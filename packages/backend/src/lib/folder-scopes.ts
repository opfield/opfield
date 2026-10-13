import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  adminUserFolders,
  appFolders,
  apps,
  certificateAuthorities,
  certificates,
  certificateTemplates,
  databaseConnectionFolders,
  databaseConnections,
  dockerAccessResources,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
  domainFolders,
  domains,
  hostingNodeBindings,
  hostingResources,
  integrationConnectors,
  loggingEnvironmentFolders,
  loggingEnvironments,
  loggingSchemaFolders,
  loggingSchemas,
  managedDatabaseInstances,
  managedStorageClusters,
  nginxTemplateFolders,
  nginxTemplates,
  nodeFolders,
  nodes,
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
import {
  canonicalizeScopes,
  extractBaseScope,
  FOLDER_CREATION_SCOPES,
  FOLDER_MANAGE_SCOPES,
  FOLDER_SCOPABLE,
} from './scopes.js';

export const FOLDER_SCOPE_TARGET_PREFIX = 'folder/';

const FOLDER_SCOPABLE_SET = new Set(FOLDER_SCOPABLE);
const CREATION_SCOPES = new Set<string>(FOLDER_CREATION_SCOPES);
/** Folder management grants cover the folder's subfolders, never the resources in them. */
const FOLDER_MANAGE_SCOPE_SET = new Set<string>(FOLDER_MANAGE_SCOPES);

export interface FolderScopedGrant {
  scope: string;
  baseScope: string;
  folderId: string;
}

export function folderScopeTarget(folderId: string): string {
  return `${FOLDER_SCOPE_TARGET_PREFIX}${folderId}`;
}

export function folderScopedScope(baseScope: string, folderId: string): string {
  return `${baseScope}:${folderScopeTarget(folderId)}`;
}

export function parseFolderScopedGrant(scope: string): FolderScopedGrant | null {
  const baseScope = extractBaseScope(scope);
  if (!FOLDER_SCOPABLE_SET.has(baseScope) || scope === baseScope) return null;
  const target = scope.slice(baseScope.length + 1);
  if (!target.startsWith(FOLDER_SCOPE_TARGET_PREFIX)) return null;
  const folderId = target.slice(FOLDER_SCOPE_TARGET_PREFIX.length);
  if (!folderId || folderId.includes('/')) return null;
  return { scope, baseScope, folderId };
}

export function isFolderScopedScope(scope: string): boolean {
  return parseFolderScopedGrant(scope) !== null;
}

export function getFolderScopedIds(scopes: readonly string[], baseScopes: readonly string[]): string[] {
  return [
    ...new Set(
      scopes.flatMap((scope) => {
        const parsed = parseFolderScopedGrant(scope);
        return parsed && baseScopes.includes(parsed.baseScope) ? [parsed.folderId] : [];
      })
    ),
  ];
}

type FolderRow = { id: string; parentId: string | null };
type ResourceRow = { id: string; folderId: string | null };

function folderDescendants(rows: FolderRow[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!row.parentId || !result.has(row.parentId) || result.has(row.id)) continue;
      result.add(row.id);
      changed = true;
    }
  }
  return result;
}

async function expandSimpleFamily(
  db: DrizzleClient,
  grants: FolderScopedGrant[],
  folderTable: any,
  resourceTable: any
): Promise<string[]> {
  if (grants.length === 0) return [];
  const folderRows = (await db
    .select({ id: folderTable.id, parentId: folderTable.parentId })
    .from(folderTable)) as FolderRow[];
  const descendantsByGrant = new Map(
    grants.map((grant) => [grant.scope, folderDescendants(folderRows, grant.folderId)])
  );
  const visibleFolderIds = new Set([...descendantsByGrant.values()].flatMap((ids) => [...ids]));
  if (visibleFolderIds.size === 0) return [];
  const resourceRows = (await db
    .select({ id: resourceTable.id, folderId: resourceTable.folderId })
    .from(resourceTable)
    .where(inArray(resourceTable.folderId, [...visibleFolderIds]))) as ResourceRow[];

  return grants.flatMap((grant) => {
    const folderIds = descendantsByGrant.get(grant.scope)!;
    return [
      ...[...folderIds].map((folderId) => folderScopedScope(grant.baseScope, folderId)),
      ...(FOLDER_MANAGE_SCOPE_SET.has(grant.baseScope) ||
      (CREATION_SCOPES.has(grant.baseScope) && grant.baseScope !== 'ssl:cert:issue')
        ? []
        : resourceRows
            .filter((resource) => resource.folderId && folderIds.has(resource.folderId))
            .map((resource) => `${grant.baseScope}:${resource.id}`)),
    ];
  });
}

async function expandDockerFamily(db: DrizzleClient, grants: FolderScopedGrant[]): Promise<string[]> {
  if (grants.length === 0) return [];
  const folderRows = await db
    .select({
      id: dockerContainerFolders.id,
      parentId: dockerContainerFolders.parentId,
      resourceType: dockerContainerFolders.resourceType,
    })
    .from(dockerContainerFolders);
  // Availability policies act on containers, deployments, and Compose projects, so their folder grants
  // follow the granted folder's own type; every other Docker scope names its folder type.
  const folderTypeByGrant = new Map(
    grants.map((grant) => {
      const type = folderRows.find((row) => row.id === grant.folderId)?.resourceType;
      // Folder management covers the granted folder's subtree in whichever Docker list it belongs to.
      if (grant.baseScope === 'docker:folders:manage') return [grant.scope, type ?? null];
      if (grant.baseScope !== 'docker:availability:manage') return [grant.scope, dockerFolderType(grant.baseScope)];
      return [grant.scope, type === 'container' || type === 'compose' ? type : null];
    })
  );
  const descendantsByGrant = new Map(
    grants.map((grant) => {
      const type = folderTypeByGrant.get(grant.scope);
      const typedRows = folderRows.filter((row) => row.resourceType === type);
      return [
        grant.scope,
        type && typedRows.some((row) => row.id === grant.folderId)
          ? folderDescendants(typedRows, grant.folderId)
          : new Set<string>(),
      ];
    })
  );
  const visibleFolderIds = new Set([...descendantsByGrant.values()].flatMap((ids) => [...ids]));
  if (visibleFolderIds.size === 0) return [];

  const assignments = await db
    .select({
      folderId: dockerContainerFolderAssignments.folderId,
      nodeId: dockerContainerFolderAssignments.nodeId,
      resourceType: dockerContainerFolderAssignments.resourceType,
      resourceKey: dockerContainerFolderAssignments.resourceKey,
    })
    .from(dockerContainerFolderAssignments)
    .where(inArray(dockerContainerFolderAssignments.folderId, [...visibleFolderIds]));
  const containerAssignments = assignments.filter((assignment) => assignment.resourceType === 'container');
  const composeAssignments = assignments.filter((assignment) => assignment.resourceType === 'compose');
  const networkAssignments = assignments.filter((assignment) => assignment.resourceType === 'network');
  const networkNodeIds = [...new Set(networkAssignments.map((assignment) => assignment.nodeId))];
  const assignmentNodeIds = [...new Set(containerAssignments.map((assignment) => assignment.nodeId))];
  const composeNodeIds = [...new Set(composeAssignments.map((assignment) => assignment.nodeId))];
  const [containerResourceIds, deploymentIds, composeProjects, networkResourceIds] = await Promise.all([
    assignmentNodeIds.length === 0
      ? []
      : db
          .select({
            id: dockerAccessResources.id,
            nodeId: dockerAccessResources.nodeId,
            resourceKey: dockerAccessResources.resourceKey,
          })
          .from(dockerAccessResources)
          .where(
            and(
              eq(dockerAccessResources.resourceType, 'container'),
              inArray(dockerAccessResources.nodeId, assignmentNodeIds)
            )
          ),
    assignmentNodeIds.length === 0
      ? []
      : db
          .select({
            id: dockerDeployments.id,
            nodeId: dockerDeployments.nodeId,
            name: dockerDeployments.name,
          })
          .from(dockerDeployments)
          .where(inArray(dockerDeployments.nodeId, assignmentNodeIds)),
    composeNodeIds.length === 0
      ? []
      : db
          .select({ id: dockerComposeProjects.id, nodeId: dockerComposeProjects.nodeId })
          .from(dockerComposeProjects)
          .where(inArray(dockerComposeProjects.nodeId, composeNodeIds)),
    networkNodeIds.length === 0
      ? []
      : db
          .select({
            id: dockerAccessResources.id,
            nodeId: dockerAccessResources.nodeId,
            resourceKey: dockerAccessResources.resourceKey,
          })
          .from(dockerAccessResources)
          .where(
            and(
              eq(dockerAccessResources.resourceType, 'network'),
              inArray(dockerAccessResources.nodeId, networkNodeIds)
            )
          ),
  ]);
  const containerIdByRef = new Map(
    containerResourceIds.map((resource) => [`${resource.nodeId}\u0000${resource.resourceKey}`, resource.id])
  );
  const deploymentIdByRef = new Map(
    deploymentIds.map((deployment) => [`${deployment.nodeId}\u0000${deployment.name}`, deployment.id])
  );
  const composeIdByRef = new Map(
    composeProjects.map((project) => [`${project.nodeId}\u0000${project.id}`, project.id])
  );
  const networkIdByRef = new Map(
    networkResourceIds.map((resource) => [`${resource.nodeId}\u0000${resource.resourceKey}`, resource.id])
  );

  return grants.flatMap((grant) => {
    const folderIds = descendantsByGrant.get(grant.scope)!;
    return [
      ...[...folderIds].map((folderId) => folderScopedScope(grant.baseScope, folderId)),
      ...assignments.flatMap((assignment) => {
        if (CREATION_SCOPES.has(grant.baseScope) || FOLDER_MANAGE_SCOPE_SET.has(grant.baseScope)) return [];
        if (!assignment.folderId || !folderIds.has(assignment.folderId)) return [];
        const expectedType = folderTypeByGrant.get(grant.scope);
        if (assignment.resourceType !== expectedType) return [];
        const ref = `${assignment.nodeId}\u0000${assignment.resourceKey}`;
        const resourceId =
          assignment.resourceType === 'compose'
            ? composeIdByRef.get(ref)
            : assignment.resourceType === 'container'
              ? (deploymentIdByRef.get(ref) ?? containerIdByRef.get(ref))
              : assignment.resourceType === 'network'
                ? networkIdByRef.get(ref)
                : assignment.resourceKey;
        return resourceId ? [`${grant.baseScope}:${assignment.nodeId}/${resourceId}`] : [];
      }),
    ];
  });
}

/** Ingress groups live in node folders and are granted by folder only: a grant covers the folder's subfolders. */
async function expandIngressGroupFamily(db: DrizzleClient, grants: FolderScopedGrant[]): Promise<string[]> {
  if (grants.length === 0) return [];
  const folderRows = await db.select({ id: nodeFolders.id, parentId: nodeFolders.parentId }).from(nodeFolders);
  return grants.flatMap((grant) =>
    [...folderDescendants(folderRows, grant.folderId)].map((folderId) => folderScopedScope(grant.baseScope, folderId))
  );
}

/** CA folders hold root CAs; a grant on a folder also covers the intermediates below each root. */
async function expandPkiCaFamily(db: DrizzleClient, grants: FolderScopedGrant[]): Promise<string[]> {
  const expanded = await expandSimpleFamily(db, grants, pkiCaFolders, certificateAuthorities);
  if (expanded.length === 0) return expanded;
  const cas = await db
    .select({ id: certificateAuthorities.id, parentId: certificateAuthorities.parentId })
    .from(certificateAuthorities);
  const children = new Map<string, string[]>();
  for (const ca of cas) {
    if (ca.parentId) children.set(ca.parentId, [...(children.get(ca.parentId) ?? []), ca.id]);
  }
  const descendants = (rootId: string): string[] => {
    const found: string[] = [];
    const queue = [rootId];
    const seen = new Set(queue);
    while (queue.length > 0) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
    return found;
  };
  return expanded.flatMap((scope) => {
    const grant = grants.find((candidate) => scope.startsWith(`${candidate.baseScope}:`));
    const target = grant ? scope.slice(grant.baseScope.length + 1) : '';
    if (!grant || target.startsWith(FOLDER_SCOPE_TARGET_PREFIX)) return [scope];
    return [scope, ...descendants(target).map((id) => `${grant.baseScope}:${id}`)];
  });
}

function dockerFolderType(baseScope: string): string {
  if (baseScope.startsWith('docker:compose:')) return 'compose';
  if (baseScope.startsWith('docker:networks:')) return 'network';
  if (baseScope.startsWith('docker:volumes:')) return 'volume';
  if (baseScope.startsWith('docker:images:')) return 'image';
  return 'container';
}

function familyForBaseScope(baseScope: string) {
  if (baseScope === 'admin:groups' || baseScope === 'admin:groups:folders:manage') return 'groups';
  if (
    baseScope === 'admin:users' ||
    baseScope === 'admin:users:impersonate' ||
    baseScope === 'admin:users:folders:manage'
  )
    return 'users';
  if (baseScope === 'pki:templates:folders:manage') return 'pki-templates';
  if (baseScope.startsWith('domains:')) return 'domains';
  if (baseScope.startsWith('proxy:templates:')) return 'nginx-templates';
  if (baseScope.startsWith('proxy:')) return 'proxy';
  if (baseScope.startsWith('pki:ca:')) return 'pki-cas';
  if (baseScope.startsWith('pki:cert:')) return 'pki-certificates';
  if (baseScope.startsWith('pages:')) return 'pages';
  if (baseScope.startsWith('apps:')) return 'apps';
  if (baseScope.startsWith('ssl:cert:')) return 'ssl';
  if (baseScope.startsWith('nodes:')) return 'nodes';
  if (baseScope.startsWith('ingress:groups:')) return 'ingress-groups';
  if (baseScope.startsWith('docker:containers:')) return 'docker';
  if (baseScope === 'docker:availability:manage' || baseScope === 'docker:folders:manage') return 'docker';
  if (baseScope.startsWith('docker:compose:')) return 'docker';
  if (
    baseScope.startsWith('docker:networks:') ||
    baseScope.startsWith('docker:volumes:') ||
    baseScope.startsWith('docker:images:')
  )
    return 'docker';
  if (baseScope.startsWith('storage:')) return 'storage';
  if (baseScope.startsWith('databases:')) return 'databases';
  if (baseScope.startsWith('logs:schemas:')) return 'logging-schemas';
  // Ingest tokens and log reading are qualified by the logging environment ID.
  if (baseScope.startsWith('logs:environments:') || baseScope.startsWith('logs:tokens:') || baseScope === 'logs:read')
    return 'logging-environments';
  return null;
}

/** Explicit node targets avoid ambiguity with legacy bare resource UUIDs. */
async function expandNodeScopes(db: DrizzleClient, scopes: readonly string[]): Promise<string[]> {
  const grants = scopes.flatMap((scope) => {
    const base = extractBaseScope(scope);
    const prefix = `${base}:node/`;
    if (!scope.startsWith(prefix)) return [];
    const nodeId = scope.slice(prefix.length);
    if (!nodeId || nodeId.includes('/')) return [];
    return [{ base, nodeId }];
  });
  const expanded: string[] = [];
  for (const { base, nodeId } of grants) {
    if (CREATION_SCOPES.has(base)) continue;
    let rows: Array<{ id: string | null }> = [];
    if (base.startsWith('proxy:')) {
      rows = await db.select({ id: proxyHosts.id }).from(proxyHosts).where(eq(proxyHosts.nodeId, nodeId));
    } else if (base.startsWith('pages:')) {
      rows = await db.select({ id: pageProjects.id }).from(pageProjects).where(eq(pageProjects.nodeId, nodeId));
    } else if (base.startsWith('storage:')) {
      rows = await db
        .select({ id: managedStorageClusters.objectStorageConnectionId })
        .from(managedStorageClusters)
        .where(eq(managedStorageClusters.nodeId, nodeId));
    } else if (base.startsWith('databases:')) {
      rows = await db
        .select({ id: managedDatabaseInstances.databaseConnectionId })
        .from(managedDatabaseInstances)
        .where(eq(managedDatabaseInstances.nodeId, nodeId));
    } else if (
      base.startsWith('hosting:snapshots:') ||
      (base.startsWith('hosting:resources:') && base !== 'hosting:resources:create')
    ) {
      rows = await db
        .select({ id: hostingNodeBindings.resourceId })
        .from(hostingNodeBindings)
        .where(eq(hostingNodeBindings.nodeId, nodeId));
    } else if (base.startsWith('docker:')) {
      expanded.push(`${base}:${nodeId}`);
    }
    expanded.push(...rows.flatMap(({ id }) => (id ? [`${base}:${id}`] : [])));
  }
  return expanded;
}

async function expandHostingAccountScopes(db: DrizzleClient, scopes: readonly string[]): Promise<string[]> {
  const grants = scopes.flatMap<{ base: string; provider: string | null; accountId: string | null }>((scope) => {
    const base = extractBaseScope(scope);
    if (!base.startsWith('hosting:') && !base.startsWith('integrations:hosting:')) return [];
    const target = scope.slice(base.length + 1);
    if (target.startsWith('provider/')) {
      const provider = target.slice('provider/'.length);
      return ['proxmox', 'digitalocean', 'hetzner', 'hostkey', 'cloudblast'].includes(provider)
        ? [{ base, provider, accountId: null }]
        : [];
    }
    if (target.startsWith('account/') && !target.slice('account/'.length).includes('/')) {
      return [{ base, provider: null, accountId: target.slice('account/'.length) }];
    }
    return [];
  });
  if (!grants.length) return [];
  const accounts = await db
    .select({ id: integrationConnectors.id, provider: integrationConnectors.provider })
    .from(integrationConnectors)
    .where(inArray(integrationConnectors.provider, ['proxmox', 'digitalocean', 'hetzner', 'hostkey', 'cloudblast']));
  const needsVmIds = grants.some(({ base }) => !hostingAccountTarget(base));
  const resources =
    needsVmIds && accounts.length
      ? await db
          .select({ id: hostingResources.id, connectorId: hostingResources.connectorId })
          .from(hostingResources)
          .where(
            inArray(
              hostingResources.connectorId,
              accounts.map(({ id }) => id)
            )
          )
      : [];
  return grants.flatMap(({ base, provider, accountId }) => {
    const ids = new Set(
      accounts
        .filter((account) => (provider ? account.provider === provider : account.id === accountId))
        .map(({ id }) => id)
    );
    return hostingAccountTarget(base)
      ? [...ids].map((id) => `${base}:${id}`)
      : resources
          .filter((resource) => resource.connectorId && ids.has(resource.connectorId))
          .map(({ id }) => `${base}:${id}`);
  });
}

function hostingAccountTarget(base: string): boolean {
  return (
    base.startsWith('integrations:hosting:') ||
    base.startsWith('hosting:billing:') ||
    base === 'hosting:resources:create'
  );
}

/**
 * Resolve dynamic folder grants to the existing resource-scoped representation.
 * The original folder grants remain present so delegation and the permissions UI
 * retain their stable folder identity.
 */
export async function expandFolderScopes(db: DrizzleClient, scopes: readonly string[]): Promise<string[]> {
  const canonical = canonicalizeScopes(scopes);
  const nodeScopes = [...(await expandNodeScopes(db, canonical)), ...(await expandHostingAccountScopes(db, canonical))];
  const grants = canonical.flatMap((scope) => {
    const parsed = parseFolderScopedGrant(scope);
    return parsed ? [parsed] : [];
  });
  if (grants.length === 0) return canonicalizeScopes([...canonical, ...nodeScopes]);

  const byFamily = new Map<string, FolderScopedGrant[]>();
  for (const grant of grants) {
    const family = familyForBaseScope(grant.baseScope);
    if (!family) continue;
    byFamily.set(family, [...(byFamily.get(family) ?? []), grant]);
  }

  const expanded = await Promise.all([
    expandSimpleFamily(db, byFamily.get('groups') ?? [], permissionGroupFolders, permissionGroups),
    expandSimpleFamily(db, byFamily.get('users') ?? [], adminUserFolders, users),
    expandSimpleFamily(db, byFamily.get('domains') ?? [], domainFolders, domains),
    expandSimpleFamily(db, byFamily.get('proxy') ?? [], proxyHostFolders, proxyHosts),
    expandSimpleFamily(db, byFamily.get('pages') ?? [], pageProjectFolders, pageProjects),
    expandSimpleFamily(db, byFamily.get('apps') ?? [], appFolders, apps),
    expandSimpleFamily(db, byFamily.get('ssl') ?? [], sslCertificateFolders, sslCertificates),
    expandPkiCaFamily(db, byFamily.get('pki-cas') ?? []),
    expandSimpleFamily(db, byFamily.get('pki-certificates') ?? [], pkiCertificateFolders, certificates),
    expandSimpleFamily(db, byFamily.get('pki-templates') ?? [], pkiTemplateFolders, certificateTemplates),
    expandSimpleFamily(db, byFamily.get('nginx-templates') ?? [], nginxTemplateFolders, nginxTemplates),
    expandSimpleFamily(db, byFamily.get('nodes') ?? [], nodeFolders, nodes),
    expandIngressGroupFamily(db, byFamily.get('ingress-groups') ?? []),
    expandDockerFamily(db, byFamily.get('docker') ?? []),
    expandSimpleFamily(db, byFamily.get('storage') ?? [], objectStorageFolders, objectStorageConnections),
    expandSimpleFamily(db, byFamily.get('databases') ?? [], databaseConnectionFolders, databaseConnections),
    expandSimpleFamily(db, byFamily.get('logging-environments') ?? [], loggingEnvironmentFolders, loggingEnvironments),
    expandSimpleFamily(db, byFamily.get('logging-schemas') ?? [], loggingSchemaFolders, loggingSchemas),
  ]);

  return canonicalizeScopes([...canonical, ...nodeScopes, ...expanded.flat()]);
}
