import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerManagementService } from './docker.service.js';
import { isOpfieldInternalContainer } from './docker-internal-containers.js';
import { DockerSourceService } from './docker-source.service.js';

function isMissingContainerError(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'CONTAINER_NOT_FOUND') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:no such container|container not found)/i.test(message);
}

/**
 * The access identity (scope resource id) of a managed database or storage link's target container, for the
 * resource-scoped permission check of a link change or read.
 *
 * A Git-source container that its first build has not created yet does not exist on the daemon. Gateway's own
 * record of it stands in: the source reserves the name on its node together with the access identity (placed in
 * the folder chosen at creation) that the container adopts when the build creates it, so the link is authorized
 * exactly as the container will be. Only a missing container falls back to that record; an existing container
 * (a pending-named one created outside Gateway included) is always judged by its own identity.
 */
export async function resolveBindingTargetContainerIdentity(nodeId: string, containerRef: string): Promise<string> {
  let inspected: Record<string, unknown> | null | undefined;
  try {
    inspected = await container.resolve(DockerManagementService).inspectContainer(nodeId, containerRef);
  } catch (error) {
    if (!isMissingContainerError(error)) throw error;
  }
  if (!inspected) {
    const pending = container.isRegistered?.(DockerSourceService)
      ? await container.resolve(DockerSourceService).getPendingContainer(nodeId, containerRef)
      : null;
    if (pending?.scopeResourceId) return pending.scopeResourceId;
    throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  }
  if (isOpfieldInternalContainer(inspected)) {
    throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  }
  const resourceId = String(inspected.scopeResourceId ?? '');
  if (!resourceId) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Binding target container not found');
  return resourceId;
}
