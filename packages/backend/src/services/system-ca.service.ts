import { createPrivateKey, createPublicKey, X509Certificate as NodeX509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import * as x509 from '@peculiar/x509';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { getPublicIPs } from '@/modules/domains/dns.utils.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import {
  OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS,
  OPFIELD_IDENTITY_RENEW_BEFORE_MS,
  validateGrpcServerCertificate,
} from './grpc-server-certificate.js';
import { renameLegacySystemCa, SYSTEM_CA_COMMON_NAMES } from './system-ca-names.js';
import type {
  SystemCertificateBindingHandle,
  SystemCertificateCurrentBinding,
  SystemCertificateLifecycleService,
} from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('SystemCA');

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

function collectGrpcServerSans(): string[] {
  // Do not infer the machine hostname here. In container deployments Docker
  // replaces it on every recreated app container, while the generated TLS
  // files survive on the Gateway data volume. Treating that ephemeral value as
  // mandatory makes a healthy gRPC listener certificate look stale on every
  // restart. Stable listener names must come from APP_URL, public addresses,
  // explicit extra SANs, or the saved Gateway endpoint settings below.
  const values = ['localhost', '127.0.0.1', 'relay'];

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      values.push(new URL(appUrl).hostname);
    } catch {
      logger.warn('Ignoring invalid APP_URL while building gRPC TLS SANs', { appUrl });
    }
  }

  if (process.env.PUBLIC_IPV4) values.push(process.env.PUBLIC_IPV4);
  if (process.env.PUBLIC_IPV6) values.push(process.env.PUBLIC_IPV6);
  values.push(
    ...(process.env.GRPC_TLS_EXTRA_SANS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [])
  );

  return [...new Set(values.map(normalizeGrpcServerSan).filter(Boolean))];
}

function normalizeGrpcServerSan(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.slice(1, -1).includes(':')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractGrpcTargetHost(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  const bracketed = trimmed.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const hostPort = trimmed.match(/^([^:]+):\d+$/);
  if (hostPort) return hostPort[1];
  return trimmed;
}

function certificateHasExpectedSans(certPem: string, expectedSans: readonly string[]): boolean {
  const subjectAltName = new NodeX509Certificate(certPem).subjectAltName ?? '';
  const dnsSans = new Set<string>();
  const ipSans = new Set<string>();
  for (const entry of subjectAltName.split(/,\s*/)) {
    if (entry.startsWith('DNS:')) dnsSans.add(entry.slice('DNS:'.length).trim());
    if (entry.startsWith('IP Address:')) ipSans.add(entry.slice('IP Address:'.length).trim());
  }
  const expectedDnsSans = new Set<string>();
  const expectedIpSans = new Set<string>();
  for (const san of expectedSans) {
    (/^[\d.]+$/.test(san) || san.includes(':') ? expectedIpSans : expectedDnsSans).add(san);
  }
  return (
    dnsSans.size === expectedDnsSans.size &&
    ipSans.size === expectedIpSans.size &&
    [...expectedDnsSans].every((san) => dnsSans.has(san)) &&
    [...expectedIpSans].every((san) => ipSans.has(san))
  );
}

function safelyUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function recoverListenerMaterial(
  db: DrizzleClient,
  certPath: string,
  keyPath: string,
  listener: 'gRPC' | 'web'
): Promise<void> {
  const certBackup = `${certPath}.previous`;
  const keyBackup = `${keyPath}.previous`;
  if (!existsSync(certBackup) && !existsSync(keyBackup)) return;
  const [current] = await db
    .select({ certificatePem: certificates.certificatePem })
    .from(certificates)
    .where(
      and(
        eq(certificates.systemOwnerType, 'opfield_listener'),
        eq(certificates.systemOwnerId, listener === 'gRPC' ? 'grpc' : 'web'),
        eq(certificates.systemLifecycleState, 'current')
      )
    )
    .limit(1);
  // A crash after DB commit but before backup cleanup must retain the newly
  // current pair. Only restore backups when the on-disk certificate is not
  // the certificate that the committed lifecycle identifies as current.
  if (current && existsSync(certPath) && readFileSync(certPath, 'utf8') === current.certificatePem) {
    if (existsSync(certBackup)) safelyUnlink(certBackup);
    if (existsSync(keyBackup)) safelyUnlink(keyBackup);
    return;
  }
  // Otherwise installation did not commit and the old pair remains current.
  if (existsSync(certBackup)) {
    safelyUnlink(certPath);
    renameSync(certBackup, certPath);
  }
  if (existsSync(keyBackup)) {
    safelyUnlink(keyPath);
    renameSync(keyBackup, keyPath);
  }
}

/**
 * Validate and install a listener TLS pair before its DB lifecycle transition
 * commits. If installation fails, restore the prior pair and rethrow so the
 * lifecycle transaction keeps the previous certificate current.
 */
function installListenerMaterial(
  certPath: string,
  keyPath: string,
  certificatePem: string,
  privateKeyPem: string
): SystemCertificateBindingHandle {
  const certificate = new NodeX509Certificate(certificatePem);
  const key = createPrivateKey(privateKeyPem);
  const certificatePublic = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const keyPublic = createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (!certificatePublic.equals(keyPublic)) throw new Error('Listener certificate and private key do not match');
  const suffix = `.pending-${process.pid}-${Date.now()}`;
  const certTemporary = `${certPath}${suffix}`;
  const keyTemporary = `${keyPath}${suffix}`;
  const certBackup = `${certPath}.previous`;
  const keyBackup = `${keyPath}.previous`;
  let certInstalled = false;
  let keyInstalled = false;
  let certBackedUp = false;
  let keyBackedUp = false;

  mkdirSync(dirname(certPath), { recursive: true });
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(certTemporary, certificatePem, { mode: 0o644 });
  writeFileSync(keyTemporary, privateKeyPem, { mode: 0o600 });
  try {
    if (existsSync(certPath)) {
      renameSync(certPath, certBackup);
      certBackedUp = true;
    }
    if (existsSync(keyPath)) {
      renameSync(keyPath, keyBackup);
      keyBackedUp = true;
    }
    renameSync(certTemporary, certPath);
    certInstalled = true;
    renameSync(keyTemporary, keyPath);
    keyInstalled = true;
  } catch (error) {
    if (certInstalled) safelyUnlink(certPath);
    if (keyInstalled) safelyUnlink(keyPath);
    if (certBackedUp && existsSync(certBackup)) renameSync(certBackup, certPath);
    if (keyBackedUp && existsSync(keyBackup)) renameSync(keyBackup, keyPath);
    throw error;
  } finally {
    safelyUnlink(certTemporary);
    safelyUnlink(keyTemporary);
  }
  return {
    onCommitted: () => {
      if (certBackedUp) safelyUnlink(certBackup);
      if (keyBackedUp) safelyUnlink(keyBackup);
    },
    onRollback: () => {
      if (certInstalled) safelyUnlink(certPath);
      if (keyInstalled) safelyUnlink(keyPath);
      if (certBackedUp && existsSync(certBackup)) renameSync(certBackup, certPath);
      if (keyBackedUp && existsSync(keyBackup)) renameSync(keyBackup, keyPath);
    },
  };
}

export class SystemCAService {
  private generalSettingsService?: GeneralSettingsService;
  private systemCertificateLifecycle?: SystemCertificateLifecycleService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly caService: CAService,
    readonly _certService: CertService,
    readonly _cryptoService: CryptoService
  ) {}

  setGeneralSettingsService(service: GeneralSettingsService) {
    this.generalSettingsService = service;
  }

  setSystemCertificateLifecycleService(service: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = service;
  }

  /** Ensure the system CA exists. Creates it on first startup. Returns its ID. */
  async ensureSystemCA(): Promise<string> {
    const [existing] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'))
      .limit(1);

    if (existing) {
      await renameLegacySystemCa(this.db, existing.id, 'node-mtls');
      return existing.id;
    }

    // Installations created before purpose-scoped system CAs have exactly one
    // locked CA: it is the node mTLS CA. Adopt it instead of minting a second
    // root during the migration to database TLS.
    const [legacy] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.isSystem, true))
      .limit(1);
    if (legacy) {
      await this.db
        .update(certificateAuthorities)
        .set({ systemPurpose: 'node-mtls' })
        .where(eq(certificateAuthorities.id, legacy.id));
      await renameLegacySystemCa(this.db, legacy.id, 'node-mtls');
      return legacy.id;
    }

    logger.info('Creating system CA for node mTLS...');

    const ca = await this.caService.createRootCA(
      {
        commonName: SYSTEM_CA_COMMON_NAMES['node-mtls'],
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 10,
        maxValidityDays: 3650,
        pathLengthConstraint: 0,
      },
      SYSTEM_USER_ID
    );

    await this.db
      .update(certificateAuthorities)
      .set({ isSystem: true, systemPurpose: 'node-mtls' })
      .where(eq(certificateAuthorities.id, ca.id));

    logger.info('System CA created', { caId: ca.id });
    return ca.id;
  }

  /** Get the system CA certificate PEM (for gRPC mTLS verification). */
  async getSystemCACertPem(): Promise<string | null> {
    const [ca] = await this.db
      .select({ certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'))
      .limit(1);
    return ca?.certificatePem ?? null;
  }

  /** Get the system CA ID (throws if not found). */
  async getSystemCAId(): Promise<string> {
    const [ca] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'))
      .limit(1);

    if (!ca) throw new Error('System CA not found — run ensureSystemCA first');
    return ca.id;
  }

  /**
   * Ensure the gRPC server has a TLS certificate issued by the system CA.
   * Returns the cert/key file paths. Reuses existing files if still valid.
   * Enrollment commands pin this certificate's fingerprint, so by default it is renewed only in
   * its last week; running renewal passes an earlier `renewBeforeMs` when no command is pending.
   */
  async ensureGrpcServerCert(
    certPath: string,
    keyPath: string,
    options: { renewBeforeMs?: number } = {}
  ): Promise<{ certPath: string; keyPath: string }> {
    const expectedSans = await this.collectGrpcServerSans();
    return this.ensureServerCert(
      certPath,
      keyPath,
      // Existing listener certificates keep their earlier name until their next renewal; nothing checks it.
      'opfield-grpc',
      expectedSans,
      'gRPC',
      options.renewBeforeMs ?? OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS
    );
  }

  /** Ensure the native web listener has its own leaf issued by the existing system CA. */
  async ensureWebServerCert(certPath: string, keyPath: string): Promise<{ certPath: string; keyPath: string }> {
    const expectedSans = await this.collectWebServerSans();
    return this.ensureServerCert(
      certPath,
      keyPath,
      'opfield-web',
      expectedSans,
      'web',
      OPFIELD_IDENTITY_RENEW_BEFORE_MS
    );
  }

  private async ensureServerCert(
    certPath: string,
    keyPath: string,
    commonName: string,
    expectedSans: string[],
    listener: 'gRPC' | 'web',
    renewBeforeMs: number
  ): Promise<{ certPath: string; keyPath: string }> {
    await recoverListenerMaterial(this.db, certPath, keyPath, listener);
    // Reuse if files exist and the cert is not yet due for renewal
    if (existsSync(certPath) && existsSync(keyPath)) {
      try {
        const certPem = readFileSync(certPath, 'utf-8');
        const keyPem = readFileSync(keyPath, 'utf-8');
        if (certPem.includes('BEGIN CERTIFICATE')) {
          const cert = new x509.X509Certificate(certPem);
          validateGrpcServerCertificate(certPem, keyPem, await this.getSystemCACertPem());
          if (!certificateHasExpectedSans(certPem, expectedSans)) {
            logger.info(`Existing ${listener} server cert is missing required SANs, regenerating`, { expectedSans });
          } else {
            const remaining = cert.notAfter.getTime() - Date.now();
            if (remaining > renewBeforeMs) {
              logger.debug(`Reusing existing ${listener} server cert`, {
                expiresAt: cert.notAfter.toISOString(),
              });
              return { certPath, keyPath };
            }
            logger.info(`${listener} server cert expiring soon, regenerating`, {
              remaining: `${Math.round(remaining / 3600000)}h`,
            });
          }
        }
      } catch (err) {
        logger.warn(`Existing ${listener} server TLS material is invalid; regenerating`, {
          error: (err as Error).message,
        });
      }
    }

    logger.info(`Issuing ${listener} server TLS certificate from system CA...`);

    const caId = await this.getSystemCAId();

    const issueInput = {
      caId,
      type: 'tls-server' as const,
      commonName,
      sans: expectedSans,
      keyAlgorithm: 'ecdsa-p256' as const,
      validityDays: 365,
    };
    const result = await this.requireSystemCertificateLifecycle().issueCurrent(
      issueInput,
      SYSTEM_USER_ID,
      { type: 'opfield_listener', id: listener === 'gRPC' ? 'grpc' : 'web' },
      async (_tx, certificate) =>
        installListenerMaterial(certPath, keyPath, certificate.certificatePem, certificate.privateKeyPem)
    );

    logger.info(`${listener} server cert issued`, { serial: result.certificate.serialNumber, certPath });
    return { certPath, keyPath };
  }

  private async collectGrpcServerSans(): Promise<string[]> {
    const values = collectGrpcServerSans();
    const settings = await this.generalSettingsService?.getOpfieldEndpointSettings();
    const publicHost = extractGrpcTargetHost(settings?.grpcPublicTarget);
    const localHost = extractGrpcTargetHost(settings?.grpcLocalIp);
    if (publicHost) values.push(publicHost);
    if (localHost) values.push(localHost);
    return [...new Set(values.map(normalizeGrpcServerSan).filter(Boolean))];
  }

  private async collectWebServerSans(): Promise<string[]> {
    const values = ['localhost', hostname(), '127.0.0.1'];
    if (process.env.PUBLIC_IPV4) values.push(process.env.PUBLIC_IPV4);
    if (process.env.PUBLIC_IPV6) values.push(process.env.PUBLIC_IPV6);
    values.push(
      ...(process.env.OPFIELD_LOCAL_HOSTS?.split(',')
        .map((value) => value.trim())
        .filter(Boolean) ?? [])
    );
    const discoveredPublicIps = getPublicIPs();
    values.push(...discoveredPublicIps.ipv4, ...discoveredPublicIps.ipv6);

    const general = await this.generalSettingsService?.getConfig();
    if (general?.publicUrl) values.push(new URL(general.publicUrl).hostname);

    return [...new Set(values.map(normalizeGrpcServerSan).filter(Boolean))];
  }

  /** Issue a TLS client cert for a daemon node using the system CA. */
  async issueNodeCert(
    nodeId: string,
    hostname: string,
    bindCurrent?: SystemCertificateCurrentBinding,
    options?: { stage?: 'current' | 'pending' }
  ): Promise<{
    caCertPem: string;
    certPem: string;
    keyPem: string;
    serial: string;
    expiresAt: Date;
  }> {
    const caId = await this.getSystemCAId();

    const [ca] = await this.db
      .select({ certificatePem: certificateAuthorities.certificatePem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, caId))
      .limit(1);

    const issueInput = {
      caId,
      type: 'tls-client' as const,
      commonName: nodeId,
      sans: [hostname],
      keyAlgorithm: 'ecdsa-p256' as const,
      validityDays: 365,
    };
    // A renewal is staged as `pending` so the current leaf stays valid until
    // the daemon proves it received the replacement.
    const lifecycle = this.requireSystemCertificateLifecycle();
    const result =
      options?.stage === 'pending'
        ? await lifecycle.issuePending(issueInput, SYSTEM_USER_ID, { type: 'node', id: nodeId }, bindCurrent)
        : await lifecycle.issueCurrent(issueInput, SYSTEM_USER_ID, { type: 'node', id: nodeId }, bindCurrent);

    return {
      caCertPem: ca!.certificatePem,
      certPem: result.certificate.certificatePem,
      keyPem: result.privateKeyPem,
      serial: result.certificate.serialNumber,
      expiresAt: result.certificate.notAfter,
    };
  }

  /** Issue the server leaf used by a remote relay data-plane listener. */
  async issueRelayServerCert(
    relayInstanceId: string,
    advertisedAddresses: string[]
  ): Promise<{ certPem: string; keyPem: string; serial: string; expiresAt: Date; identity: string }> {
    const caId = await this.getSystemCAId();
    const identity = `relay-${relayInstanceId}`;
    const sans = [...new Set([identity, ...advertisedAddresses].map(normalizeGrpcServerSan).filter(Boolean))];
    const result = await this.requireSystemCertificateLifecycle().issueCurrent(
      {
        caId,
        type: 'tls-server',
        commonName: identity,
        sans,
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 365,
      },
      SYSTEM_USER_ID,
      { type: 'relay_node_server', id: relayInstanceId }
    );
    return {
      certPem: result.certificate.certificatePem,
      keyPem: result.privateKeyPem,
      serial: result.certificate.serialNumber,
      expiresAt: result.certificate.notAfter,
      identity,
    };
  }

  private requireSystemCertificateLifecycle(): SystemCertificateLifecycleService {
    if (!this.systemCertificateLifecycle) {
      throw new Error('System certificate lifecycle service is required before issuing system leaves');
    }
    return this.systemCertificateLifecycle;
  }
}
