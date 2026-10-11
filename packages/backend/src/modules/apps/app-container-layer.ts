import { and, eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleExecutor } from '@/db/client.js';
import { dockerContainerFolderAssignments } from '@/db/schema/index.js';
import {
  AppEnvLayerService,
  type EnvironmentLayer,
  emptyLayer,
  type LayerAppliedState,
  layerOwnerKey,
} from './app-env-layer.js';

/** What a container create, update or recreate applies from its environment layer. */
export interface ContainerLayerPlan {
  /** `<nodeId>:<name>`; null when the name is only known after the create. */
  ownerKey: string | null;
  layer: EnvironmentLayer;
  previous: LayerAppliedState | null;
}

function layerService(): AppEnvLayerService | null {
  return container.isRegistered(AppEnvLayerService) ? container.resolve(AppEnvLayerService) : null;
}

/** The folder a container (or deployment, by name) sits in on its node. */
export async function containerFolderId(db: DrizzleExecutor, nodeId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ folderId: dockerContainerFolderAssignments.folderId })
    .from(dockerContainerFolderAssignments)
    .where(
      and(
        eq(dockerContainerFolderAssignments.nodeId, nodeId),
        eq(dockerContainerFolderAssignments.resourceType, 'container'),
        eq(dockerContainerFolderAssignments.resourceKey, name)
      )
    )
    .limit(1);
  return row?.folderId ?? null;
}

/**
 * The layer of a container: from `folderId` when given (a create names its destination), else from where the
 * container sits now. Null outside apps when the container never received a layer (nothing to add or remove).
 */
export async function planContainerLayer(
  db: DrizzleExecutor,
  nodeId: string,
  name: string | null | undefined,
  folderId?: string | null
): Promise<ContainerLayerPlan | null> {
  const service = layerService();
  if (!service) return null;
  const folder = folderId !== undefined ? folderId : name ? await containerFolderId(db, nodeId, name) : null;
  const layer = folder ? await service.resolveLayerForPlacement('containers', folder) : emptyLayer();
  const ownerKey = name ? layerOwnerKey('container', name, nodeId) : null;
  const previous = ownerKey ? await service.appliedState('container', ownerKey) : null;
  if (!layer.environmentId && layer.keys.length === 0 && !previous) return null;
  return { ownerKey, layer, previous };
}

/** Layer values, lowest precedence: spread the workload's own env and secrets after them. */
export function layerValues(plan: ContainerLayerPlan | null): Record<string, string> {
  return plan ? { ...plan.layer.vars, ...plan.layer.secrets } : {};
}

/**
 * Keys a previous apply set that left the layer and that the workload does not set itself: they are removed from the
 * runtime env (the daemon keeps runtime entries that are not overridden).
 */
export function layerRemovals(plan: ContainerLayerPlan | null, ownKeys: Iterable<string>): string[] {
  if (!plan?.previous) return [];
  const own = new Set(ownKeys);
  return plan.previous.appliedKeys.filter((key) => !plan.layer.keys.includes(key) && !own.has(key));
}

/** Keys the container received from a layer: never stored as its own env when env is seeded from the runtime. */
export function appliedLayerKeys(plan: ContainerLayerPlan | null): string[] {
  return plan?.previous?.appliedKeys ?? [];
}

export async function recordContainerLayer(
  plan: ContainerLayerPlan | null,
  nodeId: string,
  name?: string | null
): Promise<void> {
  const service = layerService();
  if (!service || !plan) return;
  const ownerKey = plan.ownerKey ?? (name ? layerOwnerKey('container', name, nodeId) : null);
  if (!ownerKey) return;
  await service.recordApplied('container', ownerKey, plan.layer);
}

/** A renamed container keeps its layer record; a removed one drops it. */
export async function renameContainerLayer(nodeId: string, fromName: string, toName: string): Promise<void> {
  await layerService()?.renameOwner(
    'container',
    layerOwnerKey('container', fromName, nodeId),
    layerOwnerKey('container', toName, nodeId)
  );
}

export async function forgetContainerLayer(nodeId: string, name: string): Promise<void> {
  await layerService()?.forgetOwner('container', layerOwnerKey('container', name, nodeId));
}

/** A duplicate runs the source's env, so it received what the source received. */
export async function copyContainerLayer(nodeId: string, fromName: string, toName: string): Promise<void> {
  const service = layerService();
  if (!service) return;
  const previous = await service.appliedState('container', layerOwnerKey('container', fromName, nodeId));
  if (!previous) return;
  await service.recordApplied('container', layerOwnerKey('container', toName, nodeId), {
    environmentId: previous.environmentId,
    keys: previous.appliedKeys,
    digest: previous.appliedDigest,
  });
}

/** What the environment view shows as inherited: variables with values, secret keys only. */
export async function inheritedContainerLayer(db: DrizzleExecutor, nodeId: string, name: string) {
  const plan = await planContainerLayer(db, nodeId, name);
  if (!plan?.layer.environmentId) return null;
  return {
    environmentId: plan.layer.environmentId,
    variables: Object.entries(plan.layer.vars).map(([key, value]) => ({ key, value })),
    secretKeys: Object.keys(plan.layer.secrets),
    pending: plan.previous?.appliedDigest !== plan.layer.digest,
  };
}
