import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LICENSE_SERVICE_URLS } from '@/config/vendor-urls.js';
import { LicenseService } from './license.service.js';
import { LICENSE_PLAN_ENTITLEMENTS } from './license.types.js';
import {
  createTestLicenseSigner,
  createTestLicenseVerifier,
  signedLicenseServer,
  TEST_INSTALLATION_ID,
} from './license-attestation.test-helpers.js';
import { LicenseServiceEndpoints, verifyLicenseEndpointsDocument } from './license-endpoints.js';
import { LEGACY_APP_IMAGE_MANIFEST_KIND, LEGACY_THESQLABS_UPDATES_BASE_URL, LEGACY_UPDATES_BASE_URL, LEGACY_UPDATE_KEY_ID } from '@/lib/legacy-compat.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-11T12:00:00.000Z');
const updateKeys = generateKeyPairSync('ed25519');
const PUBLIC_KEY = updateKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const DOCUMENT_URL = `${LEGACY_UPDATES_BASE_URL}/license-endpoints.json`;
const LEGACY_DOCUMENT_URL = `${LEGACY_THESQLABS_UPDATES_BASE_URL}/license-endpoints.json`;

/** Signs like scripts/release/license-endpoints.mjs and the update-trust tool. */
function signDocument(payload: Record<string, unknown>, privateKey: KeyObject = updateKeys.privateKey): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return JSON.stringify({
    schemaVersion: 1,
    keyId: LEGACY_UPDATE_KEY_ID,
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, privateKey).toString('base64url'),
  });
}

function endpointsDocument(endpoints: string[], issuedAt = new Date(NOW.getTime() - DAY), validDays = 60): string {
  return signDocument({
    kind: 'license-endpoints',
    endpoints,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + validDays * DAY).toISOString(),
  });
}

function createDb() {
  const rows = new Map<string, unknown>([['license:installation_id', TEST_INSTALLATION_ID]]);
  const keysFromCondition = (condition: unknown): string[] =>
    ((condition as { queryChunks?: unknown[] }).queryChunks ?? [])
      .flatMap((chunk) => (Array.isArray(chunk) ? chunk : [chunk]))
      .map((chunk) => (chunk as { value?: unknown }).value)
      .filter((value): value is string => typeof value === 'string' && value.startsWith('license:'));
  return {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          const matching = () =>
            keysFromCondition(condition)
              .filter((key) => rows.has(key))
              .map((key) => ({ key, value: rows.get(key) }));
          return {
            limit: () => Promise.resolve(matching().slice(0, 1)),
            // biome-ignore lint/suspicious/noThenProperty: a query builder is awaited without `.limit()`
            then: (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
              Promise.resolve(matching()).then(resolve, reject),
          };
        },
      }),
    }),
    insert: () => ({
      values: (value: { key: string; value: unknown }) => ({
        onConflictDoUpdate: () => {
          rows.set(value.key, value.value);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
    rows,
  };
}

function documentHost(documents: Record<string, string | Error>) {
  return vi.fn(async (url: string) => {
    const document = documents[url];
    if (document instanceof Error) throw document;
    return document === undefined ? new Response('not found', { status: 404 }) : new Response(document);
  });
}

function createEndpoints(db: ReturnType<typeof createDb>, fetcher: unknown, env: Record<string, string> = {}) {
  return new LicenseServiceEndpoints(db as never, env, fetcher as never, { publicKey: PUBLIC_KEY, now: () => NOW });
}

describe('license endpoints document', () => {
  it('keeps the built-in addresses equal to config/license-service.json', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../../../../config/license-service.json', import.meta.url), 'utf8')
    ) as { endpoints: string[] };
    expect([...LICENSE_SERVICE_URLS]).toEqual(config.endpoints);
  });

  it('accepts a document signed with the update key', () => {
    const document = verifyLicenseEndpointsDocument(
      endpointsDocument(['https://license.example.net/', 'https://license.opfield.dev']),
      NOW,
      PUBLIC_KEY
    );
    expect(document.endpoints).toEqual(['https://license.example.net', 'https://license.opfield.dev']);
  });

  it.each([
    [
      'an unsigned document',
      () => JSON.stringify({ kind: 'license-endpoints', endpoints: ['https://evil.example'], expiresAt: '2030-01-01' }),
    ],
    [
      'a tampered document',
      () => {
        const envelope = JSON.parse(endpointsDocument(['https://license.example.net']));
        const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
        payload.endpoints = ['https://evil.example'];
        envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return JSON.stringify(envelope);
      },
    ],
    [
      'a document signed with another key',
      () =>
        signDocument(
          {
            kind: 'license-endpoints',
            endpoints: ['https://evil.example'],
            issuedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + DAY).toISOString(),
          },
          generateKeyPairSync('ed25519').privateKey
        ),
    ],
    [
      'an expired document',
      () => endpointsDocument(['https://license.example.net'], new Date(NOW.getTime() - 61 * DAY)),
    ],
    [
      'a document issued in the future',
      () => endpointsDocument(['https://license.example.net'], new Date(NOW.getTime() + DAY)),
    ],
    [
      'a document valid for too long',
      () => endpointsDocument(['https://license.example.net'], new Date(NOW.getTime() - DAY), 800),
    ],
    ['a plain http endpoint', () => endpointsDocument(['http://license.example.net'])],
    ['no endpoints', () => endpointsDocument([])],
    [
      'another signed kind',
      () =>
        signDocument({
          kind: LEGACY_APP_IMAGE_MANIFEST_KIND,
          endpoints: ['https://license.example.net'],
          issuedAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + DAY).toISOString(),
        }),
    ],
  ])('rejects %s', (_, document) => {
    expect(() => verifyLicenseEndpointsDocument(document(), NOW, PUBLIC_KEY)).toThrow();
  });
});

describe('LicenseServiceEndpoints', () => {
  it('uses the built-in addresses without a document', async () => {
    const endpoints = createEndpoints(createDb(), documentHost({}));
    await expect(endpoints.list()).resolves.toEqual([...LICENSE_SERVICE_URLS]);
    await expect(endpoints.refresh()).resolves.toBe(false);
  });

  it('puts the addresses of a fetched document before the built-in ones and keeps it across a restart', async () => {
    const db = createDb();
    const fetcher = documentHost({
      [DOCUMENT_URL]: new TypeError('fetch failed'),
      [LEGACY_DOCUMENT_URL]: endpointsDocument(['https://license.example.net', 'https://license.opfield.dev']),
    });
    const endpoints = createEndpoints(db, fetcher);

    await expect(endpoints.refresh()).resolves.toBe(true);
    const expected = ['https://license.example.net', ...LICENSE_SERVICE_URLS];
    await expect(endpoints.list()).resolves.toEqual(expected);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([DOCUMENT_URL, LEGACY_DOCUMENT_URL]);

    // A restart with the update hosts unreachable still has the stored document.
    const restarted = createEndpoints(db, documentHost({ [DOCUMENT_URL]: new TypeError('offline') }));
    await expect(restarted.list()).resolves.toEqual(expected);
    expect(restarted.current()).toBe('https://license.example.net');
  });

  it('keeps the stored document when a tampered or older one is served', async () => {
    const db = createDb();
    const current = endpointsDocument(['https://license.example.net']);
    await createEndpoints(db, documentHost({ [DOCUMENT_URL]: current })).refresh();

    const tampered = JSON.parse(current);
    tampered.signature = Buffer.alloc(64).toString('base64url');
    const older = endpointsDocument(['https://license.older.example'], new Date(NOW.getTime() - 10 * DAY));
    for (const served of [JSON.stringify(tampered), older]) {
      const endpoints = createEndpoints(db, documentHost({ [DOCUMENT_URL]: served }));
      await expect(endpoints.refresh()).resolves.toBe(true);
      await expect(endpoints.list()).resolves.toEqual(['https://license.example.net', ...LICENSE_SERVICE_URLS]);
    }
    expect(db.rows.get('license:service_endpoints_document')).toEqual({ signed: current });
  });

  it('stops using a stored document once it expires', async () => {
    const db = createDb();
    db.rows.set('license:service_endpoints_document', {
      signed: endpointsDocument(['https://license.example.net'], new Date(NOW.getTime() - 90 * DAY)),
    });
    const endpoints = createEndpoints(db, documentHost({}));
    await expect(endpoints.list()).resolves.toEqual([...LICENSE_SERVICE_URLS]);
  });

  it('tries the administrator override first', async () => {
    const db = createDb();
    await createEndpoints(
      db,
      documentHost({ [DOCUMENT_URL]: endpointsDocument(['https://license.example.net']) })
    ).refresh();
    const endpoints = createEndpoints(db, documentHost({}), {
      LICENSE_SERVICE_URL: 'http://license-proxy.internal:8080/, https://license.opfield.dev, not a url',
    });
    await expect(endpoints.list()).resolves.toEqual([
      'http://license-proxy.internal:8080',
      'https://license.opfield.dev',
      'https://license.example.net',
      ...LICENSE_SERVICE_URLS.slice(1),
    ]);
  });

  it('fetches the document from a configured artifact host first', async () => {
    const fetcher = documentHost({});
    await createEndpoints(createDb(), fetcher, { ARTIFACT_BASE_URL: 'https://mirror.example/opfield/' }).refresh();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://mirror.example/opfield/license-endpoints.json',
      DOCUMENT_URL,
      LEGACY_DOCUMENT_URL,
    ]);
  });
});

describe('LicenseService over several addresses', () => {
  const signer = createTestLicenseSigner();
  const communityState = () => ({
    registrationStatus: 'registered',
    effectivePlan: 'community',
    paidLicenseStatus: 'none',
    graceUntil: null,
    entitlementsVersion: 5,
    entitlements: LICENSE_PLAN_ENTITLEMENTS.community,
    serverTime: new Date().toISOString(),
  });
  const answer = (data: unknown, status = 200) => ({
    ok: status < 300,
    status,
    json: () => Promise.resolve({ data }),
  });
  const crypto = {
    encryptString: (plaintext: string) => ({ encryptedKey: `enc:${plaintext}`, encryptedDek: 'dek' }),
    decryptString: (encrypted: { encryptedKey: string }) => encrypted.encryptedKey.replace(/^enc:/, ''),
  };

  function createService(db: ReturnType<typeof createDb>, server: (url: string) => unknown, env = {}) {
    const fetcher = signedLicenseServer(server as never, signer);
    const endpoints = createEndpoints(db, documentHost({}), env);
    return new LicenseService(
      db as never,
      crypto as never,
      { APP_URL: 'https://opfield.example.com', APP_VERSION: 'v2.12.0', ...env } as never,
      fetcher as never,
      undefined,
      undefined,
      createTestLicenseVerifier(signer),
      endpoints
    );
  }

  it('stays with the address that answered', async () => {
    const db = createDb();
    const down = new Set([LICENSE_SERVICE_URLS[0]]);
    const server = vi.fn(async (url: string) => {
      if (down.has(new URL(url).origin)) throw new TypeError('fetch failed');
      return new URL(url).pathname.endsWith('/register')
        ? answer({ installationToken: 'WLT-GWI-TOKEN', state: communityState() }, 201)
        : answer(communityState());
    });
    const service = createService(db, server);

    await service.heartbeat();
    await service.checkNow();

    expect(server.mock.calls.map(([url]) => url)).toEqual([
      `${LICENSE_SERVICE_URLS[0]}/api/v1/installations/register`,
      `${LICENSE_SERVICE_URLS[1]}/api/v1/installations/register`,
      `${LICENSE_SERVICE_URLS[1]}/api/v1/installations/heartbeat`,
    ]);
    await expect(service.getStatus()).resolves.toMatchObject({
      registrationStatus: 'registered',
      serverUrl: LICENSE_SERVICE_URLS[1],
    });

    // The token is the installation's, not the address's: another address takes it as is.
    down.add(LICENSE_SERVICE_URLS[1]!);
    await service.checkNow();
    const [lastUrl, lastInit] = server.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(lastUrl).toBe(`${LICENSE_SERVICE_URLS[2]}/api/v1/installations/heartbeat`);
    expect(JSON.parse(String(lastInit.body))).toMatchObject({ installationToken: 'WLT-GWI-TOKEN' });
  });

  it('sends calls to the override first', async () => {
    const db = createDb();
    const server = vi.fn(async (_url: string) =>
      answer({ installationToken: 'WLT-GWI-TOKEN', state: communityState() }, 201)
    );
    const service = createService(db, server, { LICENSE_SERVICE_URL: 'https://license-proxy.example' });

    await service.heartbeat();

    expect(server.mock.calls.map(([url]) => url)).toEqual([
      'https://license-proxy.example/api/v1/installations/register',
    ]);
  });
});
