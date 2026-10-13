import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { certificateAuthorities, certificates, managedStorageClusters } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import { renameLegacySystemCa, SYSTEM_CA_COMMON_NAMES } from './system-ca-names.js';
import type {
  SystemCertificateCurrentBinding,
  SystemCertificateLifecycleService,
} from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('StorageCA');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Names every managed storage server certificate carries besides the node's
 * own addresses. The Opfield relay tunnel and the backup relay both reach the
 * container through a local `127.0.0.1` listener and verify it as `localhost`
 * or `127.0.0.1` — for every cluster, whether or not it also publishes its S3
 * port directly.
 */
export const MANAGED_STORAGE_LOOPBACK_SANS: readonly string[] = ['localhost', '127.0.0.1'];

/**
 * Purpose-specific CA for direct managed-storage TLS. It intentionally does
 * not reuse the daemon-node mTLS CA: users may need this public CA to verify
 * an externally published storage endpoint.
 */
export class StorageCAService {
  private systemCertificateLifecycle?: SystemCertificateLifecycleService;
  constructor(
    private readonly db: DrizzleClient,
    private readonly caService: CAService,
    private readonly certService: CertService
  ) {}

  setSystemCertificateLifecycleService(service: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = service;
  }

  async ensureStorageCA(): Promise<string> {
    const [existing] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'storage-tls'))
      .limit(1);
    if (existing) {
      await renameLegacySystemCa(this.db, existing.id, 'storage-tls');
      return existing.id;
    }

    logger.info('Creating system Storage CA for managed direct TLS');
    const ca = await this.caService.createRootCA(
      {
        commonName: SYSTEM_CA_COMMON_NAMES['storage-tls'],
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 730,
        pathLengthConstraint: 0,
      },
      SYSTEM_USER_ID
    );
    await this.db
      .update(certificateAuthorities)
      .set({ isSystem: true, systemPurpose: 'storage-tls' })
      .where(eq(certificateAuthorities.id, ca.id));
    logger.info('System Storage CA created', { caId: ca.id });
    return ca.id;
  }

  async getStorageCA() {
    const [ca] = await this.db
      .select({ id: certificateAuthorities.id, certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'storage-tls'))
      .limit(1);
    if (!ca) throw new Error('Storage CA not found — run ensureStorageCA first');
    return ca;
  }

  async issueManagedStorageCertificate(
    managedStorageId: string,
    serviceAddresses: readonly string[],
    bindCurrent?: SystemCertificateCurrentBinding
  ) {
    return this.requireSystemCertificateLifecycle().issueCurrent(
      await this.managedStorageIssueInput(managedStorageId, serviceAddresses),
      SYSTEM_USER_ID,
      { type: 'managed_storage', id: managedStorageId },
      bindCurrent
    );
  }

  /**
   * Stages a replacement leaf next to the current one (reused while it has
   * 30 days or more left). It becomes current only through
   * {@link promoteManagedStorageCertificate}, once the cluster serves it.
   */
  async issuePendingManagedStorageCertificate(managedStorageId: string, serviceAddresses: readonly string[]) {
    return this.requireSystemCertificateLifecycle().issuePending(
      await this.managedStorageIssueInput(managedStorageId, serviceAddresses),
      SYSTEM_USER_ID,
      { type: 'managed_storage', id: managedStorageId }
    );
  }

  async findPendingManagedStorageCertificate(managedStorageId: string) {
    return this.requireSystemCertificateLifecycle().findPending({ type: 'managed_storage', id: managedStorageId });
  }

  /**
   * Makes the staged leaf with this serial current, retires the previous one
   * and points the cluster at it, in one transaction.
   */
  async promoteManagedStorageCertificate(managedStorageId: string, serialNumber: string): Promise<boolean> {
    return this.requireSystemCertificateLifecycle().promotePending(
      { type: 'managed_storage', id: managedStorageId },
      serialNumber,
      async (tx, certificate) => {
        if (!certificate) return;
        await tx
          .update(managedStorageClusters)
          .set({ certificateId: certificate.id, updatedAt: new Date() })
          .where(eq(managedStorageClusters.id, managedStorageId));
      }
    );
  }

  /** Public details of a managed storage leaf issued by the Storage CA. */
  async getManagedStorageCertificate(certificateId: string) {
    const [certificate] = await this.db
      .select({
        id: certificates.id,
        caId: certificates.caId,
        serialNumber: certificates.serialNumber,
        notBefore: certificates.notBefore,
        notAfter: certificates.notAfter,
        sans: certificates.sans,
        certificatePem: certificates.certificatePem,
      })
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    return certificate ? { ...certificate, sans: certificate.sans ?? [] } : null;
  }

  private async managedStorageIssueInput(managedStorageId: string, serviceAddresses: readonly string[]) {
    const addressSans = serviceAddresses
      .map((address) => address.trim())
      .filter(
        (address) => isIP(address) !== 0 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(address)
      );
    if (addressSans.length === 0) throw new Error('Managed storage node has no addresses for TLS');
    const sans = [...new Set([...addressSans, ...MANAGED_STORAGE_LOOPBACK_SANS])];
    const ca = await this.getStorageCA();
    return {
      caId: ca.id,
      type: 'tls-server' as const,
      commonName: `managed-storage-${managedStorageId}`,
      sans,
      keyAlgorithm: 'ecdsa-p256' as const,
      validityDays: 365,
    };
  }

  /**
   * Whether the certificate a managed storage cluster currently serves names
   * the loopback identities (see {@link MANAGED_STORAGE_LOOPBACK_SANS}).
   * Certificates of clusters created without the relay before that rule do
   * not, until they are reissued.
   */
  async managedStorageCertificateServesLoopback(managedStorageId: string): Promise<boolean> {
    const [cluster] = await this.db
      .select({ certificateId: managedStorageClusters.certificateId })
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, managedStorageId))
      .limit(1);
    if (!cluster?.certificateId) return false;
    const [certificate] = await this.db
      .select({ sans: certificates.sans })
      .from(certificates)
      .where(eq(certificates.id, cluster.certificateId))
      .limit(1);
    const sans = certificate?.sans ?? [];
    return MANAGED_STORAGE_LOOPBACK_SANS.every((name) => sans.includes(name));
  }

  async retireManagedStorageCertificates(managedStorageId: string, transaction?: DrizzleTransaction) {
    return (
      this.systemCertificateLifecycle?.retireOwner(
        { type: 'managed_storage', id: managedStorageId },
        'cessationOfOperation',
        transaction
      ) ?? 0
    );
  }

  async retryPendingSystemCRLs() {
    return this.systemCertificateLifecycle?.retryPendingCRLs() ?? 0;
  }

  private requireSystemCertificateLifecycle(): SystemCertificateLifecycleService {
    if (!this.systemCertificateLifecycle) {
      throw new Error('System certificate lifecycle service is required before issuing system leaves');
    }
    return this.systemCertificateLifecycle;
  }

  async getManagedStorageCertificateMaterial(certificateId: string) {
    const [certificate] = await this.db
      .select({ id: certificates.id, caId: certificates.caId, certificatePem: certificates.certificatePem })
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    if (!certificate) throw new Error('Managed storage TLS certificate not found');
    const ca = await this.getStorageCA();
    if (certificate.caId !== ca.id) throw new Error('Managed storage TLS certificate has an unexpected issuer');
    const privateKeyPem = await this.certService.getCertificatePrivateKey(certificate.id);
    if (!privateKeyPem) throw new Error('Managed storage TLS private key is unavailable');
    return { certificatePem: certificate.certificatePem, privateKeyPem, caCertificatePem: ca.certificatePem };
  }
}
