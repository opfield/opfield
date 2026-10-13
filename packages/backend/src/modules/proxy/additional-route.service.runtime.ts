import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  pageDeployments,
  pageProjects,
  pageTags,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveIngressNodes } from '@/modules/ingress-groups/ingress-nodes.js';
import type { PageNodeRuntimeService } from '@/modules/pages/runtime/page-node-runtime.service.js';
import { PageNodesRuntime } from '@/modules/pages/runtime/page-nodes-runtime.js';
import type {
  PageRuntimeConfigPublicationRequest,
  PageRuntimeConfigService,
} from '@/modules/pages/runtime-config/page-runtime-config.service.js';
import type { PageTagActivationRequest } from '@/modules/pages/tags/page-tag.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { ProxyAdditionalRouteConfig } from '@/services/nginx-config-generator.service.js';
import {
  type AdditionalRouteNodeMigration,
  type AdditionalRouteRow,
  type AdditionalRuntimeConfigProgress,
  type Input,
  isDockerKind,
  logger,
  type NormalizedTarget,
  type ProxyHostRow,
  type ProxyHostRuntimeAdapter,
} from './additional-route.service.shared.js';
import type { ProxyDockerUpstreamService } from './proxy-docker-upstream.service.js';
import { withProxyHostLock } from './proxy-host-lock.js';
import type { CreateProxyAdditionalSecureLinkInput, ProxySecureLinkService } from './proxy-secure-link.service.js';

export abstract class AdditionalRouteServiceRuntime {
  protected eventBus?: EventBusService;
  protected hostRuntime?: ProxyHostRuntimeAdapter;
  protected pageRuntime?: PageNodeRuntimeService;
  protected pageRuntimeConfig?: PageRuntimeConfigService;

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly auditService: AuditService,
    protected readonly dockerUpstreams?: ProxyDockerUpstreamService,
    protected readonly secureLinks?: ProxySecureLinkService
  ) {}

  protected abstract requireHost(hostId: string): Promise<ProxyHostRow>;

  protected abstract normalizeTarget(input: Input, existing?: AdditionalRouteRow): NormalizedTarget;

  protected abstract asSecureLinkInput(target: NormalizedTarget): CreateProxyAdditionalSecureLinkInput;

  protected abstract commitNodeMigration(migration: AdditionalRouteNodeMigration): Promise<void>;

  protected abstract rollbackNodeMigration(migration: AdditionalRouteNodeMigration): Promise<void>;

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
    eventBus.subscribe('pages.tag.changed', (payload) => {
      const event = payload as { tagId?: string; action?: string };
      if (event.tagId && event.action && /publish|activated|moved|ready/i.test(event.action)) {
        void this.reconcileByTag(event.tagId).catch((error) =>
          logger.warn('Additional Pages routes reconcile failed', { error })
        );
      }
    });
    eventBus.subscribe('pages.config.changed', (payload) => {
      const event = payload as { projectId?: string; tagId?: string | null };
      if (event.projectId) {
        void this.reconcileByProject(event.projectId, event.tagId).catch((error) =>
          logger.warn('Additional Pages runtime-config reconcile failed', { error })
        );
      }
    });
  }

  setHostRuntime(adapter: ProxyHostRuntimeAdapter): void {
    this.hostRuntime = adapter;
  }

  setPageRuntime(runtime: PageNodeRuntimeService, runtimeConfig: PageRuntimeConfigService): void {
    this.pageRuntime = runtime;
    this.pageRuntimeConfig = runtimeConfig;
  }

  /**
   * Pages bindings of a host's Additional Routes on every node that serves the host: its node, or each member of
   * its ingress group (see PageNodesRuntime).
   */
  protected pagesNodes(): PageNodesRuntime {
    if (!this.pageRuntime) throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route runtime is unavailable');
    return new PageNodesRuntime(this.pageRuntime);
  }

  protected async pagesNodeIds(
    target: { nodeId: string | null; ingressGroupId?: string | null } | string | readonly string[] | null
  ): Promise<string[]> {
    if (target === null) return [];
    if (typeof target === 'string') return [target];
    if (Array.isArray(target)) return [...target];
    const host = target as { nodeId: string | null; ingressGroupId?: string | null };
    return resolveIngressNodes(this.db, { nodeId: host.nodeId, ingressGroupId: host.ingressGroupId ?? null });
  }

  /**
   * Pages Additional Routes of a host whose serving nodes changed: nodes that start serving the host (a member that
   * joined or reconnected, a route moved onto an ingress group) get each ready Route's Deployment and runtime config
   * at its current generation; connected nodes that stop serving it lose the bindings (an offline one loses them
   * once it reconnects, through the Pages Route reconciliation).
   */
  async syncServingNodes(host: ProxyHostRow, addedNodeIds: string[], removedNodeIds: string[]): Promise<void> {
    if (!this.pageRuntime || !this.pageRuntimeConfig) return;
    const nodes = this.pagesNodes();
    const added = addedNodeIds.filter((nodeId) => this.pageRuntime!.isNodeConnected(nodeId));
    const removed = removedNodeIds.filter((nodeId) => this.pageRuntime!.isNodeConnected(nodeId));
    if (added.length === 0 && removed.length === 0) return;
    await this.withHostLock(host.id, async () => {
      const routes = await this.db.query.proxyAdditionalRoutes.findMany({
        where: and(eq(proxyAdditionalRoutes.proxyHostId, host.id), eq(proxyAdditionalRoutes.targetKind, 'pages')),
      });
      for (const route of routes) {
        for (const nodeId of removed) {
          const cleanupError = await nodes.cleanup([nodeId], route.id);
          if (cleanupError) throw cleanupError;
        }
        if (route.status !== 'ready' || !route.activeDeploymentId || !route.pageProjectId || !route.pageTagId) continue;
        const effective = await this.pageRuntimeConfig!.getEffective(route.pageProjectId, route.pageTagId);
        for (const nodeId of added) {
          if (route.runtimeConfigGeneration > 0) {
            await nodes.publishRuntimeConfig([nodeId], route.id, route.runtimeConfigGeneration, effective.value);
          }
          const includePath = await nodes.activateRoute([nodeId], route.id, route.activeDeploymentId);
          if (route.includePath && includePath !== route.includePath) {
            throw new AppError(
              502,
              'PAGES_ROUTE_INCLUDE_PATH_MISMATCH',
              'A new ingress node reports a different Pages include path; update its nginx daemon to the same release'
            );
          }
        }
      }
    });
  }

  /**
   * Shares ProxyService's reentrant per-host lock. A separate lock would invert
   * with it: a route change holds this lock while re-rendering the host, and a
   * host update holds the proxy lock while staging route migrations.
   */
  protected async withHostLock<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    return withProxyHostLock(hostId, work);
  }

  async getRenderConfig(hostId: string): Promise<ProxyAdditionalRouteConfig[]> {
    const rows = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(
        eq(proxyAdditionalRoutes.proxyHostId, hostId),
        eq(proxyAdditionalRoutes.enabled, true),
        inArray(proxyAdditionalRoutes.status, ['ready', 'staging'])
      ),
      orderBy: (route, { asc }) => [asc(route.path)],
    });
    const configs: ProxyAdditionalRouteConfig[] = [];
    for (const row of rows) {
      if (row.status !== 'ready' && !row.migrationTargetNodeId) continue;
      if (isDockerKind(row.targetKind)) {
        const binding = row.secureLinkId
          ? await this.db.query.proxyAdditionalSecureLinks.findFirst({
              where: and(
                eq(proxyAdditionalSecureLinks.id, row.secureLinkId),
                eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
                eq(proxyAdditionalSecureLinks.status, 'active')
              ),
            })
          : await this.secureLinks?.getManagedRoute(row.id);
        if (!binding) continue;
        const availabilityMembers = this.secureLinks?.getActiveAvailabilityMembers
          ? await this.secureLinks.getActiveAvailabilityMembers(hostId, `additional-route:${row.id}`)
          : [];
        configs.push({
          id: row.id,
          path: row.path,
          targetKind: row.targetKind,
          forwardScheme: row.forwardScheme,
          forwardHost: '127.0.0.1',
          forwardPort: binding.listenerPort ?? 1,
          secureLinkUpstream: true,
          secureLinkSocketPath: `/run/opfield-secure-links/${binding.id}.sock`,
          secureLinkSocketPaths:
            availabilityMembers.length > 0
              ? availabilityMembers.map((member) => `/run/opfield-secure-links/${member.id}.sock`)
              : undefined,
          stripPrefix: row.stripPrefix,
          websocketSupport: row.websocketSupport,
          requestBuffering: row.requestBuffering,
          responseBuffering: row.responseBuffering,
          connectTimeoutSeconds: row.connectTimeoutSeconds,
          readTimeoutSeconds: row.readTimeoutSeconds,
          sendTimeoutSeconds: row.sendTimeoutSeconds,
          advancedConfig: row.advancedConfig,
        });
      } else if (row.targetKind === 'pages') {
        if (!row.includePath || !row.runtimeConfigPath || !row.activeDeploymentId) continue;
        const project = row.pageProjectId
          ? await this.db.query.pageProjects.findFirst({ where: eq(pageProjects.id, row.pageProjectId) })
          : null;
        configs.push({
          id: row.id,
          path: row.path,
          targetKind: row.targetKind,
          forwardScheme: row.forwardScheme,
          forwardHost: null,
          forwardPort: null,
          pagesRouteIncludePath: row.includePath,
          pagesRuntimeConfigPath: row.runtimeConfigPath,
          pagesSpaFallback: project?.spaFallback ?? false,
          pagesFallbackUrl: project?.fallbackUrl ?? null,
          stripPrefix: true,
          websocketSupport: false,
          requestBuffering: false,
          responseBuffering: false,
          connectTimeoutSeconds: 60,
          readTimeoutSeconds: 60,
          sendTimeoutSeconds: 60,
          advancedConfig: row.advancedConfig,
        });
      } else {
        configs.push({
          id: row.id,
          path: row.path,
          targetKind: 'manual',
          forwardScheme: row.forwardScheme,
          forwardHost: row.forwardHost,
          forwardPort: row.forwardPort,
          stripPrefix: row.stripPrefix,
          websocketSupport: row.websocketSupport,
          requestBuffering: row.requestBuffering,
          responseBuffering: row.responseBuffering,
          connectTimeoutSeconds: row.connectTimeoutSeconds,
          readTimeoutSeconds: row.readTimeoutSeconds,
          sendTimeoutSeconds: row.sendTimeoutSeconds,
          advancedConfig: row.advancedConfig,
        });
      }
    }
    return configs.sort((left, right) => right.path.length - left.path.length || left.path.localeCompare(right.path));
  }

  async reconcile(): Promise<boolean> {
    const pending = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(
        inArray(proxyAdditionalRoutes.status, ['staging', 'provisioning', 'cleanup_pending']),
        isNull(proxyAdditionalRoutes.migrationTargetNodeId)
      ),
    });
    const migrations = await this.db.query.proxyAdditionalRoutes.findMany({
      where: isNotNull(proxyAdditionalRoutes.migrationTargetNodeId),
    });
    let retry = false;
    for (const route of migrations) {
      try {
        const host = await this.requireHost(route.proxyHostId);
        if (!route.migrationSourceNodeId || !route.migrationTargetNodeId) continue;
        const migration: AdditionalRouteNodeMigration = {
          hostId: route.proxyHostId,
          sourceNodeId: route.migrationSourceNodeId,
          targetNodeId: route.migrationTargetNodeId,
          routeIds: [route.id],
          generation: route.generation,
          routes: [
            {
              routeId: route.id,
              targetKind: route.targetKind,
              generation: route.generation,
              previousSecureLinkId: route.migrationPreviousSecureLinkId,
              stagedSecureLinkId: isDockerKind(route.targetKind) ? route.secureLinkId : null,
              previousIncludePath: route.migrationPreviousIncludePath,
              previousRuntimeConfigGeneration: route.migrationPreviousRuntimeConfigGeneration ?? 0,
            },
          ],
        };
        if (host.nodeId === route.migrationTargetNodeId) {
          await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
          await this.commitNodeMigration(migration);
        } else if (host.nodeId === route.migrationSourceNodeId) {
          await this.rollbackNodeMigration(migration);
        } else {
          throw new AppError(
            409,
            'ADDITIONAL_ROUTE_MIGRATION_NODE_CHANGED',
            'Additional Route host node changed during migration'
          );
        }
      } catch (error) {
        retry = true;
        logger.warn('Additional Route migration reconciliation is still pending', { routeId: route.id, error });
      }
    }
    for (const route of pending) {
      try {
        const host = await this.requireHost(route.proxyHostId);
        if (route.status === 'cleanup_pending') {
          if (isDockerKind(route.targetKind)) await this.secureLinks?.deleteManagedRoute(host, route.id);
          if (route.targetKind === 'pages') await this.cleanupPages(route, host);
          await this.db.delete(proxyAdditionalRoutes).where(eq(proxyAdditionalRoutes.id, route.id));
        } else {
          const target = this.normalizeTarget(route as unknown as Input, route);
          const provisioned = await this.provision(route, host, target);
          if (target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
          this.emit(provisioned, 'reconciled');
        }
      } catch (error) {
        retry = true;
        await this.markFailed(route.id, error, null);
      }
    }
    return retry;
  }

  async updateRenamedContainerReferences(nodeId: string, oldName: string, newName: string): Promise<void> {
    await this.db
      .update(proxyAdditionalRoutes)
      .set({ dockerContainerName: newName, updatedAt: new Date() })
      .where(
        and(
          eq(proxyAdditionalRoutes.targetKind, 'docker_container'),
          eq(proxyAdditionalRoutes.dockerNodeId, nodeId),
          eq(proxyAdditionalRoutes.dockerContainerName, oldName)
        )
      );
  }

  async reconcileDockerTargets(force = false): Promise<boolean> {
    if (!this.secureLinks) return false;
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(
        eq(proxyAdditionalRoutes.enabled, true),
        eq(proxyAdditionalRoutes.status, 'ready'),
        inArray(proxyAdditionalRoutes.targetKind, ['docker_container', 'docker_deployment']),
        isNull(proxyAdditionalRoutes.migrationTargetNodeId)
      ),
    });
    let retry = false;
    for (const route of routes) {
      try {
        await this.withHostLock(route.proxyHostId, async () => {
          const current = await this.db.query.proxyAdditionalRoutes.findFirst({
            where: and(
              eq(proxyAdditionalRoutes.id, route.id),
              eq(proxyAdditionalRoutes.enabled, true),
              eq(proxyAdditionalRoutes.status, 'ready')
            ),
          });
          if (!current || !isDockerKind(current.targetKind)) return;
          const host = await this.requireHost(current.proxyHostId);
          const binding = await this.secureLinks!.getManagedRoute(current.id);
          if (!force && binding && binding.status !== 'active') return;
          const ready = await this.secureLinks!.createManagedRoute(
            host,
            current.id,
            this.asSecureLinkInput(this.normalizeTarget(current as unknown as Input, current))
          );
          if (ready.status !== 'active') throw new Error(ready.lastError ?? 'Secure Link reconciliation failed');
          const routeBindingChanged = current.secureLinkId !== ready.id;
          const containerChanged =
            Boolean(current.dockerComposeProjectId) &&
            Boolean(ready.dockerContainerName) &&
            current.dockerContainerName !== ready.dockerContainerName;
          if (routeBindingChanged || containerChanged) {
            const [updated] = await this.db
              .update(proxyAdditionalRoutes)
              .set({
                secureLinkId: ready.id,
                ...(ready.dockerContainerName ? { dockerContainerName: ready.dockerContainerName } : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(proxyAdditionalRoutes.id, current.id),
                  eq(proxyAdditionalRoutes.generation, current.generation),
                  eq(proxyAdditionalRoutes.status, 'ready')
                )
              )
              .returning({ id: proxyAdditionalRoutes.id });
            if (!updated) return;
            await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
          }

          const staleBindings = await this.db.query.proxyAdditionalSecureLinks.findMany({
            where: and(
              eq(proxyAdditionalSecureLinks.proxyHostId, host.id),
              eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
              eq(proxyAdditionalSecureLinks.referenceId, current.id),
              ne(proxyAdditionalSecureLinks.id, ready.id)
            ),
          });
          for (const stale of staleBindings) {
            await this.secureLinks!.deleteManagedRouteBinding(host, stale.id);
          }
        });
      } catch (error) {
        retry = true;
        logger.debug('Keeping last Additional Route Docker target until reconciliation succeeds', {
          routeId: route.id,
          error,
        });
      }
    }
    return retry;
  }

  async reconcileByTag(tagId: string): Promise<void> {
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(eq(proxyAdditionalRoutes.pageTagId, tagId), eq(proxyAdditionalRoutes.targetKind, 'pages')),
    });
    for (const route of routes) await this.reconcilePagesRoute(route);
  }

  async reconcileByProject(projectId: string, tagId?: string | null): Promise<void> {
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(eq(proxyAdditionalRoutes.pageProjectId, projectId), eq(proxyAdditionalRoutes.targetKind, 'pages')),
    });
    for (const route of routes) {
      if (tagId && route.pageTagId !== tagId) continue;
      await this.reconcilePagesRoute(route);
    }
  }

  /** PageTagPublicationAdapter boundary for route-owned Pages consumers. */
  async stageTagPublication(request: PageTagActivationRequest): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select({ route: proxyAdditionalRoutes, nodeId: proxyHosts.nodeId, ingressGroupId: proxyHosts.ingressGroupId })
      .from(proxyAdditionalRoutes)
      .innerJoin(proxyHosts, eq(proxyAdditionalRoutes.proxyHostId, proxyHosts.id))
      .where(and(eq(proxyAdditionalRoutes.pageTagId, request.tagId), eq(proxyAdditionalRoutes.targetKind, 'pages')));
    const progress: Array<Record<string, unknown>> = [];
    try {
      for (const row of rows.sort((left, right) => left.route.id.localeCompare(right.route.id))) {
        if (!row.nodeId || !this.pageRuntime || !this.pageRuntimeConfig || !row.route.pageProjectId) {
          throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Additional Pages Route has no runtime node');
        }
        const nodeIds = await this.pagesNodeIds(row);
        await this.withHostLock(row.route.proxyHostId, async () => {
          const [current] = await this.db
            .select()
            .from(proxyAdditionalRoutes)
            .where(eq(proxyAdditionalRoutes.id, row.route.id))
            .limit(1);
          if (!current || current.status !== 'ready' || !current.activeDeploymentId) return;
          const runtimeGeneration = current.runtimeConfigGeneration + 1;
          const effective = await this.pageRuntimeConfig!.getEffective(current.pageProjectId!, current.pageTagId!);
          try {
            const nodes = this.pagesNodes();
            const runtimeConfigPath = await nodes.publishRuntimeConfig(
              nodeIds,
              current.id,
              runtimeGeneration,
              effective.value
            );
            const includePath = await nodes.activateRoute(nodeIds, current.id, request.deploymentId);
            const [updated] = await this.db
              .update(proxyAdditionalRoutes)
              .set({
                activeDeploymentId: request.deploymentId,
                includePath,
                runtimeConfigPath,
                runtimeConfigGeneration: runtimeGeneration,
                generation: current.generation + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(proxyAdditionalRoutes.id, current.id),
                  eq(proxyAdditionalRoutes.generation, current.generation),
                  eq(proxyAdditionalRoutes.status, 'ready'),
                  eq(proxyAdditionalRoutes.activeDeploymentId, current.activeDeploymentId)
                )
              )
              .returning({ generation: proxyAdditionalRoutes.generation });
            if (!updated)
              throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route changed during publication');
            await this.hostRuntime?.reconcileAdditionalRouteHost(current.proxyHostId);
            progress.push({
              routeId: current.id,
              hostId: current.proxyHostId,
              nodeId: row.nodeId,
              nodeIds,
              fromDeploymentId: current.activeDeploymentId,
              fromIncludePath: current.includePath,
              toDeploymentId: request.deploymentId,
              fromRuntimeConfigGeneration: current.runtimeConfigGeneration,
              toRuntimeConfigGeneration: runtimeGeneration,
              generation: updated.generation,
            });
          } catch (error) {
            try {
              await this.restorePagesMaterialization(
                nodeIds,
                current.id,
                current.activeDeploymentId,
                current.runtimeConfigGeneration
              );
              await this.restorePagesRouteRow(current, request.deploymentId);
              await this.hostRuntime?.reconcileAdditionalRouteHost(current.proxyHostId);
            } catch (rollbackError) {
              await this.db
                .update(proxyAdditionalRoutes)
                .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_ROUTE_ROLLBACK_FAILED', updatedAt: new Date() })
                .where(eq(proxyAdditionalRoutes.id, current.id));
              throw new AggregateError([error, rollbackError], 'Additional Pages Route rollback failed');
            }
            throw error;
          }
        });
      }
      return { routes: progress };
    } catch (error) {
      await this.rollbackTagPublicationProgress(progress);
      throw error;
    }
  }

  async rollbackTagPublication(_request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void> {
    await this.rollbackTagPublicationProgress(
      (Array.isArray(progress.routes) ? progress.routes : []) as Array<Record<string, unknown>>
    );
  }

  protected async rollbackTagPublicationProgress(progress: Array<Record<string, unknown>>): Promise<void> {
    for (const item of [...progress].reverse()) {
      const routeId = String(item.routeId ?? '');
      const hostId = String(item.hostId ?? '');
      const nodeId = String(item.nodeId ?? '');
      const nodeIds = Array.isArray(item.nodeIds) ? item.nodeIds.map(String) : nodeId ? [nodeId] : [];
      const fromDeploymentId = typeof item.fromDeploymentId === 'string' ? item.fromDeploymentId : null;
      const fromIncludePath = typeof item.fromIncludePath === 'string' ? item.fromIncludePath : null;
      const fromGeneration = Number(item.fromRuntimeConfigGeneration ?? 0);
      if (!routeId || !hostId || nodeIds.length === 0 || !this.pageRuntime) continue;
      try {
        await this.pagesNodes().restoreMaterialization(nodeIds, routeId, fromDeploymentId, fromGeneration);
        await this.db
          .update(proxyAdditionalRoutes)
          .set({
            activeDeploymentId: fromDeploymentId,
            includePath: fromIncludePath,
            runtimeConfigGeneration: fromGeneration,
            generation: Number(item.generation ?? 0) + 1,
            status: 'ready',
            updatedAt: new Date(),
          })
          .where(and(eq(proxyAdditionalRoutes.id, routeId), eq(proxyAdditionalRoutes.proxyHostId, hostId)));
        await this.hostRuntime?.reconcileAdditionalRouteHost(hostId);
      } catch (error) {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_ROUTE_ROLLBACK_FAILED', updatedAt: new Date() })
          .where(eq(proxyAdditionalRoutes.id, routeId));
        logger.error('Additional Pages Route rollback failed', { routeId, error });
      }
    }
  }

  async publishRuntimeConfig(request: PageRuntimeConfigPublicationRequest): Promise<Record<string, unknown>> {
    if (!this.pageRuntime) return {};
    const rows = await this.db
      .select({ route: proxyAdditionalRoutes, nodeId: proxyHosts.nodeId, ingressGroupId: proxyHosts.ingressGroupId })
      .from(proxyAdditionalRoutes)
      .innerJoin(proxyHosts, eq(proxyAdditionalRoutes.proxyHostId, proxyHosts.id))
      .where(
        and(
          eq(proxyAdditionalRoutes.targetKind, 'pages'),
          request.tagId
            ? eq(proxyAdditionalRoutes.pageTagId, request.tagId)
            : eq(proxyAdditionalRoutes.pageProjectId, request.projectId),
          eq(proxyAdditionalRoutes.status, 'ready')
        )
      );
    const applied: AdditionalRuntimeConfigProgress[] = [];
    try {
      for (const row of rows) {
        if (!row.nodeId)
          throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Additional Pages Route has no runtime node');
        const current = row.route;
        if (request.tagId === null) {
          const effective = await this.pageRuntimeConfig?.getEffective(current.pageProjectId!, current.pageTagId!);
          if (effective?.tagId !== null) continue;
        }
        const from = current.runtimeConfigGeneration;
        const to = from + 1;
        const nodeIds = await this.pagesNodeIds(row);
        const progress: AdditionalRuntimeConfigProgress = {
          routeId: current.id,
          hostId: current.proxyHostId,
          nodeId: row.nodeId,
          nodeIds,
          from,
          to,
          fromRouteGeneration: current.generation,
          toRouteGeneration: current.generation + 1,
        };
        try {
          const runtimeConfigPath = await this.pagesNodes().publishRuntimeConfig(
            nodeIds,
            current.id,
            to,
            request.value
          );
          const [updated] = await this.db
            .update(proxyAdditionalRoutes)
            .set({
              runtimeConfigPath,
              runtimeConfigGeneration: to,
              generation: current.generation + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(proxyAdditionalRoutes.id, current.id),
                eq(proxyAdditionalRoutes.generation, current.generation),
                eq(proxyAdditionalRoutes.status, 'ready')
              )
            )
            .returning({ id: proxyAdditionalRoutes.id });
          if (!updated)
            throw new AppError(
              409,
              'ADDITIONAL_ROUTE_CHANGED',
              'Additional Pages Route changed during runtime publication'
            );
          await this.hostRuntime?.reconcileAdditionalRouteHost(current.proxyHostId);
          applied.push(progress);
        } catch (error) {
          try {
            await this.restoreRuntimeConfigProgressItem(progress);
          } catch (rollbackError) {
            await this.db
              .update(proxyAdditionalRoutes)
              .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_RUNTIME_ROLLBACK_FAILED', updatedAt: new Date() })
              .where(eq(proxyAdditionalRoutes.id, current.id));
            throw new AggregateError([error, rollbackError], 'Additional Pages runtime-config rollback failed');
          }
          throw error;
        }
      }
      return { routes: applied };
    } catch (error) {
      await this.rollbackRuntimeConfigProgress(applied);
      throw error;
    }
  }

  async rollbackRuntimeConfig(
    _request: PageRuntimeConfigPublicationRequest,
    progress: Record<string, unknown>
  ): Promise<void> {
    await this.rollbackRuntimeConfigProgress(
      (Array.isArray(progress.routes) ? progress.routes : []) as AdditionalRuntimeConfigProgress[]
    );
  }

  protected async rollbackRuntimeConfigProgress(applied: AdditionalRuntimeConfigProgress[]): Promise<void> {
    if (!this.pageRuntime) return;
    for (const item of [...applied].reverse()) {
      try {
        await this.restoreRuntimeConfigProgressItem(item);
      } catch {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_RUNTIME_ROLLBACK_FAILED', updatedAt: new Date() })
          .where(eq(proxyAdditionalRoutes.id, item.routeId));
      }
    }
  }

  protected async restoreRuntimeConfigProgressItem(item: AdditionalRuntimeConfigProgress): Promise<void> {
    if (!this.pageRuntime) return;
    await this.pagesNodes().restoreRuntimeConfig(item.nodeIds ?? [item.nodeId], item.routeId, item.from);

    const [current] = await this.db
      .select()
      .from(proxyAdditionalRoutes)
      .where(eq(proxyAdditionalRoutes.id, item.routeId))
      .limit(1);
    if (
      !current ||
      (current.generation === item.fromRouteGeneration && current.runtimeConfigGeneration === item.from)
    ) {
      return;
    }
    if (
      current.generation !== item.toRouteGeneration ||
      current.runtimeConfigGeneration !== item.to ||
      current.status !== 'ready'
    ) {
      throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route changed during rollback');
    }
    const [restored] = await this.db
      .update(proxyAdditionalRoutes)
      .set({ runtimeConfigGeneration: item.from, generation: current.generation + 1, updatedAt: new Date() })
      .where(
        and(
          eq(proxyAdditionalRoutes.id, item.routeId),
          eq(proxyAdditionalRoutes.generation, item.toRouteGeneration),
          eq(proxyAdditionalRoutes.runtimeConfigGeneration, item.to),
          eq(proxyAdditionalRoutes.status, 'ready')
        )
      )
      .returning({ id: proxyAdditionalRoutes.id });
    if (!restored) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route rollback was lost');
    await this.hostRuntime?.reconcileAdditionalRouteHost(item.hostId);
  }

  protected async reconcilePagesRoute(route: AdditionalRouteRow): Promise<void> {
    if (!route.pageProjectId || !route.pageTagId || route.status !== 'ready') return;
    const host = await this.requireHost(route.proxyHostId);
    const target = this.normalizeTarget(route as unknown as Input, route);
    try {
      await this.withHostLock(route.proxyHostId, async () => {
        const deployment = await this.resolvePageDeployment(target.pageProjectId!, target.pageTagId!);
        if (deployment.id === route.activeDeploymentId) return;
        const [staged] = await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'staging', generation: route.generation + 1, updatedAt: new Date() })
          .where(
            and(
              eq(proxyAdditionalRoutes.id, route.id),
              eq(proxyAdditionalRoutes.generation, route.generation),
              eq(proxyAdditionalRoutes.status, 'ready')
            )
          )
          .returning();
        if (!staged) return;
        await this.publishAndActivatePages(staged, host, deployment.id);
      });
    } catch (error) {
      await this.markFailed(route.id, error, null);
    }
  }

  protected async provision(
    route: AdditionalRouteRow,
    host: ProxyHostRow,
    target: NormalizedTarget
  ): Promise<AdditionalRouteRow> {
    if (!route.enabled) return route;
    if (isDockerKind(target.targetKind)) {
      if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
      const binding = await this.secureLinks.createManagedRoute(host, route.id, this.asSecureLinkInput(target));
      if (binding.status !== 'active') {
        return (
          (await this.markFailed(route.id, new Error(binding.lastError ?? 'Secure Link provisioning failed'), null)) ??
          route
        );
      }
      const [ready] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          secureLinkId: binding.id,
          activeDeploymentId: null,
          includePath: null,
          runtimeConfigPath: null,
          runtimeConfigGeneration: 0,
          status: 'ready',
          lastError: null,
          generation: route.generation + 1,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalRoutes.id, route.id))
        .returning();
      return ready ?? route;
    }
    if (target.targetKind === 'pages') {
      const deployment = await this.resolvePageDeployment(target.pageProjectId!, target.pageTagId!);
      return this.publishAndActivatePages(route, host, deployment.id);
    }
    const [ready] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        secureLinkId: null,
        activeDeploymentId: null,
        includePath: null,
        runtimeConfigPath: null,
        runtimeConfigGeneration: 0,
        status: 'ready',
        lastError: null,
        generation: route.generation + 1,
        updatedAt: new Date(),
      })
      .where(eq(proxyAdditionalRoutes.id, route.id))
      .returning();
    return ready ?? route;
  }

  protected async publishAndActivatePages(
    route: AdditionalRouteRow,
    host: ProxyHostRow,
    deploymentId: string
  ): Promise<AdditionalRouteRow> {
    if (!host.nodeId || !this.pageRuntime || !this.pageRuntimeConfig || !route.pageProjectId || !route.pageTagId) {
      throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route runtime is unavailable');
    }
    const effective = await this.pageRuntimeConfig.getEffective(route.pageProjectId, route.pageTagId);
    const generation = route.runtimeConfigGeneration + 1;
    const nodeIds = await this.pagesNodeIds(host);
    try {
      const nodes = this.pagesNodes();
      const runtimeConfigPath = await nodes.publishRuntimeConfig(nodeIds, route.id, generation, effective.value);
      const includePath = await nodes.activateRoute(nodeIds, route.id, deploymentId);
      const [ready] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          secureLinkId: null,
          activeDeploymentId: deploymentId,
          includePath,
          runtimeConfigPath,
          runtimeConfigGeneration: generation,
          status: 'ready',
          lastError: null,
          generation: route.generation + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(proxyAdditionalRoutes.id, route.id), eq(proxyAdditionalRoutes.generation, route.generation)))
        .returning();
      if (!ready) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
      return ready;
    } catch (error) {
      try {
        await this.restorePagesMaterialization(
          nodeIds,
          route.id,
          route.activeDeploymentId,
          route.runtimeConfigGeneration
        );
        await this.restorePagesRouteRow(route, deploymentId);
        await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
      } catch (rollbackError) {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_ROUTE_ROLLBACK_FAILED', updatedAt: new Date() })
          .where(eq(proxyAdditionalRoutes.id, route.id));
        throw new AggregateError([error, rollbackError], 'Additional Pages Route rollback failed');
      }
      throw error;
    }
  }

  /** Removes the Route's Pages binding from its node, or from each connected member of the host's ingress group. */
  protected async cleanupPages(
    route: Pick<AdditionalRouteRow, 'id'>,
    target: { nodeId: string | null; ingressGroupId?: string | null } | string | null
  ): Promise<void> {
    if (!this.pageRuntime) return;
    const nodeIds = await this.pagesNodeIds(target);
    if (nodeIds.length === 0) return;
    const cleanupError = await this.pagesNodes().cleanup(nodeIds, route.id);
    if (cleanupError) throw cleanupError;
  }

  protected async restorePagesMaterialization(
    target: { nodeId: string | null; ingressGroupId?: string | null } | string | readonly string[],
    routeId: string,
    deploymentId: string | null,
    runtimeConfigGeneration: number
  ): Promise<void> {
    const nodeIds = await this.pagesNodeIds(target);
    await this.pagesNodes().restoreMaterialization(nodeIds, routeId, deploymentId, runtimeConfigGeneration);
  }

  protected async restorePagesRouteRow(previous: AdditionalRouteRow, expectedDeploymentId: string): Promise<void> {
    const [current] = await this.db
      .select()
      .from(proxyAdditionalRoutes)
      .where(eq(proxyAdditionalRoutes.id, previous.id))
      .limit(1);
    if (!current || current.generation === previous.generation) return;
    if (current.generation !== previous.generation + 1 || current.activeDeploymentId !== expectedDeploymentId) {
      throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route changed during rollback');
    }
    const [restored] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        secureLinkId: previous.secureLinkId,
        activeDeploymentId: previous.activeDeploymentId,
        includePath: previous.includePath,
        runtimeConfigPath: previous.runtimeConfigPath,
        runtimeConfigGeneration: previous.runtimeConfigGeneration,
        status: previous.status,
        lastError: null,
        generation: current.generation + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(proxyAdditionalRoutes.id, previous.id), eq(proxyAdditionalRoutes.generation, current.generation)))
      .returning({ id: proxyAdditionalRoutes.id });
    if (!restored) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route rollback was lost');
  }

  protected async resolvePageDeployment(projectId: string, tagId: string) {
    const [row] = await this.db
      .select({ deployment: pageDeployments, generation: pageTags.generation })
      .from(pageTags)
      .innerJoin(pageDeployments, eq(pageTags.deploymentId, pageDeployments.id))
      .where(and(eq(pageTags.id, tagId), eq(pageTags.projectId, projectId), eq(pageDeployments.status, 'ready')))
      .limit(1);
    if (!row) throw new AppError(409, 'PAGES_TAG_NOT_DEPLOYED', 'Select a Tag with a ready Deployment');
    return row.deployment;
  }

  protected routeOptions(input: Input, target: NormalizedTarget) {
    const pages = target.targetKind === 'pages';
    const boundedTimeout = (key: string): number => {
      const value = Number(input[key] ?? 60);
      if (!Number.isInteger(value) || value < 1 || value > 3600) {
        throw new AppError(400, 'INVALID_ROUTE_TIMEOUT', `${key} must be between 1 and 3600 seconds`);
      }
      return value;
    };
    return {
      stripPrefix: pages ? true : Boolean(input.stripPrefix ?? false),
      websocketSupport: pages ? false : Boolean(input.websocketSupport ?? false),
      requestBuffering: pages ? false : input.requestBuffering !== false,
      responseBuffering: pages ? false : input.responseBuffering !== false,
      connectTimeoutSeconds: pages ? 60 : boundedTimeout('connectTimeoutSeconds'),
      readTimeoutSeconds: pages ? 60 : boundedTimeout('readTimeoutSeconds'),
      sendTimeoutSeconds: pages ? 60 : boundedTimeout('sendTimeoutSeconds'),
    };
  }

  protected targetChanged(existing: AdditionalRouteRow, target: NormalizedTarget): boolean {
    return (
      existing.targetKind !== target.targetKind ||
      existing.forwardHost !== target.forwardHost ||
      existing.forwardPort !== target.forwardPort ||
      existing.forwardScheme !== target.forwardScheme ||
      existing.dockerNodeId !== target.dockerNodeId ||
      existing.dockerContainerName !== target.dockerContainerName ||
      existing.dockerComposeProjectId !== target.dockerComposeProjectId ||
      existing.dockerComposeServiceName !== target.dockerComposeServiceName ||
      existing.dockerDeploymentId !== target.dockerDeploymentId ||
      existing.dockerContainerPort !== target.dockerContainerPort ||
      existing.dockerHostPort !== target.dockerHostPort ||
      existing.dockerProtocol !== target.dockerProtocol ||
      existing.pageProjectId !== target.pageProjectId ||
      existing.pageTagId !== target.pageTagId
    );
  }

  protected async markFailed(
    routeId: string,
    error: unknown,
    updatedById: string | null
  ): Promise<AdditionalRouteRow | undefined> {
    const [failed] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        ...(updatedById ? { updatedById } : {}),
        updatedAt: new Date(),
      })
      .where(eq(proxyAdditionalRoutes.id, routeId))
      .returning();
    if (failed) this.emit(failed, 'failed');
    return failed;
  }

  protected emit(route: Pick<AdditionalRouteRow, 'id' | 'proxyHostId' | 'path' | 'status'>, action: string): void {
    const payload = { id: route.proxyHostId, routeId: route.id, path: route.path, action, status: route.status };
    this.eventBus?.publish('proxy.additional-route.changed', payload);
    this.eventBus?.publish('proxy.host.changed', payload);
  }
}
