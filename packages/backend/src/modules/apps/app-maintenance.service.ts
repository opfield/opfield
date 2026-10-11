import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { appEnvironments, apps, proxyHostFolders, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AppMaintenanceMode } from '@/modules/proxy/effective-maintenance.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { AppIncidentsRepo } from './app-incidents.repo.js';
import type { AppEnvironmentRow, AppMaintenanceHooks, AppRow } from './apps.service.js';

const logger = createChildLogger('AppMaintenance');

type RouteRow = {
  id: string;
  folderId: string | null;
  type: string;
  rawConfigEnabled: boolean;
  isSystem: boolean;
  maintenanceEnabled: boolean;
  appMaintenanceMode: string;
  domainNames: string[];
};

/** Maintenance state of an environment for its page: off, on, partial (some routes on their own) or overridden. */
export interface EnvironmentMaintenanceState {
  state: 'off' | 'on' | 'partial' | 'overridden';
  /** Routes the switch puts in maintenance (proxy routes without raw config). */
  routeCount: number;
  /** Of those, routes in maintenance on their own switch. */
  ownMaintenanceCount: number;
  /** Routes of the environment maintenance does not apply to (redirect, 404, raw). */
  notAffectedCount: number;
}

/** Only managed proxy routes without raw config can show the maintenance page (the rule of the route switch). */
export function routeTakesMaintenance(route: Pick<RouteRow, 'type' | 'rawConfigEnabled' | 'isSystem'>): boolean {
  return route.type === 'proxy' && !route.rawConfigEnabled && !route.isSystem;
}

/** The overlay a route of an environment gets: the app override and the environment switch put it in maintenance. */
export function overlayMode(
  route: Pick<RouteRow, 'type' | 'rawConfigEnabled' | 'isSystem'>,
  app: { maintenanceOverride: boolean } | null,
  env: { maintenanceEnabled: boolean } | null
): AppMaintenanceMode {
  if (!app || !routeTakesMaintenance(route)) return 'off';
  return app.maintenanceOverride || env?.maintenanceEnabled ? 'maintenance' : 'off';
}

/**
 * The overlay with incidents: an open kill switch locks a route down (maintenance page without team access), an open
 * shutdown puts it in maintenance; both only for routes that can show the page (others are withdrawn by the incident).
 */
export function withIncidentOverlay(
  route: Pick<RouteRow, 'type' | 'rawConfigEnabled' | 'isSystem'>,
  base: AppMaintenanceMode,
  incident: 'maintenance' | 'lockdown' | undefined
): AppMaintenanceMode {
  if (!incident || !routeTakesMaintenance(route)) return base;
  if (incident === 'lockdown') return 'lockdown';
  return base === 'off' ? 'maintenance' : base;
}

/**
 * The app maintenance overlay: environment switches and the app override never rewrite a route's own maintenance
 * switch. Each route gets a computed app_maintenance_mode; the proxy renders effective maintenance (own switch or
 * overlay), so turning an overlay off restores exactly what each route had. Recomputed on every switch, override,
 * membership change and route create in an environment.
 */
export class AppMaintenanceService implements AppMaintenanceHooks {
  private incidents?: AppIncidentsRepo;

  constructor(private readonly db: DrizzleClient) {}

  setIncidentsRepo(repo: AppIncidentsRepo) {
    this.incidents = repo;
  }

  private proxy(): ProxyService | null {
    return container.isRegistered(ProxyService) ? container.resolve(ProxyService) : null;
  }

  /** Recompute the overlay of every route of an app, plus routes that just left it. */
  async afterAppChange(appId: string, routeIds: readonly string[] = []): Promise<void> {
    await this.applyModes([...new Set([...(await this.memberRouteIds(appId)), ...routeIds])]);
  }

  async memberRouteIds(appId: string, environmentId?: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .innerJoin(proxyHostFolders, eq(proxyHostFolders.id, proxyHosts.folderId))
      .where(
        and(
          eq(proxyHostFolders.appId, appId),
          environmentId
            ? eq(proxyHostFolders.appEnvironmentId, environmentId)
            : isNotNull(proxyHostFolders.appEnvironmentId)
        )
      );
    return rows.map((row) => row.id);
  }

  /** Recompute and deliver the overlay of these routes (members or not: a route outside apps goes back to off). */
  async applyModes(routeIds: readonly string[]): Promise<void> {
    if (routeIds.length === 0) return;
    const routes = (await this.db
      .select({
        id: proxyHosts.id,
        folderId: proxyHosts.folderId,
        type: proxyHosts.type,
        rawConfigEnabled: proxyHosts.rawConfigEnabled,
        isSystem: proxyHosts.isSystem,
        maintenanceEnabled: proxyHosts.maintenanceEnabled,
        appMaintenanceMode: proxyHosts.appMaintenanceMode,
        domainNames: proxyHosts.domainNames,
      })
      .from(proxyHosts)
      .where(inArray(proxyHosts.id, [...routeIds]))) as RouteRow[];
    const folderIds = [...new Set(routes.map((route) => route.folderId).filter((id): id is string => !!id))];
    const folders = folderIds.length
      ? await this.db
          .select({
            id: proxyHostFolders.id,
            appId: proxyHostFolders.appId,
            environmentId: proxyHostFolders.appEnvironmentId,
          })
          .from(proxyHostFolders)
          .where(and(inArray(proxyHostFolders.id, folderIds), isNotNull(proxyHostFolders.appEnvironmentId)))
      : [];
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const appIds = [...new Set(folders.map((folder) => folder.appId!))];
    const envIds = [...new Set(folders.map((folder) => folder.environmentId!))];
    const appRows = appIds.length
      ? await this.db
          .select({ id: apps.id, maintenanceOverride: apps.maintenanceOverride })
          .from(apps)
          .where(inArray(apps.id, appIds))
      : [];
    const envRows = envIds.length
      ? await this.db
          .select({ id: appEnvironments.id, maintenanceEnabled: appEnvironments.maintenanceEnabled })
          .from(appEnvironments)
          .where(inArray(appEnvironments.id, envIds))
      : [];
    const appById = new Map(appRows.map((row) => [row.id, row]));
    const envById = new Map(envRows.map((row) => [row.id, row]));
    const incidentModes = (await this.incidents?.routeOverlays(routes.map((route) => route.id))) ?? new Map();
    const proxy = this.proxy();
    for (const route of routes) {
      const folder = route.folderId ? folderById.get(route.folderId) : undefined;
      let mode = withIncidentOverlay(
        route,
        overlayMode(
          route,
          folder ? (appById.get(folder.appId!) ?? null) : null,
          folder ? (envById.get(folder.environmentId!) ?? null) : null
        ),
        incidentModes.get(route.id)
      );
      // The route serving the Gateway public URL never enters maintenance.
      if (mode !== 'off' && proxy && (await proxy.servesGatewayPublicUrl(route))) mode = 'off';
      if ((route.appMaintenanceMode ?? 'off') === mode) continue;
      try {
        if (proxy) await proxy.setAppMaintenanceMode(route.id, mode);
        else await this.db.update(proxyHosts).set({ appMaintenanceMode: mode }).where(eq(proxyHosts.id, route.id));
      } catch (error) {
        logger.warn('Failed to apply the app maintenance overlay to a route', {
          routeId: route.id,
          mode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Startup repair: every route whose overlay is set (it may no longer belong to an app with maintenance) and every
   * route an incident holds an overlay on.
   */
  async repairStaleOverlays(): Promise<void> {
    const rows = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .where(ne(proxyHosts.appMaintenanceMode, 'off'));
    const held = (await this.incidents?.overlayRouteIds()) ?? [];
    await this.applyModes([...new Set([...rows.map((row) => row.id), ...held])]);
  }

  async environmentMaintenance(
    app: AppRow,
    environments: readonly AppEnvironmentRow[]
  ): Promise<Map<string, Record<string, unknown>>> {
    const result = new Map<string, Record<string, unknown>>();
    if (environments.length === 0) return result;
    const rows = await this.db
      .select({
        environmentId: proxyHostFolders.appEnvironmentId,
        type: proxyHosts.type,
        rawConfigEnabled: proxyHosts.rawConfigEnabled,
        isSystem: proxyHosts.isSystem,
        maintenanceEnabled: proxyHosts.maintenanceEnabled,
      })
      .from(proxyHosts)
      .innerJoin(proxyHostFolders, eq(proxyHostFolders.id, proxyHosts.folderId))
      .where(
        inArray(
          proxyHostFolders.appEnvironmentId,
          environments.map((env) => env.id)
        )
      );
    for (const env of environments) {
      const routes = rows.filter((row) => row.environmentId === env.id);
      const eligible = routes.filter(routeTakesMaintenance);
      const own = eligible.filter((route) => route.maintenanceEnabled).length;
      const state: EnvironmentMaintenanceState = {
        state: app.maintenanceOverride ? 'overridden' : env.maintenanceEnabled ? 'on' : own > 0 ? 'partial' : 'off',
        routeCount: eligible.length,
        ownMaintenanceCount: own,
        notAffectedCount: routes.length - eligible.length,
      };
      result.set(env.id, { ...state });
    }
    return result;
  }
}
