import type { IncidentTargets } from './app-incident-targets.js';
import type { NewIncidentItem } from './app-incidents.repo.js';
import { routeTakesMaintenance } from './app-maintenance.service.js';

/** Shutdown phases: routes show the maintenance page first, then workloads stop, then data engines pause. */
export const SHUTDOWN_PHASES = { routes: 10, workloads: 20, data: 30 } as const;

const STOPPED_DEPLOYMENT = new Set(['stopped', 'deleting', 'creating']);
const RUNNING_COMPOSE = new Set(['running', 'degraded']);

function routeLabel(domains: readonly string[], id: string): string {
  return domains.length > 0 ? domains.join(', ') : id;
}

/**
 * What an app shutdown changes in one environment: running containers stop, deployments and Compose projects stop,
 * managed databases and storage pause, and the environment's routes and the routes of its Pages projects show the
 * maintenance page (with team access). Only what runs is recorded, so Start brings back exactly that set. While shut
 * down, members take every change (deletes, unbinds, renames, migrations and moves included): Start brings back what
 * still exists and ends the items of deleted resources `gone` (DefaultAppIncidentActions.restore).
 */
export function buildShutdownItems(targets: IncidentTargets, gatewayRouteIds: ReadonlySet<string>): NewIncidentItem[] {
  const items: NewIncidentItem[] = [];
  for (const route of targets.routes) {
    if (route.derived && !route.pages) continue;
    if (!route.enabled || !routeTakesMaintenance(route) || gatewayRouteIds.has(route.id)) continue;
    items.push({
      itemKind: 'route_overlay',
      itemKey: `route:${route.id}`,
      phase: SHUTDOWN_PHASES.routes,
      ref: {
        routeId: route.id,
        derived: route.derived,
        pages: route.pages,
        label: routeLabel(route.domainNames, route.id),
      },
    });
  }
  const memberContainerKeys = new Set(
    targets.members.filter((member) => member.type === 'container').map((member) => `${member.nodeId}:${member.id}`)
  );
  for (const entry of targets.containers) {
    // Containers stop on their own node; an Availability workload follows its logical container.
    if (entry.owner.type !== 'container' || !memberContainerKeys.has(`${entry.nodeId}:${entry.name}`)) continue;
    if (!entry.running) continue;
    items.push({
      itemKind: 'container_stop',
      itemKey: `container:${entry.nodeId}:${entry.name}`,
      phase: SHUTDOWN_PHASES.workloads,
      ref: { nodeId: entry.nodeId, name: entry.name, label: entry.name },
    });
  }
  for (const deployment of targets.deployments) {
    if (STOPPED_DEPLOYMENT.has(deployment.status)) continue;
    items.push({
      itemKind: 'deployment_stop',
      itemKey: `deployment:${deployment.id}`,
      phase: SHUTDOWN_PHASES.workloads,
      ref: { deploymentId: deployment.id, nodeId: deployment.nodeId, label: deployment.name },
    });
  }
  for (const project of targets.composeProjects) {
    if (!RUNNING_COMPOSE.has(project.status)) continue;
    items.push({
      itemKind: 'compose_stop',
      itemKey: `compose:${project.id}`,
      phase: SHUTDOWN_PHASES.workloads,
      ref: { projectId: project.id, nodeId: project.nodeId, label: project.name },
    });
  }
  for (const database of targets.databases) {
    if (database.status !== 'ready') continue;
    items.push({
      itemKind: 'database_pause',
      itemKey: `database:${database.id}`,
      phase: SHUTDOWN_PHASES.data,
      ref: { databaseId: database.id, connectionId: database.connectionId, label: database.name },
    });
  }
  for (const storage of targets.storages) {
    if (storage.status !== 'ready') continue;
    items.push({
      itemKind: 'storage_pause',
      itemKey: `storage:${storage.id}`,
      phase: SHUTDOWN_PHASES.data,
      ref: { storageId: storage.id, connectionId: storage.connectionId, label: storage.name },
    });
  }
  return items;
}

/** Counts a shutdown dialog shows before it runs. */
export function summarizeShutdown(items: readonly NewIncidentItem[]) {
  const count = (kind: NewIncidentItem['itemKind'], filter?: (item: NewIncidentItem) => boolean) =>
    items.filter((item) => item.itemKind === kind && (!filter || filter(item))).length;
  return {
    containers: count('container_stop'),
    deployments: count('deployment_stop'),
    composeProjects: count('compose_stop'),
    databases: count('database_pause'),
    storages: count('storage_pause'),
    routes: count('route_overlay', (item) => !(item.ref as { pages?: boolean }).pages),
    pagesRoutes: count('route_overlay', (item) => (item.ref as { pages?: boolean }).pages === true),
  };
}
