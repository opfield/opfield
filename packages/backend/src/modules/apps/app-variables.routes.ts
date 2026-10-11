import { container } from '@/container.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';
import { AppVariablesService } from './app-variables.service.js';
import { getAppVariablesRoute, patchAppSecretsRoute, setAppVariablesRoute } from './apps.docs.js';
import { PatchAppSecretsSchema, SetAppVariablesSchema } from './apps.schemas.js';

export function registerAppVariablesRoutes(router: AppsRouter): void {
  router.openapi(getAppVariablesRoute, async (c) => {
    const data = await container
      .resolve(AppVariablesService)
      .get(appActor(c), c.req.param('id')!, c.req.param('envId')!);
    return c.json({ data });
  });

  router.openapi(setAppVariablesRoute, async (c) => {
    const { variables } = SetAppVariablesSchema.parse(await c.req.json());
    const data = await container
      .resolve(AppVariablesService)
      .setVariables(appActor(c), c.req.param('id')!, c.req.param('envId')!, variables);
    return c.json({ data });
  });

  router.openapi(patchAppSecretsRoute, async (c) => {
    const input = PatchAppSecretsSchema.parse(await c.req.json());
    const data = await container
      .resolve(AppVariablesService)
      .patchSecrets(appActor(c), c.req.param('id')!, c.req.param('envId')!, input);
    return c.json({ data });
  });
}
