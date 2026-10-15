import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { User } from '@/types.js';
import type {
  DockerBuildCreateInput,
  DockerSourceBindingUpsertInput,
  DockerSourceTarget,
  PagesBuildDiscoveryInput,
} from './docker-build.schemas.js';
import type { DockerBuildService } from './docker-build.service.js';
import type { SupportedSourceProvider } from './docker-source-mappers.js';
import type { DockerSourceWebhookResult } from './docker-source-webhook.service.js';

export type { DockerSourceWebhookResult } from './docker-source-webhook.service.js';
export interface PendingDockerSourceContainer {
  pendingSourceBuild: true;
  Id: string;
  Name: string;
  nodeId: string;
  containerName: string;
  sourceId: string;
  sourceBindingId: string;
  repositoryFullPath: string;
  created: number;
  latestBuild: {
    id: string;
    status: string;
    errorCode: string | null;
  } | null;
  scopeResourceId: string;
  initialConfig: {
    name: string;
    restartPolicy: 'no' | 'always' | 'unless-stopped' | 'on-failure';
    runtimeProfile: 'default' | 'secure';
    /** Managed volumes the first build creates the container with. */
    volumes?: Array<{ name: string; containerPath: string; readOnly: boolean }>;
  };
}
/**
 * A Git-source container its first build has not created yet (queued, building or failed) is no Docker container:
 * removing it as one is refused with 409 SOURCE_CONTAINER_NOT_BUILT, which says to delete its Git source.
 */
export async function assertNotPendingSourceContainer(nodeId: string, containerName: string): Promise<void> {
  if (!container.isRegistered(DockerSourceService)) return;
  const pending = await container
    .resolve(DockerSourceService)
    .getPendingContainer(nodeId, containerName)
    .catch(() => null);
  if (!pending) return;
  throw new AppError(
    409,
    'SOURCE_CONTAINER_NOT_BUILT',
    'This container does not exist yet: the first build of its Git source creates it. Delete its Git source to remove it.'
  );
}

export async function readPendingDockerSourceContainers(
  _db: DrizzleClient,
  nodeId: string,
  containerName?: string
): Promise<PendingDockerSourceContainer[]> {
  if (!container.isRegistered(DockerSourceService)) return [];
  const service = container.resolve(DockerSourceService);
  if (containerName === undefined) return service.listPendingContainers(nodeId);
  const pending = await service.getPendingContainer(nodeId, containerName);
  return pending ? [pending] : [];
}
export class DockerSourceService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _integrations: IntegrationsService,
    _cryptoService: CryptoService
  ) {}
  setBuildService(_buildService: DockerBuildService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async get(_target: DockerSourceTarget): Promise<{
    id: string;
    target:
      | {
          kind: 'container';
          nodeId: string;
          containerName: string;
          deploymentId?: undefined;
          composeProjectId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'deployment';
          deploymentId: string;
          nodeId?: undefined;
          containerName?: undefined;
          composeProjectId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'compose_project';
          composeProjectId: string;
          nodeId?: undefined;
          containerName?: undefined;
          deploymentId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'pages_project';
          pageProjectId: string;
          nodeId?: undefined;
          containerName?: undefined;
          deploymentId?: undefined;
          composeProjectId?: undefined;
        };
    connectorId: string;
    projectId: string;
    provider: SupportedSourceProvider;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    repositoryCloneUrl: string;
    branch: string;
    dockerfilePath: string;
    contextPath: string;
    composeFilePath: string | null;
    composeVariables: Record<string, string>;
    composeSecretKeys: string[];
    /** Services of the Compose file the source last resolved; null for other targets or before it resolved. */
    composeServiceNames: string[] | null;
    autoBuild: boolean;
    autoDeploy: boolean;
    buildArgs: Record<string, string>;
    buildSecretNames: string[];
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    policy: import('@/db/schema/index.js').DockerBuildPolicySnapshot;
    desiredCommitSha: string | null;
    deployedCommitSha: string | null;
    lastResolvedAt: Date | null;
    lastPollAt: Date | null;
    lastPollError: string | null;
    webhookConfiguredAt: Date | null;
    lastWebhookAt: Date | null;
    lastWebhookError: string | null;
    webhookPath: string;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return null;
  }
  async getPendingContainer(_nodeId: string, _containerName: string): Promise<PendingDockerSourceContainer | null> {
    return null;
  }
  async listPendingContainers(_nodeId: string): Promise<PendingDockerSourceContainer[]> {
    return [];
  }
  async upsert(
    _input: DockerSourceBindingUpsertInput,
    _user: User,
    _options?: {
      allowMissingTarget?: boolean;
      initialConfig?: Record<string, unknown> | null;
      createOnly?: boolean;
    }
  ): Promise<{
    id: string;
    target:
      | {
          kind: 'container';
          nodeId: string;
          containerName: string;
          deploymentId?: undefined;
          composeProjectId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'deployment';
          deploymentId: string;
          nodeId?: undefined;
          containerName?: undefined;
          composeProjectId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'compose_project';
          composeProjectId: string;
          nodeId?: undefined;
          containerName?: undefined;
          deploymentId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'pages_project';
          pageProjectId: string;
          nodeId?: undefined;
          containerName?: undefined;
          deploymentId?: undefined;
          composeProjectId?: undefined;
        };
    connectorId: string;
    projectId: string;
    provider: SupportedSourceProvider;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    repositoryCloneUrl: string;
    branch: string;
    dockerfilePath: string;
    contextPath: string;
    composeFilePath: string | null;
    composeVariables: Record<string, string>;
    composeSecretKeys: string[];
    /** Services of the Compose file the source last resolved; null for other targets or before it resolved. */
    composeServiceNames: string[] | null;
    autoBuild: boolean;
    autoDeploy: boolean;
    buildArgs: Record<string, string>;
    buildSecretNames: string[];
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    policy: import('@/db/schema/index.js').DockerBuildPolicySnapshot;
    desiredCommitSha: string | null;
    deployedCommitSha: string | null;
    lastResolvedAt: Date | null;
    lastPollAt: Date | null;
    lastPollError: string | null;
    webhookConfiguredAt: Date | null;
    lastWebhookAt: Date | null;
    lastWebhookError: string | null;
    webhookPath: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async remove(_target: DockerSourceTarget, _userId: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async resolveCurrent(
    _target: DockerSourceTarget,
    _user: User
  ): Promise<{
    id: string;
    target:
      | {
          kind: 'container';
          nodeId: string;
          containerName: string;
          deploymentId?: undefined;
          composeProjectId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'deployment';
          deploymentId: string;
          nodeId?: undefined;
          containerName?: undefined;
          composeProjectId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'compose_project';
          composeProjectId: string;
          nodeId?: undefined;
          containerName?: undefined;
          deploymentId?: undefined;
          pageProjectId?: undefined;
        }
      | {
          kind: 'pages_project';
          pageProjectId: string;
          nodeId?: undefined;
          containerName?: undefined;
          deploymentId?: undefined;
          composeProjectId?: undefined;
        };
    connectorId: string;
    projectId: string;
    provider: SupportedSourceProvider;
    repositoryRemoteId: string;
    repositoryFullPath: string;
    repositoryCloneUrl: string;
    branch: string;
    dockerfilePath: string;
    contextPath: string;
    composeFilePath: string | null;
    composeVariables: Record<string, string>;
    composeSecretKeys: string[];
    /** Services of the Compose file the source last resolved; null for other targets or before it resolved. */
    composeServiceNames: string[] | null;
    autoBuild: boolean;
    autoDeploy: boolean;
    buildArgs: Record<string, string>;
    buildSecretNames: string[];
    applicationRoot: string;
    packageManager: import('@/db/schema/index.js').PagesBuildPackageManager | null;
    packageManagerVersion: string | null;
    nodeVersion: string | null;
    buildScript: string | null;
    artifactDirectory: string | null;
    publishTag: string | null;
    policy: import('@/db/schema/index.js').DockerBuildPolicySnapshot;
    desiredCommitSha: string | null;
    deployedCommitSha: string | null;
    lastResolvedAt: Date | null;
    lastPollAt: Date | null;
    lastPollError: string | null;
    webhookConfiguredAt: Date | null;
    lastWebhookAt: Date | null;
    lastWebhookError: string | null;
    webhookPath: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async sync(
    _target: DockerSourceTarget,
    _user: User
  ): Promise<{
    source: NonNullable<Awaited<ReturnType<DockerSourceService['get']>>>;
    changed: boolean;
    build: Awaited<ReturnType<DockerBuildService['enqueue']>>['build'] | null;
  }> {
    return commercialModuleUnavailable();
  }
  async pollDue(
    _now?: Date,
    _limit?: number
  ): Promise<{
    checked: number;
    changed: number;
    failed: number;
  }> {
    return { checked: 0, changed: 0, failed: 0 };
  }
  async createBuild(
    _target: DockerSourceTarget,
    _input: DockerBuildCreateInput,
    _user: User
  ): Promise<{
    build: {
      id: string;
      ref: string;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      status: import('@/db/schema/index.js').DockerBuildStatus;
      completedAt: Date | null;
      startedAt: Date | null;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
      sourceBindingId: string;
      progress: Record<string, unknown>;
      leaseHeartbeatAt: Date | null;
      errorCode: string | null;
      errorMessage: string | null;
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
      dedupeKey: string;
      commitSha: string;
      batchId: string | null;
      trigger: import('@/db/schema/index.js').DockerBuildTrigger;
      triggerDeliveryId: string | null;
      serviceName: string | null;
      sourceConfigGeneration: number;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      queuedAt: Date;
    };
    builds: {
      id: string;
      ref: string;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      status: import('@/db/schema/index.js').DockerBuildStatus;
      completedAt: Date | null;
      startedAt: Date | null;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
      sourceBindingId: string;
      progress: Record<string, unknown>;
      leaseHeartbeatAt: Date | null;
      errorCode: string | null;
      errorMessage: string | null;
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
      dedupeKey: string;
      commitSha: string;
      batchId: string | null;
      trigger: import('@/db/schema/index.js').DockerBuildTrigger;
      triggerDeliveryId: string | null;
      serviceName: string | null;
      sourceConfigGeneration: number;
      builderNodeId: string | null;
      platform: string | null;
      attempt: number;
      maxAttempts: number;
      cancellationRequestedAt: Date | null;
      cancellationRequestedById: string | null;
      supersededByBuildId: string | null;
      queuedAt: Date;
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
  webhookSecret(_sourceBindingId: string): string {
    return commercialModuleUnavailable();
  }
  async reconcileWebhooks(_limit?: number): Promise<{
    checked: number;
    configured: number;
    failed: number;
  }> {
    return { checked: 0, configured: 0, failed: 0 };
  }
  async handleWebhook(
    _sourceBindingId: string,
    _headers: Headers,
    _rawBody: Buffer
  ): Promise<DockerSourceWebhookResult> {
    return commercialModuleUnavailable();
  }
  async discoverPagesBuild(
    _input: PagesBuildDiscoveryInput,
    _user: User
  ): Promise<{
    commitSha: string;
    packagePath: string;
    scripts: {
      [k: string]: string;
    };
    packageManagers: ('npm' | 'pnpm' | 'yarn')[];
    preferredPackageManager: string | null;
    packageManagerVersion: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async listBuildSecrets(_target: DockerSourceTarget): Promise<
    {
      id: string;
      name: string;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async upsertBuildSecret(
    _target: DockerSourceTarget,
    _name: string,
    _value: string,
    _userId: string
  ): Promise<{
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteBuildSecret(_target: DockerSourceTarget, _name: string, _userId: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async getDecryptedBuildSecrets(_sourceBindingId: string): Promise<Record<string, Buffer>> {
    return commercialModuleUnavailable();
  }
}
