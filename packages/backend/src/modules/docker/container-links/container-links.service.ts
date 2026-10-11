import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type {
  ContainerLinkRuntimeView,
  ContainerLinkView,
  CreateContainerLinkInput,
} from './container-links.schemas.js';

/**
 * Container links: a private TCP path from a consumer workload to one port of a target workload on the shared
 * secure-link connector (D10). The private core implements it; Community answers COMMERCIAL_MODULE_UNAVAILABLE.
 */
export class ContainerLinksService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _nodeDispatch: NodeDispatchService,
    _dockerManagement: DockerManagementService,
    _dockerDeployments: DockerDeploymentService,
    _dockerSecrets: DockerSecretService,
    _relayPolicy?: RelayPolicyService,
    _dockerCompose?: DockerComposeService,
    _proxySecureLinks?: ProxySecureLinkService
  ) {}
  setEventBus(_bus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  /** A removed container, or a new container taking its free name, releases the links saved for that name. */
  async releaseContainerLinks(_nodeId: string, _containerName: string, _userId: string | null): Promise<void> {}
  async listBySource(
    _nodeId: string,
    _type: ContainerLinkView['source']['type'],
    _resourceId: string
  ): Promise<ContainerLinkView[]> {
    return commercialModuleUnavailable();
  }
  async listIncoming(
    _nodeId: string,
    _type: ContainerLinkView['target']['type'],
    _resourceId: string
  ): Promise<ContainerLinkView[]> {
    return commercialModuleUnavailable();
  }
  async get(_linkId: string): Promise<ContainerLinkView> {
    return commercialModuleUnavailable();
  }
  async create(_input: CreateContainerLinkInput, _userId: string): Promise<ContainerLinkView> {
    return commercialModuleUnavailable();
  }
  async delete(_linkId: string, _userId: string): Promise<{ success: boolean }> {
    return commercialModuleUnavailable();
  }
  async getRuntime(_linkId: string): Promise<ContainerLinkRuntimeView> {
    return commercialModuleUnavailable();
  }
  /**
   * App kill switch: tear the link's transport down (link network, connector, listener, relay route) and keep the row,
   * principal and credentials with desired state `suspended`. Returns the desired state before, or null when the link
   * is gone.
   */
  async suspendForIncident(_linkId: string, _userId: string | null): Promise<{ desiredState: string } | null> {
    return commercialModuleUnavailable();
  }
  /** Back to `active` and reconcile. False when the link is gone (or was not suspended). */
  async resumeFromIncident(_linkId: string, _userId: string | null): Promise<boolean> {
    return commercialModuleUnavailable();
  }
}
