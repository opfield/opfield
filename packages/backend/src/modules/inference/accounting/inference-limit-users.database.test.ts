import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { InferenceBudgetPolicyService } from './inference-budget-policy.js';
import { InferenceUsageService } from './inference-usage.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): the limits list drops deleted accounts, except one that still has an
 * override, which stays listed until the override is removed.
 */
describe.skipIf(!url)('inference limits list and deleted accounts', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let service: InferenceUsageService;
  let live = '';
  let deleted = '';
  let deletedWithOverride = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'inference_limit_users');
    pool = database.pool;
    await migrateDatabase(pool);
    const db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    service = new InferenceUsageService(db, new InferenceBudgetPolicyService(db), {
      log: async () => undefined,
    } as unknown as AuditService);

    const group = (await pool.query(`insert into permission_groups (name) values ('limits') returning id`)).rows[0].id;
    const user = async (email: string, isDeleted: boolean) =>
      (
        await pool.query(
          `insert into users (email, name, group_id, deleted_at) values ($1, 'U', $2, $3) returning id`,
          [email, group, isDeleted ? new Date() : null]
        )
      ).rows[0].id as string;
    live = await user('live-limits@example.test', false);
    deleted = await user('deleted-limits@example.test', true);
    deletedWithOverride = await user('override-limits@example.test', true);
    await db.insert(schema.inferenceLimitPolicies).values({
      policyType: 'user',
      userId: deletedWithOverride,
      credits5h: '0',
      credits7d: '0',
      credits30d: '0',
      credits5hEnabled: false,
      credits7dEnabled: false,
      credits30dEnabled: false,
      apiMonthlyMicrodollars: 0,
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  const listed = async () => (await service.limitUsers()).map((user) => user.id);

  it('lists a deleted account only while it has an override', async () => {
    const ids = await listed();
    expect(ids).toContain(live);
    expect(ids).toContain(deletedWithOverride);
    expect(ids).not.toContain(deleted);
  });

  it('drops the deleted account once its override is removed', async () => {
    await service.removeUser(live, deletedWithOverride);
    const ids = await listed();
    expect(ids).toContain(live);
    expect(ids).not.toContain(deletedWithOverride);
  });
});
