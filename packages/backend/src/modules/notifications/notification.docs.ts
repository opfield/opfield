import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  UnknownDataResponseSchema,
  withDocumentedConditionals,
} from '@/lib/openapi.js';
import {
  AlertListQuerySchema,
  AlertRuleListQuerySchema,
  CreateAlertRuleSchema,
  UpdateAlertRuleSchema,
} from './notification-alert-rule.schemas.js';
import { CreateWebhookSchema, UpdateWebhookSchema, WebhookListQuerySchema } from './notification-webhook.schemas.js';

/** The create body with the fields each rule type requires (enforced by the schema's refinements). */
const CreateAlertRuleDocumentedSchema = withDocumentedConditionals(CreateAlertRuleSchema, [
  {
    when: { properties: { type: { const: 'threshold' } } },
    requires: { required: ['metric', 'operator', 'thresholdValue'] },
  },
  { when: { properties: { type: { const: 'event' } } }, requires: { required: ['eventPattern'] } },
  {
    when: {
      required: ['category', 'type'],
      properties: { category: { const: 'hosting_account' }, type: { const: 'threshold' } },
    },
    requires: {
      required: ['metricTarget'],
      properties: { metric: { enum: ['balance', 'monthly_expenses'] }, metricTarget: { pattern: '^[A-Z]{3}$' } },
    },
  },
]);
export const listNotificationCategoriesRoute = appRoute({
  method: 'get',
  path: '/categories',
  tags: ['Notifications'],
  summary: 'List notification alert categories',
  responses: okJson(UnknownDataResponseSchema),
});

export const listAlertCategoryResourcesRoute = appRoute({
  method: 'get',
  path: '/categories/{category}/resources',
  tags: ['Notifications'],
  summary: 'List what an alert rule of a category can be scoped to (relay pool, Docker Availability)',
  request: { params: z.object({ category: z.enum(['relay_pool', 'docker_availability']) }) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listNotificationAlertRulesRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Notifications'],
  summary: 'List notification alert rules',
  request: { query: AlertRuleListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listFiredAlertsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Notifications'],
  summary: 'List the alerts that fire now and the alert history',
  description:
    'status firing (the default) lists what fires now; resolved lists the history, kept 30 days (an event rule records each occurrence resolved at once); all lists both. Newest first. Each alert carries its rule (ruleId, ruleName, ruleType, category, metric, eventPattern), the resource (resourceType, resourceId, resourceName), the message notified, firedAt, resolvedAt, durationSeconds and the template details. Filter by ruleId, category, severity, resourceType, resourceId (also a node id, finding its disk and container alerts, or the resource name), since and until (firedAt, ISO 8601), and search (rule name, resource name or id, message). Alerts fired before 2.12.3 have no resourceName or message. Needs notifications:alerts:view.',
  request: { query: AlertListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getNotificationAlertRuleRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Notifications'],
  summary: 'Get notification alert rule details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createNotificationAlertRuleRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Notifications'],
  summary: 'Create a notification alert rule',
  description:
    'Required by type (400 VALIDATION_ERROR otherwise): type threshold needs metric, operator and thresholdValue (a hosting_account threshold: metric balance or monthly_expenses and a three-letter currency in metricTarget); type event needs eventPattern.',
  request: jsonBody(CreateAlertRuleDocumentedSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateNotificationAlertRuleRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Notifications'],
  summary: 'Update a notification alert rule',
  request: { params: IdParamSchema, ...jsonBody(UpdateAlertRuleSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteNotificationAlertRuleRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Notifications'],
  summary: 'Delete a notification alert rule',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const listNotificationWebhookPresetsRoute = appRoute({
  method: 'get',
  path: '/presets',
  tags: ['Notifications'],
  summary: 'List notification webhook template presets',
  responses: okJson(UnknownDataResponseSchema),
});

export const listNotificationWebhooksRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Notifications'],
  summary: 'List notification webhooks',
  request: { query: WebhookListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getNotificationWebhookRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Notifications'],
  summary: 'Get notification webhook details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const previewNotificationWebhookRoute = appRoute({
  method: 'post',
  path: '/preview',
  tags: ['Notifications'],
  summary: 'Render a webhook template preview',
  request: jsonBody(z.object({ bodyTemplate: z.string() })),
  responses: okJson(UnknownDataResponseSchema),
});

export const createNotificationWebhookRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Notifications'],
  summary: 'Create a notification webhook',
  request: jsonBody(CreateWebhookSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateNotificationWebhookRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Notifications'],
  summary: 'Update a notification webhook',
  request: { params: IdParamSchema, ...jsonBody(UpdateWebhookSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteNotificationWebhookRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Notifications'],
  summary: 'Delete a notification webhook',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const testNotificationWebhookRoute = appRoute({
  method: 'post',
  path: '/{id}/test',
  tags: ['Notifications'],
  summary: 'Send a test notification webhook delivery',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

const DeliveryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  webhookId: z.string().uuid().optional(),
  status: z.enum(['pending', 'success', 'failed', 'retrying', 'superseded']).optional(),
  eventType: z.string().optional(),
});

export const listNotificationDeliveriesRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Notifications'],
  summary: 'List notification deliveries',
  request: { query: DeliveryListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const notificationDeliveryStatsRoute = appRoute({
  method: 'get',
  path: '/stats',
  tags: ['Notifications'],
  summary: 'Get notification delivery stats',
  responses: okJson(UnknownDataResponseSchema),
});

export const getNotificationDeliveryRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Notifications'],
  summary: 'Get notification delivery details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
