import { and, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { parseFolderScopedGrant } from '@/lib/folder-scopes.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { APP_FAMILY_TABLES } from './app-families.js';
import { memberGrantKey, type ResourceGrantFamily, resolveAppMemberGrantTargets } from './app-member-grants.js';

/** Folder tables that hold apps' hidden folders (Docker containers and Compose share one). */
export type PlaceTable =
  | 'docker'
  | 'routes'
  | 'domains'
  | 'databases'
  | 'storage'
  | 'pages'
  | 'certificates'
  | 'logging';

const PLACE_TABLES: Readonly<Record<PlaceTable, any>> = {
  docker: APP_FAMILY_TABLES.containers.table,
  routes: APP_FAMILY_TABLES.routes.table,
  domains: APP_FAMILY_TABLES.domains.table,
  databases: APP_FAMILY_TABLES.databases.table,
  storage: APP_FAMILY_TABLES.storage.table,
  pages: APP_FAMILY_TABLES.pages.table,
  certificates: APP_FAMILY_TABLES.certificates.table,
  logging: APP_FAMILY_TABLES.logging.table,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folder table a folder grant of this base names, when apps keep hidden folders there; null otherwise. */
function placeTableOf(baseScope: string): PlaceTable | null {
  if (
    baseScope.startsWith('docker:containers:') ||
    baseScope.startsWith('docker:compose:') ||
    baseScope === 'docker:availability:manage' ||
    baseScope === 'docker:folders:manage'
  ) {
    return 'docker';
  }
  if (baseScope.startsWith('proxy:') && !baseScope.startsWith('proxy:templates:')) return 'routes';
  if (baseScope.startsWith('domains:')) return 'domains';
  if (baseScope.startsWith('databases:')) return 'databases';
  if (baseScope.startsWith('storage:')) return 'storage';
  if (baseScope.startsWith('pages:')) return 'pages';
  if (baseScope.startsWith('ssl:cert:')) return 'certificates';
  // Logging environments: their own scopes, ingest tokens and log reading (schemas live in another tree).
  if (baseScope.startsWith('logs:environments:') || baseScope.startsWith('logs:tokens:') || baseScope === 'logs:read')
    return 'logging';
  return null;
}

function placeGrant(scope: string): { table: PlaceTable; folderId: string } | null {
  const grant = parseFolderScopedGrant(scope);
  if (!grant) return null;
  const table = placeTableOf(grant.baseScope);
  return table ? { table, folderId: grant.folderId } : null;
}

/**
 * A per-resource grant on a resource of an app family (a creator grant, for example): the family and the resource it
 * names, Docker ones as `<nodeId>/<id>`. Broad, folder and node grants (Docker: a bare node id) are none.
 */
function resourceGrant(scope: string): { family: ResourceGrantFamily; target: string } | null {
  const base = extractBaseScope(scope);
  if (scope === base) return null;
  const table = placeTableOf(base);
  if (!table || base === 'docker:folders:manage') return null;
  const target = scope.slice(base.length + 1);
  if (table === 'docker') {
    const separator = target.indexOf('/');
    if (separator <= 0) return null;
    if (!UUID_RE.test(target.slice(0, separator)) || !UUID_RE.test(target.slice(separator + 1))) return null;
    return { family: base.startsWith('docker:compose:') ? 'compose' : 'containers', target };
  }
  if (!UUID_RE.test(target)) return null;
  return { family: table, target };
}

/**
 * Scope bases held only through app places: every grant of the base (as assigned, before folder expansion) names
 * an app's hidden folder or a member of an app (the per-resource grants creating inside an app adds). A broad grant,
 * a node grant, a grant on a resource outside apps or a grant on a user folder of the same base keeps the base.
 * Global sections (Docker, Routes, Domains, Certificates, Databases, Storage, Pages, Logging) ignore these bases, so
 * a user limited to an app works through Apps; the grants themselves and every check on them are unchanged.
 */
export function appOnlyScopeBases(
  assignedScopes: readonly string[],
  isHiddenFolder: (table: PlaceTable, folderId: string) => boolean,
  isAppMember: (family: ResourceGrantFamily, target: string) => boolean = () => false
): string[] {
  const appOnly = new Set<string>();
  const elsewhere = new Set<string>();
  for (const scope of assignedScopes) {
    const base = extractBaseScope(scope);
    const grant = placeGrant(scope);
    const resource = grant ? null : resourceGrant(scope);
    const inApp = grant
      ? isHiddenFolder(grant.table, grant.folderId)
      : !!resource && isAppMember(resource.family, resource.target);
    if (inApp) appOnly.add(base);
    else elsewhere.add(base);
  }
  return [...appOnly].filter((base) => !elsewhere.has(base)).sort();
}

/**
 * appOnlyScopeBases with the hidden folders and app members read from the database: one indexed lookup per folder
 * table and resource family the assigned grants name, none when there is no such grant.
 */
export async function resolveAppOnlyScopeBases(
  db: DrizzleExecutor,
  assignedScopes: readonly string[]
): Promise<string[]> {
  const idsByTable = new Map<PlaceTable, Set<string>>();
  const targetsByFamily = new Map<ResourceGrantFamily, Set<string>>();
  for (const scope of assignedScopes) {
    const grant = placeGrant(scope);
    if (grant) {
      if (!UUID_RE.test(grant.folderId)) continue;
      if (!idsByTable.has(grant.table)) idsByTable.set(grant.table, new Set());
      idsByTable.get(grant.table)!.add(grant.folderId);
      continue;
    }
    const resource = resourceGrant(scope);
    if (!resource) continue;
    if (!targetsByFamily.has(resource.family)) targetsByFamily.set(resource.family, new Set());
    targetsByFamily.get(resource.family)!.add(resource.target);
  }
  if (idsByTable.size === 0 && targetsByFamily.size === 0) return [];
  const hidden = new Map<PlaceTable, Set<string>>();
  for (const [key, ids] of idsByTable) {
    const table = PLACE_TABLES[key];
    const rows = (await (db as any)
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, [...ids]), isNotNull(table.appId)))) as Array<{ id: string }>;
    hidden.set(key, new Set(rows.map((row) => row.id)));
  }
  const members = await resolveAppMemberGrantTargets(db, targetsByFamily);
  return appOnlyScopeBases(
    assignedScopes,
    (table, folderId) => hidden.get(table)?.has(folderId) === true,
    (family, target) => members.has(memberGrantKey(family, target))
  );
}
