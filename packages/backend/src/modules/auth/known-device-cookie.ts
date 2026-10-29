import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { getEnv } from '@/config/env.js';

/**
 * A browser that signed in to an account before: a signed cookie naming the account, so the account-wide sign-in lock
 * (AccountSignInThrottle) does not keep the owner's own browsers out. It grants no access by itself.
 */
const KNOWN_DEVICE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function cookieName(): string {
  // Per installation, like the session cookies, without exposing the master key.
  return `opfield_known_device_${createHash('sha256').update(getEnv().PKI_MASTER_KEY).digest('hex').slice(0, 12)}`;
}

function sign(userId: string, expiresAt: number): string {
  return createHmac('sha256', `opfield-known-device:${getEnv().PKI_MASTER_KEY}`)
    .update(`${userId}.${expiresAt}`)
    .digest('base64url');
}

/** The cookie value for `userId`, valid until `expiresAt` (seconds since the epoch). */
export function knownDeviceToken(userId: string, expiresAt: number): string {
  return `${userId}.${expiresAt}.${sign(userId, expiresAt)}`;
}

/** The account a known-device cookie value names, when its signature is valid and it has not expired. */
export function verifyKnownDeviceToken(value: string | undefined, now = Date.now()): string | undefined {
  const [userId, expiresAtRaw, signature, ...rest] = value?.split('.') ?? [];
  if (!userId || !expiresAtRaw || !signature || rest.length > 0) return undefined;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= now) return undefined;
  const expected = Buffer.from(sign(userId, expiresAt));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? userId : undefined;
}

/** Marks this browser as a known device of `userId` after a successful sign-in, for 30 days. */
export function issueKnownDeviceCookie(c: Context, userId: string, secure: boolean): void {
  const expiresAt = Math.floor(Date.now() / 1000) + KNOWN_DEVICE_MAX_AGE_SECONDS;
  setCookie(c, cookieName(), knownDeviceToken(userId, expiresAt), {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAge: KNOWN_DEVICE_MAX_AGE_SECONDS,
    path: '/',
  });
}

/** The account this browser is a known device of, if it carries a valid known-device cookie. */
export function readKnownDeviceUserId(c: Context): string | undefined {
  try {
    return verifyKnownDeviceToken(getCookie(c, cookieName()));
  } catch {
    return undefined;
  }
}
