import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  CloudRemoteManagementSchema,
  ConnectCloudSchema,
  cancelCloudLinkCodeRoute,
  cloudLinkCodeStatusRoute,
  cloudRemoteManagementRoute,
  cloudStatusRoute,
  connectCloudRoute,
  disconnectCloudRoute,
  startCloudLinkCodeRoute,
} from './cloud-link.docs.js';
import { CloudLinkRequestError, CloudLinkService } from './cloud-link.service.js';
import { CloudLinkConnectCode } from './cloud-link-connect-code.js';

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
    return c.json({
      data: await container.resolve(CloudLinkService).connect(body.code, { userId: c.get('user')?.id ?? null }),
    });
  } catch (error) {
    throw toAppError(error);
  }
});

cloudLinkRoutes.openapi({ ...disconnectCloudRoute, middleware: requireScope('license:manage') }, async (c) => {
  try {
    return c.json({
      data: await container.resolve(CloudLinkService).disconnect({ userId: c.get('user')?.id ?? null }),
    });
  } catch (error) {
    throw toAppError(error);
  }
});

cloudLinkRoutes.openapi({ ...cloudRemoteManagementRoute, middleware: requireScope('license:manage') }, async (c) => {
  const body = CloudRemoteManagementSchema.parse(await c.req.json());
  try {
    return c.json({
      data: await container
        .resolve(CloudLinkService)
        .setRemoteManagement(body.enabled, { userId: c.get('user')?.id ?? null }),
    });
  } catch (error) {
    throw toAppError(error);
  }
});

// Connect with one code shown here and entered in the Opfield account.
cloudLinkRoutes.openapi({ ...startCloudLinkCodeRoute, middleware: requireScope('license:manage') }, async (c) => {
  try {
    return c.json({ data: await container.resolve(CloudLinkConnectCode).start({ userId: c.get('user')?.id ?? null }) });
  } catch (error) {
    throw toAppError(error);
  }
});

cloudLinkRoutes.openapi({ ...cloudLinkCodeStatusRoute, middleware: requireScope('license:manage') }, async (c) => {
  return c.json({ data: await container.resolve(CloudLinkConnectCode).status() });
});

cloudLinkRoutes.openapi({ ...cancelCloudLinkCodeRoute, middleware: requireScope('license:manage') }, async (c) => {
  return c.json({ data: await container.resolve(CloudLinkConnectCode).cancel({ userId: c.get('user')?.id ?? null }) });
});
