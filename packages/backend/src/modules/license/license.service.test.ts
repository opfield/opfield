import { afterEach, describe, expect, it, vi } from 'vitest';
import { LICENSE_SERVICE_URLS } from '@/config/vendor-urls.js';
import { LEGACY_COMMERCIAL_MANIFEST_KIND, LEGACY_LICENSE_VERSION_FIELD } from '@/lib/legacy-compat.js';
import { LicenseServerRequestError, LicenseService } from './license.service.js';
import {
  COMMUNITY_ENTITLEMENTS,
  LICENSE_OFFLINE_GRACE_DAYS,
  LICENSE_PLAN_ENTITLEMENTS,
  LICENSE_PLAN_ENTITLEMENTS_V3,
  LICENSE_PLAN_ENTITLEMENTS_V4,
  type LicenseServerState,
} from './license.types.js';
import {
  createTestLicenseSigner,
  createTestLicenseVerifier,
  signedLicenseServer,
  signTestLicenseState,
  TEST_INSTALLATION_ID,
} from './license-attestation.test-helpers.js';
import { LicensePolicyService } from './license-policy.service.js';

const signer = createTestLicenseSigner();
const verifier = createTestLicenseVerifier(signer);

function createDb() {
  const rows = new Map<string, unknown>([['license:installation_id', TEST_INSTALLATION_ID]]);
  // `eq(settings.key, key)` binds one value; `inArray(settings.key, keys)` binds an array of them.
  const keysFromCondition = (condition: unknown): string[] => {
    const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
    return chunks
      .flatMap((chunk) => (Array.isArray(chunk) ? chunk : [chunk]))
      .map((chunk) => (chunk as { value?: unknown }).value)
      .filter((value): value is string => typeof value === 'string' && value.startsWith('license:'));
  };
  const keyFromCondition = (condition: unknown): string | undefined => keysFromCondition(condition)[0];
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
    delete: () => ({
      where: (condition: unknown) => {
        const key = keyFromCondition(condition);
        if (key) rows.delete(key);
        return Promise.resolve();
      },
    }),
    rows,
  };
}

function createCrypto() {
  return {
    encryptString: (plaintext: string) => ({
      encryptedKey: `enc:${plaintext}`,
      encryptedDek: 'dek',
    }),
    decryptString: (encrypted: { encryptedKey: string }) => encrypted.encryptedKey.replace(/^enc:/, ''),
  };
}

const env = {
  APP_URL: 'https://opfield.example.com',
  APP_VERSION: 'v2.6.12',
} as never;

/** A service whose mocked license server signs every state like a current server. */
function createService(db: unknown, fetcher: unknown, eventBus?: unknown) {
  return new LicenseService(
    db as never,
    createCrypto() as never,
    env,
    signedLicenseServer(fetcher as never, signer) as never,
    undefined,
    eventBus as never,
    verifier
  );
}

const communityState = (): LicenseServerState => ({
  registrationStatus: 'registered',
  effectivePlan: 'community',
  paidLicenseStatus: 'none',
  graceUntil: null,
  entitlementsVersion: 5,
  entitlements: LICENSE_PLAN_ENTITLEMENTS.community,
  serverTime: new Date().toISOString(),
});

const paidState = (plan: 'personal' | 'business' | 'enterprise' = 'business'): LicenseServerState => {
  const expiresAt = new Date('2030-01-01T00:00:00.000Z');
  const graceHours = plan === 'personal' ? 24 : plan === 'business' ? 72 : 168;
  return {
    registrationStatus: 'registered',
    effectivePlan: plan,
    paidLicenseStatus: 'valid',
    paidLicense: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'active',
      plan,
      name: `Test ${plan}`,
      expiresAt: expiresAt.toISOString(),
      keyLast4: 'DDDD',
      metadata: { order: 'A-1' },
    },
    graceUntil: new Date(expiresAt.getTime() + graceHours * 60 * 60 * 1000).toISOString(),
    entitlementsVersion: 5,
    entitlements: LICENSE_PLAN_ENTITLEMENTS[plan],
    activation: {
      installationId: '11111111-1111-4111-8111-111111111111',
      installationName: 'opfield.example.com',
      activatedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    },
    serverTime: new Date().toISOString(),
  };
};

const expiredGraceState = (plan: 'personal' | 'business' | 'enterprise', expiresAt: Date): LicenseServerState => {
  const state = paidState(plan);
  state.paidLicenseStatus = 'expired_grace';
  state.paidLicense!.status = 'expired';
  state.paidLicense!.expiresAt = expiresAt.toISOString();
  state.graceUntil = new Date(
    expiresAt.getTime() + { personal: 24, business: 72, enterprise: 168 }[plan] * 60 * 60 * 1000
  ).toISOString();
  return state;
};

function dataResponse<T>(data: T, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data }),
  });
}

function errorResponse(code: string, message: string, status = 409) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message } }),
  });
}

/** One request that gets no answer at all tries every address of the license service. */
const LICENSE_SERVER_ADDRESSES = LICENSE_SERVICE_URLS.length;

function registerResponse(state = communityState()) {
  return dataResponse(
    {
      installationToken: 'WLT-GWI-INSTALLATION-TOKEN',
      state,
    },
    201
  );
}

describe('LicenseService', () => {
  it.each([
    'community',
    'personal',
  ] as const)('preserves the running v4 %s cache during target-image preparation and failed download', async (plan) => {
    const db = createDb();
    const cache = {
      registrationStatus: 'registered',
      plan,
      entitlementsVersion: 4,
      entitlements: LICENSE_PLAN_ENTITLEMENTS_V4[plan],
    };
    db.rows.set('license:cached_state', cache);
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() =>
        dataResponse({
          state: plan === 'community' ? communityState() : paidState(plan),
          signedManifest: 'signed-release',
        })
      )
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const service = createService(db, fetcher);
    const grant = await service.authorizeCommercialUpdate('v3.0.0-rc.1');
    if (grant.edition === 'commercial')
      expect((await grant.readFile('backend/index.cjs', 'a'.repeat(64))).status).toBe(503);
    expect(db.rows.get('license:cached_state')).toBe(cache);
  });

  it('registers for update without replacing the running cache or marking registration failures into it', async () => {
    for (const fails of [false, true]) {
      const db = createDb();
      const cache = { registrationStatus: 'pending', plan: 'community', entitlementsVersion: 4 };
      db.rows.set('license:cached_state', cache);
      const fetcher = fails
        ? vi.fn().mockRejectedValue(new Error('offline'))
        : vi
            .fn()
            .mockImplementationOnce(() => registerResponse())
            .mockImplementationOnce(() => dataResponse({ state: communityState() }));
      const service = createService(db, fetcher);
      if (fails) await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).rejects.toThrow();
      else await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).resolves.toEqual({ edition: 'community' });
      expect(db.rows.get('license:cached_state')).toBe(cache);
    }
  });

  it('reactivates a legacy key for preparation without migrating its active cache', async () => {
    const db = createDb();
    const cache = { plan: 'business', status: 'valid', entitlementsVersion: 3 };
    db.rows.set('license:cached_state', cache);
    db.rows.set('license:key_encrypted', createCrypto().encryptString('legacy-key'));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState()))
      .mockImplementationOnce(() => dataResponse({ state: paidState(), signedManifest: 'signed-release' }));
    const service = createService(db, fetcher);
    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).resolves.toMatchObject({ edition: 'commercial' });
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v1/installations/register',
      '/api/v1/licenses/activate',
      '/api/v1/releases/authorize',
    ]);
    expect(db.rows.get('license:cached_state')).toBe(cache);
  });

  it('keeps the v4 cache a release before v2.11 reads and stores its own state under a new key', async () => {
    const db = createDb();
    const legacy = {
      registrationStatus: 'registered',
      status: 'valid',
      plan: 'business',
      paidPlan: 'business',
      paidLicenseStatus: 'valid',
      entitlementsVersion: 4,
      entitlements: LICENSE_PLAN_ENTITLEMENTS_V4.business,
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: new Date().toISOString(),
      errorMessage: null,
    };
    db.rows.set('license:cached_state', legacy);
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    db.rows.set('license:key_encrypted', createCrypto().encryptString('WLT-GW-AAAA-BBBB-CCCC-DDDD'));
    const fetcher = vi.fn().mockImplementation(() => dataResponse(paidState('business')));
    const service = createService(db, fetcher);

    // An unsigned cache from an older release is replaced by a signed state at the first heartbeat.
    await service.heartbeat();
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/v1/installations/heartbeat']);
    await expect(service.getStatus()).resolves.toMatchObject({ status: 'valid', plan: 'business' });
    expect(db.rows.get('license:cached_state_v5')).toMatchObject({ entitlementsVersion: 5, status: 'valid' });
    // An updater rollback to that release finds its cache as it left it.
    expect(db.rows.get('license:cached_state')).toBe(legacy);

    // After the rolled-back release wrote its cache again, this release keeps its own signed state.
    db.rows.set('license:cached_state', { ...legacy, plan: 'community', lastCheckedAt: new Date().toISOString() });
    await expect(createService(db, vi.fn()).getStatus()).resolves.toMatchObject({ status: 'valid', plan: 'business' });
  });

  it('authorizes an exact private core online and keeps installation credentials out of URLs', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => dataResponse({ state: paidState('personal'), signedManifest: 'signed-release' }))
      .mockResolvedValueOnce(new Response('core-bytes'));
    const service = createService(db, fetcher);
    const grant = await service.authorizeCommercialUpdate('v3.0.0-rc.1');
    expect(grant.edition).toBe('commercial');
    if (grant.edition !== 'commercial') throw new Error('Expected private grant');
    await grant.readFile('backend/index.cjs', 'a'.repeat(64));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/\/api\/v1\/releases\/authorize$/),
      expect.stringMatching(/\/api\/v1\/releases\/file$/),
    ]);
    const download = fetcher.mock.calls[1][1];
    expect(download.redirect).toBe('error');
    expect(JSON.parse(download.body)).toMatchObject({
      installationToken: 'installation-secret',
      hostVersion: 'v3.0.0-rc.1',
      path: 'backend/index.cjs',
    });
  });

  it('does not use cached paid rights when online update authorization fails', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const service = createService(db, fetcher);
    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).rejects.toMatchObject({
      code: 'LICENSE_SERVER_UNAVAILABLE',
    });
    expect(fetcher).toHaveBeenCalledTimes(LICENSE_SERVER_ADDRESSES);
  });

  it.each([
    ['unreachable', () => Promise.reject(new Error('offline'))],
    ['failing', () => Promise.resolve(new Response('bad gateway', { status: 502 }))],
  ])('prepares a Community update while the license server is %s if nothing paid can be lost', async (_, answer) => {
    for (const registered of [false, true]) {
      const db = createDb();
      db.rows.set('license:cached_state', { registrationStatus: 'pending', plan: 'community', entitlementsVersion: 4 });
      if (registered)
        db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
      const service = createService(db, vi.fn().mockImplementation(answer));
      await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1', { privateCoreInstalled: false })).resolves.toEqual({
        edition: 'community',
      });
    }
  });

  it.each([
    ['a paid key is stored', { privateCoreInstalled: false }, { 'license:key_encrypted': 'paid' }],
    ['a private core is on the host', { privateCoreInstalled: true }, {}],
    ['the caller did not check the host', {}, {}],
    [
      'the state names a paid plan',
      { privateCoreInstalled: false },
      { 'license:cached_state_v5': { plan: 'community', paidPlan: 'business' } },
    ],
    ['the legacy state is paid', { privateCoreInstalled: false }, { 'license:cached_state': { plan: 'business' } }],
  ] as const)('keeps update admission online when %s', async (_, host, rows) => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    for (const [key, value] of Object.entries(rows))
      db.rows.set(key, key === 'license:key_encrypted' ? createCrypto().encryptString(value as string) : value);
    const service = createService(db, vi.fn().mockRejectedValue(new Error('offline')));
    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1', host)).rejects.toMatchObject({
      code: 'LICENSE_SERVER_UNAVAILABLE',
    });
  });

  it('does not treat a refusal as an unreachable license server', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const service = createService(
      db,
      vi.fn().mockImplementation(() => errorResponse('INSTALLATION_REVOKED', 'Installation revoked', 403))
    );
    await expect(
      service.authorizeCommercialUpdate('v3.0.0-rc.1', { privateCoreInstalled: false })
    ).rejects.toMatchObject({ code: 'INSTALLATION_REVOKED' });
  });

  it('refuses a silent Community downgrade while a local paid key remains', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    db.rows.set('license:key_encrypted', createCrypto().encryptString('paid-secret'));
    const fetcher = vi.fn().mockImplementation(() => dataResponse({ state: communityState() }));
    const service = createService(db, fetcher);
    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).rejects.toMatchObject({
      code: 'COMMERCIAL_UPDATE_NOT_AUTHORIZED',
    });
  });

  it.each([
    ['expired_grace', 'personal'],
    ['expired', 'community'],
    ['revoked', 'community'],
    ['replaced', 'community'],
    ['deactivated', 'community'],
  ] as const)('keeps the private core on update for a %s installation', async (paidLicenseStatus, effectivePlan) => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const expiresAt = new Date('2026-08-17T12:00:00.000Z');
    const state = expiredGraceState('personal', expiresAt);
    state.effectivePlan = effectivePlan;
    state.paidLicenseStatus = paidLicenseStatus;
    if (effectivePlan === 'community') state.entitlements = LICENSE_PLAN_ENTITLEMENTS.community;
    if (paidLicenseStatus === 'revoked') state.paidLicense!.status = 'revoked';
    if (paidLicenseStatus === 'replaced' || paidLicenseStatus === 'deactivated') delete state.activation;
    const fetcher = vi.fn().mockImplementation(() => dataResponse({ state, signedManifest: 'signed-release' }));
    const service = createService(db, fetcher);

    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).resolves.toMatchObject({
      edition: 'commercial',
      signedManifest: 'signed-release',
    });
  });

  it('refuses an update that would drop the private core of a lost paid installation', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const state = expiredGraceState('business', new Date('2026-08-17T12:00:00.000Z'));
    state.effectivePlan = 'community';
    state.paidLicenseStatus = 'expired';
    state.entitlements = LICENSE_PLAN_ENTITLEMENTS.community;
    const service = createService(
      db,
      vi.fn().mockImplementation(() => dataResponse({ state }))
    );

    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).rejects.toMatchObject({
      code: 'COMMERCIAL_UPDATE_NOT_AUTHORIZED',
    });
  });

  it('permits verified Community preparation without a private release', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const fetcher = vi.fn().mockImplementation(() => dataResponse({ state: communityState() }));
    const service = createService(db, fetcher);
    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).resolves.toEqual({ edition: 'community' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns usable Community with pending registration before the first heartbeat', async () => {
    const fetcher = vi.fn();
    const service = createService(createDb(), fetcher);

    const status = await service.getStatus();

    expect(status).toMatchObject({
      status: 'community',
      plan: 'community',
      registrationStatus: 'pending',
      licensed: true,
      hasKey: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('registers Community with a client-held nonce and stores only encrypted credentials', async () => {
    const db = createDb();
    const fetcher = vi.fn().mockImplementation(() => registerResponse());
    const service = createService(db, fetcher);

    await service.heartbeat();

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://license.opfield.dev/api/v1/installations/register');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      installationName: 'opfield.example.com',
      [LEGACY_LICENSE_VERSION_FIELD]: 'v2.6.12',
      entitlementsVersion: 5,
    });
    expect(body.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.registrationNonce.length).toBeGreaterThanOrEqual(32);
    expect(db.rows.get('license:registration_nonce_encrypted')).toMatchObject({
      encryptedKey: expect.stringMatching(/^enc:/),
    });
    expect(db.rows.get('license:installation_token_encrypted')).toEqual({
      encryptedKey: 'enc:WLT-GWI-INSTALLATION-TOKEN',
      encryptedDek: 'dek',
    });
    expect(db.rows.has('license:installation_token')).toBe(false);
    expect(db.rows.has('license:registration_nonce')).toBe(false);
    expect(await service.getStatus()).toMatchObject({
      plan: 'community',
      registrationStatus: 'registered',
    });
  });

  it('moves on to the next license service address only when one gives no answer', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(() => registerResponse());
    const service = createService(db, fetcher);

    await service.heartbeat();

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://license.opfield.dev/api/v1/installations/register',
      'https://license.thesqlabs.com/api/v1/installations/register',
    ]);
    expect(await service.getStatus()).toMatchObject({ registrationStatus: 'registered' });
  });

  it('does not retry an answer from the license service on another address', async () => {
    const db = createDb();
    const fetcher = vi.fn().mockImplementation(() => errorResponse('LICENSE_SERVER_ERROR', 'Unavailable', 503));
    const service = createService(db, fetcher);

    await service.heartbeat();

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('treats a response that is not the license service, such as a proxy error page, as no answer', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }))
      .mockImplementation(() => registerResponse());
    const service = createService(db, fetcher);

    await service.heartbeat();

    expect(fetcher.mock.calls.map(([url]) => new URL(url).origin)).toEqual(LICENSE_SERVICE_URLS);
    expect(await service.getStatus()).toMatchObject({
      registrationStatus: 'registered',
      serverUrl: LICENSE_SERVICE_URLS[1],
    });
  });

  it('keeps Community usable and pending when automatic registration is unavailable', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const service = createService(createDb(), fetcher);

    await expect(service.heartbeat()).resolves.toBeUndefined();

    expect(await service.getStatus()).toMatchObject({
      status: 'community',
      plan: 'community',
      registrationStatus: 'pending',
      licensed: true,
      errorMessage: 'License server is unavailable',
    });
  });

  it('serializes concurrent Community registration attempts', async () => {
    const fetcher = vi.fn().mockImplementation(() => registerResponse());
    const service = createService(createDb(), fetcher);

    await Promise.all([service.heartbeat(), service.heartbeat()]);

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('uses one stable installation ID across concurrent status and registration calls', async () => {
    const db = createDb();
    const fetcher = vi.fn().mockImplementation(() => registerResponse());
    const service = createService(db, fetcher);

    const [status] = await Promise.all([service.getStatus(), service.heartbeat()]);

    const registrationBody = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(status.installationId).toBe(registrationBody.installationId);
    expect(db.rows.get('license:installation_id')).toBe(status.installationId);
  });

  it('serializes heartbeat state updates with paid activation', async () => {
    const db = createDb();
    type HeartbeatResponse = Awaited<ReturnType<typeof dataResponse<LicenseServerState>>>;
    let resolveHeartbeat!: (response: HeartbeatResponse) => void;
    const heartbeatResponse = new Promise<HeartbeatResponse>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => heartbeatResponse)
      .mockImplementationOnce(() => dataResponse(paidState('business')));
    const service = createService(db, fetcher);
    await service.heartbeat();
    db.rows.set('license:cached_state_v5', {
      ...(db.rows.get('license:cached_state_v5') as Record<string, unknown>),
      lastCheckedAt: '2020-01-01T00:00:00.000Z',
    });

    const heartbeat = service.heartbeat();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const activation = service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');
    expect(fetcher).toHaveBeenCalledTimes(2);

    resolveHeartbeat(await dataResponse(communityState()));
    await heartbeat;
    const status = await activation;

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(status).toMatchObject({ status: 'valid', plan: 'business', hasKey: true });
  });

  it('requires online registration and activation before storing a paid key', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('business')));
    const service = createService(db, fetcher);

    const status = await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      installationToken: 'WLT-GWI-INSTALLATION-TOKEN',
      licenseKey: 'WLT-GW-AAAA-BBBB-CCCC-DDDD',
      entitlementsVersion: 5,
      requestNonce: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      attestationKeyIds: ['gls-test'],
    });
    expect(status).toMatchObject({
      status: 'valid',
      plan: 'business',
      registrationStatus: 'registered',
      licenseName: 'Test business',
      licenseMetadata: { order: 'A-1' },
      keyLast4: 'DDDD',
    });
    expect(db.rows.get('license:key_encrypted')).toEqual({
      encryptedKey: 'enc:WLT-GW-AAAA-BBBB-CCCC-DDDD',
      encryptedDek: 'dek',
    });
  });

  it('does not store a paid key when registration or activation fails', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => errorResponse('LICENSE_IN_USE', 'License is in use'));
    const service = createService(db, fetcher);

    await expect(service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      code: 'LICENSE_IN_USE',
    });
    expect(db.rows.has('license:key_encrypted')).toBe(false);
  });

  it('keeps a previously valid paid plan only during network grace', async () => {
    const db = createDb();
    const activateFetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('enterprise')));
    const service = createService(db, activateFetcher);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    const failed = createService(db, vi.fn().mockRejectedValue(new Error('network down')));
    const status = await failed.checkNow();

    expect(status).toMatchObject({
      status: 'valid_with_warning',
      plan: 'enterprise',
      licensed: true,
      errorMessage: 'License server is unavailable',
    });
    expect(status.offlineGraceUntil).toBeTruthy();
    expect(status.graceUntil).toBeNull();
  });

  it('keeps paid entitlements for exactly 100 days after the last signed valid state', async () => {
    vi.useFakeTimers();
    const lastValidAt = new Date('2026-09-01T12:00:00.000Z');
    vi.setSystemTime(lastValidAt);
    const offlineGraceUntil = new Date(lastValidAt.getTime() + LICENSE_OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const db = createDb();
    const activation = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('enterprise')));
    await createService(db, activation).activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');
    const service = createService(db, vi.fn().mockRejectedValue(new Error('network down')));
    await service.checkNow();

    vi.setSystemTime(new Date(offlineGraceUntil.getTime() - 1));
    await expect(service.getStatus()).resolves.toMatchObject({
      status: 'valid_with_warning',
      plan: 'enterprise',
      licensed: true,
      offlineGraceUntil: offlineGraceUntil.toISOString(),
    });

    vi.setSystemTime(offlineGraceUntil);
    await expect(service.getStatus()).resolves.toMatchObject({
      status: 'unreachable_grace_expired',
      plan: 'community',
      licensed: false,
      offlineGraceUntil: offlineGraceUntil.toISOString(),
    });

    // Clearing the recorded error in the database cannot stretch an old signature.
    db.rows.set('license:cached_state_v5', {
      ...(db.rows.get('license:cached_state_v5') as Record<string, unknown>),
      errorMessage: null,
      lastValidAt: new Date().toISOString(),
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      status: 'unreachable_grace_expired',
      plan: 'community',
      licensed: false,
    });
  });

  it.each([3, 4])('applies current Community limits to a valid cached v%s grant', async (version) => {
    const legacy = version === 3 ? LICENSE_PLAN_ENTITLEMENTS_V3 : LICENSE_PLAN_ENTITLEMENTS_V4;
    const db = createDb();
    const service = createService(db, vi.fn());
    const cached = {
      ...(await service.getStatus()),
      entitlementsVersion: version,
      entitlements: legacy.community,
    };
    db.rows.set('license:cached_state', cached);
    const status = await service.getStatus();
    expect(status).toMatchObject({
      plan: 'community',
      entitlementsVersion: 5,
      entitlements: COMMUNITY_ENTITLEMENTS,
    });
    expect(db.rows.get('license:cached_state')).toEqual(cached);
  });

  it.each(['unknown-version', 'altered-quota'])('does not normalize a corrupt Community cache: %s', async (kind) => {
    const db = createDb();
    const service = createService(db, vi.fn());
    db.rows.set('license:cached_state', {
      ...(await service.getStatus()),
      entitlementsVersion: kind === 'unknown-version' ? 999 : 4,
      entitlements: { ...LICENSE_PLAN_ENTITLEMENTS_V4.community, users: kind === 'altered-quota' ? 100 : 10 },
    });
    const policy = new LicensePolicyService(service);
    await expect(policy.requireQuota('users', 0)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it.each([3, 4])('never elevates an unsigned paid v%s cache from an older release', async (version) => {
    const legacy = version === 3 ? LICENSE_PLAN_ENTITLEMENTS_V3 : LICENSE_PLAN_ENTITLEMENTS_V4;
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    db.rows.set('license:key_encrypted', createCrypto().encryptString('WLT-GW-AAAA-BBBB-CCCC-DDDD'));
    db.rows.set('license:cached_state', {
      registrationStatus: 'registered',
      status: 'valid',
      plan: 'personal',
      paidPlan: 'personal',
      paidLicenseStatus: 'valid',
      expiresAt: null,
      graceUntil: null,
      entitlementsVersion: version,
      entitlements: legacy.personal,
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: new Date().toISOString(),
      errorMessage: null,
    });
    const offline = vi.fn().mockRejectedValue(new Error('network down'));
    const service = createService(db, offline);

    await expect(service.getStatus()).resolves.toMatchObject({
      status: 'unreachable_grace_expired',
      plan: 'community',
      licensed: false,
      entitlements: COMMUNITY_ENTITLEMENTS,
    });
    const policy = new LicensePolicyService(service);
    // Existing paid resources keep operating; new ones need a signed state.
    await expect(policy.requireFeatureForExistingRuntime('pages')).resolves.toBeUndefined();
    await expect(policy.requireFeature('pages')).rejects.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });

    // The unsigned cache is replaced at the first heartbeat, even inside the interval.
    await service.heartbeat();
    expect(offline).toHaveBeenCalledTimes(LICENSE_SERVER_ADDRESSES);
    expect(db.rows.has('license:installation_token_encrypted')).toBe(true);
    expect(db.rows.has('license:key_encrypted')).toBe(true);

    const online = createService(
      db,
      vi.fn().mockImplementation(() => dataResponse(paidState('personal')))
    );
    await online.heartbeat();
    await expect(online.getStatus()).resolves.toMatchObject({ status: 'valid', plan: 'personal', licensed: true });
  });

  it.each([
    ['personal', 24],
    ['business', 72],
    ['enterprise', 168],
  ] as const)('keeps %s entitlements during its %dh expiration grace', async (plan, graceHours) => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-08-17T12:00:00.000Z');
    const graceUntil = new Date(expiresAt.getTime() + graceHours * 60 * 60 * 1000);
    vi.setSystemTime(new Date(expiresAt.getTime() + 60_000));
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const service = createService(
      db,
      vi.fn().mockImplementation(() => dataResponse(expiredGraceState(plan, expiresAt)))
    );

    await service.checkNow();

    expect(await service.getStatus()).toMatchObject({
      status: 'expired_grace',
      plan,
      licensed: true,
      graceUntil: graceUntil.toISOString(),
      entitlements: LICENSE_PLAN_ENTITLEMENTS[plan],
    });
    const policy = new LicensePolicyService(service);
    await expect(policy.hasFeature('compose-applications')).resolves.toBe(true);
    vi.setSystemTime(new Date(graceUntil.getTime() - 1));
    await expect(policy.hasFeature('compose-applications')).resolves.toBe(true);
    vi.setSystemTime(graceUntil);
    await expect(policy.hasFeature('compose-applications')).resolves.toBe(false);
    await expect(policy.hasFeatureForExistingRuntime('compose-applications')).resolves.toBe(true);
  });

  it('downgrades locally when expiration grace ends without another heartbeat', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-08-17T12:00:00.000Z');
    const graceUntil = new Date('2026-08-20T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-08-17T12:01:00.000Z'));
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const service = createService(
      db,
      vi.fn().mockImplementation(() => dataResponse(expiredGraceState('business', expiresAt)))
    );
    await service.checkNow();

    vi.setSystemTime(graceUntil);
    expect(await service.getStatus()).toMatchObject({
      status: 'expired',
      plan: 'community',
      licensed: false,
      graceUntil: null,
      entitlements: expect.objectContaining({ managedNodes: 25, users: 3, customPermissionGroups: 1 }),
    });

    const policy = new LicensePolicyService(service);
    await expect(policy.hasFeatureForExistingRuntime('structured-logging')).resolves.toBe(true);
    await expect(policy.hasFeatureForExistingRuntime('internal-pki')).resolves.toBe(false);
    await expect(policy.requireFeature('structured-logging')).rejects.toMatchObject({
      statusCode: 403,
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
    });
    await expect(policy.requireQuota('users', 10)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LICENSE_QUOTA_EXCEEDED',
    });
  });

  it('retains only the former plan runtime features after server-reported expiration', async () => {
    const valid = paidState('business');
    const expired = paidState('business');
    const expiresAt = new Date('2026-08-17T12:00:00.000Z');
    expired.effectivePlan = 'community';
    expired.paidLicenseStatus = 'expired';
    expired.paidLicense!.status = 'expired';
    expired.paidLicense!.expiresAt = expiresAt.toISOString();
    expired.graceUntil = new Date(expiresAt.getTime() + 72 * 60 * 60 * 1000).toISOString();
    expired.entitlements = COMMUNITY_ENTITLEMENTS;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(valid))
      .mockImplementationOnce(() => dataResponse(expired));
    const service = createService(createDb(), fetcher);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');
    await service.checkNow();

    const policy = new LicensePolicyService(service);
    await expect(policy.hasFeatureForExistingRuntime('structured-logging')).resolves.toBe(true);
    await expect(policy.hasFeatureForExistingRuntime('internal-pki')).resolves.toBe(false);
    await expect(policy.hasFeature('structured-logging')).resolves.toBe(false);
    await expect(policy.requireFeature('structured-logging')).rejects.toMatchObject({
      statusCode: 403,
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
    });
  });

  it('downgrades a replaced paid activation to Community authoritatively', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('personal')))
      .mockImplementationOnce(() =>
        dataResponse({
          ...communityState(),
          paidLicenseStatus: 'replaced',
          paidLicense: paidState('personal').paidLicense,
          graceUntil: paidState('personal').graceUntil,
          activation: paidState('personal').activation,
        })
      );
    const service = createService(db, fetcher);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    const status = await service.checkNow();

    expect(status).toMatchObject({
      status: 'replaced',
      plan: 'community',
      licensed: false,
      paidLicenseStatus: 'replaced',
    });
  });

  it('detaches from the server before deleting the local paid key', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState()))
      .mockImplementationOnce(() => dataResponse(communityState()));
    const service = createService(db, fetcher);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    const status = await service.clearKey();

    expect(fetcher.mock.calls[2]![0]).toContain('/api/v1/licenses/deactivate');
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
      installationToken: 'WLT-GWI-INSTALLATION-TOKEN',
      entitlementsVersion: 5,
      requestNonce: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      attestationKeyIds: ['gls-test'],
    });
    expect(db.rows.has('license:key_encrypted')).toBe(false);
    expect(status).toMatchObject({ status: 'community', plan: 'community', hasKey: false });
  });

  it('retains the local key when server detach fails', async () => {
    const db = createDb();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState()))
      .mockImplementationOnce(() => errorResponse('LICENSE_SERVER_ERROR', 'Unavailable', 503));
    const service = createService(db, fetcher);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    await expect(service.clearKey()).rejects.toBeInstanceOf(LicenseServerRequestError);
    expect(db.rows.has('license:key_encrypted')).toBe(true);
  });

  it('uses a 30 minute Community cadence while the scheduler ticks every 15 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementation(() => dataResponse(communityState()));
    const service = createService(createDb(), fetcher);

    await service.heartbeat();
    vi.setSystemTime(new Date('2026-08-16T12:15:00.000Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date('2026-08-16T12:30:00.001Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({ entitlementsVersion: 5 });
  });

  it('retries pending Community registration no more than every 30 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const service = createService(createDb(), fetcher);

    await service.heartbeat();
    vi.setSystemTime(new Date('2026-08-16T12:15:00.000Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledTimes(LICENSE_SERVER_ADDRESSES);

    vi.setSystemTime(new Date('2026-08-16T12:30:00.001Z'));
    await service.heartbeat();
    expect(fetcher).toHaveBeenCalledTimes(2 * LICENSE_SERVER_ADDRESSES);
  });

  it('attempts one online activation for a legacy encrypted Homelab key after registration', async () => {
    const db = createDb();
    db.rows.set('license:key_encrypted', {
      encryptedKey: 'enc:WLT-GW-LEGACY',
      encryptedDek: 'dek',
    });
    db.rows.set('license:cached_state', {
      status: 'valid',
      tier: 'homelab',
      lastCheckedAt: new Date().toISOString(),
      lastValidAt: new Date().toISOString(),
    });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(paidState('personal')));
    const service = createService(db, fetcher);

    const status = await service.checkNow();

    expect(fetcher.mock.calls[1]![0]).toContain('/api/v1/licenses/activate');
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({ entitlementsVersion: 5 });
    expect(status).toMatchObject({ status: 'valid', plan: 'personal' });
  });

  it('rejects noncanonical server entitlements before storing credentials', async () => {
    const db = createDb();
    const malformed = communityState();
    malformed.entitlements = LICENSE_PLAN_ENTITLEMENTS.personal;
    const fetcher = vi.fn().mockImplementation(() => registerResponse(malformed));
    const service = createService(db, fetcher);

    await service.heartbeat();

    expect(db.rows.has('license:installation_token_encrypted')).toBe(false);
    expect(await service.getStatus()).toMatchObject({ status: 'community', registrationStatus: 'pending' });
  });

  it('rejects a paid effective state without paid license metadata', async () => {
    const db = createDb();
    const malformed = paidState('business');
    delete malformed.paidLicense;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(malformed));
    const service = createService(db, fetcher);

    await expect(service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      code: 'INVALID_LICENSE_STATE',
    });
    expect(db.rows.has('license:key_encrypted')).toBe(false);
  });

  it('ignores an unsigned cache that claims a longer expiration grace', async () => {
    vi.useFakeTimers();
    const db = createDb();
    const expiresAt = new Date('2026-08-17T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-08-18T12:00:00.001Z'));
    db.rows.set('license:cached_state_v5', {
      registrationStatus: 'registered',
      status: 'expired_grace',
      plan: 'business',
      paidPlan: 'business',
      paidLicenseStatus: 'expired_grace',
      licenseName: 'Business',
      licenseMetadata: {},
      expiresAt: expiresAt.toISOString(),
      graceUntil: new Date('2026-08-24T12:00:00.000Z').toISOString(),
      entitlementsVersion: 5,
      entitlements: LICENSE_PLAN_ENTITLEMENTS.business,
      lastCheckedAt: expiresAt.toISOString(),
      lastValidAt: expiresAt.toISOString(),
      activeInstallationId: null,
      activeInstallationName: null,
      errorMessage: null,
    });
    const service = createService(db, vi.fn());

    expect(await service.getStatus()).toMatchObject({
      status: 'unreachable_grace_expired',
      plan: 'community',
      licensed: false,
    });
  });

  it('publishes lifecycle transitions at expiry without waiting for heartbeat', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-17T12:00:00.000Z');
    vi.setSystemTime(now);
    const state = paidState('business');
    state.paidLicense!.expiresAt = new Date(now.getTime() + 10_000).toISOString();
    state.graceUntil = new Date(now.getTime() + 72 * 60 * 60 * 1000 + 10_000).toISOString();
    state.serverTime = now.toISOString();
    const eventBus = { publish: vi.fn() };
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => registerResponse())
      .mockImplementationOnce(() => dataResponse(state));
    const service = createService(createDb(), fetcher, eventBus);
    await service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(eventBus.publish).toHaveBeenCalledWith(
      'system.license.changed',
      expect.objectContaining({ status: 'expired_grace', plan: 'business' })
    );
  });
});

describe('LicenseService signed states', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A registered installation that already applied a signed paid state. */
  async function activatedService(plan: 'personal' | 'business' | 'enterprise' = 'business') {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    await createService(
      db,
      vi.fn().mockImplementation(() => dataResponse(paidState(plan)))
    ).activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD');
    return db;
  }

  function rawServer(respond: (body: { requestNonce: string }) => unknown) {
    return vi.fn(async (_url: string, init: RequestInit) => dataResponse(respond(JSON.parse(String(init.body)))));
  }

  function unsignedService(db: ReturnType<typeof createDb>, fetcher: unknown) {
    return new LicenseService(
      db as never,
      createCrypto() as never,
      env,
      fetcher as never,
      undefined,
      undefined,
      verifier
    );
  }

  it('rejects an unsigned state and keeps the last signed state in offline grace', async () => {
    const db = await activatedService('business');
    const forged = paidState('enterprise');
    const service = unsignedService(
      db,
      rawServer(() => forged)
    );

    const status = await service.checkNow();

    expect(status).toMatchObject({ status: 'valid_with_warning', plan: 'business', licensed: true });
    expect(status.errorMessage).toBe('License state is not signed');
  });

  it('applies only the signed copy of a state, never the unsigned fields beside it', async () => {
    const db = await activatedService('personal');
    const service = unsignedService(
      db,
      rawServer(({ requestNonce }) => {
        const signed = communityState();
        const attestation = signTestLicenseState(signer, signed, { purpose: 'heartbeat', requestNonce });
        return { ...paidState('enterprise'), attestation };
      })
    );

    const status = await service.checkNow();

    expect(status).toMatchObject({ status: 'community', plan: 'community' });
  });

  it.each<
    [
      string,
      Partial<{
        keyId: string;
        installationId: string;
        purpose: 'register';
        requestNonce: string;
        issuedAt: string;
        kind: string;
      }>,
    ]
  >([
    ['another key', { keyId: 'gls-retired' }],
    ['another installation', { installationId: '22222222-2222-4222-8222-222222222222' }],
    ['another purpose', { purpose: 'register' }],
    ['another request (replay)', { requestNonce: 'captured-from-an-earlier-request' }],
    ['a stale issue time', { issuedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() }],
    ['another kind', { kind: LEGACY_COMMERCIAL_MANIFEST_KIND }],
  ])('rejects a state signed for %s', async (_label, override) => {
    const db = await activatedService('business');
    const other = createTestLicenseSigner(override.keyId ?? 'gls-test');
    const service = unsignedService(
      db,
      rawServer(({ requestNonce }) => {
        const state = paidState('enterprise');
        return {
          ...state,
          attestation: signTestLicenseState(override.keyId ? other : signer, state, {
            purpose: 'heartbeat',
            requestNonce,
            ...override,
          }),
        };
      })
    );

    const status = await service.checkNow();

    expect(status).toMatchObject({ status: 'valid_with_warning', plan: 'business' });
  });

  it('rejects a tampered signed payload', async () => {
    const db = await activatedService('business');
    const service = unsignedService(
      db,
      rawServer(({ requestNonce }) => {
        const state = paidState('business');
        const attestation = signTestLicenseState(signer, state, { purpose: 'heartbeat', requestNonce });
        const payload = JSON.parse(Buffer.from(attestation.payload, 'base64url').toString('utf8'));
        payload.state = paidState('enterprise');
        return {
          ...state,
          attestation: { ...attestation, payload: Buffer.from(JSON.stringify(payload)).toString('base64url') },
        };
      })
    );

    await expect(service.checkNow()).resolves.toMatchObject({ status: 'valid_with_warning', plan: 'business' });
  });

  it('accepts a rotated key pinned by the release and names the pinned keys in requests', async () => {
    const next = createTestLicenseSigner('gls-next');
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const fetcher = vi.fn().mockImplementation(() => dataResponse(paidState('enterprise')));
    const service = new LicenseService(
      db as never,
      createCrypto() as never,
      env,
      signedLicenseServer(fetcher as never, next) as never,
      undefined,
      undefined,
      createTestLicenseVerifier(signer, next)
    );

    await expect(service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD')).resolves.toMatchObject({
      status: 'valid',
      plan: 'enterprise',
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).attestationKeyIds).toEqual(['gls-test', 'gls-next']);

    // A release that no longer pins the retired key treats its stored state as unsigned.
    const retired = createService(db, vi.fn().mockRejectedValue(new Error('network down')));
    await expect(retired.getStatus()).resolves.toMatchObject({ status: 'unreachable_grace_expired', licensed: false });
  });

  it('refuses a paid activation whose state is not signed', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const service = unsignedService(
      db,
      rawServer(() => paidState('enterprise'))
    );

    await expect(service.activateKey('WLT-GW-AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      code: 'INVALID_LICENSE_SIGNATURE',
    });
    expect(db.rows.has('license:key_encrypted')).toBe(false);
  });

  it('does not store the token of an unsigned registration', async () => {
    const db = createDb();
    const service = unsignedService(
      db,
      vi.fn().mockImplementation(() => registerResponse())
    );

    await service.heartbeat();

    expect(db.rows.has('license:installation_token_encrypted')).toBe(false);
    await expect(service.getStatus()).resolves.toMatchObject({ status: 'community', registrationStatus: 'pending' });
  });

  it('authorizes a private core download only from a state signed for that request', async () => {
    const db = createDb();
    db.rows.set('license:installation_token_encrypted', createCrypto().encryptString('installation-secret'));
    const service = unsignedService(
      db,
      rawServer(() => ({ state: paidState('personal'), signedManifest: 'signed-release' }))
    );

    await expect(service.authorizeCommercialUpdate('v3.0.0-rc.1')).rejects.toMatchObject({
      code: 'INVALID_LICENSE_SIGNATURE',
    });
    // An answer that fails verification is not an unreachable server, even with nothing paid to keep.
    const community = unsignedService(
      db,
      rawServer(() => ({ state: communityState() }))
    );
    await expect(
      community.authorizeCommercialUpdate('v3.0.0-rc.1', { privateCoreInstalled: false })
    ).rejects.toMatchObject({ code: 'INVALID_LICENSE_SIGNATURE' });
  });

  it('clamps a forged cache in the database to Community with continuity', async () => {
    const db = await activatedService('personal');
    const cached = db.rows.get('license:cached_state_v5') as Record<string, unknown>;
    db.rows.set('license:cached_state_v5', {
      ...cached,
      status: 'valid',
      plan: 'enterprise',
      paidPlan: 'enterprise',
      entitlements: LICENSE_PLAN_ENTITLEMENTS.enterprise,
      attestation: { ...(cached.attestation as object), signature: 'forged' },
    });
    const service = createService(db, vi.fn());
    const policy = new LicensePolicyService(service);

    await expect(service.getStatus()).resolves.toMatchObject({ plan: 'community', licensed: false });
    await expect(policy.requireFeature('internal-pki')).rejects.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    // The retained signed Personal state still proves continuity for existing resources.
    await expect(policy.requireFeatureForExistingRuntime('pages')).resolves.toBeUndefined();
    await expect(policy.requireFeatureForExistingRuntime('internal-pki')).rejects.toMatchObject({
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
    });
  });

  it('keeps a downgraded plan for its grace from the last signed higher state', async () => {
    vi.useFakeTimers();
    const downgradedAt = new Date('2026-09-10T12:00:00.000Z');
    vi.setSystemTime(downgradedAt);
    const db = await activatedService('enterprise');
    const service = createService(
      db,
      vi.fn().mockImplementation(() => dataResponse(paidState('business')))
    );
    const policy = new LicensePolicyService(service);
    vi.setSystemTime(new Date(downgradedAt.getTime() + 60_000));
    await service.checkNow();

    await expect(service.getStatus()).resolves.toMatchObject({
      status: 'valid',
      plan: 'enterprise',
      graceUntil: new Date(downgradedAt.getTime() + 168 * 60 * 60 * 1000).toISOString(),
    });
    await expect(policy.hasFeature('siem-export')).resolves.toBe(true);

    vi.setSystemTime(new Date(downgradedAt.getTime() + 168 * 60 * 60 * 1000));
    await expect(service.getStatus()).resolves.toMatchObject({ status: 'valid', plan: 'business', graceUntil: null });
    await expect(policy.hasFeature('siem-export')).resolves.toBe(false);
    await expect(policy.requireFeature('internal-pki')).rejects.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    await expect(policy.requireFeatureForExistingRuntime('internal-pki')).resolves.toBeUndefined();
  });

  it('applies revocation at once without grace but keeps continuity for existing resources', async () => {
    const db = await activatedService('enterprise');
    const revoked = (): LicenseServerState => ({
      ...communityState(),
      paidLicenseStatus: 'revoked',
      paidLicense: { ...paidState('enterprise').paidLicense!, status: 'revoked' },
      graceUntil: paidState('enterprise').graceUntil,
    });
    const service = createService(
      db,
      vi.fn().mockImplementation(() => dataResponse(revoked()))
    );
    const policy = new LicensePolicyService(service);

    await expect(service.checkNow()).resolves.toMatchObject({ status: 'revoked', plan: 'community', licensed: false });
    await expect(policy.hasFeature('siem-export')).resolves.toBe(false);
    await expect(policy.hasFeature('git-push-to-deploy')).resolves.toBe(false);
    await expect(policy.requireFeatureForExistingRuntime('internal-pki')).resolves.toBeUndefined();
    await expect(policy.requireFeatureForExistingRuntime('siem-export')).resolves.toBeUndefined();
  });

  it('gives a replacement or re-activation no downgrade grace after a reported loss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    const db = await activatedService('enterprise');
    const responses = [
      {
        ...communityState(),
        paidLicenseStatus: 'deactivated',
        paidLicense: paidState('enterprise').paidLicense,
        graceUntil: paidState('enterprise').graceUntil,
      },
      paidState('business'),
    ];
    const service = createService(
      db,
      vi.fn().mockImplementation(() => dataResponse(responses.shift()))
    );
    await service.checkNow();
    vi.setSystemTime(new Date('2026-09-10T12:30:00.000Z'));
    await service.checkNow();

    await expect(service.getStatus()).resolves.toMatchObject({ status: 'valid', plan: 'business', graceUntil: null });
  });
});
