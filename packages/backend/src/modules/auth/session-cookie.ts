import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { getEnv } from '@/config/env.js';
import { container } from '@/container.js';
import { LEGACY_SESSION_COOKIE_PREFIX } from '@/lib/legacy-compat.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';

export const LEGACY_SESSION_COOKIE_NAME = 'session_id';

type SessionCookieTransport = 'http' | 'https';

const HOST_COOKIE_PREFIX = '__Host-';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** APP_URL's default, for isolated callers without a valid environment. */
const DEFAULT_APP_URL = 'http://localhost:3000';

function getInstallationCookieNamespace(): string {
  // The master key is generated per Opfield installation and persists across
  // restarts. Expose only a short one-way namespace, never the key itself.
  return createHash('sha256').update(getEnv().PKI_MASTER_KEY).digest('hex').slice(0, 12);
}

function getUnprefixedSessionCookieName(transport: SessionCookieTransport): string {
  return `opfield_session_${getInstallationCookieNamespace()}_${transport}`;
}

/**
 * The session cookie name this release sets. Over HTTPS it carries the `__Host-` prefix: browsers then keep it only
 * with Secure, Path=/ and no Domain, so a site on a sibling subdomain cannot plant or overwrite it (cookie tossing).
 */
export function getSessionCookieName(transport: SessionCookieTransport): string {
  const name = getUnprefixedSessionCookieName(transport);
  return transport === 'https' ? `${HOST_COOKIE_PREFIX}${name}` : name;
}

// legacy-name: pre-2.12.1 session cookies — browser sessions signed in before 2.12.1 keep working; remove once those
// sessions have expired (the release after 2.12.1).
function getLegacySessionCookieName(transport: SessionCookieTransport): string {
  return `${LEGACY_SESSION_COOKIE_PREFIX}${getInstallationCookieNamespace()}_${transport}`;
}

/** Whether a Cookie header carries a per-installation session cookie (current or pre-2.12.1 name). */
export function hasInstallationSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  // legacy-name: LEGACY_SESSION_COOKIE_PREFIX prefix — see getLegacySessionCookieName.
  return cookieHeader.includes('opfield_session_') || cookieHeader.includes(LEGACY_SESSION_COOKIE_PREFIX);
}

function transportForUrl(url: string): SessionCookieTransport {
  return new URL(url).protocol === 'https:' ? 'https' : 'http';
}

export function getSessionCookieNameForUrl(publicUrl: string): string {
  return getSessionCookieName(transportForUrl(publicUrl));
}

export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_HOSTNAMES.has(new URL(url).hostname);
}

/**
 * Every name a session cookie of this installation may have, current first: the names of both transports, the HTTPS
 * name from before the `__Host-` prefix, the pre-2.12.1 names and the plain `session_id`. Accepting both transport
 * names lets an existing browser session survive a deliberate HTTP/HTTPS setting change.
 */
export function getAcceptedSessionCookieNames(): string[] {
  return [
    getSessionCookieName('https'),
    getSessionCookieName('http'),
    getUnprefixedSessionCookieName('https'),
    getLegacySessionCookieName('https'),
    getLegacySessionCookieName('http'),
    LEGACY_SESSION_COOKIE_NAME,
  ];
}

export interface SelectedSessionCookie {
  value: string;
  name: string;
  /** Read under an older name of an HTTPS console: re-issue it under the current name and clear this one. */
  legacy: boolean;
}

/**
 * The session cookie of a request to a console served from `consoleUrl` (the public URL, or a WebSocket's origin).
 *
 * Over HTTPS only the `__Host-` cookie counts while the browser has one. Any other name is a cookie from an earlier
 * release (or one a sibling subdomain planted) and is read only when the `__Host-` cookie is absent; the caller then
 * moves it under the current name. The plain `session_id` cookie counts only for an HTTP or loopback console. Over
 * HTTP no cookie is protected from sibling hosts, so every name stays accepted as before.
 */
export function selectSessionCookie(
  readCookie: (name: string) => string | undefined,
  consoleUrl: string,
  cookieHeader?: string
): SelectedSessionCookie | null {
  const transport = transportForUrl(consoleUrl);
  const plainAccepted = transport === 'http' || isLoopbackUrl(consoleUrl);
  if (cookieHeader !== undefined && !hasInstallationSessionCookie(cookieHeader)) {
    // No per-installation cookie at all: only the plain one can carry a session.
    const value = plainAccepted ? readCookie(LEGACY_SESSION_COOKIE_NAME) : undefined;
    return value ? { value, name: LEGACY_SESSION_COOKIE_NAME, legacy: transport === 'https' } : null;
  }

  const current = getSessionCookieName(transport);
  const currentValue = readCookie(current);
  if (currentValue) return { value: currentValue, name: current, legacy: false };

  const others = getAcceptedSessionCookieNames().filter(
    (name) => name !== current && name !== LEGACY_SESSION_COOKIE_NAME
  );
  for (const name of plainAccepted ? [LEGACY_SESSION_COOKIE_NAME, ...others] : others) {
    const value = readCookie(name);
    if (value) return { value, name, legacy: transport === 'https' };
  }
  return null;
}

/** The public URL session cookies are set for; APP_URL while none is configured (isolated tests, first run). */
export async function getSessionCookiePublicUrl(): Promise<string> {
  try {
    const publicUrl = await container.resolve(GeneralSettingsService).getPublicUrl();
    if (publicUrl) return publicUrl;
  } catch {
    // Not configured or not readable: the same fallback the sign-in routes use.
  }
  try {
    return getEnv().APP_URL;
  } catch {
    return DEFAULT_APP_URL;
  }
}

/** Moves a session read under a legacy name to the current `__Host-` cookie and clears the legacy one. */
export function reissueLegacySessionCookie(
  c: Context,
  selected: SelectedSessionCookie,
  publicUrl: string,
  expiresAt: number
): void {
  if (!selected.legacy) return;
  setCookie(c, getSessionCookieNameForUrl(publicUrl), selected.value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
    path: '/',
  });
  deleteCookie(c, selected.name, { path: '/' });
}

/** Expires every session cookie name; a `__Host-` cookie can only be cleared with Secure set. */
export function clearSessionCookies(c: Context): void {
  for (const name of getAcceptedSessionCookieNames()) {
    deleteCookie(c, name, name.startsWith(HOST_COOKIE_PREFIX) ? { path: '/', secure: true } : { path: '/' });
  }
}
