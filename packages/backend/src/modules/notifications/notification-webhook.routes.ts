import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  authMiddleware,
  requireAnyScopeBase,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import { notificationWebhookFolderRouteDocs } from '@/modules/resource-folders/resource-folder.docs.js';
import { registerResourceFolderRoutes } from '@/modules/resource-folders/resource-folder.routes.js';
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
import { NotificationWebhookFolderService } from './notification-folders.service.js';
import { buildSampleEvent, buildTemplateContext, renderTemplate, TEMPLATE_PRESETS } from './notification-templates.js';
import { CreateWebhookSchema, UpdateWebhookSchema, WebhookListQuerySchema } from './notification-webhook.schemas.js';
import { NotificationWebhookService } from './notification-webhook.service.js';

export const webhookRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

webhookRoutes.use('*', authMiddleware);

// Folders of webhooks, registered before the `/{id}` routes. Webhooks take notifications:webhooks:view and
// notifications:webhooks:manage broadly, on one webhook (`<scope>:<webhookId>`) or on a folder (`<scope>:folder/<id>`);
// manage on a folder also creates there. Placing a webhook needs manage on it and on the destination.
registerResourceFolderRoutes(webhookRoutes, {
  docs: notificationWebhookFolderRouteDocs,
  service: () => container.resolve(NotificationWebhookFolderService),
  manageScope: 'notifications:webhooks:folders:manage',
  viewScope: 'notifications:webhooks:view',
  listScopes: ['notifications:webhooks:manage'],
  folderGrantScopes: ['notifications:webhooks:view', 'notifications:webhooks:manage'],
  placementScope: 'notifications:webhooks:manage',
});

/** URL and headers (they often carry tokens) are shown to those who may manage the webhook. */
function canRevealWebhook(c: { get(key: 'effectiveScopes'): string[] | undefined }) {
  const scopes = c.get('effectiveScopes') ?? [];
  return (webhookId: string) => hasScope(scopes, `notifications:webhooks:manage:${webhookId}`);
}

/** Webhooks the caller may list: every webhook with broad view, otherwise those granted one by one or by folder. */
function visibleWebhookIds(scopes: readonly string[]): string[] | undefined {
  return hasScope(scopes, 'notifications:webhooks:view')
    ? undefined
    : getResourceScopedIds(scopes, 'notifications:webhooks:view');
}

// GET /presets — list template presets
webhookRoutes.openapi(
  {
    ...listNotificationWebhookPresetsRoute,
    middleware: requireAnyScopeBase('notifications:webhooks:view', 'notifications:webhooks:manage'),
  },
  async (c) => {
    return c.json({ data: TEMPLATE_PRESETS });
  }
);

// GET / — list webhooks
webhookRoutes.openapi(
  {
    ...listNotificationWebhooksRoute,
    middleware: requireScopeBase('notifications:webhooks:view'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const query = WebhookListQuerySchema.parse(c.req.query());
    const reveal = canRevealWebhook(c);
    const result = await service.list(query, {
      revealHeaders: reveal,
      revealUrl: reveal,
      allowedIds: visibleWebhookIds(c.get('effectiveScopes') ?? []),
    });
    return c.json(result);
  }
);

// GET /:id — get webhook
webhookRoutes.openapi(
  {
    ...getNotificationWebhookRoute,
    middleware: requireScopeForResource('notifications:webhooks:view', 'id'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const reveal = canRevealWebhook(c);
    const webhook = await service.getById(c.req.param('id')!, { revealHeaders: reveal, revealUrl: reveal });
    return c.json({ data: webhook });
  }
);

// POST /preview — render a template with sample data (must be before /:id routes)
webhookRoutes.openapi(
  {
    ...previewNotificationWebhookRoute,
    middleware: requireScopeBase('notifications:webhooks:manage'),
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
    middleware: requireScopeBase('notifications:webhooks:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationWebhookService);
    const body = CreateWebhookSchema.parse(await c.req.json());
    const user = c.get('user')!;
    // Broad manage creates anywhere; `manage:folder/<id>` creates in that folder only.
    await container
      .resolve(NotificationWebhookFolderService)
      .assertCreateFolder(c.get('effectiveScopes') ?? [], body.folderId);
    const webhook = await service.create(body, user.id);
    return c.json({ data: webhook }, 201);
  }
);

// PUT /:id — update webhook
webhookRoutes.openapi(
  {
    ...updateNotificationWebhookRoute,
    middleware: requireScopeForResource('notifications:webhooks:manage', 'id'),
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
    middleware: requireScopeForResource('notifications:webhooks:manage', 'id'),
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
    middleware: requireScopeForResource('notifications:webhooks:manage', 'id'),
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
