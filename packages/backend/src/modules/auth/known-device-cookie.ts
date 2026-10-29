import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { getEnv } from '@/config/env.js';
import { container } from '@/container.js';
import { CacheService } from '@/services/cache.service.js';
import { getKnownDeviceEpoch } from './known-device-epoch.js';
import { isHttpsCookieRequest } from './session-cookie.js';

/**
 * A browser that signed in to an account before: a signed cookie naming the account, so the account-wide sign-in lock
 * (AccountSignInThrottle) does not keep the owner's own browsers out. It grants no access by itself.
 * Each token carries the account's known-device epoch (known-device-epoch.ts), so a security reset of the account
 * ends it.
 */
const KNOWN_DEVICE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function cookieName(https: boolean): string {
  // Per installation, like the session cookies, without exposing the master key; __Host- over HTTPS.
  const name = `opfield_known_device_${createHash('sha256').update(getEnv().PKI_MASTER_KEY).digest('hex').slice(0, 12)}`;
  return https ? `__Host-${name}` : name;
}

function sign(userId: string, epoch: number, expiresAt: number): string {
  return createHmac('sha256', `opfield-known-device:${getEnv().PKI_MASTER_KEY}`)
    .update(`${userId}.${epoch}.${expiresAt}`)
    .digest('base64url');
}

/** The cookie value for `userId` at `epoch`, valid until `expiresAt` (seconds since the epoch). */
export function knownDeviceToken(userId: string, epoch: number, expiresAt: number): string {
  return `${userId}.${epoch}.${expiresAt}.${sign(userId, epoch, expiresAt)}`;
}

export interface KnownDevice {
  userId: string;
  /** Names this one token (one browser), for the per-device attempt limit. */
  deviceKey: string;
}

/**
 * The account and device a known-device cookie value names, when its signature holds, it has not expired and it was
 * issued at the account's current epoch.
 */
export async function verifyKnownDeviceToken(
  value: string | undefined,
  currentEpoch: (userId: string) => Promise<number>,
  now = Date.now()
): Promise<KnownDevice | undefined> {
  const [userId, epochRaw, expiresAtRaw, signature, ...rest] = value?.split('.') ?? [];
  if (!userId || !epochRaw || !expiresAtRaw || !signature || rest.length > 0) return undefined;
  const epoch = Number(epochRaw);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(epoch) || !Number.isInteger(expiresAt) || expiresAt * 1000 <= now) return undefined;
  const expected = Buffer.from(sign(userId, epoch, expiresAt));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  if ((await currentEpoch(userId)) !== epoch) return undefined;
  return { userId, deviceKey: createHash('sha256').update(signature).digest('hex').slice(0, 32) };
}

/** Marks this browser as a known device of `userId` after a successful sign-in, for 30 days. */
export async function issueKnownDeviceCookie(c: Context, userId: string): Promise<void> {
  let epoch: number;
  try {
    epoch = await getKnownDeviceEpoch(container.resolve(CacheService), userId);
  } catch {
    // The cookie only relaxes the account-wide lock: without the epoch the sign-in goes on without it.
    return;
  }
  const expiresAt = Math.floor(Date.now() / 1000) + KNOWN_DEVICE_MAX_AGE_SECONDS;
  const https = isHttpsCookieRequest(c);
  setCookie(c, cookieName(https), knownDeviceToken(userId, epoch, expiresAt), {
    httpOnly: true,
    secure: https,
    sameSite: 'Lax',
    maxAge: KNOWN_DEVICE_MAX_AGE_SECONDS,
    path: '/',
  });
}

/** The account (and device) this browser is a known device of, if it carries a valid known-device cookie. */
export async function readKnownDevice(c: Context): Promise<KnownDevice | undefined> {
  try {
    const value = getCookie(c, cookieName(isHttpsCookieRequest(c)));
    if (!value) return undefined;
    const cache = container.resolve(CacheService);
    return await verifyKnownDeviceToken(value, (userId) => getKnownDeviceEpoch(cache, userId));
  } catch {
    return undefined;
  }
}
