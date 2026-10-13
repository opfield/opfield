import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { authMiddleware, optionalAuthMiddleware } from '@/modules/auth/auth.middleware.js';
import { getSessionCookieName } from '@/modules/auth/session-cookie.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['nodes:details'],
  isBlocked: false,
};

const SESSION: SessionData = {
  userId: USER.id,
  user: USER,
  accessToken: 'oidc-access-token',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  csrfToken: 'csrf-token',
};

function createDb({
  isBlocked = false,
  require2fa = false,
  authMethod = USER.authMethod,
}: {
  isBlocked?: boolean;
  require2fa?: boolean;
  authMethod?: User['authMethod'];
} = {}): DrizzleClient {
  return {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          authMethod,
          isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: USER.groupId,
            parentId: null,
            name: USER.groupName,
            scopes: USER.scopes,
            require2fa,
          },
        ]),
      },
    },
  } as unknown as DrizzleClient;
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ message: error.message }, error.status);
    }
    throw error;
  });
  app.use('*', authMiddleware);
  app.get('/auth/csrf', (c) => c.json({ userId: c.get('user')?.id, isBlocked: c.get('user')?.isBlocked }));
  app.get('/auth/me', (c) => c.json({ userId: c.get('user')?.id, isBlocked: c.get('user')?.isBlocked }));
  app.post('/auth/logout', (c) => c.json({ userId: c.get('user')?.id, isBlocked: c.get('user')?.isBlocked }));
  app.get('/read', (c) => c.json({ userId: c.get('user')?.id }));
  app.get('/api/inference/core/status', (c) => c.json({ userId: c.get('user')?.id }));
  app.post('/mutate', (c) => c.json({ userId: c.get('user')?.id }));
  return app;
}

function createOptionalApp() {
  const app = new Hono<AppEnv>();
  app.use('*', optionalAuthMiddleware);
  app.get('/optional', (c) => c.json({ authenticated: Boolean(c.get('user')) }));
  return app;
}

function registerSession({
  csrfValid = true,
  isBlocked = false,
  require2fa = false,
  authMethod = USER.authMethod,
  session = SESSION,
}: {
  csrfValid?: boolean;
  isBlocked?: boolean;
  require2fa?: boolean;
  authMethod?: User['authMethod'];
  session?: SessionData;
} = {}) {
  const sessionService = {
    getSession: vi.fn().mockResolvedValue(session),
    validateCsrfToken: vi.fn().mockResolvedValue(csrfValid),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
    destroySession: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(SessionService, sessionService as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, createDb({ isBlocked, require2fa, authMethod }));
  return sessionService;
}

afterEach(() => {
  container.reset();
});

describe('authMiddleware browser session credentials', () => {
  it('allows the browser setup session to manage the inference core', async () => {
    const setupSession = {
      ...SESSION,
      purpose: 'setup' as const,
      setupSessionId: 'setup-session-1',
    };
    registerSession({ session: setupSession });
    container.registerInstance(SetupAccessService, {
      validateSession: vi.fn().mockResolvedValue(true),
    } as unknown as SetupAccessService);

    const response = await createApp().request('/api/inference/core/status', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
  });

  it('accepts a cookie session with a valid CSRF token for mutations', async () => {
    registerSession({ csrfValid: true });

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=session-1',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
  });

  it('accepts the transport-specific session cookie', async () => {
    registerSession();

    const response = await createApp().request('/read', {
      headers: { Cookie: `${getSessionCookieName('http')}=session-1` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
  });

  it('refreshes session metadata from the same resolved request context used by audit logs', async () => {
    const sessionService = registerSession();

    const response = await runWithAuditRequestContext({ ipAddress: '203.0.113.25', userAgent: 'Current Browser' }, () =>
      createApp().request('/read', { headers: { Cookie: 'session_id=session-1' } })
    );

    expect(response.status).toBe(200);
    expect(sessionService.updateSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        user: expect.objectContaining({ id: USER.id }),
        ipAddress: '203.0.113.25',
        userAgent: 'Current Browser',
      })
    );
  });

  it('authorizes an impersonation session only with the subject identity and scopes', async () => {
    const actor = { ...USER, id: 'actor-1', groupId: 'actor-group' };
    const subject = {
      ...USER,
      id: 'subject-1',
      email: 'subject@example.com',
      groupId: 'subject-group',
      groupName: 'viewer',
    };
    const impersonationSession = {
      ...SESSION,
      userId: subject.id,
      user: subject,
      purpose: 'impersonation' as const,
      impersonation: { actorUserId: actor.id, originalSessionId: 'original-session' },
    };
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(impersonationSession),
      getOriginalSessionForImpersonation: vi.fn().mockResolvedValue({
        sessionId: 'original-session',
        session: { ...SESSION, userId: actor.id, user: actor, purpose: 'user' },
      }),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
    } as unknown as SessionService);
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValueOnce(subject).mockResolvedValueOnce(actor),
        },
        permissionGroups: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: actor.groupId,
              parentId: null,
              name: 'system-admin',
              scopes: ['admin:users:impersonate', 'nodes:details'],
            },
            { id: subject.groupId, parentId: null, name: 'viewer', scopes: ['nodes:details'] },
          ]),
        },
      },
    } as unknown as DrizzleClient);

    const response = await createApp().request('/read', {
      headers: { Cookie: 'session_id=impersonation-session' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: subject.id });
  });

  it('blocks normal requests when the actor loses the impersonation scope', async () => {
    const actor = { ...USER, id: 'actor-1', groupId: 'actor-group' };
    const subject = { ...USER, id: 'subject-1', groupId: 'subject-group' };
    const impersonationSession = {
      ...SESSION,
      userId: subject.id,
      user: subject,
      purpose: 'impersonation' as const,
      impersonation: { actorUserId: actor.id, originalSessionId: 'original-session' },
    };
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(impersonationSession),
      getOriginalSessionForImpersonation: vi.fn().mockResolvedValue({
        sessionId: 'original-session',
        session: { ...SESSION, userId: actor.id, user: actor, purpose: 'user' },
      }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
    } as unknown as SessionService);
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValueOnce(subject).mockResolvedValueOnce(actor),
        },
        permissionGroups: {
          findMany: vi.fn().mockResolvedValue([
            { id: actor.groupId, parentId: null, name: 'admin', scopes: [] },
            { id: subject.groupId, parentId: null, name: 'viewer', scopes: [] },
          ]),
        },
      },
    } as unknown as DrizzleClient);

    const response = await createApp().request('/read', {
      headers: { Cookie: 'session_id=impersonation-session' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: 'Impersonation authorization changed' });
  });

  it('prefers the current transport cookie over a stale cookie from another transport', async () => {
    const sessionService = registerSession();

    const response = await createApp().request('/read', {
      headers: {
        Cookie: `${getSessionCookieName('https')}=stale-session; ${getSessionCookieName('http')}=current-session`,
      },
    });

    expect(response.status).toBe(200);
    expect(sessionService.getSession).toHaveBeenCalledWith('current-session');
  });

  it('rejects a cookie session mutation without a valid CSRF token', async () => {
    registerSession({ csrfValid: false });

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: 'Invalid CSRF token' });
  });

  it('uses userId from a legacy session that does not contain a cached user object', async () => {
    const legacySession = { ...SESSION, user: undefined } as unknown as SessionData;
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(legacySession),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      destroySession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionService);
    container.registerInstance(TOKENS.DrizzleClient, createDb());

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=legacy-session',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
  });

  it('rejects long-lived session ids sent as bearer or query credentials', async () => {
    registerSession();

    const bearerResponse = await createApp().request('/read', {
      headers: { Authorization: 'Bearer session-1' },
    });
    const queryResponse = await createApp().request('/read?token=session-1');

    expect(bearerResponse.status).toBe(401);
    expect(queryResponse.status).toBe(401);
  });

  it.each([
    ['opf_test_token'],
    ['gw_test_token'],
  ])('keeps API-token mutations independent of CSRF (%s)', async (token) => {
    const validateToken = vi.fn().mockResolvedValue({ user: USER, scopes: USER.scopes });
    container.registerInstance(TokensService, { validateToken } as unknown as TokensService);

    const response = await createApp().request('/mutate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: USER.id });
    expect(validateToken).toHaveBeenCalledWith(token);
  });

  it('allows an unsatisfied local session until its MFA grace deadline', async () => {
    registerSession({
      authMethod: 'password',
      require2fa: true,
      session: { ...SESSION, mfaGraceExpiresAt: Date.now() + 60_000 },
    });

    const response = await createApp().request('/read', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
  });

  it('drops an unsatisfied local session after its MFA grace deadline', async () => {
    const sessionService = registerSession({
      authMethod: 'password',
      require2fa: true,
      session: { ...SESSION, mfaGraceExpiresAt: Date.now() - 1 },
    });

    const response = await createApp().request('/read', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'MFA sign-in required' });
    expect(sessionService.destroySession).toHaveBeenCalledWith('session-1');
  });

  it('keeps an MFA-satisfied local session after its grace deadline', async () => {
    registerSession({
      authMethod: 'password',
      require2fa: true,
      session: {
        ...SESSION,
        mfaSatisfiedAt: Date.now() - 60_000,
        mfaGraceExpiresAt: Date.now() - 1,
      },
    });

    const response = await createApp().request('/read', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
  });

  it('ignores a stale MFA grace deadline when group MFA is disabled', async () => {
    registerSession({
      authMethod: 'password',
      session: { ...SESSION, mfaGraceExpiresAt: Date.now() - 1 },
    });

    const response = await createApp().request('/read', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
  });

  it('keeps OIDC browser sessions outside Gateway MFA grace enforcement', async () => {
    registerSession({
      authMethod: 'oidc',
      require2fa: true,
      session: { ...SESSION, mfaGraceExpiresAt: Date.now() - 1 },
    });

    const response = await createApp().request('/read', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
  });

  it('treats an expired MFA grace session as anonymous under optional authentication', async () => {
    const sessionService = registerSession({
      authMethod: 'password',
      require2fa: true,
      session: { ...SESSION, mfaGraceExpiresAt: Date.now() - 1 },
    });

    const response = await createOptionalApp().request('/optional', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(sessionService.destroySession).toHaveBeenCalledWith('session-1');
  });

  it('rejects blocked session users on protected routes but leaves auth status and logout routes reachable', async () => {
    registerSession({ isBlocked: true });

    const protectedResponse = await createApp().request('/read', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const csrfResponse = await createApp().request('/auth/csrf', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const meResponse = await createApp().request('/auth/me', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const logoutResponse = await createApp().request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'X-CSRF-Token': 'csrf-token' },
    });

    expect(protectedResponse.status).toBe(403);
    expect(await protectedResponse.json()).toEqual({ message: 'Account is blocked' });
    expect(csrfResponse.status).toBe(200);
    expect(await csrfResponse.json()).toEqual({ userId: USER.id, isBlocked: true });
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toEqual({ userId: USER.id, isBlocked: true });
    expect(logoutResponse.status).toBe(200);
    expect(await logoutResponse.json()).toEqual({ userId: USER.id, isBlocked: true });
  });
});
