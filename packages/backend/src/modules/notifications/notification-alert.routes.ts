import { OpenAPIHono } from '@hono/zod-openapi';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireAnyScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { listFiredAlertsRoute } from './notification.docs.js';
import { listFiredAlerts } from './notification-alert-list.js';
import { AlertListQuerySchema } from './notification-alert-rule.schemas.js';

export const alertRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

alertRoutes.use('*', authMiddleware);

// GET / — the alerts that fire now and the alert history (the MCP tool list_alerts answers the same)
alertRoutes.openapi(
  {
    ...listFiredAlertsRoute,
    middleware: requireAnyScope('notifications:alerts:view', 'notifications:alerts:manage'),
  },
  async (c) => {
    const query = AlertListQuerySchema.parse(c.req.query());
    return c.json(await listFiredAlerts(container.resolve<DrizzleClient>(TOKENS.DrizzleClient), query));
  }
);
