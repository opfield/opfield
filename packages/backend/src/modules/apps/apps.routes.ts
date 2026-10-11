import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireAnyScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { APP_SCOPES } from './app-access.js';
import { registerAppActivityRoutes } from './app-activity.routes.js';
import { registerAppIncidentRoutes } from './app-incident.routes.js';
import { registerAppMaintenanceRoutes } from './app-maintenance.routes.js';
import { registerAppMembersRoutes } from './app-members.routes.js';
import { registerAppNodesRoutes } from './app-nodes.routes.js';
import { registerAppOverviewRoutes } from './app-overview.routes.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import { registerAppVariablesRoutes } from './app-variables.routes.js';
import {
  createAppEnvironmentRoute,
  createAppRoute,
  deleteAppEnvironmentRoute,
  deleteAppRoute,
  getAppRoute,
  listAppsRoute,
  updateAppEnvironmentRoute,
  updateAppRoute,
} from './apps.docs.js';
import {
  CreateAppEnvironmentSchema,
  CreateAppSchema,
  UpdateAppEnvironmentSchema,
  UpdateAppSchema,
} from './apps.schemas.js';
import { AppsService } from './apps.service.js';

export const appsRoutes: AppsRouter = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

appsRoutes.use('*', authMiddleware);
// Any app permission reaches the API; every action checks the app or environment it touches.
appsRoutes.use('*', requireAnyScopeBase(...APP_SCOPES));

// Static paths first: `/members/place` must not be read as an app id.
registerAppMembersRoutes(appsRoutes);

appsRoutes.openapi(listAppsRoute, async (c) => {
  return c.json({ data: await container.resolve(AppsService).list(appActor(c).scopes) });
});

appsRoutes.openapi(createAppRoute, async (c) => {
  const input = CreateAppSchema.parse(await c.req.json());
  return c.json({ data: await container.resolve(AppsService).create(appActor(c), input) }, 201);
});

appsRoutes.openapi(getAppRoute, async (c) => {
  return c.json({ data: await container.resolve(AppsService).get(appActor(c).scopes, c.req.param('id')!) });
});

appsRoutes.openapi(updateAppRoute, async (c) => {
  const input = UpdateAppSchema.parse(await c.req.json());
  return c.json({ data: await container.resolve(AppsService).update(appActor(c), c.req.param('id')!, input) });
});

appsRoutes.openapi(deleteAppRoute, async (c) => {
  await container.resolve(AppsService).delete(appActor(c), c.req.param('id')!);
  return c.body(null, 204);
});

appsRoutes.openapi(createAppEnvironmentRoute, async (c) => {
  const input = CreateAppEnvironmentSchema.parse(await c.req.json());
  const data = await container.resolve(AppsService).createEnvironment(appActor(c), c.req.param('id')!, input);
  return c.json({ data }, 201);
});

appsRoutes.openapi(updateAppEnvironmentRoute, async (c) => {
  const input = UpdateAppEnvironmentSchema.parse(await c.req.json());
  const data = await container
    .resolve(AppsService)
    .updateEnvironment(appActor(c), c.req.param('id')!, c.req.param('envId')!, input);
  return c.json({ data });
});

appsRoutes.openapi(deleteAppEnvironmentRoute, async (c) => {
  await container.resolve(AppsService).deleteEnvironment(appActor(c), c.req.param('id')!, c.req.param('envId')!);
  return c.body(null, 204);
});

registerAppNodesRoutes(appsRoutes);
registerAppVariablesRoutes(appsRoutes);
registerAppMaintenanceRoutes(appsRoutes);
registerAppOverviewRoutes(appsRoutes);
registerAppActivityRoutes(appsRoutes);
registerAppIncidentRoutes(appsRoutes);
