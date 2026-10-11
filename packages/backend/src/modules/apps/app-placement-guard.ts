import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { appEnvironmentNodes, appEnvironments, nodes, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { APP_FAMILY_TABLES, type AppFamily } from './app-families.js';

/** Node types each family places workloads on. */
export const APP_FAMILY_NODE_TYPES: Readonly<Record<AppFamily, readonly string[]>> = {
  containers: ['docker'],
  compose: ['docker'],
  routes: ['nginx'],
  pages: ['nginx'],
  databases: ['databases', 'storage'],
  storage: ['storage', 'databases'],
};

const NODE_TYPE_LABELS: Readonly<Record<string, string>> = {
  docker: 'Docker',
  nginx: 'Nginx',
  databases: 'database',
  storage: 'storage',
};

export interface AppEnvironmentPlacement {
  appId: string;
  environmentId: string;
  environmentName: string;
  /** Allowed nodes of the needed types. */
  allowedNodeIds: string[];
}

/**
 * The environment a destination folder belongs to and the nodes it allows for the needed node types; null for a
 * user folder or no folder (outside apps nothing is restricted). An app root folder is never a destination.
 */
export async function appPlacementForFolder(
  db: DrizzleExecutor,
  family: AppFamily,
  folderId: string | null | undefined,
  nodeTypes: readonly string[] = APP_FAMILY_NODE_TYPES[family]
): Promise<AppEnvironmentPlacement | null> {
  if (!folderId) return null;
  const { table, dockerResourceType } = APP_FAMILY_TABLES[family];
  const [folder] = (await (db as any)
    .select({ appId: table.appId, environmentId: table.appEnvironmentId })
    .from(table)
    .where(
      and(
        eq(table.id, folderId),
        isNotNull(table.appId),
        dockerResourceType ? eq(table.resourceType, dockerResourceType) : undefined
      )
    )
    .limit(1)) as Array<{ appId: string; environmentId: string | null }>;
  if (!folder) return null;
  if (!folder.environmentId) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  return appPlacementForEnvironment(db, folder.environmentId, nodeTypes);
}

export async function appPlacementForEnvironment(
  db: DrizzleExecutor,
  environmentId: string,
  nodeTypes: readonly string[]
): Promise<AppEnvironmentPlacement> {
  const [env] = await db
    .select({ id: appEnvironments.id, appId: appEnvironments.appId, name: appEnvironments.name })
    .from(appEnvironments)
    .where(eq(appEnvironments.id, environmentId))
    .limit(1);
  if (!env) throw new AppError(404, 'APP_ENVIRONMENT_NOT_FOUND', 'Environment not found');
  const rows = await db
    .select({ nodeId: appEnvironmentNodes.nodeId })
    .from(appEnvironmentNodes)
    .innerJoin(nodes, eq(nodes.id, appEnvironmentNodes.nodeId))
    .where(and(eq(appEnvironmentNodes.environmentId, environmentId), inArray(nodes.type, [...nodeTypes] as any)));
  return {
    appId: env.appId,
    environmentId: env.id,
    environmentName: env.name,
    allowedNodeIds: rows.map((row) => row.nodeId),
  };
}

function typeLabel(nodeTypes: readonly string[]): string {
  return NODE_TYPE_LABELS[nodeTypes[0] ?? ''] ?? nodeTypes[0] ?? 'matching';
}

/** Refuse a placement on nodes the environment does not allow (no-op outside apps). */
export function assertPlacementNodesAllowed(
  placement: AppEnvironmentPlacement | null,
  nodeIds: readonly string[],
  nodeTypes: readonly string[]
): void {
  if (!placement) return;
  if (placement.allowedNodeIds.length === 0) {
    throw new AppError(
      409,
      'APP_ENV_NO_ALLOWED_NODE',
      `${placement.environmentName} has no allowed ${typeLabel(nodeTypes)} node. Allow one in the environment first`,
      { appId: placement.appId, environmentId: placement.environmentId }
    );
  }
  const refused = nodeIds.filter((nodeId) => !placement.allowedNodeIds.includes(nodeId));
  if (refused.length > 0) {
    throw new AppError(
      409,
      'APP_NODE_NOT_ALLOWED',
      `This node is not allowed in ${placement.environmentName}. Allow it in the environment first`,
      {
        appId: placement.appId,
        environmentId: placement.environmentId,
        nodeIds: refused,
        allowedNodeIds: placement.allowedNodeIds,
      }
    );
  }
}

/**
 * The guard every create and placement path calls (REST, MCP and AI share the services): a destination folder of
 * an app environment accepts only nodes that environment allows, of the node types the family runs on.
 */
export async function assertAppPlacement(
  db: DrizzleExecutor,
  family: AppFamily,
  folderId: string | null | undefined,
  nodeIds: readonly string[],
  nodeTypes: readonly string[] = APP_FAMILY_NODE_TYPES[family]
): Promise<void> {
  assertPlacementNodesAllowed(await appPlacementForFolder(db, family, folderId, nodeTypes), nodeIds, nodeTypes);
}

/** Node candidates narrowed to what an app environment folder allows (unchanged outside apps). */
export async function filterNodesForAppFolder<T>(
  db: DrizzleExecutor,
  family: AppFamily,
  folderId: string | null | undefined,
  items: readonly T[],
  nodeIdOf: (item: T) => string
): Promise<T[]> {
  const placement = await appPlacementForFolder(db, family, folderId);
  if (!placement) return [...items];
  return items.filter((item) => placement.allowedNodeIds.includes(nodeIdOf(item)));
}

/** Adding a member to an ingress group: each app environment with routes on the group must allow the node. */
export async function assertGroupRoutesAllowNode(
  db: DrizzleExecutor,
  hostIds: readonly string[],
  nodeId: string
): Promise<void> {
  if (hostIds.length === 0) return;
  const rows = await db
    .select({ folderId: proxyHosts.folderId })
    .from(proxyHosts)
    .where(and(inArray(proxyHosts.id, [...hostIds]), isNotNull(proxyHosts.folderId)));
  const folderIds = [...new Set(rows.map((row) => row.folderId).filter((id): id is string => !!id))];
  for (const folderId of folderIds) await assertAppPlacement(db, 'routes', folderId, [nodeId]);
}
