import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAccessResources, dockerDeployments } from '@/db/schema/index.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { withAppMembers } from '@/modules/apps/app-membership.js';
import {
  assertFolderManage,
  assertFolderManageForFolder,
  assertFolderManageForFolders,
} from '@/modules/resource-folders/resource-folder-access.js';
import type { AppEnv } from '@/types.js';
import {
  createDockerFolderRoute,
  deleteDockerFolderRoute,
  getDockerFolderPlacementsRoute,
  listDockerFoldersRoute,
  moveDockerContainersRoute,
  moveDockerFolderRoute,
  moveDockerResourcesRoute,
  reorderDockerContainersRoute,
  reorderDockerFoldersRoute,
  reorderDockerResourcesRoute,
  updateDockerFolderRoute,
} from './docker.docs.js';
import { DockerAccessResourceService, hasDockerResourceScope } from './docker-access-resource.service.js';
import {
  CreateDockerFolderSchema,
  DockerFolderPlacementsSchema,
  type DockerFolderResourceType,
  DockerFolderResourceTypeSchema,
  MoveDockerContainersToFolderSchema,
  MoveDockerFolderSchema,
  MoveDockerResourcesToFolderSchema,
  ReorderDockerContainersSchema,
  ReorderDockerFoldersSchema,
  ReorderDockerResourcesSchema,
  UpdateDockerFolderSchema,
} from './docker-folder.schemas.js';
import { type DockerFolderMoveAuthorizer, DockerFolderService } from './docker-folder.service.js';
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';

const VIEW_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:view',
  image: 'docker:images:view',
  network: 'docker:networks:view',
  volume: 'docker:volumes:view',
  compose: 'docker:compose:view',
} as const;

const MOVE_SCOPE_BY_RESOURCE_TYPE = {
  container: 'docker:containers:edit',
  image: 'docker:images:delete',
  volume: 'docker:volumes:delete',
  network: 'docker:networks:edit',
  compose: 'docker:compose:manage',
} as const;

function assertResourceScopes(
  scopes: string[],
  baseScope: string,
  items: Array<{ nodeId: string; resourceKey: string }>
) {
  for (const item of items) {
    if (!hasDockerResourceScope(scopes, baseScope, item.nodeId, item.resourceKey))
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
  }
}

async function containerFolderVisibility(scopes: string[], viewScope: string) {
  const visibility = composeFolderVisibility(scopes, viewScope);
  if (!visibility.allowedResourceRefs.length) return visibility;
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const refs = await Promise.all(
    visibility.allowedResourceRefs.map(async ({ nodeId, resourceKey }) => {
      const [deployment] = await db
        .select({ name: dockerDeployments.name })
        .from(dockerDeployments)
        .where(and(eq(dockerDeployments.id, resourceKey), eq(dockerDeployments.nodeId, nodeId)))
        .limit(1);
      if (deployment) return { nodeId, resourceKey: deployment.name };
      const [resource] = await db
        .select({ resourceKey: dockerAccessResources.resourceKey })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.id, resourceKey),
            eq(dockerAccessResources.nodeId, nodeId),
            eq(dockerAccessResources.resourceType, 'container')
          )
        )
        .limit(1);
      return resource ? { nodeId, resourceKey: resource.resourceKey } : null;
    })
  );
  return {
    ...visibility,
    allowedResourceRefs: refs.filter((ref): ref is { nodeId: string; resourceKey: string } => !!ref),
  };
}

function hasAnyDockerScope(scopes: string[], prefix: string): boolean {
  return scopes.some((scope) => scope === prefix || scope.startsWith(`${prefix}:`));
}

function requireAnyDockerScope(scopes: string[], prefix: string, message: string) {
  if (!hasAnyDockerScope(scopes, prefix)) {
    throw new AppError(403, 'FORBIDDEN', message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Node and node/resource targets of a scope. A target that names its node, or a resource identified by ID
 * (`resourceIds`), by something else (granted by name through the API before targets were checked) grants
 * nothing and is skipped, so it cannot reach a uuid column. Volumes and images are keyed by name.
 */
function scopedNodeTargets(scopes: string[], viewScope: string, resourceIds: boolean) {
  const targets = getResourceScopedIds(scopes, viewScope).filter((target) => !target.startsWith('folder/'));
  return {
    allowedNodeIds: targets.filter((target) => UUID_RE.test(target)),
    allowedResourceRefs: targets.flatMap((target) => {
      const [nodeId, resourceKey, ...rest] = target.split('/');
      return nodeId &&
        resourceKey &&
        rest.length === 0 &&
        UUID_RE.test(nodeId) &&
        (!resourceIds || UUID_RE.test(resourceKey))
        ? [{ nodeId, resourceKey }]
        : [];
    }),
  };
}

function composeFolderVisibility(scopes: string[], viewScope: string) {
  return scopedNodeTargets(scopes, viewScope, true);
}

async function assertContainerScopes(
  scopes: string[],
  baseScope: string,
  items: Array<{ nodeId: string; containerName: string }>
): Promise<void> {
  const resources = container.resolve(DockerAccessResourceService);
  for (const item of items) {
    const resourceId = await resources.resolveResourceByName(item.nodeId, item.containerName);
    if (!resourceId || !hasDockerResourceScope(scopes, baseScope, item.nodeId, resourceId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
    }
  }
}

async function assertNetworkScopes(
  scopes: string[],
  baseScope: string,
  items: Array<{ nodeId: string; resourceKey: string }>
): Promise<void> {
  const resources = container.resolve(DockerNetworkAccessResourceService);
  for (const item of items) {
    const resourceId = await resources.resolveNetwork(item.nodeId, item.resourceKey);
    if (!resourceId || !hasDockerResourceScope(scopes, baseScope, item.nodeId, resourceId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${baseScope}`);
    }
  }
}

function assertNetworkDestinationScope(
  scopes: string[],
  baseScope: string,
  nodeId: string,
  folderId: string | null
): void {
  if (
    hasScope(scopes, baseScope) ||
    hasScope(scopes, `${baseScope}:${nodeId}`) ||
    (!!folderId && hasScope(scopes, `${baseScope}:folder/${folderId}`))
  ) {
    return;
  }
  throw new AppError(403, 'FORBIDDEN', `Missing required destination scope: ${baseScope}`);
}

async function networkFolderVisibility(scopes: string[], viewScope: string) {
  const targets = scopedNodeTargets(scopes, viewScope, true);
  const resources = container.resolve(DockerNetworkAccessResourceService);
  const allowedResourceRefs = (
    await Promise.all(
      targets.allowedResourceRefs.map(async ({ nodeId, resourceKey: resourceId }) => {
        const resourceKey = await resources.resolveNetworkResourceKey(nodeId, resourceId);
        return resourceKey ? { nodeId, resourceKey } : null;
      })
    )
  ).filter((value): value is { nodeId: string; resourceKey: string } => !!value);
  return { allowedNodeIds: targets.allowedNodeIds, allowedResourceRefs };
}

/**
 * Moving a folder re-homes every resource inside it and its subfolders, so the caller needs what moving each of them
 * to the destination needs: the per-resource edit scope plus the destination rule of the move-resources routes.
 * Shared by PUT /folders/:id/move and the AI/MCP folder tool.
 */
export async function assertDockerFolderMoveAccess(
  scopes: string[],
  { resourceType, resources, destinationFolderId }: Parameters<DockerFolderMoveAuthorizer>[0]
): Promise<void> {
  // An empty folder re-homes nothing: docker:folders:manage (checked by the caller) is all it needs.
  if (resources.length === 0) return;
  if (resourceType === 'container') {
    await assertContainerScopes(
      scopes,
      MOVE_SCOPE_BY_RESOURCE_TYPE.container,
      resources.map((item) => ({ nodeId: item.nodeId, containerName: item.resourceKey }))
    );
  } else if (resourceType === 'network') {
    await assertNetworkScopes(scopes, MOVE_SCOPE_BY_RESOURCE_TYPE.network, resources);
  } else {
    assertResourceScopes(scopes, MOVE_SCOPE_BY_RESOURCE_TYPE[resourceType], resources);
  }
  const moveScope = MOVE_SCOPE_BY_RESOURCE_TYPE[resourceType];
  for (const item of resources) assertNetworkDestinationScope(scopes, moveScope, item.nodeId, destinationFolderId);
}

const DOCKER_FOLDER_MANAGE = 'docker:folders:manage';

/**
 * Moving or reordering Docker resources needs folder management at the destination (pass `undefined` for a reorder
 * in place) and at each resource's current folder; ungrouped resources need the broad scope. A folder grant manages
 * its subfolders in that folder's own Docker list (see resource-folder-access.ts).
 */
export async function assertDockerFolderManageForResources(
  scopes: readonly string[],
  resourceType: DockerFolderResourceType,
  items: ReadonlyArray<{ nodeId: string; resourceKey: string }>,
  destinationFolderId: string | null | undefined
): Promise<void> {
  if (hasScope([...scopes], DOCKER_FOLDER_MANAGE)) return;
  if (destinationFolderId !== undefined) assertFolderManage(scopes, DOCKER_FOLDER_MANAGE, destinationFolderId);
  const placements = await container
    .resolve(DockerFolderService)
    .getResourcePlacementsForRefs(resourceType, [...items]);
  const folderByRef = new Map(
    placements.map((placement) => [`${placement.nodeId}\u0000${placement.resourceKey}`, placement.folderId ?? null])
  );
  const places = new Set(items.map((item) => folderByRef.get(`${item.nodeId}\u0000${item.resourceKey}`) ?? null));
  for (const folderId of places) assertFolderManage(scopes, DOCKER_FOLDER_MANAGE, folderId);
}

/** The folder-move authorizer of the HTTP route and the AI/MCP folder tool. */
export function dockerFolderMoveAuthorizer(scopes: string[]): DockerFolderMoveAuthorizer {
  return async (context) => {
    assertFolderManage(scopes, DOCKER_FOLDER_MANAGE, context.sourceParentId);
    assertFolderManage(scopes, DOCKER_FOLDER_MANAGE, context.destinationFolderId);
    await assertDockerFolderMoveAccess(scopes, context);
  };
}

/** Who may list Docker folders of a resource type and which folders they see; shared with the AI/MCP folder tools. */
export async function dockerFolderTreeOptions(scopes: string[], resourceType: DockerFolderResourceType) {
  const viewScope = VIEW_SCOPE_BY_RESOURCE_TYPE[resourceType];
  const createScope =
    resourceType === 'image'
      ? 'docker:images:pull'
      : resourceType === 'compose'
        ? 'docker:compose:create'
        : `docker:${resourceType}s:create`;
  if (
    !hasScopeBase(scopes, viewScope) &&
    !hasScopeBase(scopes, createScope) &&
    !hasScopeBase(scopes, 'docker:folders:manage')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Docker folders require resource view access or docker:folders:manage');
  }
  // Only a caller who sees every resource (or manages every folder) sees every folder. A creator
  // limited in what they view sees the folders they were granted and the ones holding resources
  // they can view, so a folder-limited user never lists other people's (empty) folders.
  const canManageFolders = hasScope(scopes, 'docker:folders:manage');
  return canManageFolders || hasScope(scopes, viewScope)
    ? { resourceType, includeAllFolders: true }
    : {
        resourceType,
        allowedFolderIds: getFolderScopedIds(scopes, [viewScope, createScope, DOCKER_FOLDER_MANAGE]),
        ...(resourceType === 'container'
          ? await containerFolderVisibility(scopes, viewScope)
          : resourceType === 'compose'
            ? composeFolderVisibility(scopes, viewScope)
            : resourceType === 'network'
              ? await networkFolderVisibility(scopes, viewScope)
              : scopedNodeTargets(scopes, viewScope, false)),
      };
}

export function registerDockerFolderRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(listDockerFoldersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const resourceType = DockerFolderResourceTypeSchema.default('container').parse(c.req.query('resourceType'));
    const options = await dockerFolderTreeOptions(scopes, resourceType);
    const data = await container.resolve(DockerFolderService).getFolderTree(options);
    return c.json({ data });
  });

  router.openapi(createDockerFolderRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(scopes, 'docker:folders:manage', 'Creating Docker folders requires docker:folders:manage');
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = CreateDockerFolderSchema.parse(body);
    assertFolderManage(scopes, DOCKER_FOLDER_MANAGE, input.parentId ?? null);
    const service = container.resolve(DockerFolderService);
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  });

  router.openapi(reorderDockerFoldersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(scopes, 'docker:folders:manage', 'Reordering Docker folders requires docker:folders:manage');
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = ReorderDockerFoldersSchema.parse(body);
    const service = container.resolve(DockerFolderService);
    await assertFolderManageForFolders(
      service,
      scopes,
      DOCKER_FOLDER_MANAGE,
      input.items.map((item) => item.id)
    );
    await service.reorderFolders(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(reorderDockerResourcesRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:folders:manage',
      'Reordering Docker resources requires docker:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = ReorderDockerResourcesSchema.parse(body);
    await assertDockerFolderManageForResources(scopes, input.resourceType, input.items, undefined);
    if (input.resourceType === 'container') {
      await assertContainerScopes(
        scopes,
        'docker:containers:edit',
        input.items.map((item) => ({ nodeId: item.nodeId, containerName: item.resourceKey }))
      );
    }
    if (input.resourceType === 'network') {
      await assertNetworkScopes(scopes, 'docker:networks:edit', input.items);
    }
    if (input.resourceType !== 'container' && input.resourceType !== 'network')
      assertResourceScopes(scopes, MOVE_SCOPE_BY_RESOURCE_TYPE[input.resourceType], input.items);
    const service = container.resolve(DockerFolderService);
    await service.reorderResources(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(reorderDockerContainersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:folders:manage',
      'Reordering Docker containers requires docker:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = ReorderDockerContainersSchema.parse(body);
    await assertDockerFolderManageForResources(
      scopes,
      'container',
      input.items.map((item) => ({ nodeId: item.nodeId, resourceKey: item.containerName })),
      undefined
    );
    await assertContainerScopes(scopes, 'docker:containers:edit', input.items);
    const service = container.resolve(DockerFolderService);
    await service.reorderContainers(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(updateDockerFolderRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(scopes, 'docker:folders:manage', 'Updating Docker folders requires docker:folders:manage');
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = UpdateDockerFolderSchema.parse(body);
    const service = container.resolve(DockerFolderService);
    await assertFolderManageForFolder(service, scopes, DOCKER_FOLDER_MANAGE, c.req.param('id')!);
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  });

  router.openapi(moveDockerFolderRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(scopes, 'docker:folders:manage', 'Moving Docker folders requires docker:folders:manage');
    const user = c.get('user')!;
    const input = MoveDockerFolderSchema.parse(await c.req.json());
    const service = container.resolve(DockerFolderService);
    const data = await service.moveFolder(c.req.param('id')!, input, user.id, dockerFolderMoveAuthorizer(scopes));
    return c.json({ data });
  });

  router.openapi(deleteDockerFolderRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(scopes, 'docker:folders:manage', 'Deleting Docker folders requires docker:folders:manage');
    const user = c.get('user')!;
    const service = container.resolve(DockerFolderService);
    await assertFolderManageForFolder(service, scopes, DOCKER_FOLDER_MANAGE, c.req.param('id')!);
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.body(null, 204);
  });

  router.openapi(moveDockerContainersRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:folders:manage',
      'Moving containers between Docker folders requires docker:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = MoveDockerContainersToFolderSchema.parse(body);
    await assertDockerFolderManageForResources(
      scopes,
      'container',
      input.items.map((item) => ({ nodeId: item.nodeId, resourceKey: item.containerName })),
      input.folderId
    );
    await assertContainerScopes(scopes, 'docker:containers:edit', input.items);
    for (const item of input.items)
      assertNetworkDestinationScope(scopes, 'docker:containers:edit', item.nodeId, input.folderId);
    const service = container.resolve(DockerFolderService);
    await service.moveContainersToFolder(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(moveDockerResourcesRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    requireAnyDockerScope(
      scopes,
      'docker:folders:manage',
      'Moving Docker resources between folders requires docker:folders:manage'
    );
    const user = c.get('user')!;
    const body = await c.req.json();
    const input = MoveDockerResourcesToFolderSchema.parse(body);
    await assertDockerFolderManageForResources(scopes, input.resourceType, input.items, input.folderId);
    if (input.resourceType === 'container') {
      await assertContainerScopes(
        scopes,
        'docker:containers:edit',
        input.items.map((item) => ({ nodeId: item.nodeId, containerName: item.resourceKey }))
      );
    }
    if (input.resourceType === 'network') {
      await assertNetworkScopes(scopes, 'docker:networks:edit', input.items);
    }
    const moveScope = MOVE_SCOPE_BY_RESOURCE_TYPE[input.resourceType];
    if (input.resourceType !== 'container' && input.resourceType !== 'network')
      assertResourceScopes(scopes, moveScope, input.items);
    for (const item of input.items) assertNetworkDestinationScope(scopes, moveScope, item.nodeId, input.folderId);
    const service = container.resolve(DockerFolderService);
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  });

  router.openapi(getDockerFolderPlacementsRoute, async (c) => {
    const scopes = c.get('effectiveScopes') || [];
    const body = await c.req.json();
    const input = DockerFolderPlacementsSchema.parse(body);
    const viewScope = VIEW_SCOPE_BY_RESOURCE_TYPE[input.resourceType];
    if (!hasScopeBase(scopes, viewScope) && !hasScope(scopes, 'docker:folders:manage')) {
      throw new AppError(403, 'FORBIDDEN', 'Docker folder placements require resource view access');
    }
    if (input.resourceType === 'container') {
      await assertContainerScopes(
        scopes,
        viewScope,
        input.items.map((item) => ({ nodeId: item.nodeId, containerName: item.resourceKey }))
      );
    }
    if (input.resourceType === 'network') {
      await assertNetworkScopes(scopes, viewScope, input.items);
    }
    if (input.resourceType !== 'container' && input.resourceType !== 'network')
      assertResourceScopes(scopes, viewScope, input.items);
    const service = container.resolve(DockerFolderService);
    const placements = await service.getResourcePlacementsForRefs(input.resourceType, input.items);
    // Container and Compose placements carry `app` (a member sits in a hidden app folder, never in the folder tree).
    const data =
      input.resourceType === 'container' || input.resourceType === 'compose'
        ? await withAppMembers(input.resourceType === 'compose' ? 'compose' : 'containers', placements)
        : placements;
    return c.json({ data });
  });
}
