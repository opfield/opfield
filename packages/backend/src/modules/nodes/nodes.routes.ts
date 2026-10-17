import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import {
  getResourceScopedIds,
  hasScope,
  hasScopeBase,
  hasScopeForCreation,
  hasScopeForResource,
} from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  assertNotImpersonating,
  authMiddleware,
  requireScopeBase,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import {
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
} from '@/modules/docker/docker.schemas.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import {
  daemonLogRelay,
  getDaemonLogHistory,
  getNginxLogHistory,
  logRelay,
  type RelayedDaemonLogEntry,
  type RelayedLogEntry,
} from '@/modules/monitoring/log-relay.service.js';
import { subscribeNginxHostLogs } from '@/modules/monitoring/nginx-log-subscriptions.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  assertFolderManage,
  assertFolderManageForFolder,
  assertFolderManageForFolders,
  assertFolderManageForResources,
} from '@/modules/resource-folders/resource-folder-access.js';
import { nodeHostAccessFlags } from '@/services/node-host-access.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { AppEnv } from '@/types.js';
import { createNodeForActor, regenerateNodeEnrollmentTokenForActor, updateNodeForActor } from './node-actions.js';
import { NodeFolderService } from './node-folders.service.js';
import { browserHostOpfield, enrollmentInstallation, managedConsoleHostOpfield } from './node-installer.js';
import { DOCKER_LIST_FOLDER_BASES, NODE_LIST_FOLDER_BASES } from './node-list-access.js';
import { daemonLogMatcher, nginxLogEntryKey, nginxLogMatcher, splitLogFilterList } from './node-log-filters.js';
import { compactMonitoringHistorySnapshot, NodeMonitoringService } from './node-monitoring.service.js';
import {
  abortNodeFileUploadRoute,
  completeNodeFileUploadRoute,
  createNodeDirectoryRoute,
  createNodeFileRoute,
  createNodeFolderRoute,
  createNodeRoute,
  deleteNodeFileRoute,
  deleteNodeFolderRoute,
  deleteNodeRoute,
  getNodeBySlugRoute,
  getNodeConfigRoute,
  getNodeHealthHistoryRoute,
  getNodeRoute,
  initNodeFileUploadRoute,
  listNodeFilesRoute,
  listNodeFoldersRoute,
  listNodesRoute,
  moveNodeFileRoute,
  moveNodeFolderRoute,
  moveNodesToFolderRoute,
  nodeDaemonLogsRoute,
  nodeMonitoringStreamRoute,
  nodeNginxLogsRoute,
  readNodeFileRoute,
  regenerateNodeEnrollmentTokenRoute,
  reorderNodeFoldersRoute,
  reorderNodesRoute,
  testNodeConfigRoute,
  updateNodeConfigRoute,
  updateNodeFolderRoute,
  updateNodeRoute,
  updateNodeServiceCreationLockRoute,
  uploadNodeFileChunkRoute,
  writeNodeFileRoute,
} from './nodes.docs.js';
import {
  CreateNodeSchema,
  NodeListQuerySchema,
  UpdateNodeSchema,
  UpdateNodeServiceCreationLockSchema,
} from './nodes.schemas.js';
import { NodesService } from './nodes.service.js';

export { compactMonitoringHistorySnapshot };

export const nodesRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

nodesRoutes.use('*', authMiddleware);

const NODE_FILE_LIST_MAX = 1000;

async function parseFileContentRequest(c: Parameters<Parameters<OpenAPIHono<AppEnv>['openapi']>[1]>[0]) {
  const path = FileBrowseSchema.parse(c.req.query()).path;
  const content = Buffer.from(await c.req.arrayBuffer());
  return { path, content };
}

const BROAD_DOCKER_VIEW_SCOPES = [
  'docker:containers:view',
  'docker:images:view',
  'docker:volumes:view',
  'docker:networks:view',
  'docker:compose:view',
] as const;

const DOCKER_CREATION_SCOPES = [
  'docker:containers:create',
  'docker:compose:create',
  'docker:volumes:create',
  'docker:networks:create',
  'docker:images:pull',
] as const;

const RESOURCE_SCOPED_DOCKER_NODE_SCOPES = [
  'docker:compose:view',
  'docker:compose:create',
  'docker:compose:manage',
  'docker:compose:delete',
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

function hasBroadDockerNodeListAccess(scopes: string[]) {
  return (
    BROAD_DOCKER_VIEW_SCOPES.some((scope) => hasScope(scopes, scope)) ||
    DOCKER_CREATION_SCOPES.some(
      (base) => hasScope(scopes, base) || scopes.some((scope) => scope.startsWith(`${base}:folder/`))
    )
  );
}

function compactDockerNodeForDockerAccess(node: Record<string, unknown>) {
  const capabilities = node.capabilities as Record<string, unknown> | null | undefined;
  const health = node.lastHealthReport as Record<string, unknown> | null | undefined;
  const advertisedCapabilities = Array.isArray(capabilities?.capabilities)
    ? capabilities.capabilities.filter((value): value is string => typeof value === 'string')
    : [];
  const networkInterfaces = Array.isArray(health?.networkInterfaces) ? health.networkInterfaces : [];
  return {
    id: node.id,
    slug: node.slug,
    type: node.type,
    hostname: node.hostname,
    displayName: node.displayName,
    appearanceColor: node.appearanceColor,
    serviceAddresses: node.serviceAddresses,
    serviceAddress: node.serviceAddress,
    secondaryServiceAddress: node.secondaryServiceAddress,
    effectiveServiceAddress: node.effectiveServiceAddress,
    status: node.status,
    serviceCreationLocked: node.serviceCreationLocked,
    daemonVersion: node.daemonVersion,
    osInfo: null,
    configVersionHash: null,
    capabilities: {
      ...(capabilities?.versionMismatch ? { versionMismatch: true } : {}),
      ...(capabilities?.cpuCores !== undefined ? { cpuCores: capabilities.cpuCores } : {}),
      ...(capabilities?.dockerRuntimeStatus ? { dockerRuntimeStatus: capabilities.dockerRuntimeStatus } : {}),
      ...(advertisedCapabilities.includes('docker_port_bind_ip_v1') ? { dockerPortBindIpV1: true } : {}),
      ...(advertisedCapabilities.includes('docker_volume_storage_images_v1')
        ? { dockerVolumeStorageImagesV1: true }
        : {}),
      ...(advertisedCapabilities.includes('docker_daemon_non_root_v1') ? { dockerDaemonNonRootV1: true } : {}),
      ...(advertisedCapabilities.includes('nginx_pages_v1') ? { nginx_pages_v1: true } : {}),
      ...(advertisedCapabilities.includes('nginx_pages_config_v1') ? { nginx_pages_config_v1: true } : {}),
      ...(advertisedCapabilities.includes('managed_databases_v1') ? { managedDatabasesV1: true } : {}),
      ...(advertisedCapabilities.includes('managed_storage_v1') ? { managedStorageV1: true } : {}),
      ...(advertisedCapabilities.includes('database_backups_v1') ? { databaseBackupsV1: true } : {}),
      ...nodeHostAccessFlags(advertisedCapabilities),
    },
    lastSeenAt: node.lastSeenAt,
    lastHealthReport: health
      ? {
          systemMemoryTotalBytes: health.systemMemoryTotalBytes,
          swapTotalBytes: health.swapTotalBytes,
          networkInterfaces: networkInterfaces.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const networkInterface = value as Record<string, unknown>;
            if (typeof networkInterface.name !== 'string') return [];
            return [
              {
                name: networkInterface.name,
                ipAddresses: Array.isArray(networkInterface.ipAddresses)
                  ? networkInterface.ipAddresses.filter((address): address is string => typeof address === 'string')
                  : [],
              },
            ];
          }),
        }
      : null,
    lastStatsReport: null,
    metadata: {},
    isConnected: node.isConnected,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

nodesRoutes.openapi(listNodesRoute, async (c) => {
  const service = container.resolve(NodesService);
  const query = NodeListQuerySchema.parse(c.req.query());
  const scopes = c.get('effectiveScopes') || [];
  const hasNodeDetails = hasScope(scopes, 'nodes:details');
  const canManageFolders = hasScope(scopes, 'nodes:folders:manage');
  const allowedNodeIds = getResourceScopedIds(scopes, 'nodes:details');
  const hasNodeFolderGrant = getFolderScopedIds(scopes, NODE_LIST_FOLDER_BASES).length > 0;
  const hasDockerFolderGrant =
    query.type === 'docker' && getFolderScopedIds(scopes, DOCKER_LIST_FOLDER_BASES).length > 0;
  const allowedDockerNodeIds =
    query.type === 'docker' ? dockerScopedNodeIds(scopes, RESOURCE_SCOPED_DOCKER_NODE_SCOPES) : [];
  const canListAllDockerNodes = query.type === 'docker' && hasBroadDockerNodeListAccess(scopes);
  const canListDockerNodes = canListAllDockerNodes || allowedDockerNodeIds.length > 0;
  const creationBases =
    query.type === 'nginx'
      ? ['proxy:create', 'pages:create']
      : query.type === 'databases' || query.type === 'storage'
        ? ['databases:create', 'storage:create']
        : [];
  const isStatefulNodeQuery = query.type === 'databases' || query.type === 'storage';
  const allowedBackupExecutorNodeIds = isStatefulNodeQuery ? getResourceScopedIds(scopes, 'nodes:backups:execute') : [];
  const canListAllBackupExecutorNodes = isStatefulNodeQuery && hasScope(scopes, 'nodes:backups:execute');
  const canListBackupExecutorNodes = canListAllBackupExecutorNodes || allowedBackupExecutorNodeIds.length > 0;
  const allowedIngressNodeIds = [
    ...new Set(
      creationBases.flatMap((base) =>
        scopes.flatMap((scope) => {
          const prefix = `${base}:`;
          if (!scope.startsWith(prefix)) return [];
          const target = scope.slice(prefix.length);
          if (target.startsWith('node/')) return [target.slice('node/'.length)];
          // Legacy proxy:create UUIDs name nodes; database UUIDs do not.
          return base === 'proxy:create' && !target.includes('/') ? [target] : [];
        })
      )
    ),
  ];
  const canListAllIngressNodes = creationBases.some(
    (base) => hasScope(scopes, base) || scopes.some((scope) => scope.startsWith(`${base}:folder/`))
  );
  const canListIngressNodes = canListAllIngressNodes || allowedIngressNodeIds.length > 0;
  if (
    !hasNodeDetails &&
    !canManageFolders &&
    allowedNodeIds.length === 0 &&
    !hasNodeFolderGrant &&
    !hasDockerFolderGrant &&
    !canListDockerNodes &&
    !canListIngressNodes &&
    !canListBackupExecutorNodes
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Missing permission for the requested node inventory', {
      requiredScopes: [
        'nodes:details',
        'nodes:folders:manage',
        ...creationBases,
        ...(isStatefulNodeQuery ? ['nodes:backups:execute'] : []),
        ...(query.type === 'docker' ? RESOURCE_SCOPED_DOCKER_NODE_SCOPES : []),
      ],
      scopeMatch: 'any',
    });
  }
  const scopedNodeIds =
    query.type === 'docker' && !canListAllDockerNodes
      ? [...new Set([...allowedNodeIds, ...allowedDockerNodeIds])]
      : creationBases.length > 0 && !canListAllIngressNodes && !canListAllBackupExecutorNodes
        ? [...new Set([...allowedNodeIds, ...allowedIngressNodeIds, ...allowedBackupExecutorNodeIds])]
        : allowedNodeIds;
  const result = await service.list(
    query,
    hasNodeDetails ||
      canManageFolders ||
      canListAllDockerNodes ||
      canListAllIngressNodes ||
      canListAllBackupExecutorNodes
      ? undefined
      : { allowedIds: scopedNodeIds }
  );
  if (query.type === 'docker' && (canListDockerNodes || hasDockerFolderGrant) && !hasNodeDetails) {
    return c.json({ ...result, data: result.data.map((node) => compactDockerNodeForDockerAccess(node as any)) });
  }
  if (
    creationBases.length > 0 &&
    (canListIngressNodes || canListBackupExecutorNodes) &&
    !hasNodeDetails &&
    !canManageFolders
  ) {
    return c.json({ ...result, data: result.data.map((node) => compactDockerNodeForDockerAccess(node as any)) });
  }
  return c.json(result);
});

nodesRoutes.openapi(listNodeFoldersRoute, async (c) => {
  const service = container.resolve(NodeFolderService);
  const scopes = c.get('effectiveScopes') || [];
  const canManageFolders = hasScope(scopes, 'nodes:folders:manage');
  const hasNodeDetails = hasScope(scopes, 'nodes:details');
  const hasGlobalCreate = hasScope(scopes, 'nodes:create');
  const allowedNodeIds = getResourceScopedIds(scopes, 'nodes:details');
  const allowedFolderIds = getFolderScopedIds(scopes, [
    'nodes:details',
    'nodes:rename',
    'nodes:create',
    'nodes:folders:manage',
  ]);
  if (
    !hasScopeBase(scopes, 'nodes:folders:manage') &&
    !hasScopeBase(scopes, 'nodes:details') &&
    !hasScopeBase(scopes, 'nodes:create')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required node details, create, or folder scope', {
      requiredScopes: ['nodes:details', 'nodes:create', 'nodes:folders:manage'],
      scopeMatch: 'any',
    });
  }
  const data = await service.getFolderTree(
    canManageFolders || hasNodeDetails || hasGlobalCreate
      ? { includeAllFolders: true }
      : { allowedResourceIds: allowedNodeIds, allowedFolderIds }
  );
  return c.json({ data });
});

nodesRoutes.openapi({ ...createNodeFolderRoute, middleware: requireScopeBase('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = CreateResourceFolderSchema.parse(await c.req.json());
  assertFolderManage(c.get('effectiveScopes') ?? [], 'nodes:folders:manage', input.parentId ?? null);
  const data = await service.createFolder(input, user.id);
  return c.json({ data }, 201);
});

nodesRoutes.openapi({ ...reorderNodeFoldersRoute, middleware: requireScopeBase('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const input = ReorderResourceFoldersSchema.parse(await c.req.json());
  await assertFolderManageForFolders(
    service,
    c.get('effectiveScopes') ?? [],
    'nodes:folders:manage',
    input.items.map((item) => item.id)
  );
  await service.reorderFolders(input);
  return c.json({ success: true });
});

nodesRoutes.openapi({ ...moveNodesToFolderRoute, middleware: requireScopeBase('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = MoveResourcesToFolderSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') ?? [];
  await assertFolderManageForResources(service, scopes, 'nodes:folders:manage', input.ids, input.folderId);
  if (!input.ids.every((id) => hasScopeForResource(scopes, 'nodes:rename', id))) {
    throw new AppError(403, 'FORBIDDEN', 'Missing node rename access for one or more move sources');
  }
  if (!hasScopeForCreation(scopes, 'nodes:rename', input.folderId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing node rename access for the move destination');
  }
  await service.moveResourcesToFolder(input, user.id);
  return c.json({ success: true });
});

nodesRoutes.openapi({ ...reorderNodesRoute, middleware: requireScopeBase('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const input = ReorderResourcesSchema.parse(await c.req.json());
  await assertFolderManageForResources(
    service,
    c.get('effectiveScopes') ?? [],
    'nodes:folders:manage',
    input.items.map((item) => item.id),
    undefined
  );
  await service.reorderResources(input);
  return c.json({ success: true });
});

nodesRoutes.openapi({ ...updateNodeFolderRoute, middleware: requireScopeBase('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = UpdateResourceFolderSchema.parse(await c.req.json());
  await assertFolderManageForFolder(
    service,
    c.get('effectiveScopes') ?? [],
    'nodes:folders:manage',
    c.req.param('id')!
  );
  const data = await service.updateFolder(c.req.param('id')!, input, user.id);
  return c.json({ data });
});

nodesRoutes.openapi({ ...moveNodeFolderRoute, middleware: requireScopeBase('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  const input = MoveResourceFolderSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') ?? [];
  const data = await service.moveFolder(
    c.req.param('id')!,
    input,
    user.id,
    { scopes, editScope: 'nodes:rename' },
    { scopes, manageScope: 'nodes:folders:manage' }
  );
  return c.json({ data });
});

nodesRoutes.openapi({ ...deleteNodeFolderRoute, middleware: requireScopeBase('nodes:folders:manage') }, async (c) => {
  const service = container.resolve(NodeFolderService);
  const user = c.get('user')!;
  await assertFolderManageForFolder(
    service,
    c.get('effectiveScopes') ?? [],
    'nodes:folders:manage',
    c.req.param('id')!
  );
  await service.deleteFolder(c.req.param('id')!, user.id);
  return c.json({ success: true });
});

nodesRoutes.openapi(getNodeBySlugRoute, async (c) => {
  const service = container.resolve(NodesService);
  const node = await service.getBySlug(c.req.param('slug')!);
  const scopes = c.get('effectiveScopes') || [];
  if (!hasScope(scopes, `nodes:details:${node.id}`)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: nodes:details:${node.id}`);
  }
  return c.json({ data: node });
});

nodesRoutes.openapi({ ...getNodeRoute, middleware: requireScopeForResource('nodes:details', 'id') }, async (c) => {
  const service = container.resolve(NodesService);
  const monitoringService = container.resolve(NodeMonitoringService);
  const id = c.req.param('id')!;
  const [node, monitoringHistory] = await Promise.all([service.get(id), monitoringService.getHistory(id)]);
  return c.json({ data: { ...node, monitoringHistory } });
});

nodesRoutes.openapi(
  { ...getNodeHealthHistoryRoute, middleware: requireScopeForResource('nodes:details', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const healthHistory = await service.getHealthHistory(id);
    return c.json({ data: healthHistory });
  }
);

nodesRoutes.openapi(
  { ...listNodeFilesRoute, middleware: requireScopeForResource('nodes:files:read', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const { path } = FileBrowseSchema.parse(c.req.query());
    const data = await service.listFiles(id, path, c.get('user')!.id);
    const truncated = Array.isArray(data) && data.length > NODE_FILE_LIST_MAX;
    return c.json({
      data: truncated ? data.slice(0, NODE_FILE_LIST_MAX) : data,
      total: Array.isArray(data) ? data.length : undefined,
      limit: NODE_FILE_LIST_MAX,
      truncated,
    });
  }
);

nodesRoutes.openapi(
  { ...readNodeFileRoute, middleware: requireScopeForResource('nodes:files:read', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const { path } = FileBrowseSchema.parse(c.req.query());
    const data = await service.readFile(id, path, c.get('user')!.id);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.byteLength),
      },
    });
  }
);

nodesRoutes.openapi(
  { ...writeNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path, content } = await parseFileContentRequest(c);
    await service.writeFile(id, path, content, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...createNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path, content } = await parseFileContentRequest(c);
    await service.createFile(id, path, content, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...initNodeFileUploadRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path, totalBytes } = FileUploadInitSchema.parse(await c.req.json());
    const data = await service.initFileUpload(id, path, totalBytes, user.id);
    return c.json({ data });
  }
);

nodesRoutes.openapi(
  { ...uploadNodeFileChunkRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const uploadId = c.req.param('uploadId')!;
    const { offset } = FileUploadChunkQuerySchema.parse(c.req.query());
    const content = Buffer.from(await c.req.arrayBuffer());
    const data = await service.appendFileUploadChunk(id, uploadId, offset, content);
    return c.json({ data });
  }
);

nodesRoutes.openapi(
  { ...completeNodeFileUploadRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const uploadId = c.req.param('uploadId')!;
    const { path, totalBytes } = FileUploadCompleteSchema.parse(await c.req.json());
    await service.completeFileUpload(id, uploadId, path, totalBytes);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...abortNodeFileUploadRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const uploadId = c.req.param('uploadId')!;
    const { aborted } = await service.abortFileUpload(id, uploadId);
    return c.json({ success: true, aborted });
  }
);

nodesRoutes.openapi(
  { ...createNodeDirectoryRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path } = FileBrowseSchema.parse(await c.req.json());
    await service.createDirectory(id, path, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...deleteNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { path } = FileBrowseSchema.parse(c.req.query());
    await service.deleteFile(id, path, user.id);
    return c.json({ success: true });
  }
);

nodesRoutes.openapi(
  { ...moveNodeFileRoute, middleware: requireScopeForResource('nodes:files:write', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const id = c.req.param('id')!;
    const user = c.get('user')!;
    const { fromPath, toPath } = FileMoveSchema.parse(await c.req.json());
    await service.moveFile(id, fromPath, toPath, user.id);
    return c.json({ success: true });
  }
);

/**
 * The command for a public target nobody configured yet uses the host the browser reached Opfield on (a managed
 * installation: its console domain).
 */
async function requestFallbackOpfield(c: Context<AppEnv>): Promise<string | null> {
  return (
    (await managedConsoleHostOpfield()) ?? browserHostOpfield(c.req.header('x-forwarded-host') ?? c.req.header('host'))
  );
}

nodesRoutes.openapi(createNodeRoute, async (c) => {
  // The response carries an enrollment token that outlives the impersonation session.
  assertNotImpersonating(c, 'Nodes cannot be created while impersonating');
  const input = CreateNodeSchema.parse(await c.req.json());
  const result = await createNodeForActor({ id: c.get('user')!.id, scopes: c.get('effectiveScopes') ?? [] }, input);
  const installation = await enrollmentInstallation(result, await requestFallbackOpfield(c));
  return c.json({ data: { ...result, ...installation } }, 201);
});

nodesRoutes.openapi(regenerateNodeEnrollmentTokenRoute, async (c) => {
  assertNotImpersonating(c, 'Enrollment tokens cannot be regenerated while impersonating');
  const result = await regenerateNodeEnrollmentTokenForActor(
    { id: c.get('user')!.id, scopes: c.get('effectiveScopes') ?? [] },
    c.req.param('id')!
  );
  const installation = await enrollmentInstallation(result, await requestFallbackOpfield(c));
  return c.json({ data: { ...result, ...installation } }, 200);
});

nodesRoutes.openapi(updateNodeRoute, async (c) => {
  const input = UpdateNodeSchema.parse(await c.req.json());
  const node = await updateNodeForActor(
    { id: c.get('user')!.id, scopes: c.get('effectiveScopes') || [] },
    c.req.param('id')!,
    input
  );
  return c.json({ data: node });
});

nodesRoutes.openapi(
  { ...updateNodeServiceCreationLockRoute, middleware: requireScopeForResource('nodes:lock', 'id') },
  async (c) => {
    const service = container.resolve(NodesService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const input = UpdateNodeServiceCreationLockSchema.parse(await c.req.json());
    const node = await service.updateServiceCreationLock(id, input, user.id);
    return c.json({ data: node });
  }
);

nodesRoutes.openapi({ ...deleteNodeRoute, middleware: requireScopeForResource('nodes:delete', 'id') }, async (c) => {
  const service = container.resolve(NodesService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  await service.remove(id, user.id, { cascadeOfflineProxyHosts: c.req.query('cascadeProxyHosts') === 'true' });
  return c.json({ success: true });
});

// Helper: check node type is nginx before nginx-specific operations
async function requireNginxNode(c: any): Promise<boolean> {
  const service = container.resolve(NodesService);
  const id = c.req.param('id')!;
  try {
    const node = await service.get(id);
    if (node.type !== 'nginx') {
      c.json({ code: 'NOT_NGINX', message: 'This operation is only available for nginx nodes' }, 400);
      return false;
    }
    return true;
  } catch {
    return true; // let the downstream handler produce the 404
  }
}

nodesRoutes.openapi(getNodeConfigRoute, async (c) => {
  const requiredScope = `nodes:config:view:${c.req.param('id')!}`;
  if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
    return c.json({ message: `Missing required scope: ${requiredScope}` }, 403);
  }
  if (!(await requireNginxNode(c))) return c.body(null);
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const dispatch = container.resolve(NodeDispatchService);
  const nodeId = c.req.param('id')!;
  const result = await dispatch.readGlobalConfig(nodeId);
  if (!result.success) {
    return c.json({ code: 'DISPATCH_ERROR', message: result.error || 'Failed to read config' }, 502);
  }
  return c.json({ data: { content: result.detail } });
});

nodesRoutes.openapi(updateNodeConfigRoute, async (c) => {
  const requiredScope = `nodes:manage:${c.req.param('id')!}`;
  if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
    return c.json({ message: `Missing required scope: ${requiredScope}` }, 403);
  }
  if (!(await requireNginxNode(c))) return c.body(null);
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const dispatch = container.resolve(NodeDispatchService);
  const nodeId = c.req.param('id')!;
  const body = await c.req.json<{ content: string }>();
  if (!body.content || typeof body.content !== 'string') {
    return c.json({ code: 'INVALID_BODY', message: 'content is required' }, 400);
  }
  if (body.content.length > 1_048_576) {
    return c.json({ data: { valid: false, error: 'Config exceeds 1MB limit' } }, 422);
  }
  const result = await dispatch.updateGlobalConfig(nodeId, body.content, '');
  if (!result.success) {
    return c.json({ data: { valid: false, error: result.error } }, 422);
  }
  return c.json({ data: { valid: true } });
});

// Test node's nginx config on the target node daemon.
// Do not run a backend-local nginx -t first, because node configs can contain
// valid host-specific includes/paths that do not exist inside the Opfield container.
nodesRoutes.openapi(testNodeConfigRoute, async (c) => {
  const requiredScope = `nodes:manage:${c.req.param('id')!}`;
  if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
    return c.json({ message: `Missing required scope: ${requiredScope}` }, 403);
  }
  if (!(await requireNginxNode(c))) return c.body(null);
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const dispatch = container.resolve(NodeDispatchService);
  const nodeId = c.req.param('id')!;
  await c.req.json<{ content?: string }>().catch(() => ({}) as { content?: string });

  // Remote test via daemon (tests the deployed config in the node environment)
  const result = await dispatch.testConfig(nodeId);
  return c.json({ data: { valid: result.success, error: result.error || undefined } });
});

// Node monitoring SSE stream — 5s for generic consumers, 2s for a focused Monitoring tab
nodesRoutes.openapi(
  { ...nodeMonitoringStreamRoute, middleware: requireScopeForResource('nodes:details', 'id') },
  async (c) => {
    const nodeId = c.req.param('id')!;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) {
      return c.json({ code: 'INVALID_ID', message: 'Invalid node ID' }, 400);
    }

    const monitoringService = container.resolve(NodeMonitoringService);
    const focused = c.req.query('focused') === 'true';

    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      monitoringService.registerClient(nodeId, { focused });

      const history = await monitoringService.getHistory(nodeId);
      await stream.writeSSE({
        data: JSON.stringify({ connected: true, nodeId, history: history.map(compactMonitoringHistorySnapshot) }),
        event: 'connected',
      });
      await stream.sleep(0);

      let _running = true;

      const onSnapshot = (data: { nodeId: string; snapshot: any }) => {
        if (data.nodeId === nodeId) {
          stream.writeSSE({ data: JSON.stringify(data.snapshot), event: 'snapshot' }).catch(() => {});
        }
      };
      monitoringService.on('snapshot', onSnapshot);

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
      }, 30_000);

      stream.onAbort(() => {
        _running = false;
        clearInterval(keepalive);
        monitoringService.off('snapshot', onSnapshot);
        monitoringService.unregisterClient(nodeId, { focused });
      });

      await new Promise(() => {});
    });
  }
);

// Daemon logs SSE stream for a specific node
// Query params: ?level=info,warn,error  &search=keyword
nodesRoutes.openapi({ ...nodeDaemonLogsRoute, middleware: requireScopeForResource('nodes:logs', 'id') }, async (c) => {
  const nodeId = c.req.param('id')!;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) {
    return c.json({ code: 'INVALID_ID', message: 'Invalid node ID' }, 400);
  }

  const matchesFilter = daemonLogMatcher({
    levels: splitLogFilterList(c.req.query('level'), (level) => level.toLowerCase()),
    search: c.req.query('search') ?? '',
  });

  return streamSSE(c, async (stream) => {
    // Send buffered history (filtered)
    const history = getDaemonLogHistory(nodeId).filter(matchesFilter).slice(-300);
    await stream.writeSSE({
      data: JSON.stringify({ connected: true, nodeId, historyCount: history.length }),
      event: 'connected',
    });
    for (const entry of history) {
      await stream.writeSSE({ data: JSON.stringify(entry), event: 'log' });
    }
    await stream.sleep(0);

    const onLog = (entry: RelayedDaemonLogEntry) => {
      if (entry.nodeId === nodeId && matchesFilter(entry)) {
        stream.writeSSE({ data: JSON.stringify(entry), event: 'log' }).catch(() => {});
      }
    };
    daemonLogRelay.on('log', onLog);

    const keepalive = setInterval(() => {
      stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(keepalive);
      daemonLogRelay.off('log', onLog);
    });

    await new Promise(() => {});
  });
});

// Nginx access logs SSE stream for all hosts on a node
// Query params: ?search=keyword&status=2xx,4xx,5xx
nodesRoutes.openapi({ ...nodeNginxLogsRoute, middleware: requireScopeForResource('nodes:logs', 'id') }, async (c) => {
  if (!(await requireNginxNode(c))) return c.body(null);
  const nodeId = c.req.param('id')!;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)) {
    return c.json({ code: 'INVALID_ID', message: 'Invalid node ID' }, 400);
  }

  // Get all host IDs assigned to this node
  const { eq } = await import('drizzle-orm');
  const { proxyHosts } = await import('@/db/schema/index.js');
  const { TOKENS } = await import('@/container.js');
  const db = container.resolve(TOKENS.DrizzleClient) as any;
  const hosts = await db.select({ id: proxyHosts.id }).from(proxyHosts).where(eq(proxyHosts.nodeId, nodeId));
  const visibleHostIds = new Set<string>(hosts.map((h: any) => h.id as string));

  const matchesFilter = nginxLogMatcher({
    hostIds: visibleHostIds,
    search: c.req.query('search') ?? '',
    statuses: splitLogFilterList(c.req.query('status'), (status) => status),
  });

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({ connected: true, nodeId, hostCount: visibleHostIds.size }),
      event: 'connected',
    });

    if (visibleHostIds.size === 0) {
      await stream.writeSSE({
        data: JSON.stringify({ message: 'No routes are assigned to this nginx node' }),
        event: 'log-error',
      });
    }

    const nodeRegistry = container.resolve(NodeRegistryService);
    const sentKeys = new Set<string>();
    const writeLog = async (entry: RelayedLogEntry) => {
      if (entry.nodeId !== nodeId) return;
      if (!matchesFilter(entry)) return;
      const key = nginxLogEntryKey(entry);
      if (sentKeys.has(key)) return;
      sentKeys.add(key);
      await stream.writeSSE({ data: JSON.stringify(entry), event: 'log' });
    };

    const onLog = (entry: RelayedLogEntry) => {
      writeLog(entry).catch(() => {});
    };
    logRelay.on('log', onLog);

    for (const hostId of visibleHostIds) {
      for (const entry of getNginxLogHistory(hostId)) {
        await writeLog(entry);
      }
    }

    const subscriptions = Array.from(visibleHostIds, (hostId) =>
      subscribeNginxHostLogs(nodeRegistry, nodeId, hostId, 200)
    );
    const subscriptionErrors = subscriptions.filter((subscription) => !subscription.ok);
    if (visibleHostIds.size > 0 && subscriptionErrors.length === subscriptions.length) {
      await stream.writeSSE({
        data: JSON.stringify({ message: subscriptionErrors[0]?.message ?? 'Nginx log stream is not connected' }),
        event: 'log-error',
      });
    }

    const keepalive = setInterval(() => {
      stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(keepalive);
      logRelay.off('log', onLog);
      for (const subscription of subscriptions) {
        if (subscription.ok) subscription.cleanup();
      }
    });

    await new Promise(() => {});
  });
});
