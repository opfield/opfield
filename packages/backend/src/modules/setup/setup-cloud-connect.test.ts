import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudLinkRequestError } from '@/modules/cloud-link/cloud-link.service.js';
import {
  SETUP_OPFIELD_ACCOUNT_ADMIN_KEY,
  SetupCloudConnect,
  type SetupCloudConnectDeps,
  setupReturnOrigin,
} from './setup-cloud-connect.js';
import { signInOptionError } from './setup-wizard.service.js';

/** Settings rows by key; every read returns the kept Opfield account administrator. */
function fakeDb() {
  const rows = new Map<string, unknown>();
  const db = {
    rows,
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => {
          rows.set(row.key, row.value);
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        rows.delete(SETUP_OPFIELD_ACCOUNT_ADMIN_KEY);
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            rows.has(SETUP_OPFIELD_ACCOUNT_ADMIN_KEY) ? [{ value: rows.get(SETUP_OPFIELD_ACCOUNT_ADMIN_KEY) }] : [],
        }),
      }),
    }),
  };
  return db;
}

function fakeCache() {
  const entries = new Map<string, unknown>();
  return {
    entries,
    set: vi.fn(async (key: string, value: unknown) => {
      entries.set(key, value);
    }),
    take: vi.fn(async (key: string) => {
      const value = entries.get(key) ?? null;
      entries.delete(key);
      return value as never;
    }),
  };
}

function setup(overrides: Partial<SetupCloudConnectDeps['cloud']> = {}, fetcher?: typeof fetch) {
  const db = fakeDb();
  const cache = fakeCache();
  let connected = false;
  let pending: { redirectUri: string; requestedAt: string } | null = null;
  const cloud = {
    configuredPortalUrl: 'https://account.example.test',
    connectWithIssuer: vi.fn(async () => {
      connected = true;
      return {
        status: { state: 'connected', accountEmail: 'team@example.com' } as never,
        issuer: { email: 'ada@example.com', name: 'Ada Admin' },
      };
    }),
    requestSsoClient: vi.fn(async (redirectUri: string) => {
      pending = { redirectUri, requestedAt: '2026-10-31T10:00:00.000Z' };
      return pending;
    }),
    pendingSsoClientRequest: vi.fn(async () => pending),
    getStatus: vi.fn(async () =>
      connected
        ? ({ state: 'connected', accountEmail: 'team@example.com' } as never)
        : ({ state: 'not_connected' } as never)
    ),
    helloChanged: vi.fn(),
    cancelSsoClientRequest: vi.fn(async () => {
      pending = null;
      return true;
    }),
    disconnect: vi.fn(async () => {
      connected = false;
      return { state: 'not_connected' } as never;
    }),
    ...overrides,
  };
  const service = new SetupCloudConnect({
    db: db as never,
    cache,
    cloud,
    oidcSettings: { getPublicConfig: async () => ({ configured: false, opfieldAccount: false }) as never },
    authSettings: { getConfig: async () => ({ methods: { oidc: false } }) as never },
    installationName: () => 'Acme Opfield',
    fetcher: fetcher ?? (vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch),
  });
  return { service, cloud, cache, db };
}

describe('Opfield account in the setup wizard', () => {
  it('sends the browser to the portal with a state and an S256 challenge of a verifier kept for this session', async () => {
    const { service, cache } = setup();
    const { url } = await service.start('setup-session-1', 'https://gw.example.com/');
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe('https://account.example.test/connect-installation');
    expect(target.searchParams.get('return_uri')).toBe('https://gw.example.com/setup/cloud-callback');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('name')).toBe('Acme Opfield');
    const state = target.searchParams.get('state')!;
    expect(state).toMatch(/^[\w-]{43}$/);

    const key = `setup:cloud_connect:${createHash('sha256').update(state).digest('hex')}`;
    const stored = cache.entries.get(key) as { setupSession: string; codeVerifier: string; publicUrl: string };
    expect(stored.publicUrl).toBe('https://gw.example.com');
    expect(stored.setupSession).toBe(createHash('sha256').update('setup-session-1').digest('hex'));
    expect(target.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(stored.codeVerifier).digest('base64url')
    );
    // Neither the state nor the session id is stored as such, and the entry lives 10 minutes.
    expect(JSON.stringify([...cache.entries])).not.toContain(state);
    expect(cache.set).toHaveBeenCalledWith(key, stored, 600);
  });

  it('says plainly when this server cannot reach the portal', async () => {
    const { service } = setup(
      {},
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch
    );
    await expect(service.start('setup-session-1', 'https://gw.example.com')).rejects.toMatchObject({
      statusCode: 502,
      code: 'CLOUD_PORTAL_UNAVAILABLE',
      message: expect.stringContaining('cannot reach the Opfield account at https://account.example.test'),
    });
  });

  it('enrols with the code and the verifier of its start, once, keeps the administrator and asks for the client', async () => {
    const { service, cloud, db } = setup();
    const state = new URL((await service.start('setup-session-1', 'https://gw.example.com')).url).searchParams.get(
      'state'
    )!;

    await expect(service.finish('another-session', { code: 'CLD-7K3M-Q9TX', state })).rejects.toMatchObject({
      code: 'SETUP_CLOUD_STATE_INVALID',
    });
    expect(cloud.connectWithIssuer).not.toHaveBeenCalled();

    const state2 = new URL((await service.start('setup-session-1', 'https://gw.example.com')).url).searchParams.get(
      'state'
    )!;
    const view = await service.finish('setup-session-1', { code: 'CLD-7K3M-Q9TX', state: state2 });
    expect(cloud.connectWithIssuer).toHaveBeenCalledWith(
      'CLD-7K3M-Q9TX',
      { userId: null },
      { source: 'setup', codeVerifier: expect.stringMatching(/^[\w-]{64}$/) }
    );
    expect(db.rows.get(SETUP_OPFIELD_ACCOUNT_ADMIN_KEY)).toEqual({ email: 'ada@example.com', name: 'Ada Admin' });
    expect(cloud.requestSsoClient).toHaveBeenCalledWith('https://gw.example.com/auth/callback', { userId: null });
    expect(cloud.helloChanged).toHaveBeenCalled();
    expect(view).toEqual({
      connected: true,
      accountEmail: 'team@example.com',
      administrator: { email: 'ada@example.com', name: 'Ada Admin' },
      signInClient: 'requested',
      requestedAt: '2026-10-31T10:00:00.000Z',
    });
    // The state works once.
    await expect(service.finish('setup-session-1', { code: 'CLD-7K3M-Q9TX', state: state2 })).rejects.toMatchObject({
      code: 'SETUP_CLOUD_STATE_INVALID',
    });
  });

  it('takes a code entered by hand without a verifier', async () => {
    const { service, cloud } = setup();
    await service.finish('setup-session-1', { code: 'CLD-7K3M-Q9TX', publicUrl: 'https://gw.example.com' });
    expect(cloud.connectWithIssuer).toHaveBeenCalledWith('CLD-7K3M-Q9TX', { userId: null }, { source: 'setup' });
    expect(cloud.requestSsoClient).toHaveBeenCalledWith('https://gw.example.com/auth/callback', { userId: null });
  });

  it('turns an unreachable portal on enrol into the plain message', async () => {
    const { service } = setup({
      connectWithIssuer: vi.fn(async () => {
        throw new CloudLinkRequestError(
          502,
          'CLOUD_PORTAL_UNAVAILABLE',
          'Your cloud account could not be reached',
          true
        );
      }),
    });
    await expect(
      service.finish('setup-session-1', { code: 'CLD-7K3M-Q9TX', publicUrl: 'https://gw.example.com' })
    ).rejects.toMatchObject({
      code: 'CLOUD_PORTAL_UNAVAILABLE',
      message: expect.stringContaining('choose another sign-in option'),
    });
  });

  it('refuses an enrolment that names nobody to make administrator', async () => {
    const { service, cloud } = setup({
      connectWithIssuer: vi.fn(async () => ({ status: { state: 'connected' } as never, issuer: null })),
    });
    await expect(
      service.finish('setup-session-1', { code: 'CLD-7K3M-Q9TX', publicUrl: 'https://gw.example.com' })
    ).rejects.toMatchObject({ code: 'CLOUD_PORTAL_ERROR' });
    expect(cloud.requestSsoClient).not.toHaveBeenCalled();
  });
});

describe('setup sign-in options', () => {
  it('turns on exactly the methods of one option', () => {
    const none = { oidc: false, password: false, emailOtp: false };
    expect(signInOptionError({ option: 'opfield_account', methods: { ...none, oidc: true } })).toBeNull();
    expect(signInOptionError({ option: 'oidc', methods: { ...none, oidc: true } })).toBeNull();
    expect(signInOptionError({ option: 'password_totp', methods: { ...none, password: true } })).toBeNull();
    expect(
      signInOptionError({ option: 'password_totp', methods: { ...none, password: true, emailOtp: true } })
    ).toBeNull();

    // No plain email code, no OIDC next to a password, no password next to the Opfield account.
    expect(signInOptionError({ option: 'password_totp', methods: { ...none, emailOtp: true } })).toMatch(
      /only next to a password/
    );
    expect(
      signInOptionError({ option: 'password_totp', methods: { oidc: true, password: true, emailOtp: false } })
    ).not.toBeNull();
    expect(
      signInOptionError({ option: 'opfield_account', methods: { oidc: true, password: true, emailOtp: false } })
    ).not.toBeNull();
    expect(signInOptionError({ option: 'oidc', methods: none })).not.toBeNull();
    expect(signInOptionError({ option: 'other' as never, methods: { ...none, oidc: true } })).not.toBeNull();
  });
});

describe('Opfield account connect from another address', () => {
  it('sends the browser back to the address it is on, and registers sign-in for the public URL', async () => {
    const { service, cloud } = setup();
    const { url } = await service.start('setup-session-1', 'https://gw.example.com', 'http://192.168.1.20:3000');
    expect(new URL(url).searchParams.get('return_uri')).toBe('http://192.168.1.20:3000/setup/cloud-callback');
    const state = new URL(url).searchParams.get('state')!;
    await service.finish('setup-session-1', { code: 'CLD-7K3M-Q9TX', state });
    expect(cloud.requestSsoClient).toHaveBeenCalledWith('https://gw.example.com/auth/callback', { userId: null });
  });

  it('takes only a plain http(s) origin as the return address', () => {
    expect(setupReturnOrigin('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000');
    expect(setupReturnOrigin('https://gw.example.com/')).toBe('https://gw.example.com');
    for (const bad of [
      'javascript:alert(1)',
      'https://gw.example.com/evil',
      'https://gw.example.com?x=1',
      'https://gw.example.com#x',
      'https://user:pass@gw.example.com',
      'https://gw.example.com/..//evil.example',
      '//evil.example',
      'ftp://gw.example.com',
    ]) {
      expect(() => setupReturnOrigin(bad), bad).toThrow(/http or https origin/);
    }
  });

  it('disconnects the cloud link and drops the administrator and the client request on another option', async () => {
    const { service, cloud, db } = setup();
    await service.finish('setup-session-1', { code: 'CLD-7K3M-Q9TX', publicUrl: 'https://gw.example.com' });
    expect(db.rows.has(SETUP_OPFIELD_ACCOUNT_ADMIN_KEY)).toBe(true);
    const view = await service.disconnect();
    expect(cloud.cancelSsoClientRequest).toHaveBeenCalledWith({ userId: null });
    expect(cloud.disconnect).toHaveBeenCalledWith({ userId: null });
    expect(db.rows.has(SETUP_OPFIELD_ACCOUNT_ADMIN_KEY)).toBe(false);
    expect(view).toMatchObject({ connected: false, administrator: null, signInClient: 'none' });
  });
});
