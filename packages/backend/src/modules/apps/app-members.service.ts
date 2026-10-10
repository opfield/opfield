import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnections,
  dockerAccessResources,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerDeployments,
  ingressGroupMembers,
  managedDatabaseInstances,
  managedStorageClusterMembers,
  managedStorageClusters,
  objectStorageConnections,
  pageProjects,
  proxyHosts,
} from '@/db/schema/index.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import type { AppFamily, AppMemberType } from './app-families.js';
import type { AppFolderService } from './app-folders.service.js';

/** One member of an app environment as the API lists it. */
export interface AppMember {
  type: AppMemberType;
  /** Container: its name; every other type: its id. */
  id: string;
  name: string;
  environmentId: string;
  nodeIds: string[];
  /** Docker members live on one node. */
  nodeId?: string;
  /** Docker scope resource id (`<nodeId>/<id>` grants); containers: the access resource id. */
  scopeResourceId?: string;
}

export type AppMemberCounts = Record<AppMemberType, number>;

export function emptyMemberCounts(): AppMemberCounts {
  return { container: 0, deployment: 0, compose: 0, database: 0, storage: 0, route: 0, pages: 0 };
}

/** View check of one member with the caller's effective (folder-expanded) scopes. */
export function canViewMember(scopes: readonly string[], member: AppMember): boolean {
  const granted = [...scopes];
  switch (member.type) {
    case 'route':
      return hasScopeForResource(granted, 'proxy:view', member.id);
    case 'database':
      return hasScopeForResource(granted, 'databases:view', member.id);
    case 'storage':
      return hasScopeForResource(granted, 'storage:view', member.id);
    case 'pages':
      return hasScopeForResource(granted, 'pages:view', member.id);
    case 'compose':
      return hasDockerResourceScope(granted, 'docker:compose:view', member.nodeId!, member.id);
    case 'deployment':
      return hasDockerResourceScope(granted, 'docker:containers:view', member.nodeId!, member.id);
    case 'container':
      return hasDockerResourceScope(granted, 'docker:containers:view', member.nodeId!, member.scopeResourceId ?? '');
  }
}

/**
 * Lists what sits in the hidden folders of app environments. Membership is the folder each resource is in, so
 * this reads the resource tables and Docker placements by those folder ids.
 */
export class AppMembersReader {
  constructor(
    private readonly db: DrizzleClient,
    private readonly folders: AppFolderService
  ) {}

  /** Every member of the environments (no visibility filter; callers filter with canViewMember). */
  async listMembers(environmentIds: readonly string[]): Promise<AppMember[]> {
    if (environmentIds.length === 0) return [];
    const folderMap = await this.folders.envFolders(environmentIds);
    const envByFolder = new Map<string, { family: AppFamily; environmentId: string }>();
    for (const [environmentId, families] of folderMap) {
      for (const [family, folderId] of Object.entries(families) as Array<[AppFamily, string | null]>) {
        if (folderId) envByFolder.set(folderId, { family, environmentId });
      }
    }
    const folderIds = (family: AppFamily) =>
      [...envByFolder].filter(([, entry]) => entry.family === family).map(([folderId]) => folderId);
    const envOf = (folderId: string | null) => (folderId ? envByFolder.get(folderId)?.environmentId : undefined);
    const members: AppMember[] = [];

    const routeFolders = folderIds('routes');
    if (routeFolders.length) {
      const rows = await this.db
        .select({
          id: proxyHosts.id,
          folderId: proxyHosts.folderId,
          nodeId: proxyHosts.nodeId,
          ingressGroupId: proxyHosts.ingressGroupId,
          domainNames: proxyHosts.domainNames,
        })
        .from(proxyHosts)
        .where(inArray(proxyHosts.folderId, routeFolders));
      const groupIds = [...new Set(rows.map((row) => row.ingressGroupId).filter((id): id is string => !!id))];
      const groupMembers = groupIds.length
        ? await this.db
            .select({ groupId: ingressGroupMembers.groupId, nodeId: ingressGroupMembers.nodeId })
            .from(ingressGroupMembers)
            .where(inArray(ingressGroupMembers.groupId, groupIds))
        : [];
      for (const row of rows) {
        const environmentId = envOf(row.folderId);
        if (!environmentId) continue;
        const nodeIds = row.ingressGroupId
          ? groupMembers.filter((member) => member.groupId === row.ingressGroupId).map((member) => member.nodeId)
          : row.nodeId
            ? [row.nodeId]
            : [];
        members.push({
          type: 'route',
          id: row.id,
          name: Array.isArray(row.domainNames) && row.domainNames.length ? row.domainNames.join(', ') : row.id,
          environmentId,
          nodeIds,
        });
      }
    }

    const databaseFolders = folderIds('databases');
    if (databaseFolders.length) {
      const rows = await this.db
        .select({
          id: databaseConnections.id,
          name: databaseConnections.name,
          folderId: databaseConnections.folderId,
          nodeId: managedDatabaseInstances.nodeId,
        })
        .from(databaseConnections)
        .leftJoin(managedDatabaseInstances, eq(managedDatabaseInstances.databaseConnectionId, databaseConnections.id))
        .where(inArray(databaseConnections.folderId, databaseFolders));
      for (const row of rows) {
        const environmentId = envOf(row.folderId);
        if (!environmentId) continue;
        members.push({
          type: 'database',
          id: row.id,
          name: row.name,
          environmentId,
          nodeIds: row.nodeId ? [row.nodeId] : [],
        });
      }
    }

    const storageFolders = folderIds('storage');
    if (storageFolders.length) {
      const rows = await this.db
        .select({
          id: objectStorageConnections.id,
          name: objectStorageConnections.name,
          folderId: objectStorageConnections.folderId,
          clusterId: managedStorageClusters.id,
          nodeId: managedStorageClusters.nodeId,
        })
        .from(objectStorageConnections)
        .leftJoin(
          managedStorageClusters,
          eq(managedStorageClusters.objectStorageConnectionId, objectStorageConnections.id)
        )
        .where(inArray(objectStorageConnections.folderId, storageFolders));
      const clusterIds = rows.map((row) => row.clusterId).filter((id): id is string => !!id);
      const clusterMembers = clusterIds.length
        ? await this.db
            .select({ clusterId: managedStorageClusterMembers.clusterId, nodeId: managedStorageClusterMembers.nodeId })
            .from(managedStorageClusterMembers)
            .where(inArray(managedStorageClusterMembers.clusterId, clusterIds))
        : [];
      for (const row of rows) {
        const environmentId = envOf(row.folderId);
        if (!environmentId) continue;
        const nodeIds = new Set<string>(row.nodeId ? [row.nodeId] : []);
        for (const member of clusterMembers) if (member.clusterId === row.clusterId) nodeIds.add(member.nodeId);
        members.push({ type: 'storage', id: row.id, name: row.name, environmentId, nodeIds: [...nodeIds] });
      }
    }

    const pageFolders = folderIds('pages');
    if (pageFolders.length) {
      const rows = await this.db
        .select({
          id: pageProjects.id,
          name: pageProjects.name,
          folderId: pageProjects.folderId,
          nodeId: pageProjects.nodeId,
        })
        .from(pageProjects)
        .where(inArray(pageProjects.folderId, pageFolders));
      for (const row of rows) {
        const environmentId = envOf(row.folderId);
        if (!environmentId) continue;
        members.push({
          type: 'pages',
          id: row.id,
          name: row.name,
          environmentId,
          nodeIds: row.nodeId ? [row.nodeId] : [],
        });
      }
    }

    const composeFolders = folderIds('compose');
    if (composeFolders.length) {
      const assignments = await this.db
        .select({
          nodeId: dockerContainerFolderAssignments.nodeId,
          resourceKey: dockerContainerFolderAssignments.resourceKey,
          folderId: dockerContainerFolderAssignments.folderId,
        })
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.resourceType, 'compose'),
            inArray(dockerContainerFolderAssignments.folderId, composeFolders)
          )
        );
      const projectIds = assignments.map((row) => row.resourceKey).filter((id) => UUID_RE.test(id));
      const projects = projectIds.length
        ? await this.db
            .select({
              id: dockerComposeProjects.id,
              name: dockerComposeProjects.name,
              nodeId: dockerComposeProjects.nodeId,
            })
            .from(dockerComposeProjects)
            .where(inArray(dockerComposeProjects.id, projectIds))
        : [];
      const projectById = new Map(projects.map((project) => [project.id, project]));
      for (const row of assignments) {
        const environmentId = envOf(row.folderId);
        const project = projectById.get(row.resourceKey);
        if (!environmentId || !project) continue;
        members.push({
          type: 'compose',
          id: project.id,
          name: project.name,
          environmentId,
          nodeIds: [project.nodeId],
          nodeId: project.nodeId,
          scopeResourceId: project.id,
        });
      }
    }

    const containerFolders = folderIds('containers');
    if (containerFolders.length) {
      const assignments = await this.db
        .select({
          nodeId: dockerContainerFolderAssignments.nodeId,
          resourceKey: dockerContainerFolderAssignments.resourceKey,
          folderId: dockerContainerFolderAssignments.folderId,
        })
        .from(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.resourceType, 'container'),
            inArray(dockerContainerFolderAssignments.folderId, containerFolders)
          )
        );
      const nodeIds = [...new Set(assignments.map((row) => row.nodeId))];
      const deployments = nodeIds.length
        ? await this.db
            .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId, name: dockerDeployments.name })
            .from(dockerDeployments)
            .where(inArray(dockerDeployments.nodeId, nodeIds))
        : [];
      const deploymentByRef = new Map(deployments.map((row) => [`${row.nodeId}\u0000${row.name}`, row]));
      const accessResources = nodeIds.length
        ? await this.db
            .select({
              id: dockerAccessResources.id,
              nodeId: dockerAccessResources.nodeId,
              name: dockerAccessResources.resourceKey,
            })
            .from(dockerAccessResources)
            .where(
              and(eq(dockerAccessResources.resourceType, 'container'), inArray(dockerAccessResources.nodeId, nodeIds))
            )
        : [];
      const accessByRef = new Map(accessResources.map((row) => [`${row.nodeId}\u0000${row.name}`, row.id]));
      for (const row of assignments) {
        const environmentId = envOf(row.folderId);
        if (!environmentId) continue;
        const ref = `${row.nodeId}\u0000${row.resourceKey}`;
        const deployment = deploymentByRef.get(ref);
        if (deployment) {
          members.push({
            type: 'deployment',
            id: deployment.id,
            name: deployment.name,
            environmentId,
            nodeIds: [row.nodeId],
            nodeId: row.nodeId,
            scopeResourceId: deployment.id,
          });
        } else {
          members.push({
            type: 'container',
            id: row.resourceKey,
            name: row.resourceKey,
            environmentId,
            nodeIds: [row.nodeId],
            nodeId: row.nodeId,
            scopeResourceId: accessByRef.get(ref),
          });
        }
      }
    }
    return members;
  }

  /** Members the caller may view. */
  async listVisibleMembers(scopes: readonly string[], environmentIds: readonly string[]): Promise<AppMember[]> {
    return (await this.listMembers(environmentIds)).filter((member) => canViewMember(scopes, member));
  }

  /** Visible member counts per environment and type. */
  async countVisibleMembers(
    scopes: readonly string[],
    environmentIds: readonly string[]
  ): Promise<Map<string, AppMemberCounts>> {
    const counts = new Map(environmentIds.map((id) => [id, emptyMemberCounts()]));
    for (const member of await this.listVisibleMembers(scopes, environmentIds)) {
      const entry = counts.get(member.environmentId);
      if (entry) entry[member.type] += 1;
    }
    return counts;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
