import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { notificationAlertStates, notificationDeliveryLog, notificationWebhooks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  checkOutboundWebhookTarget,
  type OutboundWebhookPolicyService,
} from '@/modules/settings/outbound-webhook-policy.service.js';
import {
  fetchWithPinnedAddresses,
  type OutboundWebhookFetchOptions,
  type OutboundWebhookFetchResponse,
} from '@/modules/settings/outbound-webhook-request.js';
import { foldedUnder } from './notification-folding.js';
import { buildTemplateContext, type NotificationEvent, renderTemplate } from './notification-templates.js';
import { type NotificationWebhookService, redactWebhookUrl } from './notification-webhook.service.js';

const logger = createChildLogger('NotificationDispatcher');

const MAX_RESPONSE_BODY = 2048;
const HTTP_TIMEOUT_MS = 10_000;
/** Shown as the attempt budget of a delivery; a queued delivery is retried while its webhook pauses, see drainWebhook. */
const MAX_DELIVERY_ATTEMPTS = 5;
/** How long a webhook waits after its target could not be reached, by unreachable sends in a row (seconds). */
const UNREACHABLE_BACKOFF_SECONDS = [15, 30, 60, 120, 300];
/** A delivery still queued this long after it was created (its webhook stayed unreachable) fails. */
const MAX_QUEUED_MS = 24 * 60 * 60 * 1000;
/** One sender holds a webhook's queue this long without renewing it; a crashed sender's lease expires. */
const WEBHOOK_LEASE_SECONDS = 60;
/** A rate limit this short is waited out in place; a longer one pauses the webhook. */
const INLINE_RATE_LIMIT_WAIT_MS = 5_000;
/** Short rate limits waited out in place in a row before the webhook pauses instead (the lease is not renewed meanwhile). */
const MAX_INLINE_RATE_LIMIT_WAITS = 3;
/** Without a Retry-After, a rate-limited webhook waits this long. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;
/** Deliveries one drain sends before it yields; the retry job continues. */
const MAX_DELIVERIES_PER_DRAIN = 100;
/** Deliveries still to send: queued by the outbox, or waiting for their webhook. */
export const OPEN_DELIVERY_STATUSES = ['pending', 'retrying'] as const;

type DeliveryRow = typeof notificationDeliveryLog.$inferSelect;
type WebhookRow = typeof notificationWebhooks.$inferSelect;

interface QueuedSendResult {
  statusCode?: number;
  error?: string;
  responseBody?: string;
  responseHeaders?: OutboundWebhookFetchResponse['headers'];
  responseTimeMs: number;
}

export type DeliveryOutcome =
  | { kind: 'delivered' }
  | { kind: 'rejected' }
  | { kind: 'unreachable' }
  | { kind: 'rate_limited'; waitMs: number };

const OUTBOUND_POLICY_ERROR_PREFIX = 'Webhook target blocked by outbound network policy:';

function headerValue(headers: QueuedSendResult['responseHeaders'], name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

/** How long a 429 asks to wait: Retry-After (seconds or a date), else Discord's JSON retry_after (seconds). */
export function rateLimitWaitMs(
  headers: QueuedSendResult['responseHeaders'],
  body: string | undefined,
  now = Date.now()
): number {
  const retryAfter = headerValue(headers, 'retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  try {
    const seconds = Number((JSON.parse(body ?? '') as { retry_after?: unknown }).retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  } catch {
    /* not JSON */
  }
  const reset = Number(headerValue(headers, 'x-ratelimit-reset-after'));
  return Number.isFinite(reset) && reset >= 0 ? Math.ceil(reset * 1000) : DEFAULT_RATE_LIMIT_WAIT_MS;
}

/**
 * What a send means for the queue. No answer (network, DNS, timeout, the outbound policy found no address) and
 * answers that say the target is unavailable (5xx, 408, 425) pause the webhook; 429 pauses it for the time asked;
 * any other non-2xx answer rejects this delivery only.
 */
export function classifyDeliveryResult(result: QueuedSendResult): DeliveryOutcome {
  const status = result.statusCode;
  if (status === undefined) {
    // The outbound policy refusing the target is configuration, not an outage; a name that did not resolve is.
    const policyDenied =
      result.error?.startsWith(OUTBOUND_POLICY_ERROR_PREFIX) && !/did not resolve/.test(result.error);
    return policyDenied ? { kind: 'rejected' } : { kind: 'unreachable' };
  }
  if (status >= 200 && status < 300) return { kind: 'delivered' };
  if (status === 429)
    return { kind: 'rate_limited', waitMs: rateLimitWaitMs(result.responseHeaders, result.responseBody) };
  if (status >= 500 || status === 408 || status === 425) return { kind: 'unreachable' };
  return { kind: 'rejected' };
}

/** Whether a delivery's last try found its webhook unreachable (no answer, 5xx, 408, 425). */
function lastTryUnreachable(delivery: DeliveryRow): boolean {
  if (delivery.attempt <= 0) return false;
  return (
    classifyDeliveryResult({
      statusCode: delivery.responseStatus ?? undefined,
      error: delivery.error ?? undefined,
      responseTimeMs: 0,
    }).kind === 'unreachable'
  );
}

export interface DispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  body: string;
  responseBody?: string;
  responseTimeMs: number;
}

export type DispatchWebhook = {
  id: string;
  url: string;
  method: string;
  bodyTemplate: string | null;
  headers: Record<string, string>;
  signingSecret: string | null;
  signingHeader: string | null;
};

export { fetchWithPinnedAddress } from '@/modules/settings/outbound-webhook-request.js';

export class NotificationDispatcherService {
  constructor(
    private db: DrizzleClient,
    private webhookService: NotificationWebhookService,
    private env: Env,
    private outboundWebhookPolicyService: OutboundWebhookPolicyService,
    private generalSettingsService?: GeneralSettingsService
  ) {}

  getOpfieldUrl(): string {
    return (
      this.generalSettingsService?.getCachedPublicUrl() ??
      (this.env as Env & { PUBLIC_URL?: string }).PUBLIC_URL ??
      (this.env as Env & { MANAGEMENT_DOMAIN?: string }).MANAGEMENT_DOMAIN ??
      ''
    );
  }

  /**
   * Dispatch a notification event to a single webhook.
   * Renders the template, signs the payload, sends the HTTP request,
   * and logs the delivery attempt.
   *
   * @param isTest - if true, returns result directly instead of scheduling retries
   */
  async dispatch(
    webhook: DispatchWebhook,
    event: NotificationEvent,
    isTest = false
  ): Promise<{ success: boolean; statusCode?: number; error?: string; rendered?: string }> {
    const {
      success,
      statusCode: responseStatus,
      error,
      body,
      responseBody,
      responseTimeMs,
    } = await this.send(webhook, event);

    // Log the delivery attempt; a failed non-test send joins the webhook's queue.
    const status = success ? 'success' : isTest ? 'failed' : 'retrying';
    const nextRetryAt = null;

    await this.db.insert(notificationDeliveryLog).values({
      webhookId: webhook.id,
      eventType: event.type,
      severity: event.severity,
      requestUrl: webhook.url,
      requestMethod: webhook.method || 'POST',
      requestBody: body,
      responseStatus: responseStatus ?? null,
      responseBody: responseBody ?? null,
      responseTimeMs,
      attempt: 1,
      maxAttempts: isTest ? 1 : MAX_DELIVERY_ATTEMPTS,
      nextRetryAt,
      status,
      error: error ?? null,
      completedAt: success ? new Date() : null,
    });

    return { success, statusCode: responseStatus, error, rendered: isTest ? body : undefined };
  }

  /**
   * Render, sign and send one event without recording it. Used as is only while the database cannot
   * take the delivery row (an alert about a Postgres outage); recordSentDelivery() logs it afterwards.
   */
  async send(webhook: DispatchWebhook, event: NotificationEvent): Promise<DispatchResult> {
    const body = this.renderBody(webhook, event);

    // Build headers
    const headers: Record<string, string> = { ...webhook.headers };

    // Compute HMAC signature if signing secret is set
    if (webhook.signingSecret) {
      const secret = this.webhookService.decryptSigningSecret(webhook.signingSecret);
      if (secret) {
        const headerName = webhook.signingHeader || 'X-Signature-256';
        headers[headerName] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      }
    }

    // Set Content-Type default if not already set
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    // Send HTTP request
    const startTime = Date.now();
    let responseStatus: number | undefined;
    let responseBody: string | undefined;
    let error: string | undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const method = webhook.method || 'POST';
      const fetchOptions: OutboundWebhookFetchOptions = {
        method,
        headers,
        signal: controller.signal,
      };

      // Only include body for methods that support it
      if (method !== 'GET') {
        fetchOptions.body = body;
      }

      const response = await this.fetchAllowedWebhookTarget(webhook.url, fetchOptions);

      responseStatus = response.status;
      const rawBody = await response.text().catch(() => '');
      responseBody = rawBody.length > MAX_RESPONSE_BODY ? rawBody.slice(0, MAX_RESPONSE_BODY) : rawBody;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (error.includes('abort')) {
        error = `Request timed out after ${HTTP_TIMEOUT_MS}ms`;
      }
    } finally {
      clearTimeout(timeout);
    }

    const responseTimeMs = Date.now() - startTime;
    const success = responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300;

    if (!success) {
      logger.warn('Webhook delivery failed', {
        webhookId: webhook.id,
        url: redactWebhookUrl(webhook.url),
        event: event.type,
        status: responseStatus,
        error,
      });
    }

    return { success, statusCode: responseStatus, error, body, responseBody, responseTimeMs };
  }

  /** Read the outbound webhook policy now, so send() still has it if the database stops answering. */
  async primeOutboundPolicy(): Promise<void> {
    await this.outboundWebhookPolicyService.getConfig();
  }

  /** Record a delivery send() already made, as one finished attempt. */
  async recordSentDelivery(
    tx: DrizzleExecutor,
    webhook: DispatchWebhook,
    event: NotificationEvent,
    result: DispatchResult,
    sentAt: Date,
    alertStateId: string | null = null
  ): Promise<void> {
    await tx.insert(notificationDeliveryLog).values({
      webhookId: webhook.id,
      eventType: event.type,
      severity: event.severity,
      alertStateId,
      requestUrl: webhook.url,
      requestMethod: webhook.method || 'POST',
      requestBody: result.body,
      responseStatus: result.statusCode ?? null,
      responseBody: result.responseBody ?? null,
      responseTimeMs: result.responseTimeMs,
      attempt: 1,
      maxAttempts: 1,
      nextRetryAt: null,
      status: result.success ? 'success' : 'failed',
      error: result.error ?? null,
      createdAt: sentAt,
      completedAt: sentAt,
    });
  }

  private renderBody(webhook: Pick<DispatchWebhook, 'bodyTemplate'>, event: NotificationEvent): string {
    const context = buildTemplateContext(event, this.getOpfieldUrl());
    return webhook.bodyTemplate ? renderTemplate(webhook.bodyTemplate, context) : JSON.stringify(context);
  }

  /**
   * Transactional outbox: record the rendered deliveries in the caller's transaction (alongside the
   * alert state change) so a restart or DB error after commit cannot lose the notification. The rows
   * join each webhook's queue and are sent by drainWebhooks() right after commit, or by the retry job.
   * Returns the webhooks that got a delivery.
   */
  async enqueue(
    tx: DrizzleExecutor,
    webhooks: DispatchWebhook[],
    event: NotificationEvent,
    alertStateId: string | null = null
  ): Promise<string[]> {
    if (webhooks.length === 0) return [];
    const rows = await tx
      .insert(notificationDeliveryLog)
      .values(
        webhooks.map((webhook) => ({
          webhookId: webhook.id,
          eventType: event.type,
          severity: event.severity,
          alertStateId,
          requestUrl: webhook.url,
          requestMethod: webhook.method || 'POST',
          requestBody: this.renderBody(webhook, event),
          attempt: 0,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
          nextRetryAt: null,
          status: 'pending',
        }))
      )
      .returning({ webhookId: notificationDeliveryLog.webhookId });
    return [...new Set(rows.map((row) => row.webhookId))];
  }

  /** Send the queued deliveries of these webhooks now instead of waiting for the retry job's next tick. */
  async drainWebhooks(webhookIds: string[]): Promise<void> {
    await Promise.allSettled([...new Set(webhookIds)].map((id) => this.drainWebhook(id)));
  }

  /**
   * Gateway's outbound connectivity is back: webhooks paused because their target could not be reached are tried
   * now, in order, instead of at the end of their backoff.
   */
  async resumePausedWebhooks(): Promise<void> {
    const resumed = await this.db
      .update(notificationWebhooks)
      .set({ deliveryPausedUntil: null })
      .where(sql`${notificationWebhooks.deliveryPausedUntil} > now()`)
      .returning({ id: notificationWebhooks.id });
    if (resumed.length === 0) return;
    logger.info('Outbound connectivity is back: sending the queued webhook deliveries', { webhooks: resumed.length });
    await this.drainWebhooks(resumed.map((row) => row.id));
  }

  /**
   * Send one webhook's queue in order (seq), one delivery at a time, while holding the webhook's lease: one sender per
   * webhook across Gateway instances, so a later delivery never overtakes an earlier one.
   *
   * - The target cannot be reached (network, DNS, timeout, HTTP 5xx, 408, 425): the whole webhook pauses on a backoff
   *   (UNREACHABLE_BACKOFF_SECONDS) and resumes with the same delivery; nothing behind it is sent meanwhile.
   * - HTTP 429: the webhook pauses for the target's Retry-After (Discord: retry_after) and resumes in order.
   * - Any other non-2xx answer: the target rejected this delivery; it fails and the queue moves on.
   * - A delivery still queued MAX_QUEUED_MS after it was created fails without another try.
   *
   * Alert notifications are matched by alert state (see supersededReason): a firing that could not go out because
   * the webhook was unreachable, and whose resolve is queued by now, is dropped with the resolve (status superseded):
   * the reader never saw the alert, so there is nothing to resolve. A webhook that answered but asked to wait (429)
   * was up: its firing and resolve both go out, in order. A firing folded under another alert that this webhook gets
   * is dropped as well.
   */
  async drainWebhook(webhookId: string): Promise<void> {
    for (let round = 0; round < 2; round++) {
      const token = randomUUID();
      if (!(await this.claimWebhook(webhookId, token))) return;
      try {
        await this.expireStaleDeliveries(webhookId);
        // The queue waited because the webhook could not be reached (not for a rate limit): its backlog is late.
        let backlogAfterOutage: boolean | null = null;
        for (let sent = 0; sent < MAX_DELIVERIES_PER_DRAIN; sent++) {
          // Renewing the lease also reads the webhook as it is configured now.
          const webhook = await this.renewWebhookLease(webhookId, token);
          if (!webhook) return;
          backlogAfterOutage ??= webhook.deliveryFailures > 0;
          const [delivery] = await this.db
            .select()
            .from(notificationDeliveryLog)
            .where(
              and(
                eq(notificationDeliveryLog.webhookId, webhookId),
                inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])
              )
            )
            .orderBy(asc(notificationDeliveryLog.seq))
            .limit(1);
          if (!delivery) break;
          if ((await this.deliverHead(webhook, delivery, backlogAfterOutage)) === 'stop') return;
        }
      } finally {
        await this.db
          .update(notificationWebhooks)
          .set({ deliveryLeaseUntil: null, deliveryLeaseToken: null })
          .where(and(eq(notificationWebhooks.id, webhookId), eq(notificationWebhooks.deliveryLeaseToken, token)));
      }
      // A delivery committed while this sender was finishing found the lease taken; take it along now.
      if (!(await this.hasQueuedDeliveries(webhookId))) return;
    }
  }

  private async claimWebhook(webhookId: string, token: string): Promise<boolean> {
    const claimed = await this.db
      .update(notificationWebhooks)
      .set({
        deliveryLeaseToken: token,
        deliveryLeaseUntil: sql`now() + make_interval(secs => ${WEBHOOK_LEASE_SECONDS})`,
      })
      .where(
        and(
          eq(notificationWebhooks.id, webhookId),
          or(
            isNull(notificationWebhooks.deliveryPausedUntil),
            lte(notificationWebhooks.deliveryPausedUntil, sql`now()`)
          ),
          or(isNull(notificationWebhooks.deliveryLeaseUntil), lte(notificationWebhooks.deliveryLeaseUntil, sql`now()`))
        )
      )
      .returning({ id: notificationWebhooks.id });
    return claimed.length > 0;
  }

  private async renewWebhookLease(webhookId: string, token: string) {
    const [webhook] = await this.db
      .update(notificationWebhooks)
      .set({ deliveryLeaseUntil: sql`now() + make_interval(secs => ${WEBHOOK_LEASE_SECONDS})` })
      .where(and(eq(notificationWebhooks.id, webhookId), eq(notificationWebhooks.deliveryLeaseToken, token)))
      .returning();
    return webhook ?? null;
  }

  private async hasQueuedDeliveries(webhookId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: notificationDeliveryLog.id })
      .from(notificationDeliveryLog)
      .where(
        and(
          eq(notificationDeliveryLog.webhookId, webhookId),
          inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])
        )
      )
      .limit(1);
    return !!row;
  }

  private async expireStaleDeliveries(webhookId: string): Promise<void> {
    await this.db
      .update(notificationDeliveryLog)
      .set({
        status: 'failed',
        error: `Not sent: the webhook could not be reached for ${MAX_QUEUED_MS / 3_600_000} hours`,
        nextRetryAt: null,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(notificationDeliveryLog.webhookId, webhookId),
          inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES]),
          lt(notificationDeliveryLog.createdAt, sql`now() - make_interval(secs => ${MAX_QUEUED_MS / 1000})`)
        )
      );
  }

  /** Finish an open delivery without sending it. */
  private async closeDelivery(ids: string[], status: 'failed' | 'superseded', error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(notificationDeliveryLog)
      .set({ status, error, nextRetryAt: null, completedAt: new Date() })
      .where(
        and(
          inArray(notificationDeliveryLog.id, ids),
          inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])
        )
      );
  }

  /**
   * Whether an alert notification at the head of a webhook's queue is moot, by its alert state:
   * - a firing whose resolve is queued behind it while the webhook could not be reached (no answer, 5xx; this
   *   firing's own last try, or the backlog this drain sends after an outage): both are dropped, the reader never saw
   *   the alert. A webhook that answered 429 was up, so its firing and resolve are both sent;
   * - a firing folded under another alert (Gateway lost outbound connectivity, its node is down) whose own firing
   *   this webhook gets: the parent alert stands for it;
   * - a resolve whose firing never went out to this webhook (failed or dropped): there is nothing to resolve.
   */
  private async supersededReason(
    webhookId: string,
    delivery: DeliveryRow,
    backlogAfterOutage: boolean
  ): Promise<{ ids: string[]; reason: string } | null> {
    const stateId = delivery.alertStateId;
    if (!stateId) return null;
    const sameAlert = (eventType: string) =>
      and(
        eq(notificationDeliveryLog.webhookId, webhookId),
        eq(notificationDeliveryLog.alertStateId, stateId),
        eq(notificationDeliveryLog.eventType, eventType)
      );
    if (delivery.eventType === 'alert.fired') {
      const resolves = await this.db
        .select({ id: notificationDeliveryLog.id })
        .from(notificationDeliveryLog)
        .where(and(sameAlert('alert.resolved'), inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])));
      if (resolves.length > 0 && (backlogAfterOutage || lastTryUnreachable(delivery))) {
        return {
          ids: [delivery.id, ...resolves.map((row) => row.id)],
          reason: 'Not sent: the alert resolved before this webhook could be reached',
        };
      }
      const [state] = await this.db
        .select({ context: notificationAlertStates.context })
        .from(notificationAlertStates)
        .where(eq(notificationAlertStates.id, stateId))
        .limit(1);
      const folded = foldedUnder(state?.context);
      if (!folded) return null;
      const [parentDelivery] = await this.db
        .select({ id: notificationDeliveryLog.id })
        .from(notificationDeliveryLog)
        .where(
          and(
            eq(notificationDeliveryLog.webhookId, webhookId),
            eq(notificationDeliveryLog.alertStateId, folded.stateId),
            eq(notificationDeliveryLog.eventType, 'alert.fired')
          )
        )
        .limit(1);
      return parentDelivery ? { ids: [delivery.id], reason: `Not sent: folded under the alert ${folded.label}` } : null;
    }
    if (delivery.eventType === 'alert.resolved') {
      const [firing] = await this.db
        .select({ status: notificationDeliveryLog.status })
        .from(notificationDeliveryLog)
        .where(sameAlert('alert.fired'))
        .orderBy(desc(notificationDeliveryLog.seq))
        .limit(1);
      if (firing && (firing.status === 'failed' || firing.status === 'superseded')) {
        return { ids: [delivery.id], reason: 'Not sent: the firing notification never went out to this webhook' };
      }
    }
    return null;
  }

  /** Send the delivery at the head of a webhook's queue; 'stop' when the queue must wait. */
  private async deliverHead(
    webhook: WebhookRow,
    delivery: DeliveryRow,
    backlogAfterOutage = false
  ): Promise<'continue' | 'stop'> {
    // Credentials belong to the webhook as configured now. Never send them to a URL the webhook no
    // longer points at, and stop delivering once the webhook is switched off.
    if (!webhook.enabled) {
      await this.db
        .update(notificationDeliveryLog)
        .set({ status: 'failed', error: 'Webhook is disabled', nextRetryAt: null, completedAt: new Date() })
        .where(
          and(
            eq(notificationDeliveryLog.webhookId, webhook.id),
            inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])
          )
        );
      return 'stop';
    }
    if (webhook.url !== delivery.requestUrl) {
      await this.closeDelivery([delivery.id], 'failed', 'Webhook URL changed after this delivery was queued');
      return 'continue';
    }
    const superseded = await this.supersededReason(webhook.id, delivery, backlogAfterOutage);
    if (superseded) {
      await this.closeDelivery(superseded.ids, 'superseded', superseded.reason);
      return 'continue';
    }

    for (let inlineWaits = 0; ; inlineWaits++) {
      const result = await this.sendQueued(webhook, delivery);
      const attempt = delivery.attempt + 1;
      delivery = { ...delivery, attempt };
      const outcome = classifyDeliveryResult(result);
      if (outcome.kind === 'delivered') {
        await this.recordAttempt(delivery.id, attempt, result, { status: 'success', completedAt: new Date() });
        if (attempt > 1) logger.info('Webhook delivery succeeded after waiting', { deliveryId: delivery.id, attempt });
        if (webhook.deliveryFailures > 0 || webhook.deliveryPausedUntil) {
          await this.db
            .update(notificationWebhooks)
            .set({ deliveryFailures: 0, deliveryPausedUntil: null })
            .where(eq(notificationWebhooks.id, webhook.id));
          webhook = { ...webhook, deliveryFailures: 0, deliveryPausedUntil: null };
        }
        return 'continue';
      }
      if (outcome.kind === 'rejected') {
        await this.recordAttempt(delivery.id, attempt, result, {
          status: 'failed',
          error: result.error ?? `The webhook rejected the delivery with HTTP ${result.statusCode}`,
          completedAt: new Date(),
        });
        logger.warn('Webhook rejected a delivery', {
          deliveryId: delivery.id,
          webhookId: webhook.id,
          status: result.statusCode,
        });
        return 'continue';
      }
      if (
        outcome.kind === 'rate_limited' &&
        outcome.waitMs <= INLINE_RATE_LIMIT_WAIT_MS &&
        inlineWaits < MAX_INLINE_RATE_LIMIT_WAITS
      ) {
        await this.recordAttempt(delivery.id, attempt, result, { status: 'retrying', error: 'Rate limited' });
        await sleep(outcome.waitMs);
        continue;
      }
      // A 429 is an answer: the target is up, so the unreachable backoff starts over.
      const failures = outcome.kind === 'rate_limited' ? 0 : webhook.deliveryFailures + 1;
      const pauseSeconds =
        outcome.kind === 'rate_limited'
          ? Math.ceil(outcome.waitMs / 1000)
          : UNREACHABLE_BACKOFF_SECONDS[Math.min(failures - 1, UNREACHABLE_BACKOFF_SECONDS.length - 1)]!;
      const [paused] = await this.db
        .update(notificationWebhooks)
        .set({
          deliveryFailures: failures,
          deliveryPausedUntil: sql`now() + make_interval(secs => ${pauseSeconds})`,
        })
        .where(eq(notificationWebhooks.id, webhook.id))
        .returning({ until: notificationWebhooks.deliveryPausedUntil });
      await this.recordAttempt(delivery.id, attempt, result, {
        status: 'retrying',
        error: outcome.kind === 'rate_limited' ? (result.error ?? 'Rate limited') : (result.error ?? null),
        nextRetryAt: paused?.until ?? null,
      });
      logger.warn('Webhook cannot take deliveries now; its queue waits', {
        deliveryId: delivery.id,
        webhookId: webhook.id,
        url: redactWebhookUrl(webhook.url),
        status: result.statusCode,
        error: result.error,
        pausedForSeconds: pauseSeconds,
      });
      return 'stop';
    }
  }

  private async recordAttempt(
    deliveryId: string,
    attempt: number,
    result: QueuedSendResult,
    outcome: {
      status: 'success' | 'failed' | 'retrying';
      error?: string | null;
      nextRetryAt?: Date | null;
      completedAt?: Date;
    }
  ): Promise<void> {
    await this.db
      .update(notificationDeliveryLog)
      .set({
        attempt,
        responseStatus: result.statusCode ?? null,
        responseBody: result.responseBody ?? null,
        responseTimeMs: result.responseTimeMs,
        status: outcome.status,
        error: outcome.error === undefined ? (result.error ?? null) : outcome.error,
        nextRetryAt: outcome.nextRetryAt ?? null,
        completedAt: outcome.completedAt ?? null,
      })
      .where(
        and(
          eq(notificationDeliveryLog.id, deliveryId),
          inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])
        )
      );
  }

  /** Send a queued delivery against the webhook as it is configured now: its headers and HMAC signature. */
  private async sendQueued(webhook: WebhookRow, delivery: DeliveryRow): Promise<QueuedSendResult> {
    const headers: Record<string, string> = { ...((webhook.headers as Record<string, string>) ?? {}) };
    if (webhook.signingSecret && delivery.requestBody) {
      const secret = this.webhookService.decryptSigningSecret(webhook.signingSecret);
      if (secret) {
        const headerName = webhook.signingHeader || 'X-Signature-256';
        headers[headerName] = `sha256=${createHmac('sha256', secret).update(delivery.requestBody).digest('hex')}`;
      }
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const startTime = Date.now();
    let statusCode: number | undefined;
    let responseBody: string | undefined;
    let responseHeaders: OutboundWebhookFetchResponse['headers'];
    let error: string | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const fetchOptions: OutboundWebhookFetchOptions = {
        method: delivery.requestMethod,
        headers,
        signal: controller.signal,
      };
      if (delivery.requestMethod !== 'GET' && delivery.requestBody) fetchOptions.body = delivery.requestBody;
      const response = await this.fetchAllowedWebhookTarget(webhook.url, fetchOptions);
      statusCode = response.status;
      responseHeaders = response.headers;
      const rawBody = await response.text().catch(() => '');
      responseBody = rawBody.length > MAX_RESPONSE_BODY ? rawBody.slice(0, MAX_RESPONSE_BODY) : rawBody;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (error.includes('abort')) error = `Request timed out after ${HTTP_TIMEOUT_MS}ms`;
    } finally {
      clearTimeout(timeout);
    }
    return { statusCode, error, responseBody, responseHeaders, responseTimeMs: Date.now() - startTime };
  }

  private async fetchAllowedWebhookTarget(
    url: string,
    options: OutboundWebhookFetchOptions
  ): Promise<OutboundWebhookFetchResponse> {
    const policy = await this.outboundWebhookPolicyService.getConfig();
    const result = await checkOutboundWebhookTarget(
      url,
      policy,
      this.env,
      this.generalSettingsService?.getCachedPublicUrl()
    );
    if (!result.allowed) {
      throw new Error(`${OUTBOUND_POLICY_ERROR_PREFIX} ${result.reason ?? 'target is not allowed'}`);
    }
    if (result.resolvedAddresses.length === 0) {
      throw new Error(`${OUTBOUND_POLICY_ERROR_PREFIX} target did not resolve`);
    }
    return fetchWithPinnedAddresses(url, result.resolvedAddresses, options);
  }
}
