import { describe, expect, it } from 'vitest';
import {
  getAcceptedSessionCookieNames,
  getSessionCookieName,
  getSessionCookieNameForUrl,
  hasInstallationSessionCookie,
  LEGACY_SESSION_COOKIE_NAME,
} from '@/modules/auth/session-cookie.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

describe('Opfield browser session cookie names', () => {
  it('uses separate per-installation names for HTTP and HTTPS', () => {
    const httpCookie = getSessionCookieName('http');
    const httpsCookie = getSessionCookieName('https');

    expect(httpCookie).toMatch(/^opfield_session_[a-f0-9]{12}_http$/);
    expect(httpsCookie).toMatch(/^opfield_session_[a-f0-9]{12}_https$/);
    expect(httpCookie).not.toBe(httpsCookie);
    expect(getSessionCookieNameForUrl('http://gateway.example.test')).toBe(httpCookie);
    expect(getSessionCookieNameForUrl('https://gateway.example.test')).toBe(httpsCookie);
  });

  it('continues to accept the legacy cookie during upgrade', () => {
    const namespace = getSessionCookieName('https').split('_')[2];
    expect(getAcceptedSessionCookieNames()).toEqual([
      getSessionCookieName('https'),
      getSessionCookieName('http'),
      `gateway_session_${namespace}_https`,
      `gateway_session_${namespace}_http`,
      LEGACY_SESSION_COOKIE_NAME,
    ]);
  });

  it('recognizes current and pre-2.12.1 session cookies in a Cookie header', () => {
    expect(hasInstallationSessionCookie(`${getSessionCookieName('https')}=s1`)).toBe(true);
    expect(hasInstallationSessionCookie('gateway_session_0123456789ab_https=s1')).toBe(true);
    expect(hasInstallationSessionCookie('session_id=s1')).toBe(false);
    expect(hasInstallationSessionCookie(undefined)).toBe(false);
  });
});
