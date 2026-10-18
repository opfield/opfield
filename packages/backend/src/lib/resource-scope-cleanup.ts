import { inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import {
  accessListFolders,
  accessLists,
  adminUserFolders,
  appEnvironments,
  appFolders,
  apps,
  certificateAuthorities,
  certificates,
  databaseConnectionFolders,
  databaseConnections,
  dockerAccessResources,
  dockerComposeProjects,
  dockerContainerFolders,
  dockerDeployments,
  domainFolders,
  domains,
  hostingResources,
  hostingSnapshotFolders,
  integrationConnectors,
  loggingEnvironmentFolders,
  loggingEnvironments,
  loggingSchemaFolders,
  loggingSchemas,
  nginxTemplateFolders,
  nginxTemplates,
  nodeFolders,
  nodes,
  notificationAlertRuleFolders,
  notificationAlertRules,
  notificationWebhookFolders,
  notificationWebhooks,
  objectStorageConnections,
  objectStorageFolders,
  pageProjectFolders,
  pageProjects,
  permissionGroupFolders,
  permissionGroups,
  pkiCaFolders,
  pkiCertificateFolders,
  pkiTemplateFolders,
  proxyHostFolders,
  proxyHosts,
  sslCertificateFolders,
  sslCertificates,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from './logger.js';
import {
  listPersistedQualifiedScopes,
  type PersistedScopeChanges,
  rewritePersistedScopes,
} from './persisted-scopes.js';
import { type ScopeResourceKind, scopeResourceReferences } from './resource-scope-references.js';

const logger = createChildLogger('ResourceScopeCleanup');

const kindTables = (): Record<ScopeResourceKind, readonly any[]> => ({
  app: [apps],
  appEnvironment: [appEnvironments],
  node: [nodes],
  folder: [
    nodeFolders,
    proxyHostFolders,
    domainFolders,
    sslCertificateFolders,
    pageProjectFolders,
    databaseConnectionFolders,
    objectStorageFolders,
    loggingEnvironmentFolders,
    loggingSchemaFolders,
    adminUserFolders,
    permissionGroupFolders,
    dockerContainerFolders,
    hostingSnapshotFolders,
    pkiCaFolders,
    pkiCertificateFolders,
    pkiTemplateFolders,
    nginxTemplateFolders,
    appFolders,
    notificationAlertRuleFolders,
    notificationWebhookFolders,
    accessListFolders,
  ],
  proxyHost: [proxyHosts],
  proxyTemplate: [nginxTemplates],
  domain: [domains],
  sslCertificate: [sslCertificates],
  certificateAuthority: [certificateAuthorities],
  pkiCertificate: [certificates],
  accessList: [accessLists],
  pageProject: [pageProjects],
  databaseConnection: [databaseConnections],
  objectStorageConnection: [objectStorageConnections],
  loggingEnvironment: [loggingEnvironments],
  loggingSchema: [loggingSchemas],
  notificationAlertRule: [notificationAlertRules],
  notificationWebhook: [notificationWebhooks],
  // Deleted users keep their row (they can be restored), so grants naming them stay.
  user: [users],
  group: [permissionGroups],
  hostingResource: [hostingResources],
  integrationConnector: [integrationConnectors],
  dockerAccessResource: [dockerAccessResources],
  dockerDeployment: [dockerDeployments],
  dockerComposeProject: [dockerComposeProjects],
});

/** The scopes among `scopes` that name a resource whose row no longer exists. */
export async function danglingResourceScopes(tx: DrizzleExecutor, scopes: readonly string[]): Promise<string[]> {
  const referenced = scopes.map((scope) => ({ scope, references: scopeResourceReferences(scope) }));
  const idsByKind = new Map<ScopeResourceKind, Set<string>>();
  for (const { references } of referenced) {
    for (const { kinds, id } of references) {
      for (const kind of kinds) idsByKind.set(kind, (idsByKind.get(kind) ?? new Set()).add(id));
    }
  }
  const existing = new Map<ScopeResourceKind, Set<string>>();
  const tables = kindTables();
  for (const [kind, ids] of idsByKind) {
    const found = new Set<string>();
    for (const table of tables[kind]) {
      const rows: Array<{ id: string }> = await (tx as any)
        .select({ id: table.id })
        .from(table)
        .where(inArray(table.id, [...ids]));
      for (const row of rows) found.add(row.id);
    }
    existing.set(kind, found);
  }
  return referenced
    .filter(({ references }) => references.some(({ kinds, id }) => !kinds.some((kind) => existing.get(kind)?.has(id))))
    .map(({ scope }) => scope);
}

/**
 * Remove every stored grant (user, group, API token and OAuth/MCP credential scopes) that names a deleted resource.
 * Call it in the transaction that deletes resources, after the delete, so cascaded rows are covered too.
 */
export async function removeDanglingResourceScopes(
  tx: DrizzleExecutor
): Promise<PersistedScopeChanges & { removed: string[] }> {
  const removed = await danglingResourceScopes(tx, await listPersistedQualifiedScopes(tx));
  const remove = new Set(removed);
  const changes = await rewritePersistedScopes(tx, removed, (scopes) => scopes.filter((scope) => !remove.has(scope)));
  return { ...changes, removed };
}

/** Tell the sessions of changed users and group members that their permissions changed. Never throws. */
export async function announceResourceScopeChanges(changes: PersistedScopeChanges): Promise<void> {
  if (changes.userIds.length === 0 && changes.groupIds.length === 0) return;
  try {
    const { AuthService } = await import('@/modules/auth/auth.service.js');
    const { GroupService } = await import('@/modules/groups/group.service.js');
    if (changes.userIds.length > 0 && container.isRegistered(AuthService)) {
      await container.resolve(AuthService).announcePermissionsChanged(changes.userIds, 'resource_deleted');
    }
    if (changes.groupIds.length > 0 && container.isRegistered(GroupService)) {
      await container.resolve(GroupService).announceScopesChanged(changes.groupIds);
    }
  } catch (error) {
    logger.warn('Failed to announce permissions removed with a deleted resource', { error });
  }
}

/**
 * Run a deletion in a transaction that also removes the grants naming what it deleted, then announce the permission
 * change after commit.
 */
export async function transactionWithScopeCleanup<T>(
  db: DrizzleClient,
  work: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  let changes: PersistedScopeChanges = { userIds: [], groupIds: [] };
  const result = await db.transaction(async (tx) => {
    const value = await work(tx);
    changes = await removeDanglingResourceScopes(tx);
    return value;
  });
  await announceResourceScopeChanges(changes);
  return result;
}

/**
 * Repair for grants left behind by releases that deleted resources without their permissions (and a safety net for
 * any later path that misses the cleanup). Idempotent: it only removes scopes naming rows that no longer exist.
 */
export async function repairDanglingResourceScopes(db: DrizzleClient): Promise<number> {
  const changes = await db.transaction((tx) => removeDanglingResourceScopes(tx));
  if (changes.removed.length > 0) {
    logger.info('Removed permissions naming deleted resources', {
      scopes: changes.removed.length,
      users: changes.userIds.length,
      groups: changes.groupIds.length,
    });
  }
  await announceResourceScopeChanges(changes);
  return changes.removed.length;
}
