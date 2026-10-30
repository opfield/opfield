import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { accessSignInApiRoutes } from './access-signin.public-routes.js';
import { MemorySessionStore, MemorySigningKeyStore, testCrypto } from './access-signin.test-support.js';
import { type AccessListRow, domainServesHost } from './access-signin-directory.js';
import { AccessSignInExternalService, routeCallbackUrl, verifiedEmail } from './access-signin-external.service.js';
import { AccessSignInFlowService } from './access-signin-flow.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';

// The console session and CSRF checks are the auth middleware's own (auth.middleware tests); here the test sets the user.
vi.mock('@/modules/auth/auth.middleware.js', async (original) => ({
  ...(await original<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const LIST_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '33333333-3333-4333-8333-333333333333';
const list = {
  id: LIST_ID,
  signInMethods: ['opfield'],
  users: [],
  sessionTtlSeconds: 3600,
} as unknown as AccessListRow;
const target = (host: string) => ({ listId: LIST_ID, host, nodeId: NODE_ID, clientIp: '203.0.113.9', userAgent: null });

function wildcardFlow() {
  return new AccessSignInFlowService({
    directory: {
      getList: async () => list,
      // The list protects a route for *.example.com on this node.
      hostOfList: async (_listId, host, nodeId) =>
        nodeId === NODE_ID && domainServesHost('*.example.com', host) ? { secure: true } : null,
      getOpfieldUser: async () => ({ id: 'u1', email: 'lena@acme.dev', name: 'Lena', groups: [] }),
      providerNames: async () => new Map(),
    },
    sessions: new MemorySessionStore(),
    keys: new AccessSigningKeyService(new MemorySigningKeyStore(), testCrypto),
    settings: { getConfig: async () => ({ defaultSessionTtlSeconds: 86_400 }) },
    decide: (_list, _request, identity) => (identity ? 'allow' : 'redirect'),
  });
}

/** A cache with the semantics of CacheService set/get/take. */
function memoryCache() {
  const values = new Map<string, unknown>();
  return {
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    get: async <T>(key: string) => (values.get(key) as T) ?? null,
    take: async <T>(key: string) => {
      const value = (values.get(key) as T) ?? null;
      values.delete(key);
      return value;
    },
    setIfAbsent: async (key: string, value: unknown) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
  };
}

describe('access sign-in host validation', () => {
  it('never resolves a host the URL parser would read as another host', async () => {
    const host = '1572395042/.example.com';
    expect(domainServesHost('*.example.com', host)).toBe(false);
    for (const bad of [host, 'app.example.com:8443', 'user@app.example.com', 'app.example.com#x', '-a.example.com']) {
      await expect(wildcardFlow().resolveTarget(target(bad))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    }
    // A real subdomain of the wildcard route resolves, lowercased.
    expect((await wildcardFlow().resolveTarget(target('App.Example.com'))).host).toBe('app.example.com');
  });

  it('accepts only the route provider callback as the return address', () => {
    const resolved = { list, host: 'app.example.com', secure: true };
    expect(routeCallbackUrl(resolved, 'https://app.example.com/_opfield/access/provider-callback')).toBe(
      'https://app.example.com/_opfield/access/provider-callback'
    );
    for (const bad of [
      'http://app.example.com/_opfield/access/provider-callback',
      'https://evil.example.com/_opfield/access/provider-callback',
      'https://app.example.com:8443/_opfield/access/provider-callback',
      'https://user@app.example.com/_opfield/access/provider-callback',
      'https://app.example.com/_opfield/access/provider-callback?next=x',
      'https://app.example.com/other',
      'not a url',
    ]) {
      expect(() => routeCallbackUrl(resolved, bad)).toThrow(
        expect.objectContaining({ code: 'ACCESS_CALLBACK_INVALID' })
      );
    }
    // A route without TLS returns over plain HTTP.
    expect(
      routeCallbackUrl({ ...resolved, secure: false }, 'http://app.example.com/_opfield/access/provider-callback')
    ).toBe('http://app.example.com/_opfield/access/provider-callback');
  });
});

describe('Opfield account sign-in on a route', () => {
  const callback = 'https://app.example.com/_opfield/access/provider-callback';

  function external() {
    const flow = wildcardFlow();
    return new AccessSignInExternalService(
      flow,
      { find: async () => null, clientConfiguration: async () => ({}) as never },
      { getOpfieldUser: async (id) => (id === 'u1' ? { id, email: 'lena@acme.dev', name: 'Lena', groups: [] } : null) },
      memoryCache() as never,
      async () => 'https://opfield.example.com'
    );
  }

  it('confirms on the console and returns to the route callback with a one-time code', async () => {
    const service = external();
    const started = await service.start(target('app.example.com'), 'opfield', callback);
    const authorize = new URL(started.url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://opfield.example.com/api/access-sign-in/opfield/authorize'
    );
    expect(authorize.searchParams.get('state')).toBe(started.state);

    expect(await service.opfieldConsent(started.state)).toEqual({ host: 'app.example.com' });
    const back = new URL(await service.authorizeOpfield(started.state, 'u1'));
    expect(`${back.origin}${back.pathname}`).toBe(callback);
    const code = back.searchParams.get('code')!;
    // Decided once: the same link cannot be confirmed, cancelled or shown again.
    await expect(service.authorizeOpfield(started.state, 'u1')).rejects.toMatchObject({
      code: 'ACCESS_SIGN_IN_EXPIRED',
    });
    await expect(service.denyOpfield(started.state)).rejects.toMatchObject({ code: 'ACCESS_SIGN_IN_EXPIRED' });
    await expect(service.opfieldConsent(started.state)).rejects.toMatchObject({ code: 'ACCESS_SIGN_IN_EXPIRED' });

    // Another route of the list cannot finish it.
    await expect(
      service.finish(target('other.example.com'), { state: started.state, code, error: '', callbackUrl: callback })
    ).rejects.toMatchObject({ code: 'ACCESS_SIGN_IN_EXPIRED' });

    const again = await service.start(target('app.example.com'), 'opfield', callback);
    const code2 = new URL(await service.authorizeOpfield(again.state, 'u1')).searchParams.get('code')!;
    const signed = await service.finish(target('app.example.com'), {
      state: again.state,
      code: code2,
      error: '',
      callbackUrl: callback,
    });
    expect(signed.token).toMatch(/^v1\./);
    // State and code are one-time.
    await expect(
      service.finish(target('app.example.com'), { state: again.state, code: code2, error: '', callbackUrl: callback })
    ).rejects.toMatchObject({ code: 'ACCESS_SIGN_IN_EXPIRED' });
  });

  it('cancels back to the route, which says the sign-in failed', async () => {
    const service = external();
    const started = await service.start(target('app.example.com'), 'opfield', callback);
    const back = new URL(await service.denyOpfield(started.state));
    expect(`${back.origin}${back.pathname}`).toBe(callback);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
    await expect(
      service.finish(target('app.example.com'), {
        state: started.state,
        code: '',
        error: 'access_denied',
        callbackUrl: callback,
      })
    ).rejects.toMatchObject({ code: 'ACCESS_SIGN_IN_FAILED' });
  });

  it('refuses a method the list does not offer and a foreign return address', async () => {
    const service = external();
    await expect(service.start(target('app.example.com'), 'idp:x', callback)).rejects.toMatchObject({
      code: 'ACCESS_METHOD_NOT_OFFERED',
    });
    await expect(
      service.start(target('app.example.com'), 'opfield', 'https://evil.example.com/_opfield/access/provider-callback')
    ).rejects.toMatchObject({ code: 'ACCESS_CALLBACK_INVALID' });
  });
});

describe('identity provider emails', () => {
  it('uses an email only when the provider marks it verified', () => {
    expect(verifiedEmail({ email: 'Lena@ACME.dev', email_verified: true })).toBe('lena@acme.dev');
    expect(verifiedEmail({ email: 'lena@acme.dev', email_verified: false })).toBeUndefined();
    expect(verifiedEmail({ email: 'lena@acme.dev' })).toBeUndefined();
    expect(verifiedEmail({ email: 'lena@acme.dev', email_verified: 'true' })).toBeUndefined();
  });
});

describe('Opfield account authorize', () => {
  afterEach(() => container.clearInstances());

  function app(context: Partial<{ authType: string; impersonation: unknown }>) {
    container.registerInstance(AccessSignInExternalService, {
      opfieldConsent: async () => ({ host: 'app.example.com' }),
      authorizeOpfield: async () => 'https://app.example.com/_opfield/access/provider-callback?code=c&state=s',
      denyOpfield: async () => 'https://app.example.com/_opfield/access/provider-callback?error=access_denied&state=s',
    } as unknown as AccessSignInExternalService);
    const hono = new Hono<AppEnv>();
    hono.onError(errorHandler);
    hono.use('*', async (c, next) => {
      c.set('user', { id: 'u1', email: 'lena@acme.dev', name: 'Lena', isBlocked: false } as never);
      if (context.authType) c.set('authType', context.authType as never);
      if (context.impersonation) c.set('impersonation', context.impersonation as never);
      await next();
    });
    hono.route('/api/access-sign-in', accessSignInApiRoutes);
    return hono;
  }
  const authorize = (hono: Hono<AppEnv>) => hono.request('/api/access-sign-in/opfield/authorize?state=s');
  const decide = (hono: Hono<AppEnv>, decision: 'approve' | 'deny') =>
    hono.request(`/api/access-sign-in/opfield/consent/${decision}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 's' }),
    });

  it('never signs in on a GET: the console user confirms the route host first', async () => {
    const session = await authorize(app({ authType: 'session' }));
    expect(session.status).toBe(302);
    expect(session.headers.get('location')).toBe('/access-sign-in/confirm?state=s');

    const consent = await app({ authType: 'session' }).request('/api/access-sign-in/opfield/consent?state=s');
    expect(await consent.json()).toEqual({
      host: 'app.example.com',
      account: { email: 'lena@acme.dev', name: 'Lena' },
    });

    const approved = await decide(app({ authType: 'session' }), 'approve');
    expect(await approved.json()).toEqual({
      redirectUrl: 'https://app.example.com/_opfield/access/provider-callback?code=c&state=s',
    });
    const denied = await decide(app({ authType: 'session' }), 'deny');
    expect(((await denied.json()) as { redirectUrl: string }).redirectUrl).toMatch(/error=access_denied/);
  });

  it('signs in only with the console session of the person at the browser', async () => {
    for (const authType of ['api-token', 'oauth-token']) {
      expect((await authorize(app({ authType }))).status).toBe(403);
      expect((await decide(app({ authType }), 'approve')).status).toBe(403);
    }
    const impersonation = { authType: 'session', impersonation: { actor: { id: 'admin' } } };
    const impersonating = await authorize(app(impersonation));
    expect(impersonating.status).toBe(302);
    expect(impersonating.headers.get('location')).toMatch(/^\/login\?return_to=/);
    expect((await decide(app(impersonation), 'approve')).status).toBe(403);
  });
});
