import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';
import { auditContextMiddleware } from '@/middleware/audit-context.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { DemoAuthService } from '@/modules/demo/demo-auth.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { authRoutes, hashOidcState, OIDC_STATE_COOKIE_NAME } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import { LocalAuthService } from './local-auth.service.js';
import { MfaService } from './mfa.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';
import { PasskeyService } from './passkey.service.js';
import { getSessionCookieName } from './session-cookie.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

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
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  csrfToken: 'csrf-token',
};

function registerDependencies() {
  const revokeUserSessionByPublicId = vi.fn().mockResolvedValue(true);
  const auditLog = vi.fn().mockResolvedValue(true);

  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(SESSION),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
    revokeUserSessionByPublicId,
  } as unknown as SessionService);
  container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: { findFirst: vi.fn().mockResolvedValue(USER) },
      permissionGroups: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes: USER.scopes }]),
      },
    },
  } as unknown as DrizzleClient);

  return { revokeUserSessionByPublicId, auditLog };
}

afterEach(() => {
  container.reset();
});

describe('standard-installation demo auth isolation', () => {
  it('returns 404 before parsing or invoking demo auth outside demo mode', async () => {
    const requestCode = vi.fn();
    container.registerInstance(DemoAuthService, { requestCode } as unknown as DemoAuthService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/demo/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });

    expect(response.status).toBe(404);
    expect(requestCode).not.toHaveBeenCalled();
  });
});

describe('browser-session routes', () => {
  it('allows the current user to upload a custom avatar as multipart data', async () => {
    const { auditLog } = registerDependencies();
    const avatar = new File(
      [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44])],
      'avatar.png',
      { type: 'image/png' }
    );
    const updatedUser = { ...USER, avatarUrl: '/auth/avatars/avatar.png' };
    const uploadUserAvatar = vi.fn().mockResolvedValue(updatedUser);
    container.registerInstance(AuthService, { uploadUserAvatar } as unknown as AuthService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);
    const body = new FormData();
    body.append('avatar', avatar);

    const response = await app.request('/auth/me/avatar', {
      method: 'PUT',
      headers: {
        Cookie: 'session_id=current-session-id',
        'X-CSRF-Token': 'csrf-token',
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(uploadUserAvatar).toHaveBeenCalledWith(USER.id, expect.any(File));
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.avatar_update', resourceId: USER.id })
    );
  });

  it('requires an avatar file in the multipart request', async () => {
    registerDependencies();
    container.registerInstance(AuthService, { uploadUserAvatar: vi.fn() } as unknown as AuthService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);
    const body = new FormData();
    body.append('avatar', 'not-a-file');

    const response = await app.request('/auth/me/avatar', {
      method: 'PUT',
      headers: {
        Cookie: 'session_id=current-session-id',
        'X-CSRF-Token': 'csrf-token',
      },
      body,
    });

    expect(response.status).toBe(400);
  });

  it('removes the current custom avatar without an upload body', async () => {
    const { auditLog } = registerDependencies();
    const updateUserAvatar = vi.fn().mockResolvedValue(USER);
    container.registerInstance(AuthService, { updateUserAvatar } as unknown as AuthService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/me/avatar', {
      method: 'DELETE',
      headers: {
        Cookie: 'session_id=current-session-id',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(updateUserAvatar).toHaveBeenCalledWith(USER.id, null);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.avatar_remove', resourceId: USER.id })
    );
  });

  it('authenticates DELETE /me/sessions/:id before accessing the current user', async () => {
    const { revokeUserSessionByPublicId, auditLog } = registerDependencies();
    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/me/sessions/session-public-id', {
      method: 'DELETE',
      headers: {
        Cookie: 'session_id=current-session-id',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Session revoked' });
    expect(revokeUserSessionByPublicId).toHaveBeenCalledWith(USER.id, 'session-public-id', {
      excludeSessionId: 'current-session-id',
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id, resourceId: 'session-public-id', action: 'auth.session_revoke' })
    );
  });

  it('restores the original administrator session without resolving the impersonated subject', async () => {
    const actor = { ...USER, id: 'actor-1', scopes: [] };
    const subject = {
      ...USER,
      id: 'subject-1',
      email: 'subject@example.com',
      isBlocked: true,
      isDeleted: true,
    };
    const originalSession = {
      ...SESSION,
      userId: actor.id,
      user: actor,
      purpose: 'user' as const,
    };
    const impersonationSession = {
      ...SESSION,
      userId: subject.id,
      user: subject,
      purpose: 'impersonation' as const,
      impersonation: { actorUserId: actor.id, originalSessionId: 'original-session' },
    };
    const destroySession = vi.fn().mockResolvedValue(undefined);
    const auditLog = vi.fn().mockResolvedValue(true);
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(impersonationSession),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      getOriginalSessionForImpersonation: vi
        .fn()
        .mockResolvedValue({ sessionId: 'original-session', session: originalSession }),
      destroySession,
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(actor),
    } as unknown as AuthService);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://opfield.example.com'),
    } as unknown as GeneralSettingsService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);
    const response = await app.request('/auth/impersonation/stop', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=impersonation-session',
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('original-session');
    expect(destroySession).toHaveBeenCalledWith('impersonation-session');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: actor.id,
        action: 'auth.impersonation.stop',
        resourceId: subject.id,
      })
    );
  });

  it('keeps CSRF recovery available for an impersonation session with changed authorization', async () => {
    const impersonationSession = {
      ...SESSION,
      purpose: 'impersonation' as const,
      impersonation: { actorUserId: 'actor-1', originalSessionId: 'original-session' },
    };
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(impersonationSession),
      ensureCsrfToken: vi.fn().mockResolvedValue('recovery-csrf-token'),
    } as unknown as SessionService);

    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);
    const response = await app.request('/auth/csrf', {
      headers: { Cookie: 'session_id=impersonation-session' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ csrfToken: 'recovery-csrf-token' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('OIDC callback route', () => {
  it('passes the resolved client metadata to the OIDC session', async () => {
    const { auditLog } = registerDependencies();
    const handleCallback = vi.fn().mockResolvedValue({ sessionId: 'new-session-id', user: USER });
    container.registerInstance(AuthService, { handleCallback } as unknown as AuthService);
    container.registerInstance(OidcSettingsService, {
      getRuntimeConfig: vi.fn().mockResolvedValue({ redirectUri: 'https://opfield.example.com/auth/callback' }),
    } as unknown as OidcSettingsService);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://opfield.example.com'),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'reverse_proxy',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);

    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/callback?code=code&state=state', {
      headers: {
        'User-Agent': 'Mozilla/5.0 Opfield browser',
        'X-Forwarded-For': '203.0.113.10',
        Cookie: `${OIDC_STATE_COOKIE_NAME}=${hashOidcState('state')}`,
      },
    });

    expect(response.status).toBe(302);
    expect(handleCallback).toHaveBeenCalledWith(
      'https://opfield.example.com/auth/callback?code=code&state=state',
      'state',
      {
        ipAddress: '203.0.113.10',
        userAgent: 'Mozilla/5.0 Opfield browser',
      }
    );
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login', userId: USER.id }));
  });

  it('preserves a same-origin return path through the frontend callback', async () => {
    registerDependencies();
    const returnTo = 'https://opfield.example.com/proxy-hosts/route-1?tab=ssl';
    const handleCallback = vi.fn().mockResolvedValue({ sessionId: 'new-session-id', user: USER, returnTo });
    container.registerInstance(AuthService, { handleCallback } as unknown as AuthService);
    container.registerInstance(OidcSettingsService, {
      getRuntimeConfig: vi.fn().mockResolvedValue({ redirectUri: 'https://opfield.example.com/auth/callback' }),
    } as unknown as OidcSettingsService);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://opfield.example.com'),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'direct',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);

    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/callback?code=code&state=state', {
      headers: { Cookie: `${OIDC_STATE_COOKIE_NAME}=${hashOidcState('state')}` },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `https://opfield.example.com/callback?return_to=${encodeURIComponent(returnTo)}`
    );
  });
});

describe('OIDC login CSRF binding', () => {
  function registerOidcRouteDependencies(handleCallback = vi.fn()) {
    const { auditLog } = registerDependencies();
    container.registerInstance(AuthService, {
      handleCallback,
      getAuthorizationUrl: vi
        .fn()
        .mockResolvedValue(
          `https://idp.example.com/authorize?client_id=${LEGACY_INSTALL_DIR_NAME}&state=state-from-login`
        ),
    } as unknown as AuthService);
    container.registerInstance(OidcSettingsService, {
      getRuntimeConfig: vi.fn().mockResolvedValue({ redirectUri: 'https://opfield.example.com/auth/callback' }),
    } as unknown as OidcSettingsService);
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue('https://opfield.example.com'),
    } as unknown as GeneralSettingsService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'direct',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);
    return { app, auditLog, handleCallback };
  }

  it('binds the pending authorization state to the browser with a short-lived httpOnly cookie', async () => {
    const { app } = registerOidcRouteDependencies();

    const response = await app.request('/auth/login');

    expect(response.status).toBe(302);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${OIDC_STATE_COOKIE_NAME}=${hashOidcState('state-from-login')}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=300');
    expect(cookie).not.toContain('state-from-login;');
  });

  it('moves a login started on another origin to the callback origin before binding state', async () => {
    const { app } = registerOidcRouteDependencies();
    const returnTo = 'https://opfield.example.com/nodes';

    const response = await app.request(`/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
      headers: { host: '192.168.1.10:3000' },
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://opfield.example.com/auth/login');
    expect(location.searchParams.get('return_to')).toBe(returnTo);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('binds state directly when the login already runs on the callback origin', async () => {
    const { app } = registerOidcRouteDependencies();

    const response = await app.request('/auth/login', {
      headers: { host: 'opfield.example.com', 'x-forwarded-proto': 'https' },
    });

    expect(response.headers.get('location')).toContain('https://idp.example.com/authorize');
    expect(response.headers.get('set-cookie')).toContain(OIDC_STATE_COOKIE_NAME);
  });

  it('never moves a login twice, so a proxy that hides the browser host cannot loop', async () => {
    const { app } = registerOidcRouteDependencies();

    const first = await app.request('/auth/login', { headers: { host: 'backend:3000' } });
    const hop = new URL(first.headers.get('location') ?? '');
    const second = await app.request(hop.pathname + hop.search, { headers: { host: 'backend:3000' } });

    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toContain('https://idp.example.com/authorize');
    expect(second.headers.get('set-cookie')).toContain(OIDC_STATE_COOKIE_NAME);
  });

  it('refuses a callback whose state was not started in this browser', async () => {
    const { app, handleCallback, auditLog } = registerOidcRouteDependencies();

    const missing = await app.request('/auth/callback?code=code&state=attacker-state');
    const mismatched = await app.request('/auth/callback?code=code&state=attacker-state', {
      headers: { Cookie: `${OIDC_STATE_COOKIE_NAME}=${hashOidcState('victim-state')}` },
    });

    expect(missing.status).toBe(400);
    expect(mismatched.status).toBe(400);
    expect(handleCallback).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login_failed' }));
    expect(mismatched.headers.get('set-cookie')).toContain(`${OIDC_STATE_COOKIE_NAME}=;`);
  });

  it('clears the binding cookie after a successful callback', async () => {
    const { app } = registerOidcRouteDependencies(
      vi.fn().mockResolvedValue({ sessionId: 'new-session-id', user: USER })
    );

    const response = await app.request('/auth/callback?code=code&state=state', {
      headers: { Cookie: `${OIDC_STATE_COOKIE_NAME}=${hashOidcState('state')}` },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain(`${OIDC_STATE_COOKIE_NAME}=;`);
  });
});

describe('logout', () => {
  it('clears the session cookie when no identity-provider logout URL exists', async () => {
    registerDependencies();
    const logout = vi.fn().mockResolvedValue(null);
    container.registerInstance(AuthService, { logout } as unknown as AuthService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'session_id=current-session-id', 'X-CSRF-Token': 'csrf-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Logged out successfully' });
    expect(logout).toHaveBeenCalledWith('current-session-id');
    expect(response.headers.get('set-cookie')).toContain('session_id=;');
    // The __Host- cookie can only be cleared with Secure set (R1-10).
    expect(response.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-'))).toMatch(/; Secure/);
  });
});

describe('second-factor step-up', () => {
  it('refuses to reset TOTP without a fresh second-factor proof', async () => {
    registerDependencies();
    const resetTotp = vi.fn();
    container.registerInstance(MfaService, {
      assertSecondFactorChangeAllowed: vi
        .fn()
        .mockRejectedValue(new AppError(403, 'MFA_STEP_UP_REQUIRED', 'Step-up required')),
      resetTotp,
    } as unknown as MfaService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);
    const localUser = { ...USER, authMethod: 'password' as const };
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(localUser) },
        permissionGroups: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes: USER.scopes }]),
        },
      },
    } as unknown as DrizzleClient);

    const response = await app.request('/auth/me/mfa/totp/reset', {
      method: 'POST',
      headers: { Cookie: 'session_id=current-session-id', 'X-CSRF-Token': 'csrf-token' },
    });

    expect(response.status).toBe(403);
    expect(resetTotp).not.toHaveBeenCalled();
  });

  it('grants a step-up after a passkey assertion for the current user', async () => {
    registerDependencies();
    const localUser = { ...USER, authMethod: 'password' as const };
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(localUser) },
        permissionGroups: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes: USER.scopes }]),
        },
      },
    } as unknown as DrizzleClient);
    const verifyAuthentication = vi.fn().mockResolvedValue(localUser);
    const grantStepUp = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(PasskeyService, { verifyAuthentication } as unknown as PasskeyService);
    container.registerInstance(MfaService, { grantStepUp } as unknown as MfaService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/me/mfa/step-up/passkey/verify', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=current-session-id',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ challenge: 'challenge-value-1234', response: { id: 'credential' } }),
    });

    expect(response.status).toBe(200);
    expect(verifyAuthentication).toHaveBeenCalledWith('challenge-value-1234', { id: 'credential' }, USER.id, false);
    expect(grantStepUp).toHaveBeenCalledWith(USER.id, 'current-session-id');
  });
});

describe('recovery code regeneration', () => {
  it('verifies the TOTP code through the step-up failure counter and lockout', async () => {
    registerDependencies();
    const localUser = { ...USER, authMethod: 'password' as const };
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(localUser) },
        permissionGroups: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes: USER.scopes }]),
        },
      },
    } as unknown as DrizzleClient);
    const verifyTotp = vi.fn().mockResolvedValue(true);
    const verifyStepUpCode = vi
      .fn()
      .mockRejectedValue(new AppError(429, 'MFA_STEP_UP_LOCKED', 'Too many failed verification attempts'));
    const regenerateRecoveryCodes = vi.fn();
    container.registerInstance(MfaService, {
      verifyTotp,
      verifyStepUpCode,
      regenerateRecoveryCodes,
    } as unknown as MfaService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);

    const response = await app.request('/auth/me/mfa/recovery-codes', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=current-session-id',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: '123456' }),
    });

    expect(response.status).toBe(429);
    expect(verifyStepUpCode).toHaveBeenCalledWith(USER.id, 'current-session-id', { totpCode: '123456' });
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(regenerateRecoveryCodes).not.toHaveBeenCalled();
  });
});

describe('impersonated sessions', () => {
  const subjectRow = {
    id: 'subject-1',
    oidcSubject: null,
    authMethod: 'password',
    email: 'subject@example.com',
    name: 'Subject',
    avatarUrl: null,
    groupId: 'viewer-group',
    additionalScopes: [],
    additionalGroupIds: [],
    isBlocked: false,
    deletedAt: null,
  };
  const actorRow = { ...subjectRow, id: 'actor-1', email: 'admin@example.com', groupId: 'admin-group' };

  function registerImpersonation() {
    let userLookups = 0;
    const revokeOtherUserSessions = vi.fn().mockResolvedValue(1);
    const revokeUserSessionByPublicId = vi.fn().mockResolvedValue(true);
    const impersonationSession: SessionData = {
      userId: subjectRow.id,
      user: { ...USER, id: subjectRow.id },
      purpose: 'impersonation',
      impersonation: { actorUserId: actorRow.id, originalSessionId: 'original-session' },
      csrfToken: 'csrf-token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(impersonationSession),
      getOriginalSessionForImpersonation: vi.fn().mockResolvedValue({
        sessionId: 'original-session',
        session: { ...SESSION, userId: actorRow.id, mfaSatisfiedAt: Date.now() },
      }),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      updateSession: vi.fn().mockResolvedValue(undefined),
      touchSession: vi.fn().mockResolvedValue(undefined),
      refreshSession: vi.fn().mockResolvedValue(false),
      revokeOtherUserSessions,
      revokeUserSessionByPublicId,
    } as unknown as SessionService);
    container.registerInstance(AuditService, { log: vi.fn() } as unknown as AuditService);
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: {
          // Each authentication resolves the subject, then the impersonating actor.
          findFirst: vi.fn(async () => (userLookups++ % 2 === 0 ? subjectRow : actorRow)),
        },
        permissionGroups: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'viewer-group', parentId: null, name: 'viewer', scopes: ['nodes:details'], require2fa: false },
            {
              id: 'admin-group',
              parentId: null,
              name: 'admin',
              scopes: ['admin:users:impersonate', 'nodes:details'],
              require2fa: false,
            },
          ]),
        },
      },
    } as unknown as DrizzleClient);
    const mfa = {
      resetTotp: vi.fn(),
      beginTotpSetup: vi.fn(),
      confirmTotpSetup: vi.fn(),
      assertSecondFactorChangeAllowed: vi.fn().mockResolvedValue(undefined),
      verifyStepUpCode: vi.fn(),
    };
    const passkeys = { beginRegistration: vi.fn(), finishRegistration: vi.fn(), removePasskey: vi.fn() };
    container.registerInstance(MfaService, mfa as unknown as MfaService);
    container.registerInstance(PasskeyService, passkeys as unknown as PasskeyService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);
    return { app, mfa, passkeys, revokeOtherUserSessions, revokeUserSessionByPublicId };
  }

  it.each([
    ['/auth/me/passkeys/options', 'POST'],
    ['/auth/me/passkeys', 'POST'],
    ['/auth/me/passkeys/passkey-1', 'DELETE'],
    ['/auth/me/mfa/totp/setup', 'POST'],
    ['/auth/me/mfa/totp/confirm', 'POST'],
    ['/auth/me/mfa/totp/reset', 'POST'],
    ['/auth/me/mfa/step-up', 'POST'],
    ['/auth/me/sessions/revoke-others', 'POST'],
    ['/auth/me/sessions/session-public-id', 'DELETE'],
  ])('refuses %s %s while impersonating', async (path, method) => {
    const { app, mfa, passkeys, revokeOtherUserSessions, revokeUserSessionByPublicId } = registerImpersonation();

    const response = await app.request(path, {
      method,
      headers: {
        Cookie: 'session_id=impersonation-session',
        'X-CSRF-Token': 'csrf-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: '123456', totpCode: '123456', response: {} }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN' });
    for (const fn of [...Object.values(mfa), ...Object.values(passkeys)]) expect(fn).not.toHaveBeenCalled();
    expect(revokeOtherUserSessions).not.toHaveBeenCalled();
    expect(revokeUserSessionByPublicId).not.toHaveBeenCalled();
  });
});

describe('sign-in audit entries name the account', () => {
  function signInApp() {
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi
        .fn()
        .mockResolvedValue({ clientIpSource: 'auto', trustedProxyCidrs: [], trustCloudflareHeaders: false }),
    } as unknown as NetworkSettingsService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', auditContextMiddleware);
    app.route('/auth', authRoutes);
    return app;
  }
  const login = (app: Hono<AppEnv>) =>
    app.request('/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Admin@Example.com', password: 'wrong-or-right' }),
    });

  it('records the attempted account of a refused password sign-in', async () => {
    const { auditLog } = registerDependencies();
    container.registerInstance(LocalAuthService, {
      authenticatePassword: vi.fn().mockResolvedValue(null),
    } as unknown as LocalAuthService);
    const response = await login(signInApp());
    expect(response.status).toBe(401);
    expect(auditLog).toHaveBeenCalledWith({
      userId: USER.id,
      action: 'auth.login_failed',
      resourceType: 'session',
      details: { method: 'password', email: 'admin@example.com' },
    });
  });

  it('records the user of a password sign-in still waiting for MFA', async () => {
    const { auditLog } = registerDependencies();
    container.registerInstance(LocalAuthService, {
      authenticatePassword: vi.fn().mockResolvedValue(USER),
    } as unknown as LocalAuthService);
    container.registerInstance(MfaService, {
      getStatus: vi.fn().mockResolvedValue({ totpConfigured: true, passkeyCount: 0 }),
      isOpfieldMfaRequired: vi.fn().mockResolvedValue(false),
      beginLoginChallenge: vi.fn().mockResolvedValue('challenge-1'),
    } as unknown as MfaService);
    const response = await login(signInApp());
    expect(response.status).toBe(200);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id, action: 'auth.password_login', resourceType: 'session' })
    );
  });
});

describe('session cookies follow the request protocol, not the public URL (AUTH-2)', () => {
  const HTTP_PUBLIC_URL = 'http://opfield.example.com';
  const viaHttpsProxy = { 'X-Forwarded-Proto': 'https' };

  function usePublicUrl(publicUrl: string) {
    container.registerInstance(GeneralSettingsService, {
      requirePublicUrl: vi.fn().mockResolvedValue(publicUrl),
      getPublicUrl: vi.fn().mockResolvedValue(publicUrl),
    } as unknown as GeneralSettingsService);
  }

  it('signs in with the __Host- Secure cookie over HTTPS while the public URL says http', async () => {
    registerDependencies();
    usePublicUrl(HTTP_PUBLIC_URL);
    container.registerInstance(SessionService, {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'new-session', expiresAt: Date.now() + 60_000 }),
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      recordSuccessfulSignIn: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthService);
    container.registerInstance(LocalAuthService, {
      authenticatePassword: vi.fn().mockResolvedValue({ ...USER, authMethod: 'password' }),
    } as unknown as LocalAuthService);
    container.registerInstance(MfaService, {
      getStatus: vi.fn().mockResolvedValue({ totpConfigured: false, passkeyCount: 0 }),
      isOpfieldMfaRequired: vi.fn().mockResolvedValue(false),
    } as unknown as MfaService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);

    const response = await app.request(`${HTTP_PUBLIC_URL}/auth/password/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...viaHttpsProxy },
      body: JSON.stringify({ email: USER.email, password: 'right' }),
    });

    expect(response.status).toBe(200);
    const session = response.headers.getSetCookie().find((value) => value.includes('new-session'));
    expect(session).toMatch(new RegExp(`^${getSessionCookieName('https')}=new-session`));
    expect(session).toMatch(/; Secure/);
  });

  it('returns to the administrator session with the __Host- cookie when impersonation stops over HTTPS', async () => {
    const actor = { ...USER, id: 'actor-1' };
    const impersonationSession = {
      ...SESSION,
      purpose: 'impersonation' as const,
      impersonation: { actorUserId: actor.id, originalSessionId: 'original-session' },
    };
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(impersonationSession),
      validateCsrfToken: vi.fn().mockResolvedValue(true),
      getOriginalSessionForImpersonation: vi.fn().mockResolvedValue({
        sessionId: 'original-session',
        session: { ...SESSION, userId: actor.id, user: actor, purpose: 'user', expiresAt: Date.now() + 60_000 },
      }),
      destroySession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionService);
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(actor),
    } as unknown as AuthService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(true) } as unknown as AuditService);
    usePublicUrl(HTTP_PUBLIC_URL);
    const app = new Hono<AppEnv>();
    app.route('/auth', authRoutes);

    const response = await app.request(`${HTTP_PUBLIC_URL}/auth/impersonation/stop`, {
      method: 'POST',
      headers: {
        ...viaHttpsProxy,
        Cookie: `${getSessionCookieName('https')}=impersonation-session`,
        'X-CSRF-Token': 'csrf-token',
      },
    });

    expect(response.status).toBe(200);
    const original = response.headers.getSetCookie().find((value) => value.includes('original-session'));
    expect(original).toMatch(new RegExp(`^${getSessionCookieName('https')}=original-session`));
    expect(original).toMatch(/; Secure/);
  });
});

describe('admin recovery sign-in', () => {
  function registerRecovery(consumed: string | null, systemAdmin: boolean) {
    const { auditLog } = registerDependencies();
    const adminRows = systemAdmin ? [{ id: USER.id }] : [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => adminRows,
    };
    container.registerInstance(TOKENS.DrizzleClient, { select: () => chain } as unknown as DrizzleClient);
    const consumeAdminRecoveryToken = vi.fn().mockResolvedValue(consumed);
    container.registerInstance(LocalAuthService, { consumeAdminRecoveryToken } as unknown as LocalAuthService);
    const localUser = { ...USER, authMethod: 'password' as const };
    container.registerInstance(AuthService, {
      getUserById: vi.fn().mockResolvedValue(localUser),
      recordSuccessfulSignIn: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthService);
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'recovery-session-id' });
    container.registerInstance(SessionService, { createSession } as unknown as SessionService);
    const grantStepUp = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(MfaService, { grantStepUp } as unknown as MfaService);
    container.registerInstance(NetworkSettingsService, {
      getConfig: vi.fn().mockResolvedValue({
        clientIpSource: 'reverse_proxy',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }),
    } as unknown as NetworkSettingsService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/auth', authRoutes);
    const request = () =>
      app.request('/auth/recovery/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'challenge-id.secret' }),
      });
    return { auditLog, consumeAdminRecoveryToken, createSession, grantStepUp, request };
  }

  it('signs the administrator in past their second factor, audited, and opens Profile security', async () => {
    const { auditLog, consumeAdminRecoveryToken, createSession, grantStepUp, request } = registerRecovery(
      USER.id,
      true
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, redirectTo: '/profile#security' });
    expect(consumeAdminRecoveryToken).toHaveBeenCalledWith('challenge-id.secret');
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER.id }),
      expect.objectContaining({ authMethod: 'password', mfaSatisfiedAt: expect.any(Number) })
    );
    expect(grantStepUp).toHaveBeenCalledWith(USER.id, 'recovery-session-id', 30 * 60);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.recovery_sign_in', userId: USER.id, resourceType: 'session' })
    );
    expect(response.headers.get('set-cookie')).toContain('recovery-session-id');
  });

  it('refuses a used link and an account that is no longer a system administrator', async () => {
    const used = registerRecovery(null, true);
    expect((await used.request()).status).toBe(400);
    expect(used.createSession).not.toHaveBeenCalled();
    container.reset();
    const demoted = registerRecovery(USER.id, false);
    expect((await demoted.request()).status).toBe(400);
    expect(demoted.createSession).not.toHaveBeenCalled();
  });
});
