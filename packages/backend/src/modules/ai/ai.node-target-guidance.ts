import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { resolveNodeListAccess } from './ai.node-list-scopes.js';
import {
  DOCKER_NODE_FAMILY,
  type NodeFamily,
  type NodeRoleType,
  nodeFamilyForRefusal,
  nodeRole,
} from './ai.node-roles.js';
import { compactAgentList } from './ai.service-helpers.js';
import { describeToolError, formatToolError } from './ai-tool-errors.js';

/**
 * Agents pick nodes for node-scoped tools from list_nodes. When they pick a node of the wrong type (a storage or
 * builder node for a Docker tool, a Docker node for a route), a shortened id or a name, the refusal names the node's
 * type and the nodes of the right type the caller can see, so the next call can succeed. Docker list tools called
 * without nodeId list across every Docker node the caller can see instead of failing.
 */

export interface NodeSummary {
  id: string;
  type: string;
  hostname: string;
  displayName: string | null;
  status: string;
}

/** Node lookups the guidance needs; the database implementation is {@link databaseNodeDirectory}. */
export interface NodeDirectory {
  findNode(id: string): Promise<NodeSummary | null>;
  listNodes(types: readonly string[]): Promise<NodeSummary[]>;
}

const NODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTED_NODES_MAX = 15;

const NODE_SUMMARY_COLUMNS = {
  id: nodes.id,
  type: nodes.type,
  hostname: nodes.hostname,
  displayName: nodes.displayName,
  status: nodes.status,
};

export function databaseNodeDirectory(db: Pick<DrizzleClient, 'select'>): NodeDirectory {
  return {
    async findNode(id) {
      if (!NODE_ID_PATTERN.test(id)) return null;
      const [node] = await db.select(NODE_SUMMARY_COLUMNS).from(nodes).where(eq(nodes.id, id)).limit(1);
      return node ?? null;
    },
    async listNodes(types) {
      if (types.length === 0) return [];
      return db
        .select(NODE_SUMMARY_COLUMNS)
        .from(nodes)
        .where(inArray(nodes.type, [...types] as NodeRoleType[]))
        .orderBy(nodes.hostname);
    },
  };
}

export function nodeDirectoryFor(db: Pick<DrizzleClient, 'select'> | null | undefined): NodeDirectory | null {
  return db ? databaseNodeDirectory(db) : null;
}

/** Whether the caller may see this node in list_nodes (same rule as GET /api/nodes per node type). */
export function canSeeNode(scopes: string[], node: Pick<NodeSummary, 'id' | 'type'>): boolean {
  const access = resolveNodeListAccess(scopes, node.type as NodeRoleType);
  return access.allowed && (!access.allowedIds || access.allowedIds.includes(node.id));
}

export async function visibleNodesOfFamily(
  scopes: string[],
  family: NodeFamily,
  directory: NodeDirectory
): Promise<NodeSummary[]> {
  const candidates = await directory.listNodes(family.types);
  return candidates.filter((node) => canSeeNode(scopes, node));
}

function nodeName(node: NodeSummary): string {
  return node.displayName || node.hostname;
}

function nodeLabel(node: NodeSummary): string {
  return `${nodeName(node)} (${node.id}${node.status === 'online' ? '' : `, ${node.status}`})`;
}

function familyChoices(family: NodeFamily, choices: NodeSummary[]): string {
  if (choices.length === 0) {
    return `You can use no ${family.label} nodes: call get_my_access to see your node grants.`;
  }
  const shown = choices.slice(0, LISTED_NODES_MAX).map(nodeLabel).join('; ');
  const more =
    choices.length > LISTED_NODES_MAX ? `; ${choices.length - LISTED_NODES_MAX} more via ${family.listHint}` : '';
  return `${family.label} nodes you can use: ${shown}${more}.`;
}

/** Docker tools whose nodeId must name a Docker node (type docker). */
export const DOCKER_NODE_TOOLS = new Set([
  'create_docker_container',
  'list_docker_containers',
  'get_docker_container',
  'execute_docker_container_console_command',
  'list_docker_deployments',
  'get_docker_deployment',
  'start_docker_deployment',
  'stop_docker_deployment',
  'restart_docker_deployment',
  'kill_docker_deployment',
  'deploy_docker_deployment',
  'switch_docker_deployment_slot',
  'rollback_docker_deployment',
  'stop_docker_deployment_slot',
  'start_docker_container',
  'stop_docker_container',
  'restart_docker_container',
  'remove_docker_container',
  'update_docker_container_image',
  'rename_docker_container',
  'duplicate_docker_container',
  'get_docker_container_stats',
  'get_docker_container_logs',
  'list_docker_images',
  'pull_docker_image',
  'remove_docker_image',
  'prune_docker_images',
  'list_docker_volumes',
  'list_docker_networks',
  'manage_docker_volume',
  'manage_docker_network',
  'manage_docker_compose',
  'manage_docker_source',
  'manage_docker_container_config',
  'manage_docker_deployment',
  'kill_docker_container',
  'manage_docker_container',
  'upload_docker_container_archive',
  'download_docker_archive',
]);

/** Docker list tools that list across every visible Docker node when nodeId is omitted. */
export const DOCKER_LIST_TOOLS = new Set([
  'list_docker_containers',
  'list_docker_deployments',
  'list_docker_images',
  'list_docker_volumes',
  'list_docker_networks',
]);

export function hasNodeIdArgument(args: Record<string, unknown>): boolean {
  return typeof args.nodeId === 'string' && args.nodeId.trim() !== '';
}

/**
 * Refuse a Docker tool call whose nodeId is not a Docker node before the handler runs, so a wrong node is refused
 * the same way by every Docker tool (a list on a storage node does not come back empty) and the refusal gets the
 * guidance of {@link withNodeTargetGuidance}.
 */
export async function assertDockerToolNode(
  toolName: string,
  args: Record<string, unknown>,
  directory: NodeDirectory
): Promise<void> {
  if (!DOCKER_NODE_TOOLS.has(toolName) || !hasNodeIdArgument(args)) return;
  const nodeId = String(args.nodeId).trim();
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new AppError(
      404,
      'NODE_NOT_FOUND',
      `Node "${nodeId}" not found: nodeId takes the full node UUID (id in list_nodes), not a name or a shortened id`
    );
  }
  const node = await directory.findNode(nodeId);
  if (!node) throw new AppError(404, 'NODE_NOT_FOUND', `Node ${nodeId} not found`);
  if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Node is not a Docker node');
}

function isNodeNotFound(code: string | undefined, message: string): boolean {
  return code === 'NODE_NOT_FOUND' || (code === 'NOT_FOUND' && /\bnode\b/i.test(message));
}

export interface NodeTargetGuidanceInput {
  message: string;
  code: string | undefined;
  toolName: string;
  args: Record<string, unknown>;
  scopes: string[];
  directory: NodeDirectory;
}

/**
 * Add to a node-type refusal (NOT_DOCKER, NOT_NGINX, NODE_TYPE_MISMATCH) or a missing node on a Docker tool what the
 * named node is (when the caller can see it) and which nodes of the right type the caller can use.
 */
export async function withNodeTargetGuidance(input: NodeTargetGuidanceInput): Promise<string> {
  const { message, code, toolName, args, scopes, directory } = input;
  const notFound = isNodeNotFound(code, message);
  const family =
    nodeFamilyForRefusal(code, message) ?? (notFound && DOCKER_NODE_TOOLS.has(toolName) ? DOCKER_NODE_FAMILY : null);
  if (!family) return message;
  const nodeId = hasNodeIdArgument(args) ? String(args.nodeId).trim() : null;
  const parts: string[] = [message.replace(/[.\s]*$/, '.')];
  if (nodeId && !notFound) {
    const node = await directory.findNode(nodeId);
    if (node && canSeeNode(scopes, node)) {
      const role = nodeRole(node.type);
      parts.push(`"${nodeName(node)}" (${node.id}) is a ${node.type} node${role ? `: ${role}` : '.'}`);
    }
  }
  parts.push(familyChoices(family, await visibleNodesOfFamily(scopes, family, directory)));
  if (family === DOCKER_NODE_FAMILY && DOCKER_LIST_TOOLS.has(toolName)) {
    parts.push('Omit nodeId to list across all of them.');
  }
  return parts.join(' ');
}

interface ListedOnNode {
  data?: unknown;
}

/**
 * A Docker list without nodeId: run the per-node list on every Docker node the caller can see and merge the rows,
 * each tagged with its node. A node that cannot answer (offline, refused) is reported instead of failing the call.
 */
export async function listDockerAcrossNodes(
  scopes: string[],
  directory: NodeDirectory,
  listOnNode: (nodeId: string) => Promise<unknown>
) {
  const dockerNodes = await visibleNodesOfFamily(scopes, DOCKER_NODE_FAMILY, directory);
  const results = await Promise.all(
    dockerNodes.map(async (node) => {
      try {
        const result = (await listOnNode(node.id)) as ListedOnNode | unknown[];
        const rows = Array.isArray(result)
          ? result
          : Array.isArray((result as ListedOnNode)?.data)
            ? ((result as ListedOnNode).data as unknown[])
            : null;
        if (!rows) return { node, error: 'The node returned no list' };
        return { node, rows };
      } catch (error) {
        return { node, error: formatToolError(describeToolError(error)) };
      }
    })
  );
  const rows = results.flatMap((result) =>
    (result.rows ?? []).map((row) => ({
      nodeId: result.node.id,
      nodeName: nodeName(result.node),
      ...(row as Record<string, unknown>),
    }))
  );
  const unavailableNodes = results
    .filter((result) => result.error)
    .map((result) => ({
      nodeId: result.node.id,
      nodeName: nodeName(result.node),
      status: result.node.status,
      error: result.error,
    }));
  return {
    ...compactAgentList(rows),
    nodes: results
      .filter((result) => result.rows)
      .map((result) => ({ nodeId: result.node.id, nodeName: nodeName(result.node), count: result.rows?.length ?? 0 })),
    ...(unavailableNodes.length > 0 ? { unavailableNodes } : {}),
    note:
      dockerNodes.length === 0
        ? 'You can see no Docker nodes: call get_my_access to see your Docker grants.'
        : 'Listed across every Docker node you can see; each row carries its nodeId. Pass nodeId to list one node.',
  };
}

/**
 * Where a scope is missing, for a refusal: the node named by nodeId (its name and type only when the caller can see
 * it), or "for this target".
 */
export async function deniedNodeTargetText(
  args: Record<string, unknown>,
  scopes: string[],
  directory: NodeDirectory | null
): Promise<string> {
  if (!directory || !hasNodeIdArgument(args)) return 'for this target';
  const nodeId = String(args.nodeId).trim();
  try {
    const node = await directory.findNode(nodeId);
    return node && canSeeNode(scopes, node)
      ? `on node "${nodeName(node)}" (${node.id}, type ${node.type})`
      : `on node ${nodeId}`;
  } catch {
    return `on node ${nodeId}`;
  }
}
