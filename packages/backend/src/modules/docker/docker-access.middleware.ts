import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import {
  DockerAccessResourceService,
  dockerChildScopeResourceId,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from './docker-access-resource.service.js';
import { inspectUserContainer } from './docker-internal-containers.js';
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';
import { DockerSourceService } from './docker-source.service.js';
import {
  findRemovedContainerSource,
  isMissingContainerError,
  removedContainerSourceError,
} from './docker-source-removed-container.js';

function deny(baseScope: string, nodeId?: string, resourceId?: string): never {
  const requiredScope = nodeId
    ? resourceId
      ? dockerResourceScope(baseScope, nodeId, resourceId)
      : `${baseScope}:${nodeId}`
    : baseScope;
  throw new HTTPException(403, { message: `Missing required scope: ${requiredScope}` });
}

function denyUnresolvedIdentity(): never {
  throw new HTTPException(403, { message: 'Docker resource identity could not be resolved for access verification' });
}

export function assertDockerResourceScope(
  scopes: string[],
  baseScope: string,
  nodeId: string,
  resourceId: string
): void {
  if (!hasDockerResourceScope(scopes, baseScope, nodeId, resourceId)) deny(baseScope, nodeId, resourceId);
}

export function assertDockerNodeScope(scopes: string[], baseScope: string, nodeId: string): void {
  if (
    !hasDockerResourceScope(scopes, baseScope, nodeId, '') &&
    !dockerScopedNodeIds(scopes, [baseScope]).includes(nodeId)
  ) {
    deny(baseScope, nodeId);
  }
}

/**
 * Access to a per-node Docker list. `node` when the caller holds the view scope on the node or on something on it
 * (the rows are then filtered per resource). A caller that holds the view scope only elsewhere (a folder that is
 * still empty, other nodes) or only the family's creation scope can see nothing on this node: `empty` lets the list
 * answer with no rows instead of a 403, without contacting the node. Anyone else is refused.
 */
export function dockerNodeListAccess(
  scopes: string[],
  baseScope: string,
  nodeId: string,
  creationScope?: string
): 'node' | 'empty' {
  if (
    hasDockerResourceScope(scopes, baseScope, nodeId, '') ||
    dockerScopedNodeIds(scopes, [baseScope]).includes(nodeId)
  )
    return 'node';
  if (hasScopeBase(scopes, baseScope) || (!!creationScope && hasScopeBase(scopes, creationScope))) return 'empty';
  deny(baseScope, nodeId);
}

export async function resolveDockerContainerScopeResourceId(
  inspect: () => Promise<{ scopeResourceId?: unknown }>,
  transitionFallback?: {
    active: () => boolean;
    resolvePersisted: () => Promise<string | null>;
  }
): Promise<string> {
  try {
    const data = await inspect();
    return String(data?.scopeResourceId ?? '');
  } catch (error) {
    if (error instanceof AppError && error.code === 'OPFIELD_INTERNAL_CONTAINER') throw error;
    if (!transitionFallback?.active()) throw error;
    return (await transitionFallback.resolvePersisted()) ?? '';
  }
}

export function requireDockerContainerScope(
  baseScope: string,
  identifierParam = 'containerId',
  options: {
    allowTransitionIdentityFallback?: boolean;
    allowBroadWithoutResolve?: boolean;
    allowPendingSource?: boolean;
    /**
     * A Git source route on a container removed outside Opfield (the source still holds the name): `allow` authorizes
     * it on the removed container's identity (reading and detaching the source), `refuse` answers 409
     * SOURCE_CONTAINER_REMOVED after the same check. Without it the route answers CONTAINER_NOT_FOUND.
     */
    removedContainerSource?: 'allow' | 'refuse';
  } = {}
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const nodeId = c.req.param('nodeId');
    const identifier = c.req.param(identifierParam);
    if (!nodeId || !identifier) denyUnresolvedIdentity();
    if (options.allowPendingSource) {
      const pending = await container.resolve(DockerSourceService).getPendingContainer(nodeId, identifier);
      if (pending) {
        assertDockerResourceScope(scopes, baseScope, nodeId, pending.scopeResourceId);
        await next();
        return;
      }
    }
    if (options.allowBroadWithoutResolve && hasDockerResourceScope(scopes, baseScope, nodeId, '')) {
      await next();
      return;
    }
    const service = container.resolve(DockerManagementService);
    let accessNodeId = nodeId;
    let resourceId: string;
    const identity = await container
      .resolve(DockerAvailabilityService)
      .resolveRuntimeAccessIdentity(nodeId, identifier);
    if (identity) {
      accessNodeId = identity.nodeId;
      resourceId = identity.resourceId;
    } else {
      try {
        resourceId = await resolveDockerContainerScopeResourceId(
          () => inspectUserContainer(service, nodeId, identifier),
          options.allowTransitionIdentityFallback
            ? {
                active: () => Boolean(service.getContainerTransition(nodeId, identifier)),
                resolvePersisted: () =>
                  container.resolve(DockerAccessResourceService).resolveContainer(nodeId, { name: identifier }),
              }
            : undefined
        );
      } catch (error) {
        const removed =
          options.removedContainerSource && isMissingContainerError(error)
            ? await findRemovedContainerSource(nodeId, identifier)
            : null;
        if (!removed) throw error;
        if (
          !hasDockerResourceScope(scopes, baseScope, nodeId, '') &&
          !(removed.scopeResourceId && hasDockerResourceScope(scopes, baseScope, nodeId, removed.scopeResourceId))
        ) {
          deny(baseScope, nodeId, removed.scopeResourceId ?? undefined);
        }
        if (options.removedContainerSource === 'refuse') throw removedContainerSourceError(identifier);
        await next();
        return;
      }
    }
    if (hasDockerResourceScope(scopes, baseScope, nodeId, '')) {
      await next();
      return;
    }
    if (!resourceId) denyUnresolvedIdentity();
    if (
      !hasDockerResourceScope(scopes, baseScope, accessNodeId, '') &&
      !hasDockerResourceScope(scopes, baseScope, accessNodeId, resourceId)
    ) {
      deny(baseScope, accessNodeId, resourceId);
    }
    await next();
  };
}

export function requireDockerDeploymentScope(baseScope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const nodeId = c.req.param('nodeId');
    const deploymentId = c.req.param('deploymentId');
    if (!nodeId || !deploymentId) denyUnresolvedIdentity();
    assertDockerResourceScope(scopes, baseScope, nodeId, deploymentId);
    await next();
  };
}

/**
 * Network IDs exposed by the UI and tools are full daemon IDs. Resolve only
 * that persisted identity for scoped callers so an inaccessible network cannot
 * be discovered by name or an arbitrary ID prefix.
 */
export function requireDockerNetworkScope(baseScope: string, identifierParam = 'networkId'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scopes = c.get('effectiveScopes') ?? [];
    const nodeId = c.req.param('nodeId');
    const networkId = c.req.param(identifierParam);
    if (!nodeId || !networkId) denyUnresolvedIdentity();
    if (hasDockerResourceScope(scopes, baseScope, nodeId, '')) {
      await next();
      return;
    }
    const resourceId = await container.resolve(DockerNetworkAccessResourceService).resolveNetwork(nodeId, networkId);
    if (!resourceId) denyUnresolvedIdentity();
    if (!hasDockerResourceScope(scopes, baseScope, nodeId, resourceId)) deny(baseScope, nodeId, resourceId);
    await next();
  };
}

export function filterDockerResourcesForScope<T extends { scopeResourceId?: string | null }>(
  resources: T[],
  scopes: string[],
  baseScope: string,
  nodeId: string
): T[] {
  if (hasDockerResourceScope(scopes, baseScope, nodeId, '')) return resources;
  return resources.filter(
    (resource) =>
      !!resource.scopeResourceId && hasDockerResourceScope(scopes, baseScope, nodeId, resource.scopeResourceId)
  );
}

export function dockerResourceScope(baseScope: string, nodeId: string, resourceId: string): string {
  return `${baseScope}:${dockerChildScopeResourceId(nodeId, resourceId)}`;
}
