import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ConsoleTlsDeps, ConsoleTlsService, consoleHttpResponse } from './console-tls.service.js';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';

const DAY = 24 * 60 * 60 * 1000;
const DOMAIN = 'acme.opfield.test';

function certificate(name: string, notBefore: Date, notAfter: Date): { cert: string; key: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const forgeKey = forge.pki.privateKeyFromPem(key);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);
  cert.serialNumber = `0${Math.floor(Math.random() * 1e9).toString(16)}`;
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  cert.setSubject([{ name: 'commonName', value: name }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: name }] }]);
  cert.sign(forgeKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key };
}

const start = new Date();
let fallback: { cert: string; key: string };
let issued: { cert: string; key: string };
let renewed: { cert: string; key: string };
let otherDomain: { cert: string; key: string };

beforeAll(() => {
  fallback = certificate(`${LEGACY_INSTALL_DIR_NAME}-web`, new Date(start.getTime() - DAY), new Date(start.getTime() + 365 * DAY));
  issued = certificate(DOMAIN, start, new Date(start.getTime() + 90 * DAY));
  renewed = certificate(DOMAIN, new Date(start.getTime() + 60 * DAY), new Date(start.getTime() + 150 * DAY));
  otherDomain = certificate('old.opfield.test', start, new Date(start.getTime() + 90 * DAY));
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(overrides: Partial<ConsoleTlsDeps> & { stateDir?: string } = {}) {
  const stateDir = overrides.stateDir ?? mkdtempSync(join(tmpdir(), 'console-tls-'));
  if (!overrides.stateDir) dirs.push(stateDir);
  const clock = { now: start };
  const calls = { orders: 0, accountKeys: [] as string[], alerts: [] as Array<{ level: string; message: string }> };
  const responses: Array<{ cert: string; key: string } | Error> = [];
  let reachable = false;
  let publicUrl: string | null = null;
  const acme = {
    requestCertHTTP01: async (_domains: string[], _staging?: boolean, _email?: string, accountKeyPem?: string) => {
      calls.orders += 1;
      calls.accountKeys.push(accountKeyPem ?? '');
      const next = responses.shift() ?? new Error('no response queued');
      if (next instanceof Error) throw next;
      return {
        certificatePem: next.cert,
        privateKeyPem: next.key,
        chainPem: '',
        notBefore: start,
        notAfter: start,
        accountKey: accountKeyPem ?? '',
      };
    },
  } as unknown as ConsoleTlsDeps['acme'];
  const service = new ConsoleTlsService({
    domain: DOMAIN,
    email: 'ops@opfield.test',
    staging: true,
    stateDir,
    httpsPort: 0,
    httpPort: 0,
    bindHost: '127.0.0.1',
    acme,
    fallback: async () => ({ cert: Buffer.from(fallback.cert), key: Buffer.from(fallback.key) }),
    publicUrl: {
      get: async () => publicUrl,
      set: async (url) => {
        publicUrl = url;
      },
    },
    alert: async (level, message) => {
      calls.alerts.push({ level, message });
    },
    probe: async (url) => {
      if (!reachable) return null;
      const token = url.split('/').pop()!;
      return consoleHttpResponse(`/.well-known/acme-challenge/${token}`, 'GET', DOMAIN, service['challenges']).body;
    },
    now: () => clock.now,
    ...overrides,
  });
  return {
    service,
    stateDir,
    clock,
    calls,
    responses,
    advance: (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    setReachable: (value: boolean) => {
      reachable = value;
    },
    publicUrl: () => publicUrl,
    setPublicUrl: (value: string | null) => {
      publicUrl = value;
    },
  };
}

/** Loads the initial material without starting listeners or the timer loop. */
async function load(service: ConsoleTlsService) {
  await (service as unknown as { loadInitialMaterial(): Promise<void> }).loadInitialMaterial();
}

describe('ConsoleTlsService', () => {
  it('serves the fallback until Let’s Encrypt issues, keeps it on failure, and retries with backoff', async () => {
    const t = setup();
    await load(t.service);
    expect(t.service.status().source).toBe('fallback');

    // First pass orders even though the probe fails (the host may lack hairpin NAT): it fails, the fallback stays.
    t.responses.push(new Error('DNS problem: NXDOMAIN'));
    expect(await t.service.runOnce()).toBe(2 * 60 * 1000);
    expect(t.calls.orders).toBe(1);
    expect(t.service.status()).toMatchObject({ source: 'fallback', orderFailures: 1 });

    // Inside the backoff nothing is ordered.
    t.advance(60 * 1000);
    expect(await t.service.runOnce()).toBe(60 * 1000);
    expect(t.calls.orders).toBe(1);

    // After it, while the domain does not reach the host, only the cheap probe repeats.
    t.advance(2 * 60 * 1000);
    expect(await t.service.runOnce()).toBe(15_000);
    expect(t.calls.orders).toBe(1);

    // DNS arrives: the probe passes, the order succeeds and the listener switches.
    t.setReachable(true);
    t.responses.push(issued);
    await t.service.runOnce();
    expect(t.calls.orders).toBe(2);
    expect(t.service.status()).toMatchObject({ source: 'acme', orderFailures: 0, lastError: null });
    expect(readFileSync(join(t.stateDir, 'cert.pem'), 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(statSync(join(t.stateDir, 'key.pem')).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.stateDir, 'account.key')).mode & 0o777).toBe(0o600);
    // Both orders used the one stored ACME account.
    expect(t.calls.accountKeys[0]).toContain('PRIVATE KEY');
    expect(t.calls.accountKeys[1]).toBe(t.calls.accountKeys[0]);
    expect(t.calls.alerts).toHaveLength(0);
  });

  it('reuses the stored certificate after a restart and renews it at 30 days left, keeping it while renewal fails', async () => {
    const first = setup();
    writeFileSync(join(first.stateDir, 'cert.pem'), issued.cert);
    writeFileSync(join(first.stateDir, 'key.pem'), issued.key);
    await load(first.service);
    expect(first.service.status().source).toBe('acme');
    expect(await first.service.runOnce()).toBe(6 * 60 * 60 * 1000);
    expect(first.calls.orders).toBe(0);

    // 61 days in: due. The renewal fails; the current certificate stays served.
    first.setReachable(true);
    first.advance(61 * DAY);
    first.responses.push(new Error('rateLimited'));
    await first.service.runOnce();
    expect(first.calls.orders).toBe(1);
    expect(first.service.status()).toMatchObject({ source: 'acme', orderFailures: 1 });
    expect(first.service.status().notAfter!.getTime()).toBeLessThanOrEqual(start.getTime() + 90 * DAY);
    expect(first.calls.alerts).toHaveLength(0);

    // Still failing with 13 days left: an alert, once per repeat window.
    first.advance(16 * DAY);
    first.responses.push(new Error('rateLimited'));
    await first.service.runOnce();
    expect(first.calls.alerts).toEqual([expect.objectContaining({ level: 'warning' })]);
    expect(first.calls.alerts[0]!.message).toContain(DOMAIN);

    // Succeeds: the renewed certificate is served.
    first.advance(4 * 60 * 60 * 1000);
    first.responses.push(renewed);
    await first.service.runOnce();
    expect(first.service.status()).toMatchObject({ source: 'acme', orderFailures: 0 });
    expect(first.service.status().notAfter!.getTime()).toBeGreaterThan(start.getTime() + 140 * DAY);
  });

  it('ignores a stored certificate for another domain and orders a new one', async () => {
    const t = setup();
    writeFileSync(join(t.stateDir, 'cert.pem'), otherDomain.cert);
    writeFileSync(join(t.stateDir, 'key.pem'), otherDomain.key);
    await load(t.service);
    expect(t.service.status().source).toBe('fallback');
  });

  it('ignores a stored certificate whose key does not match', async () => {
    const t = setup();
    writeFileSync(join(t.stateDir, 'cert.pem'), issued.cert);
    writeFileSync(join(t.stateDir, 'key.pem'), renewed.key);
    await load(t.service);
    expect(t.service.status().source).toBe('fallback');
  });

  it('sets the public URL from the domain, keeps one an administrator chose, and follows a domain change', async () => {
    const t = setup();
    await t.service.seedPublicUrl();
    expect(t.publicUrl()).toBe(`https://${DOMAIN}`);

    t.setPublicUrl('https://console.customer.example');
    await t.service.seedPublicUrl();
    expect(t.publicUrl()).toBe('https://console.customer.example');

    writeFileSync(join(t.stateDir, 'state.json'), JSON.stringify({ domain: 'old.opfield.test' }));
    t.setPublicUrl('https://old.opfield.test');
    await t.service.seedPublicUrl();
    expect(t.publicUrl()).toBe(`https://${DOMAIN}`);
  });
});

describe('console HTTP listener', () => {
  const challenges = new Map([['tok_1', 'tok_1.key']]);

  it('answers ACME challenges and 404 for unknown tokens', () => {
    expect(consoleHttpResponse('/.well-known/acme-challenge/tok_1', 'GET', DOMAIN, challenges)).toMatchObject({
      status: 200,
      body: 'tok_1.key',
    });
    expect(consoleHttpResponse('/.well-known/acme-challenge/other', 'GET', DOMAIN, challenges).status).toBe(404);
  });

  it('redirects everything else to the console domain over HTTPS', () => {
    expect(consoleHttpResponse('/login?next=/x', 'GET', DOMAIN, challenges)).toMatchObject({
      status: 301,
      headers: { location: `https://${DOMAIN}/login?next=/x` },
    });
    expect(consoleHttpResponse('/api/x', 'POST', DOMAIN, challenges).status).toBe(308);
    // An absolute-form or empty target never redirects elsewhere.
    expect(consoleHttpResponse('http://evil.example/x', 'GET', DOMAIN, challenges).headers.location).toBe(
      `https://${DOMAIN}/`
    );
  });
});
