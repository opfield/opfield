import { and, eq, inArray, like, ne, or, type SQL } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  containerLinks,
  dockerComposeProjects,
  dockerDeploymentSlots,
  dockerDeployments,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  managedStorageClusters,
  pageRouteTargets,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { DockerWorkloadResolverService } from '@/modules/docker/availability/docker-workload-resolver.service.js';
import { labelString } from '@/modules/docker/docker-managed-labels.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import type { AppMember, AppMembersReader } from './app-members.service.js';

export interface RouteTarget {
  id: string;
  type: string;
  rawConfigEnabled: boolean;
  isSystem: boolean;
  enabled: boolean;
  maintenanceEnabled: boolean;
  appMaintenanceMode: string;
  domainNames: string[];
  /** A route outside the environment whose upstream is a member (container, deployment, Compose, Pages). */
  derived: boolean;
  /** A route serving a member Pages project. */
  pages: boolean;
}

export interface ContainerTarget {
  nodeId: string;
  name: string;
  running: boolean;
  owner: { type: 'container' | 'deployment' | 'compose'; id: string };
}

export interface IncidentTargets {
  environmentId: string;
  members: AppMember[];
  routes: RouteTarget[];
  containers: ContainerTarget[];
  containerLinks: Array<{ id: string; desiredState: string }>;
  databaseBindings: Array<{ id: string; desiredState: string }>;
  storageBindings: Array<{ id: string; desiredState: string }>;
  secureLinks: Array<{ id: string; incidentSuspendedBy: string | null }>;
  databases: Array<{
    id: string;
    connectionId: string;
    name: string;
    status: string;
    publishedPort: number | null;
    publishedNativePort: number | null;
  }>;
  storages: Array<{
    id: string;
    connectionId: string;
    name: string;
    status: string;
    publishS3: boolean;
    publishedPort: number;
  }>;
  deployments: Array<{ id: string; nodeId: string; name: string; status: string }>;
  composeProjects: Array<{ id: string; nodeId: string; name: string; status: string }>;
}

type SnapshotContainer = Record<string, any>;

function containerName(row: SnapshotContainer): string {
  const raw = row.name ?? row.Name ?? (Array.isArray(row.names) ? row.names[0] : undefined) ?? row.Names?.[0] ?? '';
  return String(raw).replace(/^\/+/, '');
}

function containerLabels(row: SnapshotContainer): Record<string, string> {
  return (row.labels ?? row.Labels ?? {}) as Record<string, string>;
}

function containerRunning(row: SnapshotContainer): boolean {
  return String(row.state ?? row.State ?? '').toLowerCase() === 'running';
}

/** Container names an Availability placement runs (a container, deployment slots, or Compose service containers). */
function placementContainerNames(identity: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) names.add(value.replace(/^\/+/, ''));
  };
  add(identity.containerName);
  const slots = identity.slots;
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) for (const value of Object.values(slots)) add(value);
  if (Array.isArray(identity.containers)) {
    for (const entry of identity.containers as Array<Record<string, unknown>>) add(entry?.containerName);
  }
  return [...names];
}

/**
 * Everything an incident of one environment touches, read fresh from the database and the Docker snapshots: member
 * routes and routes whose upstream is a member, every container of every member (deployment slots and router, Compose
 * service containers, Availability placements on other nodes), container links, database and storage bindings and
 * Secure Links touching a member, and the managed databases, storage, deployments and Compose projects themselves.
 */
export class AppIncidentTargetsReader {
  constructor(
    private readonly db: DrizzleClient,
    private readonly members: AppMembersReader
  ) {}

  private async snapshot(nodeId: string): Promise<SnapshotContainer[]> {
    if (!container.isRegistered(DockerSnapshotService)) return [];
    try {
      const envelope = await container
        .resolve(DockerSnapshotService)
        .getList<SnapshotContainer[]>(nodeId, 'containers');
      return Array.isArray(envelope?.data) ? envelope.data : [];
    } catch {
      return [];
    }
  }

  async collect(environmentId: string): Promise<IncidentTargets> {
    const members = await this.members.listMembers([environmentId]);
    const of = (type: AppMember['type']) => members.filter((member) => member.type === type);
    const memberContainers = of('container');
    const deploymentIds = of('deployment').map((member) => member.id);
    const composeIds = of('compose').map((member) => member.id);
    const pagesIds = of('pages').map((member) => member.id);
    const routeIds = of('route').map((member) => member.id);
    const databaseConnectionIds = of('database').map((member) => member.id);
    const storageConnectionIds = of('storage').map((member) => member.id);

    const [deployments, composeProjects, databases, storages] = await Promise.all([
      deploymentIds.length
        ? this.db
            .select({
              id: dockerDeployments.id,
              nodeId: dockerDeployments.nodeId,
              name: dockerDeployments.name,
              status: dockerDeployments.status,
              routerName: dockerDeployments.routerName,
            })
            .from(dockerDeployments)
            .where(inArray(dockerDeployments.id, deploymentIds))
        : [],
      composeIds.length
        ? this.db
            .select({
              id: dockerComposeProjects.id,
              nodeId: dockerComposeProjects.nodeId,
              name: dockerComposeProjects.name,
              status: dockerComposeProjects.status,
            })
            .from(dockerComposeProjects)
            .where(inArray(dockerComposeProjects.id, composeIds))
        : [],
      databaseConnectionIds.length
        ? this.db
            .select({
              id: managedDatabaseInstances.id,
              connectionId: managedDatabaseInstances.databaseConnectionId,
              name: managedDatabaseInstances.name,
              status: managedDatabaseInstances.status,
              publishedPort: managedDatabaseInstances.publishedPort,
              publishedNativePort: managedDatabaseInstances.publishedNativePort,
            })
            .from(managedDatabaseInstances)
            .where(inArray(managedDatabaseInstances.databaseConnectionId, databaseConnectionIds))
        : [],
      storageConnectionIds.length
        ? this.db
            .select({
              id: managedStorageClusters.id,
              connectionId: managedStorageClusters.objectStorageConnectionId,
              name: managedStorageClusters.name,
              status: managedStorageClusters.status,
              publishS3: managedStorageClusters.publishS3,
              publishedPort: managedStorageClusters.publishedPort,
            })
            .from(managedStorageClusters)
            .where(inArray(managedStorageClusters.objectStorageConnectionId, storageConnectionIds))
        : [],
    ]);
    const slots = deploymentIds.length
      ? await this.db
          .select({
            deploymentId: dockerDeploymentSlots.deploymentId,
            containerName: dockerDeploymentSlots.containerName,
          })
          .from(dockerDeploymentSlots)
          .where(inArray(dockerDeploymentSlots.deploymentId, deploymentIds))
      : [];

    // Containers on their own nodes, from the snapshots (running state included).
    const containers = new Map<string, ContainerTarget>();
    const snapshots = new Map<string, SnapshotContainer[]>();
    const snapshotOf = async (nodeId: string) => {
      if (!snapshots.has(nodeId)) snapshots.set(nodeId, await this.snapshot(nodeId));
      return snapshots.get(nodeId)!;
    };
    const addContainer = async (nodeId: string, name: string, owner: ContainerTarget['owner']) => {
      const key = `${nodeId}:${name}`;
      if (!name || containers.has(key)) return;
      const row = (await snapshotOf(nodeId)).find((item) => containerName(item) === name);
      containers.set(key, { nodeId, name, running: row ? containerRunning(row) : false, owner });
    };
    for (const member of memberContainers) {
      await addContainer(member.nodeId!, member.id, { type: 'container', id: member.id });
    }
    for (const deployment of deployments) {
      const owner = { type: 'deployment' as const, id: deployment.id };
      for (const slot of slots.filter((row) => row.deploymentId === deployment.id)) {
        await addContainer(deployment.nodeId, slot.containerName, owner);
      }
      await addContainer(deployment.nodeId, deployment.routerName, owner);
      for (const row of await snapshotOf(deployment.nodeId)) {
        if (labelString(containerLabels(row), 'deployment.id') === deployment.id) {
          await addContainer(deployment.nodeId, containerName(row), owner);
        }
      }
    }
    for (const project of composeProjects) {
      const owner = { type: 'compose' as const, id: project.id };
      for (const row of await snapshotOf(project.nodeId)) {
        if (containerLabels(row)['com.docker.compose.project'] === project.name) {
          await addContainer(project.nodeId, containerName(row), owner);
        }
      }
    }
    // Availability placements of member workloads on every node.
    if (container.isRegistered(DockerWorkloadResolverService)) {
      const resolver = container.resolve(DockerWorkloadResolverService);
      const resources = [
        ...memberContainers.map((member) => ({
          resource: { type: 'container' as const, nodeId: member.nodeId!, containerName: member.id },
          owner: { type: 'container' as const, id: member.id },
        })),
        ...deployments.map((deployment) => ({
          resource: { type: 'deployment' as const, deploymentId: deployment.id },
          owner: { type: 'deployment' as const, id: deployment.id },
        })),
        ...composeProjects.map((project) => ({
          resource: { type: 'compose' as const, composeProjectId: project.id },
          owner: { type: 'compose' as const, id: project.id },
        })),
      ];
      for (const { resource, owner } of resources) {
        const workload = await resolver.resolve(resource as never).catch(() => null);
        for (const placement of workload?.placements ?? []) {
          for (const name of placementContainerNames(placement.runtimeIdentity ?? {})) {
            await addContainer(placement.nodeId, name, owner);
          }
        }
      }
    }

    // Routes: members, plus routes outside the environment whose upstream is a member.
    const derivedConditions: SQL[] = [];
    for (const member of memberContainers) {
      derivedConditions.push(
        and(
          eq(proxyHosts.upstreamKind, 'docker_container'),
          eq(proxyHosts.dockerNodeId, member.nodeId!),
          eq(proxyHosts.dockerContainerName, member.id)
        )!
      );
    }
    if (deploymentIds.length) derivedConditions.push(inArray(proxyHosts.dockerDeploymentId, deploymentIds));
    if (composeIds.length) derivedConditions.push(inArray(proxyHosts.dockerComposeProjectId, composeIds));
    let pageRouteIds = new Set<string>();
    if (pagesIds.length) {
      const pageRoutes = await this.db
        .select({ proxyHostId: pageRouteTargets.proxyHostId })
        .from(pageRouteTargets)
        .where(inArray(pageRouteTargets.projectId, pagesIds));
      pageRouteIds = new Set(pageRoutes.map((row) => row.proxyHostId));
      if (pageRoutes.length) {
        derivedConditions.push(
          inArray(
            proxyHosts.id,
            pageRoutes.map((row) => row.proxyHostId)
          )
        );
      }
    }
    const routeColumns = {
      id: proxyHosts.id,
      type: proxyHosts.type,
      rawConfigEnabled: proxyHosts.rawConfigEnabled,
      isSystem: proxyHosts.isSystem,
      enabled: proxyHosts.enabled,
      maintenanceEnabled: proxyHosts.maintenanceEnabled,
      appMaintenanceMode: proxyHosts.appMaintenanceMode,
      domainNames: proxyHosts.domainNames,
    };
    const routeRows = routeIds.length
      ? await this.db.select(routeColumns).from(proxyHosts).where(inArray(proxyHosts.id, routeIds))
      : [];
    const derivedRows = derivedConditions.length
      ? await this.db
          .select(routeColumns)
          .from(proxyHosts)
          .where(and(or(...derivedConditions), eq(proxyHosts.isSystem, false)))
      : [];
    const routes = new Map<string, RouteTarget>();
    const routeOf = (row: (typeof routeRows)[number], derived: boolean): RouteTarget => ({
      ...row,
      domainNames: Array.isArray(row.domainNames) ? row.domainNames : [],
      derived,
      pages: pageRouteIds.has(row.id),
    });
    for (const row of routeRows) routes.set(row.id, routeOf(row, false));
    for (const row of derivedRows) if (!routes.has(row.id)) routes.set(row.id, routeOf(row, true));

    // Links, bindings and Secure Links touching a member workload (or a member database/storage).
    const workloadRefs: Array<{ nodeId: string; type: string; resourceId?: string; prefix?: string }> = [
      ...memberContainers.map((member) => ({ nodeId: member.nodeId!, type: 'container', resourceId: member.id })),
      ...deployments.map((deployment) => ({
        nodeId: deployment.nodeId,
        type: 'deployment',
        resourceId: deployment.id,
      })),
      ...composeProjects.map((project) => ({
        nodeId: project.nodeId,
        type: 'compose_service',
        prefix: `${project.id}:`,
      })),
    ];
    const refCondition = (nodeColumn: any, typeColumn: any, idColumn: any): SQL | undefined => {
      const parts = workloadRefs.map((ref) =>
        ref.prefix
          ? and(eq(nodeColumn, ref.nodeId), eq(typeColumn, ref.type), like(idColumn, `${ref.prefix}%`))!
          : and(eq(nodeColumn, ref.nodeId), eq(typeColumn, ref.type), eq(idColumn, ref.resourceId!))!
      );
      return parts.length ? or(...parts) : undefined;
    };
    const linkCondition = or(
      refCondition(containerLinks.sourceNodeId, containerLinks.sourceType, containerLinks.sourceResourceId),
      refCondition(containerLinks.targetNodeId, containerLinks.targetType, containerLinks.targetResourceId)
    );
    const linkRows = linkCondition
      ? await this.db
          .select({ id: containerLinks.id, desiredState: containerLinks.desiredState })
          .from(containerLinks)
          .where(and(linkCondition, ne(containerLinks.desiredState, 'deleted')))
      : [];
    const databaseIds = databases.map((row) => row.id);
    const dbBindingCondition = or(
      refCondition(
        managedDatabaseBindings.targetNodeId,
        managedDatabaseBindings.targetType,
        managedDatabaseBindings.targetResourceId
      ),
      databaseIds.length ? inArray(managedDatabaseBindings.managedDatabaseId, databaseIds) : undefined
    );
    const dbBindingRows = dbBindingCondition
      ? await this.db
          .select({ id: managedDatabaseBindings.id, desiredState: managedDatabaseBindings.desiredState })
          .from(managedDatabaseBindings)
          .where(and(dbBindingCondition, ne(managedDatabaseBindings.desiredState, 'deleted')))
      : [];
    const clusterIds = storages.map((row) => row.id);
    const storageBindingCondition = or(
      refCondition(
        managedStorageBindings.targetNodeId,
        managedStorageBindings.targetType,
        managedStorageBindings.targetResourceId
      ),
      clusterIds.length ? inArray(managedStorageBindings.clusterId, clusterIds) : undefined
    );
    const storageBindingRows = storageBindingCondition
      ? await this.db
          .select({ id: managedStorageBindings.id, desiredState: managedStorageBindings.desiredState })
          .from(managedStorageBindings)
          .where(and(storageBindingCondition, ne(managedStorageBindings.status, 'deleting')))
      : [];
    const secureLinkParts: SQL[] = [
      ...memberContainers.map(
        (member) =>
          and(
            eq(proxyAdditionalSecureLinks.dockerNodeId, member.nodeId!),
            eq(proxyAdditionalSecureLinks.dockerContainerName, member.id)
          )!
      ),
    ];
    if (deploymentIds.length)
      secureLinkParts.push(inArray(proxyAdditionalSecureLinks.dockerDeploymentId, deploymentIds));
    if (composeIds.length) secureLinkParts.push(inArray(proxyAdditionalSecureLinks.dockerComposeProjectId, composeIds));
    if (clusterIds.length) secureLinkParts.push(inArray(proxyAdditionalSecureLinks.managedStorageId, clusterIds));
    const secureLinkRows = secureLinkParts.length
      ? await this.db
          .select({
            id: proxyAdditionalSecureLinks.id,
            incidentSuspendedBy: proxyAdditionalSecureLinks.incidentSuspendedBy,
          })
          .from(proxyAdditionalSecureLinks)
          .where(and(or(...secureLinkParts), ne(proxyAdditionalSecureLinks.status, 'cleanup_pending')))
      : [];

    return {
      environmentId,
      members,
      routes: [...routes.values()],
      containers: [...containers.values()],
      containerLinks: linkRows,
      databaseBindings: dbBindingRows,
      storageBindings: storageBindingRows,
      secureLinks: secureLinkRows,
      databases: databases
        .filter((row) => !!row.connectionId)
        .map((row) => ({ ...row, connectionId: row.connectionId!, status: String(row.status) })),
      storages: storages
        .filter((row) => !!row.connectionId)
        .map((row) => ({ ...row, connectionId: row.connectionId!, status: String(row.status) })),
      deployments: deployments.map(({ routerName: _router, ...row }) => ({ ...row, status: String(row.status) })),
      composeProjects: composeProjects.map((row) => ({ ...row, status: String(row.status) })),
    };
  }
}
