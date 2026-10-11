import { container } from '@/container.js';
import { AppOverviewService } from './app-overview.service.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import { AppOverviewQuerySchema, getAppOverviewRoute } from './apps.docs.js';

export function registerAppOverviewRoutes(router: AppsRouter): void {
  router.openapi(getAppOverviewRoute, async (c) => {
    const { range } = AppOverviewQuerySchema.parse(c.req.query());
    const data = await container.resolve(AppOverviewService).overview(appActor(c).scopes, c.req.param('id')!, range);
    return c.json({ data });
  });
}
