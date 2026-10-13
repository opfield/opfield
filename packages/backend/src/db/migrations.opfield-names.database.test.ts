import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase } from './migration-database.test-helpers.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): migration 0246 on a database a 2.12.0 install wrote. Stored names that
 * carried the former product name come out under the Opfield names; an operator's own edits stay.
 */
describe.skipIf(!url)('Opfield names migration on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const group = randomUUID();
  const editedGroup = randomUUID();
  const systemUser = '00000000-0000-0000-0000-000000000000';
  const owner = randomUUID();
  const firingRule = randomUUID();
  const customRule = randomUUID();
  const destination = randomUUID();

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'opfield_names');
    pool = database.pool;
    await migrateDatabase(pool, '0245_remove_inference_companion');

    await q(
      `insert into permission_groups (id, name, scopes, require_gateway_2fa)
       values ($1, 'ops', '["settings:gateway:view", "settings:gateway:edit", "nodes:details"]', true),
              ($2, 'plain', '["nodes:details"]', false)`,
      [group, editedGroup]
    );
    await q(
      `insert into users (id, group_id, email, name, oidc_subject)
       values ($1, $2, 'system@gateway.local', 'Gateway System', 'system:gateway-setup'),
              ($3, $2, 'owner@example.com', 'Owner', null)`,
      [systemUser, group, owner]
    );
    await q(
      `insert into api_tokens (user_id, name, token_hash, token_prefix, scopes)
       values ($1, 'ci', 'hash', 'gw_0123456', '["settings:gateway:view"]')`,
      [owner]
    );
    await q(
      `insert into notification_alert_rules (id, name, type, severity, category, event_pattern, resource_ids, message_template)
       values ($1, 'Postgres down', 'event', 'critical', 'gateway', 'postgres.unavailable', '["gateway-postgres", "gateway"]',
               'Down: {{gateway.url}} and {{ gateway.url }}'),
              ($2, 'Proxy rule', 'event', 'warning', 'proxy', 'health.down', '[]', 'The gateway {{resource.name}} is down')`,
      [firingRule, customRule]
    );
    await q(
      `insert into notification_alert_states (rule_id, resource_type, resource_id, severity, context)
       values ($1, 'gateway', 'gateway-postgres', 'critical', '{}'),
              ($1, 'gateway', 'gateway-relay-instance:abc', 'critical', '{}'),
              ($2, 'proxy', 'host-1', 'warning', '{"folded": {"stateId": "x", "kind": "gateway_outbound", "label": "y"}}')`,
      [firingRule, customRule]
    );
    await q(
      `insert into notification_webhooks (name, url, template_preset, body_template)
       values ('json', 'https://hooks.example.com', 'json', '{"gateway": {{{json gateway}}}, "url": "{{gateway.url}}"}')`
    );
    await q(
      `insert into siem_destinations (id, name, url, auth_type, encrypted_secret)
       values ($1, 'collector', 'https://siem.example.com', 'bearer', 'secret')`,
      [destination]
    );
    await q(
      `insert into siem_deliveries (destination_id, audit_log_id, payload)
       values ($1, $2, $3)`,
      [
        destination,
        randomUUID(),
        JSON.stringify({
          id: 'e1',
          source: 'urn:wiolett:gateway:inst-1',
          type: 'com.wiolett.gateway.audit.v1',
          data: {},
        }),
      ]
    );
    await q(
      `insert into settings (key, value) values
         ('ai:provider_type', '"gateway_inference"'),
         ('ai:gateway_inference_model', '"model-a"'),
         ('ai:gateway_inference_allow_user_model_selection', 'false'),
         ('ai:disabled_tools', '["get_gateway_settings", "list_nodes"]'),
         ('general:settings', '{"publicUrl": "https://op.example.com", "gatewayGrpcPublicTarget": "op.example.com:9443", "gatewayGrpcLocalIp": null}')
       on conflict (key) do update set value = excluded.value`
    );

    await migrateDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('renames the tables and columns that carried the former name', async () => {
    const { rows } = await q(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and (column_name ~ 'gateway' or table_name ~ 'gateway')`
    );
    expect(rows).toEqual([]);
    expect((await q('select require_2fa from permission_groups where id = $1', [group])).rows).toEqual([
      { require_2fa: true },
    ]);
    expect((await q('select count(*)::int as n from opfield_diagnostics_samples')).rows).toEqual([{ n: 0 }]);
    const { rows: functions } = await q(`select proname from pg_proc where proname ~ '_0246$|^gateway_page'`);
    expect(functions).toEqual([]);
    expect(
      (
        await q(`select column_default from information_schema.columns where table_name = 'page_projects'
      and column_name = 'preview_hash'`)
      ).rows[0].column_default
    ).toContain('opfield_page_preview_hash');
  });

  it('rewrites stored settings scopes', async () => {
    expect((await q('select scopes from permission_groups where id = $1', [group])).rows[0].scopes).toEqual([
      'settings:opfield:view',
      'settings:opfield:edit',
      'nodes:details',
    ]);
    expect((await q('select scopes from api_tokens where user_id = $1', [owner])).rows[0].scopes).toEqual([
      'settings:opfield:view',
    ]);
  });

  it('moves alerts about Opfield itself to the opfield category and resources', async () => {
    const rule = (
      await q('select category, resource_ids, message_template from notification_alert_rules where id = $1', [
        firingRule,
      ])
    ).rows[0];
    expect(rule).toEqual({
      category: 'opfield',
      resource_ids: ['opfield-postgres', 'opfield'],
      message_template: 'Down: {{opfield.url}} and {{ opfield.url }}',
    });
    const custom = (await q('select message_template from notification_alert_rules where id = $1', [customRule]))
      .rows[0];
    expect(custom.message_template).toBe('The gateway {{resource.name}} is down');
    const states = (
      await q('select resource_type, resource_id, context from notification_alert_states order by resource_id')
    ).rows;
    expect(states).toEqual([
      {
        resource_type: 'proxy',
        resource_id: 'host-1',
        context: { folded: { stateId: 'x', kind: 'opfield_outbound', label: 'y' } },
      },
      { resource_type: 'opfield', resource_id: 'opfield-postgres', context: {} },
      { resource_type: 'opfield', resource_id: 'opfield-relay-instance:abc', context: {} },
    ]);
    const builtin = (
      await q(
        `select name, message_template from notification_alert_rules where is_builtin and event_pattern = 'outbound.unavailable'`
      )
    ).rows;
    expect(builtin).toHaveLength(1);
    expect(builtin[0].name).toBe('Opfield lost outbound connectivity');
    expect(builtin[0].message_template).toMatch(/^Opfield cannot reach/);
    const hook = (await q('select body_template from notification_webhooks')).rows[0];
    expect(hook.body_template).toBe('{"gateway": {{{json opfield}}}, "url": "{{opfield.url}}"}');
  });

  it('renames the system user and leaves other users alone', async () => {
    expect((await q('select oidc_subject, name, email from users order by email')).rows).toEqual([
      { oidc_subject: null, name: 'Owner', email: 'owner@example.com' },
      { oidc_subject: 'system:opfield-setup', name: 'Opfield System', email: 'system@opfield.local' },
    ]);
  });

  it('gives queued SIEM events the new type and source', async () => {
    const { payload } = (await q('select payload from siem_deliveries')).rows[0];
    expect(payload).toMatchObject({ type: 'dev.opfield.audit.v1', source: 'urn:opfield:inst-1' });
  });

  it('moves the AI provider type, settings keys, disabled tools and gRPC targets', async () => {
    const settings = Object.fromEntries(
      (await q(`select key, value from settings where key like 'ai:%' or key = 'general:settings'`)).rows.map((row) => [
        row.key,
        row.value,
      ])
    );
    expect(settings['ai:provider_type']).toBe('opfield_inference');
    expect(settings['ai:opfield_inference_model']).toBe('model-a');
    expect(settings['ai:opfield_inference_allow_user_model_selection']).toBe(false);
    expect(settings['ai:gateway_inference_model']).toBeUndefined();
    expect(settings['ai:disabled_tools']).toEqual(['get_opfield_settings', 'list_nodes']);
    expect(settings['general:settings']).toEqual({
      publicUrl: 'https://op.example.com',
      grpcPublicTarget: 'op.example.com:9443',
      grpcLocalIp: null,
    });
  });
});
