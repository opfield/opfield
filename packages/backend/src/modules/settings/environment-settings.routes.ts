import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
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
    const service = container.resolve(EnvironmentSettingsService);
    // Lowering the absolute session lifetime ends every older browser session at once, so changing it takes
    // admin:system like the other identity-trust settings; resubmitting the current value is fine.
    const absoluteLifetime = input.sessions?.absoluteLifetimeSeconds;
    if (
      absoluteLifetime !== undefined &&
      absoluteLifetime !== service.getSnapshot().sessions.absoluteLifetimeSeconds &&
      !hasScope(c.get('effectiveScopes') ?? [], 'admin:system')
    ) {
      throw new AppError(
        403,
        'ADMIN_SYSTEM_REQUIRED',
        'Changing the absolute session lifetime requires the admin:system permission'
      );
    }
    const data = await service.update(input);
    return c.json({ data });
  }
);
