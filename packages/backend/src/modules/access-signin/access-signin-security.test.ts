import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { accessSignInApiRoutes } from './access-signin.public-routes.js';
import { SignInTargetSchema } from './access-signin.schemas.js';
import { MemorySessionStore, MemorySigningKeyStore, testCrypto } from './access-signin.test-support.js';
import { type AccessListRow, domainServesHost } from './access-signin-directory.js';
import { AccessSignInExternalService, verifiedEmail } from './access-signin-external.service.js';
import { AccessSignInFlowService } from './access-signin-flow.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';

const LIST_ID = '11111111-1111-4111-8111-111111111111';
const NONCE = 'n'.repeat(43);
const list = {
  id: LIST_ID,
  signInMethods: ['opfield'],
  users: [],
  sessionTtlSeconds: 3600,
} as unknown as AccessListRow;

function wildcardFlow() {
  return new AccessSignInFlowService({
    directory: {
      getList: async () => list,
      // The list protects a route for *.example.com.
      hostOfList: async (_listId, host) => (domainServesHost('*.example.com', host) ? { secure: true } : null),
      getOpfieldUser: async () => ({ id: 'u1', email: 'lena@acme.dev', name: 'Lena', groups: [] }),
      providerNames: async () => new Map(),
    },
    sessions: new MemorySessionStore(),
    keys: new AccessSigningKeyService(new MemorySigningKeyStore(), testCrypto),
    settings: {
      getConfig: async () => ({
        domain: null,
        defaultSessionTtlSeconds: 86_400,
        nodeId: null,
        ingressGroupId: null,
        sslCertificateId: null,
      }),
      signInOrigin: async () => 'https://access.example.com',
    },
    decide: (_list, _request, identity) => (identity ? 'allow' : 'redirect'),
  });
}

describe('access sign-in host validation', () => {
  const meta = { clientIp: '203.0.113.9', userAgent: null };

  it('never issues a token for a host the URL parser would read as another host', async () => {
    const host = '1572395042/.example.com';
    expect(SignInTargetSchema.safeParse({ list: LIST_ID, host, n: NONCE }).success).toBe(false);
    expect(domainServesHost('*.example.com', host)).toBe(false);
    for (const bad of [host, 'app.example.com:8443', 'user@app.example.com', 'app.example.com#x', '-a.example.com']) {
      await expect(
        wildcardFlow().completeSignIn(
          { list, host: bad, secure: true, nonce: NONCE, returnPath: '/' },
          { m: 'opfield', sub: 'u1' },
          meta
        )
      ).rejects.toMatchObject({ code: 'ACCESS_HOST_NOT_PROTECTED' });
    }
    // A real subdomain of the wildcard route still gets its token.
    const signed = await wildcardFlow().completeSignIn(
      { list, host: 'app.example.com', secure: true, nonce: NONCE, returnPath: '/' },
      { m: 'opfield', sub: 'u1' },
      meta
    );
    expect(new URL(signed.redirect).hostname).toBe('app.example.com');
  });

  it('lowercases the host and degrades an over-long return path to "/"', () => {
    const parsed = SignInTargetSchema.parse({
      list: LIST_ID,
      host: 'App.Example.COM',
      n: NONCE,
      r: `/${'a'.repeat(5000)}`,
    });
    expect(parsed.host).toBe('app.example.com');
    expect(parsed.r).toBe('/');
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
      authorizeOpfield: async () => 'https://access.example.com/access/opfield/callback?code=c&state=s',
    } as unknown as AccessSignInExternalService);
    const hono = new Hono<AppEnv>();
    hono.onError(errorHandler);
    hono.use('*', async (c, next) => {
      c.set('user', { id: 'u1', isBlocked: false } as never);
      if (context.authType) c.set('authType', context.authType as never);
      if (context.impersonation) c.set('impersonation', context.impersonation as never);
      await next();
    });
    hono.route('/api/access-sign-in', accessSignInApiRoutes);
    return hono;
  }
  const authorize = (hono: Hono<AppEnv>) => hono.request('/api/access-sign-in/opfield/authorize?state=s');

  it('signs in only with the console session of the person at the browser', async () => {
    const session = await authorize(app({ authType: 'session' }));
    expect(session.status).toBe(302);
    expect(session.headers.get('location')).toMatch(/^https:\/\/access\.example\.com\/access\/opfield\/callback/);

    for (const authType of ['api-token', 'oauth-token']) {
      expect((await authorize(app({ authType }))).status).toBe(403);
    }
    const impersonating = await authorize(app({ authType: 'session', impersonation: { actor: { id: 'admin' } } }));
    expect(impersonating.status).toBe(302);
    expect(impersonating.headers.get('location')).toMatch(/^\/login\?return_to=/);
  });
});
