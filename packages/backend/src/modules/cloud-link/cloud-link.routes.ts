import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { ConnectCloudSchema, cloudStatusRoute, connectCloudRoute, disconnectCloudRoute } from './cloud-link.docs.js';
import { CloudLinkRequestError, CloudLinkService } from './cloud-link.service.js';

export const cloudLinkRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

cloudLinkRoutes.use('*', authMiddleware);

function toAppError(error: unknown): unknown {
  return error instanceof CloudLinkRequestError ? new AppError(error.status, error.code, error.message) : error;
}

// The cloud link is part of the installation's license settings: the same scopes govern it.
cloudLinkRoutes.openapi({ ...cloudStatusRoute, middleware: requireScope('license:view') }, async (c) => {
  return c.json({ data: await container.resolve(CloudLinkService).getStatus() });
});

cloudLinkRoutes.openapi({ ...connectCloudRoute, middleware: requireScope('license:manage') }, async (c) => {
  const body = ConnectCloudSchema.parse(await c.req.json());
  try {
    return c.json({ data: await container.resolve(CloudLinkService).connect(body.code) });
  } catch (error) {
    throw toAppError(error);
  }
});

cloudLinkRoutes.openapi({ ...disconnectCloudRoute, middleware: requireScope('license:manage') }, async (c) => {
  try {
    return c.json({ data: await container.resolve(CloudLinkService).disconnect() });
  } catch (error) {
    throw toAppError(error);
  }
});
