import { count, eq, ilike, inArray, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationAlertRules, notificationWebhooks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  type AlertRuleListQuery,
  type CreateAlertRuleInput,
  isOnceADayAlertRule,
  ONCE_A_DAY_ALERT_WINDOWS,
  type UpdateAlertRuleInput,
} from './notification-alert-rule.schemas.js';
import { catalogMismatch } from './notification-catalog.js';

const logger = createChildLogger('AlertRuleService');

export class NotificationAlertRuleService {
  private eventBus?: EventBusService;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitRule(id: string, action: string) {
    this.eventBus?.publish('notification.alert-rule.changed', { id, action });
  }

  async list(query: AlertRuleListQuery) {
    const conditions: SQL[] = [];

    if (query.search) {
      conditions.push(ilike(notificationAlertRules.name, `%${query.search}%`));
    }
    if (query.type) {
      conditions.push(eq(notificationAlertRules.type, query.type));
    }
    if (query.category) {
      conditions.push(eq(notificationAlertRules.category, query.category));
    }
    if (query.enabled !== undefined) {
      conditions.push(eq(notificationAlertRules.enabled, query.enabled));
    }

    const where = buildWhere(conditions);
    const [totalResult] = await this.db.select({ count: count() }).from(notificationAlertRules).where(where);
    const total = totalResult?.count ?? 0;

    const offset = (query.page - 1) * query.limit;
    const rows = await this.db
      .select()
      .from(notificationAlertRules)
      .where(where)
      .orderBy(notificationAlertRules.createdAt)
      .limit(query.limit)
      .offset(offset);

    return {
      data: rows,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  /** Webhooks a rule notifies must exist; ids the rule already had (a webhook deleted since) are kept as they are. */
  private async assertWebhooksExist(webhookIds: string[], alreadyOnRule: unknown = []): Promise<void> {
    const kept = new Set(Array.isArray(alreadyOnRule) ? alreadyOnRule : []);
    const wanted = [...new Set(webhookIds)].filter((id) => !kept.has(id));
    if (wanted.length === 0) return;
    const found = await this.db
      .select({ id: notificationWebhooks.id })
      .from(notificationWebhooks)
      .where(inArray(notificationWebhooks.id, wanted));
    const known = new Set(found.map((row) => row.id));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new AppError(
        400,
        'WEBHOOK_NOT_FOUND',
        `No webhook has the id ${missing.join(', ')}; create the webhook first or pick an existing one`
      );
    }
  }

  /** A rule watches a metric or event its category has; anything else would be accepted and never evaluated. */
  private assertInCatalog(rule: Parameters<typeof catalogMismatch>[0]): void {
    const mismatch = catalogMismatch(rule);
    if (mismatch) throw new AppError(400, 'INVALID_ALERT_RULE', mismatch);
  }

  async getById(id: string) {
    const [rule] = await this.db
      .select()
      .from(notificationAlertRules)
      .where(eq(notificationAlertRules.id, id))
      .limit(1);
    if (!rule) throw new AppError(404, 'NOT_FOUND', 'Alert rule not found');
    return rule;
  }

  async create(input: CreateAlertRuleInput, userId: string) {
    // API, AI and MCP all create through here; normalize windows a once-a-day rule can never satisfy.
    if (isOnceADayAlertRule(input)) input = { ...input, ...ONCE_A_DAY_ALERT_WINDOWS };
    this.assertInCatalog(input);
    await this.assertWebhooksExist(input.webhookIds);
    const [rule] = await this.db
      .insert(notificationAlertRules)
      .values({
        name: input.name,
        enabled: input.enabled,
        type: input.type,
        category: input.category,
        severity: input.severity,
        metric: input.metric ?? null,
        metricTarget: input.metricTarget ?? null,
        operator: input.operator ?? null,
        thresholdValue: input.thresholdValue ?? null,
        durationSeconds: input.durationSeconds,
        fireThresholdPercent: input.fireThresholdPercent,
        resolveAfterSeconds: input.resolveAfterSeconds,
        resolveThresholdPercent: input.resolveThresholdPercent,
        eventPattern: input.eventPattern ?? null,
        resourceIds: input.resourceIds,
        messageTemplate: input.messageTemplate ?? null,
        resolveMessageTemplate: input.resolveMessageTemplate?.trim() ? input.resolveMessageTemplate : null,
        webhookIds: input.webhookIds,
        cooldownSeconds: input.cooldownSeconds,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'notification_rule_created',
      resourceType: 'notification_alert_rule',
      resourceId: rule.id,
      details: { name: input.name, type: input.type, category: input.category },
    });

    logger.info('Alert rule created', { id: rule.id, name: input.name, type: input.type, category: input.category });
    this.emitRule(rule.id, 'created');
    return rule;
  }

  async update(id: string, input: UpdateAlertRuleInput, userId: string) {
    const existing = await this.getById(id);
    // Only a changed metric or event is checked: a rule saved by an older release keeps working for other edits.
    if (
      (existing.type === 'threshold' && input.metric !== undefined) ||
      (existing.type === 'event' && input.eventPattern !== undefined)
    ) {
      this.assertInCatalog({
        type: existing.type,
        category: existing.category,
        metric: input.metric ?? existing.metric,
        eventPattern: input.eventPattern ?? existing.eventPattern,
      });
    }
    if (input.webhookIds !== undefined) await this.assertWebhooksExist(input.webhookIds, existing.webhookIds);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.severity !== undefined) updates.severity = input.severity;
    if (input.metric !== undefined) updates.metric = input.metric;
    if (input.metricTarget !== undefined) updates.metricTarget = input.metricTarget;
    if (input.operator !== undefined) updates.operator = input.operator;
    if (input.thresholdValue !== undefined) updates.thresholdValue = input.thresholdValue;
    if (input.durationSeconds !== undefined) updates.durationSeconds = input.durationSeconds;
    if (input.fireThresholdPercent !== undefined) updates.fireThresholdPercent = input.fireThresholdPercent;
    if (input.resolveAfterSeconds !== undefined) updates.resolveAfterSeconds = input.resolveAfterSeconds;
    if (input.resolveThresholdPercent !== undefined) updates.resolveThresholdPercent = input.resolveThresholdPercent;
    if (input.eventPattern !== undefined) updates.eventPattern = input.eventPattern;
    if (input.resourceIds !== undefined) updates.resourceIds = input.resourceIds;
    if (input.messageTemplate !== undefined) updates.messageTemplate = input.messageTemplate;
    if (input.resolveMessageTemplate !== undefined) {
      updates.resolveMessageTemplate = input.resolveMessageTemplate?.trim() ? input.resolveMessageTemplate : null;
    }
    if (input.webhookIds !== undefined) updates.webhookIds = input.webhookIds;
    if (input.cooldownSeconds !== undefined) updates.cooldownSeconds = input.cooldownSeconds;
    if (isOnceADayAlertRule({ ...existing, metric: input.metric ?? existing.metric })) {
      for (const [key, value] of Object.entries(ONCE_A_DAY_ALERT_WINDOWS)) {
        if (updates[key] !== undefined || existing[key as keyof typeof existing] !== value) updates[key] = value;
      }
    }

    const [updated] = await this.db
      .update(notificationAlertRules)
      .set(updates)
      .where(eq(notificationAlertRules.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'notification_rule_updated',
      resourceType: 'notification_alert_rule',
      resourceId: id,
      details: { name: existing.name, changes: Object.keys(updates).filter((k) => k !== 'updatedAt') },
    });

    logger.info('Alert rule updated', { id, name: updated.name });
    this.emitRule(id, 'updated');
    return updated;
  }

  async delete(id: string, userId: string) {
    const existing = await this.getById(id);
    await this.db.delete(notificationAlertRules).where(eq(notificationAlertRules.id, id));

    await this.auditService.log({
      userId,
      action: 'notification_rule_deleted',
      resourceType: 'notification_alert_rule',
      resourceId: id,
      details: { name: existing.name },
    });

    logger.info('Alert rule deleted', { id, name: existing.name });
    this.emitRule(id, 'deleted');
  }

  async getEnabledThresholdRules() {
    return this.db
      .select()
      .from(notificationAlertRules)
      .where(buildWhere([eq(notificationAlertRules.enabled, true), eq(notificationAlertRules.type, 'threshold')]));
  }

  async getEnabledEventRules() {
    return this.db
      .select()
      .from(notificationAlertRules)
      .where(buildWhere([eq(notificationAlertRules.enabled, true), eq(notificationAlertRules.type, 'event')]));
  }
}
