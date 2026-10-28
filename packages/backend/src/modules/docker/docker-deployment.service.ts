import type { DrizzleClient } from '@/db/client.js';
import type {
  DockerDeploymentDesiredConfig,
  DockerDeploymentSlot,
  dockerDeploymentReleases,
  dockerDeploymentRoutes,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerWebhooks,
} from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { AutomaticDeployAuthority } from './automatic-deploy-authority.js';
import type { DockerAccessResourceService } from './docker-access-resource.service.js';
import type { DockerBuildRolloutGuard } from './docker-build-rollout-guard.js';
import type {
  DockerDeploymentCreateInput,
  DockerDeploymentDeployInput,
  DockerDeploymentSwitchInput,
  DockerDeploymentUpdateInput,
} from './docker-deployment.schemas.js';
import type { DockerHealthCheckDto, DockerHealthCheckService } from './docker-health-check.service.js';
import type { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import type { DockerMigrationGuard } from './docker-migration-guard.js';
import type { DockerRegistryService } from './docker-registry.service.js';
import type { DockerSecretService } from './docker-secret.service.js';
import type { DockerTaskService } from './docker-task.service.js';

type DeploymentRow = typeof dockerDeployments.$inferSelect;
type DeploymentRouteRow = typeof dockerDeploymentRoutes.$inferSelect;
type DeploymentSlotRow = typeof dockerDeploymentSlots.$inferSelect;
type DeploymentReleaseRow = typeof dockerDeploymentReleases.$inferSelect;
type DeploymentTransition =
  | 'creating'
  | 'deploying'
  | 'switching'
  | 'rolling_back'
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'killing'
  | 'removing'
  | 'updating';
export interface DockerDeploymentDetail extends DeploymentRow {
  routes: DeploymentRouteRow[];
  slots: DeploymentSlotRow[];
  releases: DeploymentReleaseRow[];
  webhook?: typeof dockerWebhooks.$inferSelect | null;
  healthCheck?: DockerHealthCheckDto | null;
  _transition?: DeploymentTransition;
}
export interface DockerDeploymentSummary extends DeploymentRow {
  routes: DeploymentRouteRow[];
  slots: DeploymentSlotRow[];
  healthCheck?: Pick<DockerHealthCheckDto, 'id' | 'enabled' | 'healthStatus' | 'lastHealthCheckAt'> | null;
  _transition?: DeploymentTransition;
}
export class DockerDeploymentService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _audit: AuditService,
    _dispatch: NodeDispatchService,
    _registry: DockerRegistryService,
    _tasks: DockerTaskService,
    _nodeRegistry: NodeRegistryService,
    _secrets?: DockerSecretService | undefined
  ) {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  setEventBus(_bus: EventBusService): void {}
  setHealthCheckService(_service: DockerHealthCheckService): void {}
  setImageCleanupService(_service: DockerImageCleanupService): void {}
  setMigrationGuard(_guard: DockerMigrationGuard): void {}
  setBuildRolloutGuard(_guard: DockerBuildRolloutGuard): void {}
  setAccessResourceService(_service: DockerAccessResourceService): void {}
  setAvailabilityCoordinator(
    _coordinator: NonNullable<{
      isManaged(deploymentId: string): Promise<boolean>;
      deploy?(
        deploymentId: string,
        input: DockerDeploymentDeployInput & { desiredConfig?: DockerDeploymentDesiredConfig },
        targetActiveSlot: 'blue' | 'green',
        userId: string | null,
        source: string,
        releaseId: string
      ): Promise<{ desiredConfig: DockerDeploymentDesiredConfig; shouldRun: boolean; activeSlot: 'blue' | 'green' }>;
      updateConfiguration(
        deploymentId: string,
        snapshot: {
          name: string;
          desiredConfig: Record<string, any>;
          health: Record<string, any>;
          routes: Array<Record<string, any>>;
          drainSeconds: number;
        },
        userId: string | null,
        reason?: string
      ): Promise<boolean>;
      setRunning(deploymentId: string, running: boolean, userId: string | null, restart?: boolean): Promise<boolean>;
      switchSlot(deploymentId: string, targetActiveSlot: 'blue' | 'green', userId: string | null): Promise<boolean>;
    }>
  ): void {}
  async list(_nodeId: string): Promise<DockerDeploymentDetail[]> {
    return [];
  }
  async listSummary(_nodeId: string): Promise<DockerDeploymentSummary[]> {
    return [];
  }
  async syntheticRows(_nodeId: string): Promise<
    {
      _transition?: DeploymentTransition | undefined;
      id: string;
      name: string;
      image: string;
      state: string;
      status: string;
      created: number;
      ports: {
        privatePort: number;
        publicPort: number;
        type: string;
      }[];
      labels: Record<string, unknown>;
      kind: string;
      deploymentId: string;
      activeSlot: DockerDeploymentSlot;
      primaryRoute: {
        hostPort: number;
        containerPort: number;
      } | null;
      activeSlotContainerId: string | null;
      healthCheckId: string | null;
      healthCheckEnabled: boolean;
      healthStatus: 'stopped' | import('@/db/schema/index.js').DockerHealthStatus;
      lastHealthCheckAt: Date | null;
      folderId: null;
      folderIsSystem: boolean;
      folderSortOrder: number;
    }[]
  > {
    return [];
  }
  async get(_nodeId: string, _deploymentId: string): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async createPending(
    _nodeId: string,
    _input: DockerDeploymentCreateInput,
    _userId: string,
    _actorScopes?: string[]
  ): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async activatePending(
    _nodeId: string,
    _deploymentId: string,
    _image: string,
    _userId: string | null,
    _source?: string,
    _actorScopes?: string[]
  ): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async discardPending(_nodeId: string, _deploymentId: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async create(
    _nodeId: string,
    _input: DockerDeploymentCreateInput,
    _userId: string,
    _actorScopes?: string[]
  ): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async update(
    _nodeId: string,
    _deploymentId: string,
    _input: DockerDeploymentUpdateInput,
    _userId: string,
    _actorScopes?: string[]
  ): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async setManagedDatabaseBindingNetwork(
    _nodeId: string,
    _deploymentId: string,
    _networkName: string,
    _enabled: boolean,
    _userId: string | null,
    _forceRollout?: boolean,
    _targetEnvironment?: Record<string, string>
  ): Promise<
    DockerDeploymentDetail & {
      bindingRolloutPending: boolean;
    }
  > {
    return commercialModuleUnavailable();
  }
  async setManagedStorageBindingNetwork(
    _nodeId: string,
    _deploymentId: string,
    _networkName: string,
    _enabled: boolean,
    _userId: string | null,
    _targetEnvironment?: Record<string, string>,
    _forceRollout?: boolean
  ): Promise<
    DockerDeploymentDetail & {
      bindingRolloutPending: boolean;
    }
  > {
    return commercialModuleUnavailable();
  }
  async managedBindingNetworkApplied(_nodeId: string, _deploymentId: string, _networkName: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  /** Rolls a serving deployment out so its new slot reaches its database links the way they are served now (D9). */
  async rolloutForLinkTransport(_nodeId: string, _deploymentId: string, _userId: string | null): Promise<void> {
    return commercialModuleUnavailable();
  }
  /**
   * Saves (or drops) a container link network in the deployment. Without `rollout` its running slots join (leave) it
   * live; with it (the link sets variables) the deployment rolls out like for a managed link.
   */
  async setContainerLinkNetwork(
    _nodeId: string,
    _deploymentId: string,
    _networkName: string,
    _enabled: boolean,
    _userId: string | null,
    _options?: { rollout?: boolean; forceRollout?: boolean }
  ): Promise<
    DockerDeploymentDetail & {
      bindingRolloutPending: boolean;
    }
  > {
    return commercialModuleUnavailable();
  }
  async deploy(
    _nodeId: string,
    _deploymentId: string,
    _input: DockerDeploymentDeployInput,
    _userId: string | null,
    _source?: string,
    _actorScopes?: string[],
    _rollbackConfig?: DockerDeploymentDesiredConfig
  ): Promise<
    | DockerDeploymentDetail
    | {
        deploymentDeferred: boolean;
        routes: DeploymentRouteRow[];
        slots: DeploymentSlotRow[];
        releases: DeploymentReleaseRow[];
        webhook?: typeof dockerWebhooks.$inferSelect | null;
        healthCheck?: DockerHealthCheckDto | null;
        _transition?: DeploymentTransition;
        id: string;
        name: string;
        status: import('@/db/schema/index.js').DockerDeploymentStatus;
        createdAt: Date;
        updatedAt: Date;
        createdById: string | null;
        nodeId: string;
        desiredConfig: DockerDeploymentDesiredConfig;
        activeSlot: DockerDeploymentSlot;
        routerName: string;
        routerImage: string;
        networkName: string;
        healthConfig: import('@/db/schema/index.js').DockerDeploymentHealthConfig;
        drainSeconds: number;
        updatedById: string | null;
      }
  > {
    return commercialModuleUnavailable();
  }
  async switchToSlot(
    _nodeId: string,
    _deploymentId: string,
    _input: DockerDeploymentSwitchInput,
    _userId: string | null,
    _releaseContext?: {
      releaseId?: string;
      image?: string;
      source?: string;
      registryId?: string;
      desiredConfig?: DockerDeploymentDesiredConfig;
    },
    _actorScopes?: string[]
  ): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async rollback(
    _nodeId: string,
    _deploymentId: string,
    _force: boolean,
    _userId: string | null,
    _actorScopes?: string[]
  ): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async stopSlot(
    _nodeId: string,
    _deploymentId: string,
    _slot: DockerDeploymentSlot,
    _userId: string | null
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async start(_nodeId: string, _deploymentId: string, _userId: string | null): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async stop(_nodeId: string, _deploymentId: string, _userId: string | null): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async restart(_nodeId: string, _deploymentId: string, _userId: string | null): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async kill(_nodeId: string, _deploymentId: string, _userId: string | null): Promise<DockerDeploymentDetail> {
    return commercialModuleUnavailable();
  }
  async remove(_nodeId: string, _deploymentId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async getWebhook(
    _nodeId: string,
    _deploymentId: string
  ): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    nodeId: string;
    deploymentId: string | null;
    containerName: string;
    targetType: 'container' | 'deployment';
    token: string | null;
    tokenHash: string | null;
    enabled: boolean;
    createdById: string | null;
    updatedById: string | null;
  } | null> {
    return commercialModuleUnavailable();
  }
  async upsertWebhook(
    _nodeId: string,
    _deploymentId: string,
    _input: {
      enabled?: boolean;
    },
    _userId: string
  ): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    nodeId: string;
    deploymentId: string | null;
    containerName: string;
    targetType: 'container' | 'deployment';
    token: string | null;
    tokenHash: string | null;
    enabled: boolean;
    createdById: string | null;
    updatedById: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteWebhook(_nodeId: string, _deploymentId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async regenerateWebhook(
    _nodeId: string,
    _deploymentId: string,
    _userId: string
  ): Promise<{
    id: string;
    nodeId: string;
    containerName: string;
    targetType: 'container' | 'deployment';
    deploymentId: string | null;
    token: string | null;
    tokenHash: string | null;
    enabled: boolean;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  /** `authority`: the account that last saved the webhook, whose current scopes the deployment runs with. */
  async triggerWebhook(
    _webhookId: string,
    _tag?: string,
    _authority?: AutomaticDeployAuthority
  ): Promise<{
    deploymentId: string;
    message: string;
    deployment: DockerDeploymentDetail;
  }> {
    return commercialModuleUnavailable();
  }
  scheduleDrainCleanup(
    _nodeId: string,
    _deploymentId: string,
    _slot: DockerDeploymentSlot,
    _delaySeconds: number,
    _expectedDrainingUntil: Date
  ): void {
    commercialModuleUnavailable();
  }
}
