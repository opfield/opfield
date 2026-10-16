import { describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

const rulesQuery = `select name, enabled, severity, category, metric, metric_target, operator, threshold_value,
  message_template, webhook_ids, is_builtin from notification_alert_rules
  where (category = 'node' and metric in ('disk', 'managed_disk_promised_pct'))
     or (category in ('database_postgres', 'database_redis') and metric = 'managed_disk_pct')
     or (category = 'database_clickhouse' and metric = 'disk_used_pct')
  order by name`;

type Rule = Record<string, any>;

function byName(rows: Rule[]): Record<string, Rule> {
  return Object.fromEntries(rows.map((row) => [row.name, row]));
}

/** Migration 0267: disk alerts for every data disk of a node, managed database disks and oversubscribed nodes. */
describe.skipIf(!url)('Built-in data disk alert rules on disposable PostgreSQL', () => {
  it('retargets the unedited built-in node disk rule and seeds the new rules with the webhooks the install alerts on', async () => {
    const db = await disposableDatabase(url!, 'data_disk_rules_upgrade');
    try {
      await migrateDatabase(db.pool, '0257_container_changed_outside_alert_rule');
      const webhook = async (name: string, enabled = true) =>
        (
          await db.pool.query(
            `insert into notification_webhooks (name, url, enabled) values ($1, $2, $3) returning id`,
            [name, `https://hooks.example.test/${name}`, enabled]
          )
        ).rows[0].id as string;
      const [nodeHook, databaseHook, disabledHook, proxyHook] = [
        await webhook('node'),
        await webhook('database'),
        await webhook('disabled', false),
        await webhook('proxy'),
      ];
      const rule = (name: string, category: string, event: string, hooks: string[]) =>
        db.pool.query(
          `insert into notification_alert_rules (name, enabled, type, category, event_pattern, webhook_ids)
           values ($1, true, 'event', $2, $3, $4)`,
          [name, category, event, JSON.stringify(hooks)]
        );
      await rule('Node offline', 'node', 'offline', [nodeHook, disabledHook]);
      await rule('Proxy down', 'proxy', 'health.offline', [proxyHook]);
      await migrateDatabase(db.pool, '0258_disk_full_alert_rules');
      await rule('Postgres down', 'database_postgres', 'health.offline', [databaseHook]);

      await migrateDatabase(db.pool);

      const rules = byName((await db.pool.query(rulesQuery)).rows);
      expect(Object.keys(rules).sort()).toEqual([
        'ClickHouse disk almost full',
        'Key-value store disk almost full',
        'Node disk almost full',
        'Node disk full',
        'Node disk oversubscribed',
        'Postgres disk almost full',
      ]);
      expect(rules['Node disk almost full']).toMatchObject({
        severity: 'warning',
        metric_target: '@data',
        operator: '>=',
        threshold_value: 85,
        is_builtin: true,
      });
      expect(rules['Node disk almost full'].message_template).toContain('Disk {{details.mount}} of node {{node.name}}');
      // 0258 copied the webhooks of node rules only, and its row keeps them.
      expect(rules['Node disk almost full'].webhook_ids).toEqual([nodeHook]);
      expect(rules['Node disk full']).toMatchObject({
        enabled: true,
        severity: 'critical',
        metric_target: '@data',
        operator: '>=',
        threshold_value: 95,
        is_builtin: true,
      });
      expect(rules['Node disk oversubscribed']).toMatchObject({
        category: 'node',
        metric: 'managed_disk_promised_pct',
        metric_target: null,
        operator: '>',
        threshold_value: 100,
        is_builtin: true,
      });
      expect(rules['Postgres disk almost full']).toMatchObject({
        category: 'database_postgres',
        metric: 'managed_disk_pct',
      });
      expect(rules['Key-value store disk almost full']).toMatchObject({
        category: 'database_redis',
        metric: 'managed_disk_pct',
      });
      expect(rules['ClickHouse disk almost full']).toMatchObject({
        category: 'database_clickhouse',
        metric: 'disk_used_pct',
      });
      for (const name of [
        'Node disk full',
        'Node disk oversubscribed',
        'Postgres disk almost full',
        'Key-value store disk almost full',
        'ClickHouse disk almost full',
      ]) {
        expect(rules[name]).toMatchObject({ enabled: true, threshold_value: expect.any(Number), is_builtin: true });
        // Enabled webhooks of enabled node, Opfield, database and storage rules: not the proxy's, not a disabled one.
        expect([...rules[name].webhook_ids].sort()).toEqual([nodeHook, databaseHook].sort());
        expect(rules[name].message_template).toContain('{{round metric.value 1}}%');
      }
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('keeps an edited built-in rule and the rules an install already has', async () => {
    const db = await disposableDatabase(url!, 'data_disk_rules_edited');
    try {
      await migrateDatabase(db.pool, '0258_disk_full_alert_rules');
      // The owner raised the threshold of the built-in rule: it keeps watching "/" with its own settings.
      await db.pool.query(
        `update notification_alert_rules set threshold_value = 90 where is_builtin and category = 'node' and metric = 'disk'`
      );
      await db.pool.query(
        `insert into notification_alert_rules (name, enabled, type, severity, category, metric, metric_target, operator, threshold_value)
         values ('My critical disk alert', true, 'threshold', 'critical', 'node', 'disk', '/data', '>', 97),
                ('My Postgres disk alert', false, 'threshold', 'warning', 'database_postgres', 'managed_disk_pct', null, '>', 70)`
      );
      await migrateDatabase(db.pool);

      const rules = byName((await db.pool.query(rulesQuery)).rows);
      expect(rules['Node disk almost full']).toMatchObject({ metric_target: '/', threshold_value: 90 });
      expect(rules['Node disk almost full'].message_template).toContain('The root disk of node');
      expect(rules['My critical disk alert']).toMatchObject({ metric_target: '/data', threshold_value: 97 });
      expect(rules['Node disk full']).toBeUndefined();
      expect(rules['My Postgres disk alert']).toMatchObject({ enabled: false, threshold_value: 70 });
      expect(rules['Postgres disk almost full']).toBeUndefined();
      expect(rules['Key-value store disk almost full']).toBeDefined();
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('retargets a built-in rule whose message was edited but keeps the message, and seeds a fresh install', async () => {
    const edited = await disposableDatabase(url!, 'data_disk_rules_message');
    try {
      await migrateDatabase(edited.pool, '0258_disk_full_alert_rules');
      await edited.pool.query(
        `update notification_alert_rules set message_template = 'Disk alert on {{node.name}}'
         where is_builtin and category = 'node' and metric = 'disk'`
      );
      await migrateDatabase(edited.pool);
      const rules = byName((await edited.pool.query(rulesQuery)).rows);
      expect(rules['Node disk almost full']).toMatchObject({
        metric_target: '@data',
        message_template: 'Disk alert on {{node.name}}',
      });
    } finally {
      await edited.drop();
    }

    const fresh = await disposableDatabase(url!, 'data_disk_rules_fresh');
    try {
      await migrateDatabase(fresh.pool);
      const rows = (await fresh.pool.query(rulesQuery)).rows;
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row).toMatchObject({ enabled: true, webhook_ids: [], is_builtin: true });
      }
      expect(byName(rows)['Node disk almost full'].metric_target).toBe('@data');
    } finally {
      await fresh.drop();
    }
  }, 60_000);
});
