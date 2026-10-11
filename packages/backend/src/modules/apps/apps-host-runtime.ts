import { and, eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleExecutor } from '@/db/client.js';
import { dockerContainerFolderAssignments } from '@/db/schema/index.js';
import {
  appliedLayerKeys,
  type ContainerLayerPlan,
  containerFolderId,
  layerRemovals,
  layerValues,
  planContainerLayer,
  recordContainerLayer,
} from './app-container-layer.js';
import {
  AppEnvLayerService,
  type EnvironmentLayer,
  emptyLayer,
  type LayerAppliedState,
  type LayerOwnerKind,
  layerOwnerKey,
  mergeLayerEnv,
} from './app-env-layer.js';
import { APP_FAMILY_TABLES, type AppFamily } from './app-families.js';
import { AppMemberFreeze, type FreezeTarget } from './app-member-freeze.js';
import {
  type AppListFilter,
  AppMembershipService,
  appMemberFolderCondition,
  parseAppListFilter,
} from './app-membership.js';
import {
  APP_FAMILY_NODE_TYPES,
  type AppEnvironmentPlacement,
  appPlacementForFolder,
  assertAppPlacement,
  assertPlacementNodesAllowed,
  filterNodesForAppFolder,
} from './app-placement-guard.js';

/** Apps are wired in the running Gateway (bootstrap); unit tests of the core run without them and see no apps. */
function wired(): boolean {
  return container.isRegistered(AppMembershipService);
}

function layerService(): AppEnvLayerService | null {
  return container.isRegistered(AppEnvLayerService) ? container.resolve(AppEnvLayerService) : null;
}

/** What a deployment deploy or a Compose apply receives from its environment layer (owner keyed by id). */
export interface WorkloadLayerPlan {
  kind: 'deployment' | 'compose';
  ownerKey: string;
  layer: EnvironmentLayer;
  previous: LayerAppliedState | null;
}

/** The Docker placement row of a container/deployment (by name) or a Compose project (by id) on its node. */
async function dockerFolderId(
  db: DrizzleExecutor,
  resourceType: 'container' | 'compose',
  nodeId: string,
  resourceKey: string
): Promise<string | null> {
  if (resourceType === 'container') return containerFolderId(db, nodeId, resourceKey);
  const [row] = await db
    .select({ folderId: dockerContainerFolderAssignments.folderId })
    .from(dockerContainerFolderAssignments)
    .where(
      and(
        eq(dockerContainerFolderAssignments.nodeId, nodeId),
        eq(dockerContainerFolderAssignments.resourceType, 'compose'),
        eq(dockerContainerFolderAssignments.resourceKey, resourceKey)
      )
    )
    .limit(1);
  return row?.folderId ?? null;
}

/**
 * What the commercial core needs from apps (attached as `apps` to the runtimes it receives): the node allowlist
 * guard for its create and placement paths, the `app` field and list filters for its resource lists, and the
 * environment layer for deployments, Compose, migration and Availability. Every helper is a no-op (no app, empty
 * layer) when apps are not wired.
 */
export const appsHostRuntime = {
  APP_FAMILY_NODE_TYPES,
  /** The environment a destination folder belongs to and the nodes it allows (null outside apps). */
  async appPlacementForFolder(
    db: DrizzleExecutor,
    family: AppFamily,
    folderId: string | null | undefined,
    nodeTypes?: readonly string[]
  ): Promise<AppEnvironmentPlacement | null> {
    if (!folderId || !wired()) return null;
    return appPlacementForFolder(db, family, folderId, nodeTypes);
  },
  /** The environment placement of a Docker workload where it sits now (container/deployment by name, Compose by id). */
  async appPlacementForDockerResource(
    db: DrizzleExecutor,
    resourceType: 'container' | 'compose',
    nodeId: string,
    resourceKey: string
  ): Promise<AppEnvironmentPlacement | null> {
    if (!wired()) return null;
    const folderId = await dockerFolderId(db, resourceType, nodeId, resourceKey);
    if (!folderId) return null;
    return appPlacementForFolder(db, resourceType === 'compose' ? 'compose' : 'containers', folderId);
  },
  /** Refuse a create or placement on nodes the destination environment does not allow (no-op outside apps). */
  async assertAppPlacement(
    db: DrizzleExecutor,
    family: AppFamily,
    folderId: string | null | undefined,
    nodeIds: readonly string[],
    nodeTypes?: readonly string[]
  ): Promise<void> {
    if (!folderId || !wired()) return;
    await assertAppPlacement(db, family, folderId, nodeIds, nodeTypes);
  },
  assertPlacementNodesAllowed,
  /** Node candidates narrowed to what an app environment folder allows (unchanged outside apps). */
  async filterNodesForAppFolder<T>(
    db: DrizzleExecutor,
    family: AppFamily,
    folderId: string | null | undefined,
    items: readonly T[],
    nodeIdOf: (item: T) => string
  ): Promise<T[]> {
    if (!folderId || !wired()) return [...items];
    return filterNodesForAppFolder(db, family, folderId, items, nodeIdOf);
  },
  parseAppListFilter,
  /**
   * SQL condition of a list filter on a resource table whose `folderColumn` points into the family's folder table:
   * `appId` keeps that app's members, `excludeAppMembers` drops every member (undefined: no filter). Apply it before
   * paging so pages and totals count only what the caller asked for.
   */
  appListCondition(family: AppFamily, folderColumn: unknown, filter: AppListFilter) {
    return appMemberFolderCondition(folderColumn, APP_FAMILY_TABLES[family].table, filter);
  },
  /** `app` ({id, slug, name, environmentId, environmentName, environmentSlug} | null) on each row of a list. */
  async annotateAppMembers<T extends Record<string, any>>(
    family: AppFamily,
    rows: T[],
    folderIdOf?: (row: T) => string | null | undefined
  ) {
    if (!wired()) return rows.map((row) => ({ ...row, app: null }));
    return container.resolve(AppMembershipService).annotate(family, rows, folderIdOf);
  },
  /** Annotate, then apply `excludeAppMembers` / `appId` (parse them from the query with parseAppListFilter). */
  async annotateAndFilterAppMembers<T extends Record<string, any>>(
    family: AppFamily,
    rows: T[],
    filter: AppListFilter,
    folderIdOf?: (row: T) => string | null | undefined
  ) {
    if (!wired()) return rows.map((row) => ({ ...row, app: null }));
    return container.resolve(AppMembershipService).annotateAndFilter(family, rows, filter, folderIdOf);
  },
  /** `app` of one resource by its folder (detail responses). */
  async appForFolder(family: AppFamily, folderId: string | null | undefined) {
    if (!folderId || !wired()) return null;
    return container.resolve(AppMembershipService).refForFolder(family, folderId);
  },
  /**
   * Environment layer for a workload placed in `folderId` (empty outside apps). Record what was applied after a
   * deploy/apply with recordAppliedLayer('deployment', id, layer) or ('compose', projectId, layer).
   */
  async resolveLayerForPlacement(family: AppFamily, folderId: string | null | undefined): Promise<EnvironmentLayer> {
    const service = layerService();
    if (!service || !folderId) return emptyLayer();
    return service.resolveLayerForPlacement(family, folderId);
  },
  async appliedLayerState(kind: LayerOwnerKind, ownerKey: string): Promise<LayerAppliedState | null> {
    return (await layerService()?.appliedState(kind, ownerKey)) ?? null;
  },
  async recordAppliedLayer(
    kind: LayerOwnerKind,
    ownerKey: string,
    layer: Pick<EnvironmentLayer, 'environmentId' | 'keys' | 'digest'>
  ): Promise<void> {
    await layerService()?.recordApplied(kind, ownerKey, layer);
  },
  /** A workload whose owner key changes (a container migrated to another node) keeps what it received. */
  async moveLayerOwner(kind: LayerOwnerKind, fromKey: string, toKey: string): Promise<void> {
    await layerService()?.renameOwner(kind, fromKey, toKey);
  },
  layerOwnerKey,
  mergeLayerEnv,
  /**
   * Kill switch freeze for core mutation paths: deploy/switch, Compose apply/up/start/down, link and binding create
   * and delete, binding moves, migration, deletes, database/storage/Pages settings, Pages activation and Availability
   * changes on members of an isolated environment answer 409 APP_ISOLATED (rules: AppMemberFreeze). A shutdown holds
   * nothing.
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
  /** Containers (standalone and Availability-managed): the same plan, merge and record as Gateway's own paths. */
  planContainerLayer,
  layerValues,
  layerRemovals,
  appliedLayerKeys,
  recordContainerLayer,
  /**
   * The layer of a deployment (placed by name like a container) or a Compose project (by id) where it sits now, or
   * in `folderId` when given. Null outside apps when it never received a layer (nothing to add or remove).
   */
  async planWorkloadLayer(
    db: DrizzleExecutor,
    kind: 'deployment' | 'compose',
    id: string,
    nodeId: string,
    resourceKey: string,
    folderId?: string | null
  ): Promise<WorkloadLayerPlan | null> {
    const service = layerService();
    if (!service) return null;
    const folder =
      folderId !== undefined
        ? folderId
        : await dockerFolderId(db, kind === 'compose' ? 'compose' : 'container', nodeId, resourceKey);
    const layer = folder
      ? await service.resolveLayerForPlacement(kind === 'compose' ? 'compose' : 'containers', folder)
      : emptyLayer();
    const previous = await service.appliedState(kind, id);
    if (!layer.environmentId && layer.keys.length === 0 && !previous) return null;
    return { kind, ownerKey: id, layer, previous };
  },
  async recordWorkloadLayer(plan: WorkloadLayerPlan | null): Promise<void> {
    const service = layerService();
    if (!service || !plan) return;
    await service.recordApplied(plan.kind, plan.ownerKey, plan.layer);
  },
};

export type AppsHostRuntime = typeof appsHostRuntime;
export type { AppEnvironmentPlacement, AppListFilter, ContainerLayerPlan, EnvironmentLayer };
