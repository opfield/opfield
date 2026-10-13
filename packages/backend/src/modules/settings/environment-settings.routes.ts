import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { getEnvironmentSettingsRoute, updateEnvironmentSettingsRoute } from './environment-settings.docs.js';
import { EnvironmentSettingsUpdateSchema } from './environment-settings.schemas.js';
import { DEFAULT_ENVIRONMENT_SETTINGS, EnvironmentSettingsService } from './environment-settings.service.js';

export const environmentSettingsRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

environmentSettingsRoutes.use('*', authMiddleware);

environmentSettingsRoutes.openapi(
  { ...getEnvironmentSettingsRoute, middleware: requireScope('settings:opfield:view') },
  async (c) =>
    c.json({
      data: container.resolve(EnvironmentSettingsService).getSnapshot(),
      defaults: DEFAULT_ENVIRONMENT_SETTINGS,
    })
);

environmentSettingsRoutes.openapi(
  { ...updateEnvironmentSettingsRoute, middleware: requireScope('settings:opfield:edit') },
  async (c) => {
    const input = EnvironmentSettingsUpdateSchema.parse(await c.req.json());
    const data = await container.resolve(EnvironmentSettingsService).update(input);
    return c.json({ data });
  }
);
