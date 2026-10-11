import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { type AppIncident, type AppIncidentKind, appEnvironments, apps, users } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { APP_OPERATE_SCOPE, assertAppScope, assertAppWideScope, visibleEnvironmentIds } from './app-access.js';
import type { AppIncidentRunner } from './app-incident-runner.js';
import type { AppIncidentTargetsReader, IncidentTargets } from './app-incident-targets.js';
import {
  type AppIncidentsRepo,
  FROZEN_INCIDENT_STATES,
  type IncidentWithItems,
  type NewIncidentItem,
} from './app-incidents.repo.js';
import { routeTakesMaintenance } from './app-maintenance.service.js';
import type { AppMemberFreeze } from './app-member-freeze.js';
import { buildShutdownItems, summarizeShutdown } from './app-shutdown.service.js';
import type { AppActor, AppEnvironmentRow, AppsService } from './apps.service.js';

/** Kill switch phases: routes lock down first, then links, then publications, then container networks. */
export const ISOLATION_PHASES = { routes: 10, links: 20, publications: 30, containers: 40 } as const;

function routeLabel(domains: readonly string[], id: string): string {
  return domains.length > 0 ? domains.join(', ') : id;
}

/**
 * What the kill switch changes in one environment. Routes of the environment and routes elsewhere whose upstream is a
 * member: lockdown (maintenance page without team access) for routes that can show it, withdrawn otherwise. Container
 * links, database and storage bindings touching a member: suspended. Secure Links to a member: held closed. Direct
 * publications of member databases and storage: suspended with their ports held. Every container of every member:
 * cut off from all its networks (a host-network container is stopped instead).
 */
export function buildIsolationItems(targets: IncidentTargets, gatewayRouteIds: ReadonlySet<string>): NewIncidentItem[] {
  const items: NewIncidentItem[] = [];
  for (const route of targets.routes) {
    if (!route.enabled || gatewayRouteIds.has(route.id)) continue;
    items.push({
      itemKind: routeTakesMaintenance(route) ? 'route_overlay' : 'route_withdraw',
      itemKey: `route:${route.id}`,
      phase: ISOLATION_PHASES.routes,
      ref: {
        routeId: route.id,
        derived: route.derived,
        pages: route.pages,
        label: routeLabel(route.domainNames, route.id),
      },
    });
  }
  for (const link of targets.containerLinks) {
    items.push({
      itemKind: 'container_link',
      itemKey: `link:${link.id}`,
      phase: ISOLATION_PHASES.links,
      ref: { linkId: link.id, label: `Container link ${link.id.slice(0, 8)}` },
    });
  }
  for (const binding of targets.databaseBindings) {
    items.push({
      itemKind: 'database_binding',
      itemKey: `database-binding:${binding.id}`,
      phase: ISOLATION_PHASES.links,
      ref: { bindingId: binding.id, label: `Database binding ${binding.id.slice(0, 8)}` },
    });
  }
  for (const binding of targets.storageBindings) {
    items.push({
      itemKind: 'storage_binding',
      itemKey: `storage-binding:${binding.id}`,
      phase: ISOLATION_PHASES.links,
      ref: { bindingId: binding.id, label: `Storage binding ${binding.id.slice(0, 8)}` },
    });
  }
  for (const link of targets.secureLinks) {
    items.push({
      itemKind: 'secure_link',
      itemKey: `secure-link:${link.id}`,
      phase: ISOLATION_PHASES.links,
      ref: { secureLinkId: link.id, label: `Secure Link ${link.id.slice(0, 8)}` },
    });
  }
  for (const database of targets.databases) {
    if (database.publishedPort == null && database.publishedNativePort == null) continue;
    items.push({
      itemKind: 'database_publication',
      itemKey: `database-publication:${database.id}`,
      phase: ISOLATION_PHASES.publications,
      ref: { databaseId: database.id, label: database.name },
    });
  }
  for (const storage of targets.storages) {
    if (!storage.publishS3) continue;
    items.push({
      itemKind: 'storage_publication',
      itemKey: `storage-publication:${storage.id}`,
      phase: ISOLATION_PHASES.publications,
      ref: { storageId: storage.id, label: storage.name },
    });
  }
  for (const entry of targets.containers) {
    items.push({
      itemKind: 'container_network',
      itemKey: `container:${entry.nodeId}:${entry.name}`,
      phase: ISOLATION_PHASES.containers,
      ref: { nodeId: entry.nodeId, name: entry.name, owner: entry.owner, label: entry.name },
    });
  }
  return items;
}

/** Counts the kill switch dialog shows before it runs. */
export function summarizeIsolation(items: readonly NewIncidentItem[]) {
  const count = (...kinds: NewIncidentItem['itemKind'][]) =>
    items.filter((item) => kinds.includes(item.itemKind)).length;
  const composeProjects = new Set(
    items
      .filter((item) => item.itemKind === 'container_network')
      .map((item) => (item.ref as { owner?: { type: string; id: string } }).owner)
      .filter((owner) => owner?.type === 'compose')
      .map((owner) => owner!.id)
  ).size;
  return {
    routes: count('route_overlay', 'route_withdraw'),
    links: count('container_link'),
    bindings: count('database_binding', 'storage_binding'),
    secureLinks: count('secure_link'),
    publications: count('database_publication', 'storage_publication'),
    containers: items.filter(
      (item) =>
        item.itemKind === 'container_network' && (item.ref as { owner?: { type: string } }).owner?.type !== 'compose'
    ).length,
    composeProjects,
  };
}

export interface IncidentView {
  id: string;
  batchId: string;
  environmentId: string;
  kind: AppIncidentKind;
  state: AppIncident['state'];
  startedAt: Date;
  startedBy: { id: string; name: string | null } | null;
  releasedAt: Date | null;
  releasedBy: { id: string; name: string | null } | null;
  lastError: string | null;
  counts: {
    total: number;
    pending: number;
    applied: number;
    failed: number;
    restored: number;
    restoreFailed: number;
    gone: number;
  };
  items: Array<{
    id: string;
    kind: string;
    label: string;
    status: string;
    attempts: number;
    lastError: string | null;
    /** What a restored or gone item could not put back as it was (a network that is gone, for one). */
    detail: string | null;
  }>;
  /**
   * Items skipped because their resource is gone (deleted meanwhile, e.g. while the app was shut down: Start does not
   * bring those back), with the reason when known.
   */
  skipped: Array<{ id: string; kind: string; label: string; detail: string | null }>;
}

function itemLabel(item: { ref: unknown; itemKey: string }): string {
  return String((item.ref as { label?: unknown }).label ?? item.itemKey);
}

/** An item's error while its change is (or should be) in effect; once restored or gone, the restore's note. */
function itemNotes(item: { status: string; lastError: string | null }) {
  const done = item.status === 'restored' || item.status === 'gone';
  return { lastError: done ? null : item.lastError, detail: done ? item.lastError : null };
}

/**
 * App shutdown/start and the kill switch (isolate/release), per environment or for every environment in one batch.
 * Starting records every item with its prior state and runs it in the background; ending marks the incidents
 * releasing and restores item by item. Scope: `apps:operate` on each environment, app-wide for every environment.
 */
export class AppIncidentService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly apps: AppsService,
    private readonly repo: AppIncidentsRepo,
    private readonly targets: AppIncidentTargetsReader,
    private readonly runner: AppIncidentRunner,
    private readonly freeze: AppMemberFreeze,
    private readonly auditService: AuditService
  ) {}

  private async scope(actor: AppActor, appIdOrSlug: string, environmentIds: readonly string[] | null) {
    const { app, envs } = await this.apps.resolveVisible(actor.scopes, appIdOrSlug);
    if (environmentIds === null) {
      assertAppWideScope(actor.scopes, APP_OPERATE_SCOPE, app.id);
      return { app, envs };
    }
    if (environmentIds.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Select at least one environment');
    const selected: AppEnvironmentRow[] = [];
    for (const id of new Set(environmentIds)) {
      const env = envs.find((item) => item.id === id);
      if (!env || visibleEnvironmentIds(actor.scopes, app.id, [env.id]).length === 0) {
        throw new AppError(404, 'APP_ENVIRONMENT_NOT_FOUND', 'Environment not found');
      }
      assertAppScope(actor.scopes, APP_OPERATE_SCOPE, app.id, env.id);
      selected.push(env);
    }
    return { app, envs: selected };
  }

  private async gatewayRouteIds(targets: IncidentTargets): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!container.isRegistered(ProxyService)) return ids;
    const proxy = container.resolve(ProxyService);
    for (const route of targets.routes) {
      if (await proxy.servesGatewayPublicUrl(route)) ids.add(route.id);
    }
    return ids;
  }

  private async build(kind: AppIncidentKind, environmentId: string): Promise<NewIncidentItem[]> {
    const targets = await this.targets.collect(environmentId);
    const gateway = await this.gatewayRouteIds(targets);
    return kind === 'isolation' ? buildIsolationItems(targets, gateway) : buildShutdownItems(targets, gateway);
  }

  /** What a shutdown or a kill switch would change, per environment and in total (the dialogs' consequences). */
  async preview(actor: AppActor, appIdOrSlug: string, kind: AppIncidentKind, environmentIds: readonly string[] | null) {
    const { envs } = await this.scope(actor, appIdOrSlug, environmentIds);
    const perEnvironment = [];
    const all: NewIncidentItem[] = [];
    for (const env of envs) {
      const items = await this.build(kind, env.id);
      all.push(...items);
      perEnvironment.push({
        environmentId: env.id,
        summary: kind === 'isolation' ? summarizeIsolation(items) : summarizeShutdown(items),
        alreadyActive: !!(await this.repo.openFor(env.id, kind)),
      });
    }
    return {
      kind,
      environments: perEnvironment,
      summary: kind === 'isolation' ? summarizeIsolation(all) : summarizeShutdown(all),
    };
  }

  async isolate(actor: AppActor, appIdOrSlug: string, environmentIds: readonly string[] | null, confirmName: string) {
    const { app } = await this.apps.resolveVisible(actor.scopes, appIdOrSlug);
    if ((confirmName ?? '').trim() !== app.name) {
      throw new AppError(400, 'APP_CONFIRM_NAME_MISMATCH', `Type ${app.name} to confirm`);
    }
    return this.begin(actor, appIdOrSlug, environmentIds, 'isolation');
  }

  async shutdown(actor: AppActor, appIdOrSlug: string, environmentIds: readonly string[] | null) {
    return this.begin(actor, appIdOrSlug, environmentIds, 'shutdown');
  }

  async release(actor: AppActor, appIdOrSlug: string, environmentIds: readonly string[] | null) {
    return this.end(actor, appIdOrSlug, environmentIds, 'isolation');
  }

  async start(actor: AppActor, appIdOrSlug: string, environmentIds: readonly string[] | null) {
    return this.end(actor, appIdOrSlug, environmentIds, 'shutdown');
  }

  private async begin(
    actor: AppActor,
    appIdOrSlug: string,
    environmentIds: readonly string[] | null,
    kind: AppIncidentKind
  ): Promise<IncidentView[]> {
    const { app, envs } = await this.scope(actor, appIdOrSlug, environmentIds);
    if (kind === 'shutdown') await this.assertNotIsolated(app.name, envs, environmentIds === null);
    const batchId = randomUUID();
    const created: AppIncident[] = [];
    let skipped = 0;
    for (const env of envs) {
      if (await this.repo.openFor(env.id, kind)) {
        skipped += 1;
        continue;
      }
      const incident = await this.repo.create({
        batchId,
        appId: app.id,
        environmentId: env.id,
        kind,
        startedById: actor.userId,
      });
      const items = await this.build(kind, env.id);
      await this.repo.addItems(incident.id, items);
      created.push(incident);
      await this.auditService.log({
        userId: actor.userId,
        action: kind === 'isolation' ? 'app.isolation.start' : 'app.shutdown',
        resourceType: 'app_environment',
        resourceId: env.id,
        details: {
          appId: app.id,
          appName: app.name,
          environmentName: env.name,
          incidentId: incident.id,
          batchId,
          ...(kind === 'isolation' ? summarizeIsolation(items) : summarizeShutdown(items)),
        },
      });
    }
    if (created.length === 0) {
      throw new AppError(
        409,
        'APP_INCIDENT_ACTIVE',
        kind === 'isolation'
          ? `${app.name} is already isolated in ${skipped === 1 ? 'this environment' : 'these environments'}`
          : `${app.name} is already shut down in ${skipped === 1 ? 'this environment' : 'these environments'}`
      );
    }
    this.freeze.invalidate();
    this.apps.publish(app.id, kind === 'isolation' ? 'isolated' : 'shut_down');
    for (const incident of created) void this.runner.run(incident.id);
    return this.views(await this.repo.withItems(created));
  }

  /**
   * A shutdown is refused while the kill switch holds the app or one of the environments (409 APP_ISOLATED): stopping
   * and pausing members under the isolation would leave the release restoring a state the shutdown changed.
   */
  private async assertNotIsolated(appName: string, envs: readonly AppEnvironmentRow[], wholeApp: boolean) {
    const isolated: AppEnvironmentRow[] = [];
    for (const env of envs) {
      if (await this.repo.openFor(env.id, 'isolation', FROZEN_INCIDENT_STATES)) isolated.push(env);
    }
    if (isolated.length === 0) return;
    const subject =
      wholeApp && isolated.length === envs.length
        ? appName
        : `${appName} · ${isolated.map((env) => env.name).join(', ')}`;
    throw new AppError(
      409,
      'APP_ISOLATED',
      `${subject} is isolated by the app kill switch; turn the kill switch off before shutting it down`,
      { environmentIds: isolated.map((env) => env.id) }
    );
  }

  private async end(
    actor: AppActor,
    appIdOrSlug: string,
    environmentIds: readonly string[] | null,
    kind: AppIncidentKind
  ): Promise<IncidentView[]> {
    const { app, envs } = await this.scope(actor, appIdOrSlug, environmentIds);
    const open = await this.repo.open({ appId: app.id, environmentIds: envs.map((env) => env.id), kind });
    if (open.length === 0) {
      throw new AppError(
        409,
        'APP_INCIDENT_NOT_ACTIVE',
        kind === 'isolation' ? `${app.name} is not isolated` : `${app.name} is not shut down`
      );
    }
    const releasing: AppIncident[] = [];
    for (const incident of open) {
      if (incident.state === 'releasing') {
        releasing.push(incident);
        continue;
      }
      const updated = await this.repo.setState(incident.id, 'releasing', { releasedById: actor.userId });
      if (!updated) continue;
      releasing.push(updated);
      const env = envs.find((item) => item.id === incident.environmentId);
      const items = await this.repo.items(incident.id);
      await this.auditService.log({
        userId: actor.userId,
        action: kind === 'isolation' ? 'app.isolation.end' : 'app.start',
        resourceType: 'app_environment',
        resourceId: incident.environmentId,
        details: {
          appId: app.id,
          appName: app.name,
          environmentName: env?.name ?? null,
          incidentId: incident.id,
          items: items.length,
          failedItems: items.filter((item) => item.status === 'failed').length,
        },
      });
    }
    this.apps.publish(app.id, kind === 'isolation' ? 'isolation_releasing' : 'starting');
    for (const incident of releasing) void this.runner.run(incident.id);
    return this.views(await this.repo.withItems(releasing));
  }

  /** Incidents of an app the caller can see (open first, then recent ones). */
  async list(scopes: readonly string[], appIdOrSlug: string): Promise<IncidentView[]> {
    const { app, envs } = await this.apps.resolveVisible(scopes, appIdOrSlug);
    const visible = new Set(
      visibleEnvironmentIds(
        scopes,
        app.id,
        envs.map((env) => env.id)
      )
    );
    const incidents = (await this.repo.listForApp(app.id)).filter((incident) => visible.has(incident.environmentId));
    return this.views(incidents);
  }

  /** Open incidents per environment (env detail) and the app's incident state (list). */
  async summaries(environmentIds: readonly string[]): Promise<Map<string, IncidentView[]>> {
    const result = new Map<string, IncidentView[]>(environmentIds.map((id) => [id, []]));
    if (environmentIds.length === 0) return result;
    const open = await this.repo.withItems(await this.repo.open({ environmentIds }));
    for (const view of await this.views(open)) result.get(view.environmentId)?.push(view);
    return result;
  }

  async views(incidents: IncidentWithItems[]): Promise<IncidentView[]> {
    const userIds = [
      ...new Set(
        incidents
          .flatMap((incident) => [incident.startedById, incident.releasedById])
          .filter((id): id is string => !!id)
      ),
    ];
    const names = userIds.length
      ? new Map(
          (await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))).map(
            (row) => [row.id, row.name]
          )
        )
      : new Map<string, string | null>();
    const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);
    return incidents.map((incident) => {
      const count = (status: string) => incident.items.filter((item) => item.status === status).length;
      return {
        id: incident.id,
        batchId: incident.batchId,
        environmentId: incident.environmentId,
        kind: incident.kind,
        state: incident.state,
        startedAt: incident.startedAt,
        startedBy: person(incident.startedById),
        releasedAt: incident.releasedAt,
        releasedBy: person(incident.releasedById),
        lastError: incident.lastError,
        counts: {
          total: incident.items.length,
          pending: count('pending'),
          applied: count('applied'),
          failed: count('failed'),
          restored: count('restored'),
          restoreFailed: count('restore_failed'),
          gone: count('gone'),
        },
        items: incident.items.map((item) => ({
          id: item.id,
          kind: item.itemKind,
          label: itemLabel(item),
          status: item.status,
          attempts: item.attempts,
          ...itemNotes(item),
        })),
        skipped: incident.items
          .filter((item) => item.status === 'gone')
          .map((item) => ({ id: item.id, kind: item.itemKind, label: itemLabel(item), detail: item.lastError })),
      };
    });
  }

  /**
   * The audit entry of a finished Start or kill switch release (the runner's `released` hook): what came back and
   * what was skipped because it is gone (deleted while the app was shut down, for one), by name.
   */
  async recordReleased(incident: AppIncident): Promise<void> {
    const items = await this.repo.items(incident.id);
    const [names] = await this.db
      .select({ appName: apps.name, environmentName: appEnvironments.name })
      .from(appEnvironments)
      .innerJoin(apps, eq(apps.id, appEnvironments.appId))
      .where(eq(appEnvironments.id, incident.environmentId))
      .limit(1);
    const skipped = items
      .filter((item) => item.status === 'gone')
      .map((item) => ({ kind: item.itemKind, label: itemLabel(item), detail: item.lastError }));
    await this.auditService.log({
      userId: incident.releasedById,
      action: incident.kind === 'isolation' ? 'app.isolation.end.completed' : 'app.start.completed',
      resourceType: 'app_environment',
      resourceId: incident.environmentId,
      details: {
        appId: incident.appId,
        appName: names?.appName ?? null,
        environmentName: names?.environmentName ?? null,
        incidentId: incident.id,
        restored: items.filter((item) => item.status === 'restored').length,
        skipped,
      },
    });
  }

  /**
   * Delete guard for apps and environments (decision 5): kept while a shutdown is open too. The incident belongs to the
   * environment, and deleting it would leave its members stopped with no Start. Members themselves take every change
   * while shut down.
   */
  async assertNoActiveIncident(appId: string, environmentId?: string): Promise<void> {
    const open = await this.repo.open({ appId, environmentIds: environmentId ? [environmentId] : undefined });
    if (open.length > 0) {
      throw new AppError(
        409,
        'APP_INCIDENT_ACTIVE',
        'Turn off the shutdown or kill switch of this app before deleting it or its environments'
      );
    }
  }

  /** Whether an environment has an open incident (of a kind): the kill switch refuses membership moves then. */
  async environmentHasIncident(environmentId: string, kind?: AppIncidentKind): Promise<boolean> {
    return (await this.repo.open({ environmentIds: [environmentId], kind })).length > 0;
  }
}
