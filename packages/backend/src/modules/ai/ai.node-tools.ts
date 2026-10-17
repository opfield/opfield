import { eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
} from '@/modules/docker/docker.schemas.js';
import {
  getDaemonLogHistory,
  getNginxLogHistory,
  logRelay,
  type RelayedLogEntry,
} from '@/modules/monitoring/log-relay.service.js';
import { subscribeNginxHostLogs } from '@/modules/monitoring/nginx-log-subscriptions.js';
import {
  createNodeForActor,
  regenerateNodeEnrollmentTokenForActor,
  updateNodeForActor,
} from '@/modules/nodes/node-actions.js';
import { enrollmentInstallation, publicUrlFallbackOpfield } from '@/modules/nodes/node-installer.js';
import {
  daemonLogMatcher,
  NODE_LOG_HISTORY_LIMIT,
  nginxLogEntryKey,
  nginxLogMatcher,
} from '@/modules/nodes/node-log-filters.js';
import { NodeMonitoringService } from '@/modules/nodes/node-monitoring.service.js';
import {
  CreateNodeSchema,
  UpdateNodeSchema,
  UpdateNodeServiceCreationLockSchema,
} from '@/modules/nodes/nodes.schemas.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { User } from '@/types.js';
import { executeNodeConsoleCommand } from './ai.node-console-tool.js';
import { resolveNodeListAccess } from './ai.node-list-scopes.js';
import { NODE_LIST_ROLE_NOTE, nodeRole } from './ai.node-roles.js';
import { agentPage, agentPageLimit } from './ai.service-helpers.js';

export const NODE_TOOL_NAMES = new Set([
  'list_nodes',
  'get_node',
  'execute_node_console_command',
  'create_node',
  'rename_node',
  'set_node_service_creation_lock',
  'delete_node',
  'manage_node_config',
  'manage_node_file',
  'manage_node',
]);

const NODE_FILE_LIST_MAX = 1000;
const NODE_FILE_READ_LIMIT_BYTES = 256 * 1024;
const NGINX_LOG_TAIL_LINES = 200;
const NGINX_LOG_SNAPSHOT_WAIT_MS = 1500;
const NODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NodeToolContext {
  nodesService: NodesService;
  getDispatchService?: () => NodeDispatchService;
  /** Who calls: remote MCP (OAuth grants and API tokens) or the in-app assistant. */
  source?: 'ai' | 'mcp';
}

type ListedNode = Awaited<ReturnType<NodesService['list']>>['data'][number];

/**
 * A Docker node whose engine cannot start containers (containerd or dockerd down) still shows status online: list_nodes
 * names the problem so an agent sees it without opening every node.
 */
function dockerEngineProblem(node: ListedNode): { dockerEngineProblem?: string } {
  const engine = (node as { lastHealthReport?: { dockerEngine?: { available?: boolean; problem?: string } } | null })
    .lastHealthReport?.dockerEngine;
  if (!engine || engine.available !== false) return {};
  return { dockerEngineProblem: engine.problem || 'the Docker Engine cannot start containers' };
}

function presentListedNode(node: ListedNode, compact: boolean) {
  return compact
    ? {
        id: node.id,
        type: node.type,
        usedFor: nodeRole(node.type),
        hostname: node.hostname,
        displayName: node.displayName,
        appearanceColor: node.appearanceColor,
        status: node.status,
        isConnected: node.isConnected,
        serviceCreationLocked: node.serviceCreationLocked,
        daemonVersion: node.daemonVersion,
        lastSeenAt: node.lastSeenAt,
        ...dockerEngineProblem(node),
      }
    : {
        id: node.id,
        type: node.type,
        usedFor: nodeRole(node.type),
        hostname: node.hostname,
        displayName: node.displayName,
        appearanceColor: node.appearanceColor,
        status: node.status,
        isConnected: node.isConnected,
        serviceCreationLocked: node.serviceCreationLocked,
        daemonVersion: node.daemonVersion,
        osInfo: node.osInfo,
        configVersionHash: node.configVersionHash,
        capabilities: node.capabilities,
        lastSeenAt: node.lastSeenAt,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        ...dockerEngineProblem(node),
      };
}

/** Node types a Docker, folder or create grant can target when list_nodes is called without a type. */
const DESTINATION_NODE_TYPES = ['docker', 'nginx', 'databases', 'storage'] as const;

async function listNodesOfGrantedTypes(context: NodeToolContext, user: User, a: Record<string, any>) {
  const lists = await Promise.all(
    DESTINATION_NODE_TYPES.map(async (type) => {
      const access = resolveNodeListAccess(user.scopes, type);
      if (!access.allowed) return null;
      const result = await context.nodesService.list(
        { search: a.search, type, status: a.status, page: 1, limit: agentPageLimit(a.limit) },
        access.allowedIds ? { allowedIds: access.allowedIds } : undefined
      );
      return { type, nodes: result.data.map((node) => presentListedNode(node, access.compact)) };
    })
  );
  return lists.filter((list): list is NonNullable<typeof list> => list !== null);
}

export async function executeNodeTool(
  context: NodeToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'list_nodes': {
      // Same inventory rule as GET /api/nodes: creators and Docker grants discover their destination nodes.
      const access = resolveNodeListAccess(user.scopes, a.type);
      if (!access.allowed) {
        // Without a type, Docker, folder and create grants still list the nodes of the types they target.
        const byType = a.type ? [] : await listNodesOfGrantedTypes(context, user, a);
        if (byType.length > 0) {
          const data = [...new Map(byType.flatMap(({ nodes }) => nodes).map((node) => [node.id, node])).values()];
          return {
            data,
            total: data.length,
            types: byType.map(({ type }) => type),
            note: `Your node access comes from Docker, folder or create grants, so nodes are listed for the types they target (${byType.map(({ type }) => type).join(', ')}). Pass type to narrow the list. ${NODE_LIST_ROLE_NOTE}`,
          };
        }
        throw new Error(
          `PERMISSION_DENIED: Missing permission for the requested node inventory (one of ${access.requiredScopes.join(', ')}).${
            a.type
              ? ''
              : ' Pass type (nginx, docker, databases or storage) to list the nodes your create or Docker scopes can target.'
          }`
        );
      }
      const result = await context.nodesService.list(
        {
          search: a.search,
          type: a.type,
          status: a.status,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        },
        access.allowedIds ? { allowedIds: access.allowedIds } : undefined
      );
      return {
        ...result,
        data: result.data.map((node) => presentListedNode(node, access.compact)),
        note: NODE_LIST_ROLE_NOTE,
      };
    }
    case 'get_node': {
      const node = await context.nodesService.get(a.nodeId);
      return node && typeof node === 'object' ? { ...node, usedFor: nodeRole((node as { type?: string }).type) } : node;
    }
    case 'execute_node_console_command':
      return executeNodeConsoleCommand(
        { getDispatch: () => getRequiredDispatchService(context), source: context.source },
        user,
        a
      );
    case 'create_node': {
      // Mirrors POST /nodes: schema, destination folder permission, then the enrollment token.
      const input = CreateNodeSchema.parse(
        definedFields({
          type: a.type,
          hostname: a.hostname,
          displayName: a.displayName,
          folderId: a.folderId,
          serviceAddresses: a.serviceAddresses,
          servicePort: a.servicePort,
        })
      );
      const created = await createNodeForActor({ id: user.id, scopes: user.scopes }, input, context.nodesService);
      return { ...created, ...(await enrollmentInstallation(created, await publicUrlFallbackOpfield())) };
    }
    case 'rename_node':
      return context.nodesService.update(a.nodeId, { displayName: a.displayName }, user.id);
    case 'set_node_service_creation_lock': {
      // Mirrors PATCH /nodes/{id}/service-creation-lock.
      if (!hasScopeForResource(user.scopes, 'nodes:lock', String(a.nodeId ?? ''))) {
        throw new Error(`PERMISSION_DENIED: Missing required scope nodes:lock:${String(a.nodeId ?? '')}`);
      }
      const input = UpdateNodeServiceCreationLockSchema.parse({ serviceCreationLocked: a.serviceCreationLocked });
      return context.nodesService.updateServiceCreationLock(a.nodeId, input, user.id);
    }
    case 'delete_node':
      await context.nodesService.remove(a.nodeId, user.id, { cascadeOfflineProxyHosts: a.cascadeProxyHosts === true });
      return { success: true };
    case 'manage_node_config':
      return executeNodeConfigTool(context, user, a);
    case 'manage_node_file':
      return executeNodeFileTool(context.nodesService, user, a);
    case 'manage_node':
      return executeManageNodeTool(context, user, a);
    default:
      throw new Error(`Unsupported node tool: ${toolName}`);
  }
}

async function executeNodeConfigTool(context: NodeToolContext, user: User, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId || '');
  const operation = String(args.operation || '');
  if (!nodeId) throw new Error('nodeId is required');
  if (!operation) throw new Error('operation is required');

  const dispatchService = getRequiredDispatchService(context);

  switch (operation) {
    case 'read': {
      assertNodeConfigScope(user, 'nodes:config:view', nodeId);
      await assertNginxNode(context.nodesService, nodeId);
      const result = await dispatchService.readGlobalConfig(nodeId);
      if (!result.success) throw new Error(result.error || 'Failed to read node config');
      return { nodeId, content: result.detail ?? '' };
    }
    case 'update': {
      assertNodeConfigScope(user, 'nodes:manage', nodeId);
      await assertNginxNode(context.nodesService, nodeId);
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) throw new Error('content is required');
      if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
        throw new Error('Config content is too large. Maximum size is 1 MB.');
      }
      const result = await dispatchService.updateGlobalConfig(nodeId, content, '');
      return { nodeId, valid: result.success, error: result.success ? null : result.error };
    }
    case 'test': {
      assertNodeConfigScope(user, 'nodes:manage', nodeId);
      await assertNginxNode(context.nodesService, nodeId);
      const result = await dispatchService.testConfig(nodeId);
      return {
        nodeId,
        valid: result.success,
        output: result.detail ?? null,
        error: result.success ? null : result.error,
      };
    }
    default:
      throw new Error(`Unsupported node config operation: ${operation}`);
  }
}

/** Mirrors requireNginxNode in nodes.routes.ts: a missing node falls through to the operation's own 404. */
async function assertNginxNode(nodesService: NodesService, nodeId: string): Promise<void> {
  let node: { type: string };
  try {
    node = await nodesService.get(nodeId);
  } catch {
    return;
  }
  if (node.type !== 'nginx') {
    throw new AppError(400, 'NOT_NGINX', 'This operation is only available for nginx nodes');
  }
}

async function executeManageNodeTool(context: NodeToolContext, user: User, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId || '');
  const operation = String(args.operation || '');
  if (!nodeId) throw new Error('nodeId is required');

  switch (operation) {
    case 'update': {
      // PATCH /nodes/{id}: every field carries its own node permission, checked in updateNodeForActor.
      const input = UpdateNodeSchema.parse(
        definedFields({
          displayName: args.displayName,
          appearanceColor: args.appearanceColor,
          serviceAddresses: args.serviceAddresses,
          serviceAddress: args.serviceAddress,
          secondaryServiceAddress: args.secondaryServiceAddress,
          confirmDomainDnsUpdate: args.confirmDomainDnsUpdate,
          builderSettings: args.builderSettings,
        })
      );
      return updateNodeForActor({ id: user.id, scopes: user.scopes }, nodeId, input, context.nodesService);
    }
    case 'regenerate_enrollment_token': {
      // Same check as POST /nodes/:id/enrollment-token: nodes:create where the node sits (folder grants included).
      const issued = await regenerateNodeEnrollmentTokenForActor(
        { id: user.id, scopes: user.scopes },
        nodeId,
        context.nodesService
      );
      return { ...issued, ...(await enrollmentInstallation(issued, await publicUrlFallbackOpfield())) };
    }
    case 'health_history':
      assertNodeScope(user, 'nodes:details', nodeId);
      return { nodeId, healthHistory: await context.nodesService.getHealthHistory(nodeId) };
    case 'monitoring_history':
      assertNodeScope(user, 'nodes:details', nodeId);
      return { nodeId, monitoringHistory: await container.resolve(NodeMonitoringService).getHistory(nodeId) };
    case 'daemon_logs': {
      assertNodeScope(user, 'nodes:logs', nodeId);
      assertNodeIdFormat(nodeId);
      const matches = daemonLogMatcher({
        levels: stringArrayArg(args.levels).map((level) => level.toLowerCase()),
        search: typeof args.search === 'string' ? args.search : '',
      });
      const entries = getDaemonLogHistory(nodeId).filter(matches).slice(-logLimitArg(args.limit));
      return { nodeId, entries, count: entries.length };
    }
    case 'nginx_logs':
      assertNodeScope(user, 'nodes:logs', nodeId);
      await assertNginxNode(context.nodesService, nodeId);
      assertNodeIdFormat(nodeId);
      return readNginxLogSnapshot(nodeId, args);
    default:
      throw new Error(`Unsupported node operation: ${operation}`);
  }
}

/**
 * Snapshot of GET /nodes/{id}/nginx-logs: buffered lines for the node's routes, plus the
 * tail the daemon sends right after a subscription, collected briefly and then released.
 */
async function readNginxLogSnapshot(nodeId: string, args: Record<string, unknown>) {
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const hosts = await db.select({ id: proxyHosts.id }).from(proxyHosts).where(eq(proxyHosts.nodeId, nodeId));
  const hostIds = new Set<string>(hosts.map((host) => host.id));
  const matches = nginxLogMatcher({
    hostIds,
    search: typeof args.search === 'string' ? args.search : '',
    statuses: stringArrayArg(args.statuses),
  });
  const entries = new Map<string, RelayedLogEntry>();
  const collect = (entry: RelayedLogEntry) => {
    if (entry.nodeId !== nodeId || !matches(entry)) return;
    entries.set(nginxLogEntryKey(entry), entry);
  };
  for (const hostId of hostIds) {
    for (const entry of getNginxLogHistory(hostId)) collect(entry);
  }

  let streamError: string | null = hostIds.size === 0 ? 'No routes are assigned to this nginx node' : null;
  if (hostIds.size > 0) {
    const registry = container.resolve(NodeRegistryService);
    logRelay.on('log', collect);
    const subscriptions = Array.from(hostIds, (hostId) =>
      subscribeNginxHostLogs(registry, nodeId, hostId, NGINX_LOG_TAIL_LINES)
    );
    try {
      const failed = subscriptions.filter((subscription) => !subscription.ok);
      if (failed.length === subscriptions.length) {
        const first = failed[0];
        streamError = first && !first.ok ? first.message : 'Nginx log stream is not connected';
      } else {
        await new Promise((resolve) => setTimeout(resolve, NGINX_LOG_SNAPSHOT_WAIT_MS));
      }
    } finally {
      logRelay.off('log', collect);
      for (const subscription of subscriptions) {
        if (subscription.ok) subscription.cleanup();
      }
    }
  }

  const sorted = [...entries.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const limited = sorted.slice(-logLimitArg(args.limit));
  return { nodeId, hostCount: hostIds.size, entries: limited, count: limited.length, streamError };
}

/** Drop omitted arguments so the parsed body matches what the HTTP route receives. */
function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function logLimitArg(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return requested > 0 ? Math.min(requested, NODE_LOG_HISTORY_LIMIT) : NODE_LOG_HISTORY_LIMIT;
}

function stringArrayArg(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [];
}

function assertNodeIdFormat(nodeId: string): void {
  if (!NODE_ID_PATTERN.test(nodeId)) throw new AppError(400, 'INVALID_ID', 'Invalid node ID');
}

/** Mirrors requireScopeForResource(<scope>, 'id') on the node routes. */
function assertNodeScope(user: User, scope: string, nodeId: string): void {
  if (!hasScope(user.scopes, `${scope}:${nodeId}`)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}:${nodeId}`);
  }
}

function getRequiredDispatchService(context: NodeToolContext): NodeDispatchService {
  if (!context.getDispatchService) {
    throw new Error('Node dispatch service is not available');
  }
  return context.getDispatchService();
}

async function executeNodeFileTool(nodesService: NodesService, user: User, args: Record<string, unknown>) {
  const nodeId = String(args.nodeId || '');
  const operation = String(args.operation || '');
  if (!nodeId) throw new Error('nodeId is required');
  if (!operation) throw new Error('operation is required');

  switch (operation) {
    case 'list': {
      assertNodeFileScope(user, 'nodes:files:read', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      const data = await nodesService.listFiles(nodeId, path, user.id);
      const files = Array.isArray(data) ? data : [];
      const truncated = files.length > NODE_FILE_LIST_MAX;
      return {
        data: truncated ? files.slice(0, NODE_FILE_LIST_MAX) : files,
        total: files.length,
        limit: NODE_FILE_LIST_MAX,
        truncated,
      };
    }
    case 'read': {
      assertNodeFileScope(user, 'nodes:files:read', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      const data = await nodesService.readFile(nodeId, path, user.id);
      return compactNodeFileRead(data, args.encoding, args.limitBytes);
    }
    case 'write': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.writeFile(nodeId, path, decodeNodeFileContent(args), user.id);
      return { success: true };
    }
    case 'create': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.createFile(nodeId, path, decodeOptionalNodeFileContent(args), user.id);
      return { success: true };
    }
    case 'mkdir': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.createDirectory(nodeId, path, user.id);
      return { success: true };
    }
    case 'delete': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path } = FileBrowseSchema.parse({ path: args.path });
      await nodesService.deleteFile(nodeId, path, user.id);
      return { success: true };
    }
    case 'move': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { fromPath, toPath } = FileMoveSchema.parse({ fromPath: args.fromPath, toPath: args.toPath });
      await nodesService.moveFile(nodeId, fromPath, toPath, user.id);
      return { success: true };
    }
    case 'upload_init': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const { path, totalBytes } = FileUploadInitSchema.parse({ path: args.path, totalBytes: args.totalBytes });
      return nodesService.initFileUpload(nodeId, path, totalBytes, user.id);
    }
    case 'upload_chunk': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const uploadId = String(args.uploadId || '');
      if (!uploadId) throw new Error('uploadId is required');
      const { offset } = FileUploadChunkQuerySchema.parse({ offset: args.offset });
      const data = await nodesService.appendFileUploadChunk(nodeId, uploadId, offset, decodeNodeFileBuffer(args));
      return { data };
    }
    case 'upload_complete': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const uploadId = String(args.uploadId || '');
      if (!uploadId) throw new Error('uploadId is required');
      const { path, totalBytes } = FileUploadCompleteSchema.parse({ path: args.path, totalBytes: args.totalBytes });
      await nodesService.completeFileUpload(nodeId, uploadId, path, totalBytes);
      return { success: true };
    }
    case 'upload_abort': {
      assertNodeFileScope(user, 'nodes:files:write', nodeId);
      const uploadId = String(args.uploadId || '');
      if (!uploadId) throw new Error('uploadId is required');
      const { aborted } = await nodesService.abortFileUpload(nodeId, uploadId);
      return aborted
        ? { success: true, aborted: true }
        : {
            success: true,
            aborted: false,
            message:
              'No upload session with this id (it finished, expired, or Opfield restarted since it began); a partial file it left on the node is removed within minutes.',
          };
    }
    default:
      throw new Error(`Unsupported node file operation: ${operation}`);
  }
}

function assertNodeConfigScope(user: User, scope: 'nodes:config:view' | 'nodes:manage', nodeId: string) {
  if (!hasScopeForResource(user.scopes, scope, nodeId)) {
    throw new Error(`Missing required scope: ${scope}:${nodeId}`);
  }
}

function assertNodeFileScope(user: User, scope: 'nodes:files:read' | 'nodes:files:write', nodeId: string) {
  if (!hasScopeForResource(user.scopes, scope, nodeId)) {
    throw new Error(`Missing required scope: ${scope}:${nodeId}`);
  }
}

function decodeOptionalNodeFileContent(args: Record<string, unknown>): string | Buffer | undefined {
  if (typeof args.contentBase64 === 'string') return Buffer.from(args.contentBase64, 'base64');
  if (typeof args.content === 'string') return args.content;
  return undefined;
}

function decodeNodeFileContent(args: Record<string, unknown>): string | Buffer {
  const content = decodeOptionalNodeFileContent(args);
  if (content === undefined) throw new Error('content or contentBase64 is required');
  return content;
}

function decodeNodeFileBuffer(args: Record<string, unknown>): Buffer {
  const content = decodeNodeFileContent(args);
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
}

function compactNodeFileRead(data: Buffer | Uint8Array, encoding: unknown, limitBytes: unknown) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const requestedLimit = typeof limitBytes === 'number' && Number.isFinite(limitBytes) ? Math.floor(limitBytes) : 0;
  const limit = requestedLimit > 0 ? Math.min(requestedLimit, NODE_FILE_READ_LIMIT_BYTES) : NODE_FILE_READ_LIMIT_BYTES;
  const slice = buffer.subarray(0, limit);
  const forcedEncoding = encoding === 'utf8' || encoding === 'base64' ? encoding : 'auto';
  const outputEncoding = forcedEncoding === 'auto' ? detectNodeFileEncoding(slice) : forcedEncoding;

  return {
    encoding: outputEncoding,
    content: outputEncoding === 'base64' ? slice.toString('base64') : slice.toString('utf8'),
    sizeBytes: buffer.byteLength,
    returnedBytes: slice.byteLength,
    truncated: buffer.byteLength > slice.byteLength,
  };
}

function detectNodeFileEncoding(buffer: Buffer): 'utf8' | 'base64' {
  if (buffer.includes(0)) return 'base64';
  const text = buffer.toString('utf8');
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
  return replacementCount > Math.max(2, text.length * 0.02) ? 'base64' : 'utf8';
}
