import { count, eq, ilike, inArray, isNull, max, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationAlertRules, notificationWebhooks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateWebhookInput, UpdateWebhookInput, WebhookListQuery } from './notification-webhook.schemas.js';

const logger = createChildLogger('WebhookService');

/** Reveal for every webhook, or per webhook (manage granted on some webhooks or folders only). */
type RevealOption = boolean | ((webhookId: string) => boolean);

type WebhookViewOptions = {
  revealHeaders?: RevealOption;
  revealUrl?: RevealOption;
};

function reveals(option: RevealOption | undefined, webhookId: string): boolean {
  return typeof option === 'function' ? option(webhookId) : !!option;
}

export function redactWebhookHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers;
  return Object.fromEntries(Object.keys(headers).map((key) => [key, '********']));
}

export function redactWebhookUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}/********`;
  } catch {
    return '********';
  }
}

export class NotificationWebhookService {
  private eventBus?: EventBusService;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private cryptoService: CryptoService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitWebhook(id: string, action: string) {
    this.eventBus?.publish('notification.webhook.changed', { id, action });
  }

  /** `allowedIds`: the webhooks a caller without broad view may list (granted one by one or through their folder). */
  async list(query: WebhookListQuery, options: WebhookViewOptions & { allowedIds?: readonly string[] } = {}) {
    const conditions: SQL[] = [];
    if (options.allowedIds) {
      if (options.allowedIds.length === 0) {
        return { data: [], total: 0, page: query.page, limit: query.limit, totalPages: 0 };
      }
      conditions.push(inArray(notificationWebhooks.id, [...options.allowedIds]));
    }
    if (query.folderId) {
      conditions.push(eq(notificationWebhooks.folderId, query.folderId));
    }

    if (query.search) {
      conditions.push(ilike(notificationWebhooks.name, `%${query.search}%`));
    }
    if (query.enabled !== undefined) {
      conditions.push(eq(notificationWebhooks.enabled, query.enabled));
    }

    const where = buildWhere(conditions);
    const [totalResult] = await this.db.select({ count: count() }).from(notificationWebhooks).where(where);
    const total = totalResult?.count ?? 0;

    const offset = (query.page - 1) * query.limit;
    const rows = await this.db
      .select()
      .from(notificationWebhooks)
      .where(where)
      .orderBy(notificationWebhooks.createdAt)
      .limit(query.limit)
      .offset(offset);

    const data = rows.map((r) => ({
      ...r,
      url: reveals(options.revealUrl, r.id) ? r.url : redactWebhookUrl(r.url),
      signingSecret: r.signingSecret ? '********' : null,
      headers: reveals(options.revealHeaders, r.id) ? r.headers : redactWebhookHeaders(r.headers),
    }));

    return {
      data,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getById(id: string, options: WebhookViewOptions = {}) {
    const [webhook] = await this.db.select().from(notificationWebhooks).where(eq(notificationWebhooks.id, id)).limit(1);
    if (!webhook) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
    return {
      ...webhook,
      url: reveals(options.revealUrl, webhook.id) ? webhook.url : redactWebhookUrl(webhook.url),
      signingSecret: webhook.signingSecret ? '********' : null,
      headers: reveals(options.revealHeaders, webhook.id) ? webhook.headers : redactWebhookHeaders(webhook.headers),
    };
  }

  /** Get raw webhook (with encrypted secret) for dispatch */
  async getRaw(id: string) {
    const [webhook] = await this.db.select().from(notificationWebhooks).where(eq(notificationWebhooks.id, id)).limit(1);
    if (!webhook) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
    return webhook;
  }

  /** Get multiple raw webhooks by IDs (for dispatch) */
  async getRawByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.db.select().from(notificationWebhooks).where(inArray(notificationWebhooks.id, ids));
  }

  async create(input: CreateWebhookInput, userId: string) {
    let encryptedSecret: string | null = null;
    if (input.signingSecret) {
      const enc = this.cryptoService.encryptPrivateKey(input.signingSecret);
      encryptedSecret = JSON.stringify(enc);
    }

    const folderId = input.folderId ?? null;
    const [webhook] = await this.db
      .insert(notificationWebhooks)
      .values({
        folderId,
        sortOrder: await this.nextSortOrder(folderId),
        name: input.name,
        url: input.url,
        method: input.method,
        enabled: input.enabled,
        signingSecret: encryptedSecret,
        signingHeader: input.signingHeader,
        templatePreset: input.templatePreset ?? null,
        bodyTemplate: input.bodyTemplate ?? null,
        headers: input.headers,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'notification_webhook_created',
      resourceType: 'notification_webhook',
      resourceId: webhook.id,
      // Webhook URLs routinely embed bearer tokens (Slack, Discord, Telegram); audit only the redacted form.
      details: { name: input.name, url: redactWebhookUrl(input.url), folderId },
    });

    logger.info('Webhook created', { id: webhook.id, name: input.name });
    this.emitWebhook(webhook.id, 'created');
    return { ...webhook, signingSecret: webhook.signingSecret ? '********' : null };
  }

  /** A new webhook goes to the end of its folder (or of the ungrouped webhooks). */
  private async nextSortOrder(folderId: string | null): Promise<number> {
    const [row] = await this.db
      .select({ last: max(notificationWebhooks.sortOrder) })
      .from(notificationWebhooks)
      .where(folderId ? eq(notificationWebhooks.folderId, folderId) : isNull(notificationWebhooks.folderId));
    return row?.last == null ? 0 : row.last + 1;
  }

  async update(id: string, input: UpdateWebhookInput, userId: string) {
    const existing = await this.getRaw(id);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.url !== undefined) updates.url = input.url;
    if (input.method !== undefined) updates.method = input.method;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.signingHeader !== undefined) updates.signingHeader = input.signingHeader;
    if (input.templatePreset !== undefined) updates.templatePreset = input.templatePreset;
    if (input.bodyTemplate !== undefined) updates.bodyTemplate = input.bodyTemplate;
    if (input.headers !== undefined) updates.headers = input.headers;

    if (input.signingSecret === null) {
      updates.signingSecret = null;
    } else if (input.signingSecret) {
      const enc = this.cryptoService.encryptPrivateKey(input.signingSecret);
      updates.signingSecret = JSON.stringify(enc);
    }

    const [updated] = await this.db
      .update(notificationWebhooks)
      .set(updates)
      .where(eq(notificationWebhooks.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'notification_webhook_updated',
      resourceType: 'notification_webhook',
      resourceId: id,
      details: { name: existing.name, changes: Object.keys(updates).filter((k) => k !== 'updatedAt') },
    });

    logger.info('Webhook updated', { id, name: updated.name });
    this.emitWebhook(id, 'updated');
    return { ...updated, signingSecret: updated.signingSecret ? '********' : null };
  }

  async delete(id: string, userId: string) {
    const existing = await this.getById(id);
    // Grants naming the webhook go with it.
    await transactionWithScopeCleanup(this.db, async (tx) => {
      await tx.delete(notificationWebhooks).where(eq(notificationWebhooks.id, id));
      // Alert rules stop naming the deleted webhook (a rule only takes ids of existing webhooks).
      await tx
        .update(notificationAlertRules)
        .set({
          webhookIds: sql`(select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(${notificationAlertRules.webhookIds}) where value <> to_jsonb(${id}::text))`,
        })
        .where(sql`${notificationAlertRules.webhookIds} @> ${JSON.stringify([id])}::jsonb`);
    });

    await this.auditService.log({
      userId,
      action: 'notification_webhook_deleted',
      resourceType: 'notification_webhook',
      resourceId: id,
      details: { name: existing.name },
    });

    logger.info('Webhook deleted', { id, name: existing.name });
    this.emitWebhook(id, 'deleted');
  }

  decryptSigningSecret(encryptedJson: string): string | null {
    try {
      const parsed = JSON.parse(encryptedJson);
      return this.cryptoService.decryptPrivateKey(parsed);
    } catch {
      return null;
    }
  }
}
