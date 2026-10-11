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
import { type AppIncidentsRepo, FROZEN_INCIDENT_STATES } from './app-incidents.repo.js';

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
 * The app kill switch freeze and the shutdown hold on app members (REST, MCP and AI share the services that call it;
 * the incident's own apply and restore never go through these checks).
 *
 * Isolated environment (kill switch on, incident applying or active) → 409 APP_ISOLATED for every change of a member:
 * recreate, update, env changes, rename, network attach/detach, deploy/switch/rollback, Compose apply/start/down,
 * migration, Availability changes, link/binding create and delete, binding moves, route create/edit/delete (and Secure
 * Links on it), Pages deploy/activation/settings, database and storage settings, publication changes, deleting the
 * member itself, removing a Docker network a member is to be reconnected to, placing new resources in the environment,
 * and membership and allowlist changes. The freeze ends when release starts (the restore itself reconnects and
 * reapplies). Still allowed: reads, logs, console, files, data browsing/queries, stop, kill, restart, start (except
 * a host-network container the kill switch stopped, see assertMayStart), pause/unpause, credential and certificate
 * rotation, and app variables and container secrets (stored until the next recreate, which is frozen).
 *
 * Shut-down environment (incident applying or active) → 409 APP_INCIDENT_ACTIVE only for changes that would make Start
 * restore something else or leave a member unbound: deleting a member (container, deployment, Compose project or its
 * containers via down/delete volumes, database, storage, route, Pages project, connection), deleting or moving links
 * and bindings, renaming or migrating a workload, enabling or disabling Availability, moving a key-value store to
 * Valkey, and membership changes. Everything else stays allowed while shut down (config edits are picked up by Start).
 *
 * Reads go to the database (never the 10 s membership caches); a 2 s "which incidents are open" flag keeps mutations
 * outside incidents free.
 */
export class AppMemberFreeze {
  private openKinds: { at: number; isolation: boolean; any: boolean } | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly incidents: AppIncidentsRepo
  ) {}

  /** Drop the cached flag (an incident opened or closed in this process). */
  invalidate(): void {
    this.openKinds = null;
  }

  private async openIncidentKinds(): Promise<{ isolation: boolean; any: boolean }> {
    if (this.openKinds && Date.now() - this.openKinds.at < ANY_OPEN_TTL_MS) return this.openKinds;
    const rows = await this.db
      .select({ kind: appIncidents.kind })
      .from(appIncidents)
      .where(inArray(appIncidents.state, [...FROZEN_INCIDENT_STATES]))
      .groupBy(appIncidents.kind);
    this.openKinds = {
      at: Date.now(),
      isolation: rows.some((row) => row.kind === 'isolation'),
      any: rows.length > 0,
    };
    return this.openKinds;
  }

  async anyIsolationOpen(): Promise<boolean> {
    return (await this.openIncidentKinds()).isolation;
  }

  /** Whether any kill switch or shutdown is applying or active (fast path of assertNoOpenIncident). */
  async anyIncidentOpen(): Promise<boolean> {
    return (await this.openIncidentKinds()).any;
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
          ? ((await this.incidents.openItemFor('route_overlay', `route:${target.id}`, FROZEN_INCIDENT_STATES)) ??
            (await this.incidents.openItemFor('route_withdraw', `route:${target.id}`, FROZEN_INCIDENT_STATES)))
          : await this.incidents.openItemFor(
              'container_network',
              `container:${target.nodeId}:${target.name}`,
              FROZEN_INCIDENT_STATES
            );
      if (held) {
        const incident = await this.incidents.get(held.incidentId);
        if (incident?.kind === 'isolation') return this.describe(incident.environmentId, incident.id);
      }
    }
    const environmentId = await this.environmentOf(target);
    if (!environmentId) return null;
    const incident = await this.incidents.openFor(environmentId, 'isolation', FROZEN_INCIDENT_STATES);
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
   * Refuse a change that must not run while the resource's environment has an open incident: isolated → 409
   * APP_ISOLATED (the freeze above), shut down → 409 APP_INCIDENT_ACTIVE. Used by deletes, unbinds, renames, migrations
   * and other changes the incident's restore does not expect (see the class comment).
   */
  async assertNoOpenIncident(target: FreezeTarget): Promise<void> {
    if (!(await this.anyIncidentOpen())) return;
    await this.assertNotFrozen(target);
    const environmentId = await this.environmentOf(target);
    if (!environmentId) return;
    const incident = await this.incidents.openFor(environmentId, 'shutdown', FROZEN_INCIDENT_STATES);
    if (!incident) return;
    const shutDown = await this.describe(environmentId, incident.id);
    throw new AppError(
      409,
      'APP_INCIDENT_ACTIVE',
      `${shutDown ? `${shutDown.appName} · ${shutDown.environmentName}` : 'Its app environment'} is shut down; start it before changing this resource`,
      shutDown ? { appId: shutDown.appId, environmentId } : undefined
    );
  }

  /**
   * Refuse removing a Docker network that a container isolated by the kill switch is to be reconnected to on release
   * (409 APP_ISOLATED): the restore needs it.
   */
  async assertNetworkNotHeld(nodeId: string, network: { id: string; name: string }): Promise<void> {
    if (!(await this.anyIsolationOpen())) return;
    const items = await this.incidents.openItemsWithKeyPrefix(
      'container_network',
      `container:${nodeId}:`,
      FROZEN_INCIDENT_STATES
    );
    for (const item of items) {
      const endpoints = (item.priorState as { endpoints?: Array<{ networkId?: string; networkName?: string }> } | null)
        ?.endpoints;
      if (!endpoints?.some((endpoint) => endpoint.networkId === network.id || endpoint.networkName === network.name)) {
        continue;
      }
      const incident = await this.incidents.get(item.incidentId);
      const frozen = incident ? await this.describe(incident.environmentId, incident.id) : null;
      throw new AppError(
        409,
        'APP_ISOLATED',
        `${frozen ? `${frozen.appName} · ${frozen.environmentName}` : 'An app environment'} is isolated by the app kill switch and reconnects its containers to ${network.name} when it is turned off; turn it off before removing this network`,
        frozen ? { appId: frozen.appId, environmentId: frozen.environmentId } : undefined
      );
    }
  }

  /**
   * Start stays allowed for frozen members (an isolated container has no network), except a host-network container
   * the kill switch stopped: starting it would bring it back on the host network.
   */
  async assertMayStart(nodeId: string, name: string): Promise<void> {
    if (!(await this.anyIsolationOpen())) return;
    const held = await this.incidents.openItemFor(
      'container_network',
      `container:${nodeId}:${name}`,
      FROZEN_INCIDENT_STATES
    );
    if (!held || !(held.priorState as { hostNetwork?: boolean } | null)?.hostNetwork) return;
    throw new AppError(
      409,
      'APP_ISOLATED',
      'The app kill switch stopped this host-network container; it starts again when the kill switch is turned off'
    );
  }
}
