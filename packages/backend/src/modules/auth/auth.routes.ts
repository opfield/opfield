import { createHash, timingSafeEqual } from 'node:crypto';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getEnv } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { users } from '@/db/schema/index.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getClientIpForContext, getDistinctClientIpForContext } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { setAuditSubjectUser } from '@/modules/audit/audit-request-context.js';
import { DemoAuthService } from '@/modules/demo/demo-auth.service.js';
import { isCanonicalSystemAdmin, isDemoMode, isDemoVisitor } from '@/modules/demo/demo-mode.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, AuthMethod } from '@/types.js';
import {
  beginCurrentUserTotpSetupRoute,
  confirmCurrentUserTotpSetupRoute,
  csrfTokenRoute,
  currentUserPreferencesRoute,
  currentUserRoute,
  getCurrentUserMfaRoute,
  listCurrentUserSessionsRoute,
  logoutRoute,
  regenerateCurrentUserRecoveryCodesRoute,
  removeCurrentUserAvatarRoute,
  resetCurrentUserTotpRoute,
  revokeCurrentUserSessionRoute,
  revokeOtherCurrentUserSessionsRoute,
  stopImpersonationRoute,
  updateCurrentUserAvatarRoute,
  updateCurrentUserPreferencesRoute,
} from './auth.docs.js';
import {
  assertNotImpersonating,
  authMiddleware,
  CSRF_HEADER_NAME,
  rejectImpersonation,
  sessionOnly,
} from './auth.middleware.js';
import { AuthService } from './auth.service.js';
import {
  EmailCodeSchema,
  EmailSchema,
  ErrorSchema,
  LocalPasswordLoginSchema,
  MfaEnrollmentConfirmSchema,
  MfaEnrollmentPasskeyConfirmSchema,
  MfaEnrollmentTokenSchema,
  MfaPasskeyOptionsSchema,
  MfaPasskeyVerifySchema,
  MfaStepUpSchema,
  MfaVerifySchema,
  PasskeyAuthenticationSchema,
  PasskeyRegistrationSchema,
  PasswordCompleteSchema,
  PasswordResetTokenSchema,
} from './auth-route-schemas.js';
import { AvatarStorageService } from './avatar-storage.service.js';
import { sessionAllowedForCookie } from './legacy-session-cookie.js';
import { requiresSessionMfaReauthentication } from './live-session-user.js';
import { LocalAuthService } from './local-auth.service.js';
import { MfaService } from './mfa.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';
import { PasskeyService } from './passkey.service.js';
import { getPublicAuthMethods } from './public-auth-methods.js';
import {
  clearSessionCookies,
  getSessionCookieNameForUrl,
  getSessionCookiePublicUrl,
  isLoopbackUrl,
  LEGACY_SESSION_COOKIE_NAME,
  selectSessionCookie,
} from './session-cookie.js';

export const authRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

const demoOnlyAuthRoute = async (c: any, next: () => Promise<void>) => {
  if (!isDemoMode()) return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  await next();
};

const standardOnlyPublicAuthRoute = async (c: any, next: () => Promise<void>) => {
  if (isDemoMode()) return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  await next();
};

authRoutes.use('/demo/*', demoOnlyAuthRoute);
authRoutes.use('/login', standardOnlyPublicAuthRoute);
authRoutes.use('/callback', standardOnlyPublicAuthRoute);
authRoutes.use('/password/*', standardOnlyPublicAuthRoute);
authRoutes.use('/email/*', standardOnlyPublicAuthRoute);
authRoutes.use('/email-otp/*', standardOnlyPublicAuthRoute);
authRoutes.use('/passkeys/*', standardOnlyPublicAuthRoute);

async function setLocalSession(c: any, user: import('@/types.js').User, authMethod: AuthMethod, mfaSatisfied = false) {
  setAuditSubjectUser(user.id);
  const sessionService = container.resolve(SessionService);
  const { sessionId } = await sessionService.createSession(user, {
    authMethod,
    ipAddress: await getClientIpForContext(c),
    userAgent: c.req.header('user-agent'),
    ...(mfaSatisfied ? { mfaSatisfiedAt: Date.now() } : {}),
  });
  await container.resolve(AuthService).recordSuccessfulSignIn(user.id);
  const publicUrl = await getPublicUrl();
  const publicUrlObject = new URL(publicUrl);
  const cookieOptions = {
    httpOnly: true,
    secure: publicUrlObject.protocol === 'https:',
    sameSite: 'Lax' as const,
    maxAge: getEnvironmentSettingsSnapshot().sessions.expirySeconds,
    path: '/',
  };
  setCookie(c, getSessionCookieNameForUrl(publicUrl), sessionId, cookieOptions);

  if (isLoopbackUrl(publicUrl)) {
    setCookie(c, LEGACY_SESSION_COOKIE_NAME, sessionId, cookieOptions);
  }
}

async function getPublicUrl(): Promise<string> {
  try {
    return await container.resolve(GeneralSettingsService).requirePublicUrl();
  } catch {
    // Isolated tests and pre-migration fixtures still provide APP_URL.
    return getEnv().APP_URL;
  }
}

async function getRequestSessionId(c: any): Promise<string | null> {
  const publicUrl = await getSessionCookiePublicUrl();
  const cookie = selectSessionCookie((name) => getCookie(c, name), publicUrl, c.req.header('Cookie') ?? '');
  if (!cookie?.legacy) return cookie?.value ?? null;
  const session = await container.resolve(SessionService).getSession(cookie.value);
  return session && sessionAllowedForCookie(cookie, session) ? cookie.value : null;
}

async function finishLocalPrimaryAuth(c: any, user: import('@/types.js').User, authMethod: 'password' | 'email_otp') {
  // The first factor passed: the sign-in's audit entry names this user, also while MFA is still pending.
  setAuditSubjectUser(user.id);
  const mfa = container.resolve(MfaService);
  const [mfaStatus, opfieldMfaRequired] = await Promise.all([
    mfa.getStatus(user.id),
    mfa.isOpfieldMfaRequired(user.id),
  ]);

  if (mfaStatus.totpConfigured || mfaStatus.passkeyCount > 0) {
    return c.json({
      ok: true,
      mfaRequired: true,
      mfaPasskeyAvailable: mfaStatus.passkeyCount > 0,
      challengeId: await mfa.beginLoginChallenge(user.id, authMethod),
    });
  }

  if (opfieldMfaRequired) {
    return c.json({
      ok: true,
      mfaEnrollmentRequired: true,
      enrollmentToken: await mfa.beginEnrollmentChallenge(user.id, authMethod),
    });
  }

  await setLocalSession(c, user, authMethod);
  return c.json({ ok: true });
}

/**
 * A refused local sign-in: names the account that was tried (its user when one exists, and the email entered), so
 * the audit log shows whose sign-in failed. The sign-in rate limit bounds how often this writes.
 */
async function auditFailedLocalSignIn(method: 'password', email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const attempted = await container
    .resolve<DrizzleClient>(TOKENS.DrizzleClient)
    .query.users.findFirst({ where: eq(users.email, normalized), columns: { id: true } })
    .then((row) => row?.id ?? null)
    .catch(() => null);
  await container
    .resolve(AuditService)
    .log({
      userId: attempted,
      action: 'auth.login_failed',
      resourceType: 'session',
      details: { method, email: normalized.slice(0, 320) },
    })
    .catch(() => undefined);
}

export const OIDC_STATE_COOKIE_NAME = 'opfield_oidc_state';
const OIDC_STATE_COOKIE_MAX_AGE_SECONDS = 5 * 60;

export function hashOidcState(state: string): string {
  return createHash('sha256').update(state).digest('base64url');
}

export function oidcStateMatchesBinding(state: string, binding: string | undefined): boolean {
  if (!binding) return false;
  const expected = Buffer.from(hashOidcState(state));
  const actual = Buffer.from(binding);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function assertLocalMfaAccount(user: import('@/types.js').User) {
  if (user.authMethod === 'oidc') {
    throw new AppError(409, 'MFA_MANAGED_BY_IDP', 'MFA for OIDC accounts is managed by the identity provider');
  }
}

function isAllowedDemoMfaUser(user: import('@/types.js').User): boolean {
  return !isDemoMode() || isCanonicalSystemAdmin(user, user.scopes);
}

// Login route
const loginRoute = createRoute({
  method: 'get',
  path: '/login',
  tags: ['Authentication'],
  summary: 'Initiate OIDC login',
  request: {
    query: z.object({
      return_to: z.string().url().optional(),
    }),
  },
  responses: {
    302: { description: 'Redirect to OIDC provider' },
    500: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Failed to initiate login' },
  },
});

/** Marks a login already moved to the callback origin, so it is never moved twice. */
const OIDC_LOGIN_ORIGIN_HOP_PARAM = 'oidc_origin_hop';

/** Origin the browser used for this request, or null when it cannot be told. */
function browserRequestOrigin(c: Context<AppEnv>): string | null {
  const host = (c.req.header('x-forwarded-host') ?? c.req.header('host'))?.split(',')[0]?.trim();
  if (!host) return null;
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const protocol = forwardedProto ? `${forwardedProto}:` : new URL(c.req.url).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  try {
    return new URL(`${protocol}//${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * The state cookie must be set on the origin that receives the OIDC callback.
 * A login started from another host (a LAN IP, plain http) is first moved to
 * the redirect URI's origin. Only when the browser's origin is known and
 * differs, and at most once per login, so a proxy that hides the host cannot
 * cause a redirect loop.
 */
function loginOnCallbackOriginUrl(c: Context<AppEnv>, redirectUri: string): string | null {
  const requestUrl = new URL(c.req.url);
  if (requestUrl.searchParams.has(OIDC_LOGIN_ORIGIN_HOP_PARAM)) return null;
  const requestOrigin = browserRequestOrigin(c);
  if (!requestOrigin) return null;
  let callbackOrigin: string;
  try {
    callbackOrigin = new URL(redirectUri).origin;
  } catch {
    return null;
  }
  if (requestOrigin === callbackOrigin) return null;
  const target = new URL(requestUrl.pathname + requestUrl.search, callbackOrigin);
  target.searchParams.set(OIDC_LOGIN_ORIGIN_HOP_PARAM, '1');
  return target.toString();
}

authRoutes.openapi(loginRoute, async (c) => {
  const authService = container.resolve(AuthService);
  const { return_to } = c.req.valid('query');
  const oidc = await container.resolve(OidcSettingsService).getRuntimeConfig();
  const callbackOriginLogin = oidc ? loginOnCallbackOriginUrl(c, oidc.redirectUri) : null;
  if (callbackOriginLogin) return c.redirect(callbackOriginLogin, 302);
  const authUrl = await authService.getAuthorizationUrl(return_to);
  const state = new URL(authUrl).searchParams.get('state');
  if (!state) throw new AppError(500, 'AUTH_ERROR', 'Failed to initiate login');
  // Bind the pending authorization to this browser. Without it, an attacker
  // could start a login with their own IdP account and hand the victim the
  // callback URL, signing the victim into the attacker's Opfield account.
  // The cookie is read back on the callback, i.e. on the redirect URI's origin.
  const cookieOrigin = oidc?.redirectUri ?? (await getPublicUrl());
  setCookie(c, OIDC_STATE_COOKIE_NAME, hashOidcState(state), {
    httpOnly: true,
    secure: new URL(cookieOrigin).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: OIDC_STATE_COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
  return c.redirect(authUrl, 302);
});

// Callback route
const callbackRoute = createRoute({
  method: 'get',
  path: '/callback',
  tags: ['Authentication'],
  summary: 'OIDC callback',
  request: {
    query: z.object({
      // An error response from the provider carries no code, and may carry no state.
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }),
  },
  responses: {
    302: { description: 'Redirect to application' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Authentication failed' },
  },
});

authRoutes.openapi(callbackRoute, async (c) => {
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const { state, error, error_description } = c.req.valid('query');
  const stateBinding = getCookie(c, OIDC_STATE_COOKIE_NAME);
  deleteCookie(c, OIDC_STATE_COOKIE_NAME, { path: '/' });

  if (error) {
    await auditService.log({
      userId: null,
      action: 'auth.login_failed',
      resourceType: 'session',
      details: { error, errorDescription: error_description || null },
    });
    return c.json({ code: 'AUTH_ERROR', message: error_description || error }, 400);
  }

  if (!state || !c.req.valid('query').code) {
    return c.json({ code: 'AUTH_ERROR', message: 'The sign-in response has no code or state' }, 400);
  }

  if (!oidcStateMatchesBinding(state, stateBinding)) {
    await auditService.log({
      userId: null,
      action: 'auth.login_failed',
      resourceType: 'session',
      details: { error: 'OIDC state is not bound to this browser' },
    });
    return c.json(
      { code: 'AUTH_ERROR', message: 'This sign-in was started in another browser or has expired. Try again.' },
      400
    );
  }

  try {
    const requestUrl = new URL(c.req.url);
    const oidc = await container.resolve(OidcSettingsService).getRuntimeConfig();
    if (!oidc) {
      return c.json({ code: 'OIDC_NOT_CONFIGURED', message: 'OIDC is not configured' }, 503);
    }
    const callbackUrl = new URL(oidc.redirectUri);
    callbackUrl.search = requestUrl.search;

    const result = await authService.handleCallback(callbackUrl.toString(), state, {
      ipAddress: await getClientIpForContext(c),
      userAgent: c.req.header('user-agent'),
    });
    await auditService.log({
      userId: result.user.id,
      action: 'auth.login',
      resourceType: 'session',
      details: { returnTo: result.returnTo ?? null },
    });

    const publicUrl = await getPublicUrl();
    setCookie(c, getSessionCookieNameForUrl(publicUrl), result.sessionId, {
      httpOnly: true,
      secure: new URL(publicUrl).protocol === 'https:',
      sameSite: 'Lax',
      maxAge: getEnvironmentSettingsSnapshot().sessions.expirySeconds,
      path: '/',
    });

    let safeReturnTo: string | null = null;
    let directReturnTo: string | null = null;
    if (result.returnTo) {
      try {
        if (new URL(result.returnTo).origin === new URL(publicUrl).origin) {
          safeReturnTo = result.returnTo;
          const returnPath = new URL(result.returnTo).pathname;
          if (returnPath.startsWith('/api/oauth/authorize') || returnPath === '/oauth/consent') {
            directReturnTo = result.returnTo;
          }
        }
      } catch {
        // Invalid URL, use default
      }
    }
    if (directReturnTo) {
      return c.redirect(directReturnTo, 302);
    }
    const redirectUrl = new URL('/callback', publicUrl);
    if (safeReturnTo) redirectUrl.searchParams.set('return_to', safeReturnTo);
    return c.redirect(redirectUrl.toString(), 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication failed';
    await auditService.log({
      userId: null,
      action: 'auth.login_failed',
      resourceType: 'session',
      details: { error: message },
    });
    return c.json({ code: 'AUTH_ERROR', message }, 400);
  }
});

authRoutes.get('/methods', async (c) => {
  return c.json(await getPublicAuthMethods());
});

authRoutes.post('/demo/request', async (c) => {
  const input = EmailSchema.parse(await c.req.json());
  const challengeId = await container
    .resolve(DemoAuthService)
    .requestCode(input.email)
    .catch(() => null);
  return c.json({ ok: true, challengeId: challengeId ?? crypto.randomUUID() });
});

authRoutes.post('/demo/verify', async (c) => {
  const input = EmailCodeSchema.parse(await c.req.json());
  const user = await container.resolve(DemoAuthService).verifyCode(input.challengeId, input.code);
  if (!user) return c.json({ code: 'INVALID_CODE', message: 'Invalid or expired sign-in code' }, 401);
  if ((user.groupNames ?? [user.groupName]).includes('system-admin') && user.scopes.includes('admin:system')) {
    return finishLocalPrimaryAuth(c, user, 'email_otp');
  }
  await setLocalSession(c, user, 'demo_email_otp', true);
  return c.json({ ok: true });
});

authRoutes.post('/password/login', async (c) => {
  const input = LocalPasswordLoginSchema.parse(await c.req.json());
  const localAuth = container.resolve(LocalAuthService);
  const user = await localAuth.authenticatePassword(
    input.email,
    input.password,
    await getDistinctClientIpForContext(c)
  );
  if (!user) {
    await auditFailedLocalSignIn('password', input.email);
    return c.json({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' }, 401);
  }
  return finishLocalPrimaryAuth(c, user, 'password');
});

authRoutes.post('/email/continue', async (c) => {
  const input = EmailSchema.parse(await c.req.json());
  return c.json(await container.resolve(LocalAuthService).beginEmailSignIn(input.email));
});

authRoutes.post('/email-otp/request', async (c) => {
  const input = EmailSchema.parse(await c.req.json());
  const localAuth = container.resolve(LocalAuthService);
  const challengeId = await localAuth.requestEmailOtp(input.email).catch(() => null);
  return c.json({ ok: true, challengeId: challengeId ?? crypto.randomUUID() });
});

authRoutes.post('/email-otp/verify', async (c) => {
  const input = EmailCodeSchema.parse(await c.req.json());
  const localAuth = container.resolve(LocalAuthService);
  const user = await localAuth.verifyEmailOtp(input.challengeId, input.code, await getDistinctClientIpForContext(c));
  if (!user) return c.json({ code: 'INVALID_CODE', message: 'Invalid or expired sign-in code' }, 401);
  return finishLocalPrimaryAuth(c, user, 'email_otp');
});

authRoutes.post('/mfa/verify', async (c) => {
  const input = MfaVerifySchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const completed = await mfa.verifyLoginChallenge(input.challengeId, input, await getDistinctClientIpForContext(c));
  if (!completed) return c.json({ code: 'INVALID_MFA_CODE', message: 'Invalid or expired authentication code' }, 401);
  const user = await container.resolve(AuthService).getUserById(completed.userId);
  if (!user || user.isBlocked || !isAllowedDemoMfaUser(user))
    return c.json({ code: 'INVALID_MFA_CODE', message: 'Invalid or expired authentication code' }, 401);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true });
});

authRoutes.post('/mfa/enrollment/totp/setup', async (c) => {
  const { token } = MfaEnrollmentTokenSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const user = await container.resolve(AuthService).getUserById(pending.userId);
  if (!user || user.isBlocked || !isAllowedDemoMfaUser(user))
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  return c.json(await mfa.beginTotpSetup(user.id, user.email));
});

authRoutes.post('/mfa/enrollment/totp/confirm', async (c) => {
  const { token, code } = MfaEnrollmentConfirmSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const recoveryCodes = await mfa.confirmTotpSetup(pending.userId, code);
  const completed = await mfa.completeEnrollmentChallenge(token);
  const user = completed ? await container.resolve(AuthService).getUserById(completed.userId) : null;
  if (!completed || !user || user.isBlocked || !isAllowedDemoMfaUser(user))
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true, recoveryCodes });
});

authRoutes.post('/mfa/enrollment/passkey/options', async (c) => {
  const { token } = MfaEnrollmentTokenSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const user = await container.resolve(AuthService).getUserById(pending.userId);
  if (!user || user.isBlocked || !isAllowedDemoMfaUser(user))
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  return c.json(await container.resolve(PasskeyService).beginRegistration(user));
});

authRoutes.post('/mfa/enrollment/passkey/confirm', async (c) => {
  const { token, response, name } = MfaEnrollmentPasskeyConfirmSchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getEnrollmentChallenge(token);
  if (!pending) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  const user = await container.resolve(AuthService).getUserById(pending.userId);
  if (!user || user.isBlocked || !isAllowedDemoMfaUser(user))
    return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  await container.resolve(PasskeyService).finishRegistration(user, response, name ?? 'Passkey');
  const completed = await mfa.completeEnrollmentChallenge(token);
  if (!completed) return c.json({ code: 'MFA_ENROLLMENT_EXPIRED', message: 'MFA enrollment has expired' }, 400);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true });
});

authRoutes.post('/passkeys/options', async (c) => {
  const options = await container.resolve(PasskeyService).beginDiscoverableAuthentication();
  return c.json(options);
});

authRoutes.post('/passkeys/verify', async (c) => {
  const { challenge, response } = PasskeyAuthenticationSchema.parse(await c.req.json());
  const user = await container.resolve(PasskeyService).verifyAuthentication(challenge, response);
  if (!user) return c.json({ code: 'INVALID_PASSKEY', message: 'Passkey sign-in could not be verified' }, 401);
  await setLocalSession(c, user, user.authMethod as 'password' | 'email_otp', true);
  return c.json({ ok: true });
});

authRoutes.post('/mfa/passkey/options', async (c) => {
  const { challengeId } = MfaPasskeyOptionsSchema.parse(await c.req.json());
  const pending = await container.resolve(MfaService).getLoginChallenge(challengeId);
  if (!pending) return c.json({ code: 'MFA_CHALLENGE_EXPIRED', message: 'MFA sign-in has expired' }, 400);
  const user = await container.resolve(AuthService).getUserById(pending.userId);
  if (!user || user.isBlocked || !isAllowedDemoMfaUser(user)) {
    return c.json({ code: 'MFA_CHALLENGE_EXPIRED', message: 'MFA sign-in has expired' }, 400);
  }
  return c.json(await container.resolve(PasskeyService).beginAuthenticationForUser(pending.userId));
});

authRoutes.post('/mfa/passkey/verify', async (c) => {
  const { challengeId, passkeyChallenge, response } = MfaPasskeyVerifySchema.parse(await c.req.json());
  const mfa = container.resolve(MfaService);
  const pending = await mfa.getLoginChallenge(challengeId);
  if (!pending) return c.json({ code: 'INVALID_MFA_PASSKEY', message: 'Passkey sign-in could not be verified' }, 401);
  const user = await container
    .resolve(PasskeyService)
    .verifyAuthentication(passkeyChallenge, response, pending.userId, false);
  const completed = user ? await mfa.completeVerifiedLoginChallenge(challengeId) : null;
  if (!user || !completed || !isAllowedDemoMfaUser(user))
    return c.json({ code: 'INVALID_MFA_PASSKEY', message: 'Passkey sign-in could not be verified' }, 401);
  await setLocalSession(c, user, completed.authMethod, true);
  return c.json({ ok: true });
});

authRoutes.post('/password/reset/request', async (c) => {
  const input = EmailSchema.parse(await c.req.json());
  await container
    .resolve(LocalAuthService)
    .requestPasswordLink(input.email, 'password_reset')
    .catch(() => {});
  return c.json({ ok: true });
});

authRoutes.post('/password/reset/profile', async (c) => {
  const { token } = PasswordResetTokenSchema.parse(await c.req.json());
  const profile = await container.resolve(LocalAuthService).getPasswordLinkProfile(token);
  if (!profile) return c.json({ code: 'INVALID_RESET_TOKEN', message: 'Invalid or expired password link' }, 400);
  return c.json(profile);
});

authRoutes.post('/password/reset/complete', async (c) => {
  const input = PasswordCompleteSchema.parse(await c.req.json());
  await container.resolve(LocalAuthService).completePasswordLink(input.token, input.password);
  return c.json({ ok: true });
});

// CSRF token for cookie-authenticated browser mutations
authRoutes.use('/csrf', async (c, next) => {
  const sessionId = await getRequestSessionId(c);
  const session = sessionId ? await container.resolve(SessionService).getSession(sessionId) : null;
  if (sessionId && session?.purpose === 'impersonation') {
    c.set('sessionId', sessionId);
    c.set('authType', 'session');
    await next();
    return;
  }
  await authMiddleware(c, next);
});
authRoutes.use('/csrf', sessionOnly);
authRoutes.openapi(csrfTokenRoute, async (c) => {
  const sessionId = c.get('sessionId');
  if (!sessionId) {
    return c.json({ code: 'AUTH_ERROR', message: 'Not a session-based login' }, 400);
  }
  const sessionService = container.resolve(SessionService);
  const csrfToken = await sessionService.ensureCsrfToken(sessionId);
  if (!csrfToken) {
    return c.json({ code: 'AUTH_ERROR', message: 'Invalid or expired session' }, 401);
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ csrfToken });
});

authRoutes.openapi(stopImpersonationRoute, async (c) => {
  const sessionService = container.resolve(SessionService);
  const impersonationSessionId = await getRequestSessionId(c);
  const impersonationSession = impersonationSessionId ? await sessionService.getSession(impersonationSessionId) : null;

  if (!impersonationSessionId || impersonationSession?.purpose !== 'impersonation') {
    throw new AppError(409, 'IMPERSONATION_NOT_ACTIVE', 'No impersonation session is active');
  }
  if (
    !(await sessionService.validateCsrfToken(
      impersonationSessionId,
      c.req.header(CSRF_HEADER_NAME),
      impersonationSession
    ))
  ) {
    throw new AppError(403, 'INVALID_CSRF', 'Invalid CSRF token');
  }

  const original = await sessionService.getOriginalSessionForImpersonation(impersonationSession);
  const actorUserId = impersonationSession.impersonation?.actorUserId;
  const actor = actorUserId ? await container.resolve(AuthService).getUserById(actorUserId) : null;
  if (
    !original ||
    !actor ||
    actor.isBlocked ||
    actor.isDeleted ||
    requiresSessionMfaReauthentication(actor, original.session)
  ) {
    await sessionService.destroySession(impersonationSessionId);
    clearSessionCookies(c);
    throw new AppError(401, 'ORIGINAL_SESSION_INVALID', 'The original administrator session is no longer valid');
  }

  const publicUrl = await getPublicUrl();
  setCookie(c, getSessionCookieNameForUrl(publicUrl), original.sessionId, {
    httpOnly: true,
    secure: new URL(publicUrl).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: Math.max(1, Math.floor((original.session.expiresAt - Date.now()) / 1000)),
    path: '/',
  });
  await sessionService.destroySession(impersonationSessionId);

  const subject = impersonationSession.user;
  await container.resolve(AuditService).log({
    userId: actor.id,
    action: 'auth.impersonation.stop',
    resourceType: 'session',
    resourceId: subject.id,
    details: {
      impersonatedUserId: subject.id,
      impersonatedUserEmail: subject.email,
      impersonatedUserName: subject.name,
    },
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ message: 'Impersonation stopped' });
});

// Logout
authRoutes.use('/logout', authMiddleware);
authRoutes.use('/logout', sessionOnly);
authRoutes.openapi(logoutRoute, async (c) => {
  const sessionId = c.get('sessionId');
  if (!sessionId) {
    return c.json({ message: 'Not a session-based login' }, 400);
  }
  const authService = container.resolve(AuthService);
  const auditService = container.resolve(AuditService);
  const user = c.get('user');
  if (!isDemoVisitor(user)) {
    await auditService.log({
      userId: user?.id ?? null,
      action: 'auth.logout',
      resourceType: 'session',
      details: { hasSession: true },
    });
  }
  let logoutUrl: string | null = null;
  try {
    logoutUrl = await authService.logout(sessionId);
  } finally {
    // Always drop the browser cookie, even if the IdP logout URL could not
    // be computed, so a signed-out browser never keeps a session reference.
    clearSessionCookies(c);
  }
  return c.json({ message: 'Logged out successfully', ...(logoutUrl ? { logoutUrl } : {}) });
});

// Get current user
authRoutes.use('/me', authMiddleware);
authRoutes.use('/me', sessionOnly);
authRoutes.openapi(currentUserRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const impersonation = c.get('impersonation');
  const authService = container.resolve(AuthService);
  const user = await authService.getUserById(sessionUser.id);
  const effectiveScopes = c.get('effectiveScopes') || user?.scopes || [];

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }

  return c.json({
    id: user.id,
    email: user.email,
    authMethod: user.authMethod,
    name: user.name,
    avatarUrl: user.avatarUrl,
    groupId: user.groupId,
    groupName: user.groupName,
    groupScopes: user.groupScopes ?? [],
    additionalScopes: user.additionalScopes ?? [],
    scopes: effectiveScopes,
    isBlocked: user.isBlocked,
    aiApprovalMode: user.aiApprovalMode ?? 'normal',
    ...(impersonation
      ? {
          impersonation: {
            active: true as const,
            actor: {
              id: impersonation.actor.id,
              email: impersonation.actor.email,
              name: impersonation.actor.name,
            },
          },
        }
      : {}),
  });
});

authRoutes.use('/me/preferences', authMiddleware);
authRoutes.use('/me/preferences', sessionOnly);
authRoutes.openapi(currentUserPreferencesRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const authService = container.resolve(AuthService);
  const preferences = await authService.getUserPreferences(sessionUser.id);
  if (!preferences) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }
  return c.json(preferences);
});

authRoutes.openapi(updateCurrentUserPreferencesRoute, async (c) => {
  const input = c.req.valid('json');
  // The subject's AI approval mode decides what their assistant may run unasked after the impersonation ends.
  if (input.aiApprovalMode !== undefined) {
    assertNotImpersonating(c, 'The AI approval mode cannot be changed while impersonating');
  }
  const sessionUser = c.get('user')!;
  const authService = container.resolve(AuthService);
  const preferences = await authService.updateUserPreferences(sessionUser.id, input);
  return c.json(preferences);
});

authRoutes.use('/me/avatar', authMiddleware);
authRoutes.use('/me/avatar', sessionOnly);
authRoutes.openapi(updateCurrentUserAvatarRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const { avatar } = c.req.valid('form');
  if (!(avatar instanceof File)) {
    throw new AppError(400, 'AVATAR_REQUIRED', 'Avatar image is required');
  }
  const updated = await container.resolve(AuthService).uploadUserAvatar(sessionUser.id, avatar);
  await container.resolve(AuditService).log({
    userId: sessionUser.id,
    action: 'user.avatar_update',
    resourceType: 'user',
    resourceId: sessionUser.id,
    details: { customAvatar: true, sizeBytes: avatar.size, mediaType: avatar.type },
  });
  return c.json(updated);
});

authRoutes.openapi(removeCurrentUserAvatarRoute, async (c) => {
  const sessionUser = c.get('user')!;
  const updated = await container.resolve(AuthService).updateUserAvatar(sessionUser.id, null);
  await container.resolve(AuditService).log({
    userId: sessionUser.id,
    action: 'user.avatar_remove',
    resourceType: 'user',
    resourceId: sessionUser.id,
    details: { customAvatar: false },
  });
  return c.json(updated);
});

authRoutes.get('/avatars/:filename', async (c) => {
  const asset = await container.resolve(AvatarStorageService).read(c.req.param('filename'));
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  c.header('Content-Type', asset.mediaType);
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(Uint8Array.from(asset.bytes).buffer);
});

authRoutes.use('/me/mfa', authMiddleware);
authRoutes.use('/me/mfa', sessionOnly);
authRoutes.openapi(getCurrentUserMfaRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const mfa = container.resolve(MfaService);
  const [status, required] = await Promise.all([mfa.getStatus(user.id), mfa.isOpfieldMfaRequired(user.id)]);
  return c.json({ ...status, required });
});

async function assertSecondFactorChangeAllowed(c: any, user: import('@/types.js').User): Promise<void> {
  await container.resolve(MfaService).assertSecondFactorChangeAllowed(user.id, c.get('sessionId')!);
}

// Step-up: prove an existing second factor before adding, replacing or
// removing one, so a stolen browser session cannot swap the account's factors.
authRoutes.use('/me/mfa/step-up', authMiddleware);
authRoutes.use('/me/mfa/step-up', sessionOnly);
authRoutes.use('/me/mfa/step-up', rejectImpersonation);
authRoutes.post('/me/mfa/step-up', async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const input = MfaStepUpSchema.parse(await c.req.json());
  if (!(await container.resolve(MfaService).verifyStepUpCode(user.id, c.get('sessionId')!, input))) {
    throw new AppError(401, 'INVALID_MFA_CODE', 'Invalid authentication code');
  }
  return c.json({ ok: true });
});

authRoutes.use('/me/mfa/step-up/passkey/*', authMiddleware);
authRoutes.use('/me/mfa/step-up/passkey/*', sessionOnly);
authRoutes.use('/me/mfa/step-up/passkey/*', rejectImpersonation);
authRoutes.post('/me/mfa/step-up/passkey/options', async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  return c.json(await container.resolve(PasskeyService).beginAuthenticationForUser(user.id));
});

authRoutes.post('/me/mfa/step-up/passkey/verify', async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const { challenge, response } = PasskeyAuthenticationSchema.parse(await c.req.json());
  const verifiedUser = await container
    .resolve(PasskeyService)
    .verifyAuthentication(challenge, response, user.id, false);
  if (!verifiedUser) throw new AppError(401, 'INVALID_PASSKEY', 'Passkey verification failed');
  await container.resolve(MfaService).grantStepUp(user.id, c.get('sessionId')!);
  return c.json({ ok: true });
});

authRoutes.use('/me/mfa/totp/setup', authMiddleware);
authRoutes.use('/me/mfa/totp/setup', sessionOnly);
authRoutes.use('/me/mfa/totp/setup', rejectImpersonation);
authRoutes.openapi(beginCurrentUserTotpSetupRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  await assertSecondFactorChangeAllowed(c, user);
  return c.json(await container.resolve(MfaService).beginTotpSetup(user.id, user.email));
});

authRoutes.use('/me/mfa/totp/reset', authMiddleware);
authRoutes.use('/me/mfa/totp/reset', sessionOnly);
authRoutes.use('/me/mfa/totp/reset', rejectImpersonation);
authRoutes.openapi(resetCurrentUserTotpRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  await assertSecondFactorChangeAllowed(c, user);
  await container.resolve(MfaService).resetTotp(user.id);
  return c.json({ ok: true });
});

authRoutes.use('/me/mfa/totp/confirm', authMiddleware);
authRoutes.use('/me/mfa/totp/confirm', sessionOnly);
authRoutes.use('/me/mfa/totp/confirm', rejectImpersonation);
authRoutes.openapi(confirmCurrentUserTotpSetupRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  await assertSecondFactorChangeAllowed(c, user);
  const { code } = c.req.valid('json');
  return c.json({ recoveryCodes: await container.resolve(MfaService).confirmTotpSetup(user.id, code) });
});

authRoutes.use('/me/mfa/recovery-codes', authMiddleware);
authRoutes.use('/me/mfa/recovery-codes', sessionOnly);
authRoutes.use('/me/mfa/recovery-codes', rejectImpersonation);
authRoutes.openapi(regenerateCurrentUserRecoveryCodesRoute, async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const { code } = c.req.valid('json');
  const mfa = container.resolve(MfaService);
  // Shares the step-up failure counter and lockout so this endpoint cannot be
  // used to guess TOTP codes without limit.
  if (!(await mfa.verifyStepUpCode(user.id, c.get('sessionId')!, { totpCode: code })))
    throw new AppError(401, 'INVALID_TOTP_CODE', 'Invalid authentication code');
  return c.json({ recoveryCodes: await mfa.regenerateRecoveryCodes(user.id) });
});

authRoutes.use('/me/mfa/recovery-codes/passkey/*', authMiddleware);
authRoutes.use('/me/mfa/recovery-codes/passkey/*', sessionOnly);
authRoutes.use('/me/mfa/recovery-codes/passkey/*', rejectImpersonation);
authRoutes.post('/me/mfa/recovery-codes/passkey/options', async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  return c.json(await container.resolve(PasskeyService).beginAuthenticationForUser(user.id));
});

authRoutes.post('/me/mfa/recovery-codes/passkey/verify', async (c) => {
  const user = c.get('user')!;
  assertLocalMfaAccount(user);
  const { challenge, response } = PasskeyAuthenticationSchema.parse(await c.req.json());
  const verifiedUser = await container
    .resolve(PasskeyService)
    .verifyAuthentication(challenge, response, user.id, false);
  if (!verifiedUser) throw new AppError(401, 'INVALID_PASSKEY', 'Passkey verification failed');
  return c.json({ recoveryCodes: await container.resolve(MfaService).regenerateRecoveryCodes(user.id) });
});

authRoutes.use('/me/passkeys', authMiddleware);
authRoutes.use('/me/passkeys', sessionOnly);
authRoutes.use('/me/passkeys/*', authMiddleware);
authRoutes.use('/me/passkeys/*', sessionOnly);
authRoutes.get('/me/passkeys', async (c) => {
  const user = c.get('user')!;
  return c.json(await container.resolve(PasskeyService).listPasskeys(user.id));
});

authRoutes.post('/me/passkeys/options', rejectImpersonation, async (c) => {
  const user = c.get('user')!;
  await assertSecondFactorChangeAllowed(c, user);
  return c.json(await container.resolve(PasskeyService).beginRegistration(user));
});

authRoutes.post('/me/passkeys', rejectImpersonation, async (c) => {
  const user = c.get('user')!;
  await assertSecondFactorChangeAllowed(c, user);
  const { response, name } = PasskeyRegistrationSchema.parse(await c.req.json());
  await container.resolve(PasskeyService).finishRegistration(user, response, name ?? 'Passkey');
  return c.json({ ok: true });
});

authRoutes.delete('/me/passkeys/:id', rejectImpersonation, async (c) => {
  const user = c.get('user')!;
  await assertSecondFactorChangeAllowed(c, user);
  if (!(await container.resolve(PasskeyService).removePasskey(user.id, c.req.param('id')!))) {
    throw new AppError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found');
  }
  return c.json({ ok: true });
});

authRoutes.use('/me/sessions', authMiddleware);
authRoutes.use('/me/sessions', sessionOnly);
authRoutes.openapi(listCurrentUserSessionsRoute, async (c) => {
  const sessionId = c.get('sessionId')!;
  const user = c.get('user')!;
  const sessionService = container.resolve(SessionService);
  return c.json(await sessionService.listPublicUserSessions(user.id, sessionId));
});

// OpenAPI routes use `{id}`, while Hono middleware matchers require `:id`.
// Keeping these syntaxes separate ensures revoke requests receive the session
// authentication context before the route handler accesses `user.id`.
authRoutes.use('/me/sessions/:id', authMiddleware);
authRoutes.use('/me/sessions/:id', sessionOnly);
authRoutes.use('/me/sessions/:id', rejectImpersonation);
authRoutes.openapi(revokeCurrentUserSessionRoute, async (c) => {
  const sessionId = c.get('sessionId')!;
  const user = c.get('user')!;
  const sessionService = container.resolve(SessionService);
  const revoked = await sessionService.revokeUserSessionByPublicId(user.id, c.req.param('id')!, {
    excludeSessionId: sessionId,
  });
  if (!revoked) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
  await container.resolve(AuditService).log({
    userId: user.id,
    action: 'auth.session_revoke',
    resourceType: 'session',
    resourceId: c.req.param('id')!,
    details: { selfService: true },
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ message: 'Session revoked' });
});

authRoutes.use('/me/sessions/revoke-others', authMiddleware);
authRoutes.use('/me/sessions/revoke-others', sessionOnly);
authRoutes.use('/me/sessions/revoke-others', rejectImpersonation);
authRoutes.openapi(revokeOtherCurrentUserSessionsRoute, async (c) => {
  const sessionId = c.get('sessionId')!;
  const user = c.get('user')!;
  const sessionService = container.resolve(SessionService);
  const revoked = await sessionService.revokeOtherUserSessions(user.id, sessionId);
  await container.resolve(AuditService).log({
    userId: user.id,
    action: 'auth.session_revoke_others',
    resourceType: 'session',
    details: { selfService: true, revoked },
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ revoked });
});
