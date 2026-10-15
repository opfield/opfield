import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  databaseConnections,
  dockerAccessResources,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
  loggingEnvironments,
  objectStorageConnections,
  pageProjects,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { APP_FAMILY_TABLES } from './app-families.js';

/** Families whose per-resource grants can name an app member (Docker grants name `<nodeId>/<id>`). */
export type ResourceGrantFamily =
  | 'containers'
  | 'compose'
  | 'routes'
  | 'databases'
  | 'storage'
  | 'pages'
  | 'certificates'
  | 'logging';

/** Folder-based families: the resource table and the folder table its `folderId` points into. */
const FOLDERED: Readonly<Record<Exclude<ResourceGrantFamily, 'containers' | 'compose'>, { table: any; folders: any }>> =
  {
    routes: { table: proxyHosts, folders: APP_FAMILY_TABLES.routes.table },
    databases: { table: databaseConnections, folders: APP_FAMILY_TABLES.databases.table },
    storage: { table: objectStorageConnections, folders: APP_FAMILY_TABLES.storage.table },
    pages: { table: pageProjects, folders: APP_FAMILY_TABLES.pages.table },
    certificates: { table: sslCertificates, folders: APP_FAMILY_TABLES.certificates.table },
    logging: { table: loggingEnvironments, folders: APP_FAMILY_TABLES.logging.table },
  };

export function memberGrantKey(family: ResourceGrantFamily, target: string): string {
  return `${family}:${target}`;
}

function splitDockerTarget(target: string): { nodeId: string; id: string } {
  const separator = target.indexOf('/');
  return { nodeId: target.slice(0, separator), id: target.slice(separator + 1) };
}

/** Docker placements (`resourceType`, `<nodeId>:<resourceKey>`) that sit in an app's hidden folder. */
async function dockerPlacementsInApps(
  db: DrizzleExecutor,
  resourceType: 'container' | 'compose',
  refs: ReadonlyArray<{ nodeId: string; key: string }>
): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = (await (db as any)
    .select({ nodeId: dockerContainerFolderAssignments.nodeId, key: dockerContainerFolderAssignments.resourceKey })
    .from(dockerContainerFolderAssignments)
    .innerJoin(dockerContainerFolders, eq(dockerContainerFolders.id, dockerContainerFolderAssignments.folderId))
    .where(
      and(
        eq(dockerContainerFolderAssignments.resourceType, resourceType),
        inArray(dockerContainerFolderAssignments.nodeId, [...new Set(refs.map((ref) => ref.nodeId))]),
        inArray(dockerContainerFolderAssignments.resourceKey, [...new Set(refs.map((ref) => ref.key))]),
        isNotNull(dockerContainerFolders.appId)
      )
    )) as Array<{ nodeId: string; key: string }>;
  return new Set(rows.map((row) => `${row.nodeId}:${row.key}`));
}

/**
 * Container grants name an access resource (a container by name) or a deployment, both on a node. A grant
 * counts when the container or deployment sits in an app's hidden folder.
 */
async function containerTargetsInApps(db: DrizzleExecutor, targets: readonly string[]): Promise<string[]> {
  const parsed = targets.map((target) => ({ target, ...splitDockerTarget(target) }));
  const ids = [...new Set(parsed.map((ref) => ref.id))];
  const [accessRows, deploymentRows] = await Promise.all([
    (db as any)
      .select({
        id: dockerAccessResources.id,
        nodeId: dockerAccessResources.nodeId,
        name: dockerAccessResources.resourceKey,
      })
      .from(dockerAccessResources)
      .where(and(inArray(dockerAccessResources.id, ids), eq(dockerAccessResources.resourceType, 'container'))),
    (db as any)
      .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId, name: dockerDeployments.name })
      .from(dockerDeployments)
      .where(inArray(dockerDeployments.id, ids)),
  ]);
  const names = new Map<string, { nodeId: string; key: string }>();
  for (const row of [...accessRows, ...deploymentRows] as Array<{ id: string; nodeId: string; name: string }>) {
    names.set(`${row.nodeId}/${row.id}`, { nodeId: row.nodeId, key: row.name });
  }
  const placed = await dockerPlacementsInApps(db, 'container', [...names.values()]);
  return parsed
    .filter((ref) => {
      const named = names.get(`${ref.nodeId}/${ref.id}`);
      return !!named && placed.has(`${named.nodeId}:${named.key}`);
    })
    .map((ref) => ref.target);
}

async function composeTargetsInApps(db: DrizzleExecutor, targets: readonly string[]): Promise<string[]> {
  const parsed = targets.map((target) => ({ target, ...splitDockerTarget(target) }));
  const placed = await dockerPlacementsInApps(
    db,
    'compose',
    parsed.map((ref) => ({ nodeId: ref.nodeId, key: ref.id }))
  );
  return parsed.filter((ref) => placed.has(`${ref.nodeId}:${ref.id}`)).map((ref) => ref.target);
}

async function folderedTargetsInApps(
  db: DrizzleExecutor,
  family: keyof typeof FOLDERED,
  targets: readonly string[]
): Promise<string[]> {
  const { table, folders } = FOLDERED[family];
  const rows = (await (db as any)
    .select({ id: table.id })
    .from(table)
    .innerJoin(folders, eq(folders.id, table.folderId))
    .where(and(inArray(table.id, [...new Set(targets)]), isNotNull(folders.appId)))) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * The per-resource grant targets (by family) that name app members: resources sitting in an app's hidden folder.
 * Creating inside an app grants the creator such per-resource scopes; they are app grants like the folder grant the
 * creation went through. Unknown resources count as outside apps. One query per family named (two for containers).
 */
export async function resolveAppMemberGrantTargets(
  db: DrizzleExecutor,
  targetsByFamily: ReadonlyMap<ResourceGrantFamily, ReadonlySet<string>>
): Promise<Set<string>> {
  const members = new Set<string>();
  for (const [family, targetSet] of targetsByFamily) {
    const targets = [...targetSet];
    if (targets.length === 0) continue;
    const found =
      family === 'containers'
        ? await containerTargetsInApps(db, targets)
        : family === 'compose'
          ? await composeTargetsInApps(db, targets)
          : await folderedTargetsInApps(db, family, targets);
    for (const target of found) members.add(memberGrantKey(family, target));
  }
  return members;
}
