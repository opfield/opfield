import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { OperationLeaseStore } from '@/db/operation-lease.js';
import {
  type DockerTaskTracking,
  dockerDeployments,
  dockerManagedVolumes,
  managedDatabaseBindings,
  managedDatabaseInstances,
  nodes,
} from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { DockerWorkloadResolverService } from './availability/docker-workload-resolver.service.js';
import type { DockerRuntimeStatus } from './docker.schemas.js';
import {
  CONTAINER_LIFECYCLE_TIMEOUT_BUFFER_SECONDS,
  DEFAULT_CONTAINER_STOP_TIMEOUT_SECONDS,
  type DockerGpuAttachmentUser,
  GPU_USAGE_INSPECTION_BATCH_SIZE,
  logger,
} from './docker.service.shared.js';
import {
  assertContainerNameNotReserved,
  type DockerAccessResourceService,
  hasDockerResourceScope,
} from './docker-access-resource.service.js';
import type { DockerBuildRolloutGuard, DockerBuildRolloutTarget } from './docker-build-rollout-guard.js';
import {
  killContainer as killDockerContainer,
  restartContainer as restartDockerContainer,
  startContainer as startDockerContainer,
  stopContainer as stopDockerContainer,
} from './docker-container-lifecycle-operations.js';
import {
  createContainer as createDockerContainer,
  type DockerContainerMutationContext,
  duplicateContainer as duplicateDockerContainer,
  imageRefWithTag,
  liveUpdateContainer as liveUpdateDockerContainer,
  recordNodeLostTask as recordDockerNodeLostTask,
  recreateWithConfig as recreateDockerContainerWithConfig,
  removeContainer as removeDockerContainerMutation,
  renameContainer as renameDockerContainer,
  rollbackCreatedContainer as rollbackDockerCreatedContainer,
  updateContainer as updateDockerContainer,
  updateContainerEnv as updateDockerContainerEnv,
} from './docker-container-mutation-operations.js';
import {
  type ContainerTransition,
  type ContainerTransitionClaim,
  DockerContainerTransitions,
} from './docker-container-transitions.js';
import { assertDockerCreationAccess, placeCreatedDockerResource } from './docker-creation-access.js';
import { dockerDaemonUserError } from './docker-daemon-errors.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
import { dockerDeploymentIdLabel, isDockerDeploymentManaged } from './docker-deployment-labels.js';
import { runKeptEnvFollowUps } from './docker-env-follow-ups.js';
import { getContainerEnv as getDockerContainerEnv } from './docker-env-operations.js';
import type { DockerEnvironmentService } from './docker-environment.service.js';
import type { DockerFolderService } from './docker-folder.service.js';
import { deriveDockerGpuAttachment, hasDockerGpuV1Capability } from './docker-gpu-attachment.js';
import type { DockerHealthCheckService } from './docker-health-check.service.js';
import type { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import {
  listAllImages as listAllDockerImages,
  listImages as listDockerImages,
  pruneImages as pruneDockerImages,
  pullImage as pullDockerImage,
  removeImage as removeDockerImage,
} from './docker-image-operations.js';
import { buildImagePrunePreview, type DockerImagePrunePreview } from './docker-image-prune-preview.js';
import { selectDanglingImages } from './docker-image-retention.js';
import {
  assertUserContainerAccessible,
  filterOpfieldInternalContainers,
  inspectUserContainer as inspectUserSelectedContainer,
  isOpfieldInternalContainer,
} from './docker-internal-containers.js';
import {
  dockerImageId,
  findOpfieldInternalImage,
  resolveDockerImageByIdentifier,
  resolvePulledDockerImage,
} from './docker-internal-images.js';
import {
  type ContainerAction,
  type DockerLifecycleWatchContext,
  type DockerTransitionOutcome,
  type DockerTransitionTrackingHint,
  watchDockerRecreateByName,
  watchDockerTransition,
} from './docker-lifecycle-watch.js';
import { assertManagedMountMutation } from './docker-managed-mounts.js';
import { isDockerManagedVolumeLabelled } from './docker-managed-volume.constants.js';
import type { DockerMigrationGuard } from './docker-migration-guard.js';
import type { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';
import { hasDockerPortBindIpV1Capability } from './docker-port-bindings.js';
import {
  abortFileUpload as abortDockerFileUpload,
  appendFileUploadChunk as appendDockerFileUploadChunk,
  completeFileUpload as completeDockerFileUpload,
  createDirectory as createDockerDirectory,
  createFile as createDockerFile,
  deleteFile as deleteDockerFile,
  getContainerLogs as getDockerContainerLogs,
  getContainerStats as getDockerContainerStats,
  getContainerTop as getDockerContainerTop,
  initFileUpload as initDockerFileUpload,
  listDirectory as listDockerDirectory,
  moveFile as moveDockerFile,
  readFile as readDockerFile,
  writeFile as writeDockerFile,
} from './docker-read-operations.js';
import { dockerDispatchErrorMessage } from './docker-recreate-watch.js';
import type { DockerRegistryService } from './docker-registry.service.js';
import { collectDockerRolloutDiagnostics, DOCKER_ROLLOUT_RESPONSE_LIMIT } from './docker-rollout-diagnostics.js';
import { applyRuntimeSettingsToInspect } from './docker-runtime-inspect.js';
import type { DockerRuntimeOperationContext } from './docker-runtime-operations.js';
import type { DockerRuntimeSettingsService } from './docker-runtime-settings.service.js';
import type { DockerSecretService } from './docker-secret.service.js';
import { type DockerSecretEnvOwner, dockerSecretEnvMatcher, dockerSecretEnvOwners } from './docker-secret-env.js';
import { assertDockerMountChangeAllowed, normalizeMountDefinitionsFromConfig } from './docker-socket-mount.guard.js';
import { assertNotPendingSourceContainer, readPendingDockerSourceContainers } from './docker-source.service.js';
import type { DockerTaskService } from './docker-task.service.js';
import type { DockerTaskReconcileContext } from './docker-task-reconciler.js';
import {
  abortVolumeFileUpload as abortDockerVolumeFileUpload,
  adoptVolume as adoptDockerVolume,
  appendVolumeFileUploadChunk as appendDockerVolumeFileUploadChunk,
  assertUserVolumeVisible as assertDockerUserVolumeVisible,
  completeVolumeFileUpload as completeDockerVolumeFileUpload,
  connectContainerToNetwork as connectDockerContainerToNetwork,
  createNetwork as createDockerNetwork,
  createVolume as createDockerVolume,
  createVolumeDirectory as createDockerVolumeDirectory,
  createVolumeFile as createDockerVolumeFile,
  deleteVolumeFile as deleteDockerVolumeFile,
  disconnectContainerFromNetwork as disconnectDockerContainerFromNetwork,
  exportVolume as exportDockerVolume,
  initVolumeFileUpload as initDockerVolumeFileUpload,
  inspectVolume as inspectDockerVolume,
  listAllVolumes as listAllDockerVolumes,
  listNetworks as listDockerNetworks,
  listVolumeFiles as listDockerVolumeFiles,
  listVolumes as listDockerVolumes,
  moveVolumeFile as moveDockerVolumeFile,
  opfieldManagedVolumeNames,
  readVolumeFile as readDockerVolumeFile,
  removeNetwork as removeDockerNetwork,
  removeVolume as removeDockerVolume,
  removeOrphanedAnonymousVolume as removeOrphanedAnonymousDockerVolume,
  renameVolume as renameDockerVolume,
  updateVolumeLabels as updateDockerVolumeLabels,
  writeVolumeFile as writeDockerVolumeFile,
} from './docker-volume-network-operations.js';

export * from './docker.service.shared.js';

/**
 * Why Secure Runtime cannot run a container on a node, from the node's runtime status. The status message describes
 * the node ("This node can install and verify Secure Runtime"), so it is framed as the refusal it is.
 */
function secureRuntimeUnavailableMessage(status: { state?: unknown; message?: unknown } | undefined): string {
  const detail = typeof status?.message === 'string' && status.message ? status.message.replace(/\.$/, '') : '';
  switch (status?.state) {
    case 'installable':
      return "Secure Runtime is not installed on this node. Run Secure Runtime Setup in the node's Details, or choose another node.";
    case 'installing':
      return 'Secure Runtime is still being installed on this node. Try again when Setup finishes.';
    case 'unsupported':
      return `Secure Runtime cannot run on this node${detail ? `: ${detail}` : ''}. Choose another node.`;
    default:
      return `Secure Runtime is not healthy on this node${detail ? `: ${detail}` : ''}. Complete Setup in Node Details first.`;
  }
}

const AVAILABILITY_NETWORKS_MANAGED =
  'This container is controlled by Availability: its replicas run on Opfield-managed networks on every node. Disable Availability to change its networks.';

/** The app kill switch freeze as Docker container mutations see it (AppMemberFreeze). */
export interface DockerAppFreezeGuard {
  anyIsolationOpen(): Promise<boolean>;
  /** 409 APP_ISOLATED for every change of a member of an isolated environment, delete and rename included. */
  assertContainer(nodeId: string, name: string): Promise<void>;
  assertMayStart(nodeId: string, name: string): Promise<void>;
  /** 409 APP_ISOLATED for a network a container isolated by the kill switch is reconnected to on release. */
  assertNetworkNotHeld(nodeId: string, network: { id: string; name: string }): Promise<void>;
}

/** The node answers the size of every volume at once (volume command `sizes`). */
export const DOCKER_VOLUME_SIZES_CAPABILITY = 'docker_volume_sizes_v1';
/** Measuring walks every volume on the node. */
const VOLUME_SIZES_TIMEOUT_MS = 5 * 60_000;

export class DockerManagementService {
  private static readonly LONG_DOCKER_OPERATION_TIMEOUT_MS = 600000; // 10 minutes

  /**
   * `${nodeId}:${containerName}` → current transition state.
   * Keyed by name (not ID) so the badge survives recreate/update, which
   * destroy the old container and create a new one with a different ID.
   */
  private containerTransitions = new DockerContainerTransitions();

  private taskService?: DockerTaskService;
  private environmentService?: DockerEnvironmentService;
  private runtimeSettingsService?: DockerRuntimeSettingsService;
  private secretService?: DockerSecretService;
  private folderService?: DockerFolderService;
  private deploymentService?: DockerDeploymentService;
  private healthCheckService?: DockerHealthCheckService;
  private registryService?: DockerRegistryService;
  private imageCleanupService?: DockerImageCleanupService;
  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  private migrationGuard?: DockerMigrationGuard;
  private appFreeze?: DockerAppFreezeGuard;
  private buildRolloutGuard?: DockerBuildRolloutGuard;
  private accessResourceService?: DockerAccessResourceService;
  private networkAccessResourceService?: DockerNetworkAccessResourceService;
  private containerRecreateCompletedHandler?: (nodeId: string, newContainerId: string) => Promise<void>;
  private managedLinkReleaseHandler?: (nodeId: string, containerName: string, userId: string | null) => Promise<void>;
  private availabilityMutationGuard?: (nodeId: string, containerName: string) => Promise<void>;
  private availabilityMutationCoordinator?: {
    containerRemoved?(nodeId: string, containerName: string): Promise<void>;
    getConfiguration?(
      nodeId: string,
      containerName: string
    ): Promise<{
      image: string;
      runtimeProfile?: string;
      shouldRun: boolean;
      nodeId: string;
      containerName: string;
    } | null>;
    updateConfiguration(
      nodeId: string,
      containerName: string,
      config: Record<string, unknown>,
      userId: string | null,
      options?: { waitForCompletion?: boolean; forceRollout?: boolean }
    ): Promise<boolean>;
    updateEnvironment(
      nodeId: string,
      containerName: string,
      env: Record<string, string> | undefined,
      removeEnv: string[] | undefined,
      userId: string
    ): Promise<boolean>;
    getEnvironment(nodeId: string, containerName: string): Promise<string[] | null>;
    setRunning(
      nodeId: string,
      containerName: string,
      running: boolean,
      userId: string,
      restart?: boolean
    ): Promise<boolean>;
  };
  private workloadResolver?: Pick<DockerWorkloadResolverService, 'resolveContainerRuntimeTarget'>;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private nodeDispatch: NodeDispatchService,
    private nodeRegistry: NodeRegistryService
  ) {}

  setTaskService(taskService: DockerTaskService) {
    this.taskService = taskService;
    taskService.setContainerTaskTerminalHandler?.(({ nodeId, containerId, containerName }) => {
      if (!containerName) return;
      this.clearTransition(nodeId, containerName);
      this.emitTransition(nodeId, containerName, containerId ?? containerName, null);
    });
  }

  setAvailabilityMutationGuard(guard: (nodeId: string, containerName: string) => Promise<void>): void {
    this.availabilityMutationGuard = guard;
  }

  setAvailabilityMutationCoordinator(
    coordinator: NonNullable<DockerManagementService['availabilityMutationCoordinator']>
  ): void {
    this.availabilityMutationCoordinator = coordinator;
  }

  async getManagedContainerConfiguration(nodeId: string, containerName: string) {
    return this.availabilityMutationCoordinator?.getConfiguration?.(nodeId, containerName) ?? null;
  }

  setWorkloadResolver(resolver: Pick<DockerWorkloadResolverService, 'resolveContainerRuntimeTarget'>): void {
    this.workloadResolver = resolver;
  }

  private async resolveRuntimeContainer(nodeId: string, containerId: string) {
    const target = await this.workloadResolver?.resolveContainerRuntimeTarget(nodeId, containerId);
    return target
      ? { nodeId: target.nodeId, containerId: target.containerId, managed: true }
      : { nodeId, containerId, managed: false };
  }

  setEnvironmentService(environmentService: DockerEnvironmentService) {
    this.environmentService = environmentService;
  }

  setRuntimeSettingsService(runtimeSettingsService: DockerRuntimeSettingsService) {
    this.runtimeSettingsService = runtimeSettingsService;
  }

  setSecretService(secretService: DockerSecretService) {
    this.secretService = secretService;
  }

  setFolderService(folderService: DockerFolderService) {
    this.folderService = folderService;
  }

  setDeploymentService(deploymentService: DockerDeploymentService) {
    this.deploymentService = deploymentService;
  }

  setHealthCheckService(healthCheckService: DockerHealthCheckService) {
    this.healthCheckService = healthCheckService;
  }

  setRegistryService(registryService: DockerRegistryService) {
    this.registryService = registryService;
  }

  setImageCleanupService(imageCleanupService: DockerImageCleanupService) {
    this.imageCleanupService = imageCleanupService;
  }

  setEventBus(eventBus: EventBusService) {
    this.eventBus = eventBus;
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  setMigrationGuard(guard: DockerMigrationGuard) {
    this.migrationGuard = guard;
  }

  /** Members of an app environment isolated by the kill switch refuse changes (set by the apps module). */
  setAppFreezeGuard(guard: DockerAppFreezeGuard) {
    this.appFreeze = guard;
  }

  /** 409 APP_ISOLATED for a container of an isolated app environment (the name is resolved only during incidents). */
  private async assertNotAppFrozen(nodeId: string, containerId: string): Promise<void> {
    if (!this.appFreeze || !(await this.appFreeze.anyIsolationOpen())) return;
    const name = await this.resolveContainerName(nodeId, containerId);
    await this.appFreeze.assertContainer(nodeId, name);
    if (name !== containerId) await this.appFreeze.assertContainer(nodeId, containerId);
  }

  /** Makes rename and update claims (and migration admissions) exclusive across backend processes. */
  setOperationLeases(leases: OperationLeaseStore) {
    this.containerTransitions.setLeaseStore(leases);
  }

  /**
   * Backs this process's transitions on the names with database leases (see
   * DockerContainerTransitions.acquireLeases): 409 CONTAINER_BUSY while
   * another backend process holds one of them.
   */
  acquireTransitionLeases(nodeId: string, names: readonly string[]): Promise<void> {
    return this.containerTransitions.acquireLeases(nodeId, names);
  }

  setBuildRolloutGuard(guard: DockerBuildRolloutGuard) {
    this.buildRolloutGuard = guard;
  }

  /** The build rollout that currently owns a target, if any. */
  async findBuildRollout(target: DockerBuildRolloutTarget) {
    return (await this.buildRolloutGuard?.find(target)) ?? null;
  }

  /** Refuses (409) while a build rollout owns the target; the rollout's own calls pass. */
  async assertBuildRolloutAllowed(target: DockerBuildRolloutTarget): Promise<void> {
    await this.buildRolloutGuard?.assertAllowed(target);
  }

  setAccessResourceService(service: DockerAccessResourceService) {
    this.accessResourceService = service;
  }

  setNetworkAccessResourceService(service: DockerNetworkAccessResourceService) {
    this.networkAccessResourceService = service;
  }

  setLicensePolicyService(_service: LicensePolicyService): void {}

  setContainerRecreateCompletedHandler(handler: (nodeId: string, newContainerId: string) => Promise<void>): void {
    this.containerRecreateCompletedHandler = handler;
  }

  /** Releases the managed database and storage links that target a container name (see releaseContainerLinks). */
  setManagedLinkReleaseHandler(
    handler: (nodeId: string, containerName: string, userId: string | null) => Promise<void>
  ): void {
    this.managedLinkReleaseHandler = handler;
  }

  /**
   * Managed database and storage links target a container by name. When the container that held the name is gone
   * (Opfield removed it, or a new container, copy, import or Git source takes a free name), its links go with it:
   * they are marked deleted at once, so no reconciliation applies them to the next container of that name, their
   * link secrets are removed, and their credentials and connectors are torn down in the background.
   */
  async releaseContainerLinks(nodeId: string, containerName: string, userId: string | null): Promise<void> {
    await this.managedLinkReleaseHandler?.(nodeId, containerName, userId);
  }

  private emitContainer(
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ) {
    const scopeResourceId = this.accessResourceService?.cachedContainerResourceId(nodeId, {
      name,
      runtimeId: id,
    });
    this.eventBus?.publish('docker.container.changed', {
      nodeId,
      name,
      id,
      action,
      ...(scopeResourceId ? { scopeResourceId } : {}),
      ...(extra || {}),
    });
    this.observeContainerLifecycle(nodeId, name, id, action, extra);
  }

  async registerImportedContainer(
    nodeId: string,
    name: string,
    runtimeId: string,
    folderId?: string,
    userId?: string
  ): Promise<void> {
    // The imported container took a free name: links left on it belonged to a container that is gone.
    await this.releaseContainerLinks(nodeId, name, userId ?? null);
    const resourceId = await this.accessResourceService?.ensureContainer(nodeId, name, runtimeId, false);
    if (resourceId)
      await grantCreatedResourcePermissions(userId, 'docker:containers', `${nodeId}/${resourceId}`, {
        folderId: folderId ?? null,
        nodeId,
      });
    await placeCreatedDockerResource(this.db, nodeId, 'container', name, folderId);
    this.emitContainer(nodeId, name, runtimeId, 'created', { source: 'gwca-import' });
  }

  emitTransition(nodeId: string, name: string, id: string, transition: ContainerTransition | null) {
    const scopeResourceId = this.accessResourceService?.cachedContainerResourceId(nodeId, {
      name,
      runtimeId: id,
    });
    this.eventBus?.publish('docker.container.changed', {
      nodeId,
      name,
      id,
      action: 'transitioning',
      transition,
      ...(scopeResourceId ? { scopeResourceId } : {}),
    });
  }

  private observeContainerLifecycle(
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ) {
    const state = this.lifecycleStateForAction(action);
    if (!state) return;

    const observedPatterns = state === 'started' || state === 'removed' ? ['stopped', 'exited'] : [state];
    this.evaluator
      ?.observeStatefulEvent(
        'container',
        state,
        { type: 'container', id: name || id, name: name || id },
        { nodeId, containerId: id, action, ...(extra || {}) },
        observedPatterns
      )
      .catch((error) => {
        logger.debug('Container lifecycle stateful event observation failed', {
          nodeId,
          containerId: id,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private lifecycleStateForAction(action: ContainerAction): 'started' | 'stopped' | 'exited' | 'removed' | null {
    switch (action) {
      case 'started':
      case 'restarted':
      case 'recreated':
        return 'started';
      case 'stopped':
        return 'stopped';
      case 'killed':
        return 'exited';
      case 'removed':
        return 'removed';
      default:
        return null;
    }
  }

  private imageOperationContext(existingImageIds?: ReadonlySet<string>) {
    return {
      existingImageIds,
      nodeDispatch: this.nodeDispatch,
      auditService: this.auditService,
      taskService: this.taskService,
      registryService: this.registryService,
      eventBus: this.eventBus,
      onImagePulled: async (nodeId: string, imageRef: string, folderId: string | null | undefined, userId: string) => {
        const images = await this.listAllImages(nodeId);
        const image = Array.isArray(images) ? resolvePulledDockerImage(images, imageRef, existingImageIds) : null;
        const imageId = image ? dockerImageId(image) : '';
        if (!imageId) {
          // No image appeared with the pull: it found one the node already had, which is neither granted nor moved.
          const known = existingImageIds;
          if (known && Array.isArray(images) && images.every((entry) => known.has(dockerImageId(entry)))) return;
          throw new AppError(
            502,
            'DOCKER_IMAGE_PULL_IDENTITY_UNRESOLVED',
            'Pulled image identity could not be resolved'
          );
        }
        // Only an image this pull created belongs to the caller. Re-pulling an image that already existed must
        // neither grant it nor move it out of the folder it sits in (that would hand it to the puller's folder).
        const createdByPull = !!existingImageIds && !existingImageIds.has(imageId);
        if (!createdByPull) return;
        await grantCreatedResourcePermissions(userId, 'docker:images', `${nodeId}/${imageId}`, {
          folderId: folderId ?? null,
          nodeId,
        });
        // Pulled at the root: a placement left by an earlier image with this id (removed outside Opfield)
        // must not pull the new one into that folder.
        if (!folderId) await this.folderService?.deleteResourceAssignment(nodeId, 'image', imageId);
        else
          await this.folderService?.moveResourcesToFolder(
            { resourceType: 'image', folderId, items: [{ nodeId, resourceKey: imageId }] },
            userId
          );
      },
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
      createTask: (nodeId: string, containerId: string, containerName: string, type: string) =>
        this.createTask(nodeId, containerId, containerName, type),
      longDockerOperationTimeoutMs: DockerManagementService.LONG_DOCKER_OPERATION_TIMEOUT_MS,
    };
  }

  protected volumeNetworkOperationContext() {
    return {
      db: this.db,
      nodeDispatch: this.nodeDispatch,
      auditService: this.auditService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
      assertContainerMutationAllowed: async (nodeId: string, containerId: string) => {
        await this.assertNotAppFrozen(nodeId, containerId);
        await this.assertContainerMutationAllowed(nodeId, containerId);
      },
      assertNetworkRemovable: async (nodeId: string, network: { id: string; name: string }) => {
        await this.appFreeze?.assertNetworkNotHeld(nodeId, network);
      },
      onNetworkCreated: async (
        nodeId: string,
        networkId: string,
        folderId: string | null | undefined,
        userId: string
      ) => {
        const resourceId = await this.networkAccessResourceService?.ensureNetwork(nodeId, networkId);
        if (resourceId)
          await grantCreatedResourcePermissions(userId, 'docker:networks', `${nodeId}/${resourceId}`, {
            folderId: folderId ?? null,
            nodeId,
          });
        if (folderId) {
          await this.folderService?.moveResourcesToFolder(
            { resourceType: 'network', folderId, items: [{ nodeId, resourceKey: networkId }] },
            userId
          );
        }
      },
      onNetworkRemoved: async (nodeId: string, networkId: string) => {
        await this.folderService?.deleteResourceAssignment(nodeId, 'network', networkId);
        await this.networkAccessResourceService?.removeNetwork(nodeId, networkId);
      },
      onVolumeCreated: async (
        nodeId: string,
        volumeName: string,
        folderId: string | null | undefined,
        userId: string
      ) => {
        await grantCreatedResourcePermissions(userId, 'docker:volumes', `${nodeId}/${volumeName}`, {
          folderId: folderId ?? null,
          nodeId,
        });
        // Created at the root: a placement left by an earlier volume of this name (removed outside Opfield)
        // must not pull the new one into that folder.
        if (!folderId) {
          await this.folderService?.deleteResourceAssignment(nodeId, 'volume', volumeName);
          return;
        }
        await this.folderService?.moveResourcesToFolder(
          { resourceType: 'volume', folderId, items: [{ nodeId, resourceKey: volumeName }] },
          userId
        );
      },
      onVolumeRemoved: async (nodeId: string, volumeName: string) => {
        await this.folderService?.deleteResourceAssignment(nodeId, 'volume', volumeName);
      },
    };
  }

  private readOperationContext() {
    return {
      nodeDispatch: this.nodeDispatch,
      auditService: this.auditService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  private envOperationContext() {
    return {
      db: this.db,
      nodeDispatch: this.nodeDispatch,
      environmentService: this.environmentService,
      secretService: this.secretService,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  private runtimeOperationContext(): DockerRuntimeOperationContext {
    return {
      db: this.db,
      nodeDispatch: this.nodeDispatch,
      nodeRegistry: this.nodeRegistry,
      runtimeSettingsService: this.runtimeSettingsService,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  /** What DockerTaskReconciler needs to settle the tasks Opfield lost track of with their nodes. */
  taskReconcileContext(): DockerTaskReconcileContext | null {
    if (!this.taskService) return null;
    return {
      ...this.lifecycleWatchContext(),
      taskService: this.taskService,
      finishPull: (nodeId, tracking) => this.finishReconciledPull(nodeId, tracking),
      runFollowUps: (task, trigger) => runKeptEnvFollowUps(this.containerMutationContext(), task, trigger),
      nodeHasCapability: (nodeId, capability) => this.nodeRegistry.hasCapability(nodeId, capability),
    };
  }

  /** What a pull settled after Opfield lost its answer still owes: the placement for its user, its registry. */
  private async finishReconciledPull(nodeId: string, tracking: Extract<DockerTaskTracking, { kind: 'pull' }>) {
    const context = this.imageOperationContext(
      tracking.preexistingImageIds ? new Set(tracking.preexistingImageIds) : undefined
    );
    if (tracking.userId) await context.onImagePulled(nodeId, tracking.imageRef, tracking.folderId, tracking.userId);
    await this.registryService?.rememberImageRegistry?.(nodeId, tracking.imageRef, tracking.registryId ?? undefined);
    this.eventBus?.publish('docker.image.changed', { nodeId, ref: tracking.imageRef, action: 'pulled' });
  }

  private lifecycleWatchContext(): DockerLifecycleWatchContext {
    return {
      nodeDispatch: this.nodeDispatch,
      taskService: this.taskService,
      eventBus: this.eventBus,
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
      clearTransition: (nodeId: string, name: string) => this.clearTransition(nodeId, name),
      emitContainer: (nodeId, name, id, action, extra) => this.emitContainer(nodeId, name, id, action, extra),
      failTask: (taskId, error, nodeId, containerName) => this.failTask(taskId, error, nodeId, containerName),
      preserveContainerIdentity: (nodeId, name, runtimeId) =>
        this.accessResourceService?.preserveContainerRuntimeId(nodeId, name, runtimeId) ?? Promise.resolve(),
    };
  }

  /**
   * Verify the target name is not already taken on this node.
   * Two-layer guard: (1) blocks if a name-keyed transition is in flight,
   * (2) lists containers and rejects if the name already exists.
   * Should be called BEFORE dispatching create/rename/duplicate to the daemon.
   */
  private async assertNameAvailable(
    nodeId: string,
    name: string,
    claim?: ContainerTransitionClaim,
    options: { sourceBindingId?: string } = {}
  ) {
    if (this.getTransition(nodeId, name) && !this.containerTransitions.isClaimedBy(nodeId, name, claim)) {
      throw new AppError(409, 'NAME_IN_USE', `A container named "${name}" is currently being modified on this node`);
    }
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.name, name)))
      .limit(1);
    if (deployment) {
      throw new AppError(409, 'NAME_IN_USE', `A deployment named "${name}" already exists on this node`);
    }
    // A Git source container waiting for its first build owns its name; only that source's rollout creates it.
    await assertContainerNameNotReserved(this.db, nodeId, name, options);
    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
      const containers = this.parseResult(result);
      if (Array.isArray(containers)) {
        const collision = containers.some((c: any) => {
          if (this.isManagedDeploymentInternal(c)) return false;
          const cName = ((c.name ?? c.Name ?? '') as string).replace(/^\//, '');
          return cName === name;
        });
        if (collision) {
          throw new AppError(409, 'NAME_IN_USE', `A container named "${name}" already exists on this node`);
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        502,
        'NAME_AVAILABILITY_CHECK_FAILED',
        `Could not verify whether the container name "${name}" is available`
      );
    }
  }

  /**
   * Translate a Docker name-conflict error from the daemon into a friendly
   * AppError. Pass any caught error through this on create/rename/duplicate.
   */
  private translateNameConflict(err: unknown, name: string): never {
    const message = err instanceof Error ? err.message : String(err);
    if (/already in use|name.*conflict|409/i.test(message)) {
      throw new AppError(409, 'NAME_IN_USE', `A container named "${name}" already exists on this node`);
    }
    throw err;
  }

  requireNoTransition(nodeId: string, name: string) {
    this.containerTransitions.requireIdle(nodeId, name);
  }

  setTransition(nodeId: string, name: string, state: ContainerTransition): boolean {
    return this.containerTransitions.set(nodeId, name, state);
  }

  clearTransition(nodeId: string, name: string) {
    this.containerTransitions.clear(nodeId, name);
  }

  private getTransition(nodeId: string, name: string): ContainerTransition | undefined {
    return this.containerTransitions.get(nodeId, name);
  }

  getContainerTransition(nodeId: string, name: string): ContainerTransition | undefined {
    return this.getTransition(nodeId, name);
  }

  private async resolveContainerName(nodeId: string, containerId: string): Promise<string> {
    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
      const data = this.parseResult(result);
      return (data?.Name ?? '').replace(/^\//, '') || containerId.slice(0, 12);
    } catch {
      return containerId.slice(0, 12);
    }
  }

  private async resolveExpectedRecreateState(nodeId: string, containerId: string): Promise<'running' | 'created'> {
    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
      const data = this.parseResult(result);
      // A crash-looping (restarting) container is meant to run: recreate it
      // running so its restart policy keeps trying with the new configuration.
      return data?.State?.Status === 'running' || data?.State?.Status === 'restarting' ? 'running' : 'created';
    } catch {
      return 'running';
    }
  }

  private isManagedDeploymentInternal(data: any): boolean {
    return isDockerDeploymentManaged(data?.Config?.Labels ?? data?.Labels ?? data?.labels);
  }

  async assertContainerMutationAllowed(nodeId: string, containerId: string) {
    if ((await this.workloadResolver?.resolveContainerRuntimeTarget(nodeId, containerId)) != null) return;
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    const data = this.parseResult(result);
    if (isOpfieldInternalContainer(data)) {
      throw new AppError(
        409,
        'OPFIELD_INTERNAL_CONTAINER',
        'This container is managed by Opfield and cannot be modified directly.'
      );
    }
    if (this.isManagedDeploymentInternal(data)) {
      throw new AppError(
        409,
        'MANAGED_DEPLOYMENT_CONTAINER',
        'This container is managed by a blue/green deployment. Use deployment actions instead.'
      );
    }
    const containerName = String(data?.Name ?? data?.name ?? containerId).replace(/^\/+/, '');
    await this.availabilityMutationGuard?.(nodeId, containerName);
  }

  private async createTask(nodeId: string, containerId: string, containerName: string, type: string) {
    if (!this.taskService) return undefined;
    const task = await this.taskService.create({ nodeId, containerId, containerName, type });
    await this.taskService.update(task.id, { status: 'running' });
    return task;
  }

  private async failTask(taskId: string | undefined, error: string, nodeId?: string, containerName?: string) {
    if (nodeId && containerName) this.clearTransition(nodeId, containerName);
    if (nodeId && containerName) {
      this.eventBus?.publish('docker.container.changed', {
        nodeId,
        name: containerName,
        action: 'transitioning',
        transition: null,
      });
    }
    if (taskId && this.taskService) {
      await this.taskService.update(taskId, { status: 'failed', error, completedAt: new Date() }).catch(() => {});
    }
  }

  private async resolveContainerStopTimeout(nodeId: string, containerId: string, timeout: number | undefined) {
    if (timeout !== undefined) return timeout;

    try {
      const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
      const data = this.parseResult(result);
      const configuredRaw = data?.Config?.StopTimeout;
      const configured = typeof configuredRaw === 'number' ? configuredRaw : Number.NaN;
      if (Number.isInteger(configured) && configured >= 0) return configured;
    } catch {
      // Fall through to Opfield default if inspect fails; the lifecycle command will report its own error.
    }

    return DEFAULT_CONTAINER_STOP_TIMEOUT_SECONDS;
  }

  private lifecycleWatchTimeoutMs(
    stopTimeoutSeconds: number,
    bufferSeconds = CONTAINER_LIFECYCLE_TIMEOUT_BUFFER_SECONDS
  ) {
    return Math.max(60000, (stopTimeoutSeconds + bufferSeconds) * 1000);
  }

  private resolveStopTimeoutFromInspect(inspect: Record<string, any>, config?: Record<string, unknown>) {
    const configRaw = config?.stopTimeout;
    const configValue = typeof configRaw === 'number' ? configRaw : Number.NaN;
    if (Number.isInteger(configValue) && configValue >= 0) return configValue;

    const inspectRaw = inspect?.Config?.StopTimeout;
    const inspectValue = typeof inspectRaw === 'number' ? inspectRaw : Number.NaN;
    if (Number.isInteger(inspectValue) && inspectValue >= 0) return inspectValue;

    return DEFAULT_CONTAINER_STOP_TIMEOUT_SECONDS;
  }

  /**
   * Poll container state to detect when an async operation completes,
   * then mark the task as succeeded and clear the transition. Settles once
   * the task did.
   */
  private watchTransition(
    nodeId: string,
    containerId: string,
    name: string,
    taskId: string | undefined,
    expectedState: string,
    progress: string,
    completedAction: ContainerAction,
    timeoutMs = 60000,
    isComplete?: (inspectData: Record<string, any>) => boolean,
    trackingHint?: DockerTransitionTrackingHint
  ): Promise<DockerTransitionOutcome> {
    return watchDockerTransition(
      this.lifecycleWatchContext(),
      nodeId,
      containerId,
      name,
      taskId,
      expectedState,
      progress,
      completedAction,
      timeoutMs,
      isComplete,
      trackingHint
    );
  }

  /**
   * Poll by container NAME to detect when a recreate completes.
   * Waits for a container with the given name to appear with a DIFFERENT ID
   * and reach the expected state.
   */
  private watchRecreateByName(
    nodeId: string,
    containerName: string,
    oldContainerId: string,
    taskId: string | undefined,
    progress: string,
    expectedState: string,
    timeoutMs = 60000,
    onComplete?: (newContainerId: string) => Promise<void>,
    daemonTaskId?: string,
    onDaemonTaskFailed?: () => Promise<void>
  ) {
    watchDockerRecreateByName(
      this.lifecycleWatchContext(),
      nodeId,
      containerName,
      oldContainerId,
      taskId,
      progress,
      expectedState,
      timeoutMs,
      onComplete,
      daemonTaskId,
      onDaemonTaskFailed
    );
  }

  private async validateDockerNode(nodeId: string) {
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
    if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Node is not a Docker node');
    if (!this.nodeRegistry.getNode(nodeId)) throw new AppError(502, 'NODE_OFFLINE', 'Node is offline');
    return node;
  }

  private async assertDockerGpuCapability(nodeId: string): Promise<void> {
    const node = await this.validateDockerNode(nodeId);
    if (!hasDockerGpuV1Capability(node.capabilities)) {
      throw new AppError(
        409,
        'UNSUPPORTED_DAEMON',
        'Docker node does not support Opfield GPU attachments. Update the Docker daemon before changing GPU configuration.'
      );
    }
  }

  private async assertDockerPortBindIpCapability(nodeId: string): Promise<void> {
    const node = await this.validateDockerNode(nodeId);
    if (!hasDockerPortBindIpV1Capability(node.capabilities)) {
      throw new AppError(
        409,
        'UNSUPPORTED_DAEMON',
        'Docker node does not support interface-specific port publishing. Update the Docker daemon before changing the publish address.'
      );
    }
  }

  protected async assertDockerRuntimeProfileAvailable(
    nodeId: string,
    profile: unknown,
    currentProfile?: unknown
  ): Promise<void> {
    if (profile !== 'secure') return;
    if (currentProfile !== 'secure') {
      return commercialModuleUnavailable();
    }
    await this.requireHealthySecureRuntime(nodeId);
  }

  protected async requireHealthySecureRuntime(nodeId: string): Promise<void> {
    const node = await this.validateDockerNode(nodeId);
    const status = (node.capabilities as Record<string, any> | null)?.dockerRuntimeStatus;
    if (status?.state !== 'healthy') {
      throw new AppError(409, 'SECURE_RUNTIME_UNAVAILABLE', secureRuntimeUnavailableMessage(status));
    }
  }

  private parseResult(result: { success: boolean; error?: string; detail?: string }) {
    if (!result.success) {
      const message = dockerDispatchErrorMessage(result, 'Command failed on daemon');
      throw dockerDaemonUserError(message) ?? new AppError(502, 'DISPATCH_ERROR', message);
    }
    try {
      return result.detail ? JSON.parse(result.detail) : null;
    } catch {
      return result.detail;
    }
  }

  // ─── Container operations ──────────────────────────────────────────

  private async getDirectContainerDatabaseLinks(nodeId: string, containerNames: string[]) {
    if (containerNames.length === 0 || typeof (this.db as { select?: unknown }).select !== 'function') {
      return new Map<string, Array<Record<string, unknown>>>();
    }
    const rows = await this.db
      .select({
        databaseId: managedDatabaseInstances.id,
        databaseName: managedDatabaseInstances.name,
        databaseType: managedDatabaseInstances.type,
        bindingId: managedDatabaseBindings.id,
        managedDatabaseId: managedDatabaseBindings.managedDatabaseId,
        targetNodeId: managedDatabaseBindings.targetNodeId,
        targetResourceId: managedDatabaseBindings.targetResourceId,
        status: managedDatabaseBindings.status,
        lastError: managedDatabaseBindings.lastError,
      })
      .from(managedDatabaseBindings)
      .innerJoin(managedDatabaseInstances, eq(managedDatabaseInstances.id, managedDatabaseBindings.managedDatabaseId))
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, nodeId),
          eq(managedDatabaseBindings.targetType, 'container'),
          inArray(managedDatabaseBindings.targetResourceId, containerNames)
        )
      );
    const byContainer = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const links = byContainer.get(row.targetResourceId) ?? [];
      links.push({
        database: { id: row.databaseId, name: row.databaseName, type: row.databaseType },
        binding: {
          id: row.bindingId,
          managedDatabaseId: row.managedDatabaseId,
          targetNodeId: row.targetNodeId,
          targetType: 'container',
          targetResourceId: row.targetResourceId,
          status: row.status,
          lastError: row.lastError,
        },
      });
      byContainer.set(row.targetResourceId, links);
    }
    return byContainer;
  }

  async listContainers(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
    const containers = this.parseResult(result);
    return this.decoratePublicContainerSnapshot(nodeId, containers);
  }

  /** Internal inventory for services that must account for Opfield-owned containers. */
  async listAllContainers(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
    const containers = this.parseResult(result);
    return this.decorateContainerSnapshot(nodeId, containers);
  }

  /**
   * Every container on the node as Docker lists it, the blue/green slot containers of deployments included (with
   * their labels), not the user-facing list where a deployment is one synthetic row. For rules that must see what
   * really runs on the node, such as the image cleanup.
   */
  async listNodeContainers(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
    return this.parseResult(result);
  }

  /**
   * Resolve the physical GPUs used by real containers on demand. Container
   * summaries intentionally omit HostConfig, so this read-only view inspects
   * each entry only when the Settings table needs it.
   */
  async listGpuAttachmentUsers(nodeId: string, actorScopes: string[]): Promise<DockerGpuAttachmentUser[]> {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
    const containers = this.parseResult(result);
    if (!Array.isArray(containers)) return [];

    const gpuInventory = await this.gpuInventoryForNode(nodeId);
    const resourceRows = (await this.accessResourceService?.listContainerResourceIdentities(nodeId)) ?? [];
    const resourceIdByName = new Map(resourceRows.map((row) => [row.name, row.id]));
    const resourceIdByRuntime = new Map(
      resourceRows.filter((row) => !!row.runtimeId).map((row) => [row.runtimeId!, row.id])
    );
    const visibleContainers = containers.flatMap((item) => {
      const container = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      if (isOpfieldInternalContainer(container)) return [];
      const containerId = String(container.id ?? container.Id ?? '');
      if (!containerId) return [];
      const name = String(container.name ?? container.Name ?? '').replace(/^\/+/, '');
      const labels = (container.labels ?? container.Labels ?? {}) as Record<string, unknown>;
      const deploymentId = dockerDeploymentIdLabel(labels);
      const scopeResourceId =
        deploymentId || (resourceIdByRuntime.get(containerId) ?? resourceIdByName.get(name) ?? null);
      if (!hasDockerResourceScope(actorScopes, 'docker:containers:view', nodeId, scopeResourceId ?? '')) {
        return [];
      }
      return [{ containerId, name, scopeResourceId }];
    });
    const users: DockerGpuAttachmentUser[] = [];
    for (let offset = 0; offset < visibleContainers.length; offset += GPU_USAGE_INSPECTION_BATCH_SIZE) {
      const batch = visibleContainers.slice(offset, offset + GPU_USAGE_INSPECTION_BATCH_SIZE);
      const inspected = await Promise.all(
        batch.map(
          async ({ containerId, name: listedName, scopeResourceId }): Promise<DockerGpuAttachmentUser | null> => {
            try {
              const inspectResult = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', {
                containerId,
              });
              const detail = this.parseResult(inspectResult);
              if (!detail || typeof detail !== 'object') return null;
              const attachment = deriveDockerGpuAttachment(detail, gpuInventory);
              if (attachment.mode !== 'managed' || attachment.deviceIds.length === 0) return null;

              const name = String(
                (detail as Record<string, unknown>).Name ?? (detail as Record<string, unknown>).name ?? listedName
              ).replace(/^\/+/, '');
              if (!name) return null;

              return {
                containerId,
                name,
                scopeResourceId,
                deviceIds: attachment.deviceIds,
              };
            } catch (error) {
              // A container can disappear between the list and inspect calls.
              // Keep the rest of the shared-device view usable in that case.
              logger.debug('Skipping GPU usage inspection for container', {
                nodeId,
                containerId,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            }
          }
        )
      );
      users.push(...inspected.filter((user): user is DockerGpuAttachmentUser => !!user));
    }
    return users;
  }

  /** Add DB-backed folders, health checks and deployment rows without contacting a daemon. */
  async decorateContainerSnapshot(nodeId: string, containers: any) {
    const folderAssignments =
      Array.isArray(containers) && this.folderService
        ? await this.folderService.syncNodeContainers(nodeId, containers as any[])
        : [];
    const folderByName = new Map(folderAssignments.map((item) => [item.containerName, item]));
    // Inject transition states into the list (looked up by name, not ID,
    // so the badge survives recreate/update which assigns a new ID).
    if (Array.isArray(containers)) {
      const visibleContainers = containers.filter((c: any) => !this.isManagedDeploymentInternal(c));
      const accessIds = this.accessResourceService
        ? await this.accessResourceService.syncContainers(
            nodeId,
            visibleContainers,
            new Set(
              visibleContainers
                .map((container: any) => String(container.name ?? container.Name ?? '').replace(/^\/+/, ''))
                .filter((name: string) => ['recreating', 'updating'].includes(this.getTransition(nodeId, name) ?? ''))
            )
          )
        : new Map<string, string>();
      const containerHealth =
        this.healthCheckService && visibleContainers.length > 0
          ? await this.healthCheckService.getRowsForContainers(
              nodeId,
              visibleContainers.map((c: any) => ((c.name ?? c.Name ?? '') as string).replace(/^\//, '')).filter(Boolean)
            )
          : new Map();
      const containerNames = visibleContainers
        .map((container: any) => String(container.name ?? container.Name ?? '').replace(/^\/+/, ''))
        .filter(Boolean);
      const databaseLinks = await this.getDirectContainerDatabaseLinks(nodeId, containerNames);
      for (const c of visibleContainers) {
        const cName = ((c.name ?? c.Name ?? '') as string).replace(/^\//, '');
        if (!cName) continue;
        const folder = folderByName.get(cName);
        if (folder) {
          c.folderId = folder.folderId;
          c.folderIsSystem = folder.folderIsSystem;
          c.folderSortOrder = folder.sortOrder;
        } else {
          c.folderId = null;
          c.folderIsSystem = false;
          c.folderSortOrder = 0;
        }
        const transition = this.getTransition(nodeId, cName);
        if (transition) c._transition = transition;
        c.scopeResourceId = accessIds.get(cName) ?? null;
        const health = containerHealth.get(cName);
        if (health) {
          c.healthCheckId = health.id;
          c.healthCheckEnabled = health.enabled;
          c.healthStatus = health.healthStatus;
          c.lastHealthCheckAt = health.lastHealthCheckAt;
        }
        c.secureLinkDown = (databaseLinks.get(cName) ?? []).some((link: any) => link.binding?.status === 'error');
      }
      if (this.deploymentService) {
        const deploymentRows = await this.deploymentService.syntheticRows(nodeId);
        const deploymentHealth = this.healthCheckService
          ? await this.healthCheckService.getRowsForDeployments(
              deploymentRows.map((deployment: any) => deployment.deploymentId ?? deployment.id)
            )
          : new Map();
        if (this.folderService && deploymentRows.length > 0) {
          const placements = await this.folderService.getPlacementsForRefs(
            deploymentRows.map((deployment: any) => ({
              nodeId,
              containerName: deployment.name,
            }))
          );
          const placementByName = new Map(placements.map((placement) => [placement.containerName, placement]));
          for (const deployment of deploymentRows as any[]) {
            const placement = placementByName.get(deployment.name);
            if (!placement) continue;
            deployment.folderId = placement.folderId;
            deployment.folderIsSystem = placement.folderIsSystem;
            deployment.folderSortOrder = placement.sortOrder;
          }
        }
        for (const deployment of deploymentRows as any[]) {
          deployment.scopeResourceId = deployment.deploymentId ?? deployment.id;
          const health = deploymentHealth.get(deployment.deploymentId ?? deployment.id);
          if (!health) continue;
          deployment.healthCheckId = health.id;
          deployment.healthCheckEnabled = health.enabled;
          deployment.healthStatus = health.healthStatus;
          deployment.lastHealthCheckAt = health.lastHealthCheckAt;
        }
        visibleContainers.push(...deploymentRows);
      }
      return visibleContainers;
    }
    return containers;
  }

  /** User-facing decoration that keeps Opfield implementation containers private. */
  async decoratePublicContainerSnapshot(nodeId: string, containers: any) {
    const publicContainers = Array.isArray(containers) ? filterOpfieldInternalContainers(containers) : containers;
    const decorated = await this.decorateContainerSnapshot(nodeId, publicContainers);
    if (!Array.isArray(decorated)) return decorated;
    const names = new Set(
      (Array.isArray(containers) ? containers : []).map((item: any) =>
        String(item.name ?? item.Name ?? '').replace(/^\/+/, '')
      )
    );
    for (const item of decorated) names.add(String(item.name ?? item.Name ?? '').replace(/^\/+/, ''));
    const pending = (await readPendingDockerSourceContainers(this.db, nodeId)).filter(
      (item) => !names.has(item.containerName)
    );
    // A pending source container was placed in its destination folder when it was created; list it there,
    // not at the root.
    const placements =
      pending.length > 0 && this.folderService
        ? await this.folderService.getPlacementsForRefs(
            pending.map((item) => ({ nodeId, containerName: item.containerName }))
          )
        : [];
    const placementByName = new Map(placements.map((placement) => [placement.containerName, placement]));
    return [
      ...decorated,
      ...pending.map((item) => {
        const placement = placementByName.get(item.containerName);
        return {
          ...item,
          id: item.Id,
          name: item.containerName,
          kind: 'container',
          state: 'pending',
          status: 'Awaiting initial build',
          image: '',
          ports: [],
          portsCount: 0,
          portsTruncated: false,
          labels: {},
          healthCheckEnabled: false,
          healthStatus: 'unknown',
          secureLinkDown: false,
          folderId: placement?.folderId ?? null,
          folderIsSystem: placement?.folderIsSystem ?? false,
          folderSortOrder: placement?.sortOrder ?? 0,
          // id/Id identify the source reservation only; this is not a Docker runtime.
        };
      }),
    ];
  }

  /** User-facing inspect decoration with non-secret direct database-link metadata. */
  async decoratePublicContainerDetailSnapshot(nodeId: string, data: any) {
    const decorated = await this.decorateContainerDetailSnapshot(nodeId, data);
    if (!decorated) return decorated;
    const cName = String(decorated.Name ?? decorated.name ?? '').replace(/^\/+/, '');
    const databaseLinks = cName ? await this.getDirectContainerDatabaseLinks(nodeId, [cName]) : new Map();
    decorated.databaseLinks = databaseLinks.get(cName) ?? [];
    decorated.secureLinkDown = decorated.databaseLinks.some((link: any) => link.binding?.status === 'error');
    return decorated;
  }

  async inspectContainer(nodeId: string, containerId: string) {
    await this.validateDockerNode(nodeId);
    const result = await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    const data = this.parseResult(result);
    if (data) {
      await this.maskSecretEnv(data, dockerSecretEnvOwners(nodeId, data));
      return this.decorateContainerDetailSnapshot(nodeId, data);
    }
    return data;
  }

  /**
   * Mask the values of the secrets stored for the given owners in an inspect's `Config.Env`: the container's own, the
   * deployment's on a slot (database and storage link credentials included) and the Compose project's on a service
   * container. A replica of an HA workload runs under an internal name on another node, so its inspect is masked with
   * the logical workload's secrets as well. Inspect never reveals them; secrets and link credentials have their own
   * reveal endpoints.
   */
  async maskSecretEnv(data: any, owners: ReadonlyArray<DockerSecretEnvOwner>) {
    if (!this.secretService || !Array.isArray(data?.Config?.Env)) return data;
    const carriesSecret = await dockerSecretEnvMatcher(this.secretService, owners);
    if (!carriesSecret) return data;
    data.Config.Env = data.Config.Env.map((entry: string) => {
      const eqIndex = entry.indexOf('=');
      if (eqIndex === -1 || !carriesSecret(entry)) return entry;
      return `${entry.slice(0, eqIndex)}=********`;
    });
    return data;
  }

  assertContainerUserAccessible(data: Record<string, any> | null | undefined): void {
    assertUserContainerAccessible(data);
  }

  /** Inspect a container selected through a user-facing Docker or AI API. */
  async inspectUserContainer(nodeId: string, containerId: string) {
    return inspectUserSelectedContainer(this, nodeId, containerId);
  }

  private async gpuInventoryForNode(nodeId: string): Promise<unknown[]> {
    const liveHealth = this.nodeRegistry.getNode(nodeId)?.lastHealthReport as Record<string, unknown> | undefined;
    if (Array.isArray(liveHealth?.gpuDevices)) return liveHealth.gpuDevices;
    try {
      const [node] = await this.db
        .select({ lastHealthReport: nodes.lastHealthReport })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      const persistedHealth = node?.lastHealthReport as Record<string, unknown> | null | undefined;
      return Array.isArray(persistedHealth?.gpuDevices) ? persistedHealth.gpuDevices : [];
    } catch {
      // Decoration must not make a normal inspect unavailable when a previous
      // health report cannot be read. An unrecognized host mapping remains
      // explicitly read-only until inventory is available again.
      return [];
    }
  }

  /** Add local transition/runtime state to a cached inspect without contacting a daemon. */
  async decorateContainerDetailSnapshot(nodeId: string, data: any, gpuInventory?: unknown[]) {
    if (!data) return data;
    const cName = ((data.Name ?? data.name ?? '') as string).replace(/^\/+/, '');
    const runtimeId = String(data.Id ?? data.id ?? '');
    // Health reports are periodic and may predate Start/Stop or even refer to
    // a replaced container with the same name. Never overwrite inspect state
    // with that unversioned inventory; lifecycle events refresh the snapshot.
    const transition = cName ? this.getTransition(nodeId, cName) : undefined;
    if (transition) data._transition = transition;
    else delete data._transition;
    const buildRollout = cName
      ? await this.buildRolloutGuard?.find({ kind: 'container', nodeId, containerName: cName }).catch(() => null)
      : null;
    if (buildRollout) data._buildRollout = { buildId: buildRollout.buildId, commitSha: buildRollout.commitSha };
    else delete data._buildRollout;
    data.gpuAttachment = deriveDockerGpuAttachment(data, gpuInventory ?? (await this.gpuInventoryForNode(nodeId)));
    const labels = (data.Config?.Labels ?? data.config?.labels ?? {}) as Record<string, string>;
    const deploymentId = dockerDeploymentIdLabel(labels);
    if (deploymentId) {
      data.scopeResourceId = deploymentId;
    } else if (this.accessResourceService && cName && runtimeId) {
      data.scopeResourceId = await this.accessResourceService.ensureContainer(
        nodeId,
        cName,
        runtimeId,
        transition === 'recreating' || transition === 'updating'
      );
    }
    if (this.runtimeSettingsService && cName) {
      const persistedRuntime = await this.runtimeSettingsService.get(nodeId, cName);
      if (persistedRuntime) return applyRuntimeSettingsToInspect(data, persistedRuntime);
    }
    return data;
  }

  private containerMutationContext(): DockerContainerMutationContext {
    return {
      db: this.db,
      auditService: this.auditService,
      nodeDispatch: this.nodeDispatch,
      environmentService: this.environmentService,
      runtimeSettingsService: this.runtimeSettingsService,
      secretService: this.secretService,
      registryService: this.registryService,
      imageCleanupService: this.imageCleanupService,
      folderService: this.folderService,
      accessResourceService: this.accessResourceService,
      taskService: this.taskService,
      releaseContainerLinks: (nodeId, containerName, userId) =>
        this.releaseContainerLinks(nodeId, containerName, userId),
      longDockerOperationTimeoutMs: DockerManagementService.LONG_DOCKER_OPERATION_TIMEOUT_MS,
      validateDockerNode: (nodeId) => this.validateDockerNode(nodeId),
      assertDockerGpuCapability: (nodeId) => this.assertDockerGpuCapability(nodeId),
      assertDockerPortBindIpCapability: (nodeId) => this.assertDockerPortBindIpCapability(nodeId),
      assertDockerRuntimeProfileAvailable: (nodeId, profile, currentProfile) =>
        this.assertDockerRuntimeProfileAvailable(nodeId, profile, currentProfile),
      assertNameAvailable: (nodeId, name, claim, options) => this.assertNameAvailable(nodeId, name, claim, options),
      assertNotManagedDeploymentInternal: (nodeId, containerId) =>
        this.assertContainerMutationAllowed(nodeId, containerId),
      translateNameConflict: (err, name) => this.translateNameConflict(err, name),
      resolveContainerName: (nodeId, containerId) => this.resolveContainerName(nodeId, containerId),
      resolveExpectedRecreateState: (nodeId, containerId) => this.resolveExpectedRecreateState(nodeId, containerId),
      resolveContainerStopTimeout: (nodeId, containerId, timeout) =>
        this.resolveContainerStopTimeout(nodeId, containerId, timeout),
      resolveStopTimeoutFromInspect: (inspect, config) => this.resolveStopTimeoutFromInspect(inspect, config),
      lifecycleWatchTimeoutMs: (stopTimeoutSeconds, bufferSeconds) =>
        this.lifecycleWatchTimeoutMs(stopTimeoutSeconds, bufferSeconds),
      inspectContainer: (nodeId, containerId) => this.inspectContainer(nodeId, containerId),
      runtimeOperationContext: () => this.runtimeOperationContext(),
      requireNoTransition: (nodeId, name) => this.requireNoTransition(nodeId, name),
      waitWhileTransition: (nodeId, name, states, timeoutMs) =>
        this.containerTransitions.waitWhile(nodeId, name, states, timeoutMs),
      setTransition: (nodeId, name, state) => this.setTransition(nodeId, name, state),
      clearTransition: (nodeId, name) => this.clearTransition(nodeId, name),
      claimTransitions: (nodeId, entries) => this.containerTransitions.claim(nodeId, entries),
      releaseTransitions: (claim) => this.containerTransitions.release(claim),
      acquireTransitionLeases: (nodeId, names, options) =>
        this.containerTransitions.acquireLeases(nodeId, names, options),
      transitionLeaseToken: (nodeId, name) => this.containerTransitions.leaseToken(nodeId, name),
      recheckMigrationGuard: (nodeId, identities, newName) => this.recheckMigrationGuard(nodeId, identities, newName),
      emitContainer: (nodeId, name, id, action, extra) => this.emitContainer(nodeId, name, id, action, extra),
      emitTransition: (nodeId, name, id, transition) => this.emitTransition(nodeId, name, id, transition),
      createTask: (nodeId, containerId, containerName, type) =>
        this.createTask(nodeId, containerId, containerName, type),
      failTask: (taskId, error, nodeId, containerName) => this.failTask(taskId, error, nodeId, containerName),
      watchTransition: (
        nodeId,
        containerId,
        name,
        taskId,
        expectedState,
        progress,
        completedAction,
        timeoutMs,
        isComplete,
        trackingHint
      ) =>
        this.watchTransition(
          nodeId,
          containerId,
          name,
          taskId,
          expectedState,
          progress,
          completedAction,
          timeoutMs,
          isComplete,
          trackingHint
        ),
      watchRecreateByName: (
        nodeId,
        containerName,
        oldContainerId,
        taskId,
        progress,
        expectedState,
        timeoutMs,
        onComplete,
        daemonTaskId,
        onDaemonTaskFailed
      ) =>
        this.watchRecreateByName(
          nodeId,
          containerName,
          oldContainerId,
          taskId,
          progress,
          expectedState,
          timeoutMs,
          onComplete,
          daemonTaskId,
          onDaemonTaskFailed
        ),
      parseResult: (result) => this.parseResult(result),
    };
  }

  /**
   * `sourceBindingId`: the first activation of that Git source creates its reserved container. Only then may the
   * name be one a source reserves, and the new runtime adopts the reservation's access identity.
   */
  async createContainer(
    nodeId: string,
    config: Record<string, unknown>,
    userId: string,
    actorScopes: string[] = [],
    options: { sourceBindingId?: string } = {}
  ) {
    await assertDockerCreationAccess(this.db, actorScopes, 'docker:containers:create', nodeId, config.folderId);
    const name = String(config.name ?? config.Name ?? '');
    if (name) await this.migrationGuard?.assertContainerNameAvailable(nodeId, name);
    return createDockerContainer(this.containerMutationContext(), nodeId, config, userId, actorScopes, options);
  }

  async rollbackCreatedContainer(nodeId: string, containerId: string, name: string | undefined, userId: string) {
    return rollbackDockerCreatedContainer(this.containerMutationContext(), nodeId, containerId, name, userId);
  }

  /** `appIncident`: the app kill switch starts a host-network container it stopped (its own hold does not apply). */
  async startContainer(nodeId: string, containerId: string, userId: string, options: { appIncident?: boolean } = {}) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    if (!options.appIncident && this.appFreeze && (await this.appFreeze.anyIsolationOpen())) {
      await this.appFreeze.assertMayStart(nodeId, await this.resolveContainerName(nodeId, containerId));
    }
    if (await this.availabilityMutationCoordinator?.setRunning(nodeId, containerId, true, userId)) return;
    const containerName = await this.resolveContainerName(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.setRunning(nodeId, containerName, true, userId)) return;
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return startDockerContainer(this.containerMutationContext(), nodeId, containerId, userId);
  }

  async stopContainer(nodeId: string, containerId: string, timeout: number | undefined, userId: string) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.setRunning(nodeId, containerId, false, userId)) return;
    const containerName = await this.resolveContainerName(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.setRunning(nodeId, containerName, false, userId)) return;
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return stopDockerContainer(this.containerMutationContext(), nodeId, containerId, timeout, userId);
  }

  async restartContainer(nodeId: string, containerId: string, timeout: number | undefined, userId: string) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.setRunning(nodeId, containerId, true, userId, true)) return;
    const containerName = await this.resolveContainerName(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.setRunning(nodeId, containerName, true, userId, true)) return;
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return restartDockerContainer(this.containerMutationContext(), nodeId, containerId, timeout, userId);
  }

  async killContainer(nodeId: string, containerId: string, signal: string, userId: string) {
    const stableName = this.getTransition(nodeId, containerId) ? containerId : undefined;
    return killDockerContainer(this.containerMutationContext(), nodeId, containerId, signal, userId, stableName);
  }

  async removeContainer(nodeId: string, containerId: string, force: boolean, userId: string) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    // Refused while the kill switch isolates it; a shut-down app takes it (Start skips a removed container and finds a
    // renamed one by its runtime id).
    await this.assertNotAppFrozen(nodeId, containerId);
    const managed = await this.workloadResolver?.resolveContainerRuntimeTarget(nodeId, containerId);
    if (managed && managed.workload.policy.mode !== 'single') {
      throw new AppError(
        409,
        'AVAILABILITY_PLACEMENT_MANAGED',
        'Disable Availability in Settings before removing this container.'
      );
    }
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    const containerName = this.availabilityMutationCoordinator?.containerRemoved
      ? await this.resolveContainerName(nodeId, containerId)
      : undefined;
    const coordinator = this.availabilityMutationCoordinator;
    try {
      return await removeDockerContainerMutation(
        this.containerMutationContext(),
        nodeId,
        containerId,
        force,
        userId,
        containerName ? async () => coordinator?.containerRemoved?.(nodeId, containerName) : undefined
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') {
        await assertNotPendingSourceContainer(nodeId, containerId);
      }
      throw error;
    }
  }

  async renameContainer(nodeId: string, containerId: string, newName: string, userId: string) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    // Refused while the kill switch isolates it; a shut-down app takes it (Start skips a removed container and finds a
    // renamed one by its runtime id).
    await this.assertNotAppFrozen(nodeId, containerId);
    await this.assertNotAvailabilityManaged(
      nodeId,
      containerId,
      'This container is controlled by Availability, and every replica keeps its name. Disable Availability to rename it.'
    );
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    await this.migrationGuard?.assertContainerNameAvailable(nodeId, newName);
    await renameDockerContainer(this.containerMutationContext(), nodeId, containerId, newName, userId);
  }

  async duplicateContainer(
    nodeId: string,
    containerId: string,
    name: string,
    userId: string,
    actorScopes: string[] = [],
    folderId?: string | null
  ) {
    await assertDockerCreationAccess(this.db, actorScopes, 'docker:containers:create', nodeId, folderId);
    return duplicateDockerContainer(
      this.containerMutationContext(),
      nodeId,
      containerId,
      name,
      userId,
      actorScopes,
      folderId
    );
  }

  async updateContainer(
    nodeId: string,
    containerId: string,
    config: Record<string, unknown>,
    userId: string,
    actorScopes: string[] = []
  ) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    await this.assertNotAppFrozen(nodeId, containerId);
    const managed = await this.updateAvailabilityContainer(nodeId, containerId, config, userId);
    if (managed) return managed;
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return updateDockerContainer(this.containerMutationContext(), nodeId, containerId, config, userId, actorScopes);
  }

  /**
   * POST .../update of a container under Availability: the new tag and environment roll out to every replica through
   * Availability in one rollout, as PUT .../env and a recreate do. Updating the container the request names changed
   * only that replica and took it out of service (stand run x1). Null for a container outside Availability.
   */
  private async updateAvailabilityContainer(
    nodeId: string,
    containerId: string,
    config: Record<string, unknown>,
    userId: string
  ): Promise<{ availabilityManaged: true; containerId: string; name: string } | null> {
    const coordinator = this.availabilityMutationCoordinator;
    if (!coordinator?.getConfiguration) return null;
    const managed =
      (await coordinator.getConfiguration(nodeId, containerId)) ??
      (await coordinator.getConfiguration(nodeId, await this.resolveContainerName(nodeId, containerId)));
    if (!managed) return null;
    const patch: Record<string, unknown> = {};
    const tag = typeof config.tag === 'string' ? config.tag.trim() : '';
    if (tag) {
      const image = imageRefWithTag(managed.image, tag);
      if (!image) throw new AppError(400, 'NO_IMAGE', 'Cannot determine the image of this Availability workload');
      patch.image = image;
    }
    if (config.env !== undefined) patch.env = config.env;
    if (config.removeEnv !== undefined) patch.removeEnv = config.removeEnv;
    // Without a change it redeploys the current image, as an update of a single container does.
    await coordinator.updateConfiguration(
      managed.nodeId,
      managed.containerName,
      Object.keys(patch).length > 0 ? patch : { image: managed.image },
      userId,
      Object.keys(patch).length > 0 ? undefined : { forceRollout: true }
    );
    return { availabilityManaged: true, containerId, name: managed.containerName };
  }

  /**
   * Refuses a change to one replica of a container under Availability that Availability cannot carry to the other
   * replicas (its name, its networks): the replicas would differ until the next rollout undid it.
   */
  private async assertNotAvailabilityManaged(nodeId: string, containerId: string, message: string): Promise<void> {
    if ((await this.workloadResolver?.resolveContainerRuntimeTarget(nodeId, containerId)) != null) {
      throw new AppError(409, 'AVAILABILITY_PLACEMENT_MANAGED', message);
    }
  }

  async getContainerLogs(nodeId: string, containerId: string, tail: number, timestamps: boolean) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    return getDockerContainerLogs(this.readOperationContext(), target.nodeId, target.containerId, tail, timestamps);
  }

  /** Bounded, redacted evidence captured before a failed rollout removes its runtime. */
  /**
   * Startup evidence of a container whose rollout failed (see collectDockerRolloutDiagnostics). `containerName` lets
   * the log lines be redacted with the values Opfield stores for the container when its inspect cannot be read.
   */
  async getContainerFailureDiagnostics(nodeId: string, containerId: string, containerName?: string): Promise<string> {
    const parseBounded = (result: { success: boolean; error?: string; detail?: string }) => {
      if (
        (result.detail?.length ?? 0) > DOCKER_ROLLOUT_RESPONSE_LIMIT ||
        Buffer.byteLength(result.detail ?? '') > DOCKER_ROLLOUT_RESPONSE_LIMIT
      ) {
        throw new Error('Oversized runtime diagnostic response');
      }
      return this.parseResult(result);
    };
    return collectDockerRolloutDiagnostics({
      secretEntries: async (inspect) =>
        this.secretService ? dockerSecretEnvMatcher(this.secretService, dockerSecretEnvOwners(nodeId, inspect)) : null,
      storedValues: async () => {
        if (!containerName) return { environment: [], secrets: [] };
        const [env, secrets] = await Promise.all([
          this.environmentService?.getDecryptedMap(nodeId, containerName),
          this.secretService?.getDecryptedMap(nodeId, containerName),
        ]);
        return { environment: Object.values(env ?? {}), secrets: Object.values(secrets ?? {}) };
      },
      inspect: async (timeoutMs) =>
        parseBounded(await this.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId }, timeoutMs)),
      logs: async (timeoutMs) =>
        parseBounded(
          await this.nodeDispatch.sendDockerLogsCommand(
            nodeId,
            containerId,
            {
              tailLines: 30,
              timestamps: false,
              follow: false,
            },
            timeoutMs
          )
        ),
    });
  }

  async getContainerEnv(nodeId: string, containerId: string) {
    const managed = await this.availabilityMutationCoordinator?.getEnvironment(nodeId, containerId);
    if (managed) return managed;
    await this.validateDockerNode(nodeId);
    return getDockerContainerEnv(this.envOperationContext(), nodeId, containerId);
  }

  async liveUpdateContainer(nodeId: string, containerId: string, config: Record<string, unknown>, userId: string) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    await this.assertNotAppFrozen(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.updateConfiguration(nodeId, containerId, config, userId)) return;
    const containerName = await this.resolveContainerName(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.updateConfiguration(nodeId, containerName, config, userId)) return;
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    await liveUpdateDockerContainer(this.containerMutationContext(), nodeId, containerId, config, userId);
  }

  async recreateWithConfig(
    nodeId: string,
    containerId: string,
    config: Record<string, unknown>,
    userId: string | null,
    options?: {
      skipImagePull?: boolean;
      skipWebhookCleanup?: boolean;
      actorScopes?: string[];
      backgroundImagePull?: boolean;
      waitForAvailability?: boolean;
      forceAvailabilityRollout?: boolean;
      // Internal rollback override: preserve intent from before the failed revision.
      expectedState?: 'running' | 'created';
    }
  ) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    await this.assertNotAppFrozen(nodeId, containerId);
    const availabilityOptions =
      options?.waitForAvailability || options?.forceAvailabilityRollout
        ? { waitForCompletion: options.waitForAvailability, forceRollout: options.forceAvailabilityRollout }
        : undefined;
    if (
      await this.availabilityMutationCoordinator?.updateConfiguration(
        nodeId,
        containerId,
        config,
        userId,
        availabilityOptions
      )
    ) {
      return { availabilityManaged: true };
    }
    const containerName = await this.resolveContainerName(nodeId, containerId);
    if (
      await this.availabilityMutationCoordinator?.updateConfiguration(
        nodeId,
        containerName,
        config,
        userId,
        availabilityOptions
      )
    ) {
      return { availabilityManaged: true };
    }
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return recreateDockerContainerWithConfig(this.containerMutationContext(), nodeId, containerId, config, userId, {
      ...options,
      onComplete: this.containerRecreateCompletedHandler
        ? async (newContainerId) => this.containerRecreateCompletedHandler?.(nodeId, newContainerId)
        : undefined,
    });
  }

  /** A failed task for an operation the node was lost before it was sent (see nodeLossHttpError); its ID. */
  recordNodeLostTask(nodeId: string, containerId: string, type: string, message: string) {
    return recordDockerNodeLostTask({ taskService: this.taskService }, nodeId, containerId, type, message);
  }

  async updateContainerEnv(
    nodeId: string,
    containerId: string,
    env: Record<string, string> | undefined,
    removeEnv: string[] | undefined,
    userId: string
  ) {
    await this.assertContainerBuildRolloutAllowed(nodeId, containerId);
    await this.assertNotAppFrozen(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.updateEnvironment(nodeId, containerId, env, removeEnv, userId)) {
      return { availabilityManaged: true };
    }
    const containerName = await this.resolveContainerName(nodeId, containerId);
    if (await this.availabilityMutationCoordinator?.updateEnvironment(nodeId, containerName, env, removeEnv, userId)) {
      return { availabilityManaged: true };
    }
    await this.assertContainerMigrationAllowed(nodeId, containerId);
    return updateDockerContainerEnv(this.containerMutationContext(), nodeId, containerId, env, removeEnv, userId);
  }

  // ─── Image operations ──────────────────────────────────────────────

  async listImages(nodeId: string) {
    await this.validateDockerNode(nodeId);
    return listDockerImages(this.imageOperationContext(), nodeId);
  }

  async decoratePublicImageSnapshot(nodeId: string, images: Array<Record<string, any>>) {
    if (!Array.isArray(images)) return images;
    const imageIds = images.map((image) => dockerImageId(image)).filter(Boolean);
    const placements =
      this.folderService && imageIds.length > 0
        ? await this.folderService.getResourcePlacementsForRefs(
            'image',
            imageIds.map((resourceKey) => ({ nodeId, resourceKey }))
          )
        : [];
    const placementById = new Map(placements.map((placement) => [placement.resourceKey, placement]));
    return images.map((image) => {
      const imageId = dockerImageId(image);
      const placement = placementById.get(imageId);
      return {
        ...image,
        scopeResourceId: imageId || null,
        folderId: placement?.folderId ?? null,
        folderIsSystem: placement?.folderIsSystem ?? false,
        folderSortOrder: placement?.sortOrder ?? 0,
      };
    });
  }

  /** Raw image inventory for reconciliation and housekeeping only. */
  async listAllImages(nodeId: string) {
    await this.validateDockerNode(nodeId);
    return listAllDockerImages(this.imageOperationContext(), nodeId);
  }

  async pullImage(
    nodeId: string,
    imageRef: string,
    registryAuth?: string,
    userId?: string,
    registryId?: string,
    folderId?: string | null,
    actorScopes?: string[]
  ) {
    if (actorScopes) {
      await assertDockerCreationAccess(this.db, actorScopes, 'docker:images:pull', nodeId, folderId, 'image');
    }
    await this.validateDockerNode(nodeId);
    const images = userId ? await this.listAllImages(nodeId) : [];
    if (!Array.isArray(images))
      throw new AppError(502, 'DOCKER_IMAGE_INVENTORY_UNAVAILABLE', 'Image inventory is unavailable');
    return pullDockerImage(
      this.imageOperationContext(new Set(images.map(dockerImageId))),
      nodeId,
      imageRef,
      registryAuth,
      userId,
      registryId,
      folderId
    );
  }

  async pullImageImmediate(
    nodeId: string,
    imageRef: string,
    registryAuth?: string,
    folderId?: string | null,
    userId?: string,
    actorScopes?: string[]
  ) {
    if (actorScopes) {
      await assertDockerCreationAccess(this.db, actorScopes, 'docker:images:pull', nodeId, folderId, 'image');
    }
    return this.pullImageNow(nodeId, imageRef, registryAuth, folderId, userId);
  }

  /**
   * Pull the image of a container or deployment that is about to be created at `workloadFolderId` (a container
   * folder) or at the node root. Creating that workload pulls the image anyway, so the destination's
   * docker:containers:create authorizes the pull; docker:images:pull is not needed. The image is not placed into
   * any image folder: it belongs to no image folder the caller could pick.
   */
  async pullImageForWorkload(
    nodeId: string,
    imageRef: string,
    registryAuth: string | undefined,
    workloadFolderId: string | null | undefined,
    userId: string,
    actorScopes: string[]
  ) {
    await assertDockerCreationAccess(this.db, actorScopes, 'docker:containers:create', nodeId, workloadFolderId);
    return this.pullImageNow(nodeId, imageRef, registryAuth, null, userId);
  }

  private async pullImageNow(
    nodeId: string,
    imageRef: string,
    registryAuth: string | undefined,
    folderId: string | null | undefined,
    userId: string | undefined
  ) {
    await this.validateDockerNode(nodeId);
    const images = userId ? await this.listAllImages(nodeId) : [];
    if (!Array.isArray(images))
      throw new AppError(502, 'DOCKER_IMAGE_INVENTORY_UNAVAILABLE', 'Image inventory is unavailable');
    const result = await this.nodeDispatch.sendDockerImageCommand(
      nodeId,
      'pull',
      { imageRef, registryAuthJson: registryAuth },
      DockerManagementService.LONG_DOCKER_OPERATION_TIMEOUT_MS
    );
    const data = this.parseResult(result);
    if (userId) {
      await this.imageOperationContext(new Set(images.map(dockerImageId))).onImagePulled?.(
        nodeId,
        imageRef,
        folderId,
        userId
      );
    }
    return data;
  }

  async removeImage(nodeId: string, imageId: string, force: boolean, userId: string | null) {
    await this.validateDockerNode(nodeId);
    const images = await listAllDockerImages(this.imageOperationContext(), nodeId);
    const imageList = Array.isArray(images) ? images : [];
    const image = resolveDockerImageByIdentifier(imageList, imageId);
    if (!image) {
      throw new AppError(404, 'DOCKER_IMAGE_NOT_FOUND', 'Docker image was not found');
    }
    if (findOpfieldInternalImage(imageList, imageId)) {
      throw new AppError(409, 'OPFIELD_INTERNAL_IMAGE', 'Opfield-owned images cannot be removed manually');
    }
    const canonicalImageId = dockerImageId(image);
    if (!canonicalImageId) {
      throw new AppError(404, 'DOCKER_IMAGE_NOT_FOUND', 'Docker image was not found');
    }
    await removeDockerImage(this.imageOperationContext(), nodeId, canonicalImageId, force, userId);
  }

  async removeOpfieldInternalImage(nodeId: string, imageId: string) {
    await this.validateDockerNode(nodeId);
    const images = await listAllDockerImages(this.imageOperationContext(), nodeId);
    const image = findOpfieldInternalImage(Array.isArray(images) ? images : [], imageId);
    if (!image) {
      throw new AppError(404, 'OPFIELD_INTERNAL_IMAGE_NOT_FOUND', 'Opfield-owned image was not found');
    }
    const canonicalImageId = dockerImageId(image);
    if (!canonicalImageId) {
      throw new AppError(404, 'OPFIELD_INTERNAL_IMAGE_NOT_FOUND', 'Opfield-owned image was not found');
    }
    await removeDockerImage(this.imageOperationContext(), nodeId, canonicalImageId, false, null);
  }

  /**
   * A system removal of an image no container uses, Opfield's build images included (the image cleanup settings and
   * housekeeping). Never forced: Docker refuses an image a running or stopped container uses.
   */
  async removeUnusedImage(nodeId: string, imageId: string, userId: string | null = null) {
    await removeDockerImage(this.imageOperationContext(), nodeId, imageId, false, userId);
  }

  /**
   * What a prune of the node would remove, removing nothing: the dangling images it removes at once and the images
   * the image cleanup rules remove now (`removable`), and those the rules remove only once their wait is over
   * (`waiting`, with `removableAt`). Each with its reason. Like any cleanup it starts the wait of newly unused images.
   */
  async previewPruneImages(nodeId: string): Promise<DockerImagePrunePreview> {
    await this.validateDockerNode(nodeId);
    const images = await this.listAllImages(nodeId);
    const dangling = Array.isArray(images) ? selectDanglingImages(images) : [];
    const rules = this.imageCleanupService
      ? await this.imageCleanupService.enforceNode(nodeId, { dryRun: true })
      : { candidates: [], waiting: [] };
    return buildImagePrunePreview(nodeId, dangling, rules);
  }

  /**
   * Removes the dangling images, then applies the image cleanup settings to the node's build images: each container
   * keeps the build it runs and its rollback builds, the rest goes.
   */
  async pruneImages(nodeId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    const data = await pruneDockerImages(this.imageOperationContext(), nodeId, userId);
    if (!this.imageCleanupService) return data;
    const builds = await this.imageCleanupService.enforceNode(nodeId, { userId });
    return {
      ImagesDeleted: [...data.ImagesDeleted, ...builds.removed],
      SpaceReclaimed: data.SpaceReclaimed + builds.freedBytes,
    };
  }

  // ─── Volume operations ─────────────────────────────────────────────

  async listVolumes(nodeId: string) {
    await this.validateDockerNode(nodeId);
    return listDockerVolumes(this.volumeNetworkOperationContext(), nodeId);
  }

  /** Reject per-volume user operations on volumes hidden from the user volume list. */
  async assertUserVolumeVisible(nodeId: string, name: string) {
    await this.validateDockerNode(nodeId);
    await assertDockerUserVolumeVisible(this.volumeNetworkOperationContext(), nodeId, name);
  }

  async inspectVolume(nodeId: string, name: string) {
    await this.validateDockerNode(nodeId);
    return inspectDockerVolume(this.volumeNetworkOperationContext(), nodeId, name);
  }

  async listVolumeFiles(nodeId: string, name: string, path: string) {
    await this.validateDockerNode(nodeId);
    return listDockerVolumeFiles(this.volumeNetworkOperationContext(), nodeId, name, path);
  }

  async readVolumeFile(nodeId: string, name: string, path: string) {
    await this.validateDockerNode(nodeId);
    return readDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path);
  }

  async writeVolumeFile(nodeId: string, name: string, path: string, content: string | Buffer, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await writeDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path, content, userId);
  }

  async createVolumeFile(nodeId: string, name: string, path: string, content: string | Buffer, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await createDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path, content, userId);
  }

  async initVolumeFileUpload(nodeId: string, name: string, path: string, totalBytes: number, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    return initDockerVolumeFileUpload(this.volumeNetworkOperationContext(), nodeId, name, path, totalBytes, userId);
  }

  async appendVolumeFileUploadChunk(nodeId: string, name: string, uploadId: string, offset: number, content: Buffer) {
    await this.validateDockerNode(nodeId);
    return appendDockerVolumeFileUploadChunk(
      this.volumeNetworkOperationContext(),
      nodeId,
      name,
      uploadId,
      offset,
      content
    );
  }

  async completeVolumeFileUpload(nodeId: string, name: string, uploadId: string, path: string, totalBytes: number) {
    await this.validateDockerNode(nodeId);
    await completeDockerVolumeFileUpload(
      this.volumeNetworkOperationContext(),
      nodeId,
      name,
      uploadId,
      path,
      totalBytes
    );
  }

  async abortVolumeFileUpload(nodeId: string, name: string, uploadId: string) {
    await this.validateDockerNode(nodeId);
    await abortDockerVolumeFileUpload(this.volumeNetworkOperationContext(), nodeId, name, uploadId);
  }

  async createVolumeDirectory(nodeId: string, name: string, path: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await createDockerVolumeDirectory(this.volumeNetworkOperationContext(), nodeId, name, path, userId);
  }

  async deleteVolumeFile(nodeId: string, name: string, path: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await deleteDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, path, userId);
  }

  async moveVolumeFile(nodeId: string, name: string, fromPath: string, toPath: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await moveDockerVolumeFile(this.volumeNetworkOperationContext(), nodeId, name, fromPath, toPath, userId);
  }

  async exportVolume(nodeId: string, name: string) {
    await this.validateDockerNode(nodeId);
    return exportDockerVolume(this.volumeNetworkOperationContext(), nodeId, name);
  }

  async renameVolume(nodeId: string, name: string, newName: string, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await renameDockerVolume(this.volumeNetworkOperationContext(), nodeId, name, newName, userId);
    await this.folderService?.renameResourceAssignment(nodeId, 'volume', name, newName);
  }

  async updateVolumeLabels(nodeId: string, name: string, labels: Record<string, string>, userId: string) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await updateDockerVolumeLabels(this.volumeNetworkOperationContext(), nodeId, name, labels, userId);
  }

  async createVolume(
    nodeId: string,
    config: { name: string; storageKind?: 'regular' | 'disk-image'; capacityBytes?: number; folderId?: string | null },
    userId: string,
    actorScopes?: string[]
  ) {
    if (actorScopes) {
      await assertDockerCreationAccess(
        this.db,
        actorScopes,
        'docker:volumes:create',
        nodeId,
        config.folderId,
        'volume'
      );
    }
    if (config.storageKind === 'disk-image') {
      return commercialModuleUnavailable();
    }
    await this.validateDockerNode(nodeId);
    return createDockerVolume(this.volumeNetworkOperationContext(), nodeId, config, userId);
  }

  async resizeVolume(_nodeId: string, _name: string, _capacityBytes: number, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }

  async listManagedVolumeOptions(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const rows = await this.db
      .select({ name: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async decoratePublicVolumeSnapshot(
    nodeId: string,
    volumes: Array<Record<string, any>>,
    containers: Array<Record<string, any>>
  ) {
    const managedRows = await this.db
      .select({
        volumeName: dockerManagedVolumes.volumeName,
        storageKind: dockerManagedVolumes.storageKind,
        capacityBytes: dockerManagedVolumes.capacityBytes,
      })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId));
    const managedByName = new Map(managedRows.map((row) => [row.volumeName, row]));
    const volumeNames = volumes.map((volume) => String(volume.Name ?? volume.name ?? '')).filter(Boolean);
    const placements =
      this.folderService && volumeNames.length > 0
        ? await this.folderService.getResourcePlacementsForRefs(
            'volume',
            volumeNames.map((resourceKey) => ({ nodeId, resourceKey }))
          )
        : [];
    const placementByName = new Map(placements.map((placement) => [placement.resourceKey, placement]));
    const publicContainerNames = new Set(
      containers
        .filter((entry) => !isOpfieldInternalContainer(entry))
        .flatMap((entry) => {
          const names = Array.isArray(entry.Names ?? entry.names) ? (entry.Names ?? entry.names) : [];
          const primary = String(entry.Name ?? entry.name ?? names[0] ?? '').replace(/^\//, '');
          return primary ? [primary] : [];
        })
    );
    const visible: Array<Record<string, any>> = volumes.flatMap((volume) => {
      const name = String(volume.Name ?? volume.name ?? '');
      if (!name) return [];
      const usedBy = Array.isArray(volume.UsedBy ?? volume.usedBy) ? (volume.UsedBy ?? volume.usedBy) : [];
      const managedRecord = managedByName.get(name);
      const managed = !!managedRecord;
      if (!managed && !usedBy.some((containerName: string) => publicContainerNames.has(containerName))) return [];
      const driver = String(volume.Driver ?? volume.driver ?? '');
      const scope = String(volume.Scope ?? volume.scope ?? '');
      const options = volume.Options ?? volume.options ?? {};
      const placement = placementByName.get(name);
      const adoptable = !managed && driver === 'local' && scope === 'local' && Object.keys(options ?? {}).length === 0;
      return [
        {
          ...volume,
          managementState: managed ? 'managed' : 'legacy',
          storageKind: managedRecord?.storageKind ?? 'regular',
          capacityBytes: managedRecord?.capacityBytes ?? null,
          adoptable,
          adoptionReason:
            !managed && !adoptable ? 'Only local volumes without driver options can be migrated' : undefined,
          scopeResourceId: name,
          folderId: placement?.folderId ?? null,
          folderIsSystem: placement?.folderIsSystem ?? false,
          folderSortOrder: placement?.sortOrder ?? 0,
        },
      ];
    });
    const returned = new Set(visible.map((volume) => String(volume.Name ?? volume.name ?? '')));
    for (const { volumeName, storageKind, capacityBytes } of managedRows) {
      if (!returned.has(volumeName)) {
        visible.push({
          Name: volumeName,
          Driver: 'local',
          Scope: 'local',
          UsedBy: [],
          managementState: 'managed',
          storageKind,
          capacityBytes,
          adoptable: false,
          availability: 'unavailable',
          scopeResourceId: volumeName,
          folderId: placementByName.get(volumeName)?.folderId ?? null,
          folderIsSystem: placementByName.get(volumeName)?.folderIsSystem ?? false,
          folderSortOrder: placementByName.get(volumeName)?.sortOrder ?? 0,
        });
      }
    }
    return visible;
  }

  async decoratePublicNetworkSnapshot(nodeId: string, networks: Array<Record<string, any>>) {
    if (!Array.isArray(networks)) return networks;
    const networkIds = networks.map((network) => String(network.id ?? network.Id ?? '')).filter((id) => id.length > 0);
    const [accessIds, placements] = await Promise.all([
      this.networkAccessResourceService
        ? this.networkAccessResourceService.syncNetworks(nodeId, networks)
        : new Map<string, string>(),
      this.folderService && networkIds.length > 0
        ? this.folderService.getResourcePlacementsForRefs(
            'network',
            networkIds.map((resourceKey) => ({ nodeId, resourceKey }))
          )
        : [],
    ]);
    const placementByNetworkId = new Map(placements.map((placement) => [placement.resourceKey, placement]));
    return networks.map((network) => {
      const networkId = String(network.id ?? network.Id ?? '');
      const placement = placementByNetworkId.get(networkId);
      return {
        ...network,
        scopeResourceId: accessIds.get(networkId) ?? null,
        folderId: placement?.folderId ?? null,
        folderIsSystem: placement?.folderIsSystem ?? false,
        folderSortOrder: placement?.sortOrder ?? 0,
      };
    });
  }

  async registerImportedManagedVolumes(nodeId: string, volumeNames: string[], userId: string) {
    const names = [...new Set(volumeNames.map((name) => name.trim()).filter(Boolean))];
    if (names.length === 0) return;
    await this.db
      .insert(dockerManagedVolumes)
      .values(names.map((volumeName) => ({ nodeId, volumeName, origin: 'created' as const, createdById: userId })))
      .onConflictDoNothing();
  }

  /** The mounts a container may be created with by an actor with these scopes, as its create checks them. */
  async assertCreationMounts(
    nodeId: string,
    config: Parameters<typeof normalizeMountDefinitionsFromConfig>[0],
    actorScopes: string[]
  ) {
    assertDockerMountChangeAllowed({ nodeId, actorScopes, nextConfig: config, currentDefinitions: [] });
    await assertManagedMountMutation({
      db: this.db,
      dispatch: this.nodeDispatch,
      parseResult: (result) => this.parseResult(result),
      nodeId,
      current: [],
      next: normalizeMountDefinitionsFromConfig(config),
    });
  }

  async assertManagedVolumeSelections(nodeId: string, volumeNames: string[]) {
    await assertManagedMountMutation({
      db: this.db,
      dispatch: this.nodeDispatch,
      parseResult: (result) => this.parseResult(result),
      nodeId,
      current: [],
      next: [...new Set(volumeNames)].map((source, index) => ({
        type: 'volume' as const,
        source,
        target: `/__opfield_archive_mount_${index}`,
        readOnly: false,
      })),
    });
  }

  async removeVolume(nodeId: string, name: string, force: boolean, userId: string | null) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    // Also reached outside the volume routes (AI tools): never remove a volume
    // that the user volume list hides. Housekeeping uses removeOrphanedAnonymousVolume.
    await assertDockerUserVolumeVisible(this.volumeNetworkOperationContext(), nodeId, name);
    await removeDockerVolume(this.volumeNetworkOperationContext(), nodeId, name, force, userId);
  }

  /**
   * The size of every volume on the node by name, from one disk-usage walk on the node (the summed file sizes, as the
   * volume metrics count them); null when the node's daemon is too old to answer it (docker_volume_sizes_v1).
   */
  async volumeSizes(nodeId: string): Promise<Map<string, number> | null> {
    await this.validateDockerNode(nodeId);
    if (!this.nodeRegistry.hasCapability(nodeId, DOCKER_VOLUME_SIZES_CAPABILITY)) return null;
    const result = await this.nodeDispatch.sendDockerVolumeCommand(nodeId, 'sizes', {}, VOLUME_SIZES_TIMEOUT_MS);
    const parsed = this.parseResult(result);
    const sizes = new Map<string, number>();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [name, size] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof size === 'number' && Number.isFinite(size) && size >= 0) sizes.set(name, size);
      }
    }
    return sizes;
  }

  /** Housekeeping inventory: every volume on the node, including the ones hidden from the user list. */
  async listHousekeepingVolumes(nodeId: string) {
    await this.validateDockerNode(nodeId);
    const volumes = await listAllDockerVolumes(this.volumeNetworkOperationContext(), nodeId);
    if (!Array.isArray(volumes)) return volumes;
    // Managed volumes (created or adopted, anonymous ones included) are never orphan candidates.
    const managed = await opfieldManagedVolumeNames(this.db, nodeId);
    return volumes.filter((volume: Record<string, any>) => {
      const name = String(volume?.Name ?? volume?.name ?? '');
      const labels = volume?.Labels ?? volume?.labels;
      return !managed.has(name) && !isDockerManagedVolumeLabelled(labels);
    });
  }

  /**
   * Housekeeping removal of an orphaned anonymous volume. Those volumes are
   * hidden from the user list, so the visibility check is skipped; the
   * migration guard applies and the name and unused state are re-checked.
   */
  async removeOrphanedAnonymousVolume(nodeId: string, name: string, userId: string | null) {
    await this.migrationGuard?.assertVolumeAllowed(nodeId, name);
    await this.validateDockerNode(nodeId);
    await removeOrphanedAnonymousDockerVolume(this.volumeNetworkOperationContext(), nodeId, name, userId);
  }

  async adoptVolume(nodeId: string, name: string, userId: string) {
    await this.validateDockerNode(nodeId);
    return adoptDockerVolume(this.volumeNetworkOperationContext(), nodeId, name, userId);
  }

  protected secureRuntimeContext() {
    return {
      db: this.db,
      nodeRegistry: this.nodeRegistry,
      nodeDispatch: this.nodeDispatch,
      validateDockerNode: (nodeId: string) => this.validateDockerNode(nodeId),
      assertVolumeAllowed: (nodeId: string, name: string) => this.migrationGuard?.assertVolumeAllowed(nodeId, name),
      parseResult: (result: { success: boolean; error?: string; detail?: string }) => this.parseResult(result),
    };
  }

  async manageRunsc(_nodeId: string, _action: 'preflight' | 'install'): Promise<DockerRuntimeStatus> {
    return commercialModuleUnavailable();
  }

  /**
   * A build rollout owns its container until it finishes: user mutations are
   * refused (409) instead of racing the recreate or being overwritten by it.
   * Runs before Availability routing so a managed workload is covered too.
   */
  private async assertContainerBuildRolloutAllowed(nodeId: string, containerId: string): Promise<void> {
    await this.buildRolloutGuard?.assertContainerAllowed(async () => {
      const name = await this.resolveContainerName(nodeId, containerId);
      const identities = [
        { nodeId, containerName: containerId },
        { nodeId, containerName: name },
      ];
      const managed = await this.getManagedContainerConfiguration(nodeId, name).catch(() => null);
      if (managed) identities.push({ nodeId: managed.nodeId, containerName: managed.containerName });
      return identities;
    });
  }

  /**
   * The guard is checked before a mutation claims the container as a fast
   * path, and again after: a migration admitted in between has written its
   * row by the time the claim (and its lease) succeeded.
   */
  private async recheckMigrationGuard(nodeId: string, identities: readonly string[], newName?: string): Promise<void> {
    if (!this.migrationGuard) return;
    for (const identity of new Set(identities)) await this.migrationGuard.assertContainerAllowed(nodeId, identity);
    if (newName) await this.migrationGuard.assertContainerNameAvailable(nodeId, newName);
  }

  private async assertContainerMigrationAllowed(nodeId: string, containerId: string): Promise<void> {
    if (!this.migrationGuard) return;
    const inspect = await this.inspectContainer(nodeId, containerId);
    const name = String(inspect?.Name ?? inspect?.name ?? containerId).replace(/^\//, '');
    await this.migrationGuard.assertContainerAllowed(nodeId, name);
    if (name !== containerId) await this.migrationGuard.assertContainerAllowed(nodeId, containerId);
  }

  // ─── Network operations ────────────────────────────────────────────

  async listNetworks(nodeId: string) {
    await this.validateDockerNode(nodeId);
    return listDockerNetworks(this.volumeNetworkOperationContext(), nodeId);
  }

  async createNetwork(
    nodeId: string,
    config: { name: string; driver: string; subnet?: string; gateway?: string; folderId?: string | null },
    userId: string
  ) {
    await this.validateDockerNode(nodeId);
    await this.folderService?.assertResourceDestination('network', config.folderId);
    return createDockerNetwork(this.volumeNetworkOperationContext(), nodeId, config, userId);
  }

  async removeNetwork(nodeId: string, networkId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await removeDockerNetwork(this.volumeNetworkOperationContext(), nodeId, networkId, userId);
  }

  async connectContainerToNetwork(nodeId: string, networkId: string, containerId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await this.assertNotAvailabilityManaged(nodeId, containerId, AVAILABILITY_NETWORKS_MANAGED);
    await connectDockerContainerToNetwork(this.volumeNetworkOperationContext(), nodeId, networkId, containerId, userId);
  }

  async disconnectContainerFromNetwork(nodeId: string, networkId: string, containerId: string, userId: string) {
    await this.validateDockerNode(nodeId);
    await this.assertNotAvailabilityManaged(nodeId, containerId, AVAILABILITY_NETWORKS_MANAGED);
    await disconnectDockerContainerFromNetwork(
      this.volumeNetworkOperationContext(),
      nodeId,
      networkId,
      containerId,
      userId
    );
  }

  // ─── Container stats ───────────────────────────────────────────────

  async getContainerStats(nodeId: string, containerId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    return getDockerContainerStats(this.readOperationContext(), target.nodeId, target.containerId);
  }

  async getContainerTop(nodeId: string, containerId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    return getDockerContainerTop(this.readOperationContext(), target.nodeId, target.containerId);
  }

  // ─── File browser ──────────────────────────────────────────────────

  async listDirectory(nodeId: string, containerId: string, path: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    return listDockerDirectory(this.readOperationContext(), target.nodeId, target.containerId, path);
  }

  async readFile(nodeId: string, containerId: string, path: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    return readDockerFile(this.readOperationContext(), target.nodeId, target.containerId, path);
  }

  async writeFile(nodeId: string, containerId: string, path: string, content: string | Buffer, userId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    await writeDockerFile(this.readOperationContext(), target.nodeId, target.containerId, path, content, userId);
  }

  async createFile(
    nodeId: string,
    containerId: string,
    path: string,
    content: string | Buffer | undefined,
    userId: string
  ) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    await createDockerFile(this.readOperationContext(), target.nodeId, target.containerId, path, content, userId);
  }

  async initFileUpload(nodeId: string, containerId: string, path: string, totalBytes: number, userId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    return initDockerFileUpload(
      this.readOperationContext(),
      target.nodeId,
      target.containerId,
      path,
      totalBytes,
      userId
    );
  }

  async appendFileUploadChunk(nodeId: string, containerId: string, uploadId: string, offset: number, content: Buffer) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    return appendDockerFileUploadChunk(
      this.readOperationContext(),
      target.nodeId,
      target.containerId,
      uploadId,
      offset,
      content
    );
  }

  async completeFileUpload(nodeId: string, containerId: string, uploadId: string, path: string, totalBytes: number) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    await completeDockerFileUpload(
      this.readOperationContext(),
      target.nodeId,
      target.containerId,
      uploadId,
      path,
      totalBytes
    );
  }

  async abortFileUpload(nodeId: string, containerId: string, uploadId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    await abortDockerFileUpload(this.readOperationContext(), target.nodeId, target.containerId, uploadId);
  }

  async createDirectory(nodeId: string, containerId: string, path: string, userId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    await createDockerDirectory(this.readOperationContext(), target.nodeId, target.containerId, path, userId);
  }

  async deleteFile(nodeId: string, containerId: string, path: string, userId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    await deleteDockerFile(this.readOperationContext(), target.nodeId, target.containerId, path, userId);
  }

  async moveFile(nodeId: string, containerId: string, fromPath: string, toPath: string, userId: string) {
    const target = await this.resolveRuntimeContainer(nodeId, containerId);
    await this.validateDockerNode(target.nodeId);
    await this.assertContainerMutationAllowed(nodeId, containerId);
    await moveDockerFile(this.readOperationContext(), target.nodeId, target.containerId, fromPath, toPath, userId);
  }
}
