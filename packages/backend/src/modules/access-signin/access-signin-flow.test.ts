import 'reflect-metadata';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import type { AppEnv } from '@/types.js';
import type { AccessDecide } from './access-decision.js';
import { accessSignInApiRoutes } from './access-signin.public-routes.js';
import { MemorySessionStore, MemorySigningKeyStore, testCrypto } from './access-signin.test-support.js';
import type { AccessListRow, AccessSignInDirectory } from './access-signin-directory.js';
import { ACCESS_SESSION_COOKIE, AccessSignInFlowService } from './access-signin-flow.service.js';
import { AccessSignInSettingsService } from './access-signin-settings.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';

const LIST_ID = '11111111-1111-4111-8111-111111111111';
const NONCE = 'n'.repeat(43);
const target = (host: string) => ({ list: LIST_ID, host, n: NONCE, r: '/reports?x=1' });

let list: AccessListRow;

beforeAll(async () => {
  list = {
    id: LIST_ID,
    name: 'Support',
    description: null,
    signInMethods: ['password', 'opfield'],
    users: [{ username: 'lena.novak', passwordHash: await bcrypt.hash('correct horse', 4) }],
    sharedPasswordHash: null,
    skipIpRanges: [],
    includeRules: [{ selector: 'everyone', values: [] }],
    requireRules: [],
    excludeRules: [],
    sessionTtlSeconds: 3600,
    createdById: '22222222-2222-4222-8222-222222222222',
    createdAt: new Date(),
    updatedAt: new Date(),
    folderId: null,
    sortOrder: 0,
  };
});

function setup() {
  const directory: AccessSignInDirectory = {
    getList: async (id) => (id === LIST_ID ? list : null),
    // Only app.example.com is a route protected by the list.
    hostOfList: async (listId, host) => (listId === LIST_ID && host === 'app.example.com' ? { secure: true } : null),
    getOpfieldUser: async () => null,
    providerNames: async () => new Map(),
  };
  const sessions = new MemorySessionStore();
  const keys = new AccessSigningKeyService(new MemorySigningKeyStore(), testCrypto);
  const settings = {
    getConfig: async () => ({
      domain: 'access.example.com',
      defaultSessionTtlSeconds: 86_400,
      nodeId: null,
      ingressGroupId: null,
      sslCertificateId: null,
    }),
    signInOrigin: async () => 'https://access.example.com',
  };
  // The shared evaluator's answer for an identity the list's include rule (everyone) admits.
  const decide: AccessDecide = (_list, _request, identity) => (identity ? 'allow' : 'redirect');
  const flow = new AccessSignInFlowService({ directory, sessions, keys, settings, decide });
  return { flow, keys, sessions, settings };
}

describe('access sign-in host tokens', () => {
  it('sends a signed-in visitor back with a token valid only for that host', async () => {
    const { flow, keys } = setup();
    const signed = await flow.signInWithPassword(target('APP.example.com'), 'lena.novak', 'correct horse', {
      clientIp: '203.0.113.9',
      userAgent: 'test',
    });
    const redirect = new URL(signed.redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe('https://app.example.com/_opfield/access/callback');
    expect(redirect.searchParams.get('r')).toBe('/reports?x=1');
    const token = redirect.searchParams.get('t')!;
    const payload = await keys.verify(token, 'app.example.com');
    expect(payload).toMatchObject({
      aud: 'app.example.com',
      non: NONCE,
      idn: { m: 'password', sub: 'lena.novak', lst: LIST_ID },
    });
    expect(payload!.exp - payload!.iat).toBe(3600);
    expect(await keys.verify(token, 'evil.example.com')).toBeNull();
    // The central session cookie is for the sign-in host.
    expect(await keys.verify(signed.cookie, 'access.example.com')).not.toBeNull();
  });

  it('refuses hosts that no route or Pages project of the list serves', async () => {
    const { flow, sessions } = setup();
    await expect(
      flow.signInWithPassword(target('evil.example.com'), 'lena.novak', 'correct horse', {
        clientIp: '203.0.113.9',
        userAgent: null,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'ACCESS_HOST_NOT_PROTECTED' });
    await expect(
      flow.context(target('evil.example.com'), undefined, { clientIp: '', userAgent: null })
    ).rejects.toMatchObject({ code: 'ACCESS_HOST_NOT_PROTECTED' });
    expect(sessions.rows.size).toBe(0);
  });

  it('redirects a visitor whose central session already gets in, and shows methods otherwise', async () => {
    const { flow } = setup();
    const meta = { clientIp: '203.0.113.9', userAgent: null };
    expect(await flow.context(target('app.example.com'), undefined, meta)).toEqual({
      host: 'app.example.com',
      methods: [
        { key: 'password', label: 'Username', kind: 'password' },
        { key: 'opfield', label: 'Opfield account', kind: 'opfield' },
      ],
      state: 'methods',
    });
    const signed = await flow.signInWithPassword(target('app.example.com'), 'lena.novak', 'correct horse', meta);
    const again = await flow.context(target('app.example.com'), signed.cookie, meta);
    expect('redirect' in again && again.redirect).toMatch(
      /^https:\/\/app\.example\.com\/_opfield\/access\/callback\?t=v1\./
    );
    // The sign-in page's own redirect check: nothing to look up without a cookie.
    expect(await flow.sessionRedirect(target('app.example.com'), undefined, meta)).toBeNull();
    expect(await flow.sessionRedirect(target('app.example.com'), signed.cookie, meta)).toMatch(
      /^https:\/\/app\.example\.com\/_opfield\/access\/callback\?t=v1\./
    );
    // Signed out: the session is revoked and the cookie no longer gets in.
    expect(await flow.signOut(signed.cookie)).toBe(true);
    expect(await flow.sessionRedirect(target('app.example.com'), signed.cookie, meta)).toBeNull();
    expect(await flow.context(target('app.example.com'), signed.cookie, meta)).toMatchObject({ state: 'methods' });
  });
});

describe('password sign-in API', () => {
  afterEach(() => {
    container.clearInstances();
  });

  it('signs in with the right password, rejects a wrong one and rate-limits attempts', async () => {
    const { flow, keys, settings } = setup();
    container.registerInstance(AccessSignInFlowService, flow);
    container.registerInstance(AccessSigningKeyService, keys);
    container.registerInstance(AccessSignInSettingsService, settings as unknown as AccessSignInSettingsService);
    container.registerInstance(TOKENS.RedisClient, new MemoryRedis());
    const defaults = DEFAULT_ENVIRONMENT_SETTINGS;
    container.registerInstance(EnvironmentSettingsService, {
      getSnapshot: () => ({ ...defaults, rateLimits: { ...defaults.rateLimits, authLoginMaxRequests: 3 } }),
    } as unknown as EnvironmentSettingsService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/api/access-sign-in', accessSignInApiRoutes);
    const post = (password: string) =>
      app.request('/api/access-sign-in/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...target('app.example.com'), username: 'lena.novak', password }),
      });

    const ok = await post('correct horse');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { redirect: string }).redirect).toMatch(
      /^https:\/\/app\.example\.com\/_opfield\/access\/callback\?/
    );
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${ACCESS_SESSION_COOKIE}=v1.`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);

    const wrong = await post('wrong');
    expect(wrong.status).toBe(401);
    expect((await post('wrong')).status).toBe(401);
    // Third attempt in the window was the last one allowed.
    expect((await post('correct horse')).status).toBe(429);
  });
});

class MemoryRedis {
  private readonly sets = new Map<string, number[]>();

  pipeline() {
    const ops: Array<() => number> = [];
    const pipeline = {
      zremrangebyscore: (key: string, _min: number, max: number) => {
        ops.push(() => {
          const kept = (this.sets.get(key) ?? []).filter((score) => score > max);
          this.sets.set(key, kept);
          return 0;
        });
        return pipeline;
      },
      zcard: (key: string) => {
        ops.push(() => this.sets.get(key)?.length ?? 0);
        return pipeline;
      },
      zadd: (key: string, score: number) => {
        ops.push(() => {
          this.sets.set(key, [...(this.sets.get(key) ?? []), score]);
          return 1;
        });
        return pipeline;
      },
      expire: () => {
        ops.push(() => 1);
        return pipeline;
      },
      exec: async () => ops.map((op) => [null, op()] as [null, number]),
    };
    return pipeline;
  }
}
