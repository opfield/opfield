import { container } from '@/container.js';
import { AppActivityService } from './app-activity.service.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import { AppActivityQuerySchema, getAppActivityRoute } from './apps.docs.js';

export function registerAppActivityRoutes(router: AppsRouter): void {
  router.openapi(getAppActivityRoute, async (c) => {
    const query = AppActivityQuerySchema.parse(c.req.query());
    return c.json(await container.resolve(AppActivityService).list(appActor(c).scopes, c.req.param('id')!, query));
  });
}
