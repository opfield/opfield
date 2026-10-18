import { inArray } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
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
  integrationConnectors,
  loggingEnvironmentFolders,
  loggingEnvironments,
  loggingSchemaFolders,
  loggingSchemas,
  nginxTemplateFolders,
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
import {
  type AccessFolderResourceType,
  type AreaGrantSummary,
  type GrantTargetSummary,
  LIMITED_ACCESS_RULES,
  summarizeScopeGrants,
} from './access-summary.js';
import { expandFolderScopes } from './folder-scopes.js';
import { extractBaseScope } from './scopes.js';

/** Entries listed per area and kind; the rest is counted in `omitted`. */
const MAX_LISTED = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccessCredential = 'session' | 'api-token' | 'oauth-token' | 'mcp' | 'assistant';

export interface AccessSummaryPrincipal {
  credential: AccessCredential;
  /** Tokens and OAuth/MCP grants never reach more than their owner currently can. */
  boundedByOwner: boolean;
  /** Account identity: present only for browser sessions (REST session or the in-product assistant). */
  userId?: string;
  name?: string | null;
  email?: string;
  group?: string;
}

/** Credentials acting in the account holder's own browser session. */
const SESSION_CREDENTIALS = new Set<AccessCredential>(['session', 'assistant']);

/**
 * The principal block of an access summary. Opfield has no identity or profile scope, so the owner's
 * id, name, email and group are returned only to browser sessions; API tokens and OAuth/MCP clients get
 * the access itself, never who owns it.
 */
export function accessSummaryPrincipal(
  user: { id: string; name: string | null; email: string; groupName: string },
  credential: AccessCredential
): AccessSummaryPrincipal {
  const session = SESSION_CREDENTIALS.has(credential);
  return {
    credential,
    boundedByOwner: !session,
    ...(session ? { userId: user.id, name: user.name, email: user.email, group: user.groupName } : {}),
  };
}

export interface AccessSummaryTarget {
  id: string;
  name: string | null;
  actions: string[];
}

export interface AccessSummaryFolder extends AccessSummaryTarget {
  /** Folder path from its top-level folder, e.g. "Clients / MyProject". */
  path: string | null;
  /** A folder grant covers every subfolder and everything placed there later. */
  includesSubfolders: true;
}

export interface AccessSummaryResource extends AccessSummaryTarget {
  nodeId?: string;
  nodeName?: string | null;
}

export interface AccessSummaryCreate {
  scope: string;
  /** Whether a create without a folder or node destination is allowed. */
  atRoot: boolean;
  folders: Array<{ id: string; name: string | null; path: string | null }>;
  nodes: Array<{ id: string; name: string | null }>;
  accounts: Array<{ id: string; name: string | null }>;
  howTo: string;
}

export interface AccessSummaryArea {
  area: string;
  title: string;
  /** broad: every resource of the area is visible; limited: only the folders, nodes and resources listed. */
  access: 'broad' | 'limited';
  /** Actions held everywhere in the area. */
  broadActions: string[];
  folders: AccessSummaryFolder[];
  nodes: AccessSummaryTarget[];
  resources: AccessSummaryResource[];
  accounts: AccessSummaryTarget[];
  create?: AccessSummaryCreate;
  /** The list_resource_folders arguments that show this area's folders with the actions held in each. */
  folderListing?: { tool: 'list_resource_folders'; arguments: Record<string, string> };
  omitted?: { folders?: number; nodes?: number; resources?: number; accounts?: number };
}

export interface AccessSummary {
  principal?: AccessSummaryPrincipal;
  /** True when some area is limited to folders, nodes or resources, or allows creation only there. */
  limited: boolean;
  /** Short text for agent instructions (the same text MCP adds to its server instructions). */
  summary: string;
  areas: AccessSummaryArea[];
  rules: readonly string[];
}

type Db = Pick<DrizzleClient, 'select'>;
type Row = Record<string, unknown>;

/** Used when no database is at hand: every lookup fails and the summary falls back to ids. */
const UNAVAILABLE_DB = {
  select: () => {
    throw new Error('Database unavailable');
  },
} as unknown as Db;

/** The application database, or null where none is registered (names then fall back to ids). */
export function accessSummaryDatabase(): DrizzleClient | null {
  try {
    return container.isRegistered(TOKENS.DrizzleClient) ? container.resolve<DrizzleClient>(TOKENS.DrizzleClient) : null;
  } catch {
    return null;
  }
}

function isTargetedQualifier(scope: string): boolean {
  const base = extractBaseScope(scope);
  if (scope === base) return false;
  const qualifier = scope.slice(base.length + 1);
  return (
    qualifier.startsWith('folder/') ||
    qualifier.startsWith('node/') ||
    qualifier.startsWith('account/') ||
    qualifier.startsWith('provider/')
  );
}

/**
 * The qualified scopes the authentication layer derived from folder, node and account grants
 * (subfolders and the resources inside them). Re-expanding only the targeted grants reproduces them.
 */
export async function derivedScopeSet(db: Db, scopes: readonly string[]): Promise<Set<string>> {
  const targeted = scopes.filter(isTargetedQualifier);
  if (targeted.length === 0) return new Set();
  const inputs = new Set(targeted);
  try {
    const expanded = await expandFolderScopes(db as DrizzleClient, targeted);
    return new Set(expanded.filter((scope) => !inputs.has(scope)));
  } catch {
    // Without the expansion, subfolders and folder contents are listed as grants of their own.
    return new Set();
  }
}

async function selectRows(db: Db, table: any, columns: Record<string, unknown>, ids?: readonly string[]) {
  try {
    const query = (db as any).select(columns).from(table);
    const rows = (await (ids ? query.where(inArray(table.id, [...ids])) : query)) as Row[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    // Names are a convenience: a failed lookup must never hide the access itself.
    return [];
  }
}

async function namesById(
  db: Db,
  table: any,
  columns: Record<string, unknown>,
  ids: readonly string[],
  nameOf: (row: Row) => unknown
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (wanted.length === 0) return new Map();
  const wantedSet = new Set(wanted);
  const rows = await selectRows(db, table, columns, wanted);
  const names = new Map<string, string>();
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : null;
    const name = nameOf(row);
    if (id && wantedSet.has(id) && typeof name === 'string' && name) names.set(id, name);
  }
  return names;
}

const FOLDER_TABLES: Record<AccessFolderResourceType, any> = {
  nodes: nodeFolders,
  databases: databaseConnectionFolders,
  storage: objectStorageFolders,
  domains: domainFolders,
  ssl_certificates: sslCertificateFolders,
  pki_cas: pkiCaFolders,
  pki_certificates: pkiCertificateFolders,
  pki_templates: pkiTemplateFolders,
  nginx_templates: nginxTemplateFolders,
  logging_environments: loggingEnvironmentFolders,
  logging_schemas: loggingSchemaFolders,
  notification_alert_rules: notificationAlertRuleFolders,
  notification_webhooks: notificationWebhookFolders,
  access_lists: accessListFolders,
  admin_users: adminUserFolders,
  permission_groups: permissionGroupFolders,
  routes: proxyHostFolders,
  docker: dockerContainerFolders,
  pages: pageProjectFolders,
  apps: appFolders,
};

type FolderInfo = { name: string | null; path: string | null; parentId: string | null };

async function folderPaths(db: Db, table: any): Promise<Map<string, FolderInfo>> {
  const rows = await selectRows(db, table, {
    id: table.id,
    name: table.name,
    parentId: table.parentId,
    ...(table.appId ? { appId: table.appId, appEnvironmentId: table.appEnvironmentId } : {}),
  });
  const byId = new Map(rows.filter((row) => typeof row.id === 'string').map((row) => [row.id as string, row]));
  const result = new Map<string, FolderInfo>();
  for (const [id, row] of byId) {
    const names: string[] = [];
    let current: Row | undefined = row;
    const seen = new Set<string>();
    while (current && typeof current.id === 'string' && !seen.has(current.id) && names.length < 8) {
      seen.add(current.id);
      names.unshift(typeof current.name === 'string' ? current.name : '?');
      current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined;
    }
    // A hidden app folder reads as its app and environment: the root is named like the app, the environment
    // folder like the environment.
    const appLabel =
      typeof row.appId === 'string'
        ? typeof row.appEnvironmentId === 'string'
          ? `App ${names[0] ?? '?'} · ${names[1] ?? '?'}`
          : `App ${names[0] ?? '?'} · every environment`
        : null;
    result.set(id, {
      name: appLabel ?? (typeof row.name === 'string' ? row.name : null),
      path: appLabel ?? names.join(' / '),
      parentId: typeof row.parentId === 'string' ? row.parentId : null,
    });
  }
  return result;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string') ?? null;
  return null;
}

/** Resource display names for one area. Docker volume and image grants are named by their key. */
async function resourceNames(db: Db, areaId: string, targets: GrantTargetSummary[]): Promise<Map<string, string>> {
  const ids = targets.map((target) => target.id);
  switch (areaId) {
    case 'docker_containers': {
      const [access, deployments] = await Promise.all([
        namesById(
          db,
          dockerAccessResources,
          { id: dockerAccessResources.id, resourceKey: dockerAccessResources.resourceKey },
          ids,
          (row) => row.resourceKey
        ),
        namesById(
          db,
          dockerDeployments,
          { id: dockerDeployments.id, name: dockerDeployments.name },
          ids,
          (row) => row.name
        ),
      ]);
      return new Map([...access, ...deployments]);
    }
    case 'docker_networks':
      return namesById(
        db,
        dockerAccessResources,
        { id: dockerAccessResources.id, resourceKey: dockerAccessResources.resourceKey },
        ids,
        (row) => row.resourceKey
      );
    case 'docker_compose':
      return namesById(
        db,
        dockerComposeProjects,
        { id: dockerComposeProjects.id, name: dockerComposeProjects.name },
        ids,
        (row) => row.name
      );
    case 'docker_volumes':
    case 'docker_images':
      return new Map(ids.map((id) => [id, id]));
    case 'routes':
      return namesById(db, proxyHosts, { id: proxyHosts.id, domainNames: proxyHosts.domainNames }, ids, (row) =>
        firstString(row.domainNames)
      );
    case 'domains':
      return namesById(db, domains, { id: domains.id, domain: domains.domain }, ids, (row) => row.domain);
    case 'ssl_certificates':
      return namesById(
        db,
        sslCertificates,
        { id: sslCertificates.id, name: sslCertificates.name },
        ids,
        (row) => row.name
      );
    case 'pki_certificates':
      return namesById(
        db,
        certificates,
        { id: certificates.id, commonName: certificates.commonName },
        ids,
        (row) => row.commonName
      );
    case 'pki_cas':
      return namesById(
        db,
        certificateAuthorities,
        { id: certificateAuthorities.id, commonName: certificateAuthorities.commonName },
        ids,
        (row) => row.commonName
      );
    case 'access_lists':
      return namesById(db, accessLists, { id: accessLists.id, name: accessLists.name }, ids, (row) => row.name);
    case 'databases':
      return namesById(
        db,
        databaseConnections,
        { id: databaseConnections.id, name: databaseConnections.name },
        ids,
        (row) => row.name
      );
    case 'storage':
      return namesById(
        db,
        objectStorageConnections,
        { id: objectStorageConnections.id, name: objectStorageConnections.name },
        ids,
        (row) => row.name
      );
    case 'pages':
      return namesById(db, pageProjects, { id: pageProjects.id, name: pageProjects.name }, ids, (row) => row.name);
    case 'logging_environments':
      return namesById(
        db,
        loggingEnvironments,
        { id: loggingEnvironments.id, name: loggingEnvironments.name },
        ids,
        (row) => row.name
      );
    case 'logging_schemas':
      return namesById(
        db,
        loggingSchemas,
        { id: loggingSchemas.id, name: loggingSchemas.name },
        ids,
        (row) => row.name
      );
    case 'notification_alert_rules':
      return namesById(
        db,
        notificationAlertRules,
        { id: notificationAlertRules.id, name: notificationAlertRules.name },
        ids,
        (row) => row.name
      );
    case 'notification_webhooks':
      return namesById(
        db,
        notificationWebhooks,
        { id: notificationWebhooks.id, name: notificationWebhooks.name },
        ids,
        (row) => row.name
      );
    case 'nodes':
      return nodeNames(db, ids);
    case 'users':
      return namesById(
        db,
        users,
        { id: users.id, name: users.name, email: users.email },
        ids,
        (row) => row.name || row.email
      );
    case 'groups':
      return namesById(
        db,
        permissionGroups,
        { id: permissionGroups.id, name: permissionGroups.name },
        ids,
        (row) => row.name
      );
    case 'hosting':
      return namesById(
        db,
        hostingResources,
        { id: hostingResources.id, remoteId: hostingResources.remoteId, kind: hostingResources.kind },
        ids,
        (row) => (typeof row.remoteId === 'string' ? `${row.kind ?? 'resource'} ${row.remoteId}` : null)
      );
    case 'apps':
      return appScopeNames(db, ids);
    case 'integrations': {
      // Git qualifiers are `<connectorId>[/<kind>/<id>]`; name them by their connector.
      const connectorIds = ids.map((id) => id.split('/')[0]);
      const connectors = await connectorNames(db, connectorIds);
      return new Map(
        ids.flatMap((id) => {
          const [connectorId, ...rest] = id.split('/');
          const connector = connectors.get(connectorId);
          return connector
            ? [[id, rest.length ? `${connector} ${rest.join(' ')}` : connector] as [string, string]]
            : [];
        })
      );
    }
    default:
      return new Map();
  }
}

/** App grants are `<appId>` (whole app) or `env/<envId>`; they read as "App Shop" and "App Shop · staging". */
async function appScopeNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const envIds = ids.filter((id) => id.startsWith('env/')).map((id) => id.slice('env/'.length));
  const envRows = (
    await selectRows(
      db,
      appEnvironments,
      { id: appEnvironments.id, name: appEnvironments.name, appId: appEnvironments.appId },
      envIds.filter((id) => UUID_RE.test(id))
    )
  ).filter((row) => typeof row.id === 'string');
  const appIds = [...ids.filter((id) => !id.startsWith('env/')), ...envRows.map((row) => String(row.appId))];
  const appNames = await namesById(db, apps, { id: apps.id, name: apps.name }, appIds, (row) => row.name);
  const result = new Map<string, string>();
  for (const id of ids) {
    if (!id.startsWith('env/') && appNames.has(id)) result.set(id, `App ${appNames.get(id)}`);
  }
  for (const row of envRows) {
    const app = appNames.get(String(row.appId));
    if (app) result.set(`env/${row.id}`, `App ${app} · ${row.name}`);
  }
  return result;
}

function nodeNames(db: Db, ids: readonly string[]) {
  return namesById(
    db,
    nodes,
    { id: nodes.id, hostname: nodes.hostname, displayName: nodes.displayName },
    ids,
    (row) => row.displayName || row.hostname
  );
}

function connectorNames(db: Db, ids: readonly string[]) {
  return namesById(
    db,
    integrationConnectors,
    { id: integrationConnectors.id, name: integrationConnectors.name },
    ids,
    (row) => row.name
  );
}

/**
 * Drop folders whose ancestor is granted with at least the same actions: the ancestor's grant already
 * covers them (the authentication layer expands a folder grant to every subfolder).
 */
function withoutCoveredSubfolders(
  folders: GrantTargetSummary[],
  folderMap: Map<string, FolderInfo> | undefined
): GrantTargetSummary[] {
  if (!folderMap || folders.length < 2) return folders;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return folders.filter((folder) => {
    const seen = new Set<string>([folder.id]);
    let parentId = folderMap.get(folder.id)?.parentId ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const ancestor = byId.get(parentId);
      if (ancestor && folder.actions.every((action) => ancestor.actions.includes(action))) return false;
      parentId = folderMap.get(parentId)?.parentId ?? null;
    }
    return true;
  });
}

function capped<T>(items: T[]): { items: T[]; omitted: number } {
  return items.length > MAX_LISTED
    ? { items: items.slice(0, MAX_LISTED), omitted: items.length - MAX_LISTED }
    : { items, omitted: 0 };
}

function createHowTo(summary: AreaGrantSummary): string {
  const hint = summary.area.createHint ?? 'pass folderId (and nodeId where the tool takes one)';
  if (summary.create?.atRoot) return `Create anywhere; ${hint} to place it.`;
  return `Creation at the root is refused: ${hint} with one of the destinations listed here.`;
}

/**
 * The access summary for a principal's effective scopes, with folder paths and resource names.
 * Pass the scopes exactly as authenticated: for tokens and OAuth/MCP grants they are already
 * bounded by the owner's current access.
 */
export async function buildAccessSummary(
  db: Db | null | undefined,
  scopes: readonly string[],
  principal?: AccessSummaryPrincipal
): Promise<AccessSummary> {
  db ??= UNAVAILABLE_DB;
  const derived = await derivedScopeSet(db, scopes);
  const grants = summarizeScopeGrants(scopes, { derived });

  const folderTypes = new Set(
    grants.areas.flatMap((summary) =>
      summary.folders.length && summary.area.folderResourceType ? [summary.area.folderResourceType] : []
    )
  );
  const allNodeIds = grants.areas.flatMap((summary) => [
    ...summary.nodes.map((node) => node.id),
    ...summary.resources.flatMap((resource) => (resource.nodeId ? [resource.nodeId] : [])),
  ]);
  const accountIds = grants.areas.flatMap((summary) =>
    summary.accounts.filter((account) => !account.provider).map((account) => account.id)
  );

  const [folderInfo, nodeNameMap, accountNames, resourceNameMaps] = await Promise.all([
    Promise.all([...folderTypes].map(async (type) => [type, await folderPaths(db, FOLDER_TABLES[type])] as const)).then(
      (entries) => new Map(entries)
    ),
    nodeNames(db, allNodeIds),
    connectorNames(db, accountIds),
    Promise.all(
      grants.areas.map(
        async (summary) => [summary.area.id, await resourceNames(db, summary.area.id, summary.resources)] as const
      )
    ).then((entries) => new Map(entries)),
  ]);

  const areas: AccessSummaryArea[] = grants.areas.map((summary) => {
    const folderMap = summary.area.folderResourceType ? folderInfo.get(summary.area.folderResourceType) : undefined;
    const names = resourceNameMaps.get(summary.area.id) ?? new Map<string, string>();
    const grantedFolders = withoutCoveredSubfolders(summary.folders, folderMap);
    const grantedFolderIds = new Set(grantedFolders.map((folder) => folder.id));
    const folders = capped(
      grantedFolders.map((folder) => ({
        id: folder.id,
        name: folderMap?.get(folder.id)?.name ?? null,
        path: folderMap?.get(folder.id)?.path ?? null,
        actions: folder.actions,
        includesSubfolders: true as const,
      }))
    );
    const nodeTargets = capped(
      summary.nodes.map((node) => ({ id: node.id, name: nodeNameMap.get(node.id) ?? null, actions: node.actions }))
    );
    const resources = capped(
      summary.resources.map((resource) => ({
        id: resource.id,
        name: names.get(resource.id) ?? null,
        actions: resource.actions,
        ...(resource.nodeId ? { nodeId: resource.nodeId, nodeName: nodeNameMap.get(resource.nodeId) ?? null } : {}),
      }))
    );
    const accounts = capped(
      summary.accounts.map((account) => ({
        id: account.id,
        name: account.provider ? `every ${account.id} account` : (accountNames.get(account.id) ?? null),
        actions: account.actions,
      }))
    );
    const folderById = new Map(summary.folders.map((folder) => [folder.id, folderMap?.get(folder.id)]));
    const omitted = {
      ...(folders.omitted ? { folders: folders.omitted } : {}),
      ...(nodeTargets.omitted ? { nodes: nodeTargets.omitted } : {}),
      ...(resources.omitted ? { resources: resources.omitted } : {}),
      ...(accounts.omitted ? { accounts: accounts.omitted } : {}),
    };
    const folderType = summary.area.folderResourceType;
    return {
      area: summary.area.id,
      title: summary.area.title,
      access: summary.broad ? 'broad' : 'limited',
      broadActions: summary.broadActions,
      folders: folders.items,
      nodes: nodeTargets.items,
      resources: resources.items,
      accounts: accounts.items,
      ...(summary.create
        ? {
            create: {
              scope: summary.create.scope,
              atRoot: summary.create.atRoot,
              folders: summary.create.folderIds
                .filter((id) => grantedFolderIds.has(id))
                .slice(0, MAX_LISTED)
                .map((id) => ({
                  id,
                  name: folderById.get(id)?.name ?? null,
                  path: folderById.get(id)?.path ?? null,
                })),
              nodes: summary.create.nodeIds
                .slice(0, MAX_LISTED)
                .map((id) => ({ id, name: nodeNameMap.get(id) ?? null })),
              accounts: summary.create.accountIds
                .slice(0, MAX_LISTED)
                .map((id) => ({ id, name: accountNames.get(id) ?? null })),
              howTo: createHowTo(summary),
            },
          }
        : {}),
      ...(folderType
        ? {
            folderListing: {
              tool: 'list_resource_folders' as const,
              arguments: {
                resourceType: folderType,
                ...(summary.area.dockerFolderType ? { dockerResourceType: summary.area.dockerFolderType } : {}),
              },
            },
          }
        : {}),
      ...(Object.keys(omitted).length ? { omitted } : {}),
    };
  });

  const result: AccessSummary = {
    ...(principal ? { principal } : {}),
    limited: grants.limited,
    summary: '',
    areas,
    rules: LIMITED_ACCESS_RULES,
  };
  result.summary = renderAccessSummaryText(result);
  return result;
}

function quoted(value: string | null, fallback: string): string {
  return value ? `'${value}'` : fallback;
}

function actionList(actions: readonly string[]): string {
  const shown = actions.slice(0, 6).join(', ');
  return actions.length > 6 ? `${shown}, …` : shown;
}

function describeTargets<T extends AccessSummaryTarget>(
  items: readonly T[],
  label: (item: T) => string,
  limit = 3
): string[] {
  const parts = items.slice(0, limit).map((item) => `${label(item)} (${actionList(item.actions)})`);
  if (items.length > limit) parts.push(`+${items.length - limit} more`);
  return parts;
}

function areaLine(area: AccessSummaryArea): string {
  const parts: string[] = [];
  if (area.broadActions.length) parts.push(`everywhere (${actionList(area.broadActions)})`);
  parts.push(
    ...describeTargets(area.folders, (folder) => `folder ${quoted(folder.path ?? folder.name, folder.id)}`),
    ...describeTargets(area.nodes, (node) => `node ${quoted(node.name, node.id)}`)
  );
  if (area.resources.length > 2) {
    const actions = [...new Set(area.resources.flatMap((resource) => resource.actions))].sort();
    const total = area.resources.length + (area.omitted?.resources ?? 0);
    parts.push(`${total} specific resources (${actionList(actions)})`);
  } else {
    parts.push(...describeTargets(area.resources, (resource) => `resource ${quoted(resource.name, resource.id)}`));
  }
  parts.push(...describeTargets(area.accounts, (account) => `account ${quoted(account.name, account.id)}`));
  const createNote = area.create && !area.create.atRoot ? '; create only in the folders or nodes listed' : '';
  return `- ${area.title}: ${parts.join('; ')}${createNote}.`;
}

/**
 * A short text for agent instructions. Empty when nothing is limited; capped at `maxLength` with a
 * pointer to get_my_access for the rest.
 */
export function renderAccessSummaryText(summary: Pick<AccessSummary, 'limited' | 'areas'>, maxLength = 1500): string {
  if (!summary.limited) return '';
  const restricted = summary.areas.filter(isRestrictedSummaryArea);
  const header =
    'Your Opfield access is limited to specific folders, nodes or resources. Empty lists and denials at the root are expected; work inside these grants:';
  const footer =
    'Call get_my_access (or read opfield://access) for ids and details; pass folderId (and nodeId) when creating.';
  const broadTitles = summary.areas
    .filter((area) => !restricted.includes(area) && area.access === 'broad')
    .map((area) => area.title);
  const lines = [header];
  let length = header.length + footer.length + 2;
  let shown = 0;
  for (const area of restricted) {
    const line = areaLine(area);
    if (length + line.length + 1 > maxLength - 60) break;
    lines.push(line);
    length += line.length + 1;
    shown += 1;
  }
  if (shown < restricted.length)
    lines.push(`- …and ${restricted.length - shown} more limited areas (see get_my_access).`);
  if (broadTitles.length) {
    const line = `- Unrestricted: ${broadTitles.join(', ')}.`;
    if (length + line.length + 1 <= maxLength - 60) lines.push(line);
  }
  lines.push(footer);
  const text = lines.join('\n');
  return text.length > maxLength ? `${text.slice(0, maxLength - footer.length - 2)}…\n${footer}` : text;
}

/** An area the caller cannot use at the root: limited visibility, or creation only in some destinations. */
export function isRestrictedSummaryArea(area: AccessSummaryArea): boolean {
  const targeted = area.folders.length + area.nodes.length + area.resources.length + area.accounts.length > 0;
  return (area.access === 'limited' && targeted) || (!!area.create && !area.create.atRoot);
}
