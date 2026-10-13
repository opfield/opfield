import { describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

const seededRule = `select name, enabled, type, severity, category, duration_seconds, resolve_after_seconds, resource_ids,
  webhook_ids, is_builtin from notification_alert_rules where category = 'managed_storage' and event_pattern = 'storage.full'`;

/** Migration 0243: a full managed storage alerts out of the box, through the webhooks the install already alerts on. */
describe.skipIf(!url)('Built-in "Storage is full" alert rule on disposable PostgreSQL', () => {
  it('is seeded on upgrade with the webhooks of the enabled proxy, node and storage rules', async () => {
    const fresh = await disposableDatabase(url!, 'storage_full_rule_upgrade');
    try {
      await migrateDatabase(fresh.pool, '0242_app_logo_description');
      const webhook = async (name: string, enabled = true) =>
        (
          await fresh.pool.query(
            `insert into notification_webhooks (name, url, enabled) values ($1, $2, $3) returning id`,
            [name, `https://hooks.example.test/${name}`, enabled]
          )
        ).rows[0].id as string;
      const [proxyHook, storageHook, disabledHook, containerHook] = [
        await webhook('proxy'),
        await webhook('storage'),
        await webhook('disabled', false),
        await webhook('container'),
      ];
      const rule = (name: string, category: string, event: string, hooks: string[], enabled = true) =>
        fresh.pool.query(
          `insert into notification_alert_rules (name, enabled, type, category, event_pattern, webhook_ids)
           values ($1, $2, 'event', $3, $4, $5)`,
          [name, enabled, category, event, JSON.stringify(hooks)]
        );
      await rule('Proxy host down', 'proxy', 'health.offline', [proxyHook, disabledHook]);
      await rule('Storage failover', 'managed_storage', 'availability.failover', [storageHook]);
      await rule('Container stopped', 'container', 'stopped', [containerHook]);
      await rule('Old node rule', 'node', 'offline', [containerHook], false);

      await migrateDatabase(fresh.pool);

      const rows = (await fresh.pool.query(seededRule)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'Storage is full',
        enabled: true,
        type: 'event',
        severity: 'critical',
        duration_seconds: 0,
        resolve_after_seconds: 60,
        resource_ids: [],
        is_builtin: true,
      });
      expect([...rows[0].webhook_ids].sort()).toEqual([proxyHook, storageHook].sort());
    } finally {
      await fresh.drop();
    }
  }, 60_000);

  it('keeps a rule the install already has, and a fresh install gets the rule without webhooks', async () => {
    const existing = await disposableDatabase(url!, 'storage_full_rule_existing');
    try {
      await migrateDatabase(existing.pool, '0242_app_logo_description');
      await existing.pool.query(
        `insert into notification_alert_rules (name, enabled, type, severity, category, event_pattern)
         values ('My storage alert', false, 'event', 'warning', 'managed_storage', 'storage.full')`
      );
      await migrateDatabase(existing.pool);
      expect((await existing.pool.query(seededRule)).rows).toEqual([
        expect.objectContaining({ name: 'My storage alert', enabled: false, severity: 'warning', is_builtin: false }),
      ]);
    } finally {
      await existing.drop();
    }

    const fresh = await disposableDatabase(url!, 'storage_full_rule_fresh');
    try {
      await migrateDatabase(fresh.pool);
      expect((await fresh.pool.query(seededRule)).rows).toEqual([
        expect.objectContaining({ name: 'Storage is full', enabled: true, webhook_ids: [], is_builtin: true }),
      ]);
    } finally {
      await fresh.drop();
    }
  }, 60_000);
});
