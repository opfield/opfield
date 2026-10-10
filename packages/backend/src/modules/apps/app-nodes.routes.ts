import { container } from '@/container.js';
import { AppNodesService } from './app-nodes.service.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import {
  AppNodeBodySchema,
  allowAppEnvironmentNodeRoute,
  listAppEnvironmentNodesRoute,
  removeAppEnvironmentNodeByBodyRoute,
  removeAppEnvironmentNodeRoute,
} from './apps.docs.js';

export function registerAppNodesRoutes(router: AppsRouter): void {
  router.openapi(listAppEnvironmentNodesRoute, async (c) => {
    const data = await container.resolve(AppNodesService).list(appActor(c), c.req.param('id')!, c.req.param('envId')!);
    return c.json({ data });
  });

  router.openapi(allowAppEnvironmentNodeRoute, async (c) => {
    const { nodeId } = AppNodeBodySchema.parse(await c.req.json());
    const data = await container
      .resolve(AppNodesService)
      .allow(appActor(c), c.req.param('id')!, c.req.param('envId')!, nodeId);
    return c.json({ data });
  });

  router.openapi(removeAppEnvironmentNodeRoute, async (c) => {
    const data = await container
      .resolve(AppNodesService)
      .remove(appActor(c), c.req.param('id')!, c.req.param('envId')!, c.req.param('nodeId')!);
    return c.json({ data });
  });

  router.openapi(removeAppEnvironmentNodeByBodyRoute, async (c) => {
    const { nodeId } = AppNodeBodySchema.parse(await c.req.json());
    const data = await container
      .resolve(AppNodesService)
      .remove(appActor(c), c.req.param('id')!, c.req.param('envId')!, nodeId);
    return c.json({ data });
  });
}
