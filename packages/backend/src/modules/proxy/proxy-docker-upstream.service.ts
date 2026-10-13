import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerComposeProjects,
  dockerDeploymentRoutes,
  dockerDeployments,
  nodes,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { matchRuntimeIdentity } from '@/modules/docker/availability/docker-workload-resolver.service.js';
import {
  type DockerAccessResourceService,
  dockerScopedNodeIds,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import { DOCKER_DEPLOYMENT_MANAGED_LABEL } from '@/modules/docker/docker-deployment-labels.js';
import type { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import type { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';

export type ProxyUpstreamKind = 'manual' | 'docker_container' | 'docker_deployment' | 'managed_storage' | 'pages';
export type DockerProxyUpstreamKind = Exclude<ProxyUpstreamKind, 'manual' | 'managed_storage' | 'pages'>;

export interface DockerUpstreamReference {
  upstreamKind: ProxyUpstreamKind;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: string | null;
}

export interface ResolvedDockerUpstream {
  upstreamKind: DockerProxyUpstreamKind;
  forwardHost: string;
  forwardPort: number;
  dockerNodeId: string | null;
  dockerContainerName: string | null;
  dockerComposeProjectId: string | null;
  dockerComposeServiceName: string | null;
  dockerDeploymentId: string | null;
  dockerContainerPort: number;
  dockerHostPort: number | null;
  dockerProtocol: 'tcp';
}

interface ResolveOptions {
  actorScopes?: string[];
  requireAvailable?: boolean;
  allowPortRebind?: boolean;
  /** Ask the node for a fresh container list once before calling the target missing (interactive edits only). */
  refreshOnMiss?: boolean;
  /**
   * A container of an Availability workload (named by its original or by a replica's runtime name) resolves to the
   * logical workload, whether or not the original copy runs and its node is online (Route create and edit, C-1).
   */
  followAvailability?: boolean;
}

const AVAILABILITY_MANAGED_MODES = ['replicated', 'failover'] as const;

interface SnapshotPort {
  privatePort: number;
  publicPort: number;
  type: string;
  ip: string | null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function readPorts(container: Record<string, unknown>): SnapshotPort[] {
  const raw = container.ports ?? container.Ports;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const port = entry as Record<string, unknown>;
    const privatePort = readNumber(port.privatePort ?? port.PrivatePort);
    const publicPort = readNumber(port.publicPort ?? port.PublicPort);
    if (!privatePort || !publicPort) return [];
    return [
      {
        privatePort,
        publicPort,
        type: String(port.type ?? port.Type ?? 'tcp').toLowerCase(),
        ip: typeof (port.ip ?? port.IP) === 'string' ? String(port.ip ?? port.IP) : null,
      },
    ];
  });
}

function readContainerName(container: Record<string, unknown>): string {
  return String(container.name ?? container.Name ?? '').replace(/^\/+/, '');
}

function readLabels(container: Record<string, unknown>): Record<string, unknown> {
  const labels = container.labels ?? container.Labels;
  return labels && typeof labels === 'object' && !Array.isArray(labels) ? (labels as Record<string, unknown>) : {};
}

function isDeploymentInternal(container: Record<string, unknown>): boolean {
  const labels = container.labels ?? container.Labels;
  return (
    !!labels &&
    typeof labels === 'object' &&
    !Array.isArray(labels) &&
    (labels as Record<string, unknown>)[DOCKER_DEPLOYMENT_MANAGED_LABEL] === 'true'
  );
}

function composeAvailabilityContainer(runtimeIdentity: unknown, serviceName: string): { containerName: string } | null {
  if (!runtimeIdentity || typeof runtimeIdentity !== 'object' || Array.isArray(runtimeIdentity)) return null;
  const containers = (runtimeIdentity as Record<string, unknown>).containers;
  if (!Array.isArray(containers)) return null;
  for (const candidate of containers) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (String(value.serviceName ?? '') !== serviceName) continue;
    const containerName = String(value.containerName ?? '').replace(/^\/+/, '');
    if (containerName) return { containerName };
  }
  return null;
}

export function clearDockerUpstreamFields() {
  return {
    dockerNodeId: null,
    dockerContainerName: null,
    dockerComposeProjectId: null,
    dockerComposeServiceName: null,
    dockerDeploymentId: null,
    dockerContainerPort: null,
    dockerHostPort: null,
    dockerProtocol: null,
  } as const;
}

function targetUnavailable() {
  return new AppError(
    409,
    'DOCKER_TARGET_UNAVAILABLE',
    'The Docker node is offline or has not reported its containers yet. Try again once it is online.'
  );
}

export class ProxyDockerUpstreamService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly snapshots: DockerSnapshotService,
    private readonly registry: NodeRegistryService,
    private readonly accessResources?: DockerAccessResourceService,
    private readonly containerRefresher?: Pick<DockerSnapshotReconciler, 'refreshNow'>
  ) {}

  async resolve(reference: DockerUpstreamReference, options: ResolveOptions = {}): Promise<ResolvedDockerUpstream> {
    if (reference.upstreamKind === 'docker_container') {
      return this.resolveContainer(reference, options);
    }
    if (reference.upstreamKind === 'docker_deployment') {
      return this.resolveDeployment(reference, options);
    }
    throw new AppError(400, 'INVALID_UPSTREAM', 'Docker upstream reference is required');
  }

  private assertDockerViewScope(nodeId: string, resourceId: string, actorScopes?: string[]) {
    if (actorScopes && !hasDockerResourceScope(actorScopes, 'docker:containers:view', nodeId, resourceId)) {
      throw new AppError(403, 'FORBIDDEN', 'Docker container access is required for this upstream');
    }
  }

  private assertComposeViewScope(nodeId: string, projectId: string, actorScopes?: string[]) {
    if (actorScopes && !hasDockerResourceScope(actorScopes, 'docker:compose:view', nodeId, projectId)) {
      throw new AppError(403, 'FORBIDDEN', 'Docker Compose project access is required for this upstream');
    }
  }

  private assertDockerNodeVisibility(nodeId: string, actorScopes?: string[]) {
    if (
      actorScopes &&
      !hasDockerResourceScope(actorScopes, 'docker:containers:view', nodeId, '') &&
      !dockerScopedNodeIds(actorScopes, ['docker:containers:view']).includes(nodeId)
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Docker container access is required for this upstream');
    }
  }

  private async getDockerNode(nodeId: string, options: ResolveOptions) {
    const [node] = await this.db
      .select({
        id: nodes.id,
        type: nodes.type,
        status: nodes.status,
        serviceAddresses: nodes.serviceAddresses,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'DOCKER_NODE_NOT_FOUND', 'Docker node not found');
    if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Selected node is not a Docker node');
    if (options.requireAvailable && !this.registry.getNode(nodeId)) {
      throw new AppError(409, 'DOCKER_TARGET_UNAVAILABLE', 'Docker node is unavailable');
    }
    return node;
  }

  /** Asks the node for a fresh container list when the caller allows it. */
  private async refreshContainers(nodeId: string, options: ResolveOptions): Promise<'fresh' | 'failed' | 'skipped'> {
    if (!options.refreshOnMiss || !this.containerRefresher || !this.registry.getNode(nodeId)) return 'skipped';
    return this.containerRefresher.refreshNow(nodeId, 'containers').then(
      () => 'fresh' as const,
      () => 'failed' as const
    );
  }

  private choosePort(reference: DockerUpstreamReference, ports: SnapshotPort[]): number {
    const containerPort = reference.dockerContainerPort;
    const protocol = reference.dockerProtocol ?? 'tcp';
    if (!containerPort || protocol !== 'tcp') {
      throw new AppError(400, 'INVALID_DOCKER_PORT', 'A TCP container port is required');
    }
    // Declared ports improve the picker but are not an admission boundary:
    // Secure Links can target an explicitly entered application port even
    // when Docker does not publish it on the host.
    const declared = ports.some((port) => port.privatePort === containerPort && port.type === protocol);
    void declared;
    return containerPort;
  }

  private async resolveContainer(
    reference: DockerUpstreamReference,
    options: ResolveOptions
  ): Promise<ResolvedDockerUpstream> {
    const nodeId = reference.dockerNodeId;
    if (!nodeId) throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node is required');
    const composeTarget = Boolean(reference.dockerComposeProjectId || reference.dockerComposeServiceName);
    if (options.followAvailability) {
      const logical = composeTarget
        ? await this.resolveAvailabilityCompose(nodeId, reference, options)
        : await this.resolveAvailabilityContainer(nodeId, reference, options);
      if (logical) return logical;
    }
    if (!composeTarget) this.assertDockerNodeVisibility(nodeId, options.actorScopes);
    await this.getDockerNode(nodeId, options);
    const snapshot = await this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'containers');
    if (options.requireAvailable && (snapshot.revision === 0 || snapshot.refreshStatus === 'error')) {
      if ((await this.refreshContainers(nodeId, options)) === 'fresh') {
        return this.resolveContainer(reference, { ...options, refreshOnMiss: false });
      }
      throw targetUnavailable();
    }
    let containerName = reference.dockerContainerName?.replace(/^\/+/, '') ?? '';
    let container: Record<string, unknown> | undefined;
    if (composeTarget) {
      if (!reference.dockerComposeProjectId || !reference.dockerComposeServiceName) {
        throw new AppError(400, 'INVALID_COMPOSE_TARGET', 'Select one Compose project service target');
      }
      const [project] = await this.db
        .select({ id: dockerComposeProjects.id, name: dockerComposeProjects.name })
        .from(dockerComposeProjects)
        .where(
          and(eq(dockerComposeProjects.id, reference.dockerComposeProjectId), eq(dockerComposeProjects.nodeId, nodeId))
        )
        .limit(1);
      if (!project) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
      this.assertComposeViewScope(nodeId, project.id, options.actorScopes);
      const matches = Array.isArray(snapshot.data)
        ? snapshot.data.filter((item) => {
            const labels = readLabels(item);
            return (
              labels['com.docker.compose.project'] === project.name &&
              labels['com.docker.compose.service'] === reference.dockerComposeServiceName &&
              !isDeploymentInternal(item)
            );
          })
        : [];
      if (matches.length > 1) {
        throw new AppError(409, 'COMPOSE_SERVICE_AMBIGUOUS', 'Compose service has more than one container');
      }
      container = matches[0];
      containerName = container ? readContainerName(container) : '';
      if (!container) {
        const [policy] = await this.db
          .select({ id: dockerAvailabilityPolicies.id })
          .from(dockerAvailabilityPolicies)
          .where(eq(dockerAvailabilityPolicies.composeProjectId, project.id))
          .limit(1);
        if (policy) {
          const [placement] = await this.db
            .select({
              nodeId: dockerAvailabilityPlacements.nodeId,
              runtimeIdentity: dockerAvailabilityPlacements.runtimeIdentity,
            })
            .from(dockerAvailabilityPlacements)
            .where(
              and(
                eq(dockerAvailabilityPlacements.policyId, policy.id),
                eq(dockerAvailabilityPlacements.serving, true),
                eq(dockerAvailabilityPlacements.actualState, 'serving')
              )
            )
            .limit(1);
          const availabilityContainer = placement
            ? composeAvailabilityContainer(placement.runtimeIdentity, reference.dockerComposeServiceName)
            : null;
          if (placement && availabilityContainer) {
            await this.getDockerNode(placement.nodeId, options);
            const selectedPort = this.choosePort(reference, []);
            return {
              upstreamKind: 'docker_container',
              forwardHost: '127.0.0.1',
              forwardPort: 1,
              dockerNodeId: placement.nodeId,
              dockerContainerName: availabilityContainer.containerName,
              dockerComposeProjectId: project.id,
              dockerComposeServiceName: reference.dockerComposeServiceName,
              dockerDeploymentId: null,
              dockerContainerPort: selectedPort,
              dockerHostPort: null,
              dockerProtocol: 'tcp',
            };
          }
        }
      }
    } else {
      if (!containerName) {
        throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker node and exact container name are required');
      }
      container = Array.isArray(snapshot.data)
        ? snapshot.data.find((item) => readContainerName(item) === containerName)
        : undefined;
    }
    if (!container || isDeploymentInternal(container)) {
      // The snapshot lags behind the node: a container created a moment ago, or a node that
      // has not reported yet. An interactive edit asks the node once before giving up.
      const refresh = await this.refreshContainers(nodeId, options);
      if (refresh === 'fresh') return this.resolveContainer(reference, { ...options, refreshOnMiss: false });
      const reported =
        refresh !== 'failed' &&
        Boolean(this.registry.getNode(nodeId)) &&
        snapshot.revision > 0 &&
        snapshot.refreshStatus !== 'error';
      if (!reported) throw targetUnavailable();
      throw new AppError(
        404,
        'DOCKER_CONTAINER_NOT_FOUND',
        composeTarget
          ? `Compose service "${reference.dockerComposeServiceName}" has no container on this Docker node`
          : `Container "${containerName}" was not found on this Docker node`
      );
    }
    if (!reference.dockerComposeProjectId) {
      const runtimeId = String(container.id ?? container.Id ?? '');
      const resourceId = this.accessResources
        ? await this.accessResources.ensureContainer(nodeId, containerName, runtimeId, false)
        : '';
      this.assertDockerViewScope(nodeId, resourceId, options.actorScopes);
    }
    const selectedPort = this.choosePort(reference, readPorts(container));
    return {
      upstreamKind: 'docker_container',
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerNodeId: nodeId,
      dockerContainerName: containerName,
      dockerComposeProjectId: reference.dockerComposeProjectId ?? null,
      dockerComposeServiceName: reference.dockerComposeServiceName ?? null,
      dockerDeploymentId: null,
      dockerContainerPort: selectedPort,
      dockerHostPort: null,
      dockerProtocol: 'tcp',
    };
  }

  /**
   * The logical source of an Availability container: its original node and name, which the Availability ingress
   * projection uses to find the policy. After a failover the original is stopped (or its node is offline) while a
   * replica serves elsewhere, so neither is required here; a reference to a replica's runtime name (gwav-…) maps to
   * the workload too, so the Route follows the next failover. Null for a container without Availability.
   */
  private async resolveAvailabilityContainer(
    nodeId: string,
    reference: DockerUpstreamReference,
    options: ResolveOptions
  ): Promise<ResolvedDockerUpstream | null> {
    const requestedName = reference.dockerContainerName?.replace(/^\/+/, '') ?? '';
    if (!requestedName) return null;
    const policy = await this.findAvailabilityContainerPolicy(nodeId, requestedName);
    if (!policy?.sourceNodeId || !policy.containerName) return null;
    const sourceNodeId = policy.sourceNodeId;
    this.assertDockerNodeVisibility(sourceNodeId, options.actorScopes);
    await this.getDockerNode(sourceNodeId, { ...options, requireAvailable: false });
    const resourceId = this.accessResources
      ? ((await this.accessResources.resolveContainer(sourceNodeId, {
          name: policy.containerName,
          includeReservations: true,
        })) ?? '')
      : '';
    this.assertDockerViewScope(sourceNodeId, resourceId, options.actorScopes);
    return {
      upstreamKind: 'docker_container',
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerNodeId: sourceNodeId,
      dockerContainerName: policy.containerName,
      dockerComposeProjectId: null,
      dockerComposeServiceName: null,
      dockerDeploymentId: null,
      dockerContainerPort: this.choosePort(reference, []),
      dockerHostPort: null,
      dockerProtocol: 'tcp',
    };
  }

  /**
   * The logical project of an Availability Compose service: the project's own node and the service's container there.
   * After a failover the origin node may be offline and the service may run only on another node; neither is required,
   * and the serving copy is never stored (the Availability ingress projection finds the policy by project). The
   * reference may name the project's node or a node that holds one of its copies.
   */
  private async resolveAvailabilityCompose(
    nodeId: string,
    reference: DockerUpstreamReference,
    options: ResolveOptions
  ): Promise<ResolvedDockerUpstream | null> {
    const projectId = reference.dockerComposeProjectId;
    const serviceName = reference.dockerComposeServiceName;
    if (!projectId || !serviceName) return null;
    const [project] = await this.db
      .select({ id: dockerComposeProjects.id, name: dockerComposeProjects.name, nodeId: dockerComposeProjects.nodeId })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, projectId))
      .limit(1);
    if (!project) return null;
    const [policy] = await this.db
      .select({ id: dockerAvailabilityPolicies.id, portableSpec: dockerAvailabilityPolicies.portableSpec })
      .from(dockerAvailabilityPolicies)
      .where(
        and(
          eq(dockerAvailabilityPolicies.resourceKind, 'compose'),
          eq(dockerAvailabilityPolicies.composeProjectId, project.id),
          inArray(dockerAvailabilityPolicies.mode, [...AVAILABILITY_MANAGED_MODES])
        )
      )
      .limit(1);
    if (!policy) return null;
    const copies = await this.db
      .select({
        nodeId: dockerAvailabilityPlacements.nodeId,
        runtimeIdentity: dockerAvailabilityPlacements.runtimeIdentity,
      })
      .from(dockerAvailabilityPlacements)
      .where(
        and(
          eq(dockerAvailabilityPlacements.policyId, policy.id),
          ne(dockerAvailabilityPlacements.actualState, 'removed')
        )
      );
    if (nodeId !== project.nodeId && !copies.some((copy) => copy.nodeId === nodeId)) return null;
    this.assertComposeViewScope(project.nodeId, project.id, options.actorScopes);
    await this.getDockerNode(project.nodeId, { ...options, requireAvailable: false });
    const model = (policy.portableSpec as Record<string, unknown> | null)?.normalizedModel as
      | { services?: Record<string, unknown> }
      | undefined;
    if (model?.services && typeof model.services === 'object' && !(serviceName in model.services)) {
      throw new AppError(
        404,
        'DOCKER_CONTAINER_NOT_FOUND',
        `Compose service "${serviceName}" is not part of this project`
      );
    }
    const snapshot = await this.snapshots.getList<Record<string, unknown>[]>(project.nodeId, 'containers');
    const listed = Array.isArray(snapshot.data)
      ? snapshot.data.find((item) => {
          const labels = readLabels(item);
          return (
            labels['com.docker.compose.project'] === project.name &&
            labels['com.docker.compose.service'] === serviceName &&
            !isDeploymentInternal(item)
          );
        })
      : undefined;
    const origin = copies.find((copy) => copy.nodeId === project.nodeId);
    const containerName =
      (listed ? readContainerName(listed) : '') ||
      (origin ? composeAvailabilityContainer(origin.runtimeIdentity, serviceName)?.containerName : undefined) ||
      `${project.name}-${serviceName}-1`;
    return {
      upstreamKind: 'docker_container',
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerNodeId: project.nodeId,
      dockerContainerName: containerName,
      dockerComposeProjectId: project.id,
      dockerComposeServiceName: serviceName,
      dockerDeploymentId: null,
      dockerContainerPort: this.choosePort(reference, []),
      dockerHostPort: null,
      dockerProtocol: 'tcp',
    };
  }

  /**
   * The container Availability policy a reference names: by its original node and name, or by the runtime identity
   * of one of its copies on that node. Only an exact runtime match counts, so another container that merely shares
   * the workload's name on a replica node is not taken for it.
   */
  private async findAvailabilityContainerPolicy(nodeId: string, name: string) {
    const [direct] = await this.db
      .select()
      .from(dockerAvailabilityPolicies)
      .where(
        and(
          eq(dockerAvailabilityPolicies.resourceKind, 'container'),
          eq(dockerAvailabilityPolicies.sourceNodeId, nodeId),
          eq(dockerAvailabilityPolicies.containerName, name),
          inArray(dockerAvailabilityPolicies.mode, [...AVAILABILITY_MANAGED_MODES])
        )
      )
      .limit(1);
    if (direct) return direct;
    const copies = await this.db
      .select({ policy: dockerAvailabilityPolicies, runtimeIdentity: dockerAvailabilityPlacements.runtimeIdentity })
      .from(dockerAvailabilityPlacements)
      .innerJoin(dockerAvailabilityPolicies, eq(dockerAvailabilityPolicies.id, dockerAvailabilityPlacements.policyId))
      .where(
        and(
          eq(dockerAvailabilityPlacements.nodeId, nodeId),
          ne(dockerAvailabilityPlacements.actualState, 'removed'),
          eq(dockerAvailabilityPolicies.resourceKind, 'container'),
          inArray(dockerAvailabilityPolicies.mode, [...AVAILABILITY_MANAGED_MODES])
        )
      );
    return copies.find((copy) => matchRuntimeIdentity(copy.runtimeIdentity, name).matches)?.policy ?? null;
  }

  private async resolveDeployment(
    reference: DockerUpstreamReference,
    options: ResolveOptions
  ): Promise<ResolvedDockerUpstream> {
    const deploymentId = reference.dockerDeploymentId;
    if (!deploymentId) throw new AppError(400, 'INVALID_DOCKER_TARGET', 'Docker deployment is required');
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, deploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
    this.assertDockerViewScope(deployment.nodeId, deployment.id, options.actorScopes);
    // An Availability Deployment is served by its placements: its origin node may be offline (C-1 follow-up).
    const availabilityServed =
      options.followAvailability === true &&
      (
        await this.db
          .select({ id: dockerAvailabilityPolicies.id })
          .from(dockerAvailabilityPolicies)
          .where(
            and(
              eq(dockerAvailabilityPolicies.resourceKind, 'deployment'),
              eq(dockerAvailabilityPolicies.deploymentId, deployment.id),
              inArray(dockerAvailabilityPolicies.mode, [...AVAILABILITY_MANAGED_MODES])
            )
          )
          .limit(1)
      ).length > 0;
    await this.getDockerNode(deployment.nodeId, availabilityServed ? { ...options, requireAvailable: false } : options);
    const routes = await this.db
      .select()
      .from(dockerDeploymentRoutes)
      .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
    const containerPort = reference.dockerContainerPort;
    if (!containerPort || (reference.dockerProtocol ?? 'tcp') !== 'tcp') {
      throw new AppError(400, 'INVALID_DOCKER_PORT', 'A TCP deployment port is required');
    }
    const semanticMatches = routes.filter((route) => route.containerPort === containerPort);
    const route =
      semanticMatches.find((item) => item.hostPort === reference.dockerHostPort) ??
      (semanticMatches.length === 1 ? semanticMatches[0] : undefined);
    if (!route) {
      throw new AppError(
        409,
        semanticMatches.length > 1 ? 'DOCKER_PORT_AMBIGUOUS' : 'DOCKER_PORT_NOT_PUBLISHED',
        semanticMatches.length > 1
          ? 'Select one of the deployment application ports'
          : 'The selected deployment route is missing'
      );
    }
    return {
      upstreamKind: 'docker_deployment',
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      dockerNodeId: deployment.nodeId,
      dockerContainerName: null,
      dockerComposeProjectId: null,
      dockerComposeServiceName: null,
      dockerDeploymentId: deploymentId,
      dockerContainerPort: route.containerPort,
      dockerHostPort: route.hostPort,
      dockerProtocol: 'tcp',
    };
  }
}
