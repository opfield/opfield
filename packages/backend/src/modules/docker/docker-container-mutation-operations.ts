import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerTaskFollowUps,
  dockerSourceBindings,
  dockerWebhooks,
  managedDatabaseBindings,
  managedStorageBindings,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  appliedLayerKeys,
  type ContainerLayerPlan,
  copyContainerLayer,
  forgetContainerLayer,
  layerRemovals,
  layerValues,
  planContainerLayer,
  recordContainerLayer,
  renameContainerLayer,
} from '@/modules/apps/app-container-layer.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { DOCKER_STOP_TIMEOUT_MAX_SECONDS } from './docker.schemas.js';
import type { DockerAccessResourceService } from './docker-access-resource.service.js';
import { containerAnonymousVolumes, removeContainerAnonymousVolumes } from './docker-container-anonymous-volumes.js';
import { type ContainerOperationAnswer, waitForStopInFlight } from './docker-container-lifecycle-operations.js';
import { detachRemovedContainerSource } from './docker-container-source-detach.js';
import type { ContainerTransition, ContainerTransitionClaim } from './docker-container-transitions.js';
import { placeCreatedDockerResource } from './docker-creation-access.js';
import {
  type DockerEnvFollowUpGate,
  type DockerEnvFollowUpPayload,
  type DockerReplacementAhead,
  MASKED_ENV_VALUE,
  reconcileStoredEnvAfterImageChange,
  trackReplacementAhead,
} from './docker-env-follow-ups.js';
import { envListToMap, envMapToList, normalizeEnvRecord } from './docker-env-operations.js';
import { dockerGpuAttachmentFromInspect, hasRequestedGpuChange } from './docker-gpu-attachment.js';
import { isOpfieldManagedDockerNetwork } from './docker-internal-networks.js';
import type {
  ContainerAction,
  DockerTransitionOutcome,
  DockerTransitionTrackingHint,
} from './docker-lifecycle-watch.js';
import { labelString } from './docker-managed-labels.js';
import { assertManagedMountMutation } from './docker-managed-mounts.js';
import { noteNodeLoss, withNodeLossAnswer } from './docker-node-loss.js';
import { hasRequestedSpecificPortBindIp } from './docker-port-bindings.js';
import { assertContainerNotUsedByProxy } from './docker-proxy-link.guard.js';
import type { DockerRegistryAuthCandidate, DockerRegistryService } from './docker-registry.service.js';
import { assertDuplicateDropsReservedLabels, assertNoReservedDockerLabelChanges } from './docker-reserved-labels.js';
import {
  applyPersistedDockerRuntimeSettingsToConfig,
  type DockerRuntimeOperationContext,
  mergePersistedDockerRuntimeSettingsIntoConfig,
  persistDockerRuntimeSettings,
  validateDockerRuntimeResourceConfig,
} from './docker-runtime-operations.js';
import type { DockerRuntimeSettingsService } from './docker-runtime-settings.service.js';
import type { DockerSecretService } from './docker-secret.service.js';
import { assertDuplicateDropsLinkEnvironment } from './docker-secret-env.js';
import {
  assertDockerMountChangeAllowed,
  containerRecreateChangesWorkload,
  normalizeMountDefinitionsFromConfig,
  normalizeMountDefinitionsFromInspect,
} from './docker-socket-mount.guard.js';
import { type DockerTaskService, detachDockerTask, trackDockerTask } from './docker-task.service.js';
import { isLostTrackError } from './docker-task-reconciler.js';
import { resolveNetworkIdentity } from './docker-volume-network-operations.js';

const logger = createChildLogger('DockerContainerMutationOperations');

/**
 * Run once a mutation holds its names in this process, before it changes
 * anything: the names are leased across backend processes, and the migration
 * guard is checked again. The caller checked the guard before claiming; a
 * migration admitted in between has written its row by now (its admission is
 * refused while the container is claimed or leased), so it is refused here.
 * The caller gives its claim back when this throws.
 */
async function holdAcrossProcesses(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  names: readonly string[],
  identities: readonly string[],
  newName?: string
) {
  await ctx.acquireTransitionLeases(nodeId, names);
  await ctx.recheckMigrationGuard(nodeId, identities, newName);
}

/**
 * Run right before a mutation's final owner-only steps: the leases
 * `holdAcrossProcesses` took are renewed at once, so no other backend process
 * can take the names for a full lease TTL from here. A lease lost meanwhile
 * (it lapsed, and another process may be changing the container) refuses the
 * steps with 409 CONTAINER_BUSY (details.leaseLost).
 */
async function confirmHeldAcrossProcesses(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  names: readonly string[]
) {
  await ctx.acquireTransitionLeases(nodeId, names);
}

/**
 * A late owner-only step (a completion watcher's env write) runs only while
 * the mutation still holds the name across processes; otherwise it is
 * skipped and logged, and the container is left to its new owner.
 */
async function whileHeldAcrossProcesses(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  name: string,
  step: string,
  run: () => Promise<void>
) {
  try {
    await confirmHeldAcrossProcesses(ctx, nodeId, [name]);
  } catch (error) {
    logger.error(`Skipped ${step}: the container is no longer held by this operation`, {
      nodeId,
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await run();
}

export interface DockerContainerMutationContext {
  db: DrizzleClient;
  auditService: AuditService;
  nodeDispatch: NodeDispatchService;
  environmentService?: {
    replace(nodeId: string, containerName: string, env: Record<string, string>): Promise<unknown>;
    deleteImported(nodeId: string, containerName: string): Promise<unknown>;
    rename(nodeId: string, oldName: string, newName: string): Promise<unknown>;
    copy(nodeId: string, sourceName: string, targetName: string): Promise<unknown>;
    getDecryptedMap(nodeId: string, containerName: string): Promise<Record<string, string>>;
    /** Seals what an operation's follow-ups need (see trackReplacementAhead) like stored env. */
    sealFollowUpPayload(payload: DockerEnvFollowUpPayload): DockerTaskFollowUps['sealed'];
    openFollowUpPayload(sealed: DockerTaskFollowUps['sealed']): DockerEnvFollowUpPayload;
  };
  runtimeSettingsService?: DockerRuntimeSettingsService;
  secretService?: DockerSecretService;
  registryService?: DockerRegistryService;
  imageCleanupService?: {
    scheduleCleanupForContainer(nodeId: string, containerName: string, imageRef: string | undefined): Promise<unknown>;
  };
  folderService?: {
    deleteContainerAssignment(nodeId: string, containerName: string): Promise<unknown>;
    renameContainerAssignment(nodeId: string, oldName: string, newName: string): Promise<unknown>;
  };
  accessResourceService?: DockerAccessResourceService;
  taskService?: DockerTaskService;
  /**
   * Releases the managed database and storage links that target a container name: the container that held it is
   * gone, so they must never reach the next container of that name.
   */
  releaseContainerLinks?(nodeId: string, containerName: string, userId: string | null): Promise<void>;
  longDockerOperationTimeoutMs: number;
  validateDockerNode(nodeId: string): Promise<unknown>;
  assertDockerGpuCapability(nodeId: string): Promise<void>;
  assertDockerPortBindIpCapability(nodeId: string): Promise<void>;
  assertDockerRuntimeProfileAvailable(nodeId: string, profile: unknown, currentProfile?: unknown): Promise<void>;
  /**
   * `claim`: a transition on `name` held by this claim does not count as "in use". `sourceBindingId`: the name may
   * be the reservation of that Git source (its first activation creates the container).
   */
  assertNameAvailable(
    nodeId: string,
    name: string,
    claim?: ContainerTransitionClaim,
    options?: { sourceBindingId?: string }
  ): Promise<void>;
  assertNotManagedDeploymentInternal(nodeId: string, containerId: string): Promise<void>;
  translateNameConflict(err: unknown, name: string): never;
  resolveContainerName(nodeId: string, containerId: string): Promise<string>;
  resolveExpectedRecreateState(nodeId: string, containerId: string): Promise<'running' | 'created'>;
  resolveContainerStopTimeout(nodeId: string, containerId: string, timeout: number | undefined): Promise<number>;
  resolveStopTimeoutFromInspect(inspect: Record<string, any>, config?: Record<string, unknown>): number;
  lifecycleWatchTimeoutMs(stopTimeoutSeconds: number, bufferSeconds?: number): number;
  inspectContainer(nodeId: string, containerId: string): Promise<any>;
  runtimeOperationContext(): DockerRuntimeOperationContext;
  requireNoTransition(nodeId: string, name: string): void;
  /**
   * Resolves once `name` holds none of `states` in this process, or after `timeoutMs` with the one it still holds.
   */
  waitWhileTransition(
    nodeId: string,
    name: string,
    states: readonly ContainerTransition[],
    timeoutMs: number
  ): Promise<ContainerTransition | undefined>;
  setTransition(
    nodeId: string,
    name: string,
    state: 'creating' | 'stopping' | 'restarting' | 'killing' | 'updating' | 'recreating'
  ): void;
  clearTransition(nodeId: string, name: string): void;
  claimTransitions(
    nodeId: string,
    entries: ReadonlyArray<{ name: string; state: ContainerTransition }>
  ): ContainerTransitionClaim;
  releaseTransitions(claim: ContainerTransitionClaim): void;
  /**
   * Backs this process's transitions on the names with database leases, so
   * another backend process cannot rename or update them meanwhile: 409
   * CONTAINER_BUSY (details.name) when one holds a name. Released when the
   * name's transition ends here.
   */
  acquireTransitionLeases(
    nodeId: string,
    names: readonly string[],
    options?: { takeOverToken?: string }
  ): Promise<void>;
  /** The token of the lease this process holds the container with (kept with the task's follow-ups). */
  transitionLeaseToken?(nodeId: string, name: string): string | undefined;
  /** The migration guard, checked again once the mutation holds the container. */
  recheckMigrationGuard(nodeId: string, identities: readonly string[], newName?: string): Promise<void>;
  emitContainer(
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ): void;
  emitTransition(
    nodeId: string,
    name: string,
    id: string,
    transition: 'stopping' | 'restarting' | 'killing' | 'updating' | 'recreating' | null
  ): void;
  createTask(
    nodeId: string,
    containerId: string,
    containerName: string,
    type: string
  ): Promise<DockerTaskService extends never ? never : Awaited<ReturnType<DockerTaskService['create']>> | undefined>;
  failTask(taskId: string | undefined, error: string, nodeId?: string, containerName?: string): Promise<void>;
  watchTransition(
    nodeId: string,
    containerId: string,
    name: string,
    taskId: string | undefined,
    expectedState: string,
    progress: string,
    completedAction: ContainerAction,
    timeoutMs?: number,
    isComplete?: (inspectData: Record<string, any>) => boolean,
    trackingHint?: DockerTransitionTrackingHint
  ): Promise<DockerTransitionOutcome>;
  /**
   * Waits for the container named `containerName` to run under a runtime other than `oldContainerId`, which must be
   * the replaced container's runtime ID: a name would match the replaced container while it still runs.
   */
  watchRecreateByName(
    nodeId: string,
    containerName: string,
    oldContainerId: string,
    taskId: string | undefined,
    progress: string,
    expectedState: string,
    timeoutMs?: number,
    onComplete?: (newContainerId: string) => Promise<void>,
    daemonTaskId?: string,
    onDaemonTaskFailed?: () => Promise<void>
  ): void;
  parseResult(result: { success: boolean; error?: string; detail?: string }): any;
}

export function daemonContainerCreateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { volumes, networks, command, folderId: _folderId, ...daemonConfig } = config;
  const normalizedEnv = normalizeEnvRecord(config.env);
  const binds = Array.isArray(volumes)
    ? volumes.map((value) => {
        const mount = value as Record<string, unknown>;
        const source = typeof mount.hostPath === 'string' ? mount.hostPath : mount.name;
        const suffix = mount.readOnly === true ? ':ro' : '';
        return `${String(source)}:${String(mount.containerPath)}${suffix}`;
      })
    : undefined;
  const primaryNetwork = Array.isArray(networks) && typeof networks[0] === 'string' ? networks[0] : undefined;
  const legacyPortBindings = Array.isArray(config.ports)
    ? Object.fromEntries(
        config.ports.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const port = value as Record<string, unknown>;
          if (typeof port.containerPort !== 'number' || typeof port.hostPort !== 'number') return [];
          const protocol = port.protocol === 'udp' ? 'udp' : 'tcp';
          return [[`${port.containerPort}/${protocol}`, String(port.hostPort)]];
        })
      )
    : null;
  return {
    ...daemonConfig,
    ...(normalizedEnv ? { env: envMapToList(normalizedEnv) } : {}),
    ...(binds ? { binds } : {}),
    ...(Array.isArray(command) ? { cmd: command } : {}),
    ...(primaryNetwork ? { network_mode: primaryNetwork } : {}),
    ...(legacyPortBindings && Object.keys(legacyPortBindings).length > 0 ? { port_bindings: legacyPortBindings } : {}),
  };
}

async function renameManagedBindingTargets(
  db: DrizzleClient,
  nodeId: string,
  oldName: string,
  newName: string
): Promise<void> {
  if (oldName === newName) return;
  const updatedAt = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(managedDatabaseBindings)
      .set({ targetResourceId: newName, updatedAt })
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, nodeId),
          eq(managedDatabaseBindings.targetType, 'container'),
          eq(managedDatabaseBindings.targetResourceId, oldName)
        )
      );
    await tx
      .update(managedStorageBindings)
      .set({ targetResourceId: newName, updatedAt })
      .where(
        and(
          eq(managedStorageBindings.targetNodeId, nodeId),
          eq(managedStorageBindings.targetType, 'container'),
          eq(managedStorageBindings.targetResourceId, oldName)
        )
      );
  });
}

async function deleteContainerWebhooks(db: DrizzleClient, nodeId: string, containerName: string): Promise<void> {
  await db
    .delete(dockerWebhooks)
    .where(
      and(
        eq(dockerWebhooks.nodeId, nodeId),
        eq(dockerWebhooks.containerName, containerName),
        eq(dockerWebhooks.targetType, 'container')
      )
    );
}

async function renameContainerWebhooks(
  db: DrizzleClient,
  nodeId: string,
  oldName: string,
  newName: string
): Promise<void> {
  if (oldName === newName) return;
  await db
    .update(dockerWebhooks)
    .set({ containerName: newName, updatedAt: new Date() })
    .where(
      and(
        eq(dockerWebhooks.nodeId, nodeId),
        eq(dockerWebhooks.containerName, oldName),
        eq(dockerWebhooks.targetType, 'container')
      )
    );
}

/** Detach the Git source of a removed container; a failure never fails the removal that already happened. */
async function detachContainerSource(
  db: DrizzleClient,
  nodeId: string,
  containerName: string,
  userId: string
): Promise<void> {
  try {
    await detachRemovedContainerSource(db, nodeId, containerName, userId);
  } catch (error) {
    logger.warn('Failed to detach the Git source of a removed container', {
      nodeId,
      containerName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Release the links of a removed container; a failure never fails the removal that already happened. */
async function releaseRemovedContainerLinks(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerName: string,
  userId: string
): Promise<void> {
  try {
    await ctx.releaseContainerLinks?.(nodeId, containerName, userId);
  } catch (error) {
    // The links stay saved for the name; the next container that takes the name releases them before it exists.
    logger.error('Failed to release the managed links of a removed container', {
      nodeId,
      containerName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function renameContainerSourceBinding(
  db: DrizzleClient,
  nodeId: string,
  oldName: string,
  newName: string
): Promise<void> {
  if (oldName === newName) return;
  await db
    .update(dockerSourceBindings)
    .set({ containerName: newName, updatedAt: new Date() })
    .where(
      and(
        eq(dockerSourceBindings.targetKind, 'container'),
        eq(dockerSourceBindings.nodeId, nodeId),
        eq(dockerSourceBindings.containerName, oldName)
      )
    );
}

/**
 * Validate create-time networks with the same rules as the network connect
 * route: only existing, user-attachable networks. Shared namespaces
 * (`host`, `container:<id>`) and Opfield-managed networks are rejected.
 */
async function resolveCreateNetworks(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  requested: unknown
): Promise<Array<{ id: string; name: string }>> {
  if (!Array.isArray(requested)) return [];
  const names = requested.filter((value): value is string => typeof value === 'string').map((value) => value.trim());
  const networkContext = {
    db: ctx.db,
    nodeDispatch: ctx.nodeDispatch,
    auditService: ctx.auditService,
    parseResult: ctx.parseResult,
  };
  const resolved: Array<{ id: string; name: string }> = [];
  for (const name of names) {
    if (!name) continue;
    if (name === 'host' || name.includes(':')) {
      throw new AppError(400, 'NETWORK_MODE_NOT_ALLOWED', `Network mode "${name}" is not allowed for containers`);
    }
    if (name === 'default') {
      resolved.push({ id: name, name });
      continue;
    }
    const network = await resolveNetworkIdentity(networkContext, nodeId, name);
    if (isOpfieldManagedDockerNetwork(network.name)) {
      throw new AppError(409, 'MANAGED_NETWORK', 'Opfield-managed networks cannot be connected manually');
    }
    if (network.name === 'host') {
      throw new AppError(400, 'NETWORK_MODE_NOT_ALLOWED', 'Host networking is not allowed for containers');
    }
    resolved.push(network);
  }
  if (resolved.length > 1 && resolved.some((network) => network.name === 'none')) {
    throw new AppError(400, 'NETWORK_MODE_NOT_ALLOWED', 'The none network cannot be combined with other networks');
  }
  return resolved;
}

/**
 * Baseline for the persisted user env. Once Opfield stores an env it is the
 * source of truth and runtime-only values (image defaults) are not re-added.
 * A container without stored env starts from its runtime env, exactly as the
 * environment view seeds it, so nothing set outside Opfield is dropped.
 */
async function storedEnvBaseline(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  storedEnv: Record<string, string>,
  inspect?: Record<string, any>,
  /** Keys the container received from its app environment layer: never seeded as its own env. */
  layerKeys: readonly string[] = []
): Promise<Record<string, string>> {
  if (Object.keys(storedEnv).length > 0) return storedEnv;
  const runtime = inspect ?? (await ctx.inspectContainer(nodeId, containerId));
  const seeded = envListToMap(Array.isArray(runtime?.Config?.Env) ? runtime.Config.Env : []);
  for (const key of layerKeys) delete seeded[key];
  return seeded;
}

/** User-set environment that may be persisted: never secret keys or masked placeholders. */
function persistableUserEnv(env: Record<string, string>, secretKeys: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => !secretKeys.has(key) && value !== MASKED_ENV_VALUE)
  );
}

/** The full runtime ID of an inspected container (a request may name it by name or short ID). */
function containerRuntimeId(inspect: Record<string, any> | null | undefined, containerId: string): string {
  const id = inspect?.Id ?? inspect?.id;
  return typeof id === 'string' && id ? id : containerId;
}

function asyncDaemonTaskId(data: any, expectedType: string): string | undefined {
  const status = String(data?.status ?? '');
  return data?.type === expectedType && ['pending', 'running', 'succeeded', 'failed'].includes(status)
    ? String(data.id ?? '') || undefined
    : undefined;
}

/**
 * What tells an update's or recreate's end before it is dispatched under a command Opfield names: the daemon finds its
 * task by that command, so the task can be settled with the node also when its answer is lost. `timeoutMs` is the
 * longest its watch may wait (an asynchronous daemon task's).
 */
function replacementAhead(
  name: string,
  oldContainerId: string,
  expectedState: string,
  progress: string,
  timeoutMs: number
): DockerReplacementAhead {
  return {
    commandId: randomUUID(),
    tracking: {
      kind: 'replace',
      containerName: name,
      oldContainerId,
      expectedState,
      daemonTaskId: null,
      beforeAnswer: true,
      progress,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    },
  };
}

/**
 * The dispatch of an update or recreate tracked ahead lost its answer (the node's control stream dropped, or the
 * answer did not come in time): the node may still run it. Its task stays active, detached, and is settled with the
 * node, which also runs what it owes (DockerTaskReconciler); the env it saved stays until then. The container's
 * transition ends. Returns whether the task was left to the node.
 */
async function leaveToTheNode(
  ctx: DockerContainerMutationContext,
  ahead: DockerEnvFollowUpGate | undefined,
  taskId: string | undefined,
  error: unknown,
  nodeId: string,
  name: string
): Promise<boolean> {
  if (!ahead?.tracked || !taskId || !isLostTrackError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (!(await detachDockerTask(ctx.taskService, taskId, message))) return false;
  await ctx.failTask(undefined, message, nodeId, name);
  return true;
}

export async function createContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  config: Record<string, unknown>,
  userId: string,
  actorScopes: string[] = [],
  options: { sourceBindingId?: string } = {}
) {
  await assertNodeAllowsServiceCreation(ctx.db, nodeId, 'docker');
  await ctx.validateDockerNode(nodeId);
  if (hasRequestedGpuChange(config)) await ctx.assertDockerGpuCapability(nodeId);
  await ctx.assertDockerRuntimeProfileAvailable(nodeId, config.runtimeProfile);
  assertSecureRuntimeConfiguration(config);
  if (hasRequestedSpecificPortBindIp(config)) await ctx.assertDockerPortBindIpCapability(nodeId);
  assertDockerMountChangeAllowed({ nodeId, actorScopes, nextConfig: config, currentDefinitions: [] });
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: [],
    next: normalizeMountDefinitionsFromConfig(config),
  });
  const createNetworks = await resolveCreateNetworks(ctx, nodeId, config.networks);
  if (Array.isArray(config.networks)) config.networks = createNetworks.map((network) => network.name);
  const registryId = typeof config.registryId === 'string' ? config.registryId : null;
  delete config.registryId;
  const requestedName = (config.name as string | undefined)?.trim();
  const previousResourceId = requestedName
    ? await ctx.accessResourceService?.resolveContainer?.(nodeId, { name: requestedName, includeReservations: true })
    : null;
  if (requestedName) {
    await ctx.assertNameAvailable(nodeId, requestedName, undefined, { sourceBindingId: options.sourceBindingId });
    // The name is free, so links still saved for it belonged to a container that is gone. A Git source's first
    // activation keeps the links saved for its reserved name: they are this container's.
    if (!options.sourceBindingId) await ctx.releaseContainerLinks?.(nodeId, requestedName, userId);
    ctx.setTransition(nodeId, requestedName, 'creating');
  }
  // An app environment destination: its variables and secrets go to the daemon under the container's own env;
  // only the container's own env is stored.
  const layerPlan = await planContainerLayer(
    ctx.db,
    nodeId,
    requestedName ?? null,
    (config.folderId as string | null | undefined) ?? null
  );
  const daemonCreateSource = layerPlan
    ? { ...config, env: { ...layerValues(layerPlan), ...(normalizeEnvRecord(config.env) ?? {}) } }
    : config;
  let data: any;
  try {
    if (registryId) {
      await pullConfigImage(ctx, nodeId, config, registryId, actorScopes);
    }
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'create', {
      configJson: JSON.stringify(daemonContainerCreateConfig(daemonCreateSource)),
    });
    data = ctx.parseResult(result);
  } catch (err) {
    if (requestedName) ctx.clearTransition(nodeId, requestedName);
    ctx.translateNameConflict(err, requestedName || '');
  } finally {
    if (requestedName) ctx.clearTransition(nodeId, requestedName);
  }
  let createdName = (requestedName || data?.name || data?.Name || '') as string;
  const newId = (data?.Id ?? data?.id ?? '') as string;
  try {
    // Docker attaches only the primary network at create time.
    for (const network of createNetworks.slice(1)) {
      const connectResult = await ctx.nodeDispatch.sendDockerNetworkCommand(nodeId, 'connect', {
        networkId: network.id,
        containerId: newId || createdName,
      });
      ctx.parseResult(connectResult);
    }
    if (!createdName && newId) {
      const inspect = await ctx.inspectContainer(nodeId, newId);
      createdName = String(inspect?.Name ?? inspect?.name ?? '').replace(/^\//, '');
    }
    await ctx.auditService.log({
      action: 'docker.container.create',
      userId,
      resourceType: 'docker-container',
      resourceId: newId,
      details: { nodeId, name: createdName, image: config.image },
    });
    if (createdName && newId) {
      const resourceId = await ctx.accessResourceService?.ensureContainer(
        nodeId,
        createdName,
        newId,
        false,
        undefined,
        {
          adoptReservation: !!options.sourceBindingId,
        }
      );
      if (resourceId && resourceId !== previousResourceId)
        await grantCreatedResourcePermissions(userId, 'docker:containers', `${nodeId}/${resourceId}`, {
          folderId: (config.folderId as string | null | undefined) ?? null,
          nodeId,
        });
      await placeCreatedDockerResource(
        ctx.db,
        nodeId,
        'container',
        createdName,
        config.folderId as string | null | undefined
      );
      await recordContainerLayer(layerPlan, nodeId, createdName);
    }
    if (createdName && ctx.environmentService) {
      const env = normalizeEnvRecord(config.env);
      if (env) {
        await ctx.environmentService.replace(nodeId, createdName, env);
      }
    }
    if (typeof config.image === 'string') {
      await ctx.registryService?.rememberImageRegistry?.(nodeId, config.image, registryId);
    }
  } catch (error) {
    try {
      await rollbackCreatedContainer(
        ctx,
        nodeId,
        newId || createdName || requestedName || '',
        createdName || requestedName
      );
    } catch (rollbackError) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${primaryMessage} (container rollback failed: ${rollbackMessage})`);
    }
    throw error;
  }
  if (requestedName && newId) {
    ctx.emitContainer(nodeId, requestedName, newId, 'created');
  }
  return data && typeof data === 'object' ? { ...data, id: newId, name: createdName } : data;
}

export async function rollbackCreatedContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  knownName?: string,
  userId?: string
) {
  if (!containerId) throw new Error('Created Docker container identity is unavailable for rollback');
  let name = knownName?.replace(/^\//, '') ?? '';
  if (!name) {
    try {
      name = await ctx.resolveContainerName(nodeId, containerId);
    } catch {
      name = '';
    }
  }
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'remove', {
    containerId,
    force: true,
  });
  ctx.parseResult(result);
  if (name) {
    await Promise.allSettled([
      ctx.environmentService?.deleteImported(nodeId, name),
      ctx.runtimeSettingsService?.delete(nodeId, name),
      ctx.secretService?.deleteImported(nodeId, name),
      ctx.folderService?.deleteContainerAssignment(nodeId, name),
      ctx.accessResourceService?.removeContainer(nodeId, name),
    ]);
  }
  if (userId) {
    await ctx.auditService
      .log({
        action: 'docker.container.create.rollback',
        userId,
        resourceType: 'docker-container',
        resourceId: containerId,
        details: { nodeId, name },
      })
      .catch(() => undefined);
  }
  if (name) ctx.emitContainer(nodeId, name, containerId, 'removed');
  return { id: containerId, name };
}

/**
 * Removes a stopped container. A removal right after a stop waits for the stop to end instead of refusing a
 * container that is stopping. A stop that outlasts the request's wait is followed by a `remove` task: the removal
 * runs once the stop ended, and the answer is pending with that task. `afterRemove` runs once the container is
 * removed, either way.
 */
export async function removeContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  force: boolean,
  userId: string,
  afterRemove?: () => Promise<void>
): Promise<ContainerOperationAnswer> {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  await assertContainerNotUsedByProxy(ctx.db, nodeId, name);
  const stopping = await waitForStopInFlight(ctx, nodeId, name);
  if (stopping) {
    const task = await ctx.createTask(nodeId, containerId, name, 'remove');
    // Opfield runs this removal itself: after an Opfield restart its task is settled by whether the container is gone.
    await trackDockerTask(ctx.taskService, task?.id, { kind: 'remove', containerId });
    void removeWhenStopped(ctx, nodeId, containerId, name, force, userId, task?.id, afterRemove);
    return { taskId: task?.id, containerId, name, pending: stopping };
  }
  await removeStoppedContainer(ctx, nodeId, containerId, name, force, userId);
  await afterRemove?.();
  return { taskId: undefined, containerId, name };
}

/** The removal a stop outlasted: it runs once the stop ended, and its task records the outcome. */
async function removeWhenStopped(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  name: string,
  force: boolean,
  userId: string,
  taskId: string | undefined,
  afterRemove?: () => Promise<void>
) {
  try {
    // The stop's own watch ends it within its timeout; this bound only guards against a transition left behind.
    await waitForStopInFlight(ctx, nodeId, name, ctx.lifecycleWatchTimeoutMs(DOCKER_STOP_TIMEOUT_MAX_SECONDS));
    // A Route may have been pointed at the container meanwhile.
    await assertContainerNotUsedByProxy(ctx.db, nodeId, name);
    await removeStoppedContainer(ctx, nodeId, containerId, name, force, userId);
    await afterRemove?.();
    if (taskId) {
      await ctx.taskService
        ?.update(taskId, { status: 'succeeded', progress: 'Container removed', completedAt: new Date() })
        .catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to remove container';
    logger.warn('Could not remove a container after its stop', { nodeId, name, error: message });
    if (taskId) {
      await ctx.taskService
        ?.update(taskId, { status: 'failed', error: message, completedAt: new Date() })
        .catch(() => undefined);
    }
  }
}

async function removeStoppedContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  name: string,
  force: boolean,
  userId: string
) {
  ctx.requireNoTransition(nodeId, name);
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  const state = String(inspect?.State?.Status ?? inspect?.state ?? inspect?.State ?? '').toLowerCase();
  const isActive =
    inspect?.State?.Running === true ||
    inspect?.State?.Paused === true ||
    inspect?.State?.Restarting === true ||
    ['running', 'paused', 'restarting'].includes(state);
  if (isActive) {
    throw new AppError(
      409,
      'CONTAINER_RUNNING',
      'Stop the container before removing it. Active containers cannot be removed from Opfield.'
    );
  }
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'remove', { containerId, force });
  ctx.parseResult(result);
  // Docker keeps a removed container's anonymous volumes (image VOLUME declarations); named volumes stay.
  await removeContainerAnonymousVolumes(ctx, nodeId, containerAnonymousVolumes(inspect));
  await ctx.auditService.log({
    action: 'docker.container.remove',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name, force },
  });
  const [, , , , accessResult] = await Promise.all([
    ctx.environmentService?.deleteImported(nodeId, name),
    ctx.runtimeSettingsService?.delete(nodeId, name),
    ctx.secretService?.deleteImported(nodeId, name),
    ctx.folderService?.deleteContainerAssignment(nodeId, name),
    ctx.accessResourceService?.removeContainer(nodeId, name),
    // A later container with the same name must not inherit the webhook token.
    deleteContainerWebhooks(ctx.db, nodeId, name),
    // Nor may it inherit the Git source (and its auto-build polling).
    detachContainerSource(ctx.db, nodeId, name, userId),
    // Nor what it received from its app environment layer.
    forgetContainerLayer(nodeId, name),
  ]);
  // Nor its managed database and storage links (network, credentials). After the secrets above: the link secrets
  // are gone with the container's.
  await releaseRemovedContainerLinks(ctx, nodeId, name, userId);
  const removedScopeResourceId = accessResult;
  ctx.emitContainer(nodeId, name, containerId, 'removed', {
    ...(removedScopeResourceId ? { scopeResourceId: removedScopeResourceId } : {}),
  });
}

export async function renameContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  newName: string,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const oldName = await ctx.resolveContainerName(nodeId, containerId);
  ctx.requireNoTransition(nodeId, oldName);
  // Claim both names before the next await: a second rename to the same name
  // would otherwise pass the checks too and pre-clean records the first one
  // has already moved, and nothing else may act on the old name meanwhile.
  let claim: ContainerTransitionClaim;
  try {
    claim = ctx.claimTransitions(nodeId, [
      { name: oldName, state: 'updating' },
      { name: newName, state: 'creating' },
    ]);
  } catch (error) {
    // The old name was idle a moment ago, so the new name is the busy one.
    if (error instanceof AppError && error.code === 'CONTAINER_BUSY') {
      throw new AppError(409, 'NAME_IN_USE', `A container named "${newName}" is currently being modified on this node`);
    }
    throw error;
  }
  try {
    try {
      await holdAcrossProcesses(ctx, nodeId, [oldName, newName], [oldName, containerId], newName);
    } catch (error) {
      // Another backend process is creating or renaming a container to the new name.
      const busyName = error instanceof AppError ? (error.details as { name?: unknown } | undefined)?.name : undefined;
      if (error instanceof AppError && error.code === 'CONTAINER_BUSY' && busyName === newName) {
        throw new AppError(
          409,
          'NAME_IN_USE',
          `A container named "${newName}" is currently being modified on this node`
        );
      }
      throw error;
    }
    // Everything that can refuse the rename is checked before anything changes.
    await ctx.accessResourceService?.assertContainerRenameAllowed?.(nodeId, oldName, newName);
    await ctx.assertNameAvailable(nodeId, newName, claim);
    // A rename keeps the runtime ID: the rollback addresses the container by it, since the old name (which the
    // request may have used) no longer exists once the daemon renamed it.
    const runtimeId = containerRuntimeId(await ctx.inspectContainer(nodeId, containerId), containerId);
    // The checks above wait on the node: the names must still be this
    // rename's across processes before it changes anything.
    await confirmHeldAcrossProcesses(ctx, nodeId, [oldName, newName]);
    // The runtime name is available, so any name-keyed records left behind by a
    // previously deleted container are stale and must not block reuse.
    await Promise.all([
      ctx.environmentService?.deleteImported(nodeId, newName),
      ctx.runtimeSettingsService?.delete(nodeId, newName),
      ctx.secretService?.deleteImported(nodeId, newName),
      ctx.folderService?.deleteContainerAssignment(nodeId, newName),
      ctx.accessResourceService?.removeContainer(nodeId, newName),
      deleteContainerWebhooks(ctx.db, nodeId, newName),
    ]);
    await ctx.releaseContainerLinks?.(nodeId, newName, userId);

    try {
      const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'rename', {
        containerId: runtimeId,
        newName,
      });
      ctx.parseResult(result);
    } catch (err) {
      ctx.translateNameConflict(err, newName);
    }

    const metadataRollbacks: Array<() => Promise<unknown>> = [];
    try {
      // The access identity first: it moves the Git source binding with it in one transaction and checks the
      // source again under its lock, so a build that started meanwhile refuses the rename before the rest moves.
      if (ctx.accessResourceService) {
        await ctx.accessResourceService.renameContainer(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.accessResourceService!.renameContainer(nodeId, newName, oldName));
      } else {
        await renameContainerSourceBinding(ctx.db, nodeId, oldName, newName);
        metadataRollbacks.unshift(() => renameContainerSourceBinding(ctx.db, nodeId, newName, oldName));
      }
      if (ctx.environmentService) {
        await ctx.environmentService.rename(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.environmentService!.rename(nodeId, newName, oldName));
      }
      await renameContainerLayer(nodeId, oldName, newName);
      metadataRollbacks.unshift(() => renameContainerLayer(nodeId, newName, oldName));
      if (ctx.runtimeSettingsService) {
        await ctx.runtimeSettingsService.rename(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.runtimeSettingsService!.rename(nodeId, newName, oldName));
      }
      if (ctx.secretService) {
        await ctx.secretService.rename(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.secretService!.rename(nodeId, newName, oldName));
      }
      if (ctx.folderService) {
        await ctx.folderService.renameContainerAssignment(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.folderService!.renameContainerAssignment(nodeId, newName, oldName));
      }
      await renameManagedBindingTargets(ctx.db, nodeId, oldName, newName);
      metadataRollbacks.unshift(() => renameManagedBindingTargets(ctx.db, nodeId, newName, oldName));
      await renameContainerWebhooks(ctx.db, nodeId, oldName, newName);
      metadataRollbacks.unshift(() => renameContainerWebhooks(ctx.db, nodeId, newName, oldName));
    } catch (metadataError) {
      try {
        const rollbackResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'rename', {
          containerId: runtimeId,
          newName: oldName,
        });
        ctx.parseResult(rollbackResult);
        const failures: unknown[] = [];
        for (const rollback of metadataRollbacks) {
          try {
            await rollback();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')
          );
        }
      } catch (rollbackError) {
        const primaryMessage = metadataError instanceof Error ? metadataError.message : String(metadataError);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${primaryMessage} (rename rollback failed: ${rollbackMessage})`);
      }
      throw metadataError;
    }

    await ctx.auditService.log({
      action: 'docker.container.rename',
      userId,
      resourceType: 'docker-container',
      resourceId: containerId,
      details: { nodeId, oldName, name: newName, containerName: newName },
    });
    ctx.emitContainer(nodeId, newName, runtimeId, 'renamed', { oldName });
  } finally {
    ctx.releaseTransitions(claim);
  }
}

export async function duplicateContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  name: string,
  userId: string,
  actorScopes: string[] = [],
  folderId?: string | null
) {
  await assertNodeAllowsServiceCreation(ctx.db, nodeId, 'docker');
  const node = (await ctx.validateDockerNode(nodeId)) as { capabilities?: unknown } | undefined;
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const sourceName = await ctx.resolveContainerName(nodeId, containerId);
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  assertDuplicateDropsReservedLabels(inspect?.Config?.Labels ?? inspect?.Labels, node?.capabilities);
  const linkEnvKeys = (await ctx.secretService?.getManagedSecretKeys(nodeId, sourceName)) ?? [];
  assertDuplicateDropsLinkEnvironment(linkEnvKeys, node?.capabilities);
  assertDockerMountChangeAllowed({
    nodeId,
    resourceId: String(inspect?.scopeResourceId ?? ''),
    actorScopes,
    currentDefinitions: [],
    nextDefinitions: normalizeMountDefinitionsFromInspect(inspect),
  });
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: [],
    next: normalizeMountDefinitionsFromInspect(inspect),
  });
  ctx.requireNoTransition(nodeId, sourceName);
  await ctx.assertNameAvailable(nodeId, name);
  // The copy takes a free name: links still saved for it belonged to a container that is gone.
  await ctx.releaseContainerLinks?.(nodeId, name, userId);
  ctx.setTransition(nodeId, name, 'creating');
  let data: any;
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'duplicate', {
      containerId,
      newName: name,
      // The copy is not linked: the daemon leaves the link variables out of its environment.
      ...(linkEnvKeys.length > 0 ? { configJson: JSON.stringify({ removeEnv: linkEnvKeys }) } : {}),
    });
    data = ctx.parseResult(result);
  } catch (err) {
    ctx.clearTransition(nodeId, name);
    ctx.translateNameConflict(err, name);
  }
  let newId = String(data?.Id ?? data?.id ?? '');
  if (!newId) {
    try {
      const duplicateInspect = await ctx.inspectContainer(nodeId, name);
      newId = String(duplicateInspect?.Id ?? duplicateInspect?.id ?? '');
    } catch {
      newId = '';
    }
  }
  if (!newId) {
    await ctx.nodeDispatch
      .sendDockerContainerCommand(nodeId, 'remove', { containerId: name, force: true })
      .then((result) => ctx.parseResult(result))
      .catch(() => undefined);
    ctx.clearTransition(nodeId, name);
    throw new Error('Docker daemon did not return the duplicated container ID');
  }

  try {
    const resourceId = await ctx.accessResourceService?.ensureContainer(nodeId, name, newId, false);
    if (resourceId)
      await grantCreatedResourcePermissions(userId, 'docker:containers', `${nodeId}/${resourceId}`, {
        folderId: folderId ?? null,
        nodeId,
      });
    await placeCreatedDockerResource(ctx.db, nodeId, 'container', name, folderId);
    await ctx.environmentService?.copy(nodeId, sourceName, name);
    await ctx.runtimeSettingsService?.copy(nodeId, sourceName, name);
    await ctx.secretService?.copySecrets(nodeId, sourceName, name, userId);
    // The copy runs the source's env: it received the source's environment layer.
    await copyContainerLayer(nodeId, sourceName, name);
    await ctx.auditService.log({
      action: 'docker.container.duplicate',
      userId,
      resourceType: 'docker-container',
      resourceId: newId,
      details: { nodeId, sourceId: containerId, sourceName, name, containerName: name },
    });
  } catch (error) {
    await ctx.nodeDispatch
      .sendDockerContainerCommand(nodeId, 'remove', { containerId: newId, force: true })
      .then((result) => ctx.parseResult(result))
      .catch(() => undefined);
    await ctx.environmentService?.deleteImported(nodeId, name).catch(() => undefined);
    await ctx.runtimeSettingsService?.delete(nodeId, name).catch(() => undefined);
    await ctx.secretService?.deleteImported(nodeId, name).catch(() => undefined);
    await ctx.accessResourceService?.removeContainer(nodeId, name).catch(() => undefined);
    ctx.clearTransition(nodeId, name);
    throw error;
  }

  ctx.clearTransition(nodeId, name);
  ctx.emitContainer(nodeId, name, newId, 'duplicated', { sourceName });
  return data && typeof data === 'object' ? { ...data, id: newId, name } : { id: newId, name };
}

/**
 * POST .../update and the AI update. The node lost before the update was sent (its control stream dropped while
 * Opfield read the container) answers 503 NODE_UNAVAILABLE and records a failed task: nothing was changed. A lost
 * answer once it was sent answers 504 NODE_ANSWER_LOST with the task that is settled with the node (see
 * nodeLossHttpError).
 */
export async function updateContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>,
  userId: string,
  actorScopes: string[] = []
) {
  return withNodeLossAnswer(
    'update',
    () => updateContainerOnNode(ctx, nodeId, containerId, config, userId, actorScopes),
    (message) => recordNodeLostTask(ctx, nodeId, containerId, 'update', message)
  );
}

/** A failed task for an operation the node was lost before it was sent; its ID. */
export async function recordNodeLostTask(
  ctx: Pick<DockerContainerMutationContext, 'taskService'>,
  nodeId: string,
  containerId: string,
  type: string,
  message: string
): Promise<string | undefined> {
  const task = await ctx.taskService?.create({ nodeId, containerId, type });
  if (!task) return undefined;
  await ctx.taskService?.update(task.id, { status: 'failed', error: message, completedAt: new Date() });
  return task.id;
}

async function updateContainerOnNode(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>,
  userId: string,
  actorScopes: string[]
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  assertDockerMountChangeAllowed({
    nodeId,
    resourceId: String(inspect?.scopeResourceId ?? ''),
    actorScopes,
    nextConfig: config,
    currentInspect: inspect,
    useCurrentWhenNextMissing: true,
  });
  const currentMounts = normalizeMountDefinitionsFromInspect(inspect);
  const nextMounts =
    Object.hasOwn(config, 'mounts') || Object.hasOwn(config, 'volumes')
      ? normalizeMountDefinitionsFromConfig(config)
      : currentMounts;
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: currentMounts,
    next: nextMounts,
  });
  const expectedState = await ctx.resolveExpectedRecreateState(nodeId, containerId);
  const requestedEnv = normalizeEnvRecord(config.env);
  const requestedRemovals = Array.isArray(config.removeEnv) ? config.removeEnv.map(String) : undefined;
  const hasEnvChange = requestedEnv !== undefined || requestedRemovals !== undefined;
  const storedEnv = ctx.environmentService ? await ctx.environmentService.getDecryptedMap(nodeId, name) : {};
  const secrets = ctx.secretService ? await ctx.secretService.getDecryptedMap(nodeId, name) : {};
  const secretKeys = new Set(Object.keys(secrets));
  const layerPlan = await planContainerLayer(ctx.db, nodeId, name);
  const envBaseline = hasEnvChange
    ? await storedEnvBaseline(ctx, nodeId, containerId, storedEnv, inspect, appliedLayerKeys(layerPlan))
    : storedEnv;
  const desiredUserEnv = persistableUserEnv({ ...envBaseline, ...(requestedEnv ?? {}) }, secretKeys);
  for (const key of requestedRemovals ?? []) delete desiredUserEnv[key];
  // App environment layer under the container's own env and secrets.
  const daemonEnv = { ...layerValues(layerPlan), ...desiredUserEnv, ...secrets };
  if (Object.keys(daemonEnv).length > 0) config.env = daemonEnv;
  else delete config.env;
  // Never allow removing a secret key via removeEnv.
  if (requestedRemovals) config.removeEnv = requestedRemovals.filter((key) => !secretKeys.has(key));
  const layerRemoved = layerRemovals(layerPlan, [...Object.keys(desiredUserEnv), ...secretKeys]);
  if (layerRemoved.length > 0) {
    config.removeEnv = [...((config.removeEnv as string[] | undefined) ?? []), ...layerRemoved];
  }
  config = await applyPersistedDockerRuntimeSettingsToConfig(ctx.runtimeOperationContext(), nodeId, name, config);
  const hasImageChange = typeof config.tag === 'string' && config.tag.length > 0;
  if (hasImageChange) {
    // The daemon pulls the new tag itself with the registry credentials it holds.
    await ctx.registryService?.syncRegistriesToNode?.(nodeId);
  }
  const previousRuntimeEnv = envListToMap(Array.isArray(inspect?.Config?.Env) ? inspect.Config.Env : []);
  const updateStopTimeout = ctx.resolveStopTimeoutFromInspect(inspect as Record<string, any>, config);
  const updateTimeoutMs = hasImageChange
    ? ctx.longDockerOperationTimeoutMs
    : Math.max(120000, ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60));
  ctx.requireNoTransition(nodeId, name);
  ctx.setTransition(nodeId, name, 'updating');
  try {
    await holdAcrossProcesses(ctx, nodeId, [name], [name, containerId]);
  } catch (error) {
    ctx.clearTransition(nodeId, name);
    throw error;
  }
  ctx.emitTransition(nodeId, name, containerId, 'updating');
  // The task records the runtime it replaces: the replacement keeps the container's access identity from it.
  const task = await ctx.createTask(nodeId, containerRuntimeId(inspect, containerId), name, 'update');
  try {
    await confirmHeldAcrossProcesses(ctx, nodeId, [name]);
  } catch (error) {
    await ctx.failTask(task?.id, error instanceof Error ? error.message : 'Failed to update container', nodeId, name);
    throw error;
  }
  // Written ahead, so a lost answer (even before the daemon answered) leaves the task to be settled with the node,
  // follow-ups included; the watch below runs them otherwise.
  const ahead = replacementAhead(
    name,
    containerRuntimeId(inspect, containerId),
    expectedState,
    'Container updated',
    Math.max(ctx.longDockerOperationTimeoutMs + 30000, updateTimeoutMs)
  );
  const followUps = await trackReplacementAhead(ctx, task?.id, name, ahead, {
    leaseToken: ctx.transitionLeaseToken?.(nodeId, name),
    expectedEnv: hasEnvChange ? desiredUserEnv : storedEnv,
    ...(hasImageChange ? { previousRuntimeEnv } : {}),
    ...(hasEnvChange ? { restoreEnv: storedEnv } : {}),
  });
  let data: any;
  try {
    // Persist the user-set env with the mutation itself, not from the in-memory
    // completion watcher, so a backend restart cannot lose it.
    if (hasEnvChange) await ctx.environmentService?.replace(nodeId, name, desiredUserEnv);
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(
      nodeId,
      'update',
      { containerId, configJson: JSON.stringify(config) },
      updateTimeoutMs,
      ahead.commandId
    );
    data = ctx.parseResult(result);
    const daemonTaskId = asyncDaemonTaskId(data, 'update');
    const newRuntimeId = daemonTaskId ? '' : String(data?.Id ?? data?.id ?? '');
    if (newRuntimeId) {
      await ctx.accessResourceService?.preserveContainerRuntimeId(nodeId, name, newRuntimeId);
    }
    await recordContainerLayer(layerPlan, nodeId, name);
  } catch (err) {
    if (await leaveToTheNode(ctx, followUps, task?.id, err, nodeId, name)) {
      throw noteNodeLoss(err, { kind: 'answer-lost', taskId: task?.id });
    }
    if (hasEnvChange) await ctx.environmentService?.replace(nodeId, name, storedEnv).catch(() => undefined);
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to update container', nodeId, name);
    throw noteNodeLoss(err, { kind: 'failed', taskId: task?.id });
  }
  const daemonTaskId = asyncDaemonTaskId(data, 'update');
  ctx.watchRecreateByName(
    nodeId,
    name,
    // The replacement is told apart from the replaced runtime by its ID, also when the request named it.
    containerRuntimeId(inspect, containerId),
    task?.id,
    'Container updated',
    expectedState,
    daemonTaskId ? ctx.longDockerOperationTimeoutMs + 30000 : updateTimeoutMs,
    hasImageChange
      ? (newContainerId) =>
          whileHeldAcrossProcesses(
            ctx,
            nodeId,
            name,
            'the stored env reconciliation after an image update',
            async () => {
              if (await followUps.take()) {
                await reconcileStoredEnvAfterImageChange(ctx, nodeId, name, previousRuntimeEnv, newContainerId);
              }
            }
          ).catch((error) => {
            logger.warn('Failed to reconcile stored env after image update', { nodeId, name, error });
          })
      : undefined,
    daemonTaskId,
    // The env was saved before dispatch; a failed async update did not apply it.
    hasEnvChange
      ? () =>
          whileHeldAcrossProcesses(ctx, nodeId, name, 'restoring the stored env after a failed update', async () => {
            if (await followUps.take()) await ctx.environmentService?.replace(nodeId, name, storedEnv);
          })
      : undefined
  );
  await ctx.auditService.log({
    action: 'docker.container.update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  if (hasImageChange) {
    const labels = (inspect?.Config?.Labels ?? {}) as Record<string, string>;
    const imageRef = imageRefWithTag(
      labelString(labels, 'archive.image.reference') || inspect?.Config?.Image || inspect?.Image,
      config.tag as string
    );
    ctx.imageCleanupService?.scheduleCleanupForContainer(nodeId, name, imageRef).catch(() => {});
  }
  return data && typeof data === 'object'
    ? { ...data, taskId: task?.id, containerId, name }
    : { taskId: task?.id, containerId, name };
}

export async function liveUpdateContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  ctx.requireNoTransition(nodeId, name);
  await validateDockerRuntimeResourceConfig(ctx.runtimeOperationContext(), nodeId, containerId, config);
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'live_update', {
    containerId,
    configJson: JSON.stringify(config),
  });
  ctx.parseResult(result);
  await persistDockerRuntimeSettings(ctx.runtimeOperationContext(), nodeId, name, config);
  await ctx.auditService.log({
    action: 'docker.container.live_update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
}

export async function recreateWithConfig(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>,
  userId: string | null,
  options?: {
    skipImagePull?: boolean;
    skipWebhookCleanup?: boolean;
    actorScopes?: string[];
    backgroundImagePull?: boolean;
    expectedState?: 'running' | 'created';
    onComplete?: (newContainerId: string) => Promise<void>;
  }
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  if (hasRequestedGpuChange(config)) await ctx.assertDockerGpuCapability(nodeId);
  if (hasRequestedSpecificPortBindIp(config)) await ctx.assertDockerPortBindIpCapability(nodeId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const expectedState = options?.expectedState ?? (await ctx.resolveExpectedRecreateState(nodeId, containerId));
  ctx.requireNoTransition(nodeId, name);
  // Judged on the request itself: the persisted runtime settings merged below are what the container runs.
  const workloadChanged = containerRecreateChangesWorkload(config);
  // Merge persisted runtime settings without saving the request yet: it is
  // persisted only after validation below succeeds.
  config = await mergePersistedDockerRuntimeSettingsIntoConfig(ctx.runtimeOperationContext(), nodeId, name, config);
  const normalizedEnv = normalizeEnvRecord(config.env);
  if (normalizedEnv) {
    config.env = normalizedEnv;
  } else {
    delete config.env;
  }
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  // Labels are replaced wholesale: Compose and Opfield labels may only come back unchanged, or the
  // recreated container would leave its folder (Compose re-homing) or hide from its users.
  assertNoReservedDockerLabelChanges(
    config.labels as Record<string, string> | undefined,
    (inspect?.Config?.Labels ?? {}) as Record<string, unknown>
  );
  const requestedImage = typeof config.image === 'string' ? config.image.trim() : '';
  const hasRequestedImage = !!requestedImage;
  const currentRuntimeProfile = inspect?.HostConfig?.Runtime === 'runsc' ? 'secure' : 'default';
  await ctx.assertDockerRuntimeProfileAvailable(nodeId, config.runtimeProfile, currentRuntimeProfile);
  assertSecureRuntimeConfiguration(config, inspect);
  if (hasRequestedGpuChange(config) && dockerGpuAttachmentFromInspect(inspect).mode === 'external') {
    throw new AppError(
      409,
      'GPU_ATTACHMENT_UNMANAGED',
      'This container has an unsupported GPU mapping. Opfield will preserve it but cannot replace it.'
    );
  }
  const recreateStopTimeout = ctx.resolveStopTimeoutFromInspect(inspect as Record<string, any>, config);
  assertDockerMountChangeAllowed({
    nodeId,
    resourceId: String(inspect?.scopeResourceId ?? ''),
    actorScopes: options?.actorScopes ?? [],
    nextConfig: config,
    currentInspect: inspect,
    useCurrentWhenNextMissing: true,
    workloadChanged,
  });
  const currentMounts = normalizeMountDefinitionsFromInspect(inspect);
  const nextMounts =
    Object.hasOwn(config, 'mounts') || Object.hasOwn(config, 'volumes')
      ? normalizeMountDefinitionsFromConfig(config)
      : currentMounts;
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: currentMounts,
    next: nextMounts,
  });
  await validateDockerRuntimeResourceConfig(ctx.runtimeOperationContext(), nodeId, containerId, config);
  // Check and claim with no await in between: another mutation (or a build
  // rollout) admitted during validation must not recreate concurrently, and
  // must not have its runtime settings replaced by this request.
  ctx.requireNoTransition(nodeId, name);
  ctx.setTransition(nodeId, name, 'recreating');
  try {
    await holdAcrossProcesses(ctx, nodeId, [name], [name, containerId]);
    await persistDockerRuntimeSettings(ctx.runtimeOperationContext(), nodeId, name, config);
  } catch (error) {
    ctx.clearTransition(nodeId, name);
    throw error;
  }
  const previousRuntimeEnv = envListToMap(Array.isArray(inspect?.Config?.Env) ? inspect.Config.Env : []);
  ctx.emitTransition(nodeId, name, containerId, 'recreating');
  // The task records the runtime it replaces: the replacement keeps the container's access identity from it.
  const task = await ctx.createTask(nodeId, containerRuntimeId(inspect, containerId), name, 'recreate');

  const executeRecreate = async () => {
    // The stored env the recreate finds; it does not change it.
    let storedEnv: Record<string, string> = {};
    let layerPlan: ContainerLayerPlan | null = null;
    let followUps: DockerEnvFollowUpGate | undefined;
    try {
      // Inject decrypted values in the task so image-changing requests can return immediately.
      if (ctx.environmentService) {
        storedEnv = await ctx.environmentService.getDecryptedMap(nodeId, name);
        const userEnv = persistableUserEnv(storedEnv, new Set());
        if (Object.keys(userEnv).length > 0) {
          const existingEnv = normalizeEnvRecord(config.env) || {};
          config.env = { ...userEnv, ...existingEnv };
        }
      }
      if (ctx.secretService) {
        const secrets = await ctx.secretService.getDecryptedMap(nodeId, name);
        if (Object.keys(secrets).length > 0) {
          const existingEnv = normalizeEnvRecord(config.env) || {};
          config.env = { ...existingEnv, ...secrets };
        }
      }
      // App environment layer under the container's own env and secrets; keys that left the layer are removed.
      layerPlan = await planContainerLayer(ctx.db, nodeId, name);
      if (layerPlan) {
        const ownEnv = normalizeEnvRecord(config.env) || {};
        config.env = { ...layerValues(layerPlan), ...ownEnv };
        const removed = layerRemovals(layerPlan, Object.keys(ownEnv));
        if (removed.length > 0) {
          config.removeEnv = [...(Array.isArray(config.removeEnv) ? config.removeEnv.map(String) : []), ...removed];
        }
      }
      if (task?.id && ctx.taskService) {
        await ctx.taskService
          .update(task.id, {
            status: 'running',
            progress: hasRequestedImage ? 'Pulling image' : 'Recreating container',
          })
          .catch(() => {});
      }
      if (!options?.skipImagePull) {
        await pullConfigImage(ctx, nodeId, config, undefined, options?.actorScopes ?? []);
      }

      if (task?.id && ctx.taskService && hasRequestedImage) {
        await ctx.taskService.update(task.id, { status: 'running', progress: 'Recreating container' }).catch(() => {});
      }

      // Written ahead, so a lost answer (even before the daemon answered) leaves the task to be settled with the node,
      // its follow-up included; the watch below runs it otherwise.
      const ahead = replacementAhead(
        name,
        containerRuntimeId(inspect, containerId),
        expectedState,
        'Container recreated',
        Math.max(ctx.longDockerOperationTimeoutMs + 30000, ctx.lifecycleWatchTimeoutMs(recreateStopTimeout, 60))
      );
      followUps = await trackReplacementAhead(ctx, task?.id, name, ahead, {
        leaseToken: ctx.transitionLeaseToken?.(nodeId, name),
        expectedEnv: storedEnv,
        ...(hasRequestedImage ? { previousRuntimeEnv } : {}),
      });
      const gate = followUps;
      const result = await ctx.nodeDispatch.sendDockerContainerCommand(
        nodeId,
        'recreate',
        { containerId, configJson: JSON.stringify({ ...config, expectedState }) },
        Math.max(120000, ctx.lifecycleWatchTimeoutMs(recreateStopTimeout, 60)),
        ahead.commandId
      );
      const data = ctx.parseResult(result);
      const daemonTaskId = asyncDaemonTaskId(data, 'recreate');
      const newRuntimeId = daemonTaskId ? '' : String(data?.Id ?? data?.id ?? '');
      if (newRuntimeId) {
        await ctx.accessResourceService?.preserveContainerRuntimeId(nodeId, name, newRuntimeId);
      }
      await recordContainerLayer(layerPlan, nodeId, name);
      await ctx.auditService.log({
        action: 'docker.container.recreate',
        userId,
        resourceType: 'docker-container',
        resourceId: containerId,
        details: { nodeId, name, containerName: name },
      });
      if (!options?.skipWebhookCleanup && typeof config.image === 'string') {
        ctx.imageCleanupService?.scheduleCleanupForContainer(nodeId, name, config.image).catch(() => {});
      }

      ctx.watchRecreateByName(
        nodeId,
        name,
        // The replacement is told apart from the replaced runtime by its ID, also when the request named it.
        containerRuntimeId(inspect, containerId),
        task?.id,
        'Container recreated',
        expectedState,
        daemonTaskId ? ctx.longDockerOperationTimeoutMs + 30000 : ctx.lifecycleWatchTimeoutMs(recreateStopTimeout, 60),
        hasRequestedImage
          ? async (newContainerId) => {
              await gate
                .take()
                .then((mayRun) =>
                  mayRun
                    ? reconcileStoredEnvAfterImageChange(ctx, nodeId, name, previousRuntimeEnv, newContainerId)
                    : undefined
                )
                .catch((error) =>
                  logger.warn('Failed to reconcile stored env after image change', { nodeId, name, error })
                );
              await options?.onComplete?.(newContainerId);
            }
          : options?.onComplete,
        daemonTaskId
      );
      return data && typeof data === 'object'
        ? { ...data, taskId: task?.id, containerId, name }
        : { taskId: task?.id, containerId, name };
    } catch (err) {
      // The error keeps its message (internal rollouts match on it); API callers answer it with nodeLossHttpError.
      if (await leaveToTheNode(ctx, followUps, task?.id, err, nodeId, name)) {
        throw noteNodeLoss(err, { kind: 'answer-lost', taskId: task?.id });
      }
      ctx.clearTransition(nodeId, name);
      if (task && ctx.taskService) {
        await ctx.taskService
          .update(task.id, {
            status: 'failed',
            error: err instanceof Error ? err.message : 'Unknown error',
            completedAt: new Date(),
          })
          .catch(() => {});
      }
      throw noteNodeLoss(err, { kind: 'failed', taskId: task?.id });
    }
  };

  if (options?.backgroundImagePull && hasRequestedImage && !options.skipImagePull) {
    void executeRecreate().catch((error) => {
      logger.error('Background image recreate failed', { nodeId, containerId, name, error });
    });
    return {
      accepted: true,
      status: 'pending',
      taskId: task?.id,
      containerId,
      name,
      image: requestedImage,
    };
  }

  return executeRecreate();
}

/**
 * Secure Runtime rules for a create, or for a recreate of `inspect`. A recreate that does not name a runtime profile
 * keeps the container's runtime, so a Secure Runtime container is held to the rules with its new configuration.
 */
function assertSecureRuntimeConfiguration(config: Record<string, unknown>, inspect?: Record<string, any>) {
  const runtimeProfile = config.runtimeProfile ?? (inspect?.HostConfig?.Runtime === 'runsc' ? 'secure' : undefined);
  if (runtimeProfile !== 'secure') return;
  const requestedNetworks = Array.isArray(config.networks) ? config.networks : undefined;
  const networkMode =
    requestedNetworks !== undefined
      ? requestedNetworks.find((network): network is string => typeof network === 'string')
      : inspect?.HostConfig?.NetworkMode;
  if (networkMode === 'host' || String(networkMode ?? '').startsWith('container:')) {
    throw new AppError(
      409,
      'SECURE_RUNTIME_NETWORK_NAMESPACE_UNSUPPORTED',
      'Secure Runtime requires an isolated Docker network namespace'
    );
  }
  const gpu = config.gpu as { deviceIds?: unknown[] } | undefined;
  const hasRequestedGpu = Array.isArray(gpu?.deviceIds) && gpu.deviceIds.length > 0;
  const preservesGpu = gpu === undefined && inspect ? dockerGpuAttachmentFromInspect(inspect).mode !== 'none' : false;
  if (hasRequestedGpu || preservesGpu) {
    throw new AppError(409, 'SECURE_RUNTIME_GPU_UNSUPPORTED', 'Remove GPU attachments before selecting Secure Runtime');
  }
  const mounts = Array.isArray(config.mounts)
    ? config.mounts
    : Array.isArray(config.volumes)
      ? config.volumes
      : undefined;
  const hasRequestedBind = mounts?.some(
    (mount) =>
      !!mount && typeof mount === 'object' && !Array.isArray(mount) && typeof (mount as any).hostPath === 'string'
  );
  const preservesBind =
    mounts === undefined &&
    !!inspect &&
    (Array.isArray(inspect?.Mounts)
      ? inspect.Mounts.some((mount: any) => String(mount?.Type ?? mount?.type).toLowerCase() === 'bind')
      : Array.isArray(inspect?.HostConfig?.Binds) &&
        inspect.HostConfig.Binds.some((bind: unknown) => String(bind).split(':', 1)[0]?.startsWith('/')));
  if (hasRequestedBind || preservesBind) {
    throw new AppError(
      409,
      'SECURE_RUNTIME_BIND_UNSUPPORTED',
      'Remove host bind mounts before selecting Secure Runtime'
    );
  }
}

async function pullConfigImage(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  config: Record<string, unknown>,
  registryId?: string,
  actorScopes: string[] = []
) {
  const imageRef = typeof config.image === 'string' ? config.image.trim() : '';
  if (!imageRef) return;

  const authCandidates =
    (await ctx.registryService?.resolveAuthCandidatesForImagePull(nodeId, imageRef, registryId, {
      actorScopes,
    })) ?? [];
  const pullCandidates: Array<DockerRegistryAuthCandidate | null> = authCandidates.length ? authCandidates : [null];
  let lastError: unknown;

  for (const auth of pullCandidates) {
    let finalImageRef = imageRef;
    if (auth && !hasRegistryHost(imageRef)) {
      finalImageRef = `${auth.url}/${imageRef}`;
    }

    try {
      const result = await ctx.nodeDispatch.sendDockerImageCommand(
        nodeId,
        'pull',
        { imageRef: finalImageRef, registryAuthJson: auth?.authJson },
        ctx.longDockerOperationTimeoutMs
      );
      ctx.parseResult(result);
      config.image = finalImageRef;
      await ctx.registryService?.rememberImageRegistry?.(nodeId, finalImageRef, auth?.registryId);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new AppError(502, 'DISPATCH_ERROR', `Failed to pull ${imageRef}`);
}

function hasRegistryHost(imageRef: string) {
  const firstSegment = imageRef.split('/')[0] ?? '';
  return firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':');
}

/** The image reference with another tag; a digest is dropped. Undefined without an image or a tag. */
export function imageRefWithTag(imageRef: string | undefined, tag: string) {
  const trimmedTag = tag.trim();
  if (!imageRef || !trimmedTag) return undefined;
  const digestIndex = imageRef.indexOf('@');
  const withoutDigest = digestIndex >= 0 ? imageRef.slice(0, digestIndex) : imageRef;
  const lastColon = withoutDigest.lastIndexOf(':');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const imageName = lastColon >= 0 && lastSlash < lastColon ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return `${imageName}:${trimmedTag}`;
}

export async function updateContainerEnv(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  env: Record<string, string> | undefined,
  removeEnv: string[] | undefined,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const expectedState = await ctx.resolveExpectedRecreateState(nodeId, containerId);
  const updateStopTimeout = await ctx.resolveContainerStopTimeout(nodeId, containerId, undefined);
  ctx.requireNoTransition(nodeId, name);
  const runtimeInspect = await ctx.inspectContainer(nodeId, containerId);

  // Persist only user-set env on top of the stored baseline. The runtime env
  // also carries image defaults and masked secret placeholders; the daemon
  // keeps runtime entries that are not overridden, so they are not re-sent.
  const storedEnv = ctx.environmentService ? await ctx.environmentService.getDecryptedMap(nodeId, name) : {};
  const secrets = ctx.secretService ? await ctx.secretService.getDecryptedMap(nodeId, name) : {};
  const secretKeys = new Set(Object.keys(secrets));
  const layerPlan = await planContainerLayer(ctx.db, nodeId, name);
  const envBaseline = await storedEnvBaseline(
    ctx,
    nodeId,
    containerId,
    storedEnv,
    runtimeInspect,
    appliedLayerKeys(layerPlan)
  );
  const desiredUserEnv = persistableUserEnv({ ...envBaseline, ...(env ?? {}) }, secretKeys);
  for (const key of removeEnv ?? []) delete desiredUserEnv[key];
  // Merge decrypted secrets so secrets persist across the recreate; the app environment layer goes under both.
  const mergedEnv = { ...layerValues(layerPlan), ...desiredUserEnv, ...secrets };
  // Never allow removing a secret key via removeEnv.
  if (removeEnv) removeEnv = removeEnv.filter((key) => !secretKeys.has(key));
  const layerRemoved = layerRemovals(layerPlan, [...Object.keys(desiredUserEnv), ...secretKeys]);
  if (layerRemoved.length > 0) removeEnv = [...(removeEnv ?? []), ...layerRemoved];

  // Re-check right before claiming: the stored env read above must not be
  // overwritten by a recreate that started meanwhile.
  ctx.requireNoTransition(nodeId, name);
  ctx.setTransition(nodeId, name, 'updating');
  try {
    await holdAcrossProcesses(ctx, nodeId, [name], [name, containerId]);
  } catch (error) {
    ctx.clearTransition(nodeId, name);
    throw error;
  }
  ctx.emitTransition(nodeId, name, containerId, 'updating');
  // The task records the runtime it replaces: the replacement keeps the container's access identity from it.
  const task = await ctx.createTask(nodeId, containerRuntimeId(runtimeInspect, containerId), name, 'update');
  // Written ahead, so a lost answer (even before the daemon answered) leaves the task to be settled with the node,
  // its follow-up included; the watch below runs it otherwise.
  const ahead = replacementAhead(
    name,
    containerRuntimeId(runtimeInspect, containerId),
    expectedState,
    'Container env updated',
    Math.max(ctx.longDockerOperationTimeoutMs + 30000, ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60))
  );
  const followUps = await trackReplacementAhead(ctx, task?.id, name, ahead, {
    leaseToken: ctx.transitionLeaseToken?.(nodeId, name),
    expectedEnv: desiredUserEnv,
    restoreEnv: storedEnv,
  });
  let data: any;
  try {
    // Persist with the mutation itself; a completion watcher is lost on restart.
    await ctx.environmentService?.replace(nodeId, name, desiredUserEnv);
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(
      nodeId,
      'update',
      { containerId, configJson: JSON.stringify({ env: mergedEnv, removeEnv, expectedState }) },
      Math.max(60000, ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60)),
      ahead.commandId
    );
    data = ctx.parseResult(result);
    await recordContainerLayer(layerPlan, nodeId, name);
  } catch (err) {
    // The error keeps its message (the core matches on it); API callers answer it with nodeLossHttpError.
    if (await leaveToTheNode(ctx, followUps, task?.id, err, nodeId, name)) {
      throw noteNodeLoss(err, { kind: 'answer-lost', taskId: task?.id });
    }
    await ctx.environmentService?.replace(nodeId, name, storedEnv).catch(() => undefined);
    ctx.clearTransition(nodeId, name);
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
          completedAt: new Date(),
        })
        .catch(() => {});
    }
    throw noteNodeLoss(err, { kind: 'failed', taskId: task?.id });
  }
  const daemonTaskId = asyncDaemonTaskId(data, 'update');
  ctx.watchRecreateByName(
    nodeId,
    name,
    // The replacement is told apart from the replaced runtime by its ID, also when the request named it.
    containerRuntimeId(runtimeInspect, containerId),
    task?.id,
    'Container env updated',
    expectedState,
    daemonTaskId ? ctx.longDockerOperationTimeoutMs + 30000 : ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60),
    undefined,
    daemonTaskId,
    // The env was saved before dispatch; a failed async update did not apply it.
    async () => {
      if (await followUps.take()) await ctx.environmentService?.replace(nodeId, name, storedEnv);
    }
  );
  await ctx.auditService.log({
    action: 'docker.container.env.update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });

  return data && typeof data === 'object'
    ? { ...data, taskId: task?.id, containerId, name }
    : { taskId: task?.id, containerId, name };
}
