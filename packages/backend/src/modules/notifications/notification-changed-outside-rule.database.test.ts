import { describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

const seededRule = `select name, enabled, type, severity, category, resource_ids, webhook_ids, is_builtin
  from notification_alert_rules where category = 'container' and event_pattern = 'changed_outside'`;

/** Migration 0257: a managed container changed outside Opfield alerts out of the box. */
describe.skipIf(!url)('Built-in "Container changed outside Opfield" alert rule on disposable PostgreSQL', () => {
  it('is seeded on upgrade with the webhooks of the enabled container and node rules', async () => {
    const db = await disposableDatabase(url!, 'changed_outside_rule_upgrade');
    try {
      await migrateDatabase(db.pool, '0256_route_client_ip_source');
      const webhook = async (name: string, enabled = true) =>
        (
          await db.pool.query(
            `insert into notification_webhooks (name, url, enabled) values ($1, $2, $3) returning id`,
            [name, `https://hooks.example.test/${name}`, enabled]
          )
        ).rows[0].id as string;
      const [containerHook, nodeHook, proxyHook, disabledHook] = [
        await webhook('container'),
        await webhook('node'),
        await webhook('proxy'),
        await webhook('disabled', false),
      ];
      const rule = (name: string, category: string, event: string, hooks: string[], enabled = true) =>
        db.pool.query(
          `insert into notification_alert_rules (name, enabled, type, category, event_pattern, webhook_ids)
           values ($1, $2, 'event', $3, $4, $5)`,
          [name, enabled, category, event, JSON.stringify(hooks)]
        );
      await rule('Container stopped', 'container', 'stopped', [containerHook, disabledHook]);
      await rule('Node offline', 'node', 'offline', [nodeHook]);
      await rule('Proxy host down', 'proxy', 'health.offline', [proxyHook]);

      await migrateDatabase(db.pool);
      const rows = (await db.pool.query(seededRule)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'Container changed outside Opfield',
        enabled: true,
        type: 'event',
        severity: 'warning',
        resource_ids: [],
        is_builtin: true,
      });
      expect([...rows[0].webhook_ids].sort()).toEqual([containerHook, nodeHook].sort());
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('keeps a rule the install already has, and a fresh install gets the rule without webhooks', async () => {
    const existing = await disposableDatabase(url!, 'changed_outside_rule_existing');
    try {
      await migrateDatabase(existing.pool, '0256_route_client_ip_source');
      await existing.pool.query(
        `insert into notification_alert_rules (name, enabled, type, severity, category, event_pattern)
         values ('My drift alert', false, 'event', 'critical', 'container', 'changed_outside')`
      );
      await migrateDatabase(existing.pool);
      expect((await existing.pool.query(seededRule)).rows).toEqual([
        expect.objectContaining({ name: 'My drift alert', enabled: false, is_builtin: false }),
      ]);
    } finally {
      await existing.drop();
    }

    const fresh = await disposableDatabase(url!, 'changed_outside_rule_fresh');
    try {
      await migrateDatabase(fresh.pool);
      expect((await fresh.pool.query(seededRule)).rows).toEqual([
        expect.objectContaining({
          name: 'Container changed outside Opfield',
          enabled: true,
          webhook_ids: [],
          is_builtin: true,
        }),
      ]);
    } finally {
      await fresh.drop();
    }
  }, 60_000);

  /** Migration 0269: the message says what each change means, and an edited message stays. */
  it('gets the message with the consequence of each change, unless someone edited it', async () => {
    const db = await disposableDatabase(url!, 'changed_outside_rule_message');
    try {
      await migrateDatabase(db.pool, '0268_docker_engine_unavailable_alert_rule');
      const template = `select message_template from notification_alert_rules
        where category = 'container' and event_pattern = 'changed_outside' and is_builtin`;
      expect((await db.pool.query(template)).rows[0].message_template).toContain('its permissions were reset');
      await migrateDatabase(db.pool);
      expect((await db.pool.query(template)).rows[0].message_template).toBe(
        'Container {{resource.name}} on {{node.name}} was {{details.change}} outside Opfield. {{details.consequence}} Change managed containers through Opfield.'
      );
    } finally {
      await db.drop();
    }

    const edited = await disposableDatabase(url!, 'changed_outside_rule_message_edited');
    try {
      await migrateDatabase(edited.pool, '0268_docker_engine_unavailable_alert_rule');
      await edited.pool.query(
        `update notification_alert_rules set message_template = 'Drift on {{resource.name}}'
         where category = 'container' and event_pattern = 'changed_outside'`
      );
      await migrateDatabase(edited.pool);
      const rows = (
        await edited.pool.query(
          `select message_template from notification_alert_rules where category = 'container' and event_pattern = 'changed_outside'`
        )
      ).rows;
      expect(rows).toEqual([{ message_template: 'Drift on {{resource.name}}' }]);
    } finally {
      await edited.drop();
    }
  }, 60_000);
});
