import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { OutboundWebhookFetchResponse } from '@/modules/settings/outbound-webhook-request.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';
import { OPFIELD_OUTBOUND_RESOURCE_ID, OpfieldOutboundMonitor } from './opfield-outbound-monitor.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): one cause is one alert. A route alert explained by its node's "node
 * down" alert or by "Opfield lost outbound connectivity" is not sent separately and resolves with it; the built-in
 * outbound rule exists after migration; resolves carry Opfield's back-online text.
 */
describe.skipIf(!url)('Alert folding on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let sent: string[] = [];
  let reachable = true;
  let webhookId = '';
  let nodeId = '';
  let hostId = '';
  let rules: any[] = [];
  let evaluator: NotificationEvaluatorService;
  let dispatcher: NotificationDispatcherService;

  const settle = async () => {
    await Promise.allSettled([...(evaluator as any).activeDeliveries]);
  };
  const observe = async (
    category: string,
    state: string,
    resource: { type: string; id: string; name: string },
    context: Record<string, unknown> = {}
  ) => {
    await evaluator.observeStatefulEvent(category, state, resource, context);
    await settle();
  };
  const node = (state: 'offline' | 'online') => observe('node', state, { type: 'node', id: nodeId, name: 'node-1' });
  const route = (state: 'health.offline' | 'health.online', context: Record<string, unknown> = {}) =>
    observe('proxy', state, { type: 'proxy', id: hostId, name: 'example.com' }, { health_status: state, ...context });
  const outbound = (state: 'outbound.unavailable' | 'ok') =>
    observe('opfield', state, { type: 'opfield', id: OPFIELD_OUTBOUND_RESOURCE_ID, name: 'Opfield' });
  const routeState = async () =>
    (
      await q(`select status, context -> 'folded' as folded from notification_alert_states where resource_id = $1`, [
        hostId,
      ])
    ).rows;
  const rule = async (name: string, category: string, eventPattern: string) =>
    (
      await q(
        `insert into notification_alert_rules (name, enabled, type, category, event_pattern, severity, webhook_ids,
           duration_seconds, resolve_after_seconds)
         values ($1, true, 'event', $2, $3, 'critical', $4, 0, 0) returning *`,
        [name, category, eventPattern, JSON.stringify([webhookId])]
      )
    ).rows[0];

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'alert_folding');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await q(`delete from notification_alert_rules`);
    await q(`delete from notification_webhooks`);
    sent = [];
    reachable = true;
    const suffix = randomUUID().slice(0, 8);
    const groupId = (await q(`insert into permission_groups (name) values ($1) returning id`, [`g-${suffix}`])).rows[0]
      .id;
    const userId = (
      await q(`insert into users (email, name, group_id) values ($1, 'Operator', $2) returning id`, [
        `u-${suffix}@example.test`,
        groupId,
      ])
    ).rows[0].id;
    nodeId = (await q(`insert into nodes (hostname, slug) values ($1, $1) returning id`, [`node-${suffix}`])).rows[0]
      .id;
    hostId = (
      await q(
        `insert into proxy_hosts (slug, node_id, domain_names, created_by_id) values ($1, $2, '["example.com"]', $3) returning id`,
        [`route-${suffix}`, nodeId, userId]
      )
    ).rows[0].id;
    webhookId = (
      await q(
        `insert into notification_webhooks (name, url, method, body_template)
         values ('Discord', 'https://hooks.example.test/x', 'POST', '{{notification.message}}') returning id`
      )
    ).rows[0].id;
    rules = [
      await rule('Node down', 'node', 'offline'),
      await rule('Proxy host down', 'proxy', 'health.offline'),
      await rule('Opfield lost outbound connectivity', 'opfield', 'outbound.unavailable'),
    ];

    dispatcher = new NotificationDispatcherService(
      db,
      { decryptSigningSecret: () => null } as never,
      {} as never,
      {} as never
    );
    (dispatcher as any).fetchAllowedWebhookTarget = async (
      _url: string,
      options: { body?: string }
    ): Promise<OutboundWebhookFetchResponse> => {
      if (!reachable)
        throw new Error('Webhook target blocked by outbound network policy: Webhook target did not resolve');
      sent.push(String(options.body));
      return { status: 204, text: async () => '' };
    };
    evaluator = new NotificationEvaluatorService(
      db,
      {} as never,
      {
        getRawByIds: async (ids: string[]) =>
          (await q(`select * from notification_webhooks where id = any($1::uuid[])`, [ids])).rows.map((row) => ({
            ...row,
            bodyTemplate: row.body_template,
            signingSecret: null,
            headers: {},
          })),
      } as never,
      dispatcher,
      null,
      { getNode: () => ({ hostname: 'node-1' }) } as never
    );
    (evaluator as any).getEventRules = async () =>
      rules.map((row) => ({
        ...row,
        eventPattern: row.event_pattern,
        webhookIds: row.webhook_ids,
        resourceIds: [],
        durationSeconds: 0,
        resolveAfterSeconds: 0,
        messageTemplate: null,
        resolveMessageTemplate: null,
      }));
  });

  it('folds a route alert under its node being down and resolves it with the node', async () => {
    await node('offline');
    await route('health.offline');
    expect(sent).toEqual(['Node down: node-1']);
    expect((await routeState())[0]).toMatchObject({ status: 'firing', folded: { kind: 'node' } });

    await node('online');
    expect(sent).toEqual(['Node down: node-1', expect.stringMatching(/^Node node-1 is back online( after \d+s)?\.$/)]);
    expect((await routeState())[0].status).toBe('resolved');

    // Right after the node is back the route is held, so a route still settling does not alert.
    await route('health.offline');
    expect(await routeState()).toHaveLength(1);
  });

  it('folds a container health alert under its node being down, also one raised before the node alert (rc.8 O-4)', async () => {
    rules.push(await rule('Container down', 'container', 'health.offline'));
    const container = (id: string, state: 'health.offline' | 'health.online') =>
      observe(
        'container',
        state,
        { type: 'docker_container', id, name: id },
        { health_status: state, nodeId, resource_type: 'docker_container' }
      );
    const containerFolded = async (id: string) =>
      (
        await q(`select status, context -> 'folded' as folded from notification_alert_states where resource_id = $1`, [
          id,
        ])
      ).rows[0];

    await container('store', 'health.offline');
    await node('offline');
    await container('web', 'health.offline');
    expect(await containerFolded('store')).toMatchObject({ status: 'firing', folded: { kind: 'node' } });
    expect(await containerFolded('web')).toMatchObject({ status: 'firing', folded: { kind: 'node' } });
    // The node alert went out; the container alert raised after it did not.
    expect(sent.filter((body) => body.startsWith('Container down: web'))).toEqual([]);

    await node('online');
    // web's firing went out nowhere: it closes quietly with the node (and fires on its own if still down after the
    // hold). store's firing did go out: it is not claimed back as recovered, its own check resolves it (rc.9 F-2).
    expect((await containerFolded('web')).status).toBe('resolved');
    expect((await containerFolded('store')).status).toBe('firing');
    expect(sent.filter((body) => body.includes('store') && /back online/.test(body))).toEqual([]);
    await container('store', 'health.online');
    expect((await containerFolded('store')).status).toBe('resolved');
    expect(sent.filter((body) => body.includes('store') && /back online/.test(body))).toHaveLength(1);
  });

  it('leaves an older, unrelated container alert unfolded and does not resolve it with the node (rc.9 F-2, O-5)', async () => {
    rules.push(await rule('Container down', 'container', 'health.offline'));
    const container = (id: string, state: 'health.offline' | 'health.online') =>
      observe(
        'container',
        state,
        { type: 'docker_container', id, name: id },
        { health_status: state, nodeId, resource_type: 'docker_container' }
      );
    const containerState = async (id: string) =>
      (
        await q(
          `select status, context -> 'folded' as folded, context -> 'node' ->> 'name' as node_name
             from notification_alert_states where resource_id = $1 order by fired_at`,
          [id]
        )
      ).rows;
    // The node is not connected to this Opfield: alerts name it from the database, not by its id (O-5).
    (evaluator as any).nodeRegistry = { getNode: () => undefined };
    const hostname = (await q(`select hostname from nodes where id = $1`, [nodeId])).rows[0].hostname;

    // cl11-hc2 fired 47 min before its node dropped (stand rc.9: 05:50 vs 06:37).
    await container('cl11-hc2', 'health.offline');
    await q(`update notification_alert_states set fired_at = now() - interval '47 minutes' where resource_id = $1`, [
      'cl11-hc2',
    ]);
    await node('offline');
    await container('store', 'health.offline');
    expect((await containerState('cl11-hc2'))[0]).toMatchObject({ status: 'firing', folded: null });
    expect((await containerState('store'))[0]).toMatchObject({ status: 'firing', folded: { kind: 'node' } });
    expect((await containerState('store'))[0].node_name).toBe(hostname);

    await node('online');
    expect((await containerState('cl11-hc2'))[0].status).toBe('firing');
    expect(sent.filter((body) => body.includes('cl11-hc2') && /back online/.test(body))).toEqual([]);
  });

  it('folds route alerts raised before Gateway noticed its outbound loss, and sends one alert once it can', async () => {
    reachable = false;
    await route('health.offline', { probe_failure: 'unreachable' });
    await outbound('outbound.unavailable');
    expect(sent).toEqual([]);
    expect((await routeState())[0]).toMatchObject({ folded: { kind: 'opfield_outbound' } });

    reachable = true;
    await dispatcher.resumePausedWebhooks();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Opfield lost outbound connectivity: Opfield$/);

    await outbound('ok');
    expect(sent).toEqual([sent[0], expect.stringMatching(/^Opfield has outbound connectivity again( after \d+s)?\.$/)]);
    expect((await routeState())[0].status).toBe('resolved');
    const statuses = (
      await q(
        `select event_type, status from notification_delivery_log where alert_state_id in
        (select id from notification_alert_states where resource_id = $1) order by seq`,
        [hostId]
      )
    ).rows;
    expect(statuses).toEqual([{ event_type: 'alert.fired', status: 'superseded' }]);
  });

  it('does not fold a route whose probe got an answer, and sends its own resolve text', async () => {
    await outbound('outbound.unavailable');
    await route('health.offline');
    await route('health.online');
    expect(sent).toEqual([
      'Opfield lost outbound connectivity: Opfield',
      'Proxy host down: example.com',
      expect.stringMatching(/^Proxy host example.com is back online( after \d+s)?\.$/),
    ]);
  });

  it('reports lost outbound connectivity only after Gateway reached a target, and resumes paused webhooks', async () => {
    let up = false;
    const observed: string[] = [];
    let resumed = 0;
    const monitor = new OpfieldOutboundMonitor(
      db,
      { observeStatefulEvent: async (_c: string, state: string) => void observed.push(state) } as never,
      { resumePausedWebhooks: async () => void resumed++ } as never,
      async () => (up ? { reached: true } : { reached: false, error: 'EAI_AGAIN' })
    );
    await monitor.run();
    expect(observed).toEqual([]);
    up = true;
    await monitor.run();
    up = false;
    await monitor.run();
    up = true;
    await monitor.run();
    expect(observed).toEqual(['ok', 'outbound.unavailable', 'ok']);
    expect(resumed).toBe(1);
  });

  it('upgrades: queued deliveries keep their creation order, and the built-in outbound rule gets the route and node webhooks', async () => {
    const fresh = await disposableDatabase(url!, 'alert_folding_seed');
    try {
      await migrateDatabase(fresh.pool, '0232_docker_task_follow_ups');
      const hook = (
        await fresh.pool.query(
          `insert into notification_webhooks (name, url) values ('D', 'https://hooks.example.test/y') returning id`
        )
      ).rows[0].id;
      await fresh.pool.query(
        `insert into notification_alert_rules (name, enabled, type, category, event_pattern, webhook_ids)
         values ('Proxy host down', true, 'event', 'proxy', 'health.offline', $1)`,
        [JSON.stringify([hook])]
      );
      for (const [body, age] of [
        ['later', '1 minute'],
        ['earlier', '2 minutes'],
      ]) {
        await fresh.pool.query(
          `insert into notification_delivery_log (webhook_id, event_type, severity, request_url, request_method,
             request_body, status, created_at)
           values ($1, 'alert.fired', 'critical', 'https://hooks.example.test/y', 'POST', $2, 'retrying',
             now() - $3::interval)`,
          [hook, body, age]
        );
      }
      await migrateDatabase(fresh.pool);
      await fresh.pool.query(
        `insert into notification_delivery_log (webhook_id, event_type, severity, request_url, request_method, request_body)
         values ($1, 'alert.fired', 'critical', 'https://hooks.example.test/y', 'POST', 'new')`,
        [hook]
      );
      const queue = (await fresh.pool.query(`select request_body from notification_delivery_log order by seq`)).rows;
      expect(queue.map((row) => row.request_body)).toEqual(['earlier', 'later', 'new']);
      const seeded = (
        await fresh.pool.query(
          `select enabled, is_builtin, severity, webhook_ids from notification_alert_rules where event_pattern = 'outbound.unavailable'`
        )
      ).rows;
      expect(seeded).toEqual([{ enabled: true, is_builtin: true, severity: 'critical', webhook_ids: [hook] }]);
    } finally {
      await fresh.drop();
    }
  }, 60_000);
});
