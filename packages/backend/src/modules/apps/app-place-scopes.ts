import { and, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { parseFolderScopedGrant } from '@/lib/folder-scopes.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { APP_FAMILY_TABLES } from './app-families.js';

/** Folder tables that hold apps' hidden folders (Docker containers and Compose share one). */
export type PlaceTable = 'docker' | 'routes' | 'databases' | 'storage' | 'pages';

const PLACE_TABLES: Readonly<Record<PlaceTable, any>> = {
  docker: APP_FAMILY_TABLES.containers.table,
  routes: APP_FAMILY_TABLES.routes.table,
  databases: APP_FAMILY_TABLES.databases.table,
  storage: APP_FAMILY_TABLES.storage.table,
  pages: APP_FAMILY_TABLES.pages.table,
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
  if (baseScope.startsWith('databases:')) return 'databases';
  if (baseScope.startsWith('storage:')) return 'storage';
  if (baseScope.startsWith('pages:')) return 'pages';
  return null;
}

function placeGrant(scope: string): { table: PlaceTable; folderId: string } | null {
  const grant = parseFolderScopedGrant(scope);
  if (!grant) return null;
  const table = placeTableOf(grant.baseScope);
  return table ? { table, folderId: grant.folderId } : null;
}

/**
 * Scope bases held only through app places: every grant of the base (as assigned, before folder expansion) names
 * an app's hidden folder. A broad grant, a node grant, a resource grant or a grant on a user folder of the same base
 * keeps the base. Global sections (Docker, Routes, Databases, Storage, Pages) ignore these bases, so a user limited to
 * an app works through Apps; the grants themselves and every check on them are unchanged.
 */
export function appOnlyScopeBases(
  assignedScopes: readonly string[],
  isHiddenFolder: (table: PlaceTable, folderId: string) => boolean
): string[] {
  const appOnly = new Set<string>();
  const elsewhere = new Set<string>();
  for (const scope of assignedScopes) {
    const base = extractBaseScope(scope);
    const grant = placeGrant(scope);
    if (grant && isHiddenFolder(grant.table, grant.folderId)) appOnly.add(base);
    else elsewhere.add(base);
  }
  return [...appOnly].filter((base) => !elsewhere.has(base)).sort();
}

/**
 * appOnlyScopeBases with the hidden folders read from the database: one indexed lookup per folder table the
 * assigned folder grants name, none when there is no such grant.
 */
export async function resolveAppOnlyScopeBases(
  db: DrizzleExecutor,
  assignedScopes: readonly string[]
): Promise<string[]> {
  const idsByTable = new Map<PlaceTable, Set<string>>();
  for (const scope of assignedScopes) {
    const grant = placeGrant(scope);
    if (!grant || !UUID_RE.test(grant.folderId)) continue;
    if (!idsByTable.has(grant.table)) idsByTable.set(grant.table, new Set());
    idsByTable.get(grant.table)!.add(grant.folderId);
  }
  if (idsByTable.size === 0) return [];
  const hidden = new Map<PlaceTable, Set<string>>();
  for (const [key, ids] of idsByTable) {
    const table = PLACE_TABLES[key];
    const rows = (await (db as any)
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, [...ids]), isNotNull(table.appId)))) as Array<{ id: string }>;
    hidden.set(key, new Set(rows.map((row) => row.id)));
  }
  return appOnlyScopeBases(assignedScopes, (table, folderId) => hidden.get(table)?.has(folderId) === true);
}
