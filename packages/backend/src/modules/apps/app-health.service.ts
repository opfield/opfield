import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnections,
  dockerComposeProjects,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerHealthChecks,
  type ManagedAvailabilityState,
  managedAvailabilitySets,
  managedDatabaseInstances,
  managedStorageClusters,
  nodes,
  objectStorageConnections,
  pageRouteTargets,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { effectiveMaintenance } from '@/modules/proxy/effective-maintenance.js';
import { CacheService } from '@/services/cache.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { certificateMemberHealths } from './app-certificate-health.js';
import {
  assessEnvironment,
  CERT_WARNING_DAYS,
  type MemberAssessment,
  type MemberHealth,
  type MemberSignal,
  memberSignalKey,
  NODE_UNREACHABLE_AFTER_MS,
  REPEATED_RESTARTS,
  REPEATED_RESTARTS_WINDOW_MS,
  ROUTE_ERROR_WINDOW_MS,
  worse,
} from './app-environment-health.js';
import type { AppMember, AppMembersReader } from './app-members.service.js';
import { latestOf, overviewSamples } from './app-overview-sources.js';
import {
  type RouteTrafficSample,
  readSamples,
  routeTrafficKey,
  type WorkloadSample,
  workloadSampleKey,
} from './app-workload-sampler.js';
import type { AppHealthProvider, EnvironmentHealthSummary } from './apps.service.js';

export { combineHealth, type MemberHealth } from './app-environment-health.js';

export interface MemberStatus extends MemberAssessment {
  member: AppMember;
  /** Latest CPU percent and memory bytes of a container or the active deployment slot. */
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  /** Docker runtime container name: the container itself, or the active slot of a deployment. */
  runtimeName?: string | null;
  /** Docker container id of that runtime (changes on every recreate). */
  runtimeId?: string | null;
  /** A container or deployment with an enabled Opfield health check (without one, running counts as healthy). */
  hasHealthCheck?: boolean;
}

/** Route, database and storage health statuses (online/degraded/offline/unknown/disabled) as member health. */
export function healthFromStatus(status: string | null | undefined): MemberHealth {
  switch (status) {
    case 'online':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'offline':
      return 'failing';
    default:
      return 'none';
  }
}

/**
 * A database or storage that runs on several servers (an availability set): its connection's health is the primary's,
 * the set's state says whether the copies can take over. A set that lost a copy or cannot fail over is degraded, never
 * down while the primary answers; a failover in progress is degraded too (the copy takes over within seconds).
 */
export function withAvailabilityState(
  health: MemberHealth,
  state: ManagedAvailabilityState | null | undefined
): MemberHealth {
  if (!state || state === 'healthy' || health === 'none' || health === 'stopped') return health;
  if (health === 'healthy') return 'degraded';
  if (health === 'failing' && state === 'failing_over') return 'degraded';
  return health;
}

/** Docker's exit code from a container list status ("Exited (137) 3 minutes ago"), or null. */
export function containerExitCode(status: string | null | undefined): number | null {
  const match = /^exited\s*\((-?\d+)\)/i.exec(String(status ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Whether an exited container was stopped on request rather than crashed. A stop (Opfield, the API, MCP or
 * `docker stop`) sends the stop signal and, after the timeout, SIGKILL: the process exits 0 or with the signal's code
 * (130 SIGINT, 143 SIGTERM, 137 SIGKILL; `docker kill` is 137 too). A process that crashes exits with another code; a
 * kernel OOM kill is also 137 but Docker marks it OOMKilled, so 137 counts as a stop only when the inspect says it was
 * not one (unknown is a crash).
 */
export function stoppedOnRequest(exitCode: number | null, oomKilled: boolean | null | undefined): boolean {
  if (exitCode === null || oomKilled === true) return false;
  if (exitCode === 0 || exitCode === 130 || exitCode === 143) return true;
  return exitCode === 137 && oomKilled === false;
}

/** How a container runs: Docker's state, its list status (with the exit code) and, for exit 137, the OOM flag. */
export interface ContainerRuntimeState {
  state?: string | null;
  status?: string | null;
  oomKilled?: boolean | null;
}

/**
 * A container from its runtime state, its Opfield health check and its restarts in the last hour. Running follows
 * the check (one that has not reported yet is neutral, "starting") and is degraded when it restarted
 * REPEATED_RESTARTS times or more; exited is stopped when it was stopped on request, else failing (a crash or an OOM
 * kill); created and never started is stopped; restarting (a restart loop), dead or missing is failing; paused is
 * degraded.
 */
export function containerState(
  state: string | null | undefined,
  check: string | null | undefined,
  runtime: ContainerRuntimeState = {},
  recentRestarts: number | null = null
): MemberAssessment {
  const current = String(state ?? '').toLowerCase();
  if (current === 'running') {
    if (check === 'unknown') return { health: 'none', neutral: 'starting' };
    const fromCheck = healthFromStatus(check);
    if (fromCheck === 'failing') return { health: 'failing', reason: 'Its health check fails' };
    if (fromCheck === 'degraded') return { health: 'degraded', reason: 'Its health check is slow' };
    if (recentRestarts !== null && recentRestarts >= REPEATED_RESTARTS) {
      return { health: 'degraded', reason: `Restarting repeatedly: ${recentRestarts} restarts in the last hour` };
    }
    return { health: 'healthy' };
  }
  if (current === 'paused' || current === 'pending' || current === 'removing') {
    return { health: 'degraded', reason: `The container is ${current}` };
  }
  if (current === 'created') return { health: 'stopped', reason: 'Created, not started' };
  if (current === 'exited') {
    const code = containerExitCode(runtime.status);
    if (stoppedOnRequest(code, runtime.oomKilled)) return { health: 'stopped', reason: 'Stopped on request' };
    if (runtime.oomKilled === true) return { health: 'failing', reason: 'Killed for running out of memory' };
    return { health: 'failing', reason: code === null ? 'The container exited' : `Crashed with exit code ${code}` };
  }
  if (current === 'restarting') return { health: 'failing', reason: 'In a restart loop' };
  if (current === 'dead') return { health: 'failing', reason: 'The container is dead' };
  return { health: 'failing', reason: 'The container is missing' };
}

export function containerHealth(
  state: string | null | undefined,
  check: string | null | undefined,
  runtime: ContainerRuntimeState = {}
): MemberHealth {
  return containerState(state, check, runtime).health;
}

/**
 * A deployment: stopped on request (its status) is stopped; a ready one follows its active slot's container like a
 * container (exited on request is stopped, crashed is failing, a check that has not reported is starting, repeated
 * restarts degrade it); one being created, deployed or switched, or degraded, is degraded; failed is failing.
 */
export function deploymentState(
  status: string | null | undefined,
  check: string | null | undefined,
  slot?: ContainerRuntimeState | null,
  recentRestarts: number | null = null
): MemberAssessment {
  switch (status) {
    case 'stopped':
      return { health: 'stopped', reason: 'Stopped on request' };
    case 'deleting':
      return { health: 'none' };
    case 'ready':
      return containerState(slot?.state || 'running', check, slot ?? {}, recentRestarts);
    case 'creating':
    case 'deploying':
    case 'switching':
      return { health: 'degraded', reason: `The deployment is ${status}` };
    case 'degraded':
      return { health: 'degraded', reason: 'The deployment is degraded' };
    default:
      return { health: 'failing', reason: 'The deployment failed' };
  }
}

export function deploymentHealth(
  status: string | null | undefined,
  check: string | null | undefined,
  slot?: ContainerRuntimeState | null
): MemberHealth {
  return deploymentState(status, check, slot).health;
}

/**
 * A Compose project from its status, desired state and its containers: stopped through Opfield (desired state
 * stopped) is stopped; a service container that crashed (an exit that is no stop) or loops fails it; running is
 * healthy; only some services up is degraded; every service down after a stop on request (docker compose stop) is
 * stopped, otherwise failing; one being applied is degraded; failed or missing is failing.
 */
export function composeState(
  status: string | null | undefined,
  desiredState?: string | null,
  containers: readonly ContainerRuntimeState[] = []
): MemberAssessment {
  if (desiredState === 'stopped' && status !== 'failed') return { health: 'stopped', reason: 'Stopped on request' };
  const exited = containers.filter((item) => String(item.state ?? '').toLowerCase() === 'exited');
  const crashed = exited.find((item) => !stoppedOnRequest(containerExitCode(item.status), item.oomKilled ?? false));
  if (crashed && status !== 'running') {
    return { health: 'failing', reason: `A service crashed with exit code ${containerExitCode(crashed.status)}` };
  }
  if (containers.some((item) => String(item.state ?? '').toLowerCase() === 'restarting')) {
    return { health: 'failing', reason: 'A service is in a restart loop' };
  }
  switch (status) {
    case 'running':
      return { health: 'healthy' };
    case 'degraded':
      return { health: 'degraded', reason: 'Only some services run' };
    case 'validating':
    case 'applying':
    case 'discovered':
      return { health: 'degraded', reason: `The project is ${status}` };
    case 'deleting':
      return { health: 'none' };
    case 'stopped':
      return exited.length > 0
        ? { health: 'stopped', reason: 'Stopped on request' }
        : { health: 'failing', reason: 'No service runs' };
    default:
      return { health: 'failing', reason: status === 'missing' ? 'The project is missing' : 'The project failed' };
  }
}

export function composeHealth(status: string | null | undefined, desiredState?: string | null): MemberHealth {
  return composeState(status, desiredState).health;
}

/**
 * A route's TLS certificate: expired fails the route; a failed renewal or an expiry within CERT_WARNING_DAYS
 * degrades it.
 */
export function certificateState(
  cert: { status: string | null; notAfter: Date | null; renewalFailureCount: number | null } | null | undefined,
  now = Date.now()
): MemberAssessment {
  if (!cert) return { health: 'none' };
  const expiresAt = cert.notAfter?.getTime() ?? null;
  if (cert.status === 'expired' || (expiresAt !== null && expiresAt <= now)) {
    return { health: 'failing', reason: 'Its certificate expired' };
  }
  if ((cert.renewalFailureCount ?? 0) > 0) return { health: 'degraded', reason: 'Its certificate renewal failed' };
  if (expiresAt !== null && expiresAt - now <= CERT_WARNING_DAYS * 24 * 60 * 60 * 1000) {
    const days = Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
    return { health: 'degraded', reason: `Its certificate expires in ${days} ${days === 1 ? 'day' : 'days'}` };
  }
  return { health: 'none' };
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Restarts of a workload within the last REPEATED_RESTARTS_WINDOW_MS from its samples (a new runtime counts from 0). */
export function recentRestartsOf(samples: readonly WorkloadSample[], now = Date.now()): number | null {
  const recent = samples
    .filter((sample) => sample.at >= now - REPEATED_RESTARTS_WINDOW_MS && sample.restartCount !== null)
    .sort((left, right) => left.at - right.at);
  if (recent.length === 0) return null;
  let total = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1]!;
    const current = recent[index]!;
    total +=
      previous.runtime === current.runtime
        ? Math.max(0, current.restartCount! - previous.restartCount!)
        : current.restartCount!;
  }
  return total;
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const OOM_CHECK_TTL_MS = 60_000;
const OOM_CHECK_TIMEOUT_MS = 3_000;
/** The newest samples health needs: an hour of per-minute ones (restarts, the route error window). */
const RECENT_SAMPLES = 62;

type RuntimeEntry = {
  id: string | null;
  state: string | null;
  status: string | null;
  labels: Record<string, string>;
  oomKilled: boolean | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
};

/** The key a route's Docker upstream names a workload member by. */
export function workloadKey(type: string, nodeId: string | null | undefined, id: string | null | undefined): string {
  return type === 'container' ? `container:${nodeId}/${id}` : `${type}:${id}`;
}

/**
 * Rules across members, applied in place: a route whose target member was stopped on request is degraded ("its
 * target is stopped"), not failing, since nothing is meant to answer; a member whose every node is unreachable is
 * degraded ("node unreachable"), since its last snapshot is stale.
 */
export function applyCrossMemberRules(
  statuses: MemberStatus[],
  routeTargets: ReadonlyMap<string, string | null>,
  unreachableNodes: ReadonlySet<string>
): void {
  const stopped = new Set(
    statuses
      .filter((status) => status.health === 'stopped')
      .map((status) => workloadKey(status.member.type, status.member.nodeId, status.member.id))
  );
  for (const status of statuses) {
    if (status.member.type !== 'route' || status.health === 'none' || status.health === 'healthy') continue;
    const target = routeTargets.get(status.member.id);
    if (target && stopped.has(target)) {
      status.health = 'degraded';
      status.reason = 'Its target is stopped';
    }
  }
  for (const status of statuses) {
    const memberNodes = status.member.nodeIds;
    if (status.member.type === 'pages' || memberNodes.length === 0) continue;
    if (memberNodes.every((nodeId) => unreachableNodes.has(nodeId))) {
      status.health = 'degraded';
      status.reason = 'Its node is unreachable';
      status.neutral = undefined;
    }
  }
}

/**
 * Health of app members and environments. Members count only when the caller may view them. Environment health is
 * assessEnvironment's (the overview uses the same function). CPU and memory are the latest container stats the nodes
 * reported.
 */
export class AppHealthService implements AppHealthProvider {
  /** OOM verdicts of containers that exited with 137, by `<nodeId>\0<containerId>`, for OOM_CHECK_TTL_MS. */
  private oomVerdicts = new Map<string, { at: number; oomKilled: boolean | null }>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly members: AppMembersReader
  ) {}

  async summarizeEnvironments(
    scopes: readonly string[],
    environmentIds: readonly string[]
  ): Promise<Map<string, EnvironmentHealthSummary>> {
    const visible = await this.members.listVisibleMembers(scopes, environmentIds);
    const [statuses, signals] = await Promise.all([this.memberStatuses(visible), this.memberSignals(visible)]);
    const result = new Map<string, EnvironmentHealthSummary>();
    for (const environmentId of environmentIds) {
      const own = statuses.filter((status) => status.member.environmentId === environmentId);
      const assessment = assessEnvironment({ envName: '', statuses: own, signals });
      const cpu = own.map((status) => status.cpuPercent).filter((value): value is number => value !== null);
      const memory = own.map((status) => status.memoryBytes).filter((value): value is number => value !== null);
      result.set(environmentId, {
        health: assessment.health,
        running: assessment.running,
        failing: assessment.failing,
        degraded: assessment.degraded,
        stopped: assessment.stopped,
        warnings: assessment.alerts.filter((alert) => alert.tone === 'warning').length,
        cpuPercent: cpu.length ? Math.round(cpu.reduce((sum, value) => sum + value, 0) * 10) / 10 : null,
        memoryBytes: memory.length ? memory.reduce((sum, value) => sum + value, 0) : null,
      });
    }
    return result;
  }

  /**
   * What the environment warnings are computed from: each database's and storage's disk use (the latest overview
   * sample, the value its Disk card shows) and each route's requests and 5xx over the last five minutes (the route
   * traffic samples the Requests and Errors cards show).
   */
  async memberSignals(members: readonly AppMember[], now = Date.now()): Promise<Map<string, MemberSignal>> {
    const result = new Map<string, MemberSignal>();
    const of = (type: AppMember['type']) => members.filter((member) => member.type === type);
    const databases = of('database');
    const storages = of('storage');
    const routes = of('route');
    const cache = container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
    const [limits, databaseSamples, storageSamples, routeSamples] = await Promise.all([
      this.rows(
        databases.map((member) => member.id),
        (list) =>
          this.db
            .select({ id: databaseConnections.id, manualSizeLimitMb: databaseConnections.manualSizeLimitMb })
            .from(databaseConnections)
            .where(inArray(databaseConnections.id, list))
      ),
      overviewSamples(
        DatabaseMonitoringService,
        databases.map((member) => member.id),
        '1h'
      ),
      overviewSamples(
        ObjectStorageMonitoringService,
        storages.map((member) => member.id),
        '1h'
      ),
      Promise.all(
        routes.map((member) => readSamples<RouteTrafficSample>(cache, routeTrafficKey(member.id), RECENT_SAMPLES))
      ),
    ]);
    for (const member of databases) {
      const samples = databaseSamples.get(member.id) ?? [];
      const limit = limits.find((row) => row.id === member.id)?.manualSizeLimitMb ?? null;
      result.set(memberSignalKey(member), {
        diskPercent: databaseDiskPercent(latestOf(samples, 'database_size_bytes'), limit),
      });
    }
    for (const member of storages) {
      const samples = storageSamples.get(member.id) ?? [];
      result.set(memberSignalKey(member), {
        diskPercent: storageDiskPercent(latestOf(samples, 'disk_used_bytes'), latestOf(samples, 'disk_total_bytes')),
      });
    }
    routes.forEach((member, index) => {
      const recent = (routeSamples[index] ?? []).filter((sample) => sample.at >= now - ROUTE_ERROR_WINDOW_MS);
      if (recent.length === 0) return;
      result.set(memberSignalKey(member), {
        requests: recent.reduce((sum, sample) => sum + sample.requests, 0),
        errors: recent.reduce((sum, sample) => sum + sample.errors, 0),
      });
    });
    return result;
  }

  /** The state of each member (with the reason it is degraded, failing or neutral), read in one query per source. */
  async memberStatuses(members: readonly AppMember[], now = Date.now()): Promise<MemberStatus[]> {
    const ids = (type: AppMember['type']) =>
      members.filter((member) => member.type === type).map((member) => member.id);
    const [routes, databases, storages, composes, deployments, managedDatabases, managedStorages, pageTargets] =
      await Promise.all([
        this.rows(ids('route'), (list) =>
          this.db
            .select({
              id: proxyHosts.id,
              enabled: proxyHosts.enabled,
              healthStatus: proxyHosts.healthStatus,
              rawConfigEnabled: proxyHosts.rawConfigEnabled,
              maintenanceEnabled: proxyHosts.maintenanceEnabled,
              appMaintenanceMode: proxyHosts.appMaintenanceMode,
              upstreamKind: proxyHosts.upstreamKind,
              dockerNodeId: proxyHosts.dockerNodeId,
              dockerContainerName: proxyHosts.dockerContainerName,
              dockerDeploymentId: proxyHosts.dockerDeploymentId,
              dockerComposeProjectId: proxyHosts.dockerComposeProjectId,
              sslEnabled: proxyHosts.sslEnabled,
              certStatus: sslCertificates.status,
              certNotAfter: sslCertificates.notAfter,
              certRenewalFailures: sslCertificates.renewalFailureCount,
            })
            .from(proxyHosts)
            .leftJoin(sslCertificates, eq(sslCertificates.id, proxyHosts.sslCertificateId))
            .where(inArray(proxyHosts.id, list))
        ),
        this.rows(ids('database'), (list) =>
          this.db
            .select({
              id: databaseConnections.id,
              healthStatus: databaseConnections.healthStatus,
              lastHealthCheckAt: databaseConnections.lastHealthCheckAt,
            })
            .from(databaseConnections)
            .where(inArray(databaseConnections.id, list))
        ),
        this.rows(ids('storage'), (list) =>
          this.db
            .select({
              id: objectStorageConnections.id,
              healthStatus: objectStorageConnections.healthStatus,
              lastHealthCheckAt: objectStorageConnections.lastHealthCheckAt,
            })
            .from(objectStorageConnections)
            .where(inArray(objectStorageConnections.id, list))
        ),
        this.rows(ids('compose'), (list) =>
          this.db
            .select({
              id: dockerComposeProjects.id,
              name: dockerComposeProjects.name,
              status: dockerComposeProjects.status,
              desiredState: dockerComposeProjects.desiredState,
            })
            .from(dockerComposeProjects)
            .where(inArray(dockerComposeProjects.id, list))
        ),
        this.rows(ids('deployment'), (list) =>
          this.db
            .select({
              id: dockerDeployments.id,
              status: dockerDeployments.status,
              activeSlot: dockerDeployments.activeSlot,
            })
            .from(dockerDeployments)
            .where(inArray(dockerDeployments.id, list))
        ),
        this.rows(ids('database'), (list) =>
          this.db
            .select({
              id: managedDatabaseInstances.databaseConnectionId,
              status: managedDatabaseInstances.status,
              updatedAt: managedDatabaseInstances.updatedAt,
            })
            .from(managedDatabaseInstances)
            .where(inArray(managedDatabaseInstances.databaseConnectionId, list))
        ),
        this.rows(ids('storage'), (list) =>
          this.db
            .select({
              id: managedStorageClusters.objectStorageConnectionId,
              status: managedStorageClusters.status,
              updatedAt: managedStorageClusters.updatedAt,
            })
            .from(managedStorageClusters)
            .where(inArray(managedStorageClusters.objectStorageConnectionId, list))
        ),
        this.rows(ids('pages'), (list) =>
          this.db
            .select({
              projectId: pageRouteTargets.projectId,
              status: pageRouteTargets.status,
              activeDeploymentId: pageRouteTargets.activeDeploymentId,
              routeEnabled: proxyHosts.enabled,
            })
            .from(pageRouteTargets)
            .innerJoin(proxyHosts, eq(proxyHosts.id, pageRouteTargets.proxyHostId))
            .where(inArray(pageRouteTargets.projectId, list))
        ),
      ]);
    const [databaseSets, storageSets, nodeRows] = await Promise.all([
      this.rows(ids('database'), (list) =>
        this.db
          .select({ id: managedDatabaseInstances.databaseConnectionId, state: managedAvailabilitySets.state })
          .from(managedAvailabilitySets)
          .innerJoin(
            managedDatabaseInstances,
            eq(managedDatabaseInstances.id, managedAvailabilitySets.managedDatabaseId)
          )
          .where(inArray(managedDatabaseInstances.databaseConnectionId, list))
      ),
      this.rows(ids('storage'), (list) =>
        this.db
          .select({ id: managedStorageClusters.objectStorageConnectionId, state: managedAvailabilitySets.state })
          .from(managedAvailabilitySets)
          .innerJoin(
            managedStorageClusters,
            eq(managedStorageClusters.id, managedAvailabilitySets.managedStorageClusterId)
          )
          .where(inArray(managedStorageClusters.objectStorageConnectionId, list))
      ),
      this.rows(
        members.flatMap((member) => member.nodeIds),
        (list) =>
          this.db
            .select({ id: nodes.id, status: nodes.status, lastSeenAt: nodes.lastSeenAt })
            .from(nodes)
            .where(inArray(nodes.id, list))
      ),
    ]);
    const setStateOf = (rows: Array<{ id: string | null; state: ManagedAvailabilityState }>) =>
      new Map(rows.filter((row) => row.id).map((row) => [row.id!, row.state]));
    const databaseSetState = setStateOf(databaseSets);
    const storageSetState = setStateOf(storageSets);
    const deploymentIds = deployments.map((row) => row.id);
    const containerMembers = members.filter((member) => member.type === 'container');
    const workloads = members.filter((member) => member.type === 'container' || member.type === 'deployment');
    const cache = container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
    const [deploymentChecks, slots, containerChecks, restartSamples] = await Promise.all([
      this.rows(deploymentIds, (list) =>
        this.db
          .select({ deploymentId: dockerHealthChecks.deploymentId, healthStatus: dockerHealthChecks.healthStatus })
          .from(dockerHealthChecks)
          .where(and(inArray(dockerHealthChecks.deploymentId, list), eq(dockerHealthChecks.enabled, true)))
      ),
      this.rows(deploymentIds, (list) =>
        this.db
          .select({
            deploymentId: dockerDeploymentSlots.deploymentId,
            slot: dockerDeploymentSlots.slot,
            containerName: dockerDeploymentSlots.containerName,
          })
          .from(dockerDeploymentSlots)
          .where(inArray(dockerDeploymentSlots.deploymentId, list))
      ),
      this.rows(
        containerMembers.map((member) => member.nodeId!),
        (nodeIds) =>
          this.db
            .select({
              nodeId: dockerHealthChecks.nodeId,
              containerName: dockerHealthChecks.containerName,
              healthStatus: dockerHealthChecks.healthStatus,
            })
            .from(dockerHealthChecks)
            .where(
              and(
                inArray(dockerHealthChecks.nodeId, [...new Set(nodeIds)]),
                isNotNull(dockerHealthChecks.containerName),
                eq(dockerHealthChecks.enabled, true)
              )
            )
      ),
      Promise.all(
        workloads.map((member) =>
          readSamples<WorkloadSample>(cache, workloadSampleKey(member.type, member.id), RECENT_SAMPLES)
        )
      ),
    ]);
    const runtime = await this.containerRuntime([
      ...new Set(members.filter((member) => member.nodeId).map((member) => member.nodeId!)),
    ]);

    const certificates = await certificateMemberHealths(this.db, ids('certificate'));
    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
    const routeById = byId(routes);
    const databaseById = byId(databases);
    const storageById = byId(storages);
    const composeById = byId(composes);
    const deploymentById = byId(deployments);
    const managedStatus = new Map(
      [...managedDatabases, ...managedStorages].filter((row) => row.id).map((row) => [row.id!, row.status])
    );
    const managedChangedAt = new Map(
      [...managedDatabases, ...managedStorages].filter((row) => row.id).map((row) => [row.id!, row.updatedAt])
    );
    const restartsOf = (member: AppMember) => recentRestartsOf(restartSamples[workloads.indexOf(member)] ?? [], now);
    // A node offline past NODE_UNREACHABLE_AFTER_MS: what its last snapshot said is no longer the member's state.
    const unreachable = new Set(
      nodeRows
        .filter(
          (row) =>
            (row.status === 'offline' || row.status === 'error') &&
            (!row.lastSeenAt || now - row.lastSeenAt.getTime() >= NODE_UNREACHABLE_AFTER_MS)
        )
        .map((row) => row.id)
    );

    const statuses = members.map((member): MemberStatus => {
      const base = { member, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null };
      switch (member.type) {
        case 'route': {
          const row = routeById.get(member.id);
          if (!row?.enabled) return { ...base, health: 'none', neutral: 'disabled' };
          if (effectiveMaintenance(row)) return { ...base, health: 'none', neutral: 'maintenance' };
          if (row.rawConfigEnabled) return { ...base, health: 'none' };
          const fromCheck = healthFromStatus(row.healthStatus);
          const checked: MemberAssessment =
            fromCheck === 'failing'
              ? { health: 'failing', reason: 'Its health check fails' }
              : fromCheck === 'degraded'
                ? { health: 'degraded', reason: 'Its health check is slow' }
                : { health: fromCheck };
          const cert: MemberAssessment = row.sslEnabled
            ? certificateState(
                row.certStatus
                  ? { status: row.certStatus, notAfter: row.certNotAfter, renewalFailureCount: row.certRenewalFailures }
                  : null,
                now
              )
            : { health: 'none' };
          return { ...base, ...worse(checked, cert) };
        }
        case 'database':
        case 'storage': {
          const managed = managedStatus.get(member.id);
          if (managed === 'stopped' || managed === 'paused') {
            return { ...base, health: 'degraded', reason: 'Stopped: what depends on it cannot reach it' };
          }
          const row = member.type === 'database' ? databaseById.get(member.id) : storageById.get(member.id);
          // A check from before the instance last changed (started again after an app shutdown, created, updated)
          // says nothing about it yet: neutral until the next check, not failing for the minute until it runs.
          const changedAt = managedChangedAt.get(member.id);
          if (
            changedAt &&
            row?.healthStatus === 'offline' &&
            (!row.lastHealthCheckAt || row.lastHealthCheckAt < changedAt)
          ) {
            return { ...base, health: 'none', neutral: 'starting' };
          }
          const sets = member.type === 'database' ? databaseSetState : storageSetState;
          const health = withAvailabilityState(healthFromStatus(row?.healthStatus), sets.get(member.id));
          return {
            ...base,
            health,
            ...(health === 'failing'
              ? { reason: 'It does not answer' }
              : health === 'degraded'
                ? { reason: sets.get(member.id) ? 'A copy is missing or cannot take over' : 'It answers slowly' }
                : {}),
          };
        }
        case 'pages': {
          const serving = pageTargets.some(
            (target) =>
              target.projectId === member.id &&
              target.routeEnabled &&
              target.status === 'ready' &&
              target.activeDeploymentId
          );
          return serving
            ? { ...base, health: 'healthy' }
            : { ...base, health: 'degraded', reason: 'Not serving: no enabled route serves an active deployment' };
        }
        case 'compose': {
          const row = composeById.get(member.id);
          const own = [...runtime.entries()]
            .filter(
              ([key, entry]) =>
                key.startsWith(`${member.nodeId}\u0000`) && row?.name === entry.labels[COMPOSE_PROJECT_LABEL]
            )
            .map(([, entry]) => entry);
          return { ...base, ...composeState(row?.status, row?.desiredState, own) };
        }
        case 'deployment': {
          const row = deploymentById.get(member.id);
          const checkRow = deploymentChecks.find((item) => item.deploymentId === member.id);
          const slot = slots.find((item) => item.deploymentId === member.id && item.slot === row?.activeSlot);
          const stats = slot ? runtime.get(`${member.nodeId}\u0000${slot.containerName}`) : undefined;
          return {
            ...base,
            runtimeName: slot?.containerName ?? null,
            runtimeId: stats?.id ?? null,
            hasHealthCheck: checkRow !== undefined,
            ...deploymentState(row?.status, checkRow?.healthStatus, stats, restartsOf(member)),
            cpuPercent: stats?.cpuPercent ?? null,
            memoryBytes: stats?.memoryBytes ?? null,
            memoryLimitBytes: stats?.memoryLimitBytes ?? null,
          };
        }
        case 'container': {
          const stats = runtime.get(`${member.nodeId}\u0000${member.id}`);
          const checkRow = containerChecks.find(
            (item) => item.nodeId === member.nodeId && item.containerName === member.id
          );
          return {
            ...base,
            runtimeName: member.id,
            runtimeId: stats?.id ?? null,
            hasHealthCheck: checkRow !== undefined,
            ...containerState(stats?.state, checkRow?.healthStatus, stats, restartsOf(member)),
            cpuPercent: stats?.cpuPercent ?? null,
            memoryBytes: stats?.memoryBytes ?? null,
            memoryLimitBytes: stats?.memoryLimitBytes ?? null,
          };
        }
        case 'certificate':
          return { ...base, ...(certificates.get(member.id) ?? { health: 'none' }) };
        default:
          return { ...base, health: 'none' };
      }
    });

    const routeTargets = new Map(
      routes.map((row) => [
        row.id,
        row.upstreamKind === 'docker_container'
          ? row.dockerComposeProjectId
            ? workloadKey('compose', null, row.dockerComposeProjectId)
            : workloadKey('container', row.dockerNodeId, row.dockerContainerName)
          : row.upstreamKind === 'docker_deployment'
            ? workloadKey('deployment', null, row.dockerDeploymentId)
            : null,
      ])
    );
    applyCrossMemberRules(statuses, routeTargets, unreachable);
    return statuses;
  }

  /**
   * Runtime state from the Docker snapshot (state, list status with the exit code, labels, container id) and the
   * latest stats the node reported, by `<nodeId>\0<name>`. A container that exited with 137 is inspected for Docker's
   * OOM flag (cached briefly), the one thing that tells an OOM kill from a stop.
   */
  private async containerRuntime(nodeIds: readonly string[]) {
    const result = new Map<string, RuntimeEntry>();
    const snapshots = container.isRegistered(DockerSnapshotService) ? container.resolve(DockerSnapshotService) : null;
    const registry = container.isRegistered(NodeRegistryService) ? container.resolve(NodeRegistryService) : null;
    for (const nodeId of nodeIds) {
      const list = snapshots
        ? await snapshots.getList<Array<Record<string, any>>>(nodeId, 'containers').catch(() => null)
        : null;
      for (const item of Array.isArray(list?.data) ? list.data : []) {
        const name = String(item.name ?? item.Name ?? '').replace(/^\/+/, '');
        if (!name) continue;
        result.set(`${nodeId}\u0000${name}`, {
          id: String(item.id ?? item.Id ?? '') || null,
          state: String(item.state ?? item.State ?? ''),
          status: String(item.status ?? item.Status ?? '') || null,
          labels: (item.labels ?? item.Labels ?? {}) as Record<string, string>,
          oomKilled: null,
          cpuPercent: null,
          memoryBytes: null,
          memoryLimitBytes: null,
        });
      }
      const stats = (registry?.getNode(nodeId)?.lastHealthReport as { containerStats?: unknown[] } | null)
        ?.containerStats;
      for (const stat of Array.isArray(stats) ? (stats as Array<Record<string, unknown>>) : []) {
        const name = String(stat.name ?? '').replace(/^\/+/, '');
        if (!name) continue;
        const key = `${nodeId}\u0000${name}`;
        const entry = result.get(key) ?? {
          id: String(stat.containerId ?? '') || null,
          state: String(stat.state ?? ''),
          status: null,
          labels: {},
          oomKilled: null,
          cpuPercent: null,
          memoryBytes: null,
          memoryLimitBytes: null,
        };
        // A report without a metrics sample (a container that just started) carries zeros: unknown, not 0.
        if (stat.metricsAvailable !== false && stat.metrics_available !== false) {
          entry.cpuPercent = numberOf(stat.cpuPercent ?? stat.cpu_percent);
          entry.memoryBytes = numberOf(stat.memoryUsageBytes ?? stat.memory_usage_bytes);
          entry.memoryLimitBytes = numberOf(stat.memoryLimitBytes ?? stat.memory_limit_bytes);
        }
        result.set(key, entry);
      }
    }
    await Promise.all(
      [...result.entries()].map(async ([key, entry]) => {
        if (entry.state?.toLowerCase() !== 'exited' || containerExitCode(entry.status) !== 137 || !entry.id) return;
        entry.oomKilled = await this.oomKilled(key.split('\u0000')[0]!, entry.id);
      })
    );
    return result;
  }

  /** Docker's OOMKilled flag of a container (null when the node does not answer). */
  private async oomKilled(nodeId: string, containerId: string): Promise<boolean | null> {
    const key = `${nodeId}\u0000${containerId}`;
    const cached = this.oomVerdicts.get(key);
    if (cached && Date.now() - cached.at < OOM_CHECK_TTL_MS) return cached.oomKilled;
    const dispatch = container.isRegistered(NodeDispatchService) ? container.resolve(NodeDispatchService) : null;
    const result = dispatch
      ? await dispatch
          .sendDockerContainerCommand(nodeId, 'inspect', { containerId }, OOM_CHECK_TIMEOUT_MS)
          .catch(() => null)
      : null;
    const oomKilled = result?.success ? oomKilledOf(result.detail) : null;
    if (this.oomVerdicts.size > 1_000) this.oomVerdicts.clear();
    if (oomKilled !== null) this.oomVerdicts.set(key, { at: Date.now(), oomKilled });
    return oomKilled;
  }

  private async rows<T>(list: readonly string[], query: (list: string[]) => Promise<T[]>): Promise<T[]> {
    const unique = [...new Set(list.filter(Boolean))];
    return unique.length ? query(unique) : [];
  }
}

/** Docker's State.OOMKilled from a container inspect result, or null. */
export function oomKilledOf(detail: unknown): boolean | null {
  let parsed: unknown = detail;
  if (typeof detail === 'string') {
    try {
      parsed = JSON.parse(detail);
    } catch {
      return null;
    }
  }
  const flag = (parsed as { State?: { OOMKilled?: unknown } } | null)?.State?.OOMKilled;
  return typeof flag === 'boolean' ? flag : null;
}

/** A database's disk use against its size limit (percent, one decimal), or null without either. */
export function databaseDiskPercent(sizeBytes: number | null, limitMb: number | null): number | null {
  return sizeBytes !== null && limitMb ? Math.round((sizeBytes / (limitMb * 1024 * 1024)) * 1000) / 10 : null;
}

/** A storage's disk use against its quota (percent, one decimal), or null without either. */
export function storageDiskPercent(usedBytes: number | null, totalBytes: number | null): number | null {
  return usedBytes !== null && totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null;
}
