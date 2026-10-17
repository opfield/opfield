import { describe, expect, it } from 'vitest';
import { getSessionCookieName } from '@/modules/auth/session-cookie.js';
import { getSessionWebSocketCredential } from '@/modules/auth/websocket-auth.js';

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

  it('continues to accept legacy browser session cookies', () => {
    expect(getSessionWebSocketCredential('session_id=legacy-session', 'https://opfield.test', allowedOrigin)).toEqual({
      type: 'session',
      value: 'legacy-session',
    });
  });

  it('prefers the cookie matching the WebSocket origin transport', () => {
    const cookieHeader = `${getSessionCookieName('https')}=stale-session; ${getSessionCookieName('http')}=current-session`;

    expect(getSessionWebSocketCredential(cookieHeader, 'http://opfield.test', allowedOrigin)).toEqual({
      type: 'session',
      value: 'current-session',
    });
  });
});
