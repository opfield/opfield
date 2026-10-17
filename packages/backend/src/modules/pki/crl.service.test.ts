// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { certificateAuthorities, pkiRevokedSerials } from '@/db/schema/index.js';
import { x509 } from '@/lib/x509.js';
import { CRLService } from './crl.service.js';
import { crlNeedsRepublish, crlSerialHex, derPositiveInteger } from './crl-encoding.js';

// F-1 (rc.3 stand): the CRL wrote every serial whose first byte is 0x80 or more as a negative INTEGER, so
// `openssl verify -crl_check` accepted about half of all revoked certificates, deleted ones (tombstones) too.

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const HIGH = 'c5021179c4672e8da1a819f6af9d87be4b1e6ec8'; // first byte >= 0x80
const HIGH_DELETED = 'a1c88ce289f8aff4ee7d6bd1e127f73d89dd308d';
const LOW = '3e79edfb00112233445566778899aabbccdd2ced';
const LOW_DELETED = '05641391aabbccddeeff00112233445566d475';
const NOT_REVOKED = 'f00dfeed00112233445566778899aabbccddeeff';
const DAY = 24 * 60 * 60 * 1000;

const workDir = mkdtempSync(path.join(tmpdir(), 'crl-test-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

async function issue(serialNumber: string, caCert: x509.X509Certificate, caKeys: CryptoKeyPair) {
  const keys = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  return x509.X509CertificateGenerator.create({
    serialNumber,
    subject: `CN=${serialNumber.slice(0, 8)}.test`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 30 * DAY),
    publicKey: keys.publicKey,
    signingKey: caKeys.privateKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
}

async function setup() {
  const caKeys = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=crl-test Root CA',
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    keys: caKeys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const ca = {
    id: 'ca-1',
    subjectDn: caCert.subject,
    certificatePem: caCert.toString('pem'),
    keyAlgorithm: 'ecdsa-p256',
  };
  const revokedAt = new Date(Date.now() - 60_000);
  const stored: { lastCrlDer?: string } = {};
  const caRows = [{ id: 'ca-1', status: 'active', lastCrlDer: null as string | null, notAfter: caCert.notAfter }];
  const tx = {
    execute: async () => undefined,
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (table === certificateAuthorities && typeof values.lastCrlDer === 'string') {
            stored.lastCrlDer = values.lastCrlDer;
            caRows[0].lastCrlDer = values.lastCrlDer;
          }
          return Object.assign(Promise.resolve(), {
            returning: async () => [{ crlNumber: 7, status: 'active', notAfter: caCert.notAfter }],
          });
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === pkiRevokedSerials
            ? [
                { serialNumber: HIGH_DELETED, revokedAt },
                { serialNumber: LOW_DELETED, revokedAt },
              ]
            : [],
      }),
    }),
    query: {
      certificates: {
        findMany: async () => [
          { serialNumber: HIGH, revokedAt, revocationReason: 'keyCompromise' },
          // An old row stored with a redundant leading zero byte still matches the certificate.
          { serialNumber: `00${LOW}`, revokedAt, revocationReason: null },
        ],
      },
      certificateAuthorities: { findMany: async () => [] },
    },
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    select: () => ({
      from: () =>
        Object.assign(Promise.resolve(caRows), {
          where: () => ({ limit: async () => [{ lastCrlDer: stored.lastCrlDer ?? null }] }),
        }),
    }),
  };
  const caService = {
    setCrlPublisher: () => undefined,
    getCASigningMaterials: async () => ({ ca, privateKeyPem: 'unused' }),
    getAlgorithm: () => ALG,
    importKeyPair: async () => caKeys,
  };
  const cache = new Map<string, string>();
  const cacheService = {
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: string) => void cache.set(key, value),
    delete: async (key: string) => void cache.delete(key),
  };
  const service = new CRLService(db as never, caService as never, cacheService as never);
  return { service, caCert, caKeys, caRows };
}

function opensslAvailable(): boolean {
  return spawnSync('openssl', ['version']).status === 0;
}

describe('crlSerialHex', () => {
  it('keeps a serial with the high bit set positive and strips redundant zero bytes', () => {
    expect(crlSerialHex(HIGH)).toBe(`00${HIGH}`);
    expect(crlSerialHex(HIGH.toUpperCase())).toBe(`00${HIGH}`);
    expect(crlSerialHex(LOW)).toBe(LOW);
    expect(crlSerialHex(`0000${LOW}`)).toBe(LOW);
    expect(crlSerialHex(`00${HIGH}`)).toBe(`00${HIGH}`);
    expect(crlSerialHex('C5:02:11')).toBe('00c50211');
    expect(crlSerialHex('abc')).toBe('0abc');
  });

  it('encodes a CRL number as a positive DER INTEGER', () => {
    expect(Buffer.from(derPositiveInteger(7)).toString('hex')).toBe('020107');
    expect(Buffer.from(derPositiveInteger(128)).toString('hex')).toBe('02020080');
    expect(Buffer.from(derPositiveInteger(0)).toString('hex')).toBe('020100');
  });
});

describe('CRLService.generateCRL', () => {
  it('lists every revoked serial as the positive number the certificate carries, with CRL Number and AKI', async () => {
    const { service, caCert, caKeys } = await setup();
    const der = await service.generateCRL('ca-1');
    const crl = new x509.X509Crl(der);

    const serials = crl.entries.map((entry) => entry.serialNumber).sort();
    expect(serials).toEqual([`00${HIGH}`, `00${HIGH_DELETED}`, LOW, LOW_DELETED].sort());
    expect(crl.extensions.map((extension) => extension.type).sort()).toEqual(['2.5.29.20', '2.5.29.35']);
    expect(crlNeedsRepublish(der)).toBe(false);
    expect(await crl.verify({ publicKey: caKeys.publicKey, signatureOnly: true })).toBe(true);

    if (!opensslAvailable()) return;
    const caPath = path.join(workDir, 'ca.pem');
    const crlPath = path.join(workDir, 'crl.pem');
    writeFileSync(caPath, caCert.toString('pem'));
    writeFileSync(crlPath, x509.PemConverter.encode(der, 'X509 CRL'));
    expect(execFileSync('openssl', ['crl', '-in', crlPath, '-noout', '-text'], { encoding: 'utf8' })).not.toMatch(
      /Serial Number: -/
    );

    for (const [serial, revoked] of [
      [HIGH, true],
      [HIGH_DELETED, true],
      [LOW, true],
      [LOW_DELETED, true],
      [NOT_REVOKED, false],
    ] as const) {
      const certPath = path.join(workDir, `${serial}.pem`);
      writeFileSync(certPath, (await issue(serial, caCert, caKeys)).toString('pem'));
      const result = spawnSync('openssl', ['verify', '-crl_check', '-CAfile', caPath, '-CRLfile', crlPath, certPath], {
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;
      if (revoked) {
        expect(result.status, `${serial}: ${output}`).not.toBe(0);
        expect(output).toMatch(/certificate revoked/);
      } else {
        expect(result.status, `${serial}: ${output}`).toBe(0);
      }
    }
  });

  it('signs again on startup a stored CRL with a negative serial or without the RFC 5280 extensions', async () => {
    const { service, caCert, caKeys, caRows } = await setup();
    const legacy = await x509.X509CrlGenerator.create({
      issuer: caCert.subject,
      thisUpdate: new Date(),
      nextUpdate: new Date(Date.now() + DAY),
      entries: [{ serialNumber: HIGH, revocationDate: new Date() }] as unknown as x509.X509CrlEntry[],
      signingKey: caKeys.privateKey,
      signingAlgorithm: ALG,
    });
    caRows[0].lastCrlDer = Buffer.from(legacy.rawData).toString('base64');
    expect(crlNeedsRepublish(caRows[0].lastCrlDer)).toBe(true);

    expect(await service.republishOutdatedCrls()).toEqual({ republished: 1, failed: 0 });
    expect(crlNeedsRepublish(caRows[0].lastCrlDer as string)).toBe(false);
    // Already current: nothing to do on the next start.
    expect(await service.republishOutdatedCrls()).toEqual({ republished: 0, failed: 0 });
  });
});
