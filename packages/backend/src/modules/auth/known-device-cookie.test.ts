import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { container } from '@/container.js';
import { CacheService } from '@/services/cache.service.js';
import { SessionService } from '@/services/session.service.js';
import {
  issueKnownDeviceCookie,
  knownDeviceToken,
  readKnownDevice,
  verifyKnownDeviceToken,
} from './known-device-cookie.js';
import { bumpKnownDeviceEpoch } from './known-device-epoch.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

/** The Redis keys the epoch and the session revocation use. */
function memoryCache() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    incr: async (key: string) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, next);
      return next;
    },
    smembers: async () => [],
    delete: async (key: string) => void values.delete(key),
  };
}

afterEach(() => {
  container.reset();
});

describe('known-device cookie', () => {
  const epochOf = (epoch: number) => async () => epoch;

  it('names the account and device while its signature holds, it has not expired and its epoch is current', async () => {
    const expiresAt = inAnHour();
    const token = knownDeviceToken(USER_ID, 3, expiresAt);
    await expect(verifyKnownDeviceToken(token, epochOf(3))).resolves.toMatchObject({
      userId: USER_ID,
      deviceKey: expect.stringMatching(/^[a-f0-9]{32}$/),
    });

    // A security reset of the account (the epoch moved) ends it.
    await expect(verifyKnownDeviceToken(token, epochOf(4))).resolves.toBeUndefined();

    const [, , , signature] = token.split('.');
    await expect(
      verifyKnownDeviceToken(`22222222-2222-4222-8222-222222222222.3.${expiresAt}.${signature}`, epochOf(3))
    ).resolves.toBeUndefined();
    await expect(verifyKnownDeviceToken(`${USER_ID}.2.${expiresAt}.${signature}`, epochOf(2))).resolves.toBeUndefined();
    await expect(
      verifyKnownDeviceToken(knownDeviceToken(USER_ID, 3, Math.floor(Date.now() / 1000) - 1), epochOf(3))
    ).resolves.toBeUndefined();
    await expect(verifyKnownDeviceToken('garbage', epochOf(0))).resolves.toBeUndefined();
  });

  it('is a __Host- cookie over HTTPS (by the request protocol) and ends when all sessions are revoked', async () => {
    const cache = memoryCache();
    container.registerInstance(CacheService, cache as unknown as CacheService);
    const app = new Hono();
    app.get('/issue', async (c) => {
      await issueKnownDeviceCookie(c, USER_ID);
      return c.text('ok');
    });
    app.get('/read', async (c) => c.text((await readKnownDevice(c))?.userId ?? 'none'));

    // A public URL saying http:// does not matter: the request came over HTTPS (proxy header).
    const issued =
      (
        await app.request('http://opfield.example.com/issue', { headers: { 'X-Forwarded-Proto': 'https' } })
      ).headers.get('set-cookie') ?? '';
    expect(issued).toMatch(/^__Host-opfield_known_device_[a-f0-9]{12}=/);
    expect(issued).toMatch(/HttpOnly/);
    expect(issued).toMatch(/Secure/);
    expect(issued).toMatch(/SameSite=Lax/);
    expect(issued).toMatch(/Max-Age=2592000/);

    const cookie = { Cookie: issued.split(';')[0]!, 'X-Forwarded-Proto': 'https' };
    expect(await (await app.request('http://opfield.example.com/read', { headers: cookie })).text()).toBe(USER_ID);

    await new SessionService(cache as never).destroyAllUserSessions(USER_ID);
    expect(await (await app.request('http://opfield.example.com/read', { headers: cookie })).text()).toBe('none');
  });

  it('is a plain cookie without Secure over plain HTTP', async () => {
    container.registerInstance(CacheService, memoryCache() as unknown as CacheService);
    const app = new Hono();
    app.get('/issue', async (c) => {
      await issueKnownDeviceCookie(c, USER_ID);
      return c.text('ok');
    });
    const issued = (await app.request('http://203.0.113.5:3000/issue')).headers.get('set-cookie') ?? '';
    expect(issued).toMatch(/^opfield_known_device_[a-f0-9]{12}=/);
    expect(issued).not.toMatch(/Secure/);
  });

  it('moves the epoch with each reset', async () => {
    const cache = memoryCache();
    await bumpKnownDeviceEpoch(cache as never, USER_ID);
    await bumpKnownDeviceEpoch(cache as never, USER_ID);
    expect(cache.values.get(`auth:known-device-epoch:${USER_ID}`)).toBe(2);
  });
});
