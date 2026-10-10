import { container } from '@/container.js';
import type { AppFamily } from './app-families.js';
import { type AppListFilter, AppMembershipService, parseAppListFilter } from './app-membership.js';
import {
  APP_FAMILY_NODE_TYPES,
  appPlacementForFolder,
  assertAppPlacement,
  assertPlacementNodesAllowed,
  filterNodesForAppFolder,
} from './app-placement-guard.js';

/**
 * What the commercial core needs from apps (attached as `apps` to the runtimes it receives): the node allowlist
 * guard for its create and placement paths, and the `app` field and list filters for its resource lists.
 */
export const appsHostRuntime = {
  APP_FAMILY_NODE_TYPES,
  appPlacementForFolder,
  assertAppPlacement,
  assertPlacementNodesAllowed,
  filterNodesForAppFolder,
  parseAppListFilter,
  /** `app` ({id, slug, name, environmentId, environmentName} | null) on each row of a folder-based list. */
  annotateAppMembers<T extends Record<string, any>>(
    family: AppFamily,
    rows: T[],
    folderIdOf?: (row: T) => string | null | undefined
  ) {
    return container.resolve(AppMembershipService).annotate(family, rows, folderIdOf);
  },
  /** Annotate, then apply `excludeAppMembers` / `appId` (parse them from the query with parseAppListFilter). */
  annotateAndFilterAppMembers<T extends Record<string, any>>(
    family: AppFamily,
    rows: T[],
    filter: AppListFilter,
    folderIdOf?: (row: T) => string | null | undefined
  ) {
    return container.resolve(AppMembershipService).annotateAndFilter(family, rows, filter, folderIdOf);
  },
  /** `app` of one resource by its folder (detail responses). */
  appForFolder(family: AppFamily, folderId: string | null | undefined) {
    return container.resolve(AppMembershipService).refForFolder(family, folderId);
  },
};

export type AppsHostRuntime = typeof appsHostRuntime;
