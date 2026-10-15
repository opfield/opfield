import type { DrizzleClient } from '@/db/client.js';
import type { DockerBuildScanSummary, DockerBuildStatus, DockerBuildTrigger } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { DockerBuildEvent } from '@/grpc/generated/types.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerBuildListInput } from './docker-build-query.js';

export {
  assertSupportedDockerBuildResourcePolicy,
  canTransitionDockerBuild,
  dockerBuildLimits,
  evaluateDockerArtifactPolicy,
  expiredDockerBuildDisposition,
  redactDockerBuildLog,
} from './docker-build-policy.js';
export interface DockerBuildEnqueueInput {
  sourceBindingId: string;
  commitSha: string;
  trigger: DockerBuildTrigger;
  triggerDeliveryId?: string | null;
  createdById?: string | null;
  force?: boolean;
  /** Queue the build even while every Build Worker is paused for new builds; it is claimed once one is unlocked. */
  queueWhilePaused?: boolean;
}
export class DockerBuildService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient) {}
  setEventBus(_eventBus: EventBusService): void {}
  setAdmissionGuard(_guard: () => Promise<void>): void {}
  setLicenseGuard(_guard: () => Promise<void>): void {}
  setArtifactRollout(
    _handler: (
      buildId: string,
      leaseOwner: string,
      operationId: string
    ) => Promise<'deployed' | 'superseded' | 'pending'>
  ): void {}
  setBuildReleaseHandler(_handler: (buildId: string) => Promise<void>): void {}
  async admissionStatus(): Promise<{
    ready: boolean;
    code: string | null;
    message: string | null;
  }> {
    return { ready: false, code: 'COMMERCIAL_MODULE_UNAVAILABLE', message: 'Builds require the commercial module' };
  }
  async enqueue(_input: DockerBuildEnqueueInput): Promise<{
    build: {
      id: string;
      ref: string;
      status: DockerBuildStatus;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      repositoryRemoteId: string;
      repositoryFullPath: string;
      dockerfilePath: string;
      contextPath: string;
      buildArgs: Record<string, string>;
      applicationRoot: string;
      packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
      packageManagerVersion: string | null;
      nodeVersion: string | null;
      buildScript: string | null;
      artifactDirectory: string | null;
      publishTag: string | null;
      sourceBindingId: string;
      dedupeKey: string;
      commitSha: string;
      errorCode: string | null;
      errorMessage: string | null;
      completedAt: Date | null;
      batchId: string | null;
      trigger: DockerBuildTrigger;
      triggerDeliveryId: string | null;
      serviceName: string | null;
      sourceConfigGeneration: number;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      progress: Record<string, unknown>;
      queuedAt: Date;
      startedAt: Date | null;
    };
    builds: {
      id: string;
      ref: string;
      status: DockerBuildStatus;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      repositoryRemoteId: string;
      repositoryFullPath: string;
      dockerfilePath: string;
      contextPath: string;
      buildArgs: Record<string, string>;
      applicationRoot: string;
      packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
      packageManagerVersion: string | null;
      nodeVersion: string | null;
      buildScript: string | null;
      artifactDirectory: string | null;
      publishTag: string | null;
      sourceBindingId: string;
      dedupeKey: string;
      commitSha: string;
      errorCode: string | null;
      errorMessage: string | null;
      completedAt: Date | null;
      batchId: string | null;
      trigger: DockerBuildTrigger;
      triggerDeliveryId: string | null;
      serviceName: string | null;
      sourceConfigGeneration: number;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      progress: Record<string, unknown>;
      queuedAt: Date;
      startedAt: Date | null;
    }[];
    batch: {
      id: string;
      sourceBindingId: string;
      dedupeKey: string;
      commitSha: string;
      status: import('@/db/schema/index.js').DockerBuildBatchStatus;
      expectedServices: string[];
      composeBuildPlan: import('@/db/schema/index.js').DockerComposeBuildPlan;
      composeVariables: Record<string, string>;
      composeSecretKeys: string[];
      candidateRevisionId: string | null;
      supersededByBatchId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      updatedAt: Date;
      completedAt: Date | null;
    } | null;
    created: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async hasBuildForCommit(_sourceBindingId: string, _commitSha: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async claimNext(_input: {
    builderNodeId: string;
    leaseOwner: string;
    platform: string;
    leaseMs?: number;
    now?: Date;
    supportsScanDisable?: boolean;
  }): Promise<{
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  } | null> {
    return commercialModuleUnavailable();
  }
  async heartbeat(
    _buildId: string,
    _leaseOwner: string,
    _leaseMs?: number,
    _now?: Date
  ): Promise<{
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async beginArtifactRollout(
    _buildId: string,
    _workerLeaseOwner: string,
    _attempt: number,
    _progress: Record<string, unknown>,
    _now?: Date
  ): Promise<{
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async returnClaimToQueue(
    _buildId: string,
    _leaseOwner: string,
    _reason: string,
    _now?: Date
  ): Promise<{
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async transition(
    _buildId: string,
    _leaseOwner: string,
    _nextStatus: DockerBuildStatus,
    _input?: {
      progress?: Record<string, unknown>;
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  ): Promise<{
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async requestCancellation(
    _buildId: string,
    _userId: string
  ): Promise<{
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async retry(
    _buildId: string,
    _userId: string
  ): Promise<{
    build: {
      id: string;
      ref: string;
      status: DockerBuildStatus;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      repositoryRemoteId: string;
      repositoryFullPath: string;
      dockerfilePath: string;
      contextPath: string;
      buildArgs: Record<string, string>;
      applicationRoot: string;
      packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
      packageManagerVersion: string | null;
      nodeVersion: string | null;
      buildScript: string | null;
      artifactDirectory: string | null;
      publishTag: string | null;
      sourceBindingId: string;
      dedupeKey: string;
      commitSha: string;
      errorCode: string | null;
      errorMessage: string | null;
      completedAt: Date | null;
      batchId: string | null;
      trigger: DockerBuildTrigger;
      triggerDeliveryId: string | null;
      serviceName: string | null;
      sourceConfigGeneration: number;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      progress: Record<string, unknown>;
      queuedAt: Date;
      startedAt: Date | null;
    };
    builds: {
      id: string;
      ref: string;
      status: DockerBuildStatus;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      repositoryRemoteId: string;
      repositoryFullPath: string;
      dockerfilePath: string;
      contextPath: string;
      buildArgs: Record<string, string>;
      applicationRoot: string;
      packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
      packageManagerVersion: string | null;
      nodeVersion: string | null;
      buildScript: string | null;
      artifactDirectory: string | null;
      publishTag: string | null;
      sourceBindingId: string;
      dedupeKey: string;
      commitSha: string;
      errorCode: string | null;
      errorMessage: string | null;
      completedAt: Date | null;
      batchId: string | null;
      trigger: DockerBuildTrigger;
      triggerDeliveryId: string | null;
      serviceName: string | null;
      sourceConfigGeneration: number;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      progress: Record<string, unknown>;
      queuedAt: Date;
      startedAt: Date | null;
    }[];
    batch: {
      id: string;
      sourceBindingId: string;
      dedupeKey: string;
      commitSha: string;
      status: import('@/db/schema/index.js').DockerBuildBatchStatus;
      expectedServices: string[];
      composeBuildPlan: import('@/db/schema/index.js').DockerComposeBuildPlan;
      composeVariables: Record<string, string>;
      composeSecretKeys: string[];
      candidateRevisionId: string | null;
      supersededByBatchId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdById: string | null;
      createdAt: Date;
      updatedAt: Date;
      completedAt: Date | null;
    } | null;
    created: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async recoverExpiredLeases(_now?: Date): Promise<
    {
      id: string;
      ref: string;
      status: DockerBuildStatus;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      repositoryRemoteId: string;
      repositoryFullPath: string;
      dockerfilePath: string;
      contextPath: string;
      buildArgs: Record<string, string>;
      applicationRoot: string;
      packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
      packageManagerVersion: string | null;
      nodeVersion: string | null;
      buildScript: string | null;
      artifactDirectory: string | null;
      publishTag: string | null;
      sourceBindingId: string;
      dedupeKey: string;
      commitSha: string;
      errorCode: string | null;
      errorMessage: string | null;
      completedAt: Date | null;
      batchId: string | null;
      trigger: DockerBuildTrigger;
      triggerDeliveryId: string | null;
      serviceName: string | null;
      sourceConfigGeneration: number;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      progress: Record<string, unknown>;
      queuedAt: Date;
      startedAt: Date | null;
    }[]
  > {
    return [];
  }
  async appendLog(
    _buildId: string,
    _sequence: number,
    _content: string,
    _options?: {
      secretValues?: readonly string[];
      secretNames?: readonly string[];
    }
  ): Promise<{
    createdAt: Date;
    sequence: number;
    content: string;
    buildId: string;
    byteLength: number;
  }> {
    return commercialModuleUnavailable();
  }
  async handleDaemonEvent(
    _builderNodeId: string,
    _event: DockerBuildEvent
  ): Promise<
    | {
        id: string;
        sourceBindingId: string;
        batchId: string | null;
        dedupeKey: string;
        trigger: DockerBuildTrigger;
        triggerDeliveryId: string | null;
        repositoryRemoteId: string;
        repositoryFullPath: string;
        ref: string;
        commitSha: string;
        serviceName: string | null;
        dockerfilePath: string;
        contextPath: string;
        buildArgs: Record<string, string>;
        applicationRoot: string;
        packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
        packageManagerVersion: string | null;
        nodeVersion: string | null;
        buildScript: string | null;
        artifactDirectory: string | null;
        publishTag: string | null;
        sourceConfigGeneration: number;
        status: DockerBuildStatus;
        builderNodeId: string | null;
        platform: string | null;
        attempt: number;
        maxAttempts: number;
        leaseOwner: string | null;
        leaseHeartbeatAt: Date | null;
        leaseExpiresAt: Date | null;
        cancellationRequestedAt: Date | null;
        cancellationRequestedById: string | null;
        supersededByBuildId: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        progress: Record<string, unknown>;
        createdById: string | null;
        createdAt: Date;
        queuedAt: Date;
        startedAt: Date | null;
        updatedAt: Date;
        completedAt: Date | null;
      }
    | {
        createdAt: Date;
        sequence: number;
        content: string;
        buildId: string;
        byteLength: number;
      }
  > {
    return commercialModuleUnavailable();
  }
  async recordArtifact(_input: {
    buildId: string;
    registryRepository: string;
    digest: string;
    platform: string;
    sizeBytes: number;
    sbomDigest?: string | null;
    provenanceDigest?: string | null;
    scanSummary?: DockerBuildScanSummary | null;
  }): Promise<{
    artifact: {
      id: string;
      buildId: string | null;
      sourceBindingId: string | null;
      ownerKind: import('@/db/schema/index.js').DockerArtifactOwnerKind;
      ownerKey: string | null;
      sourceImageReference: string | null;
      registryRepository: string;
      digest: string;
      platform: string;
      sizeBytes: number;
      status: import('@/db/schema/index.js').DockerArtifactStatus;
      sbomDigest: string | null;
      provenanceDigest: string | null;
      scanSummary: DockerBuildScanSummary | null;
      policyDecision: import('@/db/schema/index.js').DockerArtifactPolicyDecision;
      policyReason: string | null;
      verifiedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
    created: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async listLogs(
    _buildId: string,
    _afterSequence?: number,
    _limit?: number
  ): Promise<
    {
      buildId: string;
      sequence: number;
      content: string;
      byteLength: number;
      createdAt: Date;
    }[]
  > {
    return [];
  }
  async listInternalRegistryRepositories(): Promise<string[]> {
    return [];
  }
  async get(_id: string): Promise<{
    provider: import('@/db/schema/index.js').IntegrationProvider;
    builderName: string | null;
    sourceAutoDeploy: boolean;
    artifact: {
      id: string;
      buildId: string | null;
      sourceBindingId: string | null;
      ownerKind: import('@/db/schema/index.js').DockerArtifactOwnerKind;
      ownerKey: string | null;
      sourceImageReference: string | null;
      registryRepository: string;
      digest: string;
      platform: string;
      sizeBytes: number;
      status: import('@/db/schema/index.js').DockerArtifactStatus;
      sbomDigest: string | null;
      provenanceDigest: string | null;
      scanSummary: DockerBuildScanSummary | null;
      policyDecision: import('@/db/schema/index.js').DockerArtifactPolicyDecision;
      policyReason: string | null;
      verifiedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
    target:
      | {
          kind: 'container';
          nodeId: string;
          containerName: string;
          name: string;
          deploymentId?: undefined;
          composeProjectId?: undefined;
          serviceName?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'deployment';
          nodeId: string;
          deploymentId: string;
          name: string;
          containerName?: undefined;
          composeProjectId?: undefined;
          serviceName?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'compose_project';
          nodeId: string;
          composeProjectId: string;
          name: string;
          serviceName: string | null;
          containerName?: undefined;
          deploymentId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'pages_project';
          nodeId: string | undefined;
          pageProjectId: string;
          name: string;
          containerName?: undefined;
          deploymentId?: undefined;
          composeProjectId?: undefined;
          serviceName?: undefined;
        };
    id: string;
    sourceBindingId: string;
    batchId: string | null;
    dedupeKey: string;
    trigger: DockerBuildTrigger;
    triggerDeliveryId: string | null;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    ref: string;
    commitSha: string;
    serviceName: string | null;
    dockerfilePath: string;
    contextPath: string;
    buildArgs: Record<string, string>;
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    sourceConfigGeneration: number;
    status: DockerBuildStatus;
    builderNodeId: string | null;
    platform: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseHeartbeatAt: Date | null;
    leaseExpiresAt: Date | null;
    cancellationRequestedAt: Date | null;
    cancellationRequestedById: string | null;
    supersededByBuildId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    progress: Record<string, unknown>;
    createdById: string | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    updatedAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async list(_input?: DockerBuildListInput): Promise<
    {
      provider: import('@/db/schema/index.js').IntegrationProvider;
      builderName: string | null;
      sourceAutoDeploy: boolean;
      artifact: {
        id: string;
        buildId: string | null;
        sourceBindingId: string | null;
        ownerKind: import('@/db/schema/index.js').DockerArtifactOwnerKind;
        ownerKey: string | null;
        sourceImageReference: string | null;
        registryRepository: string;
        digest: string;
        platform: string;
        sizeBytes: number;
        status: import('@/db/schema/index.js').DockerArtifactStatus;
        sbomDigest: string | null;
        provenanceDigest: string | null;
        scanSummary: DockerBuildScanSummary | null;
        policyDecision: import('@/db/schema/index.js').DockerArtifactPolicyDecision;
        policyReason: string | null;
        verifiedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      } | null;
      target:
        | {
            kind: 'container';
            nodeId: string;
            containerName: string;
            name: string;
            deploymentId?: undefined;
            composeProjectId?: undefined;
            serviceName?: undefined;
            pageProjectId?: undefined;
          }
        | {
            kind: 'deployment';
            nodeId: string;
            deploymentId: string;
            name: string;
            containerName?: undefined;
            composeProjectId?: undefined;
            serviceName?: undefined;
            pageProjectId?: undefined;
          }
        | {
            kind: 'compose_project';
            nodeId: string;
            composeProjectId: string;
            name: string;
            serviceName: string | null;
            containerName?: undefined;
            deploymentId?: undefined;
            pageProjectId?: undefined;
          }
        | {
            kind: 'pages_project';
            nodeId: string | undefined;
            pageProjectId: string;
            name: string;
            containerName?: undefined;
            deploymentId?: undefined;
            composeProjectId?: undefined;
            serviceName?: undefined;
          };
      id: string;
      sourceBindingId: string;
      batchId: string | null;
      dedupeKey: string;
      trigger: DockerBuildTrigger;
      triggerDeliveryId: string | null;
      repositoryRemoteId: string;
      repositoryFullPath: string;
      ref: string;
      commitSha: string;
      serviceName: string | null;
      dockerfilePath: string;
      contextPath: string;
      buildArgs: Record<string, string>;
      applicationRoot: string;
      packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
      packageManagerVersion: string | null;
      nodeVersion: string | null;
      buildScript: string | null;
      artifactDirectory: string | null;
      publishTag: string | null;
      sourceConfigGeneration: number;
      status: DockerBuildStatus;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      leaseOwner: string | null;
      leaseHeartbeatAt: Date | null;
      leaseExpiresAt: Date | null;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      progress: Record<string, unknown>;
      createdById: string | null;
      createdAt: Date;
      queuedAt: Date;
      startedAt: Date | null;
      updatedAt: Date;
      completedAt: Date | null;
    }[]
  > {
    return [];
  }
}
