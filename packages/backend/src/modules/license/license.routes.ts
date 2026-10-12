import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import {
  assertNotCloudManaged,
  CLOUD_MANAGED_MESSAGES,
  isCloudManaged,
} from '@/modules/cloud-link/cloud-link-managed-locks.js';
import type { AppEnv } from '@/types.js';
import {
  ActivateLicenseSchema,
  activateLicenseModuleRoute,
  activateLicenseRoute,
  checkLicenseRoute,
  clearLicenseRoute,
  licenseStatusRoute,
} from './license.docs.js';
import { toLicenseAppError } from './license.errors.js';
import { LicenseService } from './license.service.js';
import { LicenseModuleService } from './license-module.service.js';

export const licenseRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

licenseRoutes.use('*', authMiddleware);

licenseRoutes.openapi({ ...licenseStatusRoute, middleware: requireScope('license:view') }, async (c) => {
  const service = container.resolve(LicenseService);
  const [status, cloudManaged] = await Promise.all([service.getStatus(), isCloudManaged()]);
  return c.json({ data: { ...status, cloudManaged } });
});

licenseRoutes.openapi({ ...activateLicenseRoute, middleware: requireScope('license:manage') }, async (c) => {
  const body = ActivateLicenseSchema.parse(await c.req.json());
  const service = container.resolve(LicenseService);
  // A managed installation runs on the key its Opfield account delivered (the enrolment file activates it).
  await assertNotCloudManaged(CLOUD_MANAGED_MESSAGES.license);
  try {
    const status = await service.activateKey(body.licenseKey);
    const activation = await container.resolve(LicenseModuleService).ensureAvailable();
    return c.json({ data: { ...status, moduleRestarting: activation.restarting } });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});

licenseRoutes.openapi({ ...activateLicenseModuleRoute, middleware: requireScope('license:manage') }, async (c) => {
  try {
    return c.json({ data: await container.resolve(LicenseModuleService).ensureAvailable() });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});

licenseRoutes.openapi({ ...checkLicenseRoute, middleware: requireScope('license:manage') }, async (c) => {
  const service = container.resolve(LicenseService);
  try {
    return c.json({ data: await service.checkNow() });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});

licenseRoutes.openapi({ ...clearLicenseRoute, middleware: requireScope('license:manage') }, async (c) => {
  const service = container.resolve(LicenseService);
  await assertNotCloudManaged(CLOUD_MANAGED_MESSAGES.license);
  try {
    return c.json({ data: await service.clearKey() });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});
