import { container } from '@/container.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import { listAppMembersRoute } from './apps.docs.js';
import { AppMembersQuerySchema } from './apps.schemas.js';
import { AppsService } from './apps.service.js';

export function registerAppMembersRoutes(router: AppsRouter): void {
  router.openapi(listAppMembersRoute, async (c) => {
    const query = AppMembersQuerySchema.parse(c.req.query());
    const data = await container
      .resolve(AppsService)
      .listMembers(appActor(c).scopes, c.req.param('id')!, query.environmentId);
    return c.json({ data });
  });
}
