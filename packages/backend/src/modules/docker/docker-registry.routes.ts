import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { requireScope } from '@/modules/auth/auth.middleware.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import type { AppEnv } from '@/types.js';
import {
  createRegistryRoute,
  deleteRegistryRoute,
  getInternalRegistryRoute,
  listRegistriesRoute,
  resumeInternalRegistryMaintenanceRoute,
  runInternalRegistryGcRoute,
  testRegistryDirectRoute,
  testRegistryRoute,
  updateInternalRegistryRoute,
  updateRegistryRoute,
} from './docker.docs.js';
import { RegistryCreateSchema, RegistryUpdateSchema } from './docker.schemas.js';
import { DockerInternalRegistrySettingsSchema } from './docker-build.schemas.js';
import { DockerBuildService } from './docker-build.service.js';
import { DockerRegistryService } from './docker-registry.service.js';
import { DockerInternalRegistryService } from './docker-registry-internal.service.js';
import { DockerInternalRegistryUpdateSchema } from './registry-storage/registry-storage.schemas.js';
import { DockerRegistryStorageService } from './registry-storage/registry-storage.service.js';

export function registerRegistryRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Registry routes ──────────────────────────────────────────────────

  router.openapi({ ...getInternalRegistryRoute, middleware: requireScope('docker:registries:view') }, async (c) => {
    const state = await container.resolve(DockerInternalRegistryService).getState();
    const storage = await container.resolve(DockerRegistryStorageService).getView();
    return c.json({ data: { ...state, storage } });
  });

  router.get('/registries/internal/repositories', requireScope('docker:registries:view'), async (c) => {
    const data = await container.resolve(DockerBuildService).listInternalRegistryRepositories();
    return c.json({ data });
  });

  router.openapi({ ...updateInternalRegistryRoute, middleware: requireScope('docker:registries:edit') }, async (c) => {
    const { storage: storageInput, ...external } = DockerInternalRegistryUpdateSchema.parse(await c.req.json());
    const user = c.get('user')!;
    const registry = container.resolve(DockerInternalRegistryService);
    const storageService = container.resolve(DockerRegistryStorageService);
    // The storage switch is checked here and runs on in the background; external access changes at once.
    if (storageInput) {
      await storageService.update(storageInput, { userId: user.id, scopes: c.get('effectiveScopes') || [] });
    }
    const state =
      external.externalAccessEnabled === undefined
        ? await registry.getState()
        : await registry.updateSettings(DockerInternalRegistrySettingsSchema.parse(external), user.id);
    return c.json({ data: { ...state, storage: await storageService.getView() } });
  });

  router.openapi({ ...runInternalRegistryGcRoute, middleware: requireScope('docker:registries:edit') }, async (c) => {
    const input = z.object({ dryRun: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    const housekeepingConfig = await container.resolve(HousekeepingService).getConfig();
    const data = await container.resolve(DockerInternalRegistryService).runGarbageCollection({
      dryRun: input.dryRun,
      requestedById: c.get('user')!.id,
      retentionCount: housekeepingConfig.internalRegistry.retentionSuccessfulArtifacts,
    });
    return c.json({ data });
  });

  router.openapi(
    { ...resumeInternalRegistryMaintenanceRoute, middleware: requireScope('docker:registries:edit') },
    async (c) => {
      const data = await container.resolve(DockerInternalRegistryService).resumeMaintenance(c.req.param('runId')!);
      return c.json({ data });
    }
  );

  // List registries
  router.openapi({ ...listRegistriesRoute, middleware: requireScope('docker:registries:view') }, async (c) => {
    const service = container.resolve(DockerRegistryService);
    const nodeId = c.req.query('nodeId');
    const data = await service.list(nodeId);
    return c.json({ data });
  });

  // Create registry
  router.openapi({ ...createRegistryRoute, middleware: requireScope('docker:registries:create') }, async (c) => {
    const service = container.resolve(DockerRegistryService);
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = RegistryCreateSchema.parse(body);
    const data = await service.create(input, user.id);
    return c.json({ data }, 201);
  });

  // Update registry
  router.openapi({ ...updateRegistryRoute, middleware: requireScope('docker:registries:edit') }, async (c) => {
    const service = container.resolve(DockerRegistryService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = RegistryUpdateSchema.parse(body);
    const data = await service.update(id, input, user.id);
    return c.json({ data });
  });

  // Delete registry
  router.openapi({ ...deleteRegistryRoute, middleware: requireScope('docker:registries:delete') }, async (c) => {
    const service = container.resolve(DockerRegistryService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    await service.delete(id, user.id);
    return c.json({ success: true });
  });

  // Test registry connection (by credentials, before saving)
  router.openapi({ ...testRegistryDirectRoute, middleware: requireScope('docker:registries:edit') }, async (c) => {
    const service = container.resolve(DockerRegistryService);
    const body = await c.req.json();
    const input = RegistryCreateSchema.partial().parse(body);
    const data = await service.testConnectionDirect(
      input.url ?? '',
      input.username,
      input.password,
      input.trustedAuthRealm
    );
    return c.json({ data });
  });

  // Test registry connection (by ID)
  router.openapi({ ...testRegistryRoute, middleware: requireScope('docker:registries:edit') }, async (c) => {
    const service = container.resolve(DockerRegistryService);
    const id = c.req.param('id')!;
    const data = await service.testConnection(id, { actorScopes: c.get('effectiveScopes') || [] });
    return c.json({ data });
  });
}
