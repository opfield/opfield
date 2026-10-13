import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { hasTokenPrefix } from '@/lib/token-prefixes.js';
import { authenticateBearerToken } from '@/modules/auth/auth.middleware.js';
import { requiresSessionMfaReauthentication, resolveLiveSessionUser } from '@/modules/auth/live-session-user.js';
import { isDemoRealtimeCapabilityAllowed } from '@/modules/demo/demo-mode.js';
import type { User } from '@/types.js';
import {
  getAcceptedSessionCookieNames,
  getSessionCookieNameForUrl,
  hasInstallationSessionCookie,
  LEGACY_SESSION_COOKIE_NAME,
} from './session-cookie.js';

export type WebSocketCredential =
  | {
      type: 'session';
      value: string;
    }
  | {
      type: 'bearer';
      value: string;
      /** The client address of the upgrade request, resolved when it arrived (token address limits). */
      clientIp?: Promise<string | undefined>;
    };

export type WebSocketAuthResult = {
  user: User;
  scopes: string[];
  impersonation?: {
    actor: User;
    subject: User;
  };
};

export function getCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return rawValue.join('=');
  }
  return '';
}

export function getBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader?.startsWith('Bearer ')) return '';
  const token = authorizationHeader.slice(7).trim();
  return hasTokenPrefix(token, 'api') || hasTokenPrefix(token, 'oauthAccess') ? token : '';
}

export function getSessionWebSocketCredential(
  cookieHeader: string | undefined,
  origin: string | undefined,
  isAllowedOrigin: (origin: string | undefined) => boolean
): WebSocketCredential | null {
  if (!isAllowedOrigin(origin)) return null;
  if (hasInstallationSessionCookie(cookieHeader)) {
    const preferredCookieName = origin ? getSessionCookieNameForUrl(origin) : null;
    if (preferredCookieName) {
      const preferredSessionId = getCookieValue(cookieHeader, preferredCookieName);
      if (preferredSessionId) return { type: 'session', value: preferredSessionId };
    }

    const legacySessionId = getCookieValue(cookieHeader, LEGACY_SESSION_COOKIE_NAME);
    if (legacySessionId) return { type: 'session', value: legacySessionId };

    for (const cookieName of getAcceptedSessionCookieNames()) {
      if (cookieName === preferredCookieName || cookieName === LEGACY_SESSION_COOKIE_NAME) continue;
      const sessionId = getCookieValue(cookieHeader, cookieName);
      if (sessionId) return { type: 'session', value: sessionId };
    }
  }
  const legacySessionId = getCookieValue(cookieHeader, LEGACY_SESSION_COOKIE_NAME);
  if (legacySessionId) return { type: 'session', value: legacySessionId };
  return null;
}

export function getProgrammaticWebSocketCredential(
  cookieHeader: string | undefined,
  origin: string | undefined,
  authorizationHeader: string | undefined,
  isAllowedOrigin: (origin: string | undefined) => boolean,
  resolveClientIp?: () => Promise<string | undefined>
): WebSocketCredential | null {
  const bearerToken = getBearerToken(authorizationHeader);
  if (bearerToken) {
    // Read while the upgrade request is at hand; a token limited to addresses is checked against it.
    const clientIp = resolveClientIp?.().catch(() => undefined);
    return { type: 'bearer', value: bearerToken, ...(clientIp ? { clientIp } : {}) };
  }
  return getSessionWebSocketCredential(cookieHeader, origin, isAllowedOrigin);
}

export async function resolveWebSocketCredential(
  credential: WebSocketCredential | null,
  requiredScope: string
): Promise<WebSocketAuthResult | null> {
  const result = await resolveWebSocketCredentialContext(credential);
  if (result && !isDemoRealtimeCapabilityAllowed(result.user, result.scopes, requiredScope)) return null;
  if (!result || !hasScope(result.scopes, requiredScope)) return null;
  return result;
}

export async function resolveWebSocketCredentialForScopeBase(
  credential: WebSocketCredential | null,
  requiredScopeBase: string
): Promise<WebSocketAuthResult | null> {
  const result = await resolveWebSocketCredentialContext(credential);
  if (result && !isDemoRealtimeCapabilityAllowed(result.user, result.scopes, requiredScopeBase)) return null;
  if (!result || !hasScopeBase(result.scopes, requiredScopeBase)) return null;
  return result;
}

export async function resolveWebSocketCredentialContext(
  credential: WebSocketCredential | null
): Promise<WebSocketAuthResult | null> {
  if (!credential) return null;
  const result =
    credential.type === 'session'
      ? await resolveLiveSessionUser(credential.value).then((value) => {
          if (
            !value ||
            value.session.purpose === 'setup' ||
            (value.impersonation && !value.impersonation.authorized) ||
            (!value.impersonation && requiresSessionMfaReauthentication(value.user, value.session))
          ) {
            return null;
          }
          return {
            user: value.user,
            scopes: value.effectiveScopes,
            impersonation: value.impersonation,
          };
        })
      : await authenticateBearerToken(credential.value, { clientIp: await credential.clientIp });
  if (!result || result.user.isBlocked) return null;
  return {
    user: result.user,
    scopes: result.scopes,
    ...('impersonation' in result && result.impersonation ? { impersonation: result.impersonation } : {}),
  };
}
