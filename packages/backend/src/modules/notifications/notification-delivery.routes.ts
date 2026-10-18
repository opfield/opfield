import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  getNotificationDeliveryRoute,
  listNotificationDeliveriesRoute,
  notificationDeliveryStatsRoute,
} from './notification.docs.js';
import { DeliveryListQuerySchema } from './notification-delivery.schemas.js';
import { NotificationDeliveryService } from './notification-delivery.service.js';

export const deliveryRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

deliveryRoutes.use('*', authMiddleware);

type ScopeContext = { get(key: 'effectiveScopes'): string[] | undefined };

/** Payloads and full URLs are shown to those who may manage the delivery's webhook. */
function canRevealDeliveryPayloads(c: ScopeContext) {
  const scopes = c.get('effectiveScopes') ?? [];
  return (webhookId: string | null) =>
    hasScope(scopes, 'notifications:webhooks:manage') ||
    (!!webhookId && hasScope(scopes, `notifications:webhooks:manage:${webhookId}`));
}

/** The delivery history belongs to webhooks: without broad view, only deliveries of the webhooks one may view. */
function allowedWebhookIds(c: ScopeContext): string[] | undefined {
  const scopes = c.get('effectiveScopes') ?? [];
  return hasScope(scopes, 'notifications:webhooks:view')
    ? undefined
    : getResourceScopedIds(scopes, 'notifications:webhooks:view');
}

// GET / — list deliveries
deliveryRoutes.openapi(
  {
    ...listNotificationDeliveriesRoute,
    middleware: requireScopeBase('notifications:webhooks:view'),
  },
  async (c) => {
    const service = container.resolve(NotificationDeliveryService);
    const query = DeliveryListQuerySchema.parse(c.req.query());
    const result = await service.list(query, {
      revealSensitive: canRevealDeliveryPayloads(c),
      allowedWebhookIds: allowedWebhookIds(c),
    });
    return c.json(result);
  }
);

// GET /stats — delivery stats
deliveryRoutes.openapi(
  {
    ...notificationDeliveryStatsRoute,
    middleware: requireScopeBase('notifications:webhooks:view'),
  },
  async (c) => {
    const service = container.resolve(NotificationDeliveryService);
    const webhookId = c.req.query('webhookId');
    const stats = await service.getStats(webhookId, { allowedWebhookIds: allowedWebhookIds(c) });
    return c.json({ data: stats });
  }
);

// GET /:id — get delivery detail
deliveryRoutes.openapi(
  {
    ...getNotificationDeliveryRoute,
    middleware: requireScopeBase('notifications:webhooks:view'),
  },
  async (c) => {
    const service = container.resolve(NotificationDeliveryService);
    const allowed = allowedWebhookIds(c);
    const delivery = await service.getById(c.req.param('id')!, {
      revealSensitive: canRevealDeliveryPayloads(c),
      canView: (webhookId) => !allowed || (!!webhookId && allowed.includes(webhookId)),
    });
    if (!delivery) throw new AppError(404, 'DELIVERY_NOT_FOUND', 'Not found');
    return c.json({ data: delivery });
  }
);
