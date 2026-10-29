import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { SessionData } from '@/types.js';
import type { SelectedSessionCookie } from './session-cookie.js';

const logger = createChildLogger('LegacySessionCookie');

/** When this installation first ran a release that sets the `__Host-` session cookie. Written once, never changed. */
const HOST_COOKIE_SINCE_KEY = 'auth:host_session_cookie_since';

let hostCookieSince: number | null = null;

/**
 * Records the first start of the release with the `__Host-` session cookie (kept if already there) and loads it. Runs
 * at boot before requests are served.
 */
export async function initializeHostCookieSince(db: Pick<DrizzleClient, 'insert' | 'select'>): Promise<void> {
  try {
    await db
      .insert(settings)
      .values({ key: HOST_COOKIE_SINCE_KEY, value: { since: new Date().toISOString() }, updatedAt: new Date() })
      .onConflictDoNothing({ target: settings.key });
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, HOST_COOKIE_SINCE_KEY))
      .limit(1);
    const since = Date.parse(String((row?.value as { since?: unknown } | undefined)?.since ?? ''));
    hostCookieSince = Number.isFinite(since) ? since : null;
  } catch (error) {
    // Without the date no legacy-named cookie is accepted: those browsers sign in again.
    logger.warn('Could not record when the __Host- session cookie was introduced', { error });
    hostCookieSince = null;
  }
}

/**
 * Whether a session may be used through the cookie it arrived under. A cookie under a legacy name (an HTTPS console
 * without the `__Host-` cookie, see selectSessionCookie) carries only sessions created before this installation set
 * `__Host-` cookies: a sibling subdomain can plant a legacy-named cookie, but not one for a session older than that.
 *
 * legacy-name: pre-__Host- session cookie names (unprefixed `opfield_session_*_https`, the http and pre-2.12.1 names,
 * loopback `session_id`) on HTTPS consoles; remove together with their acceptance once sessions created before this
 * release have expired (sessions live at most 365 days, so the release after that).
 */
export function sessionAllowedForCookie(cookie: Pick<SelectedSessionCookie, 'legacy'>, session: SessionData): boolean {
  if (!cookie.legacy) return true;
  return hostCookieSince !== null && session.createdAt < hostCookieSince;
}
