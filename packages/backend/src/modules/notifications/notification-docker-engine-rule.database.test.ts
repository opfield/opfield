import { describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

const seededRule = `select name, enabled, type, severity, category, metric, operator, threshold_value, duration_seconds,
    resource_ids, webhook_ids, is_builtin, message_template
  from notification_alert_rules where category = 'node' and metric = 'docker_engine_unavailable'`;

/** Migration 0268: a Docker node whose engine cannot start containers alerts out of the box (rc.2 F-12). */
describe.skipIf(!url)('Built-in "Docker runtime unavailable" alert rule on disposable PostgreSQL', () => {
  it('is seeded on upgrade, enabled, with the webhooks of the enabled node rules', async () => {
    const db = await disposableDatabase(url!, 'docker_engine_rule_upgrade');
    try {
      await migrateDatabase(db.pool, '0263_inference_unpriced_cost');
      const webhook = async (name: string, enabled = true) =>
        (
          await db.pool.query(
            `insert into notification_webhooks (name, url, enabled) values ($1, $2, $3) returning id`,
            [name, `https://hooks.example.test/${name}`, enabled]
          )
        ).rows[0].id as string;
      const [nodeHook, proxyHook, disabledHook] = [
        await webhook('node'),
        await webhook('proxy'),
        await webhook('off', false),
      ];
      const rule = (name: string, category: string, event: string, hooks: string[]) =>
        db.pool.query(
          `insert into notification_alert_rules (name, enabled, type, category, event_pattern, webhook_ids)
           values ($1, true, 'event', $2, $3, $4)`,
          [name, category, event, JSON.stringify(hooks)]
        );
      await rule('Node offline', 'node', 'offline', [nodeHook, disabledHook]);
      await rule('Proxy host down', 'proxy', 'health.offline', [proxyHook]);

      await migrateDatabase(db.pool);
      const rows = (await db.pool.query(seededRule)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'Docker runtime unavailable',
        enabled: true,
        type: 'threshold',
        severity: 'critical',
        operator: '>=',
        threshold_value: 1,
        duration_seconds: 120,
        resource_ids: [],
        is_builtin: true,
      });
      expect(rows[0].message_template).toContain('{{details.problem}}');
      expect(rows[0].webhook_ids).toEqual([nodeHook]);
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('keeps a rule the install already has, and a fresh install gets the rule without webhooks', async () => {
    const existing = await disposableDatabase(url!, 'docker_engine_rule_existing');
    try {
      await migrateDatabase(existing.pool, '0263_inference_unpriced_cost');
      await existing.pool.query(
        `insert into notification_alert_rules (name, enabled, type, severity, category, metric, operator, threshold_value)
         values ('My Docker check', false, 'threshold', 'warning', 'node', 'docker_engine_unavailable', '>=', 1)`
      );
      await migrateDatabase(existing.pool);
      const rows = (await existing.pool.query(seededRule)).rows;
      expect(rows.map((row) => row.name)).toEqual(['My Docker check']);
    } finally {
      await existing.drop();
    }
    const fresh = await disposableDatabase(url!, 'docker_engine_rule_fresh');
    try {
      await migrateDatabase(fresh.pool);
      const rows = (await fresh.pool.query(seededRule)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].webhook_ids).toEqual([]);
    } finally {
      await fresh.drop();
    }
  }, 60_000);
});
