import { isIP } from 'node:net';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import {
  certificateAuthorities,
  certificates,
  managedAvailabilitySets,
  managedDatabaseInstances,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import { renameLegacySystemCa, SYSTEM_CA_COMMON_NAMES } from './system-ca-names.js';
import type {
  SystemCertificateCurrentBinding,
  SystemCertificateLifecycleService,
} from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('DatabaseCA');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
/**
 * A member of an availability set presents its leaf as the replication client too (sslcert of its standby, pg_rewind;
 * the members' pg_hba requires clientcert=verify-ca), so set members' leaves carry both usages.
 */
export const SET_MEMBER_LEAF_EXT_KEY_USAGE = ['serverAuth', 'clientAuth'] as const;

/**
 * Purpose-specific CA for direct managed-database TLS. It intentionally does
 * not reuse the daemon-node mTLS CA: users may need this public CA to verify
 * an externally published database endpoint.
 */
export class DatabaseCAService {
  private systemCertificateLifecycle?: SystemCertificateLifecycleService;
  constructor(
    private readonly db: DrizzleClient,
    private readonly caService: CAService,
    private readonly certService: CertService
  ) {}

  setSystemCertificateLifecycleService(service: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = service;
  }

  async ensureDatabaseCA(): Promise<string> {
    const [existing] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'database-tls'))
      .limit(1);
    if (existing) {
      await renameLegacySystemCa(this.db, existing.id, 'database-tls');
      return existing.id;
    }

    logger.info('Creating system Database CA for managed direct TLS');
    const ca = await this.caService.createRootCA(
      {
        commonName: SYSTEM_CA_COMMON_NAMES['database-tls'],
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 730,
        pathLengthConstraint: 0,
      },
      SYSTEM_USER_ID
    );
    await this.db
      .update(certificateAuthorities)
      .set({ isSystem: true, systemPurpose: 'database-tls' })
      .where(eq(certificateAuthorities.id, ca.id));
    logger.info('System Database CA created', { caId: ca.id });
    return ca.id;
  }

  async getDatabaseCA() {
    const [ca] = await this.db
      .select({ id: certificateAuthorities.id, certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'database-tls'))
      .limit(1);
    if (!ca) throw new Error('Database CA not found — run ensureDatabaseCA first');
    return ca;
  }

  async issueManagedDatabaseCertificate(
    managedDatabaseId: string,
    serviceAddresses: readonly string[],
    bindCurrent?: SystemCertificateCurrentBinding
  ) {
    return this.requireSystemCertificateLifecycle().issueCurrent(
      await this.managedDatabaseIssueInput(managedDatabaseId, serviceAddresses),
      SYSTEM_USER_ID,
      { type: 'managed_database', id: managedDatabaseId },
      bindCurrent,
      await this.managedDatabaseLeafOptions(managedDatabaseId)
    );
  }

  /**
   * Stages a replacement leaf next to the current one (reused while it has
   * 30 days or more left). It becomes current only through
   * {@link promoteManagedDatabaseCertificate}, once the database serves it.
   */
  async issuePendingManagedDatabaseCertificate(managedDatabaseId: string, serviceAddresses: readonly string[]) {
    return this.requireSystemCertificateLifecycle().issuePending(
      await this.managedDatabaseIssueInput(managedDatabaseId, serviceAddresses),
      SYSTEM_USER_ID,
      { type: 'managed_database', id: managedDatabaseId },
      undefined,
      await this.managedDatabaseLeafOptions(managedDatabaseId)
    );
  }

  async findPendingManagedDatabaseCertificate(managedDatabaseId: string) {
    return this.requireSystemCertificateLifecycle().findPending({ type: 'managed_database', id: managedDatabaseId });
  }

  /**
   * Makes the staged leaf with this serial current, retires the previous one
   * and points the database at it, in one transaction.
   */
  async promoteManagedDatabaseCertificate(managedDatabaseId: string, serialNumber: string): Promise<boolean> {
    return this.requireSystemCertificateLifecycle().promotePending(
      { type: 'managed_database', id: managedDatabaseId },
      serialNumber,
      async (tx, certificate) => {
        if (!certificate) return;
        await tx
          .update(managedDatabaseInstances)
          .set({ certificateId: certificate.id, updatedAt: new Date() })
          .where(eq(managedDatabaseInstances.id, managedDatabaseId));
      }
    );
  }

  /** Public details of a managed database leaf issued by the Database CA. */
  async getManagedDatabaseCertificate(certificateId: string) {
    const [certificate] = await this.db
      .select({
        id: certificates.id,
        caId: certificates.caId,
        serialNumber: certificates.serialNumber,
        notBefore: certificates.notBefore,
        notAfter: certificates.notAfter,
        sans: certificates.sans,
        extKeyUsage: certificates.extKeyUsage,
        certificatePem: certificates.certificatePem,
      })
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    return certificate
      ? { ...certificate, sans: certificate.sans ?? [], extKeyUsage: certificate.extKeyUsage ?? [] }
      : null;
  }

  /**
   * The usages a database's leaf needs: a member of an availability set (the set exists from the start of its convert
   * or create) gets serverAuth and clientAuth, a single-node database serverAuth only. Issuing and renewing both follow.
   */
  async managedDatabaseLeafOptions(managedDatabaseId: string): Promise<{ extKeyUsage?: readonly string[] }> {
    const [set] = await this.db
      .select({ id: managedAvailabilitySets.id })
      .from(managedAvailabilitySets)
      .where(
        and(
          eq(managedAvailabilitySets.ownerKind, 'managed_database'),
          eq(managedAvailabilitySets.ownerId, managedDatabaseId)
        )
      )
      .limit(1);
    return set ? { extKeyUsage: SET_MEMBER_LEAF_EXT_KEY_USAGE } : {};
  }

  private async managedDatabaseIssueInput(managedDatabaseId: string, serviceAddresses: readonly string[]) {
    const sans = [
      ...new Set(serviceAddresses.map((address) => address.trim()).filter((address) => isIP(address) !== 0)),
    ];
    if (sans.length === 0) throw new Error('Managed database node has no configured IP addresses for TLS');
    const ca = await this.getDatabaseCA();
    return {
      caId: ca.id,
      type: 'tls-server' as const,
      commonName: `managed-db-${managedDatabaseId}`,
      sans,
      keyAlgorithm: 'ecdsa-p256' as const,
      validityDays: 365,
    };
  }

  async retireManagedDatabaseCertificates(managedDatabaseId: string, transaction?: DrizzleTransaction) {
    return (
      this.systemCertificateLifecycle?.retireOwner(
        { type: 'managed_database', id: managedDatabaseId },
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

  async getManagedDatabaseCertificateMaterial(certificateId: string) {
    const [certificate] = await this.db
      .select({ id: certificates.id, caId: certificates.caId, certificatePem: certificates.certificatePem })
      .from(certificates)
      .where(eq(certificates.id, certificateId))
      .limit(1);
    if (!certificate) throw new Error('Managed database TLS certificate not found');
    const ca = await this.getDatabaseCA();
    if (certificate.caId !== ca.id) throw new Error('Managed database TLS certificate has an unexpected issuer');
    const privateKeyPem = await this.certService.getCertificatePrivateKey(certificate.id);
    if (!privateKeyPem) throw new Error('Managed database TLS private key is unavailable');
    return { certificatePem: certificate.certificatePem, privateKeyPem, caCertificatePem: ca.certificatePem };
  }
}
