import { container } from '@/container.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { hasTokenPrefix } from '@/lib/token-prefixes.js';
import { authenticateBearerToken } from '@/modules/auth/auth.middleware.js';
import { requiresSessionMfaReauthentication, resolveLiveSessionUser } from '@/modules/auth/live-session-user.js';
import { isDemoRealtimeCapabilityAllowed } from '@/modules/demo/demo-mode.js';
import { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';
import { sessionAllowedForCookie } from './legacy-session-cookie.js';
import { selectSessionCookie } from './session-cookie.js';

export type WebSocketCredential =
  | {
      type: 'session';
      value: string;
      /** Read under a legacy cookie name: only a session from before the `__Host-` cookie counts. */
      legacy?: true;
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

/**
 * The browser session of a WebSocket upgrade from an allowed origin. The origin is the console the page was loaded
 * from, so it decides the cookie names that count, the same way the public URL does for HTTP requests. A cookie under a
 * legacy name is accepted here and moved to the current name by the next HTTP request.
 */
export function getSessionWebSocketCredential(
  cookieHeader: string | undefined,
  origin: string | undefined,
  isAllowedOrigin: (origin: string | undefined) => boolean
): WebSocketCredential | null {
  if (!isAllowedOrigin(origin)) return null;
  let consoleUrl = 'http://localhost';
  try {
    if (origin) consoleUrl = new URL(origin).origin;
  } catch {
    return null;
  }
  const cookie = selectSessionCookie(
    (name) => getCookieValue(cookieHeader, name) || undefined,
    consoleUrl,
    cookieHeader ?? ''
  );
  if (!cookie) return null;
  return cookie.legacy
    ? { type: 'session', value: cookie.value, legacy: true }
    : { type: 'session', value: cookie.value };
}

/**
 * The session id of a WebSocket's session cookie for endpoints that authenticate by id (AI Workspace, events): ''
 * when there is none, or when it came under a legacy cookie name and its session is not from before the `__Host-`
 * cookie (sessionAllowedForCookie).
 */
export async function admitWebSocketSessionCookie(credential: WebSocketCredential | null): Promise<string> {
  if (credential?.type !== 'session') return '';
  if (!credential.legacy) return credential.value;
  const session = await container.resolve(SessionService).getSession(credential.value);
  return session && sessionAllowedForCookie({ legacy: true }, session) ? credential.value : '';
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
  const legacyCookie = credential.type === 'session' && credential.legacy === true;
  const result =
    credential.type === 'session'
      ? await resolveLiveSessionUser(credential.value).then((value) => {
          if (
            !value ||
            !sessionAllowedForCookie({ legacy: legacyCookie }, value.session) ||
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
