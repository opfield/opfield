import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  appEnvironments,
  appIncidents,
  apps,
  databaseConnectionFolders,
  databaseConnections,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
  managedDatabaseInstances,
  managedStorageClusters,
  objectStorageConnections,
  objectStorageFolders,
  pageProjectFolders,
  pageProjects,
  proxyHostFolders,
  proxyHosts,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { type AppIncidentsRepo, OPEN_INCIDENT_STATES } from './app-incidents.repo.js';

/** A resource a mutation is about to change. Containers are named by node and name (or id, resolved by the caller). */
export type FreezeTarget =
  | { kind: 'container'; nodeId: string; name: string }
  | { kind: 'deployment'; id: string }
  | { kind: 'compose'; id: string }
  | { kind: 'database'; connectionId: string }
  | { kind: 'managedDatabase'; id: string }
  | { kind: 'storage'; connectionId: string }
  | { kind: 'managedStorage'; id: string }
  | { kind: 'pages'; id: string }
  | { kind: 'route'; id: string }
  | { kind: 'environment'; id: string };

export interface FrozenEnvironment {
  appId: string;
  appName: string;
  environmentId: string;
  environmentName: string;
  incidentId: string;
}

const ANY_OPEN_TTL_MS = 2_000;

/**
 * Members of an isolated environment are frozen: recreate, update, env changes, network attach, deploy, Compose apply,
 * migration, link/binding create, route edits, membership and allowlist changes are refused with 409 APP_ISOLATED until
 * the kill switch is turned off. Stop, start, restart, logs, console and delete stay allowed. Reads go to the database
 * (never the 10 s membership caches); a 2 s "any isolation open" flag keeps mutations outside incidents free.
 */
export class AppMemberFreeze {
  private anyOpen: { at: number; value: boolean } | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly incidents: AppIncidentsRepo
  ) {}

  /** Drop the cached flag (an incident opened or closed in this process). */
  invalidate(): void {
    this.anyOpen = null;
  }

  async anyIsolationOpen(): Promise<boolean> {
    if (this.anyOpen && Date.now() - this.anyOpen.at < ANY_OPEN_TTL_MS) return this.anyOpen.value;
    const [row] = await this.db
      .select({ id: appIncidents.id })
      .from(appIncidents)
      .where(and(eq(appIncidents.kind, 'isolation'), inArray(appIncidents.state, [...OPEN_INCIDENT_STATES])))
      .limit(1);
    this.anyOpen = { at: Date.now(), value: !!row };
    return !!row;
  }

  /** The environment a resource belongs to (from where it sits), or null outside apps. */
  async environmentOf(target: FreezeTarget): Promise<string | null> {
    switch (target.kind) {
      case 'environment':
        return target.id;
      case 'container':
        return this.dockerEnvironment('container', target.nodeId, target.name);
      case 'deployment': {
        const [row] = await this.db
          .select({ nodeId: dockerDeployments.nodeId, name: dockerDeployments.name })
          .from(dockerDeployments)
          .where(eq(dockerDeployments.id, target.id))
          .limit(1);
        return row ? this.dockerEnvironment('container', row.nodeId, row.name) : null;
      }
      case 'compose': {
        const [row] = await this.db
          .select({ nodeId: dockerComposeProjects.nodeId })
          .from(dockerComposeProjects)
          .where(eq(dockerComposeProjects.id, target.id))
          .limit(1);
        return row ? this.dockerEnvironment('compose', row.nodeId, target.id) : null;
      }
      case 'database':
        return this.folderEnvironment(
          databaseConnections,
          databaseConnectionFolders,
          eq(databaseConnections.id, target.connectionId)
        );
      case 'managedDatabase': {
        const [row] = await this.db
          .select({ connectionId: managedDatabaseInstances.databaseConnectionId })
          .from(managedDatabaseInstances)
          .where(eq(managedDatabaseInstances.id, target.id))
          .limit(1);
        return row?.connectionId ? this.environmentOf({ kind: 'database', connectionId: row.connectionId }) : null;
      }
      case 'storage':
        return this.folderEnvironment(
          objectStorageConnections,
          objectStorageFolders,
          eq(objectStorageConnections.id, target.connectionId)
        );
      case 'managedStorage': {
        const [row] = await this.db
          .select({ connectionId: managedStorageClusters.objectStorageConnectionId })
          .from(managedStorageClusters)
          .where(eq(managedStorageClusters.id, target.id))
          .limit(1);
        return row?.connectionId ? this.environmentOf({ kind: 'storage', connectionId: row.connectionId }) : null;
      }
      case 'pages':
        return this.folderEnvironment(pageProjects, pageProjectFolders, eq(pageProjects.id, target.id));
      case 'route':
        return this.folderEnvironment(proxyHosts, proxyHostFolders, eq(proxyHosts.id, target.id));
    }
  }

  private async dockerEnvironment(
    resourceType: 'container' | 'compose',
    nodeId: string,
    resourceKey: string
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ environmentId: dockerContainerFolders.appEnvironmentId })
      .from(dockerContainerFolderAssignments)
      .innerJoin(dockerContainerFolders, eq(dockerContainerFolders.id, dockerContainerFolderAssignments.folderId))
      .where(
        and(
          eq(dockerContainerFolderAssignments.resourceType, resourceType),
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceKey, resourceKey)
        )
      )
      .limit(1);
    return row?.environmentId ?? null;
  }

  private async folderEnvironment(table: any, folderTable: any, where: any): Promise<string | null> {
    const [row] = await this.db
      .select({ environmentId: folderTable.appEnvironmentId })
      .from(table)
      .innerJoin(folderTable, eq(folderTable.id, table.folderId))
      .where(where)
      .limit(1);
    return (row?.environmentId as string | null | undefined) ?? null;
  }

  /** The isolated environment holding this resource, or null (outside apps, or its environment is not isolated). */
  async frozenEnvironment(target: FreezeTarget): Promise<FrozenEnvironment | null> {
    if (!(await this.anyIsolationOpen())) return null;
    if (target.kind === 'route' || target.kind === 'container') {
      // Routes outside the app whose upstream is a member, and host-network containers the kill switch stopped, are
      // held by the incident itself.
      const held =
        target.kind === 'route'
          ? ((await this.incidents.openItemFor('route_overlay', `route:${target.id}`)) ??
            (await this.incidents.openItemFor('route_withdraw', `route:${target.id}`)))
          : await this.incidents.openItemFor('container_network', `container:${target.nodeId}:${target.name}`);
      if (held) {
        const incident = await this.incidents.get(held.incidentId);
        if (incident?.kind === 'isolation') return this.describe(incident.environmentId, incident.id);
      }
    }
    const environmentId = await this.environmentOf(target);
    if (!environmentId) return null;
    const incident = await this.incidents.openFor(environmentId, 'isolation');
    return incident ? this.describe(environmentId, incident.id) : null;
  }

  private async describe(environmentId: string, incidentId: string): Promise<FrozenEnvironment | null> {
    const [row] = await this.db
      .select({
        appId: apps.id,
        appName: apps.name,
        environmentName: appEnvironments.name,
      })
      .from(appEnvironments)
      .innerJoin(apps, eq(apps.id, appEnvironments.appId))
      .where(eq(appEnvironments.id, environmentId))
      .limit(1);
    return row ? { ...row, environmentId, incidentId } : null;
  }

  /** Refuse a mutation of a frozen resource with 409 APP_ISOLATED. */
  async assertNotFrozen(target: FreezeTarget): Promise<void> {
    const frozen = await this.frozenEnvironment(target);
    if (!frozen) return;
    throw new AppError(
      409,
      'APP_ISOLATED',
      `${frozen.appName} · ${frozen.environmentName} is isolated by the app kill switch; turn it off before changing its resources`,
      { appId: frozen.appId, environmentId: frozen.environmentId }
    );
  }

  /**
   * Start stays allowed for frozen members (an isolated container has no network), except a host-network container
   * the kill switch stopped: starting it would bring it back on the host network.
   */
  async assertMayStart(nodeId: string, name: string): Promise<void> {
    if (!(await this.anyIsolationOpen())) return;
    const held = await this.incidents.openItemFor('container_network', `container:${nodeId}:${name}`);
    if (!held || !(held.priorState as { hostNetwork?: boolean } | null)?.hostNetwork) return;
    throw new AppError(
      409,
      'APP_ISOLATED',
      'The app kill switch stopped this host-network container; it starts again when the kill switch is turned off'
    );
  }
}
