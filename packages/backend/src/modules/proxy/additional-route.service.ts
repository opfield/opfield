import { and, eq, inArray } from 'drizzle-orm';
import {
  nginxTemplates,
  pageDeployments,
  pageProjects,
  pageTags,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AdditionalRouteServiceRuntime } from './additional-route.service.runtime.js';
import {
  type AdditionalRouteNodeMigration,
  type AdditionalRouteRow,
  type Input,
  isDockerKind,
  isUniqueViolation,
  logger,
  type NormalizedTarget,
  type ProxyHostRow,
  readInput,
} from './additional-route.service.shared.js';
import { additionalRouteAdvancedConfigErrors, normalizeAdditionalRoutePath } from './additional-route.validation.js';
import { supportsAdditionalRoutesTemplate } from './additional-route-template.js';
import type { CreateProxyAdditionalSecureLinkInput } from './proxy-secure-link.service.js';

export * from './additional-route.service.shared.js';

export class AdditionalRouteService extends AdditionalRouteServiceRuntime {
  async requireHost(hostId: string): Promise<ProxyHostRow> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    return host;
  }

  /** Service-level gate used by CRUD and by direct ProxyService callers. */
  async assertHostCanUse(host: ProxyHostRow): Promise<void> {
    if (host.type !== 'proxy' || host.rawConfigEnabled) {
      throw new AppError(409, 'ADDITIONAL_ROUTES_UNAVAILABLE', 'Additional Routes require a managed route');
    }
    if (host.nginxTemplateId) {
      const template = await this.db.query.nginxTemplates.findFirst({
        where: eq(nginxTemplates.id, host.nginxTemplateId),
      });
      if (
        !template ||
        template.type !== 'proxy' ||
        (!template.isBuiltin && !supportsAdditionalRoutesTemplate(template.content))
      ) {
        throw new AppError(
          409,
          'ADDITIONAL_ROUTES_TEMPLATE_UNSUPPORTED',
          'Additional Routes require the managed proxy template'
        );
      }
    }
  }

  async assertHostTemplateMutationAllowed(host: ProxyHostRow, input: Input): Promise<void> {
    const count = await this.db
      .select({ id: proxyAdditionalRoutes.id })
      .from(proxyAdditionalRoutes)
      .where(eq(proxyAdditionalRoutes.proxyHostId, host.id))
      .limit(1);
    if (count.length === 0) return;
    if (host.type === 'proxy' && (input.type === 'redirect' || input.type === '404')) {
      throw new AppError(
        409,
        'ADDITIONAL_ROUTES_HOST_MODE_BLOCKED',
        'Remove Additional Routes before changing this host from Proxy to Redirect or 404'
      );
    }
    const entersRaw = input.type === 'raw' || input.rawConfigEnabled === true;
    if (entersRaw) {
      throw new AppError(
        409,
        'ADDITIONAL_ROUTES_HOST_MODE_BLOCKED',
        'Remove Additional Routes before switching this host to raw mode or a custom template'
      );
    }
    if (input.nginxTemplateId === undefined || input.nginxTemplateId === null) return;
    if (typeof input.nginxTemplateId === 'string') {
      const template = await this.db.query.nginxTemplates.findFirst({
        where: eq(nginxTemplates.id, input.nginxTemplateId),
      });
      if (template?.type === 'proxy' && (template.isBuiltin || supportsAdditionalRoutesTemplate(template.content))) {
        return;
      }
    }
    throw new AppError(
      409,
      'ADDITIONAL_ROUTES_HOST_MODE_BLOCKED',
      'Remove Additional Routes before switching this host to raw mode or a custom template'
    );
  }

  async list(hostId: string) {
    await this.requireHost(hostId);
    return this.db
      .select({
        route: proxyAdditionalRoutes,
        pageProjectName: pageProjects.name,
        pageProjectSlug: pageProjects.slug,
        pageProjectAppearanceColor: pageProjects.appearanceColor,
        pageTagName: pageTags.name,
      })
      .from(proxyAdditionalRoutes)
      .leftJoin(pageProjects, eq(proxyAdditionalRoutes.pageProjectId, pageProjects.id))
      .leftJoin(pageTags, eq(proxyAdditionalRoutes.pageTagId, pageTags.id))
      .where(eq(proxyAdditionalRoutes.proxyHostId, hostId))
      .orderBy(proxyAdditionalRoutes.path)
      .then((rows) => rows.map(({ route, ...labels }) => ({ ...route, ...labels })));
  }

  async present(route: AdditionalRouteRow) {
    const [view] = await this.db
      .select({
        pageProjectName: pageProjects.name,
        pageProjectSlug: pageProjects.slug,
        pageProjectAppearanceColor: pageProjects.appearanceColor,
        pageTagName: pageTags.name,
      })
      .from(proxyAdditionalRoutes)
      .leftJoin(pageProjects, eq(proxyAdditionalRoutes.pageProjectId, pageProjects.id))
      .leftJoin(pageTags, eq(proxyAdditionalRoutes.pageTagId, pageTags.id))
      .where(eq(proxyAdditionalRoutes.id, route.id))
      .limit(1);
    return { ...route, ...view };
  }

  async get(hostId: string, routeId: string): Promise<AdditionalRouteRow> {
    const [route] = await this.db
      .select()
      .from(proxyAdditionalRoutes)
      .where(and(eq(proxyAdditionalRoutes.id, routeId), eq(proxyAdditionalRoutes.proxyHostId, hostId)))
      .limit(1);
    if (!route) throw new AppError(404, 'ADDITIONAL_ROUTE_NOT_FOUND', 'Additional Route not found');
    return route;
  }

  protected normalizeTarget(input: Input, existing?: AdditionalRouteRow): NormalizedTarget {
    const nested =
      input.target && typeof input.target === 'object' && !Array.isArray(input.target)
        ? (input.target as Input)
        : undefined;
    const targetKind = String(
      input.targetKind ?? input.targetType ?? nested?.kind ?? nested?.targetKind ?? existing?.targetKind ?? ''
    ) as NormalizedTarget['targetKind'];
    if (!['manual', 'docker_container', 'docker_deployment', 'pages'].includes(targetKind)) {
      throw new AppError(400, 'ADDITIONAL_ROUTE_TARGET_REQUIRED', 'A route target is required');
    }
    const value = (key: string): unknown => readInput(input, nested, key);
    const sameKind = existing?.targetKind === targetKind;
    return {
      targetKind,
      forwardHost:
        targetKind === 'manual'
          ? ((value('forwardHost') as string | null | undefined) ?? (sameKind ? existing?.forwardHost : null) ?? null)
          : null,
      forwardPort:
        targetKind === 'manual'
          ? ((value('forwardPort') as number | null | undefined) ?? (sameKind ? existing?.forwardPort : null) ?? null)
          : null,
      forwardScheme: (value('forwardScheme') as 'http' | 'https' | undefined) ?? existing?.forwardScheme ?? 'http',
      dockerNodeId: isDockerKind(targetKind)
        ? ((value('dockerNodeId') as string | null | undefined) ?? (sameKind ? existing?.dockerNodeId : null) ?? null)
        : null,
      dockerContainerName:
        targetKind === 'docker_container'
          ? ((value('dockerContainerName') as string | null | undefined) ??
            (sameKind ? existing?.dockerContainerName : null) ??
            null)
          : null,
      dockerComposeProjectId:
        targetKind === 'docker_container'
          ? ((value('dockerComposeProjectId') as string | null | undefined) ??
            (sameKind ? existing?.dockerComposeProjectId : null) ??
            null)
          : null,
      dockerComposeServiceName:
        targetKind === 'docker_container'
          ? ((value('dockerComposeServiceName') as string | null | undefined) ??
            (sameKind ? existing?.dockerComposeServiceName : null) ??
            null)
          : null,
      dockerDeploymentId:
        targetKind === 'docker_deployment'
          ? ((value('dockerDeploymentId') as string | null | undefined) ??
            (sameKind ? existing?.dockerDeploymentId : null) ??
            null)
          : null,
      dockerContainerPort: isDockerKind(targetKind)
        ? ((value('dockerContainerPort') as number | null | undefined) ??
          (sameKind ? existing?.dockerContainerPort : null) ??
          null)
        : null,
      dockerHostPort: isDockerKind(targetKind)
        ? ((value('dockerHostPort') as number | null | undefined) ??
          (sameKind ? existing?.dockerHostPort : null) ??
          null)
        : null,
      dockerProtocol: isDockerKind(targetKind)
        ? ((value('dockerProtocol') as 'tcp' | undefined) ??
          (sameKind ? (existing?.dockerProtocol as 'tcp' | null | undefined) : null) ??
          'tcp')
        : null,
      pageProjectId:
        targetKind === 'pages'
          ? ((value('pageProjectId') as string | null | undefined) ??
            (sameKind ? existing?.pageProjectId : null) ??
            null)
          : null,
      pageTagId:
        targetKind === 'pages'
          ? ((value('pageTagId') as string | null | undefined) ?? (sameKind ? existing?.pageTagId : null) ?? null)
          : null,
    };
  }

  protected async validateTarget(host: ProxyHostRow, target: NormalizedTarget, actorScopes: string[]): Promise<void> {
    if (target.forwardScheme !== 'http' && target.forwardScheme !== 'https') {
      throw new AppError(400, 'INVALID_ROUTE_SCHEME', 'Route scheme must be HTTP or HTTPS');
    }
    if (target.targetKind === 'manual') {
      if (!target.forwardHost || !/^[A-Za-z0-9._-]+$/.test(target.forwardHost))
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host is required');
      if (!target.forwardPort || target.forwardPort < 1 || target.forwardPort > 65535)
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host and port are required');
      return;
    }
    if (isDockerKind(target.targetKind)) {
      if (target.dockerProtocol !== 'tcp') {
        throw new AppError(400, 'INVALID_DOCKER_PROTOCOL', 'Docker Additional Routes require TCP');
      }
      if (!this.dockerUpstreams)
        throw new AppError(503, 'DOCKER_UPSTREAMS_UNAVAILABLE', 'Docker upstream resolution is unavailable');
      await this.dockerUpstreams.resolve(
        {
          upstreamKind: target.targetKind,
          dockerNodeId: target.dockerNodeId,
          dockerContainerName: target.dockerContainerName,
          dockerComposeProjectId: target.dockerComposeProjectId,
          dockerComposeServiceName: target.dockerComposeServiceName,
          dockerDeploymentId: target.dockerDeploymentId,
          dockerContainerPort: target.dockerContainerPort,
          dockerHostPort: target.dockerHostPort,
          dockerProtocol: target.dockerProtocol,
        },
        { actorScopes, requireAvailable: true, refreshOnMiss: true }
      );
      return;
    }
    if (!target.pageProjectId || !target.pageTagId) {
      throw new AppError(400, 'PAGES_ROUTE_TARGET_REQUIRED', 'Select both a Page Project and Tag');
    }
    if (!hasScope(actorScopes, `pages:view:${target.pageProjectId}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
    }
    if (!host.nodeId) throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Pages Route host has no Nginx node');
    const [targetRow] = await this.db
      .select({ deploymentId: pageTags.deploymentId, generation: pageTags.generation })
      .from(pageTags)
      .innerJoin(pageDeployments, eq(pageTags.deploymentId, pageDeployments.id))
      .where(
        and(
          eq(pageTags.id, target.pageTagId),
          eq(pageTags.projectId, target.pageProjectId),
          eq(pageDeployments.status, 'ready')
        )
      )
      .limit(1);
    if (!targetRow?.deploymentId)
      throw new AppError(409, 'PAGES_TAG_NOT_DEPLOYED', 'Select a Tag with a ready Deployment');
    if (!this.pageRuntime || !this.pageRuntimeConfig)
      throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route runtime is unavailable');
    await this.pagesNodes().preflight(await this.pagesNodeIds(host), 0);
  }

  protected assertAdvancedConfigAllowed(host: ProxyHostRow, advancedConfig: unknown, actorScopes: string[]): void {
    if (typeof advancedConfig !== 'string' || !advancedConfig) return;
    const errors = additionalRouteAdvancedConfigErrors(
      advancedConfig,
      hasScope(actorScopes, `proxy:unrestricted:${host.id}`)
    );
    if (errors.length > 0) {
      throw new AppError(400, 'INVALID_ADVANCED_CONFIG', `Advanced config is invalid: ${errors.join(', ')}`);
    }
  }

  protected asSecureLinkInput(target: NormalizedTarget): CreateProxyAdditionalSecureLinkInput {
    if (!isDockerKind(target.targetKind) || !target.dockerContainerPort) {
      throw new AppError(400, 'INVALID_DOCKER_TARGET', 'A Docker target and application port are required');
    }
    return {
      name: 'route',
      upstreamKind: target.targetKind,
      forwardScheme: target.forwardScheme,
      dockerNodeId: target.dockerNodeId,
      dockerContainerName: target.dockerContainerName,
      dockerComposeProjectId: target.dockerComposeProjectId,
      dockerComposeServiceName: target.dockerComposeServiceName,
      dockerDeploymentId: target.dockerDeploymentId,
      dockerContainerPort: target.dockerContainerPort,
    };
  }

  async create(hostId: string, input: Input, userId: string, actorScopes: string[]): Promise<AdditionalRouteRow> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      await this.assertHostCanUse(host);
      this.assertAdvancedConfigAllowed(host, input.advancedConfig, actorScopes);
      const target = this.normalizeTarget(input);
      await this.validateTarget(host, target, actorScopes);
      const path = normalizeAdditionalRoutePath(String(input.path ?? ''));
      const enabled = input.enabled !== false;
      const options = this.routeOptions(input, target);
      let created: AdditionalRouteRow;
      try {
        [created] = await this.db
          .insert(proxyAdditionalRoutes)
          .values({
            proxyHostId: host.id,
            path,
            enabled,
            ...target,
            ...options,
            advancedConfig: typeof input.advancedConfig === 'string' ? input.advancedConfig || null : null,
            status: enabled ? 'staging' : 'disabled',
            generation: 1,
            createdById: userId,
            updatedById: userId,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, 'ADDITIONAL_ROUTE_PATH_EXISTS', 'A route already uses this path');
        throw error;
      }
      if (!created) throw new AppError(500, 'ADDITIONAL_ROUTE_CREATE_FAILED', 'Additional Route was not created');

      try {
        if (enabled) {
          created = await this.provision(created, host, target);
          if (target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        }
      } catch (error) {
        created = (await this.markFailed(created.id, error, userId)) ?? created;
      }
      await this.auditService.log({
        userId,
        action: 'proxy.additional_route.create',
        resourceType: 'proxy_additional_route',
        resourceId: created.id,
        details: { proxyHostId: host.id, path: created.path, targetKind: created.targetKind },
      });
      this.emit(created, 'created');
      return created;
    });
  }

  async update(
    hostId: string,
    routeId: string,
    input: Input,
    userId: string,
    actorScopes: string[]
  ): Promise<AdditionalRouteRow> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      await this.assertHostCanUse(host);
      this.assertAdvancedConfigAllowed(host, input.advancedConfig, actorScopes);
      const existing = await this.get(hostId, routeId);
      const target = this.normalizeTarget(input, existing);
      await this.validateTarget(host, target, actorScopes);
      const path = input.path === undefined ? existing.path : normalizeAdditionalRoutePath(String(input.path));
      const enabled = input.enabled === undefined ? existing.enabled : Boolean(input.enabled);
      const options = this.routeOptions({ ...existing, ...input }, target);
      const targetChanged = this.targetChanged(existing, target);
      const resetMaterialization = !enabled
        ? {
            secureLinkId: null,
            activeDeploymentId: null,
            includePath: null,
            runtimeConfigPath: null,
            runtimeConfigGeneration: 0,
          }
        : {};
      const [staged] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          path,
          enabled,
          ...target,
          ...options,
          advancedConfig:
            input.advancedConfig === undefined
              ? existing.advancedConfig
              : typeof input.advancedConfig === 'string' && input.advancedConfig.length > 0
                ? input.advancedConfig
                : null,
          ...resetMaterialization,
          status: enabled ? 'staging' : 'disabled',
          generation: existing.generation + 1,
          lastError: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(proxyAdditionalRoutes.id, routeId), eq(proxyAdditionalRoutes.proxyHostId, hostId)))
        .returning();
      if (!staged) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      let ready: AdditionalRouteRow | null = null;
      try {
        ready = enabled ? await this.provision(staged, host, target) : staged;
        if (enabled && ready.status !== 'ready') {
          throw new Error(ready.lastError ?? 'Additional Route target did not become ready');
        }
        if (!enabled || target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        try {
          if (
            (!enabled || (targetChanged && !isDockerKind(target.targetKind))) &&
            this.secureLinks &&
            isDockerKind(existing.targetKind)
          ) {
            if (existing.secureLinkId) {
              await this.secureLinks.deleteManagedRouteBinding(host, existing.secureLinkId);
            } else {
              await this.secureLinks.deleteManagedRoute(host, routeId);
            }
          } else if (
            targetChanged &&
            isDockerKind(target.targetKind) &&
            isDockerKind(existing.targetKind) &&
            existing.secureLinkId &&
            ready.secureLinkId !== existing.secureLinkId
          ) {
            await this.secureLinks?.deleteManagedRouteBinding(host, existing.secureLinkId);
          }
          if ((!enabled || (targetChanged && target.targetKind !== 'pages')) && existing.targetKind === 'pages') {
            await this.cleanupPages(existing, host);
          }
        } catch (cleanupError) {
          logger.warn('Additional Route previous target cleanup failed after successful retarget', {
            routeId,
            cleanupError,
          });
        }
        await this.auditService.log({
          userId,
          action: 'proxy.additional_route.update',
          resourceType: 'proxy_additional_route',
          resourceId: routeId,
          details: { proxyHostId: host.id, changes: Object.keys(input) },
        });
        this.emit(ready, 'updated');
        return ready;
      } catch (error) {
        if (targetChanged) {
          try {
            if (existing.targetKind === 'pages' && existing.activeDeploymentId) {
              await this.restorePagesMaterialization(
                host,
                existing.id,
                existing.activeDeploymentId,
                existing.runtimeConfigGeneration
              );
            }
            await this.restoreRetarget(existing, userId);
            await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
            if (
              ready?.secureLinkId &&
              ready.secureLinkId !== existing.secureLinkId &&
              isDockerKind(target.targetKind)
            ) {
              await this.secureLinks?.deleteManagedRouteBinding(host, ready.secureLinkId).catch(() => undefined);
            }
            if (target.targetKind === 'pages' && existing.targetKind !== 'pages' && ready) {
              await this.cleanupPages(ready, host).catch(() => undefined);
            }
            logger.warn('Additional Route retarget rolled back to the previous ready target', { routeId, error });
          } catch (rollbackError) {
            logger.error('Additional Route retarget rollback failed', { routeId, error, rollbackError });
            // Fall through to the retryable failed state when the previous
            // materialization could not be restored safely.
            const [failed] = await this.db
              .update(proxyAdditionalRoutes)
              .set({
                status: 'failed',
                lastError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                updatedAt: new Date(),
              })
              .where(eq(proxyAdditionalRoutes.id, routeId))
              .returning();
            return failed ?? (await this.get(hostId, routeId));
          }
          throw error;
        }
        // Restore the persisted intent. Runtime cleanup is best effort and the
        // failed generation remains visible for an explicit retry.
        await this.db
          .update(proxyAdditionalRoutes)
          .set({
            status: enabled ? 'failed' : 'cleanup_pending',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(proxyAdditionalRoutes.id, routeId));
        const current = await this.get(hostId, routeId);
        logger.warn('Additional Route update left in retryable failed state', { routeId, error });
        return current;
      }
    });
  }

  protected async restoreRetarget(previous: AdditionalRouteRow, userId: string): Promise<AdditionalRouteRow> {
    const current = await this.get(previous.proxyHostId, previous.id);
    const [restored] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        path: previous.path,
        enabled: previous.enabled,
        targetKind: previous.targetKind,
        forwardHost: previous.forwardHost,
        forwardPort: previous.forwardPort,
        forwardScheme: previous.forwardScheme,
        dockerNodeId: previous.dockerNodeId,
        dockerContainerName: previous.dockerContainerName,
        dockerDeploymentId: previous.dockerDeploymentId,
        dockerContainerPort: previous.dockerContainerPort,
        dockerHostPort: previous.dockerHostPort,
        dockerProtocol: previous.dockerProtocol,
        pageProjectId: previous.pageProjectId,
        pageTagId: previous.pageTagId,
        secureLinkId: previous.secureLinkId,
        activeDeploymentId: previous.activeDeploymentId,
        includePath: previous.includePath,
        runtimeConfigPath: previous.runtimeConfigPath,
        runtimeConfigGeneration: previous.runtimeConfigGeneration,
        advancedConfig: previous.advancedConfig,
        stripPrefix: previous.stripPrefix,
        websocketSupport: previous.websocketSupport,
        requestBuffering: previous.requestBuffering,
        responseBuffering: previous.responseBuffering,
        connectTimeoutSeconds: previous.connectTimeoutSeconds,
        readTimeoutSeconds: previous.readTimeoutSeconds,
        sendTimeoutSeconds: previous.sendTimeoutSeconds,
        status: previous.status,
        generation: current.generation + 1,
        lastError: null,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(proxyAdditionalRoutes.id, previous.id),
          eq(proxyAdditionalRoutes.proxyHostId, previous.proxyHostId),
          eq(proxyAdditionalRoutes.generation, current.generation)
        )
      )
      .returning();
    if (!restored) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed during rollback');
    return restored;
  }

  async retry(hostId: string, routeId: string, userId: string, actorScopes: string[]): Promise<AdditionalRouteRow> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      await this.assertHostCanUse(host);
      const existing = await this.get(hostId, routeId);
      const target = this.normalizeTarget(existing as unknown as Input, existing);
      await this.validateTarget(host, target, actorScopes);
      const [staged] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          status: 'staging',
          generation: existing.generation + 1,
          lastError: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalRoutes.id, routeId))
        .returning();
      if (!staged) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      try {
        if (isDockerKind(target.targetKind)) await this.secureLinks?.deleteManagedRoute(host, routeId);
        if (target.targetKind === 'pages') await this.cleanupPages(existing, host);
        const ready = await this.provision(staged, host, target);
        if (target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        await this.auditService.log({
          userId,
          action: 'proxy.additional_route.retry',
          resourceType: 'proxy_additional_route',
          resourceId: routeId,
        });
        this.emit(ready, 'retried');
        return ready;
      } catch (error) {
        return (await this.markFailed(routeId, error, userId)) ?? staged;
      }
    });
  }

  async remove(hostId: string, routeId: string, userId: string): Promise<void> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      const existing = await this.get(hostId, routeId);
      // Stage the config removal before touching relay/Pages state.
      const [pending] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          status: 'cleanup_pending',
          enabled: false,
          generation: existing.generation + 1,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalRoutes.id, routeId))
        .returning();
      if (!pending) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      try {
        await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        if (isDockerKind(existing.targetKind)) await this.secureLinks?.deleteManagedRoute(host, routeId);
        if (existing.targetKind === 'pages') await this.cleanupPages(existing, host);
        await this.db.delete(proxyAdditionalRoutes).where(eq(proxyAdditionalRoutes.id, routeId));
      } catch (error) {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({
            status: 'cleanup_pending',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(proxyAdditionalRoutes.id, routeId));
        throw error;
      }
      await this.auditService.log({
        userId,
        action: 'proxy.additional_route.delete',
        resourceType: 'proxy_additional_route',
        resourceId: routeId,
        details: { proxyHostId: host.id, path: existing.path },
      });
      this.emit(existing, 'deleted');
    });
  }

  async cleanupForHost(host: ProxyHostRow, abandonOfflineNode = false): Promise<void> {
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: eq(proxyAdditionalRoutes.proxyHostId, host.id),
    });
    for (const route of routes) {
      if (route.targetKind === 'pages' && !abandonOfflineNode) {
        await this.cleanupPages(route, host);
      }
    }
    // The Secure Link service owns the hidden relay bindings and is called by
    // ProxyService immediately before this method.  Keep route rows durable
    // until the host cascade; offline deletion intentionally leaves daemon
    // cleanup to the existing deferred relay reconciliation.
  }

  /**
   * Stage route-owned listeners/fragments on a new ingress node.  The old
   * listener and Pages materialization remain active until ProxyService has
   * applied the destination host configuration and calls commitNodeMigration.
   */
  async stageNodeMigration(
    hostId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<AdditionalRouteNodeMigration> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      const rows = await this.db.query.proxyAdditionalRoutes.findMany({
        where: and(
          eq(proxyAdditionalRoutes.proxyHostId, hostId),
          eq(proxyAdditionalRoutes.enabled, true),
          eq(proxyAdditionalRoutes.status, 'ready'),
          inArray(proxyAdditionalRoutes.targetKind, ['docker_container', 'docker_deployment', 'pages'])
        ),
        orderBy: (route, { asc }) => [asc(route.id)],
      });
      const progress: AdditionalRouteNodeMigration['routes'] = [];
      try {
        for (const route of rows) {
          if (isDockerKind(route.targetKind)) {
            if (!this.secureLinks || !route.secureLinkId) {
              throw new AppError(
                409,
                'SECURE_LINK_ROUTE_NOT_READY',
                'Docker Additional Route Secure Link is unavailable'
              );
            }
            const binding = await this.db.query.proxyAdditionalSecureLinks.findFirst({
              where: and(
                eq(proxyAdditionalSecureLinks.id, route.secureLinkId),
                eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
                eq(proxyAdditionalSecureLinks.status, 'active')
              ),
            });
            if (!binding || binding.sourceNodeId !== sourceNodeId) {
              throw new AppError(409, 'SECURE_LINK_ROUTE_CHANGED', 'Docker Additional Route changed during migration');
            }
            const stagedBinding = await this.secureLinks.stageManagedRouteMigration(host, route.id, targetNodeId);
            const [staged] = await this.db
              .update(proxyAdditionalRoutes)
              .set({
                secureLinkId: stagedBinding.stagedBindingId,
                migrationSourceNodeId: sourceNodeId,
                migrationTargetNodeId: targetNodeId,
                migrationPreviousSecureLinkId: route.secureLinkId,
                migrationPreviousIncludePath: null,
                migrationPreviousRuntimeConfigGeneration: route.runtimeConfigGeneration,
                status: 'staging',
                generation: route.generation + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(proxyAdditionalRoutes.id, route.id),
                  eq(proxyAdditionalRoutes.generation, route.generation),
                  eq(proxyAdditionalRoutes.status, 'ready'),
                  eq(proxyAdditionalRoutes.secureLinkId, route.secureLinkId)
                )
              )
              .returning({ generation: proxyAdditionalRoutes.generation });
            if (!staged) {
              await this.secureLinks.deleteManagedRouteBinding(host, stagedBinding.stagedBindingId);
              throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
            }
            progress.push({
              routeId: route.id,
              targetKind: route.targetKind,
              generation: staged.generation,
              previousSecureLinkId: route.secureLinkId,
              stagedSecureLinkId: stagedBinding.stagedBindingId,
              previousIncludePath: null,
              previousRuntimeConfigGeneration: route.runtimeConfigGeneration,
            });
            continue;
          }

          if (
            !this.pageRuntime ||
            !this.pageRuntimeConfig ||
            !route.pageProjectId ||
            !route.pageTagId ||
            !route.activeDeploymentId
          ) {
            throw new AppError(409, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Additional Route runtime is unavailable');
          }
          const effective = await this.pageRuntimeConfig.getEffective(route.pageProjectId, route.pageTagId);
          const runtimeGeneration = route.runtimeConfigGeneration || 1;
          const runtimeConfigPath = await this.pageRuntime.publishRuntimeConfig(
            targetNodeId,
            'route',
            route.id,
            runtimeGeneration,
            effective.value
          );
          let includePath: string;
          try {
            includePath = await this.pageRuntime.activateRoute(targetNodeId, route.id, route.activeDeploymentId);
          } catch (error) {
            await this.pageRuntime.removeRuntimeConfig(targetNodeId, 'route', route.id).catch(() => undefined);
            throw error;
          }
          const [staged] = await this.db
            .update(proxyAdditionalRoutes)
            .set({
              includePath,
              runtimeConfigPath,
              migrationSourceNodeId: sourceNodeId,
              migrationTargetNodeId: targetNodeId,
              migrationPreviousSecureLinkId: null,
              migrationPreviousIncludePath: route.includePath,
              migrationPreviousRuntimeConfigGeneration: route.runtimeConfigGeneration,
              status: 'staging',
              generation: route.generation + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(proxyAdditionalRoutes.id, route.id),
                eq(proxyAdditionalRoutes.generation, route.generation),
                eq(proxyAdditionalRoutes.status, 'ready')
              )
            )
            .returning({ generation: proxyAdditionalRoutes.generation });
          if (!staged) {
            await this.pageRuntime.deactivateRoute(targetNodeId, route.id).catch(() => undefined);
            await this.pageRuntime.removeRuntimeConfig(targetNodeId, 'route', route.id).catch(() => undefined);
            throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
          }
          progress.push({
            routeId: route.id,
            targetKind: route.targetKind,
            generation: staged.generation,
            previousSecureLinkId: null,
            stagedSecureLinkId: null,
            previousIncludePath: route.includePath,
            previousRuntimeConfigGeneration: route.runtimeConfigGeneration,
          });
        }
        return {
          hostId,
          sourceNodeId,
          targetNodeId,
          routeIds: progress.map((route) => route.routeId),
          generation: progress.reduce((max, route) => Math.max(max, route.generation), 0),
          routes: progress,
        };
      } catch (error) {
        await this.rollbackNodeMigrationLocked({
          hostId,
          sourceNodeId,
          targetNodeId,
          routeIds: progress.map((route) => route.routeId),
          generation: progress.reduce((max, route) => Math.max(max, route.generation), 0),
          routes: progress,
        }).catch((rollbackError) =>
          logger.error('Additional Route migration rollback failed', { hostId, rollbackError })
        );
        throw error;
      }
    });
  }

  async commitNodeMigration(migration: AdditionalRouteNodeMigration): Promise<void> {
    await this.withHostLock(migration.hostId, async () => {
      const host = await this.requireHost(migration.hostId);
      for (const item of migration.routes) {
        const [current] = await this.db
          .select()
          .from(proxyAdditionalRoutes)
          .where(eq(proxyAdditionalRoutes.id, item.routeId))
          .limit(1);
        if (!current) continue;
        if (
          current.migrationTargetNodeId !== migration.targetNodeId ||
          current.migrationSourceNodeId !== migration.sourceNodeId ||
          current.generation !== item.generation
        ) {
          if (current.migrationTargetNodeId === null && current.status === 'ready') continue;
          throw new AppError(
            409,
            'ADDITIONAL_ROUTE_MIGRATION_OWNERSHIP_LOST',
            'Additional Route migration claim was lost'
          );
        }

        let cleanupComplete = true;
        if (item.targetKind === 'pages') {
          if (this.pageRuntime) {
            try {
              await this.pageRuntime.deactivateRoute(migration.sourceNodeId, item.routeId);
              await this.pageRuntime.removeRuntimeConfig(migration.sourceNodeId, 'route', item.routeId);
            } catch (error) {
              cleanupComplete = false;
              logger.warn('Additional Pages Route source cleanup will retry', { routeId: item.routeId, error });
            }
          }
        } else if (item.previousSecureLinkId && this.secureLinks) {
          try {
            await this.secureLinks.deleteManagedRouteBinding(host, item.previousSecureLinkId);
          } catch (error) {
            cleanupComplete = false;
            logger.warn('Additional Route source Secure Link cleanup will retry', { routeId: item.routeId, error });
          }
        }
        if (cleanupComplete) {
          await this.db
            .update(proxyAdditionalRoutes)
            .set({
              status: 'ready',
              migrationSourceNodeId: null,
              migrationTargetNodeId: null,
              migrationPreviousSecureLinkId: null,
              migrationPreviousIncludePath: null,
              migrationPreviousRuntimeConfigGeneration: null,
              generation: current.generation + 1,
              updatedAt: new Date(),
            })
            .where(
              and(eq(proxyAdditionalRoutes.id, item.routeId), eq(proxyAdditionalRoutes.generation, item.generation))
            );
        } else {
          // Keep the claim durable while the target remains the only rendered
          // route. Reconciliation will retry source cleanup after reconnect.
          await this.db
            .update(proxyAdditionalRoutes)
            .set({ status: 'ready', updatedAt: new Date() })
            .where(
              and(eq(proxyAdditionalRoutes.id, item.routeId), eq(proxyAdditionalRoutes.generation, item.generation))
            );
        }
      }
    });
  }

  async rollbackNodeMigration(migration: AdditionalRouteNodeMigration): Promise<void> {
    await this.withHostLock(migration.hostId, async () => {
      await this.rollbackNodeMigrationLocked(migration);
    });
  }

  protected async rollbackNodeMigrationLocked(migration: AdditionalRouteNodeMigration): Promise<void> {
    const host = await this.requireHost(migration.hostId);
    for (const item of [...migration.routes].reverse()) {
      const [current] = await this.db
        .select()
        .from(proxyAdditionalRoutes)
        .where(eq(proxyAdditionalRoutes.id, item.routeId))
        .limit(1);
      if (!current || current.migrationTargetNodeId === null) continue;
      if (current.generation !== item.generation || current.migrationTargetNodeId !== migration.targetNodeId) {
        throw new AppError(
          500,
          'ADDITIONAL_ROUTE_MIGRATION_OWNERSHIP_LOST',
          'Additional Route migration claim was lost'
        );
      }
      if (item.targetKind === 'pages') {
        if (this.pageRuntime) {
          await this.pageRuntime.deactivateRoute(migration.targetNodeId, item.routeId);
          await this.pageRuntime.removeRuntimeConfig(migration.targetNodeId, 'route', item.routeId);
        }
      } else if (item.stagedSecureLinkId && this.secureLinks) {
        await this.secureLinks.deleteManagedRouteBinding(host, item.stagedSecureLinkId);
      }
      await this.db
        .update(proxyAdditionalRoutes)
        .set({
          status: 'ready',
          secureLinkId: item.previousSecureLinkId,
          includePath: item.previousIncludePath,
          runtimeConfigGeneration: item.previousRuntimeConfigGeneration,
          migrationSourceNodeId: null,
          migrationTargetNodeId: null,
          migrationPreviousSecureLinkId: null,
          migrationPreviousIncludePath: null,
          migrationPreviousRuntimeConfigGeneration: null,
          generation: current.generation + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(proxyAdditionalRoutes.id, item.routeId), eq(proxyAdditionalRoutes.generation, item.generation)));
    }
  }
}
