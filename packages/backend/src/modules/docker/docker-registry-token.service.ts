import crypto, { createPrivateKey, createSign, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readOpfieldEnv } from '@/config/env.js';
import { LEGACY_REGISTRY_TOKEN_SERVICE, REGISTRY_TOKEN_SERVICE } from '@/foundation/opfield-names.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';

export { LEGACY_REGISTRY_TOKEN_SERVICE, REGISTRY_TOKEN_SERVICE };

const REGISTRY_TOKEN_SERVICES: readonly string[] = [REGISTRY_TOKEN_SERVICE, LEGACY_REGISTRY_TOKEN_SERVICE];

/**
 * The audience the installation's registry checks: OPFIELD_REGISTRY_TOKEN_SERVICE, which the Opfield Compose layout
 * sets next to the registry's own setting. An installation without it still runs the registry of the earlier layout.
 */
export function configuredRegistryTokenService(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = readOpfieldEnv('REGISTRY_TOKEN_SERVICE', environment)?.trim();
  return configured && REGISTRY_TOKEN_SERVICES.includes(configured) ? configured : LEGACY_REGISTRY_TOKEN_SERVICE;
}

/** Whether a token request names an audience an internal registry of either layout checks. */
export function isRegistryTokenService(service: string): boolean {
  return REGISTRY_TOKEN_SERVICES.includes(service);
}
const PRODUCTION_AUTH_DIR = '/var/lib/opfield-registry-auth';
const TOKEN_CERT_FILE = 'token-cert.pem';
const TOKEN_KEY_FILE = 'token-key.pem';
const MAX_TOKEN_TTL_SECONDS = 300;

export function resolveDockerRegistryAuthDir(
  environment: NodeJS.ProcessEnv = process.env,
  temporaryDirectory = os.tmpdir()
): string {
  return (
    readOpfieldEnv('REGISTRY_AUTH_DIR', environment) ||
    (environment.NODE_ENV === 'production'
      ? PRODUCTION_AUTH_DIR
      : path.join(temporaryDirectory, 'opfield-registry-auth'))
  );
}

export interface DockerRegistryGrant {
  repository: string;
  actions: Array<'pull' | 'push' | 'delete'>;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function pem(label: string, bytes: ArrayBuffer): string {
  const body =
    Buffer.from(bytes)
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function rsaJwkThumbprint(certificatePem: string): string {
  const publicJwk = new X509Certificate(certificatePem).publicKey.export({ format: 'jwk' });
  if (publicJwk.kty !== 'RSA' || !publicJwk.e || !publicJwk.n) {
    throw new Error('Registry token signing certificate does not contain an RSA public key');
  }
  const canonical = JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export class DockerRegistryTokenService {
  private privateKeyPem: string | null = null;
  private certificatePem: string | null = null;

  constructor(private readonly authDir = resolveDockerRegistryAuthDir()) {}

  async initialize(): Promise<void> {
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    const certPath = path.join(this.authDir, TOKEN_CERT_FILE);
    const keyPath = path.join(this.authDir, TOKEN_KEY_FILE);
    const existing = await Promise.all([
      readFile(certPath, 'utf8').catch(() => null),
      readFile(keyPath, 'utf8').catch(() => null),
    ]);
    if (existing[0] && existing[1]) {
      const certificate = new X509Certificate(existing[0]);
      if (!certificate.checkPrivateKey(createPrivateKey(existing[1]))) {
        throw new Error('Registry token signing key does not match its certificate');
      }
      this.certificatePem = existing[0];
      this.privateKeyPem = existing[1];
      return;
    }

    const algorithm = {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    };
    const keys = (await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as any;
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date();
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: crypto.randomBytes(20).toString('hex'),
      // Existing installations keep the signer they have; the registry trusts exactly that certificate.
      name: 'CN=Opfield Internal Registry Token Signer',
      notBefore,
      notAfter,
      keys,
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    const privateKeyPem = pem('PRIVATE KEY', await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    const certificatePem = certificate.toString('pem');
    await this.writeSecretFile(keyPath, privateKeyPem, 0o600);
    await this.writeSecretFile(certPath, certificatePem, 0o644);
    this.privateKeyPem = privateKeyPem;
    this.certificatePem = certificatePem;
  }

  issueToken(input: {
    subject: string;
    service?: string;
    requested: DockerRegistryGrant[];
    allowed: DockerRegistryGrant[];
    context?: { nodeId?: string; buildId?: string; containerId?: string; deploymentId?: string };
    ttlSeconds?: number;
    now?: Date;
    /** Also the registry's repository list (`/v2/_catalog`): only Opfield's own maintenance asks for it. */
    catalog?: boolean;
  }): { token: string; accessToken: string; expiresIn: number; issuedAt: string } {
    if (!this.privateKeyPem || !this.certificatePem) {
      throw new AppError(503, 'REGISTRY_TOKEN_SIGNER_UNAVAILABLE', 'Registry token signer is not initialized');
    }
    const service = input.service || configuredRegistryTokenService();
    if (!isRegistryTokenService(service)) {
      throw new AppError(403, 'REGISTRY_SERVICE_DENIED', 'Registry token audience is not allowed');
    }
    const allowed = new Map(input.allowed.map((grant) => [grant.repository, new Set(grant.actions)]));
    const access = input.requested.map((grant) => {
      const actions = [...new Set(grant.actions)];
      const allowedActions = allowed.get(grant.repository);
      if (!allowedActions || actions.some((action) => !allowedActions.has(action))) {
        throw new AppError(403, 'REGISTRY_SCOPE_DENIED', 'Requested registry repository or action is not allowed');
      }
      return { type: 'repository', name: grant.repository, actions };
    }) as Array<{ type: string; name: string; actions: string[] }>;
    if (input.catalog) access.push({ type: 'registry', name: 'catalog', actions: ['*'] });
    const now = input.now ?? new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresIn = Math.min(Math.max(input.ttlSeconds ?? 120, 30), MAX_TOKEN_TTL_SECONDS);
    const header = { alg: 'RS256', typ: 'JWT', kid: rsaJwkThumbprint(this.certificatePem) };
    const payload = {
      // The registry of either layout sets its issuer to the same name as its audience.
      iss: service,
      sub: input.subject,
      aud: service,
      exp: issuedAt + expiresIn,
      nbf: issuedAt - 5,
      iat: issuedAt,
      jti: randomUUID(),
      access,
      opfield: input.context
        ? {
            node_id: input.context.nodeId,
            build_id: input.context.buildId,
            container_id: input.context.containerId,
            deployment_id: input.context.deploymentId,
          }
        : undefined,
    };
    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const signature = createSign('RSA-SHA256').update(signingInput).end().sign(this.privateKeyPem);
    const token = `${signingInput}.${base64Url(signature)}`;
    return { token, accessToken: token, expiresIn, issuedAt: now.toISOString() };
  }

  getCertificatePem(): string {
    if (!this.certificatePem) throw new Error('Registry token signer is not initialized');
    return this.certificatePem;
  }

  private async writeSecretFile(filePath: string, content: string, mode: number): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, filePath);
  }
}

export const dockerRegistryTokenContract = {
  issuer: REGISTRY_TOKEN_SERVICE,
  service: REGISTRY_TOKEN_SERVICE,
  authDir: PRODUCTION_AUTH_DIR,
  certificatePath: `${PRODUCTION_AUTH_DIR}/${TOKEN_CERT_FILE}`,
  maxTtlSeconds: MAX_TOKEN_TTL_SECONDS,
};
