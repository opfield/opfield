import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { OutboundWebhookFetchResponse } from '@/modules/settings/outbound-webhook-request.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';
import { buildNotificationTemplateContext, type NotificationEvent } from './notification-templates.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

type Answer = { status: number; body?: string; headers?: Record<string, string> } | Error;

function event(type: 'alert.fired' | 'alert.resolved', message: string): NotificationEvent {
  const resource = { type: 'proxy', id: null, key: 'p1', name: 'example.com' };
  const context = buildNotificationTemplateContext({
    notification: { type, title: 'Proxy host down', message, timestamp: new Date().toISOString() },
    alert: {
      id: 'rule',
      name: 'Proxy host down',
      status: type === 'alert.fired' ? 'firing' : 'resolved',
      severity: 'critical',
    },
    resource,
  });
  return { type, title: 'Proxy host down', message, severity: 'critical', resource, context, timestamp: '' };
}

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): webhook deliveries go out per webhook in order, the whole webhook
 * pauses while its target cannot be reached, a firing that never went out is dropped with its resolve, and the
 * queue state lives in the database (a second sender or a restarted one continues it).
 */
describe.skipIf(!url)('Notification delivery queue on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let webhookId = '';
  let ruleId = '';
  let sent: string[] = [];
  let answers: Answer[] = [];

  /** A dispatcher whose HTTP sends record the body and answer from `answers` (200 once they run out). */
  const dispatcher = () => {
    const service = new NotificationDispatcherService(
      db,
      { decryptSigningSecret: () => null } as never,
      {} as never,
      {} as never
    );
    (service as unknown as { fetchAllowedWebhookTarget: unknown }).fetchAllowedWebhookTarget = async (
      _url: string,
      options: { body?: string }
    ): Promise<OutboundWebhookFetchResponse> => {
      const answer = answers.shift() ?? { status: 200 };
      if (answer instanceof Error) throw answer;
      sent.push(String(options.body));
      return { status: answer.status, text: async () => answer.body ?? '', headers: answer.headers };
    };
    return service;
  };

  const newState = async (status = 'firing', context: Record<string, unknown> = {}) =>
    (
      await q(
        `insert into notification_alert_states (rule_id, resource_type, resource_id, status, severity, context)
         values ($1, 'proxy', gen_random_uuid()::text, $2, 'critical', $3) returning id`,
        [ruleId, status, JSON.stringify(context)]
      )
    ).rows[0].id as string;

  const enqueue = (
    service: NotificationDispatcherService,
    stateId: string | null,
    type: 'alert.fired' | 'alert.resolved',
    message: string
  ) =>
    service.enqueue(
      db,
      [
        {
          id: webhookId,
          url: 'https://hooks.example.test/x',
          method: 'POST',
          bodyTemplate: '{{notification.message}}',
          headers: {},
          signingSecret: null,
          signingHeader: null,
        },
      ],
      event(type, message),
      stateId
    );

  const rows = async () =>
    (
      await q(
        `select request_body, status, attempt, error from notification_delivery_log where webhook_id = $1 order by seq`,
        [webhookId]
      )
    ).rows as Array<{
      request_body: string;
      status: string;
      attempt: number;
      error: string | null;
    }>;

  const unpause = () => q(`update notification_webhooks set delivery_paused_until = null where id = $1`, [webhookId]);

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'notification_queue');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    sent = [];
    answers = [];
    webhookId = (
      await q(
        `insert into notification_webhooks (name, url, method, body_template) values ('Discord', 'https://hooks.example.test/x', 'POST', '{{notification.message}}') returning id`
      )
    ).rows[0].id;
    ruleId = (
      await q(
        `insert into notification_alert_rules (name, enabled, type, category, event_pattern, webhook_ids)
         values ('Proxy host down', true, 'event', 'proxy', 'health.offline', $1) returning id`,
        [JSON.stringify([webhookId])]
      )
    ).rows[0].id;
  });

  it('sends a webhook queue in order and pauses the whole webhook while it cannot be reached', async () => {
    const service = dispatcher();
    await enqueue(service, await newState(), 'alert.fired', 'first');
    await enqueue(service, await newState(), 'alert.fired', 'second');
    answers = [
      new Error('Webhook target blocked by outbound network policy: Webhook target did not resolve to an IP address'),
    ];

    await service.drainWebhook(webhookId);
    expect(sent).toEqual([]);
    expect((await rows()).map((row) => [row.request_body, row.status, row.attempt])).toEqual([
      ['first', 'retrying', 1],
      ['second', 'pending', 0],
    ]);
    const [paused] = (
      await q(
        `select delivery_failures, delivery_paused_until > now() as paused from notification_webhooks where id = $1`,
        [webhookId]
      )
    ).rows;
    expect(paused).toEqual({ delivery_failures: 1, paused: true });

    // Still paused: nothing is tried.
    await service.drainWebhook(webhookId);
    expect(sent).toEqual([]);

    await unpause();
    await service.drainWebhook(webhookId);
    expect(sent).toEqual(['first', 'second']);
    expect((await rows()).map((row) => row.status)).toEqual(['success', 'success']);
    const [reset] = (
      await q(`select delivery_failures, delivery_paused_until from notification_webhooks where id = $1`, [webhookId])
    ).rows;
    expect(reset).toEqual({ delivery_failures: 0, delivery_paused_until: null });
  });

  it('drops a firing that never went out together with its resolve', async () => {
    const service = dispatcher();
    const down = await newState();
    const other = await newState();
    answers = [new Error('connect ECONNREFUSED')];
    await enqueue(service, down, 'alert.fired', 'down fired');
    await service.drainWebhook(webhookId);
    await enqueue(service, other, 'alert.fired', 'other fired');
    await enqueue(service, down, 'alert.resolved', 'down resolved');

    await unpause();
    await service.drainWebhook(webhookId);
    expect(sent).toEqual(['other fired']);
    expect((await rows()).map((row) => [row.request_body, row.status])).toEqual([
      ['down fired', 'superseded'],
      ['other fired', 'success'],
      ['down resolved', 'superseded'],
    ]);
  });

  it('sends a firing and its resolve in order when the webhook was only rate limited', async () => {
    const service = dispatcher();
    const short = await newState();
    answers = [{ status: 429, headers: { 'Retry-After': '120' } }];
    await enqueue(service, short, 'alert.fired', 'short fired');
    await service.drainWebhook(webhookId);
    await enqueue(service, short, 'alert.resolved', 'short resolved');
    expect(sent).toEqual(['short fired']);

    await unpause();
    await service.drainWebhook(webhookId);
    expect(sent).toEqual(['short fired', 'short fired', 'short resolved']);
    expect((await rows()).map((row) => [row.request_body, row.status, row.attempt])).toEqual([
      ['short fired', 'success', 2],
      ['short resolved', 'success', 1],
    ]);
  });

  it('a rate limit after an outage resets the backoff, so the backlog is no longer treated as late', async () => {
    const service = dispatcher();
    const alert = await newState();
    answers = [new Error('connect ECONNREFUSED'), { status: 429, headers: { 'Retry-After': '60' } }];
    await enqueue(service, alert, 'alert.fired', 'fired');
    await service.drainWebhook(webhookId);
    await unpause();
    await service.drainWebhook(webhookId);
    const [webhook] = (await q(`select delivery_failures from notification_webhooks where id = $1`, [webhookId])).rows;
    expect(webhook.delivery_failures).toBe(0);
    await enqueue(service, alert, 'alert.resolved', 'resolved');
    await unpause();
    await service.drainWebhook(webhookId);
    expect(sent).toEqual(['fired', 'fired', 'resolved']);
  });

  it('sends a resolve after its delivered firing, and drops a resolve whose firing was rejected', async () => {
    const service = dispatcher();
    const delivered = await newState();
    const rejected = await newState();
    await enqueue(service, delivered, 'alert.fired', 'a fired');
    await enqueue(service, rejected, 'alert.fired', 'b fired');
    answers = [{ status: 204 }, { status: 400, body: 'bad embed' }];
    await service.drainWebhook(webhookId);
    await enqueue(service, delivered, 'alert.resolved', 'a resolved');
    await enqueue(service, rejected, 'alert.resolved', 'b resolved');
    await service.drainWebhook(webhookId);

    expect(sent).toEqual(['a fired', 'b fired', 'a resolved']);
    expect((await rows()).map((row) => row.status)).toEqual(['success', 'failed', 'success', 'superseded']);
  });

  it('waits out a short rate limit in place and pauses the webhook for a long one', async () => {
    const service = dispatcher();
    await enqueue(service, await newState(), 'alert.fired', 'one');
    await enqueue(service, await newState(), 'alert.fired', 'two');
    answers = [
      { status: 429, body: '{"retry_after": 0.05}' },
      { status: 204 },
      { status: 429, headers: { 'Retry-After': '120' } },
    ];
    await service.drainWebhook(webhookId);
    expect(sent).toEqual(['one', 'one', 'two']);
    expect((await rows()).map((row) => [row.status, row.attempt])).toEqual([
      ['success', 2],
      ['retrying', 1],
    ]);
    const [pause] = (
      await q(
        `select extract(epoch from delivery_paused_until - now()) as seconds, delivery_failures from notification_webhooks where id = $1`,
        [webhookId]
      )
    ).rows;
    expect(Number(pause.seconds)).toBeGreaterThan(100);
    expect(pause.delivery_failures).toBe(0);
  });

  it('folds a firing under a parent alert this webhook gets, and sends it when the webhook does not get the parent', async () => {
    const service = dispatcher();
    const parent = await newState();
    const child = await newState('firing', { folded: { stateId: parent, kind: 'node', label: 'Node down (node-1)' } });
    const lone = await newState('firing', {
      folded: { stateId: await newState(), kind: 'node', label: 'Node down (node-2)' },
    });
    await enqueue(service, parent, 'alert.fired', 'node down');
    await enqueue(service, child, 'alert.fired', 'route down');
    await enqueue(service, lone, 'alert.fired', 'other route down');
    await service.drainWebhook(webhookId);
    expect(sent).toEqual(['node down', 'other route down']);
    expect((await rows())[1]).toMatchObject({
      status: 'superseded',
      error: 'Not sent: folded under the alert Node down (node-1)',
    });
  });

  it('keeps one sender per webhook: a second sender waits, an expired lease of a crashed one is taken over', async () => {
    const first = dispatcher();
    const second = dispatcher();
    for (const message of ['1', '2', '3', '4']) await enqueue(first, await newState(), 'alert.fired', message);
    await Promise.all([first.drainWebhook(webhookId), second.drainWebhook(webhookId)]);
    expect(sent).toEqual(['1', '2', '3', '4']);

    await enqueue(first, await newState(), 'alert.fired', '5');
    await q(
      `update notification_webhooks set delivery_lease_until = now() + interval '1 minute', delivery_lease_token = gen_random_uuid() where id = $1`,
      [webhookId]
    );
    await second.drainWebhook(webhookId);
    expect(sent).toEqual(['1', '2', '3', '4']);
    await q(`update notification_webhooks set delivery_lease_until = now() - interval '1 second' where id = $1`, [
      webhookId,
    ]);
    await second.drainWebhook(webhookId);
    expect(sent).toEqual(['1', '2', '3', '4', '5']);
  });

  it('fails deliveries still queued a day later and stops at a disabled webhook', async () => {
    const service = dispatcher();
    await enqueue(service, await newState(), 'alert.fired', 'old');
    await q(`update notification_delivery_log set created_at = now() - interval '25 hours' where webhook_id = $1`, [
      webhookId,
    ]);
    await enqueue(service, await newState(), 'alert.fired', 'new');
    await q(`update notification_webhooks set enabled = false where id = $1`, [webhookId]);
    await service.drainWebhook(webhookId);
    expect(sent).toEqual([]);
    expect((await rows()).map((row) => [row.status, row.error])).toEqual([
      ['failed', 'Not sent: the webhook could not be reached for 24 hours'],
      ['failed', 'Webhook is disabled'],
    ]);
  });
});
