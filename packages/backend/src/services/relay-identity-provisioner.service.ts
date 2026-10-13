import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { GrpcIdentityService } from './grpc-identity.service.js';
import { OPFIELD_IDENTITY_RENEW_BEFORE_MS } from './grpc-server-certificate.js';
import type { SystemCAService } from './system-ca.service.js';
import type { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('RelayIdentityProvisioner');
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const RENEW_BEFORE_MS = OPFIELD_IDENTITY_RENEW_BEFORE_MS;

type ServiceOwnerId = 'app-internal-server' | 'app-relay-client' | 'relay-app-client';

interface ServiceLeaf {
  certificatePem: string;
  privateKeyPem: string;
}

export interface AppRelayIdentity {
  internalServerCertPath: string;
  internalServerKeyPath: string;
  appClientCertPath: string;
  appClientKeyPath: string;
  relayClientFingerprint: string;
  appClientFingerprint: string;
  /** The client pair the running relay may still trust after a renewal; see RelayControlClient. */
  previousAppClientCertPath?: string;
  previousAppClientKeyPath?: string;
  /** Digest of every certificate the relay loads: equal digests need no relay reload. */
  materialDigest: string;
  /** The external server certificate the relay serves to daemons, which enrollment commands pin. */
  externalFingerprint: string;
}

export interface InstalledRelayCertificatePaths {
  /** Copy of Opfield's gRPC listener certificate, served by the relay to daemons. */
  externalServer: string;
  /** Served by Opfield's own gRPC listener to the relay. */
  appInternalServer: string;
  /** Opfield's client certificate toward the relay admin and broker. */
  appRelayClient: string;
  /** The relay's client certificate toward Opfield. */
  relayAppClient: string;
}

function fingerprint(certificatePem: string | Buffer): string {
  const certificate = new X509Certificate(certificatePem);
  return `sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`;
}

function safelyUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parsedFingerprint(certificatePem: string): string | null {
  try {
    return fingerprint(certificatePem);
  } catch {
    return null;
  }
}

/** The fingerprint of a still-valid certificate, or null. */
function validFingerprint(certificatePem: Buffer | null, now = Date.now()): string | null {
  if (!certificatePem) return null;
  try {
    const certificate = new X509Certificate(certificatePem);
    return Date.parse(certificate.validTo) > now ? fingerprint(certificatePem) : null;
  } catch {
    return null;
  }
}

function atomicWrite(path: string, content: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.pending-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

const COMMIT_JOURNAL = '.commit';
const STAGED_SUFFIX = '.next';

interface StagedFile {
  staged: string;
  path: string;
}

/**
 * Writes the relay identity as one set. Every file is staged next to its final name first, so a crash
 * while staging leaves the installed set intact; the journal lets the next start finish the renames.
 */
class IdentityFileSet {
  private readonly files: StagedFile[] = [];

  constructor(private readonly directory: string) {}

  write(path: string, content: string | Buffer, mode: number): void {
    const staged = `${path}${STAGED_SUFFIX}`;
    atomicWrite(staged, content, mode);
    this.files.push({ staged, path });
  }

  commit(): void {
    const journal = resolve(this.directory, COMMIT_JOURNAL);
    atomicWrite(journal, JSON.stringify(this.files), 0o600);
    for (const file of this.files) renameSync(file.staged, file.path);
    safelyUnlink(journal);
  }
}

/** Finishes a set interrupted after its journal was written and drops files staged for a set that never committed. */
export function recoverIdentityFileSet(directory: string): void {
  const journal = resolve(directory, COMMIT_JOURNAL);
  const recorded = readIfExists(journal);
  if (recorded) {
    let files: StagedFile[] = [];
    try {
      files = JSON.parse(recorded.toString('utf8')) as StagedFile[];
    } catch {
      logger.warn('Ignoring an unreadable relay identity commit journal');
    }
    for (const file of Array.isArray(files) ? files : []) {
      if (typeof file?.path !== 'string' || dirname(file.path) !== directory) continue;
      if (file.staged !== `${file.path}${STAGED_SUFFIX}`) continue;
      if (existsSync(file.staged)) renameSync(file.staged, file.path);
    }
    safelyUnlink(journal);
  }
  for (const name of readdirSync(directory)) {
    if (name.endsWith(STAGED_SUFFIX) || name.includes('.pending-')) safelyUnlink(resolve(directory, name));
  }
}

export class RelayIdentityProvisionerService {
  private identity: AppRelayIdentity | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly certService: CertService,
    private readonly lifecycle: SystemCertificateLifecycleService,
    private readonly systemCA: SystemCAService,
    private readonly grpcIdentity: GrpcIdentityService,
    private readonly identityDir: string
  ) {}

  async ensure(): Promise<AppRelayIdentity> {
    if (this.identity) return this.identity;
    const marker = resolve(this.identityDir, '.updating');
    const directory = resolve(this.identityDir);
    mkdirSync(directory, { recursive: true });
    writeFileSync(marker, `${process.pid}\n`, { mode: 0o600 });
    try {
      recoverIdentityFileSet(directory);
      const [systemCa, externalIdentity, appServer, appClient, relayClient] = await Promise.all([
        this.systemCA.getSystemCACertPem(),
        this.grpcIdentity.resolve(),
        this.ensureLeaf('app-internal-server', 'tls-server', 'app', ['app']),
        this.ensureLeaf('app-relay-client', 'tls-client', 'app-relay-client', []),
        this.ensureLeaf('relay-app-client', 'tls-client', 'relay-app-client', []),
      ]);
      if (!systemCa) throw new Error('Opfield system CA certificate is unavailable');

      const paths = {
        systemCa: resolve(this.identityDir, 'system-ca.crt'),
        externalCertificate: resolve(this.identityDir, 'external-server.crt'),
        externalPrivateKey: resolve(this.identityDir, 'external-server.key'),
        appServerCertificate: resolve(this.identityDir, 'app-internal-server.crt'),
        appServerPrivateKey: resolve(this.identityDir, 'app-internal-server.key'),
        appClientCertificate: resolve(this.identityDir, 'app-relay-client.crt'),
        appClientPrivateKey: resolve(this.identityDir, 'app-relay-client.key'),
        relayClientCertificate: resolve(this.identityDir, 'relay-app-client.crt'),
        relayClientPrivateKey: resolve(this.identityDir, 'relay-app-client.key'),
        trustManifest: resolve(this.identityDir, 'trust-manifest.json'),
        previousAppClientCertificate: resolve(this.identityDir, 'app-relay-client.previous.crt'),
        previousAppClientPrivateKey: resolve(this.identityDir, 'app-relay-client.previous.key'),
      };
      // A running relay trusts the client pair it loaded, and it reloads only when a client it
      // trusts asks. Keep the pair a renewal replaces, so Opfield can still ask.
      const files = new IdentityFileSet(directory);
      const installedClient = readIfExists(paths.appClientCertificate);
      const installedKey = readIfExists(paths.appClientPrivateKey);
      const renewedFingerprint = fingerprint(appClient.certificatePem);
      let previousFingerprint = validFingerprint(readIfExists(paths.previousAppClientCertificate));
      if (
        installedKey &&
        validFingerprint(installedClient) &&
        validFingerprint(installedClient) !== renewedFingerprint
      ) {
        files.write(paths.previousAppClientCertificate, installedClient!, 0o644);
        files.write(paths.previousAppClientPrivateKey, installedKey, 0o600);
        previousFingerprint = validFingerprint(installedClient);
      }
      if (!previousFingerprint) {
        safelyUnlink(paths.previousAppClientCertificate);
        safelyUnlink(paths.previousAppClientPrivateKey);
      }
      files.write(paths.systemCa, systemCa, 0o644);
      files.write(paths.externalCertificate, readFileSync(externalIdentity.certPath), 0o644);
      files.write(paths.externalPrivateKey, readFileSync(externalIdentity.keyPath), 0o600);
      files.write(paths.appServerCertificate, appServer.certificatePem, 0o644);
      files.write(paths.appServerPrivateKey, appServer.privateKeyPem, 0o600);
      files.write(paths.appClientCertificate, appClient.certificatePem, 0o644);
      files.write(paths.appClientPrivateKey, appClient.privateKeyPem, 0o600);
      files.write(paths.relayClientCertificate, relayClient.certificatePem, 0o644);
      files.write(paths.relayClientPrivateKey, relayClient.privateKeyPem, 0o600);

      const appClientFingerprint = fingerprint(appClient.certificatePem);
      const relayClientFingerprint = fingerprint(relayClient.certificatePem);
      files.write(
        paths.trustManifest,
        `${JSON.stringify(
          {
            version: 1,
            appRelayClientFingerprint: appClientFingerprint,
            relayAppClientFingerprint: relayClientFingerprint,
          },
          null,
          2
        )}\n`,
        0o644
      );
      files.commit();
      const externalCertificate = readFileSync(paths.externalCertificate, 'utf8');
      const materialDigest = createHash('sha256')
        .update(
          [
            systemCa,
            externalCertificate,
            appServer.certificatePem,
            appClient.certificatePem,
            relayClient.certificatePem,
          ].join('\n')
        )
        .digest('hex');
      logger.info('Provisioned relay service identities and trust manifest');
      this.identity = {
        internalServerCertPath: paths.appServerCertificate,
        internalServerKeyPath: paths.appServerPrivateKey,
        appClientCertPath: paths.appClientCertificate,
        appClientKeyPath: paths.appClientPrivateKey,
        relayClientFingerprint,
        appClientFingerprint,
        materialDigest,
        externalFingerprint: parsedFingerprint(externalCertificate) ?? '',
        ...(previousFingerprint && previousFingerprint !== appClientFingerprint
          ? {
              previousAppClientCertPath: paths.previousAppClientCertificate,
              previousAppClientKeyPath: paths.previousAppClientPrivateKey,
            }
          : {}),
      };
      return this.identity;
    } finally {
      safelyUnlink(marker);
    }
  }

  /** Re-provisions, renewing leaves that are due. A failure keeps the current identity. */
  async refresh(): Promise<AppRelayIdentity> {
    const previous = this.identity;
    this.identity = null;
    try {
      return await this.ensure();
    } catch (error) {
      this.identity = previous;
      throw error;
    }
  }

  /** The certificates installed for the local relay and Opfield's internal listener, for expiry checks. */
  installedCertificatePaths(): InstalledRelayCertificatePaths {
    return {
      externalServer: resolve(this.identityDir, 'external-server.crt'),
      appInternalServer: resolve(this.identityDir, 'app-internal-server.crt'),
      appRelayClient: resolve(this.identityDir, 'app-relay-client.crt'),
      relayAppClient: resolve(this.identityDir, 'relay-app-client.crt'),
    };
  }

  private async ensureLeaf(
    ownerId: ServiceOwnerId,
    type: 'tls-server' | 'tls-client',
    commonName: string,
    sans: string[]
  ): Promise<ServiceLeaf> {
    const [current] = await this.db
      .select({ id: certificates.id, certificatePem: certificates.certificatePem, notAfter: certificates.notAfter })
      .from(certificates)
      .where(
        and(
          eq(certificates.systemOwnerType, 'opfield_service'),
          eq(certificates.systemOwnerId, ownerId),
          eq(certificates.systemLifecycleState, 'current'),
          eq(certificates.status, 'active')
        )
      )
      .limit(1);
    if (current && current.notAfter.getTime() - Date.now() > RENEW_BEFORE_MS) {
      const privateKeyPem = await this.certService.getCertificatePrivateKey(current.id);
      if (privateKeyPem) return { certificatePem: current.certificatePem, privateKeyPem };
    }

    const issued = await this.lifecycle.issueCurrent(
      {
        caId: await this.systemCA.getSystemCAId(),
        type,
        commonName,
        sans,
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 365,
      },
      SYSTEM_USER_ID,
      { type: 'opfield_service', id: ownerId }
    );
    return { certificatePem: issued.certificate.certificatePem, privateKeyPem: issued.privateKeyPem };
  }
}
