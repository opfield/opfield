import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  issueKnownDeviceCookie,
  knownDeviceToken,
  readKnownDeviceUserId,
  verifyKnownDeviceToken,
} from './known-device-cookie.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

describe('known-device cookie', () => {
  it('names the account it was issued for while its signature holds and it has not expired', () => {
    const expiresAt = inAnHour();
    expect(verifyKnownDeviceToken(knownDeviceToken(USER_ID, expiresAt))).toBe(USER_ID);

    const [, , signature] = knownDeviceToken(USER_ID, expiresAt).split('.');
    expect(verifyKnownDeviceToken(`22222222-2222-4222-8222-222222222222.${expiresAt}.${signature}`)).toBeUndefined();
    expect(verifyKnownDeviceToken(`${USER_ID}.${expiresAt + 1}.${signature}`)).toBeUndefined();
    expect(verifyKnownDeviceToken(knownDeviceToken(USER_ID, Math.floor(Date.now() / 1000) - 1))).toBeUndefined();
    expect(verifyKnownDeviceToken(undefined)).toBeUndefined();
    expect(verifyKnownDeviceToken('garbage')).toBeUndefined();
  });

  it('is set httpOnly, SameSite=Lax, for 30 days, Secure over HTTPS, and read back from the request', async () => {
    const app = new Hono();
    app.get('/issue', (c) => {
      issueKnownDeviceCookie(c, USER_ID, true);
      return c.text('ok');
    });
    app.get('/read', (c) => c.text(readKnownDeviceUserId(c) ?? 'none'));

    const issued = (await app.request('/issue')).headers.get('set-cookie') ?? '';
    expect(issued).toMatch(/HttpOnly/);
    expect(issued).toMatch(/Secure/);
    expect(issued).toMatch(/SameSite=Lax/);
    expect(issued).toMatch(/Max-Age=2592000/);

    const cookie = issued.split(';')[0]!;
    expect(await (await app.request('/read', { headers: { Cookie: cookie } })).text()).toBe(USER_ID);
    expect(await (await app.request('/read')).text()).toBe('none');
  });
});
