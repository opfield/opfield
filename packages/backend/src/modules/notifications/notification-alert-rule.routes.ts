import { OpenAPIHono } from '@hono/zod-openapi';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import {
  authMiddleware,
  requireAnyScopeBase,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import { notificationAlertRuleFolderRouteDocs } from '@/modules/resource-folders/resource-folder.docs.js';
import { registerResourceFolderRoutes } from '@/modules/resource-folders/resource-folder.routes.js';
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
import { NotificationAlertRuleFolderService } from './notification-folders.service.js';
import { type AlertResourceCategory, listAlertCategoryResources } from './notification-rule-resources.js';

export const alertRuleRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

alertRuleRoutes.use('*', authMiddleware);

// Folders of custom rules, registered before the `/{id}` routes. Rules take notifications:alerts:view and
// notifications:alerts:manage broadly, on one rule (`<scope>:<ruleId>`) or on a folder (`<scope>:folder/<id>`); manage on
// a folder also creates there. Placing a rule needs manage on it and on the destination. Built-in rules never move.
registerResourceFolderRoutes(alertRuleRoutes, {
  docs: notificationAlertRuleFolderRouteDocs,
  service: () => container.resolve(NotificationAlertRuleFolderService),
  manageScope: 'notifications:alerts:folders:manage',
  viewScope: 'notifications:alerts:view',
  listScopes: ['notifications:alerts:manage'],
  folderGrantScopes: ['notifications:alerts:view', 'notifications:alerts:manage'],
  placementScope: 'notifications:alerts:manage',
});

/** Rules the caller may list: every rule with broad view, otherwise the rules granted one by one or by folder. */
function visibleRuleIds(scopes: readonly string[]): string[] | undefined {
  return hasScope(scopes, 'notifications:alerts:view')
    ? undefined
    : getResourceScopedIds(scopes, 'notifications:alerts:view');
}

// GET /categories — list alert categories with their metrics, events, and variables
alertRuleRoutes.openapi(
  {
    ...listNotificationCategoriesRoute,
    middleware: requireAnyScopeBase('notifications:alerts:view', 'notifications:alerts:manage'),
  },
  async (c) => {
    return c.json({ data: ALERT_CATEGORIES });
  }
);

// GET /categories/:category/resources — what a rule of a category without its own list can be scoped to
alertRuleRoutes.openapi(
  {
    ...listAlertCategoryResourcesRoute,
    middleware: requireAnyScopeBase('notifications:alerts:view', 'notifications:alerts:manage'),
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
    middleware: requireScopeBase('notifications:alerts:view'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const query = AlertRuleListQuerySchema.parse(c.req.query());
    const result = await service.list(query, { allowedIds: visibleRuleIds(c.get('effectiveScopes') ?? []) });
    return c.json(result);
  }
);

// GET /:id — get alert rule
alertRuleRoutes.openapi(
  {
    ...getNotificationAlertRuleRoute,
    middleware: requireScopeForResource('notifications:alerts:view', 'id'),
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
    middleware: requireScopeBase('notifications:alerts:manage'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const body = CreateAlertRuleSchema.parse(await c.req.json());
    const user = c.get('user')!;
    // Broad manage creates anywhere; `manage:folder/<id>` creates in that folder only.
    await container
      .resolve(NotificationAlertRuleFolderService)
      .assertCreateFolder(c.get('effectiveScopes') ?? [], body.folderId);
    const rule = await createAlertRuleWithEffects(service, body, c.get('effectiveScopes') ?? user.scopes, user.id);
    return c.json({ data: rule }, 201);
  }
);

// PUT /:id — update alert rule
alertRuleRoutes.openapi(
  {
    ...updateNotificationAlertRuleRoute,
    middleware: requireScopeForResource('notifications:alerts:manage', 'id'),
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
    middleware: requireScopeForResource('notifications:alerts:manage', 'id'),
  },
  async (c) => {
    const service = container.resolve(NotificationAlertRuleService);
    const user = c.get('user')!;
    await deleteAlertRuleWithEffects(service, c.req.param('id')!, user.id);
    return c.body(null, 204);
  }
);
