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
  objectStorageConnections,
  proxyHosts,
} from '@/db/schema/index.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { effectiveMaintenance } from '@/modules/proxy/effective-maintenance.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { AppMember, AppMembersReader } from './app-members.service.js';
import type { AppHealth, AppHealthProvider, EnvironmentHealthSummary } from './apps.service.js';

/** A member's state: `none` when it does not count (a disabled route, a route in maintenance). */
export type MemberHealth = AppHealth | 'none';

export interface MemberStatus {
  member: AppMember;
  health: MemberHealth;
  /** Latest CPU percent and memory bytes of a container or the active deployment slot. */
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  /** Docker runtime container name: the container itself, or the active slot of a deployment. */
  runtimeName?: string | null;
}

/** failing beats degraded beats healthy; no member is healthy. */
export function combineHealth(states: readonly MemberHealth[]): AppHealth {
  if (states.includes('failing')) return 'failing';
  if (states.includes('degraded')) return 'degraded';
  return 'healthy';
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
  if (!state || state === 'healthy' || health === 'none') return health;
  if (health === 'healthy') return 'degraded';
  if (health === 'failing' && state === 'failing_over') return 'degraded';
  return health;
}

/** A container from its runtime state and its Gateway health check. */
export function containerHealth(state: string | null | undefined, check: string | null | undefined): MemberHealth {
  const runtime = String(state ?? '').toLowerCase();
  if (runtime === 'running') {
    const fromCheck = healthFromStatus(check);
    return fromCheck === 'none' ? 'healthy' : fromCheck;
  }
  if (runtime === 'restarting' || runtime === 'paused' || runtime === 'pending') return 'degraded';
  return 'failing';
}

export function deploymentHealth(status: string | null | undefined, check: string | null | undefined): MemberHealth {
  switch (status) {
    case 'ready': {
      const fromCheck = healthFromStatus(check);
      return fromCheck === 'none' ? 'healthy' : fromCheck;
    }
    case 'creating':
    case 'deploying':
    case 'switching':
    case 'degraded':
      return 'degraded';
    default:
      return 'failing';
  }
}

export function composeHealth(status: string | null | undefined): MemberHealth {
  switch (status) {
    case 'running':
      return 'healthy';
    case 'validating':
    case 'applying':
    case 'degraded':
    case 'discovered':
      return 'degraded';
    default:
      return 'failing';
  }
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Health of app members and environments. Members count only when the caller may view them. An environment is
 * failing when any member fails, else degraded when any is degraded, else healthy (empty: healthy). CPU and memory
 * are the latest container stats the nodes reported.
 */
export class AppHealthService implements AppHealthProvider {
  constructor(
    private readonly db: DrizzleClient,
    private readonly members: AppMembersReader
  ) {}

  async summarizeEnvironments(
    scopes: readonly string[],
    environmentIds: readonly string[]
  ): Promise<Map<string, EnvironmentHealthSummary>> {
    const statuses = await this.memberStatuses(await this.members.listVisibleMembers(scopes, environmentIds));
    const result = new Map<string, EnvironmentHealthSummary>();
    for (const environmentId of environmentIds) {
      const own = statuses.filter((status) => status.member.environmentId === environmentId);
      const counted = own.filter((status) => status.health !== 'none');
      const cpu = own.map((status) => status.cpuPercent).filter((value): value is number => value !== null);
      const memory = own.map((status) => status.memoryBytes).filter((value): value is number => value !== null);
      result.set(environmentId, {
        health: combineHealth(counted.map((status) => status.health)),
        running: counted.filter((status) => status.health === 'healthy').length,
        failing: counted.filter((status) => status.health === 'failing').length,
        degraded: counted.filter((status) => status.health === 'degraded').length,
        cpuPercent: cpu.length ? Math.round(cpu.reduce((sum, value) => sum + value, 0) * 10) / 10 : null,
        memoryBytes: memory.length ? memory.reduce((sum, value) => sum + value, 0) : null,
      });
    }
    return result;
  }

  /** The state of each member, read in one query per source. */
  async memberStatuses(members: readonly AppMember[]): Promise<MemberStatus[]> {
    const ids = (type: AppMember['type']) =>
      members.filter((member) => member.type === type).map((member) => member.id);
    const [routes, databases, storages, composes, deployments] = await Promise.all([
      this.rows(ids('route'), (list) =>
        this.db
          .select({
            id: proxyHosts.id,
            enabled: proxyHosts.enabled,
            healthStatus: proxyHosts.healthStatus,
            rawConfigEnabled: proxyHosts.rawConfigEnabled,
            maintenanceEnabled: proxyHosts.maintenanceEnabled,
            appMaintenanceMode: proxyHosts.appMaintenanceMode,
          })
          .from(proxyHosts)
          .where(inArray(proxyHosts.id, list))
      ),
      this.rows(ids('database'), (list) =>
        this.db
          .select({ id: databaseConnections.id, healthStatus: databaseConnections.healthStatus })
          .from(databaseConnections)
          .where(inArray(databaseConnections.id, list))
      ),
      this.rows(ids('storage'), (list) =>
        this.db
          .select({ id: objectStorageConnections.id, healthStatus: objectStorageConnections.healthStatus })
          .from(objectStorageConnections)
          .where(inArray(objectStorageConnections.id, list))
      ),
      this.rows(ids('compose'), (list) =>
        this.db
          .select({ id: dockerComposeProjects.id, status: dockerComposeProjects.status })
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
    ]);
    const [databaseSets, storageSets] = await Promise.all([
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
    ]);
    const setStateOf = (rows: Array<{ id: string | null; state: ManagedAvailabilityState }>) =>
      new Map(rows.filter((row) => row.id).map((row) => [row.id!, row.state]));
    const databaseSetState = setStateOf(databaseSets);
    const storageSetState = setStateOf(storageSets);
    const deploymentIds = deployments.map((row) => row.id);
    const containerMembers = members.filter((member) => member.type === 'container');
    const [deploymentChecks, slots, containerChecks] = await Promise.all([
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
    ]);
    const runtime = await this.containerRuntime([
      ...new Set(members.filter((member) => member.nodeId).map((member) => member.nodeId!)),
    ]);

    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
    const routeById = byId(routes);
    const databaseById = byId(databases);
    const storageById = byId(storages);
    const composeById = byId(composes);
    const deploymentById = byId(deployments);

    return members.map((member): MemberStatus => {
      const base = { member, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null };
      switch (member.type) {
        case 'route': {
          const row = routeById.get(member.id);
          if (!row?.enabled || row.rawConfigEnabled || effectiveMaintenance(row)) return { ...base, health: 'none' };
          return { ...base, health: healthFromStatus(row.healthStatus) };
        }
        case 'database':
          return {
            ...base,
            health: withAvailabilityState(
              healthFromStatus(databaseById.get(member.id)?.healthStatus),
              databaseSetState.get(member.id)
            ),
          };
        case 'storage':
          return {
            ...base,
            health: withAvailabilityState(
              healthFromStatus(storageById.get(member.id)?.healthStatus),
              storageSetState.get(member.id)
            ),
          };
        case 'pages':
          return { ...base, health: 'none' };
        case 'compose':
          return { ...base, health: composeHealth(composeById.get(member.id)?.status) };
        case 'deployment': {
          const row = deploymentById.get(member.id);
          const check = deploymentChecks.find((item) => item.deploymentId === member.id)?.healthStatus;
          const slot = slots.find((item) => item.deploymentId === member.id && item.slot === row?.activeSlot);
          const stats = slot ? runtime.get(`${member.nodeId}\u0000${slot.containerName}`) : undefined;
          return {
            ...base,
            runtimeName: slot?.containerName ?? null,
            health: deploymentHealth(row?.status, check),
            cpuPercent: stats?.cpuPercent ?? null,
            memoryBytes: stats?.memoryBytes ?? null,
            memoryLimitBytes: stats?.memoryLimitBytes ?? null,
          };
        }
        case 'container': {
          const stats = runtime.get(`${member.nodeId}\u0000${member.id}`);
          const check = containerChecks.find(
            (item) => item.nodeId === member.nodeId && item.containerName === member.id
          )?.healthStatus;
          return {
            ...base,
            runtimeName: member.id,
            health: containerHealth(stats?.state, check),
            cpuPercent: stats?.cpuPercent ?? null,
            memoryBytes: stats?.memoryBytes ?? null,
            memoryLimitBytes: stats?.memoryLimitBytes ?? null,
          };
        }
        default:
          return { ...base, health: 'none' };
      }
    });
  }

  /** Runtime state from the Docker snapshot and the latest stats the node reported, by `<nodeId>\0<name>`. */
  private async containerRuntime(nodeIds: readonly string[]) {
    const result = new Map<
      string,
      { state: string | null; cpuPercent: number | null; memoryBytes: number | null; memoryLimitBytes: number | null }
    >();
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
          state: String(item.state ?? item.State ?? ''),
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
          state: String(stat.state ?? ''),
          cpuPercent: null,
          memoryBytes: null,
          memoryLimitBytes: null,
        };
        entry.cpuPercent = numberOf(stat.cpuPercent ?? stat.cpu_percent);
        entry.memoryBytes = numberOf(stat.memoryUsageBytes ?? stat.memory_usage_bytes);
        entry.memoryLimitBytes = numberOf(stat.memoryLimitBytes ?? stat.memory_limit_bytes);
        result.set(key, entry);
      }
    }
    return result;
  }

  private async rows<T>(list: readonly string[], query: (list: string[]) => Promise<T[]>): Promise<T[]> {
    const unique = [...new Set(list.filter(Boolean))];
    return unique.length ? query(unique) : [];
  }
}
