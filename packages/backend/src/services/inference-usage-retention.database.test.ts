import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase, pgError, rejection } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { cleanInferenceUsage, INFERENCE_USAGE_RETENTION_SETTING } from './inference-usage-retention.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): the usage ledger is append-only by a trigger, so the retention
 * cleanup has to pass that trigger in the real schema, and nothing else may. One connection, so a setting left on it
 * by the cleanup would show in the next statement.
 */
describe.skipIf(!url)('inference usage retention, on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
  const now = new Date();
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
  let userId = '';
  let keptLedgerId = '';

  const request = async (status: string, startedAt: Date) =>
    (
      await q(
        `insert into inference_requests (user_id, protocol, operation, public_model_id, status, started_at)
         values ($1, 'responses', 'create', 'model', $2, $3) returning id`,
        [userId, status, startedAt]
      )
    ).rows[0].id as string;
  const attempt = async (requestId: string) =>
    (
      await q(
        `insert into inference_request_attempts (request_id, sequence, status) values ($1, 1, 'completed') returning id`,
        [requestId]
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'inference_usage_retention', { max: 1 });
    await migrateDatabase(database.pool);
    db = drizzle(database.pool, { schema }) as unknown as DrizzleClient;
    const group = (await q(`insert into permission_groups (name) values ('retention') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('retention@example.test', 'R', $1) returning id`, [
        group,
      ])
    ).rows[0].id;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('removes expired settled requests with their usage records and keeps the lifetime totals', async () => {
    const expired = await request('completed', daysAgo(100));
    const expiredAttempt = await attempt(expired);
    await q(
      `insert into inference_usage_ledger
         (request_id, attempt_id, user_id, entry_type, budget_type, credits, api_microdollars,
          uncached_input_tokens, cached_input_tokens, output_tokens, reasoning_tokens)
       values ($1, $2, $3, 'settlement', 'subscription', '2.5', 700, 10, 20, 30, 5),
              ($1, null, $3, 'adjustment', 'subscription', '0.5', 0, 0, 0, 0, 0)`,
      [expired, expiredAttempt, userId]
    );
    const running = await request('running', daysAgo(100));
    const recent = await request('completed', daysAgo(10));
    keptLedgerId = (
      await q(
        `insert into inference_usage_ledger (request_id, attempt_id, user_id, entry_type, budget_type, credits)
         values ($1, $2, $3, 'settlement', 'subscription', '1') returning id`,
        [recent, await attempt(recent), userId]
      )
    ).rows[0].id;

    await expect(cleanInferenceUsage(db, 90, now)).resolves.toEqual({ requests: 1, ledgerEntries: 2 });

    const requests = (await q(`select id from inference_requests`)).rows.map((row) => row.id as string);
    expect(requests.sort()).toEqual([running, recent].sort());
    expect((await q(`select id from inference_usage_ledger`)).rows).toEqual([{ id: keptLedgerId }]);
    expect((await q(`select 1 from inference_request_attempts where id = $1`, [expiredAttempt])).rows).toEqual([]);
    const totals = await q(
      `select tokens, credits, api_microdollars from inference_usage_lifetime_totals where user_id = $1`,
      [userId]
    );
    expect(totals.rows).toEqual([{ tokens: '65', credits: '3.000000', api_microdollars: '700' }]);
  });

  it('refuses every other change to the usage ledger', async () => {
    const appendOnly = async (statement: Promise<unknown>) => {
      const error = pgError(await rejection(statement)) as { code?: string; message?: string } | undefined;
      expect(error?.code).toBe('P0001');
      expect(error?.message).toBe('inference_usage_ledger is append-only');
    };

    // After the cleanup, on the connection it used.
    await appendOnly(q(`delete from inference_usage_ledger where id = $1`, [keptLedgerId]));
    await appendOnly(q(`update inference_usage_ledger set credits = '0' where id = $1`, [keptLedgerId]));
    // The cleanup's setting opens deletes only.
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config($1, 'on', true)`, [INFERENCE_USAGE_RETENTION_SETTING]);
      await appendOnly(client.query(`update inference_usage_ledger set credits = '0' where id = $1`, [keptLedgerId]));
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect((await q(`select credits from inference_usage_ledger where id = $1`, [keptLedgerId])).rows).toEqual([
      { credits: '1.000000' },
    ]);
  });
});
