import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerDeployments, nodes } from '@/db/schema/index.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import { parseDockerChildScopeResourceId } from './docker-access-resource.service.js';
import { isDockerDeploymentManaged } from './docker-deployment-labels.js';

const BROAD_DOCKER_NODE_SCOPES = [
  'docker:containers:view',
  'docker:images:view',
  'docker:volumes:view',
  'docker:networks:view',
] as const;

const SCOPED_DOCKER_NODE_SCOPES = [
  'docker:containers:view',
  'docker:containers:create',
  'docker:containers:manage',
  'docker:containers:console',
  'docker:containers:migrate',
  'docker:containers:delete',
  'docker:containers:edit',
  'docker:containers:environment',
  'docker:containers:link',
  'docker:containers:secrets',
  'docker:containers:files:read',
  'docker:containers:files:write',
  'docker:containers:export',
  'docker:containers:webhooks',
  'docker:containers:mounts',
  'docker:images:view',
  'docker:images:pull',
  'docker:images:delete',
  'docker:volumes:view',
  'docker:volumes:create',
  'docker:volumes:delete',
  'docker:volumes:files:read',
  'docker:volumes:files:write',
  'docker:networks:view',
  'docker:networks:create',
  'docker:networks:delete',
  'docker:networks:edit',
] as const;

type ContainerInspector = {
  inspectContainer(nodeId: string, containerId: string): Promise<any>;
};

type VolumeInspector = {
  inspectVolume(nodeId: string, name: string): Promise<any>;
};

function dockerResourceNotFound(resource: 'Container' | 'Volume') {
  return new AppError(404, `${resource.toUpperCase()}_NOT_FOUND`, `${resource} not found`);
}

function rethrowDockerInspectError(error: unknown, resource: 'Container' | 'Volume'): never {
  if (error instanceof AppError && error.code === 'DISPATCH_ERROR' && /(?:no such|not found)/i.test(error.message)) {
    throw dockerResourceNotFound(resource);
  }
  throw error;
}

export function hasDockerNodeRouteAccess(scopes: string[], nodeId: string): boolean {
  return (
    BROAD_DOCKER_NODE_SCOPES.some((scope) => scopes.includes(scope)) ||
    SCOPED_DOCKER_NODE_SCOPES.some((scope) =>
      scopes.some((candidate) => {
        const base = extractBaseScope(candidate);
        if (base !== scope || candidate === base) return false;
        const resourceId = candidate.slice(base.length + 1);
        return (parseDockerChildScopeResourceId(resourceId)?.nodeId ?? resourceId) === nodeId;
      })
    )
  );
}

export function hasAnyDockerNodeRouteAccess(scopes: string[]): boolean {
  return (
    BROAD_DOCKER_NODE_SCOPES.some((scope) => scopes.includes(scope)) ||
    SCOPED_DOCKER_NODE_SCOPES.some((scope) => scopes.some((candidate) => candidate.startsWith(`${scope}:`)))
  );
}

export async function resolveDockerNodeBySlug(db: DrizzleClient, slug: string) {
  const [node] = await db
    .select({
      id: nodes.id,
      slug: nodes.slug,
      type: nodes.type,
      hostname: nodes.hostname,
      displayName: nodes.displayName,
      appearanceColor: nodes.appearanceColor,
    })
    .from(nodes)
    .where(and(eq(nodes.slug, slug), eq(nodes.type, 'docker')))
    .limit(1);
  if (!node) throw new AppError(404, 'NOT_FOUND', 'Docker node not found');
  return node;
}

export async function resolveDockerDeploymentIdByName(db: DrizzleClient, nodeId: string, name: string) {
  const [deployment] = await db
    .select({ id: dockerDeployments.id })
    .from(dockerDeployments)
    .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.name, name)))
    .limit(1);
  if (!deployment) throw new AppError(404, 'NOT_FOUND', 'Deployment not found');
  return deployment.id;
}

export async function resolveDockerContainerByName(service: ContainerInspector, nodeId: string, name: string) {
  let data: any;
  try {
    data = await service.inspectContainer(nodeId, name);
  } catch (error) {
    rethrowDockerInspectError(error, 'Container');
  }
  const canonicalName = String(data?.Name ?? data?.name ?? '').replace(/^\/+/, '');
  const labels = data?.Config?.Labels ?? data?.config?.labels ?? {};
  if (canonicalName !== name || isDockerDeploymentManaged(labels)) {
    throw dockerResourceNotFound('Container');
  }
  return data;
}

export async function resolveDockerVolumeByName(service: VolumeInspector, nodeId: string, name: string) {
  let data: any;
  try {
    data = await service.inspectVolume(nodeId, name);
  } catch (error) {
    rethrowDockerInspectError(error, 'Volume');
  }
  if (String(data?.Name ?? data?.name ?? '') !== name) throw dockerResourceNotFound('Volume');
  return data;
}
