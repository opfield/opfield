import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AppIncidentItem,
  containerLinks,
  dockerComposeOperations,
  dockerComposeProjects,
  dockerDeployments,
  dockerMigrations,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  managedStorageClusters,
  proxyHosts,
} from '@/db/schema/index.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { ContainerLinksService } from '@/modules/docker/container-links/container-links.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import { ManagedStorageBindingsService } from '@/modules/storage/managed-storage-bindings.service.js';
import { AppIncidentConsumerEnv, envKeys } from './app-incident-consumer-env.js';
import type { AppIncidentItemKind } from './app-incidents.repo.js';
import type { AppMaintenanceService } from './app-maintenance.service.js';
import type { AppNetworkIsolation, IsolatedEndpoint, NetworkRestoreResult } from './app-network-isolation.js';

export interface IncidentActionContext {
  incidentId: string;
  userId: string | null;
}

/**
 * What applying or restoring an item did: applied (with the prior state to keep), restored, or the resource is gone.
 * `detail` notes what a restore could not put back as it was (a network that is gone, for one).
 */
export type IncidentActionOutcome =
  | { status: 'applied'; priorState: Record<string, unknown> }
  | { status: 'restored'; detail?: string }
  | { status: 'gone'; detail?: string };

export interface AppIncidentActions {
  apply(item: AppIncidentItem, context: IncidentActionContext): Promise<IncidentActionOutcome>;
  restore(item: AppIncidentItem, context: IncidentActionContext): Promise<IncidentActionOutcome>;
}

const SYSTEM_ACTOR = 'system';

/**
 * The detail of a shutdown item whose resource was deleted while the app was shut down (members take every change
 * then): Start skips it, and the incident view and the release audit list it.
 */
export const DELETED_WHILE_SHUT_DOWN = 'Deleted while the app was shut down; not started';

/** Shutdown items Start brings back (stopped workloads, paused data engines). */
const STARTED_KINDS: ReadonlySet<AppIncidentItemKind> = new Set([
  'container_stop',
  'deployment_stop',
  'compose_stop',
  'database_pause',
  'storage_pause',
]);

/** Migrations of a container that took it to another node (cut over), followed by Start. */
const MIGRATED_STATUSES = ['completed', 'cleanup_pending'] as const;
/** How many migrations in a row Start follows (a container moved on again after its first move). */
const MAX_MIGRATION_HOPS = 5;

/** Where a container a shutdown stopped is now: node, the key Docker finds it by (name or runtime ID), its state. */
interface FoundContainer {
  nodeId: string;
  key: string;
  state: string;
  note?: string;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  return status === 404;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** A daemon's failure for a network that no longer exists (daemons before the `gone` list report it as failed). */
const NETWORK_GONE_ERROR = /no such network|network \S+ not found/i;

/** A network restore split into the networks that are gone (skipped for good) and real failures (retried). */
export interface NetworkRestoreSplit {
  gone: string[];
  failed: NetworkRestoreResult['failed'];
}

export function splitGoneNetworks(result: NetworkRestoreResult): NetworkRestoreSplit {
  const gone = [...result.gone];
  const failed: NetworkRestoreResult['failed'] = [];
  for (const failure of result.failed) {
    if (NETWORK_GONE_ERROR.test(failure.error)) gone.push(failure.networkName || failure.networkId);
    else failed.push(failure);
  }
  return { gone, failed };
}

/** The item detail of a network restore that could not put everything back: gone networks and the network mode. */
export function networkRestoreNotes(gone: readonly string[], result: NetworkRestoreResult): string[] {
  const notes: string[] = [];
  if (gone.length === 1) notes.push(`Skipped network ${gone[0]}: it no longer exists`);
  else if (gone.length > 1) notes.push(`Skipped networks that no longer exist: ${gone.join(', ')}`);
  if (result.networkModeGone) {
    notes.push(
      result.fallbackNetwork
        ? `Primary network ${result.networkModeGone} is gone, so the container is on ${result.fallbackNetwork} now`
        : `Primary network ${result.networkModeGone} is gone; the container keeps its other networks`
    );
  }
  return notes;
}

/** How long a restore waits for the recreate that removes left-over variables (a recreate's own watch is longer). */
const ENV_RECREATE_WAIT_MS = 180_000;
const ENV_RECREATE_POLL_MS = 1_000;

/**
 * Applies and restores incident items against the real services. Every apply returns the state it changed away from;
 * every restore puts back exactly that recorded state and only when the resource is still in the state the incident
 * left it in (nothing is re-derived from the current configuration).
 */
export class DefaultAppIncidentActions implements AppIncidentActions {
  private readonly consumerEnv: AppIncidentConsumerEnv;
  /** Waits of `removeGoneBindingEnv` (shorter in tests). */
  protected envRecreateWait = { timeoutMs: ENV_RECREATE_WAIT_MS, pollMs: ENV_RECREATE_POLL_MS };

  constructor(
    private readonly db: DrizzleClient,
    private readonly maintenance: AppMaintenanceService,
    private readonly network: AppNetworkIsolation,
    consumerEnv?: AppIncidentConsumerEnv
  ) {
    this.consumerEnv = consumerEnv ?? new AppIncidentConsumerEnv(db);
  }

  private resolve<T>(token: abstract new (...args: never[]) => T): T {
    return container.resolve(token as never) as T;
  }

  async apply(item: AppIncidentItem, context: IncidentActionContext): Promise<IncidentActionOutcome> {
    const ref = item.ref as Record<string, unknown>;
    const userId = context.userId;
    try {
      switch (item.itemKind as AppIncidentItemKind) {
        case 'route_overlay': {
          const [route] = await this.db
            .select({ maintenanceEnabled: proxyHosts.maintenanceEnabled, mode: proxyHosts.appMaintenanceMode })
            .from(proxyHosts)
            .where(eq(proxyHosts.id, str(ref.routeId)))
            .limit(1);
          if (!route) return { status: 'gone' };
          const prior = item.priorState ?? {
            maintenanceEnabled: route.maintenanceEnabled,
            appMaintenanceMode: route.mode,
          };
          // The item counts as in effect from its creation; recomputing delivers lockdown/maintenance.
          await this.maintenance.applyModes([str(ref.routeId)]);
          return { status: 'applied', priorState: prior };
        }
        case 'route_withdraw': {
          const [route] = await this.db
            .select({ enabled: proxyHosts.enabled })
            .from(proxyHosts)
            .where(eq(proxyHosts.id, str(ref.routeId)))
            .limit(1);
          if (!route) return { status: 'gone' };
          if (item.priorState) {
            if (route.enabled)
              await this.proxy().toggleProxyHost(str(ref.routeId), false, userId ?? SYSTEM_ACTOR, {
                appIncident: true,
              });
            return { status: 'applied', priorState: item.priorState };
          }
          if (route.enabled)
            await this.proxy().toggleProxyHost(str(ref.routeId), false, userId ?? SYSTEM_ACTOR, { appIncident: true });
          return { status: 'applied', priorState: { enabled: route.enabled } };
        }
        case 'container_link': {
          const result = await this.resolve(ContainerLinksService).suspendForIncident(str(ref.linkId), userId);
          if (!result) return { status: 'gone' };
          return {
            status: 'applied',
            priorState: item.priorState ?? {
              desiredState: result.desiredState,
              ...(await this.consumerEnv.record('container_link', str(ref.linkId))),
            },
          };
        }
        case 'database_binding': {
          const result = await this.resolve(ManagedDatabaseBindingService).suspendForIncident(
            str(ref.bindingId),
            userId
          );
          if (!result) return { status: 'gone' };
          return {
            status: 'applied',
            priorState: item.priorState ?? {
              desiredState: result.desiredState,
              ...(await this.consumerEnv.record('database_binding', str(ref.bindingId))),
            },
          };
        }
        case 'storage_binding': {
          const result = await this.resolve(ManagedStorageBindingsService).suspendForIncident(
            str(ref.bindingId),
            userId
          );
          if (!result) return { status: 'gone' };
          return {
            status: 'applied',
            priorState: item.priorState ?? {
              desiredState: result.desiredState,
              ...(await this.consumerEnv.record('storage_binding', str(ref.bindingId))),
            },
          };
        }
        case 'secure_link': {
          const result = await this.resolve(ProxySecureLinkService).setIncidentSuspended(
            str(ref.secureLinkId),
            context.incidentId
          );
          if (!result) return { status: 'gone' };
          // A retry finds the link already held by this incident: keep the holder recorded at the first apply.
          return {
            status: 'applied',
            priorState: item.priorState ?? {
              incidentSuspendedBy: result.previous === context.incidentId ? null : result.previous,
            },
          };
        }
        case 'database_publication': {
          const result = await this.resolve(ManagedDatabaseService).suspendPublication(
            str(ref.databaseId),
            item.id,
            userId
          );
          if (!result && !item.priorState) return { status: 'gone' };
          return { status: 'applied', priorState: item.priorState ?? result! };
        }
        case 'storage_publication': {
          const result = await this.resolve(ManagedStorageService).suspendPublication(
            str(ref.storageId),
            item.id,
            userId
          );
          if (!result && !item.priorState) return { status: 'gone' };
          return { status: 'applied', priorState: item.priorState ?? result! };
        }
        case 'container_network':
          return await this.isolateContainer(item, userId);
        case 'container_stop': {
          const status = await this.containerStatus(str(ref.nodeId), str(ref.name));
          if (status === null) return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (status.state === 'running') {
            await this.docker().stopContainer(str(ref.nodeId), str(ref.name), undefined, userId ?? SYSTEM_ACTOR);
          }
          // The runtime ID finds the container again when it is renamed while the app is shut down.
          return { status: 'applied', priorState: item.priorState ?? { state: status.state, containerId: status.id } };
        }
        case 'deployment_stop': {
          const deployment = await this.deployment(str(ref.deploymentId));
          if (!deployment || deployment.status === 'deleting') {
            return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          }
          if (deployment.status !== 'stopped') {
            await this.resolve(DockerDeploymentService).stop(deployment.nodeId, deployment.id, userId);
          }
          return { status: 'applied', priorState: item.priorState ?? { status: deployment.status } };
        }
        case 'compose_stop': {
          const project = await this.composeProject(str(ref.projectId));
          if (!project || project.status === 'deleting') return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (project.status !== 'stopped') {
            const operation = await this.resolve(DockerComposeService).startOperation(
              project.nodeId,
              project.id,
              'stop',
              { idempotencyKey: `app-incident:${item.id}:stop:${item.attempts}`, volumeNames: [] },
              userId ?? SYSTEM_ACTOR
            );
            await this.waitForCompose(project.id, (operation as { id?: string })?.id);
          }
          return { status: 'applied', priorState: item.priorState ?? { status: project.status } };
        }
        case 'database_pause': {
          const database = await this.managedDatabase(str(ref.databaseId));
          if (!database || database.status === 'deleting') return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (database.status !== 'paused') {
            await this.resolve(ManagedDatabaseService).pause(database.id, userId ?? SYSTEM_ACTOR);
          }
          return { status: 'applied', priorState: item.priorState ?? { status: database.status } };
        }
        case 'storage_pause': {
          const storage = await this.managedStorage(str(ref.storageId));
          if (!storage || storage.status === 'deleting') return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (storage.status !== 'paused') await this.resolve(ManagedStorageService).pause(storage.id, userId);
          return { status: 'applied', priorState: item.priorState ?? { status: storage.status } };
        }
      }
    } catch (error) {
      if (isNotFound(error)) return this.goneOutcome(item);
      throw error;
    }
    throw new Error(`Unknown incident item kind ${item.itemKind}`);
  }

  async restore(item: AppIncidentItem, context: IncidentActionContext): Promise<IncidentActionOutcome> {
    const ref = item.ref as Record<string, unknown>;
    const prior = (item.priorState ?? {}) as Record<string, any>;
    const userId = context.userId;
    try {
      switch (item.itemKind as AppIncidentItemKind) {
        case 'route_overlay': {
          // The caller marks the item restored first; recomputing drops the overlay (the route's own switch was never
          // touched). A route deleted meanwhile has nothing left to restore.
          const [route] = await this.db
            .select({ id: proxyHosts.id })
            .from(proxyHosts)
            .where(eq(proxyHosts.id, str(ref.routeId)))
            .limit(1);
          if (!route) return { status: 'gone' };
          await this.maintenance.applyModes([str(ref.routeId)]);
          return { status: 'restored' };
        }
        case 'route_withdraw': {
          const [route] = await this.db
            .select({ enabled: proxyHosts.enabled })
            .from(proxyHosts)
            .where(eq(proxyHosts.id, str(ref.routeId)))
            .limit(1);
          if (!route) return { status: 'gone' };
          if (prior.enabled === true && !route.enabled) {
            await this.proxy().toggleProxyHost(str(ref.routeId), true, userId ?? SYSTEM_ACTOR, { appIncident: true });
          }
          return { status: 'restored' };
        }
        case 'container_link': {
          const [row] = await this.db
            .select({ desiredState: containerLinks.desiredState })
            .from(containerLinks)
            .where(eq(containerLinks.id, str(ref.linkId)))
            .limit(1);
          if (!row || row.desiredState === 'deleted') return { status: 'gone' };
          if (prior.desiredState !== 'suspended' && row.desiredState === 'suspended') {
            // Removed between the check and the resume: nothing left to restore.
            const resumed = await this.resolve(ContainerLinksService).resumeFromIncident(str(ref.linkId), userId);
            if (!resumed) return { status: 'gone' };
          }
          return { status: 'restored' };
        }
        case 'database_binding': {
          const [row] = await this.db
            .select({ desiredState: managedDatabaseBindings.desiredState })
            .from(managedDatabaseBindings)
            .where(eq(managedDatabaseBindings.id, str(ref.bindingId)))
            .limit(1);
          if (!row || row.desiredState === 'deleted') return { status: 'gone' };
          if (prior.desiredState !== 'suspended' && row.desiredState === 'suspended') {
            // Removed between the check and the resume: nothing left to restore.
            const resumed = await this.resolve(ManagedDatabaseBindingService).resumeFromIncident(
              str(ref.bindingId),
              userId
            );
            if (!resumed) return { status: 'gone' };
          }
          return { status: 'restored' };
        }
        case 'storage_binding': {
          const [row] = await this.db
            .select({ desiredState: managedStorageBindings.desiredState })
            .from(managedStorageBindings)
            .where(eq(managedStorageBindings.id, str(ref.bindingId)))
            .limit(1);
          if (!row) return { status: 'gone' };
          if (prior.desiredState !== 'suspended' && row.desiredState === 'suspended') {
            // Removed between the check and the resume: nothing left to restore.
            const resumed = await this.resolve(ManagedStorageBindingsService).resumeFromIncident(
              str(ref.bindingId),
              userId
            );
            if (!resumed) return { status: 'gone' };
          }
          return { status: 'restored' };
        }
        case 'secure_link': {
          const result = await this.resolve(ProxySecureLinkService).setIncidentSuspended(
            str(ref.secureLinkId),
            (prior.incidentSuspendedBy as string | null | undefined) ?? null
          );
          return result ? { status: 'restored' } : { status: 'gone' };
        }
        case 'database_publication': {
          const ok = await this.resolve(ManagedDatabaseService).resumePublication(
            str(ref.databaseId),
            { publishedPort: prior.publishedPort ?? null, publishedNativePort: prior.publishedNativePort ?? null },
            item.id,
            userId
          );
          return ok ? { status: 'restored' } : { status: 'gone' };
        }
        case 'storage_publication': {
          const ok = await this.resolve(ManagedStorageService).resumePublication(
            str(ref.storageId),
            { publishS3: prior.publishS3 === true, publishedPort: Number(prior.publishedPort) },
            item.id,
            userId
          );
          return ok ? { status: 'restored' } : { status: 'gone' };
        }
        case 'container_network':
          return await this.restoreContainer(item, userId);
        case 'container_stop': {
          // Start only what was running and is still stopped (a container started by hand meanwhile is left alone),
          // wherever it is now; a container deleted while shut down is skipped.
          const found = await this.findStoppedContainer(item, str(ref.nodeId), str(ref.name), prior.containerId);
          if (!found) return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (prior.state === 'running' && found.state !== 'running') {
            await this.docker().startContainer(found.nodeId, found.key, userId ?? SYSTEM_ACTOR, { appIncident: true });
          }
          return found.note ? { status: 'restored', detail: found.note } : { status: 'restored' };
        }
        case 'deployment_stop': {
          // By ID: a deployment renamed, migrated or moved to another environment meanwhile is still started.
          const deployment = await this.deployment(str(ref.deploymentId));
          if (!deployment || deployment.status === 'deleting') {
            return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          }
          if (prior.status !== 'stopped' && deployment.status === 'stopped') {
            await this.resolve(DockerDeploymentService).start(deployment.nodeId, deployment.id, userId);
          }
          return { status: 'restored' };
        }
        case 'compose_stop': {
          const project = await this.composeProject(str(ref.projectId));
          if (!project || project.status === 'deleting') return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (prior.status !== 'stopped' && project.status === 'stopped') {
            // A project taken down while shut down has no containers to start: it comes up from its active revision.
            const takenDown = await this.composeTakenDownSince(project.id, item.createdAt);
            const action = takenDown ? 'apply' : 'start';
            const operation = await this.resolve(DockerComposeService).startOperation(
              project.nodeId,
              project.id,
              action,
              { idempotencyKey: `app-incident:${item.id}:${action}:${item.attempts}`, volumeNames: [] },
              userId ?? SYSTEM_ACTOR,
              false,
              { appIncident: true }
            );
            await this.waitForCompose(project.id, (operation as { id?: string })?.id);
            if (takenDown) {
              return {
                status: 'restored',
                detail: 'Taken down while the app was shut down; brought up again from its active revision',
              };
            }
          }
          return { status: 'restored' };
        }
        case 'database_pause': {
          const database = await this.managedDatabase(str(ref.databaseId));
          if (!database || database.status === 'deleting') return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (prior.status !== 'paused' && database.status === 'paused') {
            await this.resolve(ManagedDatabaseService).unpause(database.id, userId ?? SYSTEM_ACTOR);
          }
          return { status: 'restored' };
        }
        case 'storage_pause': {
          const storage = await this.managedStorage(str(ref.storageId));
          if (!storage || storage.status === 'deleting') return { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN };
          if (prior.status !== 'paused' && storage.status === 'paused') {
            await this.resolve(ManagedStorageService).unpause(storage.id, userId);
          }
          return { status: 'restored' };
        }
      }
    } catch (error) {
      if (isNotFound(error)) return this.goneOutcome(item);
      throw error;
    }
    throw new Error(`Unknown incident item kind ${item.itemKind}`);
  }

  /** A resource found missing: a shutdown item says it was deleted while the app was shut down. */
  private goneOutcome(item: AppIncidentItem): IncidentActionOutcome {
    return STARTED_KINDS.has(item.itemKind as AppIncidentItemKind)
      ? { status: 'gone', detail: DELETED_WHILE_SHUT_DOWN }
      : { status: 'gone' };
  }

  /**
   * The container a shutdown stopped, where it is now. Members take every change while the app is shut down, so:
   * a migration since the shutdown is followed to the node it took the container to; otherwise the name on its node
   * (a container recreated under the name is the same container), then the runtime ID recorded when it was stopped
   * (renamed meanwhile). Null when nothing is left (deleted).
   */
  private async findStoppedContainer(
    item: AppIncidentItem,
    nodeId: string,
    name: string,
    containerId: unknown
  ): Promise<FoundContainer | null> {
    let node = nodeId;
    let since = item.createdAt;
    for (let hop = 0; hop < MAX_MIGRATION_HOPS; hop += 1) {
      const migration = await this.migrationSince(node, name, since);
      if (!migration) break;
      node = migration.targetNodeId;
      since = migration.cutoverAt;
    }
    if (node !== nodeId) {
      const status = await this.containerStatus(node, name);
      return status
        ? { nodeId: node, key: name, state: status.state, note: 'Migrated to another node while the app was shut down' }
        : null;
    }
    const byName = await this.containerStatus(nodeId, name);
    if (byName) return { nodeId, key: name, state: byName.state };
    if (typeof containerId !== 'string' || !containerId) return null;
    const byId = await this.containerStatus(nodeId, containerId);
    if (!byId) return null;
    return {
      nodeId,
      key: containerId,
      state: byId.state,
      ...(byId.name ? { note: `Renamed to ${byId.name} while the app was shut down` } : {}),
    };
  }

  /** The migration that took a container from a node since a moment (cut over), if any. */
  private async migrationSince(
    nodeId: string,
    name: string,
    since: Date
  ): Promise<{ targetNodeId: string; cutoverAt: Date } | null> {
    const [row] = await this.db
      .select({ targetNodeId: dockerMigrations.targetNodeId, cutoverAt: dockerMigrations.cutoverAt })
      .from(dockerMigrations)
      .where(
        and(
          eq(dockerMigrations.resourceType, 'container'),
          eq(dockerMigrations.sourceNodeId, nodeId),
          eq(dockerMigrations.resourceName, name),
          inArray(dockerMigrations.status, [...MIGRATED_STATUSES]),
          gt(dockerMigrations.cutoverAt, since)
        )
      )
      .orderBy(desc(dockerMigrations.cutoverAt))
      .limit(1);
    return row?.cutoverAt ? { targetNodeId: row.targetNodeId, cutoverAt: row.cutoverAt } : null;
  }

  /** Whether the last Compose down/apply/start that succeeded on a project since a moment was a down. */
  private async composeTakenDownSince(projectId: string, since: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ action: dockerComposeOperations.action })
      .from(dockerComposeOperations)
      .where(
        and(
          eq(dockerComposeOperations.projectId, projectId),
          eq(dockerComposeOperations.status, 'succeeded'),
          inArray(dockerComposeOperations.action, ['down', 'apply', 'pull_apply', 'start']),
          gt(dockerComposeOperations.createdAt, since)
        )
      )
      .orderBy(desc(dockerComposeOperations.createdAt))
      .limit(1);
    return row?.action === 'down';
  }

  /**
   * Network isolation of one container: the daemon returns every endpoint it removed (kept as the prior state, never
   * overwritten by a retry, which finds nothing left to remove). A host-network container cannot lose its network:
   * it is stopped instead (and started again on release when it ran).
   */
  private async isolateContainer(item: AppIncidentItem, userId: string | null): Promise<IncidentActionOutcome> {
    const ref = item.ref as { nodeId: string; name: string };
    const status = await this.containerStatus(ref.nodeId, ref.name);
    if (status === null) return { status: 'gone' };
    const { state } = status;
    try {
      const result = await this.network.isolate(ref.nodeId, ref.name);
      const previous = item.priorState as { endpoints?: IsolatedEndpoint[] } | null;
      const endpoints = [...(previous?.endpoints ?? [])];
      for (const endpoint of result.endpoints) {
        if (!endpoints.some((known) => known.networkName === endpoint.networkName)) endpoints.push(endpoint);
      }
      await this.refreshSnapshot(ref.nodeId, [ref.name, status.id]);
      return { status: 'applied', priorState: { networkMode: result.networkMode, endpoints } };
    } catch (error) {
      if ((error as { code?: string })?.code !== 'HOST_NETWORK') throw error;
      const wasRunning = (item.priorState as { wasRunning?: boolean } | null)?.wasRunning ?? state === 'running';
      if (state === 'running') {
        await this.docker().stopContainer(ref.nodeId, ref.name, undefined, userId ?? SYSTEM_ACTOR);
        await this.refreshSnapshot(ref.nodeId, [ref.name, status.id]);
      }
      return { status: 'applied', priorState: { hostNetwork: true, wasRunning } };
    }
  }

  /**
   * Puts a container back on the networks it was isolated from. A network removed meanwhile (with its binding or link)
   * is gone: skipped and named in the detail, never failed or retried. The daemon keeps the container startable when
   * its network mode named such a network (on the default bridge when nothing else was left). Variables a removed
   * binding left on the container go as well.
   */
  private async restoreContainer(item: AppIncidentItem, userId: string | null): Promise<IncidentActionOutcome> {
    const ref = item.ref as { nodeId: string; name: string };
    const prior = (item.priorState ?? {}) as {
      hostNetwork?: boolean;
      wasRunning?: boolean;
      endpoints?: IsolatedEndpoint[];
    };
    const status = await this.containerStatus(ref.nodeId, ref.name);
    if (status === null) return { status: 'gone' };
    const notes: string[] = [];
    if (prior.hostNetwork) {
      if (prior.wasRunning && status.state !== 'running') {
        await this.docker().startContainer(ref.nodeId, ref.name, userId ?? SYSTEM_ACTOR, { appIncident: true });
        await this.refreshSnapshot(ref.nodeId, [ref.name, status.id]);
      }
    } else if ((prior.endpoints ?? []).length > 0) {
      const result = await this.network.restore(ref.nodeId, ref.name, prior.endpoints!);
      // Read back before anything can fail below: the networks a partial restore put back show at once as well.
      await this.refreshSnapshot(ref.nodeId, [ref.name, status.id]);
      const { gone, failed } = splitGoneNetworks(result);
      if (failed.length > 0) {
        throw new Error(
          `Networks not restored: ${failed.map((failure) => `${failure.networkName}: ${failure.error}`).join('; ')}`
        );
      }
      notes.push(...networkRestoreNotes(gone, result));
    }
    notes.push(...(await this.removeGoneBindingEnv(item, ref, userId)));
    return notes.length > 0 ? { status: 'restored', detail: notes.join('. ') } : { status: 'restored' };
  }

  /**
   * Removes the variables a binding or link removed during the incident left on the container (see
   * AppIncidentConsumerEnv), as the binding's removal does: an environment update without them, which recreates the
   * container. Waits for that recreate, so the item reports whether the variables are gone (retried otherwise).
   */
  private async removeGoneBindingEnv(
    item: AppIncidentItem,
    ref: { nodeId: string; name: string },
    userId: string | null
  ): Promise<string[]> {
    const candidates = await this.consumerEnv.leftByGoneBindings(item.incidentId, ref.nodeId, ref.name);
    if (candidates.length === 0) return [];
    const present = envKeys((await this.docker().inspectContainer(ref.nodeId, ref.name))?.Config?.Env);
    const left = candidates.filter((name) => present.has(name));
    if (left.length === 0) return [];
    await this.docker().updateContainerEnv(ref.nodeId, ref.name, undefined, left, userId ?? SYSTEM_ACTOR);
    const deadline = Date.now() + this.envRecreateWait.timeoutMs;
    while (this.docker().getContainerTransition(ref.nodeId, ref.name) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.envRecreateWait.pollMs));
    }
    const after = envKeys((await this.docker().inspectContainer(ref.nodeId, ref.name))?.Config?.Env);
    const still = left.filter((name) => after.has(name));
    if (still.length > 0) {
      throw new Error(`Variables of removed bindings not removed yet: ${still.join(', ')}`);
    }
    return [`Removed ${left.join(', ')} left by removed bindings`];
  }

  /**
   * Reads a container back into Gateway's snapshot now, as a lifecycle request does before it answers: the container
   * list and its detail (under its name and runtime ID, the keys pages read it by; open pages get the
   * docker.snapshot.changed event) show what isolation or its release did at once, not after the periodic reconcile.
   * A failed read is left to that reconcile.
   */
  private async refreshSnapshot(nodeId: string, keys: readonly string[]): Promise<void> {
    try {
      await this.resolve(DockerSnapshotReconciler).refreshContainerNow(nodeId, keys);
    } catch {
      // The periodic reconcile reads it back.
    }
  }

  /**
   * The container's state (`running` or another Docker state, asked live, not from a snapshot), runtime ID and name,
   * or null when it does not exist.
   */
  private async containerStatus(
    nodeId: string,
    nameOrId: string
  ): Promise<{ state: string; id: string; name: string } | null> {
    try {
      const data = (await this.docker().inspectContainer(nodeId, nameOrId)) as Record<string, any> | null;
      if (!data) return null;
      const id = String(data.Id ?? data.id ?? '');
      const name = String(data.Name ?? data.name ?? '').replace(/^\//, '');
      const state = data.State ?? data.state;
      if (typeof state === 'string') return { state: state.toLowerCase(), id, name };
      if (state && typeof state === 'object') {
        if (state.Running === true || state.running === true) return { state: 'running', id, name };
        return { state: String(state.Status ?? state.status ?? 'exited').toLowerCase(), id, name };
      }
      return { state: 'exited', id, name };
    } catch (error) {
      if (isNotFound(error) || /no such container|not found/i.test(String((error as Error)?.message ?? ''))) {
        return null;
      }
      throw error;
    }
  }

  private async deployment(id: string) {
    const [row] = await this.db
      .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId, status: dockerDeployments.status })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, id))
      .limit(1);
    return row ?? null;
  }

  private async composeProject(id: string) {
    const [row] = await this.db
      .select({
        id: dockerComposeProjects.id,
        nodeId: dockerComposeProjects.nodeId,
        status: dockerComposeProjects.status,
      })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, id))
      .limit(1);
    return row ?? null;
  }

  private async managedDatabase(id: string) {
    const [row] = await this.db
      .select({ id: managedDatabaseInstances.id, status: managedDatabaseInstances.status })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, id))
      .limit(1);
    return row ?? null;
  }

  private async managedStorage(id: string) {
    const [row] = await this.db
      .select({ id: managedStorageClusters.id, status: managedStorageClusters.status })
      .from(managedStorageClusters)
      .where(eq(managedStorageClusters.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Compose stop/start run as operations: wait for the one started (bounded), so the item reports its outcome. */
  private async waitForCompose(_projectId: string, operationId: string | undefined) {
    if (!operationId) return;
    const result = await this.resolve(DockerComposeService).waitForOperation(operationId, 5 * 60_000);
    if (result?.status && result.status !== 'succeeded') {
      throw new Error(`Compose operation ended ${result.status}${result.error ? `: ${result.error}` : ''}`);
    }
  }

  private docker(): DockerManagementService {
    return this.resolve(DockerManagementService);
  }

  private proxy(): ProxyService {
    return this.resolve(ProxyService);
  }
}
