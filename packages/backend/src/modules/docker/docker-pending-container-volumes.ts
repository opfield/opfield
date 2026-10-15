import { and, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { DockerManagementService } from './docker.service.js';
import type { DockerPendingContainerVolumesSchema } from './docker-build.schemas.js';
import { DockerSourceService } from './docker-source.service.js';

/**
 * Managed volumes of a Git source container its first build has not created yet. They are kept in its creation
 * settings with the rest of them, and the first build creates the container with them, so its first start already
 * has its data. Each save replaces the whole list.
 */
export async function updatePendingContainerVolumes(
  nodeId: string,
  containerName: string,
  input: z.infer<typeof DockerPendingContainerVolumesSchema>,
  actor: { id: string; scopes: string[] }
) {
  const pending = await container.resolve(DockerSourceService).getPendingContainer(nodeId, containerName);
  if (!pending) {
    throw new AppError(
      409,
      'SOURCE_CONTAINER_BUILT',
      'This container already exists: change its volume mounts in its Settings, which recreates it'
    );
  }
  const docker = container.resolve(DockerManagementService);
  // A running first build owns the container's creation settings.
  await docker.assertBuildRolloutAllowed({ kind: 'container', nodeId, containerName: pending.containerName });
  // Checked as the first build's create checks them: managed volumes the caller may view, one per path.
  if (input.volumes.length > 0) await docker.assertCreationMounts(nodeId, { volumes: input.volumes }, actor.scopes);
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const updated = await db
    .update(dockerSourceBindings)
    .set({
      initialConfig: sql`jsonb_set(${dockerSourceBindings.initialConfig}, '{volumes}', ${JSON.stringify(input.volumes)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dockerSourceBindings.id, pending.sourceBindingId),
        isNull(dockerSourceBindings.deployedCommitSha),
        sql`${dockerSourceBindings.initialConfig} IS NOT NULL`
      )
    )
    .returning({ id: dockerSourceBindings.id });
  if (updated.length === 0) {
    throw new AppError(
      409,
      'SOURCE_CONTAINER_BUILT',
      'The first build created this container meanwhile: change its volume mounts in its Settings'
    );
  }
  await container.resolve(AuditService).log({
    action: 'docker.container.mounts.update',
    userId: actor.id,
    resourceType: 'docker-container',
    resourceId: pending.containerName,
    details: {
      nodeId,
      name: pending.containerName,
      containerName: pending.containerName,
      pendingSourceBuild: true,
      volumes: input.volumes.map((volume) => `${volume.name}:${volume.containerPath}`),
    },
  });
  return { pendingSourceBuild: true as const, name: pending.containerName, volumes: input.volumes };
}
