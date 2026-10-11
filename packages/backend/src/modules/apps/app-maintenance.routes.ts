import { container } from '@/container.js';
import { AppMaintenanceAccessService } from './app-maintenance-access.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import { AppAccessCodeBodySchema, createAppAccessCodeRoute } from './apps.docs.js';

export function registerAppMaintenanceRoutes(router: AppsRouter): void {
  router.openapi(createAppAccessCodeRoute, async (c) => {
    const { environmentId } = AppAccessCodeBodySchema.parse(await c.req.json().catch(() => ({})));
    const data = await container
      .resolve(AppMaintenanceAccessService)
      .issue(appActor(c), c.req.param('id')!, environmentId ?? null);
    return c.json({ data });
  });
}
