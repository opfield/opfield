import type { OpenAPIHono } from '@hono/zod-openapi';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import {
  assertComposeChildMutationAllowed,
  assertComposeNetworkMutationAllowed,
} from './compose/compose-child.guard.js';
import { isComposeOwnedNetwork } from './compose/compose-discovery.service.js';
import {
  connectNetworkRoute,
  createNetworkRoute,
  disconnectNetworkRoute,
  listNetworksRoute,
  removeNetworkRoute,
} from './docker.docs.js';
import { NetworkConnectSchema, NetworkCreateSchema } from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import { requireDockerNetworkScope } from './docker-access.middleware.js';
import { DockerAccessResourceService, hasDockerResourceScope } from './docker-access-resource.service.js';
import { dockerCreationDeniedMessage } from './docker-creation-access.js';
import { DockerFolderService } from './docker-folder.service.js';
import { isOpfieldManagedDockerNetwork } from './docker-internal-networks.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_NETWORK_CONTAINER_PREVIEW_MAX = 100;
const DOCKER_NETWORK_IPAM_CONFIG_MAX = 8;

function compactNetworkContainers(containers: unknown) {
  if (!containers || typeof containers !== 'object') return undefined;
  const entries = Object.entries(containers as Record<string, any>);
  return Object.fromEntries(
    entries.slice(0, DOCKER_NETWORK_CONTAINER_PREVIEW_MAX).map(([id, endpoint]) => [
      id,
      {
        name: endpoint?.name ?? endpoint?.Name,
      },
    ])
  );
}

function compactNetworkIpam(ipam: any) {
  const config = ipam?.config ?? ipam?.Config;
  if (!Array.isArray(config)) return undefined;
  return {
    config: config.slice(0, DOCKER_NETWORK_IPAM_CONFIG_MAX).map((entry: any) => ({
      subnet: entry.subnet ?? entry.Subnet,
      gateway: entry.gateway ?? entry.Gateway,
    })),
  };
}

function hasNetworkDestinationScope(
  scopes: readonly string[],
  baseScope: string,
  nodeId: string,
  folderId: string | null | undefined
): boolean {
  return hasScopeForCreation(scopes, baseScope, folderId, nodeId);
}

async function assertNetworkContainerEditScope(scopes: string[], nodeId: string, containerId: string): Promise<void> {
  if (hasDockerResourceScope(scopes, 'docker:containers:edit', nodeId, '')) return;
  const resources = container.resolve(DockerAccessResourceService);
  const resourceId =
    (await resources.resolveContainer(nodeId, { runtimeId: containerId })) ??
    (await resources.resolveContainer(nodeId, { name: containerId }));
  if (!resourceId || !hasDockerResourceScope(scopes, 'docker:containers:edit', nodeId, resourceId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required scope: docker:containers:edit');
  }
}

export function compactNetworkListItem(network: Record<string, any>) {
  const containers = network.containers ?? network.Containers;
  const containerEntries = containers && typeof containers === 'object' ? Object.entries(containers) : [];
  return {
    id: network.id ?? network.Id,
    name: network.name ?? network.Name,
    driver: network.driver ?? network.Driver,
    scope: network.scope ?? network.Scope,
    created: network.created ?? network.Created,
    internal: network.internal ?? network.Internal,
    attachable: network.attachable ?? network.Attachable,
    ingress: network.ingress ?? network.Ingress,
    containers: compactNetworkContainers(containers),
    containersCount: containerEntries.length,
    containersTruncated: containerEntries.length > DOCKER_NETWORK_CONTAINER_PREVIEW_MAX,
    ipam: compactNetworkIpam(network.ipam ?? network.IPAM),
    scopeResourceId: network.scopeResourceId ?? null,
    folderId: network.folderId ?? null,
    folderIsSystem: network.folderIsSystem ?? false,
    folderSortOrder: network.folderSortOrder ?? 0,
  };
}

export function matchesNetworkSearch(network: ReturnType<typeof compactNetworkListItem>, search: string | undefined) {
  if (!search) return true;
  const haystack = [network.id, network.name, network.driver, network.scope].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(search);
}

export function registerNetworkRoutes(router: OpenAPIHono<AppEnv>) {
  // ─── Network routes ──────────────────────────────────────────────────

  // List networks
  router.openapi(listNetworksRoute, async (c) => {
    const snapshots = container.resolve(DockerSnapshotService);
    const nodeId = c.req.param('nodeId')!;
    const scopes = c.get('effectiveScopes') ?? [];
    if (!hasScopeBase(scopes, 'docker:networks:view')) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required scope: docker:networks:view');
    }
    await snapshots.assertDockerNode(nodeId);
    const snapshot = await snapshots.getList<any[]>(nodeId, 'networks');
    const data = snapshot.data;
    if (!Array.isArray(data)) return c.json({ data });
    const search = c.req.query('search')?.trim().toLowerCase();
    const decorated = await container.resolve(DockerManagementService).decoratePublicNetworkSnapshot(
      nodeId,
      data
        .filter((item) => !isOpfieldManagedDockerNetwork(String(item.name ?? item.Name ?? '')))
        .filter((item) => !isComposeOwnedNetwork(item))
    );
    const compacted = decorated
      .map((item) => ({
        ...compactNetworkListItem(item),
        scopeResourceId: item.scopeResourceId,
        folderId: item.folderId,
        folderIsSystem: item.folderIsSystem,
        folderSortOrder: item.folderSortOrder,
        nodeId,
        availability: snapshots.availability(nodeId, snapshot),
      }))
      .filter(
        (item) =>
          hasDockerResourceScope(scopes, 'docker:networks:view', nodeId, '') ||
          (!!item.scopeResourceId &&
            hasDockerResourceScope(scopes, 'docker:networks:view', nodeId, item.scopeResourceId))
      )
      .filter((item) => matchesNetworkSearch(item, search));
    const truncated = compacted.length > DOCKER_RESOURCE_LIST_MAX;
    return c.json({
      data: truncated ? compacted.slice(0, DOCKER_RESOURCE_LIST_MAX) : compacted,
      total: compacted.length,
      limit: DOCKER_RESOURCE_LIST_MAX,
      truncated,
    });
  });

  // Create network
  router.openapi(createNetworkRoute, async (c) => {
    const service = container.resolve(DockerManagementService);
    const nodeId = c.req.param('nodeId')!;
    const user = c.get('user')!;
    const body = await c.req.json();
    const config = NetworkCreateSchema.parse(body);
    const scopes = c.get('effectiveScopes') ?? [];
    if (!hasNetworkDestinationScope(scopes, 'docker:networks:create', nodeId, config.folderId)) {
      const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
      throw new AppError(
        403,
        'FORBIDDEN',
        await dockerCreationDeniedMessage(db, scopes, 'docker:networks:create', config.folderId)
      );
    }
    await container.resolve(DockerFolderService).assertResourceDestination('network', config.folderId);
    const data = await service.createNetwork(nodeId, config, user.id);
    return c.json({ data }, 201);
  });

  // Remove network
  router.openapi(
    { ...removeNetworkRoute, middleware: requireDockerNetworkScope('docker:networks:delete') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const networkId = c.req.param('networkId')!;
      const user = c.get('user')!;
      await assertComposeNetworkMutationAllowed(nodeId, networkId);
      await service.removeNetwork(nodeId, networkId, user.id);
      return c.json({ success: true });
    }
  );

  // Connect container to network
  router.openapi(
    { ...connectNetworkRoute, middleware: requireDockerNetworkScope('docker:networks:edit') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const networkId = c.req.param('networkId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { containerId } = NetworkConnectSchema.parse(body);
      await assertNetworkContainerEditScope(c.get('effectiveScopes') ?? [], nodeId, containerId);
      await Promise.all([
        assertComposeNetworkMutationAllowed(nodeId, networkId),
        assertComposeChildMutationAllowed(nodeId, containerId),
      ]);
      await service.connectContainerToNetwork(nodeId, networkId, containerId, user.id);
      return c.json({ success: true });
    }
  );

  // Disconnect container from network
  router.openapi(
    { ...disconnectNetworkRoute, middleware: requireDockerNetworkScope('docker:networks:edit') },
    async (c) => {
      const service = container.resolve(DockerManagementService);
      const nodeId = c.req.param('nodeId')!;
      const networkId = c.req.param('networkId')!;
      const user = c.get('user')!;
      const body = await c.req.json();
      const { containerId } = NetworkConnectSchema.parse(body);
      await assertNetworkContainerEditScope(c.get('effectiveScopes') ?? [], nodeId, containerId);
      await Promise.all([
        assertComposeNetworkMutationAllowed(nodeId, networkId),
        assertComposeChildMutationAllowed(nodeId, containerId),
      ]);
      await service.disconnectContainerFromNetwork(nodeId, networkId, containerId, user.id);
      return c.json({ success: true });
    }
  );
}
