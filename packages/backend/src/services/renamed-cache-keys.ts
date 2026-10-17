import { logger } from '@/lib/logger.js';
import { DOCKER_SNAPSHOT_PREFIX } from '@/modules/docker/docker-snapshot.service.js';
import type { RedisClient } from '@/services/cache.service.js';
import { RESOURCE_SNAPSHOT_PREFIX } from '@/services/resource-snapshot.store.js';
import { LEGACY_DOCKER_SNAPSHOT_CACHE, LEGACY_READ_MODEL_CACHE } from '@/lib/legacy-compat.js';

// legacy-name: Redis cache prefixes written before 2.12.1 — remove once every install has passed 2.12.1
const RENAMED_PREFIXES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [LEGACY_DOCKER_SNAPSHOT_CACHE, DOCKER_SNAPSHOT_PREFIX],
  [LEGACY_READ_MODEL_CACHE, RESOURCE_SNAPSHOT_PREFIX],
];

/** How long the copied-from keys stay, so a rolled-back update still starts with a warm cache. */
const LEGACY_KEY_TTL_SECONDS = 24 * 60 * 60;
const STARTUP_BUDGET_MS = 10_000;

// Copies the key unless the new name already exists, then lets the old key expire (once: an expiry already set stays).
const ADOPT_KEY_SCRIPT = `
local copied = 0
if redis.call('exists', KEYS[2]) == 0 then copied = redis.call('copy', KEYS[1], KEYS[2]) end
if redis.call('ttl', KEYS[1]) == -1 then redis.call('expire', KEYS[1], ARGV[1]) end
return copied`;

async function adopt(redis: RedisClient, deadline: number): Promise<number> {
  let copied = 0;
  for (const [legacy, current] of RENAMED_PREFIXES) {
    let cursor = '0';
    do {
      if (Date.now() > deadline) return copied;
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${legacy}:*`, 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        // A refresh lease belongs to the process that took it; the new name starts without one.
        if (key.endsWith(':lease')) continue;
        const result = await redis.eval(
          ADOPT_KEY_SCRIPT,
          2,
          key,
          `${current}${key.slice(legacy.length)}`,
          String(LEGACY_KEY_TTL_SECONDS)
        );
        if (result === 1) copied += 1;
      }
    } while (cursor !== '0');
  }
  return copied;
}

/**
 * The Docker snapshot and read-model caches moved to Opfield key names. Startup copies what the previous release
 * cached, so lists stay warm across the update; both caches rebuild on a miss, so a copy that fails or runs out of
 * time only costs a refresh.
 */
export async function adoptRenamedCacheKeys(redis: RedisClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = adopt(redis, Date.now() + STARTUP_BUDGET_MS).catch((error: unknown) => {
    logger.warn('Could not copy cached snapshots to their Opfield key names; they rebuild on demand', { error });
    return 0;
  });
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(0), STARTUP_BUDGET_MS + 1_000);
  });
  try {
    const copied = await Promise.race([work, timeout]);
    if (copied > 0) logger.info('Copied cached snapshots to their Opfield key names', { keys: copied });
  } finally {
    clearTimeout(timer);
  }
}
