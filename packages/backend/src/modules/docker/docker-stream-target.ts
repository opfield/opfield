import { AppError } from '@/middleware/error-handler.js';
import { inspectUserContainer } from './docker-internal-containers.js';

/**
 * The container a Logs, Console or Files stream opened for a runtime ID reaches. A recreate (or update) replaces the
 * runtime: a client that still holds the replaced ID reaches the container now under its name, and while the recreate
 * runs (or before the container exists) the stream is `unavailable`, which is not an authentication failure.
 */
export type DockerStreamTarget =
  | { kind: 'resolved'; runtimeContainerId: string; scopeNodeId: string; scopeResourceId: string }
  | { kind: 'internal' }
  | { kind: 'unavailable'; recreating: boolean };

/** Error frame code of a container that is being recreated or does not run yet: clients wait and reconnect. */
export const CONTAINER_UNAVAILABLE_CODE = 'container_unavailable';
/** RFC 6455 "Try Again Later". */
export const CONTAINER_UNAVAILABLE_CLOSE_CODE = 1013;

export function containerUnavailableFrame(recreating: boolean): Record<string, unknown> {
  return {
    type: 'error',
    code: CONTAINER_UNAVAILABLE_CODE,
    reason: recreating ? 'recreating' : 'not_running',
    message: recreating ? 'Container is being recreated' : 'Container is not running yet',
  };
}

interface DockerStreamTargetDeps {
  docker: {
    inspectContainer(nodeId: string, containerId: string): Promise<any>;
    getContainerTransition(nodeId: string, name: string): string | undefined;
  };
  availability: {
    resolveRuntimeAccessIdentity(
      nodeId: string,
      containerId: string
    ): Promise<{ nodeId: string; resourceId: string } | null>;
  };
  tasks: { findRecreatedContainerName(nodeId: string, containerId: string): Promise<string | null> };
}

export async function resolveDockerStreamTarget(
  deps: DockerStreamTargetDeps,
  nodeId: string,
  containerId: string
): Promise<DockerStreamTarget> {
  // Availability placements may be inspectable as regular containers (deployment slots); their logical workload is
  // the authorization boundary, not the generated runtime name.
  const placement = await deps.availability.resolveRuntimeAccessIdentity(nodeId, containerId).catch(() => null);
  if (placement) {
    const scopeResourceId = String(placement.resourceId ?? '');
    return scopeResourceId
      ? { kind: 'resolved', runtimeContainerId: containerId, scopeNodeId: placement.nodeId ?? nodeId, scopeResourceId }
      : { kind: 'unavailable', recreating: false };
  }
  const direct = await inspectTarget(deps, nodeId, containerId, containerId);
  if (direct.kind !== 'unavailable') return direct;
  const name = await deps.tasks.findRecreatedContainerName(nodeId, containerId).catch(() => null);
  if (!name) return direct;
  if (deps.docker.getContainerTransition(nodeId, name)) return { kind: 'unavailable', recreating: true };
  const replacement = await inspectTarget(deps, nodeId, name);
  return replacement.kind === 'unavailable' ? { kind: 'unavailable', recreating: true } : replacement;
}

async function inspectTarget(
  deps: DockerStreamTargetDeps,
  nodeId: string,
  key: string,
  runtimeContainerId?: string
): Promise<DockerStreamTarget> {
  try {
    const data = await inspectUserContainer(deps.docker, nodeId, key);
    const scopeResourceId = String(data?.scopeResourceId ?? '');
    const id = runtimeContainerId ?? String(data?.Id ?? data?.id ?? '');
    if (scopeResourceId && id)
      return { kind: 'resolved', runtimeContainerId: id, scopeNodeId: nodeId, scopeResourceId };
    const name = String(data?.Name ?? data?.name ?? '').replace(/^\/+/, '');
    return { kind: 'unavailable', recreating: !!name && !!deps.docker.getContainerTransition(nodeId, name) };
  } catch (error) {
    if (error instanceof AppError && error.code === 'OPFIELD_INTERNAL_CONTAINER') return { kind: 'internal' };
    return { kind: 'unavailable', recreating: false };
  }
}
