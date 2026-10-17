import { and, eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';

/** A Git source bound to a container name whose container no longer exists on its node. */
export interface RemovedContainerSource {
  sourceBindingId: string;
  /** The access identity the removed container had (its grants still apply); null when Opfield never recorded one. */
  scopeResourceId: string | null;
}

/** True for the node's answer that a container does not exist. */
export function isMissingContainerError(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'CONTAINER_NOT_FOUND') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:no such container|container not found)/i.test(message);
}

/**
 * The Git source of a container that was removed outside Opfield (`docker rm` on the node): the source still holds
 * the container name, but no container answers to it. Only a container the node reported missing is looked up here,
 * so a live container is always judged by itself. The source stays readable and removable by its binding, which
 * releases the name; the background repair removes it on its own after a few minutes.
 */
export async function findRemovedContainerSource(
  nodeId: string,
  containerName: string,
  db: DrizzleClient = container.resolve<DrizzleClient>(TOKENS.DrizzleClient)
): Promise<RemovedContainerSource | null> {
  const [binding] = await db
    .select({ id: dockerSourceBindings.id })
    .from(dockerSourceBindings)
    .where(
      and(
        eq(dockerSourceBindings.targetKind, 'container'),
        eq(dockerSourceBindings.nodeId, nodeId),
        eq(dockerSourceBindings.containerName, containerName)
      )
    )
    .limit(1);
  if (!binding) return null;
  const scopeResourceId = await new DockerAccessResourceService(db).resolveContainer(nodeId, {
    name: containerName,
    includeReservations: true,
  });
  return { sourceBindingId: binding.id, scopeResourceId };
}

/** What the Git source of a removed container still answers to: reading it and detaching it (and its Build Secrets). */
export const REMOVED_CONTAINER_SOURCE_OPERATIONS = ['get', 'remove', 'secret_list', 'secret_delete'] as const;

/** The advice for a Git source whose container was removed outside Opfield. */
export function removedContainerSourceAdvice(containerName: string): string {
  return `Container "${containerName}" no longer exists on this node (it was removed outside Opfield), but its Git source still holds the name. Remove the Git source (manage_docker_source remove, or DELETE /api/docker/nodes/{nodeId}/containers/${containerName}/source) to release the name, then create the container again and attach the source to it.`;
}

/**
 * Refuses an operation the Git source of a removed container cannot run (a build, a sync, a change): 409
 * SOURCE_CONTAINER_REMOVED, saying how to release the name.
 */
export function removedContainerSourceError(containerName: string): AppError {
  return new AppError(409, 'SOURCE_CONTAINER_REMOVED', removedContainerSourceAdvice(containerName), {
    containerName,
    allowedOperations: [...REMOVED_CONTAINER_SOURCE_OPERATIONS],
  });
}
