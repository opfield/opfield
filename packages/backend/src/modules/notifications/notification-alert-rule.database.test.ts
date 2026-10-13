import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { CreateAlertRuleSchema } from './notification-alert-rule.schemas.js';
import { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import { NotificationWebhookService } from './notification-webhook.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/** Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): alert rules only name webhooks that exist. */
describe.skipIf(!url)('Alert rule webhooks on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const audit = { log: async () => {} } as never;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'alert_rule_webhooks');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  const newWebhook = async (name: string) =>
    (
      await pool.query(
        `insert into notification_webhooks (name, url, method, body_template) values ($1, 'https://hooks.example.test/x', 'POST', '{}') returning id`,
        [name]
      )
    ).rows[0].id as string;

  const ruleInput = (webhookIds: string[]) =>
    CreateAlertRuleSchema.parse({
      name: 'Node down',
      type: 'event',
      category: 'node',
      eventPattern: 'offline',
      severity: 'critical',
      webhookIds,
    });

  it('rejects a webhook id that does not exist, on create and on update', async () => {
    const service = new NotificationAlertRuleService(db, audit);
    const hook = await newWebhook('a');
    const missing = '00000000-0000-4000-8000-000000000001';

    await expect(service.create(ruleInput([hook, missing]), 'user')).rejects.toMatchObject({
      statusCode: 400,
      code: 'WEBHOOK_NOT_FOUND',
    });
    const rule = await service.create(ruleInput([hook]), 'user');
    expect(rule.webhookIds).toEqual([hook]);
    await expect(service.update(rule.id, { webhookIds: [missing] }, 'user')).rejects.toMatchObject({
      code: 'WEBHOOK_NOT_FOUND',
    });
  });

  it('drops a deleted webhook from the rules that named it', async () => {
    const rules = new NotificationAlertRuleService(db, audit);
    const webhooks = new NotificationWebhookService(db, audit, {} as never);
    const kept = await newWebhook('kept');
    const gone = await newWebhook('gone');
    const rule = await rules.create(ruleInput([kept, gone]), 'user');

    await webhooks.delete(gone, 'user');
    expect((await rules.getById(rule.id)).webhookIds).toEqual([kept]);
    // Saving the rule again with its remaining webhooks works.
    expect((await rules.update(rule.id, { webhookIds: [kept] }, 'user')).webhookIds).toEqual([kept]);
  });
});
