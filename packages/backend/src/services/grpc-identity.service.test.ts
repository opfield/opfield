import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrpcIdentityService } from './grpc-identity.service.js';

function rsaKeys() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const forgeKey = forge.pki.privateKeyFromPem(pem);
  return { privateKey: forgeKey, publicKey: forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e), pem };
}

function createCertificatePair(options: { serverAuth?: boolean; clientAuth?: boolean } = {}) {
  const { serverAuth = true, clientAuth = false } = options;
  const now = Date.now();
  const caKeys = rsaKeys();
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(now - 60_000);
  caCert.validity.notAfter = new Date(now + 86_400_000);
  caCert.setSubject([{ name: 'commonName', value: 'gateway-system-ca' }]);
  caCert.setIssuer(caCert.subject.attributes);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = rsaKeys();
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = '02';
  leafCert.validity.notBefore = new Date(now - 60_000);
  leafCert.validity.notAfter = new Date(now + 86_400_000);
  leafCert.setSubject([{ name: 'commonName', value: 'gateway-grpc' }]);
  leafCert.setIssuer(caCert.subject.attributes);
  const extKeyUsage: { name: 'extKeyUsage'; serverAuth?: boolean; clientAuth?: boolean } = { name: 'extKeyUsage' };
  if (serverAuth) extKeyUsage.serverAuth = true;
  if (clientAuth) extKeyUsage.clientAuth = true;
  leafCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    extKeyUsage,
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
  ]);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem: forge.pki.certificateToPem(caCert),
    certPem: forge.pki.certificateToPem(leafCert),
    keyPem: leafKeys.pem,
  };
}

const pair = createCertificatePair();
const foreignPair = createCertificatePair();

describe('GrpcIdentityService', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeTlsFiles(certPem: string, keyPem = 'test-key') {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-identity-test-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'grpc-server.crt');
    const keyPath = join(dir, 'grpc-server.key');
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);
    return { certPath, keyPath };
  }

  function customService(certPem: string, keyPem: string, caPem: string) {
    const { certPath, keyPath } = writeTlsFiles(certPem, keyPem);
    const service = new GrpcIdentityService(
      { GRPC_TLS_CERT: certPath, GRPC_TLS_KEY: keyPath, GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any,
      { ensureGrpcServerCert: vi.fn(), getSystemCACertPem: vi.fn().mockResolvedValue(caPem) } as any
    );
    return { service, certPath, keyPath };
  }

  it('advertises the served certificate until a renewed one is marked served', async () => {
    const first = writeTlsFiles(pair.certPem);
    const renewed = writeTlsFiles(foreignPair.certPem);
    const systemCA = {
      ensureGrpcServerCert: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(renewed),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);
    const served = (await service.resolve()).opfieldCertSha256;

    const next = await service.refresh({ renewBeforeMs: 30 * 86_400_000 });
    expect(systemCA.ensureGrpcServerCert).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), {
      renewBeforeMs: 30 * 86_400_000,
    });
    expect(next.opfieldCertSha256).not.toBe(served);
    // Installed, not yet served: enrollment commands keep the fingerprint daemons get today.
    await expect(service.getOpfieldCertSha256()).resolves.toBe(served);

    service.markServed(next.opfieldCertSha256);
    await expect(service.getOpfieldCertSha256()).resolves.toBe(next.opfieldCertSha256);
  });

  it('keeps the current identity when a refresh fails', async () => {
    const { certPath, keyPath } = writeTlsFiles(pair.certPem);
    const systemCA = {
      ensureGrpcServerCert: vi
        .fn()
        .mockResolvedValueOnce({ certPath, keyPath })
        .mockRejectedValueOnce(new Error('issuance failed')),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);
    const current = await service.resolve();

    await expect(service.refresh()).rejects.toThrow('issuance failed');
    await expect(service.resolve()).resolves.toEqual(current);
    await expect(service.getOpfieldCertSha256()).resolves.toBe(current.opfieldCertSha256);
  });

  it('never issues two certificates at once', async () => {
    const { certPath, keyPath } = writeTlsFiles(pair.certPem);
    let active = 0;
    let overlapped = false;
    const systemCA = {
      ensureGrpcServerCert: vi.fn(async () => {
        active += 1;
        overlapped ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { certPath, keyPath };
      }),
      getSystemCACertPem: vi.fn(),
    };
    const service = new GrpcIdentityService({ GRPC_TLS_AUTO_DIR: '/tmp/gateway-tls' } as any, systemCA as any);

    await Promise.all([service.resolve(), service.refresh(), service.getOpfieldCertSha256(), service.refresh()]);
    expect(overlapped).toBe(false);
  });

  it('accepts a custom gRPC TLS certificate issued by the Gateway system CA', async () => {
    const { service, certPath, keyPath } = customService(pair.certPem, pair.keyPem, pair.caPem);
    await expect(service.resolve()).resolves.toMatchObject({ certPath, keyPath });
  });

  it('rejects a custom gRPC TLS certificate not issued by the Gateway system CA', async () => {
    const { service } = customService(pair.certPem, pair.keyPem, foreignPair.caPem);
    await expect(service.resolve()).rejects.toThrow('certificate is not signed by the Opfield system CA');
  });

  it('rejects a custom gRPC TLS certificate with a mismatched private key', async () => {
    const { service } = customService(pair.certPem, foreignPair.keyPem, pair.caPem);
    await expect(service.resolve()).rejects.toThrow('private key does not match certificate');
  });

  it('rejects a custom gRPC TLS certificate without server authentication usage', async () => {
    const clientOnly = createCertificatePair({ serverAuth: false, clientAuth: true });
    const { service } = customService(clientOnly.certPem, clientOnly.keyPem, clientOnly.caPem);
    await expect(service.resolve()).rejects.toThrow('certificate must allow TLS server authentication');
  });
});
