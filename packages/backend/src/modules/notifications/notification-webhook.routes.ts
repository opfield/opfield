import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireAnyScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  createNotificationWebhookRoute,
  deleteNotificationWebhookRoute,
  getNotificationWebhookRoute,
  listNotificationWebhookPresetsRoute,
  listNotificationWebhooksRoute,
  previewNotificationWebhookRoute,
  testNotificationWebhookRoute,
  updateNotificationWebhookRoute,
} from './notification.docs.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';
import { buildSampleEvent, buildTemplateContext, renderTemplate, TEMPLATE_PRESETS } from './notification-templates.js';
import { CreateWebhookSchema, UpdateWebhookSchema, WebhookListQuerySchema } from './notification-webhook.schemas.js';
import { NotificationWebhookService } from './notification-webhook.service.js';

export const webhookRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

webhookRoutes.use('*', authMiddleware);

function canRevealWebhookHeaders(c: { get(key: 'effectiveScopes'): string[] | undefined }): boolean {
  const scopes = c.get('effectiveScopes') ?? [];
  return hasScope(scopes, 'notifications:webhooks:manage');
}

// GET /presets — list template presets
webhookRoutes.openapi(
  {
    ...listNotificationWebhookPresetsRoute,
    middleware: requireAnyScope('notifications:webhooks:view', 'notifications:webhooks:manage'),
  },
  async (c) => {
    return c.json({ data: TEMPLATE_PRESETS });
  }
);

// GET / — list webhooks
webhookRoutes.openapi(
  {
    ...listNotificationWebhooksRoute,
    middleware: requireAnyScope('notifications:webhooks:view', 'notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const query = WebhookListQuerySchema.parse(c.req.query());
    const revealSensitive = canRevealWebhookHeaders(c);
    const result = await service.list(query, { revealHeaders: revealSensitive, revealUrl: revealSensitive });
    return c.json(result);
  }
);

// GET /:id — get webhook
webhookRoutes.openapi(
  {
    ...getNotificationWebhookRoute,
    middleware: requireAnyScope('notifications:webhooks:view', 'notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const revealSensitive = canRevealWebhookHeaders(c);
    const webhook = await service.getById(c.req.param('id')!, {
      revealHeaders: revealSensitive,
      revealUrl: revealSensitive,
    });
    return c.json({ data: webhook });
  }
);

// POST /preview — render a template with sample data (must be before /:id routes)
webhookRoutes.openapi(
  {
    ...previewNotificationWebhookRoute,
    middleware: requireAnyScope('notifications:webhooks:manage'),
  },
  async (c) => {
    const { bodyTemplate } = await c.req.json();
    if (typeof bodyTemplate !== 'string') {
      throw new AppError(400, 'BODY_TEMPLATE_REQUIRED', 'bodyTemplate is required');
    }
    const dispatcher = container.resolve(NotificationDispatcherService);
    const sampleEvent = buildSampleEvent();
    const context = buildTemplateContext(sampleEvent, dispatcher.getOpfieldUrl());
    const rendered = renderTemplate(bodyTemplate, context);
    return c.json({ data: { rendered, context } });
  }
);

// POST / — create webhook
webhookRoutes.openapi(
  {
    ...createNotificationWebhookRoute,
    middleware: requireAnyScope('notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const body = CreateWebhookSchema.parse(await c.req.json());
    const user = c.get('user')!;
    const webhook = await service.create(body, user.id);
    return c.json({ data: webhook }, 201);
  }
);

// PUT /:id — update webhook
webhookRoutes.openapi(
  {
    ...updateNotificationWebhookRoute,
    middleware: requireAnyScope('notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const body = UpdateWebhookSchema.parse(await c.req.json());
    const user = c.get('user')!;
    const webhook = await service.update(c.req.param('id')!, body, user.id);
    return c.json({ data: webhook });
  }
);

// DELETE /:id — delete webhook
webhookRoutes.openapi(
  {
    ...deleteNotificationWebhookRoute,
    middleware: requireAnyScope('notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const user = c.get('user')!;
    await service.delete(c.req.param('id')!, user.id);
    return c.body(null, 204);
  }
);

// POST /:id/test — send test delivery
webhookRoutes.openapi(
  {
    ...testNotificationWebhookRoute,
    middleware: requireAnyScope('notifications:webhooks:manage'),
  },
  async (c) => {
    const dispatcher = container.resolve(NotificationDispatcherService);
    const webhookService = container.resolve(NotificationWebhookService);
    const webhook = await webhookService.getRaw(c.req.param('id')!);
    const sampleEvent = buildSampleEvent();
    const result = await dispatcher.dispatch(webhook, sampleEvent, true);
    return c.json({ data: result });
  }
);
