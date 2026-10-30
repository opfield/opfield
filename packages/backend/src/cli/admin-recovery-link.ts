import 'reflect-metadata';
import 'dotenv/config';

import { getEnv } from '@/config/env.js';
import { createDrizzleClient } from '@/db/client.js';
import { issueAdminRecoveryLink } from '@/modules/auth/admin-recovery-link.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CacheService, createRedisClient } from '@/services/cache.service.js';

const USAGE = 'Usage: node dist/cli/admin-recovery-link.js [--email <system administrator email>]';

function emailArgument(args: string[]): string | undefined {
  const [arg, value, ...rest] = args;
  if (arg === undefined) return undefined;
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (arg.startsWith('--email=') && value === undefined) return arg.slice('--email='.length);
  if (arg === '--email' && value && !value.startsWith('--') && rest.length === 0) return value;
  throw new Error(USAGE);
}

/**
 * Prints, as JSON on one line, a one-time link (30 minutes, used once) that signs a system administrator in without
 * their usual sign-in provider or second factor; they land on Profile > Security to fix their sign-in. The sign-in is
 * audited as a recovery sign-in. Default: the owner of the installation; `--email` picks another system administrator.
 */
async function main() {
  const email = emailArgument(process.argv.slice(2));
  const env = getEnv();
  const db = createDrizzleClient(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);
  try {
    const publicUrl = (await new GeneralSettingsService(db).getPublicUrl()) ?? env.APP_URL;
    const link = await issueAdminRecoveryLink(db, new CacheService(redis), publicUrl, email ? { email } : {});
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
