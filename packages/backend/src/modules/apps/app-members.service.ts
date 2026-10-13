import { and, eq, inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnections,
  dockerAccessResources,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
  ingressGroupMembers,
  loggingEnvironments,
  managedDatabaseInstances,
  managedStorageClusterMembers,
  managedStorageClusters,
  objectStorageConnections,
  pageProjects,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { APP_ENV_MANAGE_SCOPE, assertAppScope, hasAppScope } from './app-access.js';
import { type AppFamily, type AppMemberType, familyOfMemberType } from './app-families.js';
import type { AppFolderService } from './app-folders.service.js';
import {
  APP_FAMILY_NODE_TYPES,
  appPlacementForEnvironment,
  assertPlacementNodesAllowed,
} from './app-placement-guard.js';
import type { AppMemberRefInput, PlaceAppMembersInput } from './apps.schemas.js';
import type { AppActor, AppsService } from './apps.service.js';

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
  /** Managed databases and storage: the instance or cluster id (incident items name it). Internal, never listed. */
  managedId?: string;
}

export type AppMemberCounts = Record<AppMemberType, number>;

export function emptyMemberCounts(): AppMemberCounts {
  return {
    container: 0,
    deployment: 0,
    compose: 0,
    database: 0,
    storage: 0,
    route: 0,
    pages: 0,
    certificate: 0,
    logging: 0,
  };
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
    case 'certificate':
      return hasScopeForResource(granted, 'ssl:cert:view', member.id);
    case 'logging':
      // logs:read lists the environment too (its logs need it in the list).
      return (
        hasScopeForResource(granted, 'logs:environments:view', member.id) ||
        hasScopeForResource(granted, 'logs:read', member.id)
      );
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
          managedId: managedDatabaseInstances.id,
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
          ...(row.managedId ? { managedId: row.managedId } : {}),
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
        members.push({
          type: 'storage',
          id: row.id,
          name: row.name,
          environmentId,
          nodeIds: [...nodeIds],
          ...(row.clusterId ? { managedId: row.clusterId } : {}),
        });
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

    // Certificates and logging environments run on no node.
    const certificateFolders = folderIds('certificates');
    if (certificateFolders.length) {
      const rows = await this.db
        .select({ id: sslCertificates.id, name: sslCertificates.name, folderId: sslCertificates.folderId })
        .from(sslCertificates)
        .where(inArray(sslCertificates.folderId, certificateFolders));
      for (const row of rows) {
        const environmentId = envOf(row.folderId);
        if (environmentId)
          members.push({ type: 'certificate', id: row.id, name: row.name, environmentId, nodeIds: [] });
      }
    }

    const loggingFolders = folderIds('logging');
    if (loggingFolders.length) {
      const rows = await this.db
        .select({ id: loggingEnvironments.id, name: loggingEnvironments.name, folderId: loggingEnvironments.folderId })
        .from(loggingEnvironments)
        .where(inArray(loggingEnvironments.folderId, loggingFolders));
      for (const row of rows) {
        const environmentId = envOf(row.folderId);
        if (environmentId) members.push({ type: 'logging', id: row.id, name: row.name, environmentId, nodeIds: [] });
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

/** One member a place request names, resolved. */
interface ResolvedMember {
  input: AppMemberRefInput;
  type: AppMemberType;
  /** Container: name; others: id. */
  id: string;
  name: string;
  nodeIds: string[];
  nodeId: string | null;
  folderId: string | null;
  /** Docker scope resource id (`<nodeId>/<id>` grants). */
  scopeResourceId: string | null;
  /** Docker placement key (container or deployment name, Compose project id). */
  resourceKey: string | null;
  refusal?: { code: string; message: string };
}

export interface PlaceResult {
  placed: Array<{
    member: AppMemberRefInput;
    type: AppMemberType;
    id: string;
    name: string;
    environmentId: string | null;
  }>;
  refused: Array<{ member: AppMemberRefInput; code: string; message: string }>;
}

/** Layout events of each family, so the normal lists refresh after a member moves in or out. */
const FAMILY_EVENTS: Readonly<Record<AppFamily, string>> = {
  containers: 'docker.folder.changed',
  compose: 'docker.folder.changed',
  routes: 'proxy.host.changed',
  databases: 'database.folder.changed',
  storage: 'storage.folder.changed',
  pages: 'pages.folder.changed',
  certificates: 'ssl.cert.folder.changed',
  logging: 'logging.environment.changed',
};

/** The permission that lets a caller change where a member lives (as for moving it between folders). */
export function canEditMember(
  scopes: readonly string[],
  member: { type: AppMemberType; id: string; nodeId: string | null; scopeResourceId: string | null }
): boolean {
  const granted = [...scopes];
  switch (member.type) {
    case 'route':
      return hasScopeForResource(granted, 'proxy:edit', member.id);
    case 'database':
      return hasScopeForResource(granted, 'databases:edit', member.id);
    case 'storage':
      return hasScopeForResource(granted, 'storage:edit', member.id);
    case 'pages':
      return hasScopeForResource(granted, 'pages:edit', member.id);
    case 'certificate':
      return hasScopeForResource(granted, 'ssl:cert:issue', member.id);
    case 'logging':
      return hasScopeForResource(granted, 'logs:environments:edit', member.id);
    case 'compose':
      return hasDockerResourceScope(granted, 'docker:compose:manage', member.nodeId ?? '', member.id);
    case 'deployment':
      return hasDockerResourceScope(granted, 'docker:containers:edit', member.nodeId ?? '', member.id);
    case 'container':
      return hasDockerResourceScope(
        granted,
        'docker:containers:edit',
        member.nodeId ?? '',
        member.scopeResourceId ?? ''
      );
  }
}

/**
 * Moves resources into, between and out of app environments. Membership is the folder of each resource (or the
 * Docker placement row), so a move sets the folder to the target environment's folder of that family, or to null
 * for "No app". Each member is checked and placed on its own; refusals are reported, not thrown.
 */
export class AppMembersService {
  private eventBus?: EventBusService;
  private afterRoutesMoved?: (routeIds: string[]) => Promise<void>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly folders: AppFolderService,
    private readonly apps: AppsService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private isolationCheck?: (environmentId: string) => Promise<boolean>;

  /**
   * Whether the kill switch isolates an environment (moves in and out are refused then, 409 APP_ISOLATED). A shut-down
   * environment takes moves both ways: Start still brings back what ran at shutdown wherever it sits now.
   */
  setIsolationCheck(check: (environmentId: string) => Promise<boolean>) {
    this.isolationCheck = check;
  }

  /** Maintenance overlay recompute for routes that changed environment (set by the maintenance module). */
  setRouteMoveHook(hook: (routeIds: string[]) => Promise<void>) {
    this.afterRoutesMoved = hook;
  }

  async place(actor: AppActor, input: PlaceAppMembersInput): Promise<PlaceResult> {
    let target: { appId: string; environmentId: string; name: string; envName: string } | null = null;
    if (input.target) {
      const { app } = await this.apps.resolveVisible(actor.scopes, input.target.appId);
      const env = await this.apps.getEnvironment(app.id, input.target.environmentId);
      assertAppScope(actor.scopes, APP_ENV_MANAGE_SCOPE, app.id, env.id);
      target = { appId: app.id, environmentId: env.id, name: app.name, envName: env.name };
      if (await this.isolationCheck?.(env.id)) {
        throw new AppError(
          409,
          'APP_ISOLATED',
          `${app.name} · ${env.name} is isolated by the app kill switch; turn it off before moving resources into it`
        );
      }
    }
    const result: PlaceResult = { placed: [], refused: [] };
    const touchedApps = new Set<string>(target ? [target.appId] : []);
    const touchedFamilies = new Set<AppFamily>();
    const movedRoutes: string[] = [];
    const resolved = await this.resolveMembers(input.members);
    const targetFolders = target
      ? (await this.folders.envFolders([target.environmentId])).get(target.environmentId)
      : null;

    for (const member of resolved) {
      const refuse = (code: string, message: string) => result.refused.push({ member: member.input, code, message });
      if (member.refusal) {
        refuse(member.refusal.code, member.refusal.message);
        continue;
      }
      const family = familyOfMemberType(member.type);
      const source = await this.folders.resolveFolder(family, member.folderId);
      if (source && !source.environmentId) {
        refuse('RESOURCE_IN_APP', 'This resource sits in an app root folder');
        continue;
      }
      if (!canEditMember(actor.scopes, member)) {
        refuse('FORBIDDEN', 'You cannot change where this resource lives');
        continue;
      }
      if (source && !hasAppScope(actor.scopes, APP_ENV_MANAGE_SCOPE, source.appId, source.environmentId)) {
        refuse('FORBIDDEN', 'Missing apps:env:manage for the environment this resource leaves');
        continue;
      }
      if (source?.environmentId && (await this.isolationCheck?.(source.environmentId))) {
        refuse('APP_ISOLATED', 'Its environment is isolated by the app kill switch; turn it off before moving it');
        continue;
      }
      const targetFolderId = target ? (targetFolders?.[family] ?? null) : null;
      if (target && !targetFolderId) {
        refuse('APP_ENVIRONMENT_NOT_FOUND', 'Environment not found');
        continue;
      }
      if ((member.folderId ?? null) === targetFolderId) {
        result.placed.push({
          member: member.input,
          type: member.type,
          id: member.id,
          name: member.name,
          environmentId: target?.environmentId ?? null,
        });
        continue;
      }
      if (target) {
        try {
          const placement = await appPlacementForEnvironment(
            this.db,
            target.environmentId,
            APP_FAMILY_NODE_TYPES[family]
          );
          // External database and storage connections run on no node; Pages without a node yet are free too.
          if (member.nodeIds.length > 0)
            assertPlacementNodesAllowed(placement, member.nodeIds, APP_FAMILY_NODE_TYPES[family]);
        } catch (error) {
          const appError = error as AppError;
          refuse(appError.code ?? 'APP_NODE_NOT_ALLOWED', appError.message);
          continue;
        }
      }
      await this.setFolder(member, family, targetFolderId);
      if (source) touchedApps.add(source.appId);
      touchedFamilies.add(family);
      if (member.type === 'route') movedRoutes.push(member.id);
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.resource.place',
        resourceType: 'app_member',
        resourceId: member.type === 'container' ? `${member.nodeId}:${member.id}` : member.id,
        details: {
          memberType: member.type,
          memberId: member.id,
          nodeId: member.nodeId,
          name: member.name,
          fromAppId: source?.appId ?? null,
          fromEnvironmentId: source?.environmentId ?? null,
          appId: target?.appId ?? null,
          environmentId: target?.environmentId ?? null,
          appName: target?.name ?? null,
          environmentName: target?.envName ?? null,
        },
      });
      result.placed.push({
        member: member.input,
        type: member.type,
        id: member.id,
        name: member.name,
        environmentId: target?.environmentId ?? null,
      });
    }

    for (const family of touchedFamilies) this.eventBus?.publish(FAMILY_EVENTS[family], { action: 'resources_moved' });
    if (touchedFamilies.size > 0) for (const appId of touchedApps) this.apps.publish(appId, 'members_changed');
    if (movedRoutes.length > 0) await this.afterRoutesMoved?.(movedRoutes);
    return result;
  }

  private async setFolder(member: ResolvedMember, family: AppFamily, folderId: string | null): Promise<void> {
    const now = new Date();
    switch (family) {
      case 'routes':
        await this.db.update(proxyHosts).set({ folderId, updatedAt: now }).where(eq(proxyHosts.id, member.id));
        return;
      case 'databases':
        await this.db
          .update(databaseConnections)
          .set({ folderId, updatedAt: now })
          .where(eq(databaseConnections.id, member.id));
        return;
      case 'storage':
        await this.db
          .update(objectStorageConnections)
          .set({ folderId, updatedAt: now })
          .where(eq(objectStorageConnections.id, member.id));
        return;
      case 'pages':
        await this.db.update(pageProjects).set({ folderId, updatedAt: now }).where(eq(pageProjects.id, member.id));
        return;
      case 'certificates':
        await this.db
          .update(sslCertificates)
          .set({ folderId, updatedAt: now })
          .where(eq(sslCertificates.id, member.id));
        return;
      case 'logging':
        await this.db
          .update(loggingEnvironments)
          .set({ folderId, updatedAt: now })
          .where(eq(loggingEnvironments.id, member.id));
        return;
      case 'containers':
      case 'compose': {
        const resourceType = family === 'compose' ? 'compose' : 'container';
        await this.db
          .insert(dockerContainerFolderAssignments)
          .values({
            nodeId: member.nodeId!,
            resourceType,
            resourceKey: member.resourceKey!,
            containerName: resourceType === 'container' ? member.resourceKey! : null,
            folderId,
            sortOrder: 0,
          })
          .onConflictDoUpdate({
            target: [
              dockerContainerFolderAssignments.nodeId,
              dockerContainerFolderAssignments.resourceType,
              dockerContainerFolderAssignments.resourceKey,
            ],
            set: { folderId, updatedAt: now },
          });
        return;
      }
    }
  }

  /** Resolve what each requested member is, where it sits and which nodes it runs on. */
  private async resolveMembers(inputs: readonly AppMemberRefInput[]): Promise<ResolvedMember[]> {
    const out: ResolvedMember[] = [];
    for (const input of inputs) {
      const base = {
        input,
        type: input.type,
        id: input.id ?? input.resourceKey ?? '',
        name: '',
        nodeIds: [] as string[],
        nodeId: input.nodeId ?? null,
        folderId: null as string | null,
        scopeResourceId: null as string | null,
        resourceKey: null as string | null,
      };
      const notFound = (message = 'Resource not found') =>
        out.push({ ...base, refusal: { code: 'NOT_FOUND', message } });
      if (!base.id) {
        notFound('id is required');
        continue;
      }
      switch (input.type) {
        case 'route': {
          if (!UUID_RE.test(base.id)) {
            notFound();
            break;
          }
          const [row] = await this.db
            .select({
              id: proxyHosts.id,
              folderId: proxyHosts.folderId,
              nodeId: proxyHosts.nodeId,
              ingressGroupId: proxyHosts.ingressGroupId,
              domainNames: proxyHosts.domainNames,
              isSystem: proxyHosts.isSystem,
            })
            .from(proxyHosts)
            .where(eq(proxyHosts.id, base.id))
            .limit(1);
          if (!row) {
            notFound();
            break;
          }
          const nodeIds = row.ingressGroupId
            ? (
                await this.db
                  .select({ nodeId: ingressGroupMembers.nodeId })
                  .from(ingressGroupMembers)
                  .where(eq(ingressGroupMembers.groupId, row.ingressGroupId))
              ).map((member) => member.nodeId)
            : row.nodeId
              ? [row.nodeId]
              : [];
          const resolved: ResolvedMember = {
            ...base,
            name: Array.isArray(row.domainNames) ? row.domainNames.join(', ') : row.id,
            folderId: row.folderId,
            nodeIds,
          };
          if (row.isSystem) {
            resolved.refusal = { code: 'ROUTE_NOT_PLACEABLE', message: 'System routes cannot join an app' };
          } else if (
            container.isRegistered(ProxyService) &&
            (await container.resolve(ProxyService).servesOpfieldPublicUrl({ domainNames: row.domainNames ?? [] }))
          ) {
            resolved.refusal = {
              code: 'ROUTE_NOT_PLACEABLE',
              message: 'The route serving the Opfield public URL cannot join an app',
            };
          }
          out.push(resolved);
          break;
        }
        case 'database':
        case 'storage':
        case 'pages': {
          if (!UUID_RE.test(base.id)) {
            notFound();
            break;
          }
          const row =
            input.type === 'database'
              ? (
                  await this.db
                    .select({
                      name: databaseConnections.name,
                      folderId: databaseConnections.folderId,
                      nodeId: managedDatabaseInstances.nodeId,
                    })
                    .from(databaseConnections)
                    .leftJoin(
                      managedDatabaseInstances,
                      eq(managedDatabaseInstances.databaseConnectionId, databaseConnections.id)
                    )
                    .where(eq(databaseConnections.id, base.id))
                    .limit(1)
                )[0]
              : input.type === 'storage'
                ? (
                    await this.db
                      .select({
                        name: objectStorageConnections.name,
                        folderId: objectStorageConnections.folderId,
                        nodeId: managedStorageClusters.nodeId,
                      })
                      .from(objectStorageConnections)
                      .leftJoin(
                        managedStorageClusters,
                        eq(managedStorageClusters.objectStorageConnectionId, objectStorageConnections.id)
                      )
                      .where(eq(objectStorageConnections.id, base.id))
                      .limit(1)
                  )[0]
                : (
                    await this.db
                      .select({ name: pageProjects.name, folderId: pageProjects.folderId, nodeId: pageProjects.nodeId })
                      .from(pageProjects)
                      .where(eq(pageProjects.id, base.id))
                      .limit(1)
                  )[0];
          if (!row) {
            notFound();
            break;
          }
          out.push({ ...base, name: row.name, folderId: row.folderId, nodeIds: row.nodeId ? [row.nodeId] : [] });
          break;
        }
        case 'certificate': {
          if (!UUID_RE.test(base.id)) {
            notFound();
            break;
          }
          const [row] = await this.db
            .select({
              name: sslCertificates.name,
              folderId: sslCertificates.folderId,
              isSystem: sslCertificates.isSystem,
            })
            .from(sslCertificates)
            .where(eq(sslCertificates.id, base.id))
            .limit(1);
          if (!row) {
            notFound();
            break;
          }
          out.push({
            ...base,
            name: row.name,
            folderId: row.folderId,
            ...(row.isSystem
              ? {
                  refusal: {
                    code: 'CERTIFICATE_NOT_PLACEABLE',
                    message: 'System certificates (the Opfield management certificate) cannot join an app',
                  },
                }
              : {}),
          });
          break;
        }
        case 'logging': {
          if (!UUID_RE.test(base.id)) {
            notFound();
            break;
          }
          const [row] = await this.db
            .select({ name: loggingEnvironments.name, folderId: loggingEnvironments.folderId })
            .from(loggingEnvironments)
            .where(eq(loggingEnvironments.id, base.id))
            .limit(1);
          if (!row) {
            notFound();
            break;
          }
          out.push({ ...base, name: row.name, folderId: row.folderId });
          break;
        }
        case 'compose': {
          if (!UUID_RE.test(base.id)) {
            notFound();
            break;
          }
          const [project] = await this.db
            .select({
              id: dockerComposeProjects.id,
              nodeId: dockerComposeProjects.nodeId,
              name: dockerComposeProjects.name,
            })
            .from(dockerComposeProjects)
            .where(eq(dockerComposeProjects.id, base.id))
            .limit(1);
          if (!project) {
            notFound();
            break;
          }
          out.push({
            ...base,
            name: project.name,
            nodeId: project.nodeId,
            nodeIds: [project.nodeId],
            folderId: await this.dockerFolder('compose', project.nodeId, project.id),
            scopeResourceId: project.id,
            resourceKey: project.id,
          });
          break;
        }
        case 'deployment': {
          if (!UUID_RE.test(base.id)) {
            notFound();
            break;
          }
          const [deployment] = await this.db
            .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId, name: dockerDeployments.name })
            .from(dockerDeployments)
            .where(eq(dockerDeployments.id, base.id))
            .limit(1);
          if (!deployment) {
            notFound();
            break;
          }
          out.push({
            ...base,
            name: deployment.name,
            nodeId: deployment.nodeId,
            nodeIds: [deployment.nodeId],
            folderId: await this.dockerFolder('container', deployment.nodeId, deployment.name),
            scopeResourceId: deployment.id,
            resourceKey: deployment.name,
          });
          break;
        }
        case 'container': {
          if (!base.nodeId) {
            notFound('nodeId is required for a container');
            break;
          }
          const [access] = await this.db
            .select({ id: dockerAccessResources.id })
            .from(dockerAccessResources)
            .where(
              and(
                eq(dockerAccessResources.nodeId, base.nodeId),
                eq(dockerAccessResources.resourceType, 'container'),
                eq(dockerAccessResources.resourceKey, base.id)
              )
            )
            .limit(1);
          if (!access) {
            notFound('Container not found on this node');
            break;
          }
          const [deployment] = await this.db
            .select({ id: dockerDeployments.id })
            .from(dockerDeployments)
            .where(and(eq(dockerDeployments.nodeId, base.nodeId), eq(dockerDeployments.name, base.id)))
            .limit(1);
          const folderRow = await this.dockerPlacement('container', base.nodeId, base.id);
          const resolved: ResolvedMember = {
            ...base,
            name: base.id,
            nodeIds: [base.nodeId],
            folderId: folderRow?.folderId ?? null,
            scopeResourceId: access.id,
            resourceKey: base.id,
          };
          if (deployment) {
            resolved.refusal = {
              code: 'USE_DEPLOYMENT',
              message: 'This container belongs to a deployment: move the deployment',
            };
          } else if (folderRow?.isSystem) {
            resolved.refusal = {
              code: 'COMPOSE_SERVICE',
              message: 'This container is a Compose service: move its Compose project',
            };
          }
          out.push(resolved);
          break;
        }
      }
    }
    return out;
  }

  private async dockerFolder(resourceType: 'container' | 'compose', nodeId: string, key: string) {
    return (await this.dockerPlacement(resourceType, nodeId, key))?.folderId ?? null;
  }

  private async dockerPlacement(resourceType: 'container' | 'compose', nodeId: string, key: string) {
    const [row] = await this.db
      .select({ folderId: dockerContainerFolderAssignments.folderId, isSystem: dockerContainerFolders.isSystem })
      .from(dockerContainerFolderAssignments)
      .leftJoin(dockerContainerFolders, eq(dockerContainerFolders.id, dockerContainerFolderAssignments.folderId))
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, resourceType),
          eq(dockerContainerFolderAssignments.resourceKey, key)
        )
      )
      .limit(1);
    return row ? { folderId: row.folderId ?? null, isSystem: row.isSystem ?? false } : null;
  }
}
