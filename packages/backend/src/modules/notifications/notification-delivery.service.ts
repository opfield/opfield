import { and, count, desc, eq, exists, inArray, isNull, lt, lte, notInArray, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationDeliveryLog, notificationWebhooks } from '@/db/schema/index.js';
import { buildWhere } from '@/lib/utils.js';
import { OPEN_DELIVERY_STATUSES } from './notification-dispatcher.service.js';
import { redactWebhookUrl } from './notification-webhook.service.js';

const DELIVERY_BODY_PREVIEW_CHARS = 2048;

function bodyPreview(value: string | null): { preview: string | null; truncated: boolean } {
  if (value == null) return { preview: null, truncated: false };
  return {
    preview: value.length > DELIVERY_BODY_PREVIEW_CHARS ? value.slice(0, DELIVERY_BODY_PREVIEW_CHARS) : value,
    truncated: value.length > DELIVERY_BODY_PREVIEW_CHARS,
  };
}

interface DeliveryListQuery {
  page: number;
  limit: number;
  webhookId?: string;
  status?: string;
  eventType?: string;
}

/** Payloads and the full URL: for every delivery, or per webhook (manage granted on some webhooks or folders only). */
type RevealOption = boolean | ((webhookId: string | null) => boolean);

function reveals(option: RevealOption | undefined, webhookId: string | null): boolean {
  return typeof option === 'function' ? option(webhookId) : !!option;
}

/** Deliveries of the allowed webhooks only (a caller without broad webhook view). */
function allowedWebhookCondition(allowedWebhookIds: readonly string[] | undefined): SQL | null {
  if (!allowedWebhookIds) return null;
  return allowedWebhookIds.length > 0 ? inArray(notificationDeliveryLog.webhookId, [...allowedWebhookIds]) : sql`false`;
}

export class NotificationDeliveryService {
  constructor(private db: DrizzleClient) {}

  async list(
    query: DeliveryListQuery,
    options: { revealSensitive?: RevealOption; allowedWebhookIds?: readonly string[] } = {}
  ) {
    const conditions: SQL[] = [];
    const allowed = allowedWebhookCondition(options.allowedWebhookIds);
    if (allowed) conditions.push(allowed);

    if (query.webhookId) {
      conditions.push(eq(notificationDeliveryLog.webhookId, query.webhookId));
    }
    if (query.status) {
      conditions.push(eq(notificationDeliveryLog.status, query.status));
    }
    if (query.eventType) {
      conditions.push(eq(notificationDeliveryLog.eventType, query.eventType));
    }

    const where = buildWhere(conditions);
    const [totalResult] = await this.db.select({ count: count() }).from(notificationDeliveryLog).where(where);
    const total = totalResult?.count ?? 0;

    const offset = (query.page - 1) * query.limit;
    const rows = await this.db
      .select({
        id: notificationDeliveryLog.id,
        webhookId: notificationDeliveryLog.webhookId,
        webhookName: notificationWebhooks.name,
        eventType: notificationDeliveryLog.eventType,
        severity: notificationDeliveryLog.severity,
        requestUrl: notificationDeliveryLog.requestUrl,
        requestMethod: notificationDeliveryLog.requestMethod,
        requestBody: sql<string | null>`substring(${notificationDeliveryLog.requestBody} from 1 for ${
          DELIVERY_BODY_PREVIEW_CHARS + 1
        })`,
        responseStatus: notificationDeliveryLog.responseStatus,
        responseBody: sql<string | null>`substring(${notificationDeliveryLog.responseBody} from 1 for ${
          DELIVERY_BODY_PREVIEW_CHARS + 1
        })`,
        responseTimeMs: notificationDeliveryLog.responseTimeMs,
        attempt: notificationDeliveryLog.attempt,
        maxAttempts: notificationDeliveryLog.maxAttempts,
        nextRetryAt: notificationDeliveryLog.nextRetryAt,
        status: notificationDeliveryLog.status,
        error: notificationDeliveryLog.error,
        createdAt: notificationDeliveryLog.createdAt,
        completedAt: notificationDeliveryLog.completedAt,
      })
      .from(notificationDeliveryLog)
      .leftJoin(notificationWebhooks, eq(notificationDeliveryLog.webhookId, notificationWebhooks.id))
      .where(where)
      .orderBy(desc(notificationDeliveryLog.createdAt))
      .limit(query.limit)
      .offset(offset);

    return {
      data: rows.map((row) => {
        const request = bodyPreview(row.requestBody);
        const response = bodyPreview(row.responseBody);
        const reveal = reveals(options.revealSensitive, row.webhookId);
        return {
          ...row,
          requestUrl: reveal ? row.requestUrl : redactWebhookUrl(row.requestUrl),
          requestBody: undefined,
          responseBody: undefined,
          requestBodyPreview: reveal ? request.preview : null,
          requestBodyTruncated: reveal ? request.truncated : false,
          responseBodyPreview: reveal ? response.preview : null,
          responseBodyTruncated: reveal ? response.truncated : false,
        };
      }),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  /** `canView`: whether the caller may see a delivery of this webhook (null: the webhook was deleted). */
  async getById(
    id: string,
    options: { revealSensitive?: RevealOption; canView?: (webhookId: string | null) => boolean } = {}
  ) {
    const [row] = await this.db
      .select()
      .from(notificationDeliveryLog)
      .where(eq(notificationDeliveryLog.id, id))
      .limit(1);
    if (!row) return null;
    if (options.canView && !options.canView(row.webhookId)) return null;
    if (reveals(options.revealSensitive, row.webhookId)) return row;
    return {
      ...row,
      requestUrl: redactWebhookUrl(row.requestUrl),
      requestBody: null,
      responseBody: null,
    };
  }

  /** Webhooks with queued deliveries that may send now: not paused, and no other sender holds their queue. */
  async getWebhooksDue(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: notificationWebhooks.id })
      .from(notificationWebhooks)
      .where(
        and(
          or(
            isNull(notificationWebhooks.deliveryPausedUntil),
            lte(notificationWebhooks.deliveryPausedUntil, sql`now()`)
          ),
          or(isNull(notificationWebhooks.deliveryLeaseUntil), lte(notificationWebhooks.deliveryLeaseUntil, sql`now()`)),
          exists(
            this.db
              .select({ id: notificationDeliveryLog.id })
              .from(notificationDeliveryLog)
              .where(
                and(
                  eq(notificationDeliveryLog.webhookId, notificationWebhooks.id),
                  inArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])
                )
              )
          )
        )
      )
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Clean old delivery log entries (for housekeeping) */
  async cleanOldEntries(retentionDays: number): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - retentionDays);

    const result = await this.db
      .delete(notificationDeliveryLog)
      .where(
        and(
          lt(notificationDeliveryLog.createdAt, threshold),
          notInArray(notificationDeliveryLog.status, [...OPEN_DELIVERY_STATUSES])
        )
      )
      .returning({ id: notificationDeliveryLog.id });

    return result.length;
  }

  /** Delivery stats for UI dashboard */
  async getStats(webhookId?: string, options: { allowedWebhookIds?: readonly string[] } = {}) {
    const conditions: SQL[] = [];
    const allowed = allowedWebhookCondition(options.allowedWebhookIds);
    if (allowed) conditions.push(allowed);
    if (webhookId) {
      conditions.push(eq(notificationDeliveryLog.webhookId, webhookId));
    }

    const where = buildWhere(conditions);

    const [totalResult] = await this.db.select({ count: count() }).from(notificationDeliveryLog).where(where);
    const [successResult] = await this.db
      .select({ count: count() })
      .from(notificationDeliveryLog)
      .where(buildWhere([...conditions, eq(notificationDeliveryLog.status, 'success')]));
    const [failedResult] = await this.db
      .select({ count: count() })
      .from(notificationDeliveryLog)
      .where(buildWhere([...conditions, eq(notificationDeliveryLog.status, 'failed')]));
    const [retryingResult] = await this.db
      .select({ count: count() })
      .from(notificationDeliveryLog)
      .where(buildWhere([...conditions, eq(notificationDeliveryLog.status, 'retrying')]));

    return {
      total: totalResult?.count ?? 0,
      success: successResult?.count ?? 0,
      failed: failedResult?.count ?? 0,
      retrying: retryingResult?.count ?? 0,
    };
  }
}
