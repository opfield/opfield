import type { DrizzleClient } from '@/db/client.js';
import type { DockerComposeOperationAction, dockerComposeOperations } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerBuildRolloutGuard } from '../docker-build-rollout-guard.js';
import type { DockerSecretService } from '../docker-secret.service.js';
import type { DockerSnapshotService } from '../docker-snapshot.service.js';
import type { DockerSnapshotReconciler } from '../docker-snapshot-reconciler.service.js';
import type { DockerTaskService } from '../docker-task.service.js';
import type {
  ComposeCreateInput,
  ComposeOperationInput,
  ComposeOperationListQuery,
  ComposeRevisionCreateInput,
  ComposeYamlInput,
} from './compose.schemas.js';
import type { DockerComposeDispatcher } from './compose-dispatcher.js';

type OperationRow = typeof dockerComposeOperations.$inferSelect;
export class DockerComposeService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _audit: AuditService,
    _tasks: DockerTaskService,
    _secrets: DockerSecretService,
    _snapshots?: DockerSnapshotService | undefined
  ) {}
  setDispatcher(_dispatcher: DockerComposeDispatcher): void {}
  setEventBus(_eventBus: EventBusService): void {}
  setBuildRolloutGuard(_guard: DockerBuildRolloutGuard): void {}
  setSnapshotReconciler(_reconciler: Pick<DockerSnapshotReconciler, 'refreshNow'>): void {}
  setAvailabilityCoordinator(
    _coordinator: NonNullable<{
      isManaged(projectId: string): Promise<boolean>;
      removeManaged(projectId: string, userId: string | null): Promise<boolean>;
      applyRevision(projectId: string, revisionId: string, userId: string | null): Promise<boolean>;
      setRunning(projectId: string, running: boolean, userId: string | null, restart?: boolean): Promise<boolean>;
    }>
  ): void {}
  validate(_input: ComposeYamlInput): import('./compose-policy.types.js').ComposeValidationResult {
    return commercialModuleUnavailable();
  }
  async list(_nodeId?: string): Promise<
    {
      services: {
        name: string;
        image: string;
        state: string;
        health: string;
        containerIds: string[];
      }[];
      volumeNames: string[];
      networkNames: string[];
      serviceCount: number;
      runningServiceCount: number;
      healthyServiceCount: number;
      drifted: boolean;
      scopeResourceId: string;
      folderId: string | null;
      folderSortOrder: number | null;
      lastOperation: {
        id: string;
        projectId: string;
        revisionId: string | null;
        taskId: string | null;
        idempotencyKey: string;
        action: DockerComposeOperationAction;
        status: import('@/db/schema/index.js').DockerComposeOperationStatus;
        progress: string | null;
        error: string | null;
        options: import('@/db/schema/index.js').DockerComposeOperationOptions;
        createdById: string | null;
        createdAt: Date;
        startedAt: Date | null;
        completedAt: Date | null;
      };
      id: string;
      nodeId: string;
      name: string;
      managementState: import('@/db/schema/index.js').DockerComposeManagementState;
      desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
      status: import('@/db/schema/index.js').DockerComposeProjectStatus;
      availability: import('@/db/schema/index.js').DockerComposeAvailability;
      activeRevisionId: string | null;
      observedFingerprint: string | null;
      lastSeenAt: Date | null;
      createdById: string | null;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return [];
  }
  async get(
    _nodeId: string,
    _projectId: string
  ): Promise<{
    services: {
      name: string;
      image: string;
      state: string;
      health: string;
      containerIds: string[];
    }[];
    volumeNames: string[];
    networkNames: string[];
    serviceCount: number;
    runningServiceCount: number;
    healthyServiceCount: number;
    drifted: boolean;
    scopeResourceId: string;
    activeRevision: {
      id: string;
      projectId: string;
      revisionNumber: number;
      sourceYaml: string;
      originalYaml: string;
      normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
      configDigest: string;
      variables: Record<string, string>;
      secretKeys: string[];
      sourceBindingId: string | null;
      buildBatchId: string | null;
      sourceCommitSha: string | null;
      createdById: string | null;
      createdAt: Date;
    } | null;
    revisions: {
      id: string;
      projectId: string;
      revisionNumber: number;
      sourceYaml: string;
      originalYaml: string;
      normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
      configDigest: string;
      variables: Record<string, string>;
      secretKeys: string[];
      sourceBindingId: string | null;
      buildBatchId: string | null;
      sourceCommitSha: string | null;
      createdById: string | null;
      createdAt: Date;
    }[];
    id: string;
    nodeId: string;
    name: string;
    managementState: import('@/db/schema/index.js').DockerComposeManagementState;
    desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
    status: import('@/db/schema/index.js').DockerComposeProjectStatus;
    availability: import('@/db/schema/index.js').DockerComposeAvailability;
    activeRevisionId: string | null;
    observedFingerprint: string | null;
    lastSeenAt: Date | null;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async findByName(
    _nodeId: string,
    _name: string
  ): Promise<{
    id: string;
    nodeId: string;
    name: string;
    managementState: import('@/db/schema/index.js').DockerComposeManagementState;
    desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
    status: import('@/db/schema/index.js').DockerComposeProjectStatus;
    availability: import('@/db/schema/index.js').DockerComposeAvailability;
    activeRevisionId: string | null;
    observedFingerprint: string | null;
    lastSeenAt: Date | null;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async create(
    _nodeId: string,
    _input: ComposeCreateInput,
    _userId: string,
    _actorScopes: string[]
  ): Promise<{
    project: {
      id: string;
      nodeId: string;
      name: string;
      managementState: import('@/db/schema/index.js').DockerComposeManagementState;
      desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
      status: import('@/db/schema/index.js').DockerComposeProjectStatus;
      availability: import('@/db/schema/index.js').DockerComposeAvailability;
      activeRevisionId: string | null;
      observedFingerprint: string | null;
      lastSeenAt: Date | null;
      createdById: string | null;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
    revision: {
      id: string;
      createdAt: Date;
      createdById: string | null;
      projectId: string;
      revisionNumber: number;
      sourceYaml: string;
      originalYaml: string;
      normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
      configDigest: string;
      variables: Record<string, string>;
      secretKeys: string[];
      sourceBindingId: string | null;
      buildBatchId: string | null;
      sourceCommitSha: string | null;
    };
  }> {
    return commercialModuleUnavailable();
  }
  async createPendingGitProject(
    _nodeId: string,
    _projectName: string,
    _userId: string,
    _actorScopes: string[],
    _folderId?: string | null
  ): Promise<{
    id: string;
    name: string;
    status: import('@/db/schema/index.js').DockerComposeProjectStatus;
    lastSeenAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    nodeId: string;
    updatedById: string | null;
    desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
    managementState: import('@/db/schema/index.js').DockerComposeManagementState;
    availability: import('@/db/schema/index.js').DockerComposeAvailability;
    activeRevisionId: string | null;
    observedFingerprint: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async discardPendingGitProject(_projectId: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async adopt(
    _nodeId: string,
    _projectId: string,
    _input: ComposeRevisionCreateInput,
    _userId: string,
    _actorScopes?: readonly string[]
  ): Promise<{
    project: {
      id: string;
      nodeId: string;
      name: string;
      managementState: import('@/db/schema/index.js').DockerComposeManagementState;
      desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
      status: import('@/db/schema/index.js').DockerComposeProjectStatus;
      availability: import('@/db/schema/index.js').DockerComposeAvailability;
      activeRevisionId: string | null;
      observedFingerprint: string | null;
      lastSeenAt: Date | null;
      createdById: string | null;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
    revision: {
      id: string;
      projectId: string;
      revisionNumber: number;
      sourceYaml: string;
      originalYaml: string;
      normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
      configDigest: string;
      variables: Record<string, string>;
      secretKeys: string[];
      sourceBindingId: string | null;
      buildBatchId: string | null;
      sourceCommitSha: string | null;
      createdById: string | null;
      createdAt: Date;
    };
    validation: import('./compose-policy.types.js').ComposeValidationResult;
  }> {
    return commercialModuleUnavailable();
  }
  async createRevision(
    _nodeId: string,
    _projectId: string,
    _input: ComposeRevisionCreateInput,
    _userId: string,
    _actorScopes?: readonly string[]
  ): Promise<{
    id: string;
    createdAt: Date;
    createdById: string | null;
    projectId: string;
    revisionNumber: number;
    sourceYaml: string;
    originalYaml: string;
    normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
    configDigest: string;
    variables: Record<string, string>;
    secretKeys: string[];
    sourceBindingId: string | null;
    buildBatchId: string | null;
    sourceCommitSha: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async createGitRevision(
    _nodeId: string,
    _projectId: string,
    _input: ComposeRevisionCreateInput,
    _source: {
      yaml: string;
      bindingId: string;
      batchId: string;
      commitSha: string;
    },
    _userId: string,
    _actorScopes?: readonly string[]
  ): Promise<{
    id: string;
    createdAt: Date;
    createdById: string | null;
    projectId: string;
    revisionNumber: number;
    sourceYaml: string;
    originalYaml: string;
    normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
    configDigest: string;
    variables: Record<string, string>;
    secretKeys: string[];
    sourceBindingId: string | null;
    buildBatchId: string | null;
    sourceCommitSha: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async listRevisions(_projectId: string): Promise<
    {
      id: string;
      projectId: string;
      revisionNumber: number;
      sourceYaml: string;
      originalYaml: string;
      normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
      configDigest: string;
      variables: Record<string, string>;
      secretKeys: string[];
      sourceBindingId: string | null;
      buildBatchId: string | null;
      sourceCommitSha: string | null;
      createdById: string | null;
      createdAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async listOperations(
    _nodeId: string,
    _projectId: string,
    _query: ComposeOperationListQuery
  ): Promise<{
    data: {
      id: string;
      projectId: string;
      revisionId: string | null;
      taskId: string | null;
      idempotencyKey: string;
      action: DockerComposeOperationAction;
      status: import('@/db/schema/index.js').DockerComposeOperationStatus;
      progress: string | null;
      error: string | null;
      options: import('@/db/schema/index.js').DockerComposeOperationOptions;
      createdById: string | null;
      createdAt: Date;
      startedAt: Date | null;
      completedAt: Date | null;
    }[];
    nextCursor: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async getRevisionForApi(
    _projectId: string,
    _revisionId: string
  ): Promise<{
    id: string;
    projectId: string;
    revisionNumber: number;
    sourceYaml: string;
    originalYaml: string;
    normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
    configDigest: string;
    variables: Record<string, string>;
    secretKeys: string[];
    sourceBindingId: string | null;
    buildBatchId: string | null;
    sourceCommitSha: string | null;
    createdById: string | null;
    createdAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteRevision(_nodeId: string, _projectId: string, _revisionId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deleteProject(_nodeId: string, _projectId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async startOperation(
    _nodeId: string,
    _projectId: string,
    _action: DockerComposeOperationAction,
    _input: ComposeOperationInput,
    _userId: string,
    _allowProjectDeleting?: boolean,
    _options?: { appIncident?: boolean; keepStopped?: boolean; actorScopes?: readonly string[] }
  ): Promise<OperationRow> {
    return commercialModuleUnavailable();
  }
  async recoverInterruptedOperations(_now?: Date): Promise<number> {
    return 0;
  }
  async listSecrets(
    _nodeId: string,
    _projectId: string,
    _reveal: boolean
  ): Promise<
    {
      system: boolean;
      id: string;
      key: string;
      value: string;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async createSecret(
    _nodeId: string,
    _projectId: string,
    _key: string,
    _value: string,
    _userId: string
  ): Promise<{
    id: string;
    key: string;
    value: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async updateSecret(
    _nodeId: string,
    _projectId: string,
    _secretId: string,
    _value: string,
    _userId: string
  ): Promise<{
    id: string;
    key: string;
    value: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteSecret(_nodeId: string, _projectId: string, _secretId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async resolveServiceTarget(
    _nodeId: string,
    _targetResourceId: string,
    _requireRunning?: boolean
  ): Promise<{
    project: {
      id: string;
      nodeId: string;
      name: string;
      managementState: import('@/db/schema/index.js').DockerComposeManagementState;
      desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
      status: import('@/db/schema/index.js').DockerComposeProjectStatus;
      availability: import('@/db/schema/index.js').DockerComposeAvailability;
      activeRevisionId: string | null;
      observedFingerprint: string | null;
      lastSeenAt: Date | null;
      createdById: string | null;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
    revision: {
      id: string;
      projectId: string;
      revisionNumber: number;
      sourceYaml: string;
      originalYaml: string;
      normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
      configDigest: string;
      variables: Record<string, string>;
      secretKeys: string[];
      sourceBindingId: string | null;
      buildBatchId: string | null;
      sourceCommitSha: string | null;
      createdById: string | null;
      createdAt: Date;
    };
    serviceName: string;
    service: import('@/db/schema/index.js').DockerComposeNormalizedService;
    targetResourceId: string;
  }> {
    return commercialModuleUnavailable();
  }
  async resolveLinkServiceTarget(
    _nodeId: string,
    _targetResourceId: string
  ): Promise<{
    project: {
      id: string;
      nodeId: string;
      name: string;
      managementState: import('@/db/schema/index.js').DockerComposeManagementState;
      desiredState: import('@/db/schema/index.js').DockerComposeDesiredState;
      status: import('@/db/schema/index.js').DockerComposeProjectStatus;
      availability: import('@/db/schema/index.js').DockerComposeAvailability;
      activeRevisionId: string | null;
      observedFingerprint: string | null;
      lastSeenAt: Date | null;
      createdById: string | null;
      updatedById: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
    revision: {
      id: string;
      createdAt: Date;
      createdById: string | null;
      projectId: string;
      revisionNumber: number;
      sourceYaml: string;
      originalYaml: string;
      normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
      configDigest: string;
      variables: Record<string, string>;
      secretKeys: string[];
      sourceBindingId: string | null;
      buildBatchId: string | null;
      sourceCommitSha: string | null;
    } | null;
    serviceName: string;
    service: import('@/db/schema/index.js').DockerComposeNormalizedService | null;
    targetResourceId: string;
    deferred: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async getServiceEnvironmentNames(_nodeId: string, _targetResourceId: string): Promise<Set<string>> {
    return commercialModuleUnavailable();
  }
  async applyManagedDatabaseBinding(
    _nodeId: string,
    _targetResourceId: string,
    _bindingId: string,
    _networkName: string,
    _hostAlias: string,
    _hostAddress: string | undefined,
    _environment: Record<string, string>,
    _userId: string
  ): Promise<{
    id: string;
    createdAt: Date;
    createdById: string | null;
    projectId: string;
    revisionNumber: number;
    sourceYaml: string;
    originalYaml: string;
    normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
    configDigest: string;
    variables: Record<string, string>;
    secretKeys: string[];
    sourceBindingId: string | null;
    buildBatchId: string | null;
    sourceCommitSha: string | null;
  } | null> {
    return commercialModuleUnavailable();
  }
  async removeManagedDatabaseBinding(
    _nodeId: string,
    _targetResourceId: string,
    _bindingId: string,
    _networkName: string,
    _hostAlias: string,
    _hostAddress: string | undefined,
    _environment: Record<string, string>,
    _userId: string
  ): Promise<{
    id: string;
    createdAt: Date;
    createdById: string | null;
    projectId: string;
    revisionNumber: number;
    sourceYaml: string;
    originalYaml: string;
    normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
    configDigest: string;
    variables: Record<string, string>;
    secretKeys: string[];
    sourceBindingId: string | null;
    buildBatchId: string | null;
    sourceCommitSha: string | null;
  } | null> {
    return commercialModuleUnavailable();
  }
  /**
   * A new revision with (or without) a container link on one service: its external link network and the variables the
   * link sets (as project secrets). Null when the link is saved pending (no revision yet, or an operation holds it).
   */
  async applyContainerLink(
    _nodeId: string,
    _targetResourceId: string,
    _linkId: string,
    _networkName: string,
    _environment: Record<string, string>,
    _userId: string
  ): Promise<{ id: string } | null> {
    return commercialModuleUnavailable();
  }
  async removeContainerLink(
    _nodeId: string,
    _targetResourceId: string,
    _linkId: string,
    _networkName: string,
    _environment: Record<string, string>,
    _userId: string
  ): Promise<{ id: string } | null> {
    return commercialModuleUnavailable();
  }
  async moveManagedDatabaseBindingNetwork(
    _nodeId: string,
    _targetResourceId: string,
    _bindingId: string,
    _networkName: string,
    _hostAlias: string,
    _hostAddress: string | undefined,
    _environment: Record<string, string>,
    _userId: string
  ): Promise<{
    id: string;
    createdAt: Date;
    createdById: string | null;
    projectId: string;
    revisionNumber: number;
    sourceYaml: string;
    originalYaml: string;
    normalizedModel: import('@/db/schema/index.js').DockerComposeNormalizedModel;
    configDigest: string;
    variables: Record<string, string>;
    secretKeys: string[];
    sourceBindingId: string | null;
    buildBatchId: string | null;
    sourceCommitSha: string | null;
  } | null> {
    return commercialModuleUnavailable();
  }
  async waitForOperation(
    _operationId: string,
    _timeoutMs?: number
  ): Promise<{
    id: string;
    projectId: string;
    revisionId: string | null;
    taskId: string | null;
    idempotencyKey: string;
    action: DockerComposeOperationAction;
    status: import('@/db/schema/index.js').DockerComposeOperationStatus;
    progress: string | null;
    error: string | null;
    options: import('@/db/schema/index.js').DockerComposeOperationOptions;
    createdById: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  /**
   * App promotion: a new revision of the project from another environment's revision YAML (service images pinned by
   * digest, build sections removed) with this project's own variables and secret keys, `promoted_from_revision_id`
   * set, then applied. Returns the revision and the apply operation.
   */
  async applyPromotedRevision(
    _nodeId: string,
    _projectId: string,
    _input: { sourceYaml: string; promotedFromRevisionId: string },
    _userId: string,
    _actorScopes?: readonly string[]
  ): Promise<{ revisionId: string; revisionNumber: number; operationId: string | null }> {
    return commercialModuleUnavailable();
  }
}
