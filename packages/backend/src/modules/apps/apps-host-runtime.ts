import { container } from '@/container.js';
import {
  AppEnvLayerService,
  type EnvironmentLayer,
  type LayerOwnerKind,
  layerOwnerKey,
  mergeLayerEnv,
} from './app-env-layer.js';
import type { AppFamily } from './app-families.js';
import { AppMemberFreeze, type FreezeTarget } from './app-member-freeze.js';
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
  /**
   * Environment layer for deployments, Compose and migration (core): the variables and secrets of the environment a
   * workload's folder belongs to (empty outside apps), what it received last, and the merge rule. Record what was
   * applied after a deploy/apply with recordAppliedLayer('deployment', id, layer) or ('compose', projectId, layer).
   */
  resolveLayerForPlacement(family: AppFamily, folderId: string | null | undefined) {
    return container.resolve(AppEnvLayerService).resolveLayerForPlacement(family, folderId);
  },
  appliedLayerState(kind: LayerOwnerKind, ownerKey: string) {
    return container.resolve(AppEnvLayerService).appliedState(kind, ownerKey);
  },
  recordAppliedLayer(
    kind: LayerOwnerKind,
    ownerKey: string,
    layer: Pick<EnvironmentLayer, 'environmentId' | 'keys' | 'digest'>
  ) {
    return container.resolve(AppEnvLayerService).recordApplied(kind, ownerKey, layer);
  },
  layerOwnerKey,
  mergeLayerEnv,
  /**
   * Kill switch freeze for core mutation paths: deploy/switch, Compose apply/up/start, migration, link and binding
   * create, Pages activation on members of an isolated environment answer 409 APP_ISOLATED.
   */
  assertNotFrozen(target: FreezeTarget) {
    if (!container.isRegistered(AppMemberFreeze)) return Promise.resolve();
    return container.resolve(AppMemberFreeze).assertNotFrozen(target);
  },
  /** Whether a resource sits in an isolated environment (reconcilers skip it instead of throwing). */
  async isFrozen(target: FreezeTarget): Promise<boolean> {
    if (!container.isRegistered(AppMemberFreeze)) return false;
    return (await container.resolve(AppMemberFreeze).frozenEnvironment(target)) !== null;
  },
  /** `app` of one resource by its folder (detail responses). */
  appForFolder(family: AppFamily, folderId: string | null | undefined) {
    return container.resolve(AppMembershipService).refForFolder(family, folderId);
  },
};

export type AppsHostRuntime = typeof appsHostRuntime;
