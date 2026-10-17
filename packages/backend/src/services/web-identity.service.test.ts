import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import forge from 'node-forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebIdentityService } from './web-identity.service.js';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';

function rsaKeys() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const forgeKey = forge.pki.privateKeyFromPem(pem);
  return { privateKey: forgeKey, publicKey: forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e), pem };
}

function createRenewedCertificates() {
  const now = Date.now();
  const caKeys = rsaKeys();
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(now - 60_000);
  caCert.validity.notAfter = new Date(now + 86_400_000);
  caCert.setSubject([{ name: 'commonName', value: 'opfield-system-ca' }]);
  caCert.setIssuer(caCert.subject.attributes);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());
  const leafKeys = rsaKeys();
  const leaf = (serialNumber: string) => {
    const leafCert = forge.pki.createCertificate();
    leafCert.publicKey = leafKeys.publicKey;
    leafCert.serialNumber = serialNumber;
    leafCert.validity.notBefore = new Date(now - 60_000);
    leafCert.validity.notAfter = new Date(now + 86_400_000);
    leafCert.setSubject([{ name: 'commonName', value: `${LEGACY_INSTALL_DIR_NAME}-web` }]);
    leafCert.setIssuer(caCert.subject.attributes);
    leafCert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
    ]);
    leafCert.sign(caKeys.privateKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(leafCert);
  };
  return {
    caPem: forge.pki.certificateToPem(caCert),
    keyPem: leafKeys.pem,
    foreignKeyPem: caKeys.pem,
    currentPem: leaf('02'),
    renewedPem: leaf('03'),
  };
}

const certificates = createRenewedCertificates();

function fingerprint(certificatePem: string | Buffer): string {
  return createHash('sha256').update(new X509Certificate(certificatePem).raw).digest('hex');
}

describe('WebIdentityService hot reload', () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];
  const sockets: TLSSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'opfield-web-identity-'));
    tempDirs.push(dir);
    const certPath = join(dir, 'web-server.crt');
    const keyPath = join(dir, 'web-server.key');
    writeFileSync(certPath, certificates.currentPem);
    writeFileSync(keyPath, certificates.keyPem);
    const systemCA = {
      ensureWebServerCert: vi.fn(async () => ({ certPath, keyPath })),
      getSystemCACertPem: vi.fn(async () => certificates.caPem),
    };
    const service = new WebIdentityService({ WEB_TLS_AUTO_DIR: dir } as never, systemCA as never);
    await service.resolve();
    const server = createServer({ cert: certificates.currentPem, key: certificates.keyPem }, (_request, response) =>
      response.end('ok')
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    service.attachServer(server);
    const port = (server.address() as AddressInfo).port;
    const open = () =>
      new Promise<TLSSocket>((resolve, reject) => {
        const socket = connect({ port, host: '127.0.0.1', servername: 'localhost', ca: certificates.caPem }, () =>
          resolve(socket)
        );
        sockets.push(socket);
        socket.once('error', reject);
      });
    return { service, certPath, keyPath, open };
  }

  it('switches the running HTTPS listener to a renewed certificate without dropping connections', async () => {
    const { service, certPath, open } = await setup();
    const established = await open();

    writeFileSync(certPath, certificates.renewedPem);
    await service.reloadServed();

    expect(service.servedCertificate()).toEqual(Buffer.from(certificates.renewedPem));
    const renewed = await open();
    expect(fingerprint(renewed.getPeerCertificate().raw)).toBe(fingerprint(certificates.renewedPem));
    expect(established.destroyed).toBe(false);
    expect(fingerprint(established.getPeerCertificate().raw)).toBe(fingerprint(certificates.currentPem));
  });

  it('keeps serving the current certificate when renewed material does not validate', async () => {
    const { service, certPath, keyPath, open } = await setup();

    writeFileSync(certPath, certificates.renewedPem);
    writeFileSync(keyPath, certificates.foreignKeyPem);
    await expect(service.reloadServed()).rejects.toThrow('Invalid web TLS certificate');

    expect(service.servedCertificate()).toEqual(Buffer.from(certificates.currentPem));
    const next = await open();
    expect(fingerprint(next.getPeerCertificate().raw)).toBe(fingerprint(certificates.currentPem));
  });

  it('never issues two web certificates at once and keeps the identity when a refresh fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opfield-web-identity-'));
    tempDirs.push(dir);
    const installedCert = join(dir, 'web-server.crt');
    const keyPath = join(dir, 'web-server.key');
    writeFileSync(installedCert, certificates.currentPem);
    let active = 0;
    let overlapped = false;
    let failNext = false;
    const systemCA = {
      ensureWebServerCert: vi.fn(async () => {
        active += 1;
        overlapped ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (failNext) {
          failNext = false;
          throw new Error('issuance failed');
        }
        return { certPath: installedCert, keyPath };
      }),
      getSystemCACertPem: vi.fn(),
    };
    const service = new WebIdentityService({ WEB_TLS_AUTO_DIR: dir } as never, systemCA as never);

    // A settings change and a renewal refresh together; their issuances run one after the other.
    await Promise.all([service.resolve(), service.refresh(), service.reloadServed(), service.refresh()]);
    expect(overlapped).toBe(false);

    const current = await service.resolve();
    failNext = true;
    await expect(service.refresh()).rejects.toThrow('issuance failed');
    await expect(service.resolve()).resolves.toEqual(current);
  });
});
