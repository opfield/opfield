import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { parseAppListFilter, withAppMembers } from '@/modules/apps/app-membership.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import {
  isComposeOwnedContainer,
  isComposeOwnedNetwork,
  isComposeOwnedVolume,
} from './compose/compose-discovery.service.js';
import { DockerManagementService } from './docker.service.js';
import { filterDockerResourcesForScope } from './docker-access.middleware.js';
import {
  DockerAccessResourceService,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from './docker-access-resource.service.js';
import { compactContainerListItem, matchesContainerSearch } from './docker-container.routes.js';
import { compactImageListItem, matchesImageSearch } from './docker-image.routes.js';
import { withDockerImageSources } from './docker-image-source.js';
import { filterOpfieldInternalImages } from './docker-internal-images.js';
import { isOpfieldManagedDockerNetwork } from './docker-internal-networks.js';
import { compactNetworkListItem, matchesNetworkSearch } from './docker-network.routes.js';
import {
  DOCKER_SNAPSHOT_KINDS,
  type DockerRefreshKind,
  type DockerSnapshotKind,
  DockerSnapshotService,
} from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';
import { compactVolumeListItem, matchesVolumeSearch } from './docker-volume.routes.js';

const MAX_ITEMS = 1000;
export const DockerSnapshotRefreshSchema = z
  .object({
    nodeId: z.string().uuid().optional(),
    resource: z.enum([...DOCKER_SNAPSHOT_KINDS, 'container-detail', 'volume-detail', 'volume-metrics']).optional(),
    kind: z.enum([...DOCKER_SNAPSHOT_KINDS, 'container-detail', 'volume-detail', 'volume-metrics']).optional(),
    key: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const resource = value.resource ?? value.kind;
    if (!resource) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resource'], message: 'resource is required' });
    }
    if (
      (resource === 'container-detail' || resource === 'volume-detail' || resource === 'volume-metrics') &&
      !value.key
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key'], message: 'key is required for detail refresh' });
    }
  });

const VIEW_SCOPE: Record<DockerRefreshKind, string> = {
  containers: 'docker:containers:view',
  images: 'docker:images:view',
  volumes: 'docker:volumes:view',
  networks: 'docker:networks:view',
  'container-detail': 'docker:containers:view',
  'volume-detail': 'docker:volumes:view',
  'volume-metrics': 'docker:volumes:view',
};

async function canRefreshContainerDetail(scopes: string[], nodeId: string, key: string): Promise<boolean> {
  await container.resolve(DockerManagementService).inspectUserContainer(nodeId, key);
  if (hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, '')) return true;
  const resources = container.resolve(DockerAccessResourceService);
  const resourceId =
    (await resources.resolveContainer(nodeId, { runtimeId: key })) ??
    (await resources.resolveContainer(nodeId, { name: key }));
  return !!resourceId && hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, resourceId);
}

function canRefreshVolumeDetail(scopes: string[], nodeId: string, key: string): boolean {
  return hasDockerResourceScope(scopes, 'docker:volumes:view', nodeId, key);
}

function normalizeRows(kind: DockerSnapshotKind, data: Record<string, any>[], search?: string) {
  switch (kind) {
    case 'containers':
      return data.filter((item) => matchesContainerSearch(item, search)).map(compactContainerListItem);
    case 'images':
      return filterOpfieldInternalImages(data)
        .filter((item) => matchesImageSearch(item, search))
        .map(compactImageListItem);
    case 'volumes':
      return data.filter((item) => matchesVolumeSearch(item, search)).map(compactVolumeListItem);
    case 'networks':
      return data
        .filter((item) => !isOpfieldManagedDockerNetwork(String(item.name ?? item.Name ?? '')))
        .map(compactNetworkListItem)
        .filter((item) => matchesNetworkSearch(item, search));
  }
}

async function aggregate(c: any, kind: DockerSnapshotKind) {
  const snapshots = container.resolve(DockerSnapshotService);
  const docker = container.resolve(DockerManagementService);
  const scopes = c.get('effectiveScopes') || [];
  const requestedNodeId = c.req.query('nodeId')?.trim() || undefined;
  const search = c.req.query('search')?.trim().toLowerCase() || undefined;
  const visibleNodes = await snapshots.listVisibleNodes(kind, scopes, requestedNodeId);

  const results = await Promise.all(
    visibleNodes.map(async (node) => {
      const snapshot = await snapshots.getList<Record<string, any>[]>(node.id, kind);
      const standaloneSnapshot = Array.isArray(snapshot.data)
        ? snapshot.data.filter((item) =>
            kind === 'containers'
              ? !isComposeOwnedContainer(item)
              : kind === 'volumes'
                ? !isComposeOwnedVolume(item)
                : kind === 'networks'
                  ? !isComposeOwnedNetwork(item)
                  : true
          )
        : snapshot.data;
      let source =
        kind === 'containers'
          ? await docker.decoratePublicContainerSnapshot(node.id, standaloneSnapshot)
          : kind === 'volumes'
            ? await docker.decoratePublicVolumeSnapshot(
                node.id,
                standaloneSnapshot,
                (await snapshots.getList<Record<string, any>[]>(node.id, 'containers')).data
              )
            : kind === 'networks'
              ? await docker.decoratePublicNetworkSnapshot(node.id, standaloneSnapshot)
              : kind === 'images'
                ? docker.decoratePublicImageSnapshot
                  ? await docker.decoratePublicImageSnapshot(node.id, standaloneSnapshot)
                  : standaloneSnapshot
                : standaloneSnapshot;
      if (kind === 'volumes' && Array.isArray(source)) {
        const metrics = await snapshots.getDetails<{ usedBytes?: number | null }>(node.id, 'volume-metrics');
        source = source.map((volume) => {
          const name = String(volume.name ?? volume.Name ?? '');
          return { ...volume, usedBytes: metrics[name]?.data?.usedBytes ?? null };
        });
      }
      const availability = snapshots.availability(node.id, snapshot);
      const normalized = normalizeRows(kind, Array.isArray(source) ? source : [], search);
      const scoped: Array<Record<string, unknown>> = filterDockerResourcesForScope(
        normalized as Array<Record<string, unknown> & { scopeResourceId?: string | null }>,
        scopes,
        VIEW_SCOPE[kind],
        node.id
      );
      const logicalStates =
        kind === 'containers'
          ? await container.resolve(DockerAvailabilityService).listContainerSurfaceStates(
              node.id,
              scoped.map((item) => ({
                name: String(item.name ?? ''),
                deploymentId: typeof item.deploymentId === 'string' ? item.deploymentId : null,
              }))
            )
          : {};
      const rows = scoped.map((item) => {
        const key = item.deploymentId ? `deployment:${item.deploymentId}` : `container:${String(item.name ?? '')}`;
        const logicalState = logicalStates[key];
        return {
          ...item,
          ...(logicalState
            ? {
                image: logicalState.sourceImageReference ?? item.image,
                availabilityPolicyStatus: logicalState.status,
                availabilityHealthStatus: logicalState.healthStatus,
                availabilityServing: logicalState.serving,
                availabilityDesired: logicalState.desired,
              }
            : {}),
          nodeId: node.id,
          availability,
        };
      });
      // Containers (and deployments) carry `app` and honour excludeAppMembers / appId.
      const listed =
        kind === 'containers'
          ? await withAppMembers('containers', await withDockerImageSources(rows), parseAppListFilter(c.req.query()))
          : rows;
      return { rows: listed, node: snapshots.toNodeMetadata(node, snapshot) };
    })
  );

  const data = results.flatMap((result) => result.rows);
  const truncated = data.length > MAX_ITEMS;
  return c.json({
    data: truncated ? data.slice(0, MAX_ITEMS) : data,
    nodes: results.map((result) => result.node),
    total: data.length,
    limit: MAX_ITEMS,
    truncated,
  });
}

export function registerDockerSnapshotRoutes(router: OpenAPIHono<AppEnv>) {
  router.get('/containers', (c) => aggregate(c, 'containers'));
  router.get('/images', (c) => aggregate(c, 'images'));
  router.get('/volumes', (c) => aggregate(c, 'volumes'));
  router.get('/networks', (c) => aggregate(c, 'networks'));

  router.post('/snapshots/refresh', async (c) => {
    const input = DockerSnapshotRefreshSchema.parse(await c.req.json());
    return c.json(await refreshDockerSnapshots(c.get('effectiveScopes') || [], input), 202);
  });
}

/**
 * POST /docker/snapshots/refresh and manage_docker_container refresh_snapshot: queue an urgent re-read of the
 * Docker snapshot cache for one node (needs the resource's view scope there) or for every node the caller sees.
 */
export async function refreshDockerSnapshots(
  scopes: string[],
  input: z.infer<typeof DockerSnapshotRefreshSchema>
): Promise<{ accepted: true; nodeCount: number }> {
  const snapshots = container.resolve(DockerSnapshotService);
  const resource = (input.resource ?? input.kind)!;
  const reconciler = container.resolve(DockerSnapshotReconciler);
  if (input.nodeId) {
    await snapshots.assertDockerNode(input.nodeId);
    const hasChildAccess = dockerScopedNodeIds(scopes, [VIEW_SCOPE[resource]]).includes(input.nodeId);
    if (!TokensService.hasScope(scopes, `${VIEW_SCOPE[resource]}:${input.nodeId}`) && !hasChildAccess) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required Docker node access scope', {
        requiredScope: `${VIEW_SCOPE[resource]}:${input.nodeId}`,
      });
    }
    if (resource === 'container-detail' && !(await canRefreshContainerDetail(scopes, input.nodeId, input.key!))) {
      throw new AppError(403, 'FORBIDDEN', 'Missing docker:containers:view permission for the requested container');
    }
    if (
      (resource === 'volume-detail' || resource === 'volume-metrics') &&
      !canRefreshVolumeDetail(scopes, input.nodeId, input.key!)
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Missing docker:volumes:view permission for the requested volume');
    }
    reconciler.enqueue({ nodeId: input.nodeId, kind: resource, key: input.key }, { urgent: true });
    return { accepted: true, nodeCount: 1 };
  }
  const listKind: DockerSnapshotKind =
    resource === 'container-detail'
      ? 'containers'
      : resource === 'volume-detail' || resource === 'volume-metrics'
        ? 'volumes'
        : resource;
  const visibleNodes = await snapshots.listVisibleNodes(listKind, scopes);
  for (const node of visibleNodes) {
    if (resource === 'container-detail' && !(await canRefreshContainerDetail(scopes, node.id, input.key!))) {
      continue;
    }
    if (
      (resource === 'volume-detail' || resource === 'volume-metrics') &&
      !canRefreshVolumeDetail(scopes, node.id, input.key!)
    ) {
      continue;
    }
    reconciler.enqueue({ nodeId: node.id, kind: resource, key: input.key }, { urgent: true });
  }
  return { accepted: true, nodeCount: visibleNodes.length };
}
