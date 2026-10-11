import { eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AppIncidentItem,
  containerLinks,
  dockerComposeProjects,
  dockerDeployments,
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
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import { ManagedStorageBindingsService } from '@/modules/storage/managed-storage-bindings.service.js';
import type { AppIncidentItemKind } from './app-incidents.repo.js';
import type { AppMaintenanceService } from './app-maintenance.service.js';
import type { AppNetworkIsolation, IsolatedEndpoint } from './app-network-isolation.js';

export interface IncidentActionContext {
  incidentId: string;
  userId: string | null;
}

/** What applying or restoring an item did: applied (with the prior state to keep), restored, or the resource is gone. */
export type IncidentActionOutcome =
  | { status: 'applied'; priorState: Record<string, unknown> }
  | { status: 'restored' }
  | { status: 'gone' };

export interface AppIncidentActions {
  apply(item: AppIncidentItem, context: IncidentActionContext): Promise<IncidentActionOutcome>;
  restore(item: AppIncidentItem, context: IncidentActionContext): Promise<IncidentActionOutcome>;
}

const SYSTEM_ACTOR = 'system';

function isNotFound(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  return status === 404;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * Applies and restores incident items against the real services. Every apply returns the state it changed away from;
 * every restore puts back exactly that recorded state and only when the resource is still in the state the incident
 * left it in (nothing is re-derived from the current configuration).
 */
export class DefaultAppIncidentActions implements AppIncidentActions {
  constructor(
    private readonly db: DrizzleClient,
    private readonly maintenance: AppMaintenanceService,
    private readonly network: AppNetworkIsolation
  ) {}

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
          return { status: 'applied', priorState: item.priorState ?? { desiredState: result.desiredState } };
        }
        case 'database_binding': {
          const result = await this.resolve(ManagedDatabaseBindingService).suspendForIncident(
            str(ref.bindingId),
            userId
          );
          if (!result) return { status: 'gone' };
          return { status: 'applied', priorState: item.priorState ?? { desiredState: result.desiredState } };
        }
        case 'storage_binding': {
          const result = await this.resolve(ManagedStorageBindingsService).suspendForIncident(
            str(ref.bindingId),
            userId
          );
          if (!result) return { status: 'gone' };
          return { status: 'applied', priorState: item.priorState ?? { desiredState: result.desiredState } };
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
          const state = await this.containerState(str(ref.nodeId), str(ref.name));
          if (state === null) return { status: 'gone' };
          if (state === 'running') {
            await this.docker().stopContainer(str(ref.nodeId), str(ref.name), undefined, userId ?? SYSTEM_ACTOR);
          }
          return { status: 'applied', priorState: item.priorState ?? { state } };
        }
        case 'deployment_stop': {
          const deployment = await this.deployment(str(ref.deploymentId));
          if (!deployment) return { status: 'gone' };
          if (deployment.status !== 'stopped') {
            await this.resolve(DockerDeploymentService).stop(deployment.nodeId, deployment.id, userId);
          }
          return { status: 'applied', priorState: item.priorState ?? { status: deployment.status } };
        }
        case 'compose_stop': {
          const project = await this.composeProject(str(ref.projectId));
          if (!project) return { status: 'gone' };
          if (project.status !== 'stopped') {
            const operation = await this.resolve(DockerComposeService).startOperation(
              project.nodeId,
              project.id,
              'stop' as never,
              {} as never,
              userId ?? SYSTEM_ACTOR
            );
            await this.waitForCompose(project.id, (operation as { id?: string })?.id);
          }
          return { status: 'applied', priorState: item.priorState ?? { status: project.status } };
        }
        case 'database_pause': {
          const database = await this.managedDatabase(str(ref.databaseId));
          if (!database) return { status: 'gone' };
          if (database.status !== 'paused') {
            await this.resolve(ManagedDatabaseService).pause(database.id, userId ?? SYSTEM_ACTOR);
          }
          return { status: 'applied', priorState: item.priorState ?? { status: database.status } };
        }
        case 'storage_pause': {
          const storage = await this.managedStorage(str(ref.storageId));
          if (!storage) return { status: 'gone' };
          if (storage.status !== 'paused') await this.resolve(ManagedStorageService).pause(storage.id, userId);
          return { status: 'applied', priorState: item.priorState ?? { status: storage.status } };
        }
      }
    } catch (error) {
      if (isNotFound(error)) return { status: 'gone' };
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
        case 'route_overlay':
          // The caller marks the item restored first; recomputing drops the overlay (the route's own switch was never
          // touched).
          await this.maintenance.applyModes([str(ref.routeId)]);
          return { status: 'restored' };
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
            await this.resolve(ContainerLinksService).resumeFromIncident(str(ref.linkId), userId);
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
            await this.resolve(ManagedDatabaseBindingService).resumeFromIncident(str(ref.bindingId), userId);
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
            await this.resolve(ManagedStorageBindingsService).resumeFromIncident(str(ref.bindingId), userId);
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
          // Start only what was running and is still stopped (a container started by hand meanwhile is left alone).
          const state = await this.containerState(str(ref.nodeId), str(ref.name));
          if (state === null) return { status: 'gone' };
          if (prior.state === 'running' && state !== 'running') {
            await this.docker().startContainer(str(ref.nodeId), str(ref.name), userId ?? SYSTEM_ACTOR, {
              appIncident: true,
            });
          }
          return { status: 'restored' };
        }
        case 'deployment_stop': {
          const deployment = await this.deployment(str(ref.deploymentId));
          if (!deployment) return { status: 'gone' };
          if (prior.status !== 'stopped' && deployment.status === 'stopped') {
            await this.resolve(DockerDeploymentService).start(deployment.nodeId, deployment.id, userId);
          }
          return { status: 'restored' };
        }
        case 'compose_stop': {
          const project = await this.composeProject(str(ref.projectId));
          if (!project) return { status: 'gone' };
          if (prior.status !== 'stopped' && project.status === 'stopped') {
            const operation = await this.resolve(DockerComposeService).startOperation(
              project.nodeId,
              project.id,
              'start' as never,
              {} as never,
              userId ?? SYSTEM_ACTOR
            );
            await this.waitForCompose(project.id, (operation as { id?: string })?.id);
          }
          return { status: 'restored' };
        }
        case 'database_pause': {
          const database = await this.managedDatabase(str(ref.databaseId));
          if (!database) return { status: 'gone' };
          if (prior.status !== 'paused' && database.status === 'paused') {
            await this.resolve(ManagedDatabaseService).unpause(database.id, userId ?? SYSTEM_ACTOR);
          }
          return { status: 'restored' };
        }
        case 'storage_pause': {
          const storage = await this.managedStorage(str(ref.storageId));
          if (!storage) return { status: 'gone' };
          if (prior.status !== 'paused' && storage.status === 'paused') {
            await this.resolve(ManagedStorageService).unpause(storage.id, userId);
          }
          return { status: 'restored' };
        }
      }
    } catch (error) {
      if (isNotFound(error)) return { status: 'gone' };
      throw error;
    }
    throw new Error(`Unknown incident item kind ${item.itemKind}`);
  }

  /**
   * Network isolation of one container: the daemon returns every endpoint it removed (kept as the prior state, never
   * overwritten by a retry, which finds nothing left to remove). A host-network container cannot lose its network:
   * it is stopped instead (and started again on release when it ran).
   */
  private async isolateContainer(item: AppIncidentItem, userId: string | null): Promise<IncidentActionOutcome> {
    const ref = item.ref as { nodeId: string; name: string };
    const state = await this.containerState(ref.nodeId, ref.name);
    if (state === null) return { status: 'gone' };
    try {
      const result = await this.network.isolate(ref.nodeId, ref.name);
      const previous = item.priorState as { endpoints?: IsolatedEndpoint[] } | null;
      const endpoints = [...(previous?.endpoints ?? [])];
      for (const endpoint of result.endpoints) {
        if (!endpoints.some((known) => known.networkName === endpoint.networkName)) endpoints.push(endpoint);
      }
      return { status: 'applied', priorState: { networkMode: result.networkMode, endpoints } };
    } catch (error) {
      if ((error as { code?: string })?.code !== 'HOST_NETWORK') throw error;
      const wasRunning = (item.priorState as { wasRunning?: boolean } | null)?.wasRunning ?? state === 'running';
      if (state === 'running')
        await this.docker().stopContainer(ref.nodeId, ref.name, undefined, userId ?? SYSTEM_ACTOR);
      return { status: 'applied', priorState: { hostNetwork: true, wasRunning } };
    }
  }

  private async restoreContainer(item: AppIncidentItem, userId: string | null): Promise<IncidentActionOutcome> {
    const ref = item.ref as { nodeId: string; name: string };
    const prior = (item.priorState ?? {}) as {
      hostNetwork?: boolean;
      wasRunning?: boolean;
      endpoints?: IsolatedEndpoint[];
    };
    const state = await this.containerState(ref.nodeId, ref.name);
    if (state === null) return { status: 'gone' };
    if (prior.hostNetwork) {
      if (prior.wasRunning && state !== 'running') {
        await this.docker().startContainer(ref.nodeId, ref.name, userId ?? SYSTEM_ACTOR, { appIncident: true });
      }
      return { status: 'restored' };
    }
    const endpoints = prior.endpoints ?? [];
    if (endpoints.length === 0) return { status: 'restored' };
    const result = await this.network.restore(ref.nodeId, ref.name, endpoints);
    if (result.failed.length > 0) {
      throw new Error(
        `Networks not restored: ${result.failed.map((failure) => `${failure.networkName}: ${failure.error}`).join('; ')}`
      );
    }
    return { status: 'restored' };
  }

  /** `running`, another Docker state, or null when the container does not exist (asked live, not from a snapshot). */
  private async containerState(nodeId: string, name: string): Promise<string | null> {
    try {
      const data = (await this.docker().inspectContainer(nodeId, name)) as Record<string, any> | null;
      if (!data) return null;
      const state = data.State ?? data.state;
      if (typeof state === 'string') return state.toLowerCase();
      if (state && typeof state === 'object') {
        if (state.Running === true || state.running === true) return 'running';
        return String(state.Status ?? state.status ?? 'exited').toLowerCase();
      }
      return 'exited';
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
