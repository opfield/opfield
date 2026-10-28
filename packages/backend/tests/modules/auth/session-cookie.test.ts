import { describe, expect, it } from 'vitest';
import {
  getAcceptedSessionCookieNames,
  getSessionCookieName,
  getSessionCookieNameForUrl,
  hasInstallationSessionCookie,
  LEGACY_SESSION_COOKIE_NAME,
  selectSessionCookie,
} from '@/modules/auth/session-cookie.js';
import { LEGACY_SESSION_COOKIE_PREFIX } from '@/lib/legacy-compat.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

function cookies(values: Record<string, string>) {
  return (name: string) => values[name];
}

describe('Opfield browser session cookie names', () => {
  it('uses separate per-installation names for HTTP and HTTPS, the HTTPS one __Host- prefixed', () => {
    const httpCookie = getSessionCookieName('http');
    const httpsCookie = getSessionCookieName('https');

    expect(httpCookie).toMatch(/^opfield_session_[a-f0-9]{12}_http$/);
    expect(httpsCookie).toMatch(/^__Host-opfield_session_[a-f0-9]{12}_https$/);
    expect(getSessionCookieNameForUrl('http://opfield.example.test')).toBe(httpCookie);
    expect(getSessionCookieNameForUrl('https://opfield.example.test')).toBe(httpsCookie);
  });

  it('continues to accept the cookies of earlier releases during upgrade', () => {
    const namespace = getSessionCookieName('http').split('_')[2];
    expect(getAcceptedSessionCookieNames()).toEqual([
      getSessionCookieName('https'),
      getSessionCookieName('http'),
      `opfield_session_${namespace}_https`,
      `${LEGACY_SESSION_COOKIE_PREFIX}${namespace}_https`,
      `${LEGACY_SESSION_COOKIE_PREFIX}${namespace}_http`,
      LEGACY_SESSION_COOKIE_NAME,
    ]);
  });

  it('recognizes current and pre-2.12.1 session cookies in a Cookie header', () => {
    expect(hasInstallationSessionCookie(`${getSessionCookieName('https')}=s1`)).toBe(true);
    expect(hasInstallationSessionCookie(`${LEGACY_SESSION_COOKIE_PREFIX}0123456789ab_https=s1`)).toBe(true);
    expect(hasInstallationSessionCookie('session_id=s1')).toBe(false);
    expect(hasInstallationSessionCookie(undefined)).toBe(false);
  });
});

describe('session cookie selection (R1-10)', () => {
  const https = 'https://opfield.example.com';
  const unprefixedHttps = () => getSessionCookieName('https').replace('__Host-', '');

  it('reads only the __Host- cookie over HTTPS while the browser has one', () => {
    const selected = selectSessionCookie(
      cookies({ [unprefixedHttps()]: 'planted', [getSessionCookieName('https')]: 'own', session_id: 'planted' }),
      https
    );
    expect(selected).toEqual({ value: 'own', name: getSessionCookieName('https'), legacy: false });
  });

  it('accepts an older HTTPS cookie only without a __Host- cookie, marked for moving', () => {
    expect(selectSessionCookie(cookies({ [unprefixedHttps()]: 'before-upgrade' }), https)).toEqual({
      value: 'before-upgrade',
      name: unprefixedHttps(),
      legacy: true,
    });
  });

  it('accepts the plain session_id cookie only for an HTTP or loopback console', () => {
    expect(selectSessionCookie(cookies({ session_id: 's1' }), https)).toBeNull();
    expect(selectSessionCookie(cookies({ session_id: 's1' }), 'http://opfield.lan:3000')).toMatchObject({
      value: 's1',
      legacy: false,
    });
    expect(selectSessionCookie(cookies({ session_id: 's1' }), 'https://localhost:3000')).toMatchObject({
      value: 's1',
      legacy: true,
    });
  });

  it('keeps every name over HTTP, preferring the HTTP cookie', () => {
    const selected = selectSessionCookie(
      cookies({ [getSessionCookieName('https')]: 'stale', [getSessionCookieName('http')]: 'current' }),
      'http://opfield.lan'
    );
    expect(selected).toEqual({ value: 'current', name: getSessionCookieName('http'), legacy: false });
  });
});
