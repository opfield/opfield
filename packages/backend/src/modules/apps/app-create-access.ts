import type { DrizzleExecutor } from '@/db/client.js';
import { parseFolderScopedGrant } from '@/lib/folder-scopes.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import type { AppFamily } from './app-families.js';
import type { AppFolderService } from './app-folders.service.js';

/** The scope that creates a resource of each family (the same check the family's create route makes). */
export const APP_FAMILY_CREATE_SCOPES: Readonly<Partial<Record<AppFamily, string>>> = {
  containers: 'docker:containers:create',
  compose: 'docker:compose:create',
  routes: 'proxy:create',
  databases: 'databases:create',
  storage: 'storage:create',
  pages: 'pages:create',
  certificates: 'ssl:cert:issue',
  logging: 'logs:environments:create',
};

/** Families created on a node: a grant on one of the environment's allowed nodes also creates there. */
const NODE_BOUND = new Set<AppFamily>(['containers', 'compose', 'routes', 'databases', 'storage', 'pages']);

/**
 * What the caller may create in an environment, per family: the family's create scope broadly, on the
 * environment's placement folder (an app-root grant reaches it through folder expansion) or, for node-bound
 * families, on an allowed node. The app page offers only these entry points; each create route still checks.
 */
export function environmentCreateAccess(
  scopes: readonly string[],
  placementFolderIds: Partial<Record<AppFamily, string | null>> | undefined,
  allowedNodeIds: readonly string[]
): Partial<Record<AppFamily, boolean>> {
  const result: Partial<Record<AppFamily, boolean>> = {};
  for (const [family, scope] of Object.entries(APP_FAMILY_CREATE_SCOPES) as Array<[AppFamily, string]>) {
    const folderId = placementFolderIds?.[family] ?? null;
    result[family] =
      (!!folderId && hasScopeForCreation(scopes, scope, folderId)) ||
      hasScopeForCreation(scopes, scope, null) ||
      (NODE_BOUND.has(family) && allowedNodeIds.some((nodeId) => hasScopeForCreation(scopes, scope, null, nodeId)));
  }
  return result;
}

/**
 * Environments (of these) on whose placement folders the caller holds a folder grant (an app root grant reaches
 * them through folder expansion): an access line in the environment without the app's own permissions. Such an
 * environment stays visible, through members, while it is still empty, so the caller can create in it.
 */
export async function environmentsWithPlaceGrants(
  folders: Pick<AppFolderService, 'envFolders'>,
  scopes: readonly string[],
  environmentIds: readonly string[],
  db?: DrizzleExecutor
): Promise<Set<string>> {
  const granted = new Set(scopes.flatMap((scope) => parseFolderScopedGrant(scope)?.folderId ?? []));
  if (granted.size === 0 || environmentIds.length === 0) return new Set();
  const byEnvironment = await folders.envFolders(environmentIds, db);
  return new Set(
    environmentIds.filter((id) =>
      Object.values(byEnvironment.get(id) ?? {}).some((folderId) => !!folderId && granted.has(folderId))
    )
  );
}
