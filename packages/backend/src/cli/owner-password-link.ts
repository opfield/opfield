import 'reflect-metadata';
import 'dotenv/config';

import { getEnv } from '@/config/env.js';
import { createDrizzleClient } from '@/db/client.js';
import { issueOwnerPasswordLink } from '@/modules/configuration-transfer/owner-password-link.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CacheService, createRedisClient } from '@/services/cache.service.js';

/**
 * Prints a one-time link (24 h) that sets the owner's password, as JSON on one line. The installer runs it after
 * restoring an export of a managed cloud installation; run it again for a new link.
 */
async function main() {
  const env = getEnv();
  const db = createDrizzleClient(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);
  try {
    const publicUrl = (await new GeneralSettingsService(db).getPublicUrl()) ?? env.APP_URL;
    const link = await issueOwnerPasswordLink(db, new CacheService(redis), publicUrl);
    process.stdout.write(`${JSON.stringify(link)}\n`);
  } finally {
    await redis.quit();
    await db.$client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
