import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { container } from '@/container.js';
import { proxyHostFolders, proxyHosts } from '@/db/schema/index.js';
import { buildWhere, escapeLike } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { type AppMemberRef, AppMembershipService, appMemberFolderCondition } from '@/modules/apps/app-membership.js';
import { proxyHostsServedByNode } from '@/modules/ingress-groups/ingress-nodes.js';
import type { PaginatedResponse } from '@/types.js';
import { type AppMaintenanceMode, effectiveMaintenance } from './effective-maintenance.js';
import type { ProxyHostListQuery } from './proxy.schemas.js';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';

export { __testOnly } from './proxy.service-helpers.js';

import { logger, type ProxyHostRow, type ProxyHostView } from './proxy.service.core.js';
import { ProxyServiceSecureLinks } from './proxy.service.secure-links.js';
import {
  assertNoProxyDomainOverlapOnNodes,
  restoringProxyHostState,
  rethrowProxyHostDomainConflict,
} from './proxy-domain-overlap.js';
import { proxyNodeLockKey, withProxyHostLock, withProxyLocks } from './proxy-host-lock.js';

export abstract class ProxyServiceListing extends ProxyServiceSecureLinks {
  /** `app` ({id, slug, name, environmentId, environmentName} or null) on each route. */
  async withAppField<T extends { folderId?: string | null }>(
    hosts: T[]
  ): Promise<Array<T & { app: AppMemberRef | null }>> {
    if (!container.isRegistered(AppMembershipService)) return hosts.map((host) => ({ ...host, app: null }));
    return container.resolve(AppMembershipService).annotate('routes', hosts, (host) => host.folderId);
  }

  async listProxyHosts(
    query: ProxyHostListQuery,
    options?: { allowedIds?: string[] }
  ): Promise<PaginatedResponse<ProxyHostView>> {
    const conditions = [eq(proxyHosts.isSystem, false)];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
        };
      }
      conditions.push(inArray(proxyHosts.id, options.allowedIds));
    }

    if (query.type) {
      conditions.push(eq(proxyHosts.type, query.type));
    }
    if (query.enabled !== undefined) {
      conditions.push(eq(proxyHosts.enabled, query.enabled));
    }
    if (query.healthStatus) {
      conditions.push(
        query.healthStatus === 'disabled'
          ? or(eq(proxyHosts.healthStatus, 'disabled'), eq(proxyHosts.rawConfigEnabled, true))!
          : and(eq(proxyHosts.healthStatus, query.healthStatus), eq(proxyHosts.rawConfigEnabled, false))!
      );
    }
    if (query.search) {
      // Search across domain names (cast jsonb to text for ilike)
      conditions.push(ilike(sql`${proxyHosts.domainNames}::text`, `%${escapeLike(query.search)}%`));
    }
    if (query.nodeId) {
      // Routes the node serves, including the routes of its ingress groups.
      conditions.push(proxyHostsServedByNode(this.db, query.nodeId));
    }
    if (query.ingressGroupId) {
      conditions.push(eq(proxyHosts.ingressGroupId, query.ingressGroupId));
    }
    const appFilter = appMemberFolderCondition(proxyHosts.folderId, proxyHostFolders, {
      excludeAppMembers: query.excludeAppMembers,
      appId: query.appId,
    });
    if (appFilter) conditions.push(appFilter);

    const where = buildWhere(conditions);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db.query.proxyHosts.findMany({
        where: where ? () => where : undefined,
        orderBy: [desc(proxyHosts.createdAt)],
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
      }),
      this.db.select({ count: count() }).from(proxyHosts).where(where),
    ]);

    const total = Number(totalCount);

    const displayEntries = await this.withAppField(await attachDockerUpstreamDisplay(this.db, entries));
    return {
      data: displayEntries.map(({ healthHistory, rawConfig: _rc, ...rest }) => {
        let effectiveStatus = rest.rawConfigEnabled ? 'disabled' : (rest.healthStatus as string);
        if (
          !rest.rawConfigEnabled &&
          rest.healthStatus === 'online' &&
          Array.isArray(healthHistory) &&
          healthHistory.length > 0
        ) {
          const fiveMinAgo = Date.now() - 5 * 60 * 1000;
          const recent = (healthHistory as Array<{ ts?: string; status: string }>).filter((h) => {
            if (!h.ts) return false;
            return new Date(h.ts).getTime() >= fiveMinAgo;
          });
          if (recent.some((h) => h.status === 'offline' || h.status === 'degraded')) {
            effectiveStatus = 'recovering';
          }
        }
        return { ...rest, effectiveHealthStatus: effectiveStatus };
      }) as any,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Toggle enabled/disabled
  // -----------------------------------------------------------------------

  async toggleProxyHost(id: string, enabled: boolean, userId: string) {
    return withProxyHostLock(id, () => this.toggleProxyHostLocked(id, enabled, userId));
  }

  private async toggleProxyHostLocked(id: string, enabled: boolean, userId: string) {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (existing.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be toggled');
    if (!enabled && (await this.isGatewayPublicRoute(existing))) {
      throw new AppError(
        409,
        'GATEWAY_PUBLIC_ROUTE_PROTECTED',
        'The route serving the Gateway public URL cannot be disabled'
      );
    }
    if (existing.enabled === enabled) return (await attachDockerUpstreamDisplay(this.db, [existing]))[0]!;

    // Enabling makes the host serve on its nodes again (every member of its ingress group): fence reconnect
    // cleanup and refuse a domain another enabled host on one of them already serves.
    const servingNodeIds = await this.ingressNodesOf(existing);
    if (enabled && servingNodeIds.length > 0) {
      return withProxyLocks(servingNodeIds.map(proxyNodeLockKey), async () => {
        await assertNoProxyDomainOverlapOnNodes(this.db, servingNodeIds, existing.domainNames, existing.id);
        return this.applyToggle(existing, enabled, userId);
      });
    }
    return this.applyToggle(existing, enabled, userId);
  }

  private async applyToggle(existing: ProxyHostRow, enabled: boolean, userId: string) {
    const id = existing.id;
    const previousEnabled = existing.enabled;
    const exitsMaintenance = !enabled && existing.maintenanceEnabled;

    const [updated] = await this.db
      .update(proxyHosts)
      .set({
        enabled,
        ...(exitsMaintenance
          ? {
              maintenanceEnabled: false,
              maintenanceStartedAt: null,
              healthStatus: existing.healthCheckEnabled ? ('unknown' as const) : existing.healthStatus,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, id))
      .returning()
      .catch((error) => rethrowProxyHostDomainConflict(this.db, error));

    try {
      if (enabled) {
        // Re-enable: generate config and apply on every serving node
        await this.deliverHost(updated);
      } else {
        // Disable: remove config and reload
        await this.withdrawHost(updated);
      }
    } catch (error) {
      // Rollback DB to previous enabled state
      logger.error('Failed to apply nginx config during toggle, rolling back DB', {
        hostId: id,
        error,
      });
      // nginx still serves the previous state: restore it even when another host took one of its names meanwhile
      // (recorded as a legacy conflict), and never let a failed rollback replace the apply error.
      try {
        await restoringProxyHostState(this.db, (tx) =>
          tx
            .update(proxyHosts)
            .set({
              enabled: previousEnabled,
              maintenanceEnabled: existing.maintenanceEnabled,
              maintenanceStartedAt: existing.maintenanceStartedAt,
              healthStatus: existing.healthStatus,
              updatedAt: existing.updatedAt,
            })
            .where(eq(proxyHosts.id, id))
        );
      } catch (rollbackError) {
        logger.error('Failed to roll back the proxy host after a toggle failed; it may not match nginx', {
          hostId: id,
          rollbackError,
        });
      }
      // A config the node rejected (422 NGINX_CONFIG_FAILED) and every other caller error already says what failed.
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: enabled ? 'proxy_host.enable' : 'proxy_host.disable',
      resourceType: 'proxy_host',
      resourceId: id,
    });

    logger.info('Toggled proxy host', { hostId: id, enabled });
    this.emitHost(id, 'updated', existing.domainNames?.[0]);
    if (exitsMaintenance) this.reconcileMaintenanceAlerts(id);

    // Fire-and-forget immediate health check when enabling
    if (enabled && updated.healthCheckEnabled) {
      this.runImmediateHealthCheck(id);
    }

    return (await attachDockerUpstreamDisplay(this.db, [updated]))[0]!;
  }

  /**
   * Apps set a route's maintenance overlay (environment switch, app override, phase 2 incidents). The route's own
   * switch is never touched; its nodes get the effective state like a toggle (a flag without reload where the node
   * keeps maintenance flags). A node that cannot be reached gets it with its next resync. Returns whether it changed.
   */
  async setAppMaintenanceMode(id: string, mode: AppMaintenanceMode): Promise<boolean> {
    return withProxyHostLock(id, async () => {
      const existing = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
      if (!existing || (existing.appMaintenanceMode ?? 'off') === mode) return false;
      const [updated] = await this.db
        .update(proxyHosts)
        .set({ appMaintenanceMode: mode, updatedAt: new Date() })
        .where(eq(proxyHosts.id, id))
        .returning();
      const effectiveChanged = effectiveMaintenance(existing) !== effectiveMaintenance(updated);
      if (updated.enabled && effectiveChanged) {
        try {
          await this.deliverHost(updated, {
            certOptions: { preserveLegacyOnUnsupported: true },
            apply: { reuseActiveBundle: true },
          });
        } catch (error) {
          logger.warn('App maintenance overlay not delivered now; the node gets it with its next resync', {
            hostId: id,
            mode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.emitHost(id, 'updated', existing.domainNames?.[0], { appMaintenanceMode: mode });
      if (effectiveChanged) this.reconcileMaintenanceAlerts(id);
      if (effectiveChanged && !effectiveMaintenance(updated) && updated.healthCheckEnabled) {
        this.runImmediateHealthCheck(id);
      }
      return true;
    });
  }

  /** Whether a route serves the Gateway public URL (it never joins an app maintenance overlay or an app). */
  async servesGatewayPublicUrl(host: Pick<ProxyHostRow, 'domainNames'>): Promise<boolean> {
    return this.isGatewayPublicRoute(host);
  }

  async toggleMaintenance(id: string, enabled: boolean, userId: string) {
    return withProxyHostLock(id, () => this.toggleMaintenanceLocked(id, enabled, userId));
  }

  private async toggleMaintenanceLocked(id: string, enabled: boolean, userId: string) {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (existing.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot enter maintenance');
    if (enabled && (await this.isGatewayPublicRoute(existing))) {
      throw new AppError(
        409,
        'GATEWAY_PUBLIC_ROUTE_PROTECTED',
        'The route serving the Gateway public URL cannot enter maintenance mode'
      );
    }
    if (existing.maintenanceEnabled === enabled) {
      return (await attachDockerUpstreamDisplay(this.db, [existing]))[0]!;
    }
    if (enabled) {
      if (!existing.enabled) {
        throw new AppError(409, 'MAINTENANCE_HOST_DISABLED', 'Enable the proxy host before entering maintenance');
      }
      if (existing.type !== 'proxy' || existing.rawConfigEnabled) {
        throw new AppError(
          409,
          'MAINTENANCE_UNSUPPORTED_HOST',
          'Maintenance is available only for managed proxy hosts without raw mode'
        );
      }
    }

    const [updated] = await this.db
      .update(proxyHosts)
      .set({
        maintenanceEnabled: enabled,
        maintenanceStartedAt: enabled ? new Date() : null,
        ...(!enabled && existing.healthCheckEnabled ? { healthStatus: 'unknown' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, id))
      .returning();

    try {
      if (updated.enabled) {
        // On a node that keeps maintenance flags the route's config is the same in and out of maintenance: the node
        // only switches the flag, without a reload, and an unchanged TLS bundle is not sent again.
        await this.deliverHost(updated, {
          certOptions: { preserveLegacyOnUnsupported: true },
          apply: { reuseActiveBundle: true },
        });
      }
    } catch (error) {
      logger.error('Failed to apply nginx config during maintenance transition, rolling back DB', {
        hostId: id,
        enabled,
        error,
      });
      await this.db
        .update(proxyHosts)
        .set({
          maintenanceEnabled: existing.maintenanceEnabled,
          maintenanceStartedAt: existing.maintenanceStartedAt,
          healthStatus: existing.healthStatus,
          updatedAt: existing.updatedAt,
        })
        .where(eq(proxyHosts.id, id));
      try {
        await this.restoreConfigOnNode(existing);
      } catch (rollbackError) {
        logger.error('Failed to restore nginx config after maintenance transition failure', {
          hostId: id,
          rollbackError,
        });
      }
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: enabled ? 'proxy_host.maintenance_enter' : 'proxy_host.maintenance_exit',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { domainNames: existing.domainNames },
    });
    logger.info('Toggled proxy host maintenance', { hostId: id, enabled });
    this.emitHost(id, 'updated', existing.domainNames?.[0], { maintenanceEnabled: enabled });
    this.reconcileMaintenanceAlerts(id);

    if (!enabled && updated.healthCheckEnabled) this.runImmediateHealthCheck(id);
    return (await attachDockerUpstreamDisplay(this.db, [updated]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Immediate single-host health check (fire-and-forget)
  // -----------------------------------------------------------------------
}
