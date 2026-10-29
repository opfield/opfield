import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { initializeHostCookieSince } from '@/modules/auth/legacy-session-cookie.js';
import { getSessionCookieName } from '@/modules/auth/session-cookie.js';
import { admitWebSocketSessionCookie, getSessionWebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { SessionService } from '@/services/session.service.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

describe('browser WebSocket credentials', () => {
  const allowedOrigin = () => true;

  it('accepts a transport-specific browser session cookie', () => {
    expect(
      getSessionWebSocketCredential(`${getSessionCookieName('http')}=session-1`, 'http://opfield.test', allowedOrigin)
    ).toEqual({ type: 'session', value: 'session-1' });
  });

  it('accepts the plain session_id cookie only from an HTTP or loopback origin (R1-10)', () => {
    expect(getSessionWebSocketCredential('session_id=legacy-session', 'http://opfield.test', allowedOrigin)).toEqual({
      type: 'session',
      value: 'legacy-session',
    });
    expect(getSessionWebSocketCredential('session_id=legacy-session', 'https://localhost:3000', allowedOrigin)).toEqual(
      { type: 'session', value: 'legacy-session', legacy: true }
    );
    expect(getSessionWebSocketCredential('session_id=planted', 'https://opfield.test', allowedOrigin)).toBeNull();
  });

  it('reads only the __Host- cookie from an HTTPS origin while the browser has one (R1-10)', () => {
    const unprefixed = getSessionCookieName('https').replace('__Host-', '');
    const cookieHeader = `${unprefixed}=planted; ${getSessionCookieName('https')}=own-session`;

    expect(getSessionWebSocketCredential(cookieHeader, 'https://opfield.test', allowedOrigin)).toEqual({
      type: 'session',
      value: 'own-session',
    });
    // Marked, so only a session from before the __Host- cookie is accepted through it (L-08).
    expect(getSessionWebSocketCredential(`${unprefixed}=before-upgrade`, 'https://opfield.test', allowedOrigin)).toEqual(
      { type: 'session', value: 'before-upgrade', legacy: true }
    );
  });

  it('prefers the cookie matching the WebSocket origin transport', () => {
    const cookieHeader = `${getSessionCookieName('https')}=stale-session; ${getSessionCookieName('http')}=current-session`;

    expect(getSessionWebSocketCredential(cookieHeader, 'http://opfield.test', allowedOrigin)).toEqual({
      type: 'session',
      value: 'current-session',
    });
  });
});

describe('session cookies of the AI and events WebSockets (L-08)', () => {
  async function useHostCookieSince(since: number) {
    const row = { value: { since: new Date(since).toISOString() } };
    await initializeHostCookieSince({
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    } as never);
  }

  function useSession(createdAt: number) {
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue({ userId: 'u1', createdAt, expiresAt: Date.now() + 60_000 }),
    } as unknown as SessionService);
  }

  afterEach(() => container.reset());

  it('passes a legacy-named cookie only for a session from before the __Host- cookie', async () => {
    await useHostCookieSince(Date.now() - 60_000);
    const legacy = { type: 'session' as const, value: 'session-1', legacy: true as const };

    useSession(Date.now() - 120_000);
    await expect(admitWebSocketSessionCookie(legacy)).resolves.toBe('session-1');

    useSession(Date.now());
    await expect(admitWebSocketSessionCookie(legacy)).resolves.toBe('');
    await expect(admitWebSocketSessionCookie({ type: 'session', value: 'session-2' })).resolves.toBe('session-2');
    await expect(admitWebSocketSessionCookie(null)).resolves.toBe('');
  });
});
