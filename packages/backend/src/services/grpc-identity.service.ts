import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Env } from '@/config/env.js';
import { createChildLogger } from '@/lib/logger.js';
import { validateGrpcServerCertificate } from './grpc-server-certificate.js';
import type { SystemCAService } from './system-ca.service.js';

const logger = createChildLogger('GrpcIdentity');

export interface GrpcIdentity {
  certPath: string;
  keyPath: string;
  opfieldCertSha256: string;
}

export class GrpcIdentityService {
  private identity: GrpcIdentity | null = null;
  /** Fingerprint of the certificate daemons are served now, which enrollment commands pin. */
  private servedSha256: string | null = null;
  /** Loads never overlap: two certificate issuances would undo each other's staged files. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly env: Env,
    private readonly systemCA: SystemCAService
  ) {}

  async resolve(): Promise<GrpcIdentity> {
    if (this.identity) return this.identity;
    return this.exclusive(async () => {
      if (!this.identity) this.remember(await this.load());
      return this.identity!;
    });
  }

  /** The fingerprint new enrollment commands carry: the certificate daemons are served now. */
  async getOpfieldCertSha256(): Promise<string> {
    return this.servedSha256 ?? (await this.resolve()).opfieldCertSha256;
  }

  /**
   * Re-reads the identity, renewing the auto-managed certificate once it is within
   * `renewBeforeMs` of expiry (the default renews only in its last week, see
   * SystemCAService.ensureGrpcServerCert). A failure keeps the current identity.
   */
  async refresh(options: { renewBeforeMs?: number } = {}): Promise<GrpcIdentity> {
    return this.exclusive(async () => {
      this.remember(await this.load(options));
      return this.identity!;
    });
  }

  /** Records that daemons are now served the certificate with this fingerprint. */
  markServed(opfieldCertSha256: string): void {
    this.servedSha256 = opfieldCertSha256;
  }

  private remember(identity: GrpcIdentity): void {
    this.identity = identity;
    // What is resolved first is what the listener starts with; later changes are marked when served.
    this.servedSha256 ??= identity.opfieldCertSha256;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(options: { renewBeforeMs?: number } = {}): Promise<GrpcIdentity> {
    let certPath = this.env.GRPC_TLS_CERT;
    let keyPath = this.env.GRPC_TLS_KEY;

    if ((certPath && !keyPath) || (!certPath && keyPath)) {
      throw new Error('GRPC_TLS_CERT and GRPC_TLS_KEY must be configured together');
    }

    if (!certPath && !keyPath) {
      const autoCertPath = `${this.env.GRPC_TLS_AUTO_DIR}/grpc-server.crt`;
      const autoKeyPath = `${this.env.GRPC_TLS_AUTO_DIR}/grpc-server.key`;
      const autoCert =
        options.renewBeforeMs === undefined
          ? await this.systemCA.ensureGrpcServerCert(autoCertPath, autoKeyPath)
          : await this.systemCA.ensureGrpcServerCert(autoCertPath, autoKeyPath, {
              renewBeforeMs: options.renewBeforeMs,
            });
      certPath = autoCert.certPath;
      keyPath = autoCert.keyPath;
    } else {
      const customCertPath = certPath!;
      const customKeyPath = keyPath!;
      await this.validateCustomServerCertificate(readFileSync(customCertPath), readFileSync(customKeyPath));
    }

    const resolvedCertPath = certPath!;
    const resolvedKeyPath = keyPath!;
    const opfieldCertSha256 = GrpcIdentityService.computeCertificateSha256(readFileSync(resolvedCertPath));
    logger.info('Resolved gRPC server identity', { certPath: resolvedCertPath, opfieldCertSha256 });
    return { certPath: resolvedCertPath, keyPath: resolvedKeyPath, opfieldCertSha256 };
  }

  static computeCertificateSha256(certificatePem: string | Buffer): string {
    try {
      const cert = new X509Certificate(certificatePem);
      return `sha256:${createHash('sha256').update(cert.raw).digest('hex')}`;
    } catch (error) {
      throw new Error(`Invalid gRPC TLS certificate PEM: ${(error as Error).message}`);
    }
  }

  private async validateCustomServerCertificate(
    certificatePem: string | Buffer,
    privateKeyPem: string | Buffer
  ): Promise<void> {
    const caPem = await this.systemCA.getSystemCACertPem();
    try {
      validateGrpcServerCertificate(certificatePem, privateKeyPem, caPem);
    } catch (error) {
      const message = (error as Error).message.replace(/^Invalid gRPC TLS certificate: /, '');
      throw new Error(`Invalid custom gRPC TLS certificate: ${message}`);
    }
  }
}
