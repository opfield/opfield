import { container } from '@/container.js';
import { AppMembersService } from './app-members.service.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import { listAppMembersRoute, placeAppMembersRoute } from './apps.docs.js';
import { AppMembersQuerySchema, PlaceAppMembersSchema } from './apps.schemas.js';
import { AppsService } from './apps.service.js';

export function registerAppMembersRoutes(router: AppsRouter): void {
  router.openapi(placeAppMembersRoute, async (c) => {
    const input = PlaceAppMembersSchema.parse(await c.req.json());
    return c.json({ data: await container.resolve(AppMembersService).place(appActor(c), input) });
  });

  router.openapi(listAppMembersRoute, async (c) => {
    const query = AppMembersQuerySchema.parse(c.req.query());
    const data = await container
      .resolve(AppsService)
      .listMembers(appActor(c).scopes, c.req.param('id')!, query.environmentId);
    return c.json({ data });
  });
}
