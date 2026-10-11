import type { DrizzleClient } from '@/db/client.js';
import type { ManagedStorageClusterRow, StorageBindingEnvironment } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService, RelayRouteRuntime } from '@/services/relay-policy.service.js';
import type { CreateManagedStorageBindingInput } from './managed-storage.schemas.js';
export class ManagedStorageBindingsService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _nodeDispatch: NodeDispatchService,
    _dockerManagement: DockerManagementService,
    _dockerDeployments: DockerDeploymentService,
    _dockerSecrets: DockerSecretService,
    _connectorImage: string,
    _relayPolicy?:
      | Pick<
          RelayPolicyService,
          | 'ensureStorageBindingRoute'
          | 'getManagedStorageBindingRouteRuntime'
          | 'getNodeGrantBundle'
          | 'revokeOwner'
          | 'revokeStorageBindingRoute'
          | 'syncNodeGrants'
          | 'setLinkRouteTransport'
          | 'getLinkRouteTransport'
          | 'awaitSecureLinkEgress'
          | 'probeLinkRoute'
          | 'secureLinkEgressStatuses'
        >
      | undefined,
    _storageCA?: import('@/services/storage-ca.service.js').StorageCAService | undefined,
    _objectStorage?: Pick<
      import('@/modules/object-storage/object-storage.service.js').ObjectStorageService,
      'listBuckets' | 'createBucket'
    >
  ) {}
  setEventBus(_bus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async releaseContainerLinks(_nodeId: string, _containerName: string, _userId: string | null): Promise<void> {}
  async list(_clusterId: string): Promise<
    {
      id: string;
      clusterId: string;
      targetNodeId: string;
      targetType: 'container' | 'deployment';
      targetResourceId: string;
      connectorAlias: string;
      environment: StorageBindingEnvironment;
      buckets: string[];
      accessKeyId: string | null;
      status: 'error' | 'ready' | 'creating' | 'deleting';
      observedState: 'target_applied' | 'active';
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async create(
    _clusterId: string,
    _input: CreateManagedStorageBindingInput,
    _userId: string
  ): Promise<{
    id: string;
    clusterId: string;
    targetNodeId: string;
    targetType: 'container' | 'deployment';
    targetResourceId: string;
    connectorAlias: string;
    environment: StorageBindingEnvironment;
    buckets: string[];
    accessKeyId: string | null;
    status: 'error' | 'ready' | 'creating' | 'deleting';
    observedState: 'target_applied' | 'active';
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    return commercialModuleUnavailable();
  }
  async getTarget(
    _clusterId: string,
    _bindingId: string
  ): Promise<{
    targetNodeId: string;
    targetType: 'container' | 'deployment';
    targetResourceId: string;
  }> {
    return commercialModuleUnavailable();
  }
  async getRuntime(
    _clusterId: string,
    _bindingId: string
  ): Promise<{
    binding: {
      id: string;
      clusterId: string;
      targetNodeId: string;
      targetType: 'container' | 'deployment';
      targetResourceId: string;
      connectorAlias: string;
      environment: StorageBindingEnvironment;
      buckets: string[];
      accessKeyId: string | null;
      status: 'error' | 'ready' | 'creating' | 'deleting';
      observedState: 'target_applied' | 'active';
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    };
    runtime: RelayRouteRuntime | null;
  }> {
    return commercialModuleUnavailable();
  }
  async delete(
    _clusterId: string,
    _bindingId: string,
    _userId: string,
    _targetEnvironment?: Record<string, string>
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteAllForCluster(_cluster: ManagedStorageClusterRow, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async move(
    _clusterId: string,
    _bindingId: string,
    _targetClusterId: string,
    _userId: string
  ): Promise<{
    binding: {
      id: string;
      clusterId: string;
      targetNodeId: string;
      targetType: 'container' | 'deployment';
      targetResourceId: string;
      connectorAlias: string;
      environment: StorageBindingEnvironment;
      buckets: string[];
      accessKeyId: string | null;
      status: 'error' | 'ready' | 'creating' | 'deleting';
      observedState: 'target_applied' | 'active';
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    };
    fromClusterId: string;
    sourceKeyRevoked: boolean;
    warnings: string[];
  }> {
    return commercialModuleUnavailable();
  }
  /**
   * App kill switch: tear the binding's transport down (network, connector, relay route) and keep the row, principal
   * and credentials with desired state `suspended`. Returns the desired state before, or null when the binding is gone.
   */
  async suspendForIncident(_bindingId: string, _userId: string | null): Promise<{ desiredState: string } | null> {
    return commercialModuleUnavailable();
  }
  /** Back to `active` and reconcile. False when the binding is gone (or was not suspended). */
  async resumeFromIncident(_bindingId: string, _userId: string | null): Promise<boolean> {
    return commercialModuleUnavailable();
  }
}
