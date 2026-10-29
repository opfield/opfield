import type { CacheService } from '@/services/cache.service.js';

/**
 * Every known-device cookie (known-device-cookie.ts) carries its account's epoch. The epoch moves on each security
 * reset of the account: password set or reset and sign-in method change (both revoke all sessions), all sessions or
 * all other sessions revoked, block and MFA reset. That ends every known-device cookie issued before it.
 */
function epochKey(userId: string): string {
  return `auth:known-device-epoch:${userId}`;
}

/** The account's current known-device epoch (0 until the first reset). */
export async function getKnownDeviceEpoch(cache: Pick<CacheService, 'get'>, userId: string): Promise<number> {
  return Number((await cache.get<number>(epochKey(userId))) ?? 0) || 0;
}

/** Ends every known-device cookie of the account. */
export async function bumpKnownDeviceEpoch(cache: Pick<CacheService, 'incr'>, userId: string): Promise<void> {
  await cache.incr(epochKey(userId));
}
