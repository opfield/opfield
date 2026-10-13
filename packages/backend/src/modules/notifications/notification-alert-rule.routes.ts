import { OpenAPIHono } from '@hono/zod-openapi';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireAnyScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { ALERT_CATEGORIES } from './notification.constants.js';
import {
  createNotificationAlertRuleRoute,
  deleteNotificationAlertRuleRoute,
  getNotificationAlertRuleRoute,
  listAlertCategoryResourcesRoute,
  listNotificationAlertRulesRoute,
  listNotificationCategoriesRoute,
  updateNotificationAlertRuleRoute,
} from './notification.docs.js';
import {
  createAlertRuleWithEffects,
  deleteAlertRuleWithEffects,
  updateAlertRuleWithEffects,
} from './notification-alert-rule.mutations.js';
import {
  AlertRuleListQuerySchema,
  CreateAlertRuleSchema,
  UpdateAlertRuleSchema,
} from './notification-alert-rule.schemas.js';
import { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import { type AlertResourceCategory, listAlertCategoryResources } from './notification-rule-resources.js';

export const alertRuleRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

alertRuleRoutes.use('*', authMiddleware);

// GET /categories — list alert categories with their metrics, events, and variables
alertRuleRoutes.openapi(
  {
    ...listNotificationCategoriesRoute,
    middleware: requireAnyScope('notifications:alerts:view', 'notifications:alerts:manage'),
  },
  async (c) => {
    return c.json({ data: ALERT_CATEGORIES });
  }
);

// GET /categories/:category/resources — what a rule of a category without its own list can be scoped to
alertRuleRoutes.openapi(
  {
    ...listAlertCategoryResourcesRoute,
    middleware: requireAnyScope('notifications:alerts:view', 'notifications:alerts:manage'),
  },
  async (c) => {
    const user = c.get('user')!;
    const data = await listAlertCategoryResources(
      container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
      c.req.param('category') as AlertResourceCategory,
      c.get('effectiveScopes') ?? user.scopes
    );
    return c.json({ data });
  }
);

// GET / — list alert rules
alertRuleRoutes.openapi(
  {
    ...listNotificationAlertRulesRoute,
    middleware: requireAnyScope('notifications:alerts:view', 'notifications:alerts:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const query = AlertRuleListQuerySchema.parse(c.req.query());
    const result = await service.list(query);
    return c.json(result);
  }
);

// GET /:id — get alert rule
alertRuleRoutes.openapi(
  {
    ...getNotificationAlertRuleRoute,
    middleware: requireAnyScope('notifications:alerts:view', 'notifications:alerts:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const rule = await service.getById(c.req.param('id')!);
    return c.json({ data: rule });
  }
);

// POST / — create alert rule
alertRuleRoutes.openapi(
  {
    ...createNotificationAlertRuleRoute,
    middleware: requireAnyScope('notifications:alerts:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const body = CreateAlertRuleSchema.parse(await c.req.json());
    const user = c.get('user')!;
    const rule = await createAlertRuleWithEffects(service, body, c.get('effectiveScopes') ?? user.scopes, user.id);
    return c.json({ data: rule }, 201);
  }
);

// PUT /:id — update alert rule
alertRuleRoutes.openapi(
  {
    ...updateNotificationAlertRuleRoute,
    middleware: requireAnyScope('notifications:alerts:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const body = UpdateAlertRuleSchema.parse(await c.req.json());
    const user = c.get('user')!;
    const rule = await updateAlertRuleWithEffects(
      service,
      c.req.param('id')!,
      body,
      c.get('effectiveScopes') ?? user.scopes,
      user.id
    );
    return c.json({ data: rule });
  }
);

// DELETE /:id — delete alert rule
alertRuleRoutes.openapi(
  {
    ...deleteNotificationAlertRuleRoute,
    middleware: requireAnyScope('notifications:alerts:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const user = c.get('user')!;
    await deleteAlertRuleWithEffects(service, c.req.param('id')!, user.id);
    return c.body(null, 204);
  }
);
