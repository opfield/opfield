import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateSiemDestinationSchema,
  SiemDeliveryListQuerySchema,
  SiemDestinationListQuerySchema,
  UpdateSiemDestinationSchema,
} from '@/modules/audit/siem.schemas.js';
import { ALERT_CATEGORIES } from '@/modules/notifications/notification.constants.js';
import { listFiredAlerts } from '@/modules/notifications/notification-alert-list.js';
import {
  createAlertRuleWithEffects,
  deleteAlertRuleWithEffects,
  updateAlertRuleWithEffects,
} from '@/modules/notifications/notification-alert-rule.mutations.js';
import {
  AlertListQuerySchema,
  AlertRuleListQuerySchema,
  CreateAlertRuleSchema,
  UpdateAlertRuleSchema,
} from '@/modules/notifications/notification-alert-rule.schemas.js';
import { DeliveryListQuerySchema } from '@/modules/notifications/notification-delivery.schemas.js';
import {
  ALERT_RESOURCE_CATEGORIES,
  type AlertResourceCategory,
  listAlertCategoryResources,
} from '@/modules/notifications/notification-rule-resources.js';
import {
  buildSampleEvent,
  buildTemplateContext,
  renderTemplate,
  TEMPLATE_PRESETS,
} from '@/modules/notifications/notification-templates.js';
import {
  CreateWebhookSchema,
  UpdateWebhookSchema,
  WebhookListQuerySchema,
} from '@/modules/notifications/notification-webhook.schemas.js';
import type { User } from '@/types.js';
import { agentPage, agentPageLimit } from './ai.service-helpers.js';

export const SIEM_NOTIFICATION_TOOL_NAMES = new Set([
  'list_siem_destinations',
  'get_siem_destination',
  'create_siem_destination',
  'update_siem_destination',
  'delete_siem_destination',
  'test_siem_destination',
  'list_siem_deliveries',
  'get_siem_delivery',
  'requeue_siem_delivery',
]);

export const NOTIFICATION_TOOL_NAMES = new Set([
  'list_alert_rules',
  'list_alerts',
  'get_alert_rule',
  'create_alert_rule',
  'update_alert_rule',
  'delete_alert_rule',
  'list_webhooks',
  'create_webhook',
  'update_webhook',
  'delete_webhook',
  'test_webhook',
  'list_webhook_deliveries',
  'get_delivery_stats',
  'manage_notifications',
  ...SIEM_NOTIFICATION_TOOL_NAMES,
]);

export interface NotificationToolContext {
  notifRuleService?: import('@/modules/notifications/notification-alert-rule.service.js').NotificationAlertRuleService;
  notifWebhookService?: import('@/modules/notifications/notification-webhook.service.js').NotificationWebhookService;
  notifDeliveryService?: import('@/modules/notifications/notification-delivery.service.js').NotificationDeliveryService;
  notifDispatcherService?: import('@/modules/notifications/notification-dispatcher.service.js').NotificationDispatcherService;
  siemDestinationService?: import('@/modules/audit/siem-destination.service.js').SiemDestinationService;
  siemDeliveryService?: import('@/modules/audit/siem-delivery.service.js').SiemDeliveryService;
  generalSettingsService?: import('@/modules/settings/general-settings.service.js').GeneralSettingsService;
}

/** Same reveal rules as the webhook and delivery routes. */
function canRevealWebhookSecrets(user: User): boolean {
  return hasScope(user.scopes, 'notifications:webhooks:manage');
}

function canRevealDeliveryPayloads(user: User): boolean {
  return hasScope(user.scopes, 'notifications:webhooks:manage');
}

function requireAnyScope(user: User, scopes: string[]): void {
  if (!scopes.some((scope) => hasScope(user.scopes, scope))) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: one of ${scopes.join(', ')}`);
  }
}

function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export async function executeNotificationTool(
  context: NotificationToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  if (SIEM_NOTIFICATION_TOOL_NAMES.has(toolName)) {
    try {
      if (!context.generalSettingsService || !(await context.generalSettingsService.isFeatureEnabled('siemEnabled'))) {
        return { error: 'SIEM feature is disabled' };
      }
    } catch {
      return { error: 'SIEM feature is disabled' };
    }
  }

  switch (toolName) {
    case 'list_alert_rules':
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      return context.notifRuleService.list(
        AlertRuleListQuerySchema.parse({
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
          type: a.type,
          category: a.category,
          enabled: a.enabled,
          search: a.search,
        })
      );
    case 'list_alerts':
      return listFiredAlerts(
        container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
        AlertListQuerySchema.parse(
          definedFields({
            page: agentPage(a.page),
            limit: agentPageLimit(a.limit),
            status: a.status,
            ruleId: a.ruleId,
            category: a.category,
            severity: a.severity,
            resourceType: a.resourceType,
            resourceId: a.resourceId,
            since: a.since,
            until: a.until,
            search: a.search,
          })
        )
      );
    case 'get_alert_rule':
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      return context.notifRuleService.getById(a.ruleId);
    case 'create_alert_rule': {
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      const input = CreateAlertRuleSchema.parse(
        definedFields({
          name: a.name,
          type: a.type,
          category: a.category,
          severity: a.severity,
          metric: a.metric,
          metricTarget: a.metricTarget,
          operator: a.operator,
          thresholdValue: a.thresholdValue,
          durationSeconds: a.durationSeconds,
          fireThresholdPercent: a.fireThresholdPercent,
          resolveAfterSeconds: a.resolveAfterSeconds,
          resolveThresholdPercent: a.resolveThresholdPercent,
          eventPattern: a.eventPattern,
          resourceIds: a.resourceIds,
          messageTemplate: a.messageTemplate,
          resolveMessageTemplate: a.resolveMessageTemplate,
          webhookIds: a.webhookIds,
          cooldownSeconds: a.cooldownSeconds,
          enabled: a.enabled ?? true,
        })
      );
      return createAlertRuleWithEffects(context.notifRuleService, input, user.scopes, user.id);
    }
    case 'update_alert_rule': {
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      const input = UpdateAlertRuleSchema.parse(
        definedFields({
          name: a.name,
          enabled: a.enabled,
          severity: a.severity,
          metric: a.metric,
          metricTarget: a.metricTarget,
          operator: a.operator,
          thresholdValue: a.thresholdValue,
          durationSeconds: a.durationSeconds,
          fireThresholdPercent: a.fireThresholdPercent,
          resolveAfterSeconds: a.resolveAfterSeconds,
          resolveThresholdPercent: a.resolveThresholdPercent,
          eventPattern: a.eventPattern,
          resourceIds: a.resourceIds,
          messageTemplate: a.messageTemplate,
          resolveMessageTemplate: a.resolveMessageTemplate,
          webhookIds: a.webhookIds,
          cooldownSeconds: a.cooldownSeconds,
        })
      );
      return updateAlertRuleWithEffects(context.notifRuleService, a.ruleId, input, user.scopes, user.id);
    }
    case 'delete_alert_rule':
      if (!context.notifRuleService) return { error: 'Notification service not available' };
      await deleteAlertRuleWithEffects(context.notifRuleService, a.ruleId, user.id);
      return { success: true };
    case 'list_webhooks': {
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      const reveal = canRevealWebhookSecrets(user);
      return context.notifWebhookService.list(
        WebhookListQuerySchema.parse({
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
          enabled: a.enabled,
          search: a.search,
        }),
        { revealHeaders: reveal, revealUrl: reveal }
      );
    }
    case 'create_webhook':
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      return context.notifWebhookService.create(
        CreateWebhookSchema.parse(
          definedFields({
            name: a.name,
            url: a.url,
            method: a.method,
            enabled: a.enabled,
            templatePreset: a.templatePreset,
            bodyTemplate: a.bodyTemplate,
            signingSecret: a.signingSecret,
            signingHeader: a.signingHeader,
            headers: a.headers,
          })
        ),
        user.id
      );
    case 'update_webhook':
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      return context.notifWebhookService.update(
        a.webhookId,
        UpdateWebhookSchema.parse(
          definedFields({
            name: a.name,
            url: a.url,
            method: a.method,
            enabled: a.enabled,
            templatePreset: a.templatePreset,
            bodyTemplate: a.bodyTemplate,
            signingSecret: a.signingSecret,
            signingHeader: a.signingHeader,
            headers: a.headers,
          })
        ),
        user.id
      );
    case 'delete_webhook':
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      return context.notifWebhookService.delete(a.webhookId, user.id);
    case 'test_webhook': {
      if (!context.notifWebhookService || !context.notifDispatcherService) {
        return { error: 'Notification service not available' };
      }
      const webhook = await context.notifWebhookService.getRaw(a.webhookId);
      return context.notifDispatcherService.dispatch(webhook, buildSampleEvent(), true);
    }
    case 'list_webhook_deliveries':
      if (!context.notifDeliveryService) return { error: 'Notification service not available' };
      return context.notifDeliveryService.list(
        DeliveryListQuerySchema.parse({
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
          webhookId: a.webhookId,
          status: a.status,
          eventType: a.eventType,
        }),
        { revealSensitive: canRevealDeliveryPayloads(user) }
      );
    case 'get_delivery_stats':
      if (!context.notifDeliveryService) return { error: 'Notification service not available' };
      return context.notifDeliveryService.getStats(a.webhookId);
    case 'manage_notifications':
      return manageNotifications(context, user, a);
    case 'list_siem_destinations':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.list(
        SiemDestinationListQuerySchema.parse({
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
          enabled: a.enabled,
          search: a.search,
        })
      );
    case 'get_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.getById(a.destinationId);
    case 'create_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.create(
        CreateSiemDestinationSchema.parse({
          name: a.name,
          url: a.url,
          authType: a.authType,
          ...(a.customHeaderName !== undefined ? { customHeaderName: a.customHeaderName } : {}),
          secret: a.secret,
          ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        }),
        user.id
      );
    case 'update_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.update(
        a.destinationId,
        UpdateSiemDestinationSchema.parse({
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.url !== undefined ? { url: a.url } : {}),
          ...(a.authType !== undefined ? { authType: a.authType } : {}),
          ...(a.customHeaderName !== undefined ? { customHeaderName: a.customHeaderName } : {}),
          ...(a.secret !== undefined ? { secret: a.secret } : {}),
          ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        }),
        user.id
      );
    case 'delete_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.delete(a.destinationId, user.id);
    case 'test_siem_destination':
      if (!context.siemDestinationService) return { error: 'SIEM service not available' };
      return context.siemDestinationService.test(a.destinationId);
    case 'list_siem_deliveries':
      if (!context.siemDeliveryService) return { error: 'SIEM service not available' };
      return context.siemDeliveryService.list(
        SiemDeliveryListQuerySchema.parse({
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
          destinationId: a.destinationId,
          status: a.status,
        })
      );
    case 'get_siem_delivery': {
      if (!context.siemDeliveryService) return { error: 'SIEM service not available' };
      const delivery = await context.siemDeliveryService.getById(a.deliveryId);
      if (!delivery) throw new AppError(404, 'SIEM_DELIVERY_NOT_FOUND', 'SIEM delivery not found');
      return delivery;
    }
    case 'requeue_siem_delivery':
      if (!context.siemDeliveryService) return { error: 'SIEM service not available' };
      return context.siemDeliveryService.requeue(a.deliveryId);
    default:
      throw new Error(`Unsupported notification tool: ${toolName}`);
  }
}

async function manageNotifications(context: NotificationToolContext, user: User, a: Record<string, any>) {
  switch (a.operation) {
    case 'alert_categories':
      requireAnyScope(user, ['notifications:alerts:view', 'notifications:alerts:manage']);
      return ALERT_CATEGORIES;
    case 'alert_resources': {
      requireAnyScope(user, ['notifications:alerts:view', 'notifications:alerts:manage']);
      if (!ALERT_RESOURCE_CATEGORIES.includes(a.category)) {
        return { error: `alert_resources takes category ${ALERT_RESOURCE_CATEGORIES.join(' or ')}` };
      }
      return listAlertCategoryResources(
        container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
        a.category as AlertResourceCategory,
        user.scopes
      );
    }
    case 'webhook_presets':
      requireAnyScope(user, ['notifications:webhooks:view', 'notifications:webhooks:manage']);
      return TEMPLATE_PRESETS;
    case 'webhook_get': {
      requireAnyScope(user, ['notifications:webhooks:view', 'notifications:webhooks:manage']);
      if (!context.notifWebhookService) return { error: 'Notification service not available' };
      const reveal = canRevealWebhookSecrets(user);
      return context.notifWebhookService.getById(requiredId(a.webhookId, 'webhookId'), {
        revealHeaders: reveal,
        revealUrl: reveal,
      });
    }
    case 'webhook_preview': {
      requireAnyScope(user, ['notifications:webhooks:manage']);
      if (!context.notifDispatcherService) return { error: 'Notification service not available' };
      if (typeof a.bodyTemplate !== 'string') {
        throw new AppError(400, 'BODY_TEMPLATE_REQUIRED', 'bodyTemplate is required');
      }
      const templateContext = buildTemplateContext(buildSampleEvent(), context.notifDispatcherService.getOpfieldUrl());
      return { rendered: renderTemplate(a.bodyTemplate, templateContext), context: templateContext };
    }
    case 'delivery_get': {
      requireAnyScope(user, ['notifications:webhooks:view', 'notifications:webhooks:manage']);
      if (!context.notifDeliveryService) return { error: 'Notification service not available' };
      const delivery = await context.notifDeliveryService.getById(requiredId(a.deliveryId, 'deliveryId'), {
        revealSensitive: canRevealDeliveryPayloads(user),
      });
      if (!delivery) throw new AppError(404, 'DELIVERY_NOT_FOUND', 'Not found');
      return delivery;
    }
    default:
      throw new Error(`Unsupported notification operation: ${String(a.operation)}`);
  }
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', `${label} is required`);
  return value;
}
