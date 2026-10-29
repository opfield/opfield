import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { getClientIpForContext, resolveRequestOriginForContext } from '@/lib/request-ip.js';
import type { TokenRequestContext } from '@/lib/token-limits.js';
import { hasTokenPrefix } from '@/lib/token-prefixes.js';
import { AppError } from '@/middleware/error-handler.js';
import { runWithIdempotency } from '@/middleware/idempotency.js';
import { getAuditRequestContext, setAuditImpersonationContext } from '@/modules/audit/audit-request-context.js';
import { requiresSessionMfaReauthentication, resolveLiveSessionUser } from '@/modules/auth/live-session-user.js';
import { assertDemoRequestAllowed } from '@/modules/demo/demo-mode.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { sessionAllowedForCookie } from './legacy-session-cookie.js';
import {
  LEGACY_SESSION_COOKIE_NAME,
  reissueLegacySessionCookie,
  type SelectedSessionCookie,
  selectSessionCookie,
} from './session-cookie.js';

const SESSION_COOKIE_NAME = LEGACY_SESSION_COOKIE_NAME;
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type CredentialType = 'session' | 'api-token' | 'oauth-token';

type AuthenticatedBearer = {
  type: Exclude<CredentialType, 'session'>;
  user: User;
  scopes: string[];
  tokenId: string;
  tokenPrefix: string;
  clientId?: string;
};

type RequestCredential =
  | { type: Exclude<CredentialType, 'session'>; value: string }
  | { type: 'session'; value: string; cookie: SelectedSessionCookie };

async function extractCredential(c: Context<AppEnv>): Promise<RequestCredential | null> {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const value = authHeader.slice(7).trim();
    if (hasTokenPrefix(value, 'api')) {
      return { type: 'api-token', value };
    }
    if (hasTokenPrefix(value, 'oauthAccess')) {
      return { type: 'oauth-token', value };
    }
  }

  const cookieHeader = c.req.header('Cookie');
  if (!cookieHeader) return null;
  const cookie = selectSessionCookie(
    (name) => getCookie(c, name),
    await resolveRequestOriginForContext(c),
    cookieHeader
  );
  return cookie ? { type: 'session', value: cookie.value, cookie } : null;
}

/**
 * The session a cookie credential names, or null. A legacy-named cookie only carries a session from before the
 * `__Host-` cookie (sessionAllowedForCookie); anything else under that name is treated as no session.
 */
async function getCredentialSession(
  credential: Extract<RequestCredential, { type: 'session' }>
): Promise<SessionData | null> {
  const session = await container.resolve(SessionService).getSession(credential.value);
  return session && sessionAllowedForCookie(credential.cookie, session) ? session : null;
}

/** A session that arrived under a legacy cookie name continues under the current one (see selectSessionCookie). */
function moveLegacySessionCookie(c: Context<AppEnv>, credential: RequestCredential, session: SessionData): void {
  if (credential.type !== 'session') return;
  reissueLegacySessionCookie(c, credential.cookie, session.expiresAt);
}

function requiresCsrf(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

const SETUP_PURPOSE_PATHS = [
  '/auth/csrf',
  '/api/ai/config',
  '/api/ai/status',
  '/api/inference/core',
  '/api/inference/providers',
  '/api/inference/models',
  '/api/inference/limits',
  '/api/admin/auth-settings',
] as const;

function isSetupPurposePath(path: string): boolean {
  return SETUP_PURPOSE_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

async function validateSetupPurposeSession(session: SessionData, path: string): Promise<boolean> {
  return Boolean(
    session.purpose === 'setup' &&
      session.setupSessionId &&
      isSetupPurposePath(path) &&
      (await container.resolve(SetupAccessService).validateSession(session.setupSessionId))
  );
}

export async function isAdmittedSetupPurposeRequest(c: Context<AppEnv>): Promise<boolean> {
  const credential = await extractCredential(c);
  if (!credential || credential.type !== 'session') return false;
  const session = credential.type === 'session' ? await getCredentialSession(credential) : null;
  if (!session) return false;
  return validateSetupPurposeSession(session, new URL(c.req.url).pathname);
}

function allowsBlockedSessionPath(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  return path === '/auth/csrf' || path === '/auth/me' || path === '/auth/logout';
}

function allowsImpersonationRecoveryPath(c: Context<AppEnv>): boolean {
  const path = new URL(c.req.url).pathname;
  return path === '/auth/csrf' || path === '/auth/me' || path === '/auth/logout' || path === '/auth/impersonation/stop';
}

/**
 * Validates an API or OAuth bearer token for a request from `context.clientIp`: an expired token, or one limited to
 * other addresses, is refused like a revoked one.
 */
export async function authenticateBearerToken(
  rawToken: string,
  context: TokenRequestContext = {}
): Promise<AuthenticatedBearer | null> {
  if (hasTokenPrefix(rawToken, 'api')) {
    const tokensService = container.resolve(TokensService);
    const result = await tokensService.validateToken(rawToken, context);
    if (!result) return null;
    return {
      type: 'api-token',
      user: result.user,
      scopes: result.scopes,
      tokenId: result.tokenId,
      tokenPrefix: result.tokenPrefix,
    };
  }

  if (hasTokenPrefix(rawToken, 'oauthAccess')) {
    const oauthService = container.resolve(OAuthService);
    const result = await oauthService.validateAccessToken(rawToken, {
      resource: oauthService.getApiResourceUrl(),
      clientIp: context.clientIp,
    });
    if (!result) return null;
    return {
      type: 'oauth-token',
      user: result.user,
      scopes: result.scopes,
      tokenId: result.tokenId,
      tokenPrefix: result.tokenPrefix,
      clientId: result.clientId,
    };
  }

  return null;
}

function applyBearerContext(c: Context<AppEnv>, result: AuthenticatedBearer): void {
  c.set('user', result.user);
  c.set('effectiveScopes', result.scopes);
  c.set('isTokenAuth', true);
  c.set('authType', result.type);
  c.set('authTokenId', result.tokenId);
}

/**
 * The ID of the live browser session a request carries, or null (no session cookie, an expired or unknown session, or
 * a bearer token). The API rate limit counts signed-in browser sessions per session; it is not authentication.
 */
export async function liveRequestSessionId(c: Context<AppEnv>): Promise<string | null> {
  const credential = await extractCredential(c);
  if (credential?.type !== 'session') return null;
  const session = credential.type === 'session' ? await getCredentialSession(credential) : null;
  return session && session.purpose !== 'setup' ? credential.value : null;
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credential = await extractCredential(c);

  if (!credential) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }

  if (credential.type === 'api-token' || credential.type === 'oauth-token') {
    const result = await authenticateBearerToken(credential.value, { clientIp: await getClientIpForContext(c) });
    if (!result) {
      throw new HTTPException(401, { message: 'Invalid or expired bearer token' });
    }
    applyBearerContext(c, result);
    assertDemoRequestAllowed(c);
  } else {
    const sessionService = container.resolve(SessionService);
    const session = credential.type === 'session' ? await getCredentialSession(credential) : null;
    if (!session) {
      throw new HTTPException(401, { message: 'Invalid or expired session' });
    }
    if (session.purpose === 'setup') {
      const validSetupSession = await validateSetupPurposeSession(session, new URL(c.req.url).pathname);
      if (!validSetupSession) {
        await sessionService.destroySession(credential.value);
        throw new HTTPException(401, { message: 'Invalid or expired setup session' });
      }
    }
    const resolved = await resolveLiveSessionUser(credential.value, session);
    if (!resolved) {
      if (session.purpose !== 'impersonation') {
        await sessionService.destroySession(credential.value);
      }
      throw new HTTPException(401, { message: 'Invalid or expired session' });
    }
    const { user } = resolved;
    if (!resolved.impersonation && requiresSessionMfaReauthentication(user, session)) {
      await sessionService.destroySession(credential.value);
      throw new HTTPException(401, { message: 'MFA sign-in required' });
    }
    if (user.isBlocked && !allowsBlockedSessionPath(c)) {
      throw new HTTPException(403, { message: 'Account is blocked' });
    }
    if (resolved.impersonation && !resolved.impersonation.authorized && !allowsImpersonationRecoveryPath(c)) {
      throw new HTTPException(403, { message: 'Impersonation authorization changed' });
    }
    if (
      requiresCsrf(c.req.method) &&
      !(await sessionService.validateCsrfToken(credential.value, c.req.header(CSRF_HEADER_NAME), session))
    ) {
      throw new HTTPException(403, { message: 'Invalid CSRF token' });
    }

    c.set('user', user);
    c.set('sessionId', credential.value);
    c.set('effectiveScopes', resolved.effectiveScopes);
    if (resolved.impersonation) {
      c.set('impersonation', resolved.impersonation);
      setAuditImpersonationContext({
        actorUserId: resolved.impersonation.actor.id,
        subjectUserId: user.id,
        subjectEmail: user.email,
        subjectName: user.name,
      });
    }
    c.set('isTokenAuth', false);
    c.set('authType', 'session');
    assertDemoRequestAllowed(c);
    moveLegacySessionCookie(c, credential, session);
    const requestContext = getAuditRequestContext();
    await sessionService.updateSession(credential.value, {
      user,
      ...(requestContext?.ipAddress ? { ipAddress: requestContext.ipAddress } : {}),
      ...(requestContext?.userAgent ? { userAgent: requestContext.userAgent } : {}),
    });
    if (session.purpose !== 'setup') {
      sessionService.touchSession?.(credential.value).catch(() => {});
      sessionService.refreshSession(credential.value).catch(() => {});
    }
  }

  // Idempotency-Key is scoped to the principal, so it applies once authentication succeeded.
  return runWithIdempotency(c, next);
};

export const optionalAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credential = await extractCredential(c);

  if (credential) {
    if (credential.type === 'api-token' || credential.type === 'oauth-token') {
      const result = await authenticateBearerToken(credential.value, { clientIp: await getClientIpForContext(c) });
      if (result) {
        applyBearerContext(c, result);
      }
    } else {
      const sessionService = container.resolve(SessionService);
      const session = credential.type === 'session' ? await getCredentialSession(credential) : null;
      if (session) {
        if (session.purpose === 'setup') {
          const validSetupSession = await validateSetupPurposeSession(session, new URL(c.req.url).pathname);
          if (!validSetupSession) {
            await sessionService.destroySession(credential.value);
            await next();
            return;
          }
        }
        const resolved = await resolveLiveSessionUser(credential.value, session);
        const user = resolved?.user;
        if (!resolved || !user) {
          if (session.purpose !== 'impersonation') {
            await sessionService.destroySession(credential.value);
          }
        } else if (!resolved.impersonation && requiresSessionMfaReauthentication(user, session)) {
          await sessionService.destroySession(credential.value);
        } else {
          c.set('user', user);
          c.set('sessionId', credential.value);
          c.set('effectiveScopes', resolved.effectiveScopes);
          if (resolved.impersonation) {
            c.set('impersonation', resolved.impersonation);
            setAuditImpersonationContext({
              actorUserId: resolved.impersonation.actor.id,
              subjectUserId: user.id,
              subjectEmail: user.email,
              subjectName: user.name,
            });
          }
          c.set('isTokenAuth', false);
          c.set('authType', 'session');
          moveLegacySessionCookie(c, credential, session);
          sessionService.updateSession(credential.value, { user }).catch(() => {});
          if (session.purpose !== 'setup') {
            sessionService.touchSession?.(credential.value, session).catch(() => {});
            sessionService.refreshSession(credential.value, session).catch(() => {});
          }
        }
      }
    }
  }

  await next();
};

/**
 * Middleware that rejects blocked users. Apply to all API routes
 * except /auth/me and /auth/logout (which must remain accessible
 * so the frontend can detect blocked status and log out).
 */
export const requireActiveUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (user?.isBlocked) {
    throw new HTTPException(403, { message: 'Account is blocked' });
  }
  await next();
};

/**
 * Unified scope-based permission middleware.
 * Fires for BOTH session users and API token users.
 * Session users' scopes combine their permission group with user-specific additional permissions.
 * Token users' scopes are bounded by both the token and the owner's current effective permissions.
 */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes');
    if (!scopes || !TokensService.hasScope(scopes, scope)) {
      throw new HTTPException(403, { message: `Missing required scope: ${scope}` });
    }
    await next();
  };
}

export function requireScopeBase(scopeBase: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes');
    if (!scopes || !hasScopeBase(scopes, scopeBase)) {
      throw new HTTPException(403, { message: `Missing required scope: ${scopeBase}` });
    }
    await next();
  };
}

/** Require a broad scope or any resource-scoped variant of at least one base scope. */
export function requireAnyScopeBase(...scopeBases: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes');
    if (!scopes || !scopeBases.some((scopeBase) => hasScopeBase(scopes, scopeBase))) {
      throw new HTTPException(403, { message: `Missing required scope: one of ${scopeBases.join(', ')}` });
    }
    await next();
  };
}

/**
 * Require ANY of the listed scopes (OR logic).
 * Useful when a route should be accessible to users with different scope hierarchies.
 */
export function requireAnyScope(...requiredScopes: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes');
    if (!scopes || !requiredScopes.some((s) => TokensService.hasScope(scopes, s))) {
      throw new HTTPException(403, { message: `Missing required scope: one of ${requiredScopes.join(', ')}` });
    }
    await next();
  };
}

/**
 * Resource-scoped permission check.
 * Builds scopeBase:resourceId from a URL param and checks against effective scopes.
 */
export function requireScopeForResource(scopeBase: string, paramName: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resourceId = c.req.param(paramName);
    const scopes = c.get('effectiveScopes');
    const fullScope = resourceId ? `${scopeBase}:${resourceId}` : scopeBase;
    if (!scopes || !TokensService.hasScope(scopes, fullScope)) {
      throw new HTTPException(403, { message: `Missing required scope: ${fullScope}` });
    }
    await next();
  };
}

/**
 * Account-level baseline gate (for example `feat:ai:use` in front of inference administration) for
 * routes that carry their own delegated scope checks. Bearer callers are checked against the owning
 * account's live permissions, so a token does not have to carry the baseline scope itself: it still
 * needs each route's own scope and can never reach more than its owner can in the browser.
 */
export function requireAccountScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = isProgrammaticAuth(c) ? c.get('user')?.scopes : c.get('effectiveScopes');
    if (!scopes || !TokensService.hasScope(scopes, scope)) {
      throw new HTTPException(403, { message: `Missing required scope: ${scope}` });
    }
    await next();
  };
}

/**
 * Middleware that restricts access to session-authenticated users only.
 * Reserved for browser/identity-bound routes (login, MFA, passkeys, own sessions, impersonation,
 * OAuth consent, token management, AI chat, UI bootstrap). Resource and management routes accept
 * API and OAuth tokens and rely on their scope checks instead.
 */
export const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('authType') !== 'session') {
    throw new HTTPException(403, {
      message: 'This endpoint requires browser session authentication.',
    });
  }
  await next();
};

export const requireBrowserSession = sessionOnly;

export const IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN = 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN';

/**
 * Impersonation lets an administrator act as another user for the lifetime of
 * that session only. Anything that outlives the session (tokens, passkeys,
 * TOTP factors, recovery codes) or ends the subject's own sessions is refused.
 */
export function assertNotImpersonating(
  c: Context<AppEnv>,
  message = 'This action is unavailable while impersonating'
): void {
  if (c.get('impersonation')) {
    throw new AppError(403, IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN, message);
  }
}

export const rejectImpersonation: MiddlewareHandler<AppEnv> = async (c, next) => {
  assertNotImpersonating(c);
  await next();
};

export function isProgrammaticAuth(c: Context<AppEnv>): boolean {
  return c.get('authType') === 'api-token' || c.get('authType') === 'oauth-token';
}

export { CSRF_HEADER_NAME, SESSION_COOKIE_NAME };
