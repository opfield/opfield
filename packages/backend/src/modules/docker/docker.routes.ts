import { OpenAPIHono } from '@hono/zod-openapi';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { resolveSlugVisibleTo } from '@/lib/slug-lookup.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { registerDockerAvailabilityRoutes } from './availability/docker-availability.routes.js';
import { registerDockerComposeRoutes } from './compose/compose.routes.js';
import { registerContainerLinkRoutes } from './container-links/container-links.routes.js';
import { getDockerNodeBySlugRoute } from './docker.docs.js';
import { registerDockerBuildRoutes } from './docker-build.routes.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { registerDockerDeploymentRoutes } from './docker-deployment.routes.js';
import { registerDockerFolderRoutes } from './docker-folder.routes.js';
import { registerDockerHealthCheckRoutes } from './docker-health-check.routes.js';
import { registerImageRoutes } from './docker-image.routes.js';
import { registerDockerMigrationRoutes } from './docker-migration.routes.js';
import { registerNetworkRoutes } from './docker-network.routes.js';
import { registerRegistryRoutes } from './docker-registry.routes.js';
import { hasDockerNodeRouteAccess, resolveDockerNodeBySlug } from './docker-route-resolvers.js';
import { registerDockerRuntimeRoutes } from './docker-runtime.routes.js';
import { registerDockerSnapshotRoutes } from './docker-snapshot.routes.js';
import { registerDockerSourceRoutes } from './docker-source.routes.js';
import { registerTaskRoutes } from './docker-task.routes.js';
import { registerVolumeRoutes } from './docker-volume.routes.js';
import { registerWebhookConfigRoutes } from './docker-webhook.routes.js';

export const dockerRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

dockerRoutes.use('*', authMiddleware);

dockerRoutes.openapi(getDockerNodeBySlugRoute, async (c) => {
  const db = container.resolve(TOKENS.DrizzleClient) as DrizzleClient;
  const scopes = c.get('effectiveScopes') || [];
  // A Docker node the caller has no access to answers like a missing slug.
  const node = await resolveSlugVisibleTo(
    'Docker node',
    () => resolveDockerNodeBySlug(db, c.req.param('nodeSlug')!),
    (id) => hasDockerNodeRouteAccess(scopes, id)
  );
  return c.json({ data: node });
});

// Register all route groups
registerDockerSnapshotRoutes(dockerRoutes);
registerDockerBuildRoutes(dockerRoutes);
registerWebhookConfigRoutes(dockerRoutes);
registerDockerDeploymentRoutes(dockerRoutes);
registerDockerComposeRoutes(dockerRoutes);
registerDockerHealthCheckRoutes(dockerRoutes);
registerDockerMigrationRoutes(dockerRoutes);
registerDockerAvailabilityRoutes(dockerRoutes);
registerDockerRuntimeRoutes(dockerRoutes);
registerDockerFolderRoutes(dockerRoutes);
registerDockerSourceRoutes(dockerRoutes);
registerContainerLinkRoutes(dockerRoutes);
registerContainerRoutes(dockerRoutes);
registerImageRoutes(dockerRoutes);
registerVolumeRoutes(dockerRoutes);
registerNetworkRoutes(dockerRoutes);
registerRegistryRoutes(dockerRoutes);
registerTaskRoutes(dockerRoutes);
