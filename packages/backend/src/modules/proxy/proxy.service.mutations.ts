import { asc, eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { nodes, proxyHosts } from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type { FreezeTarget } from '@/modules/apps/app-member-freeze.js';
import { assertAppPlacement, filterNodesForAppFolder } from '@/modules/apps/app-placement-guard.js';
import { requireRoutableIngressGroup } from '@/modules/ingress-groups/ingress-group-routing.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { PageRouteNodeMigration } from '@/modules/pages/routes/page-route.service.js';
import type { AdditionalRouteNodeMigration } from './additional-route.service.js';
import type { CreateProxyHostInput, CreateProxyHostRequest, UpdateProxyHostInput } from './proxy.schemas.js';
import {
  assertSslPrerequisites,
  assertSslPrerequisitesForUpdate,
  normalizeProxyValidationOptions,
  type ProxyValidationInput,
  rawConfigAuditDetails,
  storedRawConfigForRawModeEnablement,
} from './proxy.service-helpers.js';
import {
  assertRegisteredDomainsUseTarget,
  findRegisteredDomainNodes,
  registeredDomainsIngressPlacement,
} from './proxy-domain-node.js';
import {
  assertNoProxyDomainOverlapOnNodes,
  restoringProxyHostState,
  rethrowProxyHostDomainConflict,
} from './proxy-domain-overlap.js';
import { proxyHostLockKey, proxyNodeLockKey, withProxyLocks } from './proxy-host-lock.js';
import { IngressDeliveryError } from './proxy-ingress-delivery.js';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';
import { loadRouteIngressGroups, type RouteIngressGroup } from './route-ingress-groups.js';
import {
  type RouteIngressNode,
  type RouteIngressNodeCandidate,
  type RouteIngressNodeSource,
  resolveRouteIngressNode,
  routeIngressNodesForScopes,
  toRouteIngressNode,
} from './route-ingress-nodes.js';

export { __testOnly } from './proxy.service-helpers.js';

import { isDockerUpstream, logger, type ProxyHostView, sameDomainNames } from './proxy.service.core.js';
import { ProxyServicePlacement, requestedPlacementChange } from './proxy.service.placement.js';

/** The app kill switch freeze as route mutations see it (AppMemberFreeze; set by the apps module). */
export interface ProxyAppFreezeGuard {
  /**
   * 409 APP_ISOLATED: a route of an isolated environment, or one the kill switch holds because it reaches a member
   * (edits and deletes alike; a shut-down app holds nothing).
   */
  assertRoute(routeId: string): Promise<void>;
  /** 409 APP_ISOLATED when a route or Secure Link would newly reach a member of an isolated environment. */
  assertUpstream(target: FreezeTarget): Promise<void>;
}

/** Upstream fields of a route or an additional Secure Link that name a workload. */
export interface AppFreezeUpstreamFields {
  upstreamKind?: string | null;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerDeploymentId?: string | null;
  pageProjectId?: string | null;
  managedStorageId?: string | null;
}

/** The app member an upstream names (null for a manual upstream or when no workload field is given). */
export function appFreezeTargetOfUpstream(
  upstream: AppFreezeUpstreamFields,
  fallbackDockerNodeId?: string | null
): FreezeTarget | null {
  if (upstream.upstreamKind === 'manual') return null;
  if (upstream.dockerDeploymentId) return { kind: 'deployment', id: upstream.dockerDeploymentId };
  if (upstream.dockerComposeProjectId) return { kind: 'compose', id: upstream.dockerComposeProjectId };
  const nodeId = upstream.dockerNodeId ?? fallbackDockerNodeId;
  if (upstream.dockerContainerName && nodeId) return { kind: 'container', nodeId, name: upstream.dockerContainerName };
  if (upstream.pageProjectId) return { kind: 'pages', id: upstream.pageProjectId };
  if (upstream.managedStorageId) return { kind: 'managedStorage', id: upstream.managedStorageId };
  return null;
}

/**
 * A proxy host write that names an SSL certificate waits on that certificate's
 * row lock (the foreign-key check), so a concurrent certificate delete either
 * sees the host and refuses, or commits first and fails this write here.
 */
function mapProxyHostCertificateReferenceError(error: unknown): never {
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown } | null;
  const pgError = candidate?.code === '23503' ? candidate : (candidate?.cause as typeof candidate | undefined);
  if (
    pgError?.code === '23503' &&
    typeof pgError.constraint === 'string' &&
    pgError.constraint.startsWith('proxy_hosts_ssl_certificate_id')
  ) {
    throw new AppError(409, 'SSL_CERT_DELETED', 'The selected SSL certificate was deleted; choose another certificate');
  }
  throw error;
}

export abstract class ProxyServiceMutations extends ProxyServicePlacement {
  /** Recomputes the app maintenance overlay of routes (set by the apps module). */
  protected appOverlay?: (routeIds: string[]) => Promise<void>;

  setAppOverlayHook(hook: (routeIds: string[]) => Promise<void>) {
    this.appOverlay = hook;
  }

  /** Refuses changes to routes an app kill switch holds or a shutdown keeps (set by the apps module). */
  protected appFreeze?: ProxyAppFreezeGuard;

  setAppFreezeGuard(guard: ProxyAppFreezeGuard) {
    this.appFreeze = guard;
  }

  /**
   * 409 APP_ISOLATED for a route the kill switch freezes. A user placement change checks it first; internal ingress
   * group moves do not (they move many routes and roll back as one).
   */
  async assertRouteNotAppFrozen(id: string): Promise<void> {
    await this.appFreeze?.assertRoute(id);
  }

  /** A route or Secure Link may not newly reach a workload of an environment isolated by the kill switch. */
  protected async assertUpstreamNotAppFrozen(
    upstream: AppFreezeUpstreamFields,
    fallbackDockerNodeId?: string | null
  ): Promise<void> {
    if (!this.appFreeze) return;
    const target = appFreezeTargetOfUpstream(upstream, fallbackDockerNodeId);
    if (target) await this.appFreeze.assertUpstream(target);
  }

  /** A route created in, or changed inside, an app environment takes the environment's maintenance overlay. */
  protected async refreshAppOverlay(host: {
    id: string;
    folderId?: string | null;
    appMaintenanceMode?: string | null;
  }) {
    if (!this.appOverlay || (!host.folderId && (host.appMaintenanceMode ?? 'off') === 'off')) return;
    try {
      await this.appOverlay([host.id]);
    } catch (error) {
      logger.warn('Failed to refresh the app maintenance overlay of a route', {
        hostId: host.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Every nginx node as a route destination: identity and availability only (no node details). */
  protected async loadRouteIngressNodeCandidates(): Promise<RouteIngressNodeCandidate[]> {
    const rows = await this.db
      .select({
        id: nodes.id,
        displayName: nodes.displayName,
        hostname: nodes.hostname,
        status: nodes.status,
        serviceCreationLocked: nodes.serviceCreationLocked,
      })
      .from(nodes)
      .where(eq(nodes.type, 'nginx'))
      .orderBy(asc(nodes.createdAt), asc(nodes.id));
    return rows.map((row) => ({
      ...row,
      status: row.status === 'online' && !this.nodeDispatch.isNodeConnected(row.id) ? 'offline' : row.status,
    }));
  }

  /**
   * Nginx ingress nodes the caller may create routes on (see routeIngressNodesForScopes), for
   * creators without `nodes:details`. `folderId` limits the list to a route in that folder.
   */
  async listRouteIngressNodes(scopes: readonly string[], folderId?: string | null): Promise<RouteIngressNode[]> {
    const candidates = await filterNodesForAppFolder(
      this.db,
      'routes',
      folderId,
      await this.loadRouteIngressNodeCandidates(),
      (candidate) => candidate.id
    );
    return routeIngressNodesForScopes(candidates, scopes, folderId).map(toRouteIngressNode);
  }

  /**
   * Ingress groups the caller may place a new route on: the caller may view the group (ingress:groups:view), every
   * member must be a node the caller may create routes on (see listRouteIngressNodes) and the group must have an
   * active member. Members are listed in site order.
   */
  async listRouteIngressGroups(scopes: readonly string[], folderId?: string | null): Promise<RouteIngressGroup[]> {
    const candidates = await this.loadRouteIngressNodeCandidates();
    const allowed = await filterNodesForAppFolder(this.db, 'routes', folderId, candidates, (candidate) => candidate.id);
    return loadRouteIngressGroups(this.db, routeIngressNodesForScopes(allowed, scopes, folderId), scopes);
  }

  /**
   * The ingress node of a new route: the requested one, else the node its registered domains are
   * assigned to, else the only node the caller may create on at this destination (409 listing them
   * when several qualify). Runs before the destination checks, which then use the returned node.
   */
  async resolveRouteIngressNode(
    scopes: readonly string[],
    input: Pick<CreateProxyHostRequest, 'nodeId' | 'domainNames' | 'folderId' | 'ingressGroupId'>
  ): Promise<{ nodeId: string; ingressGroupId: string | null; source: RouteIngressNodeSource }> {
    if (input.ingressGroupId) {
      const group = await requireRoutableIngressGroup(this.db, input.ingressGroupId, scopes);
      return { nodeId: group.primaryNodeId, ingressGroupId: group.group.id, source: 'request' };
    }
    if (input.nodeId) return { nodeId: input.nodeId, ingressGroupId: null, source: 'request' };
    const registered = await findRegisteredDomainNodes(this.db, input.domainNames);
    const pinned = registeredDomainsIngressPlacement(registered);
    if (pinned?.ingressGroupId) {
      // A registered domain on an ingress group places the route on that group (the caller must be able to view it).
      const group = await requireRoutableIngressGroup(this.db, pinned.ingressGroupId, scopes);
      return { nodeId: group.primaryNodeId, ingressGroupId: group.group.id, source: 'domain' };
    }
    const resolved = resolveRouteIngressNode({
      scopes,
      folderId: input.folderId,
      pinnedNodeId: pinned?.nodeId ?? null,
      pinnedByDomain: registered[0]?.domain,
      // In an app environment only its allowed nginx nodes are candidates.
      candidates: pinned
        ? []
        : await filterNodesForAppFolder(
            this.db,
            'routes',
            input.folderId,
            await this.loadRouteIngressNodeCandidates(),
            (candidate) => candidate.id
          ),
    });
    return { ...resolved, ingressGroupId: null };
  }

  /** Where a new route is served: its ingress group (every member) or its node. */
  protected async resolveCreatePlacement(
    request: Pick<CreateProxyHostRequest, 'nodeId' | 'ingressGroupId'>
  ): Promise<{ nodeId: string; ingressGroupId: string | null; servingNodeIds: string[] }> {
    if (request.ingressGroupId) {
      const group = await requireRoutableIngressGroup(this.db, request.ingressGroupId);
      if (request.nodeId && !group.memberNodeIds.includes(request.nodeId)) {
        throw new AppError(
          400,
          'INGRESS_TARGET_CONFLICT',
          'Pass either nodeId or ingressGroupId; a route on an ingress group is served by every member'
        );
      }
      return {
        nodeId: group.primaryNodeId,
        ingressGroupId: group.group.id,
        servingNodeIds: group.memberNodeIds,
      };
    }
    if (!request.nodeId) {
      throw new AppError(400, 'NODE_REQUIRED', 'A node must be selected for the proxy host');
    }
    return { nodeId: request.nodeId, ingressGroupId: null, servingNodeIds: [request.nodeId] };
  }

  async createProxyHost(request: CreateProxyHostRequest, userId: string, validationOptions: ProxyValidationInput = {}) {
    const options = normalizeProxyValidationOptions(validationOptions);

    // 0. Require a node or ingress group assignment (callers resolve an omitted nodeId with
    // resolveRouteIngressNode before their destination checks). A group route keeps the group's first
    // member in nodeId and is served by every member.
    const placement = await this.resolveCreatePlacement(request);
    const input: CreateProxyHostInput = { ...request, nodeId: placement.nodeId };
    for (const servingNodeId of placement.servingNodeIds) {
      await assertNodeAllowsServiceCreation(this.db, servingNodeId, 'nginx');
    }
    // A route created in an app environment is served only by nodes the environment allows (every group member).
    await assertAppPlacement(this.db, 'routes', input.folderId, placement.servingNodeIds);
    await this.assertUpstreamNotAppFrozen(input);
    await assertRegisteredDomainsUseTarget(this.db, input.domainNames, placement);

    // 0b. Validate advanced config if provided
    if (input.advancedConfig && !options.bypassAdvancedValidation) {
      if (/\{\{additionalSecureLinks\./.test(input.advancedConfig)) {
        throw new AppError(
          400,
          'INVALID_SECURE_LINK_REFERENCE',
          'Provision additional Secure Links after creating the proxy host'
        );
      }
      const validation = this.configGenerator.validateAdvancedConfig(input.advancedConfig);
      if (!validation.valid) {
        throw new AppError(
          400,
          'INVALID_ADVANCED_CONFIG',
          `Advanced config is invalid: ${validation.errors.join(', ')}`
        );
      }
    }
    if ((input as any).rawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        (input as any).rawConfig,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    assertSslPrerequisites({
      sslEnabled: input.sslEnabled,
      sslCertificateId: input.sslCertificateId,
      internalCertificateId: input.internalCertificateId,
    });

    const upstreamData = await this.prepareCreateUpstream(input, options);
    if (input.type === 'proxy' && input.upstreamKind === 'pages') {
      await this.assertPagesTemplateCompatible(input.nginxTemplateId);
    }

    // 1. Insert into DB. The node lock makes the domain check and the insert
    // atomic against other creates, moves and enables on this node, so a
    // retried or double-submitted create cannot add a second server block.
    const nodeLockKeys = placement.servingNodeIds.map(proxyNodeLockKey);
    let host = await withProxyLocks(nodeLockKeys, async () => {
      await assertNoProxyDomainOverlapOnNodes(this.db, placement.servingNodeIds, input.domainNames);
      return writeWithAllocatedSlug({
        source: input.domainNames[0] ?? '',
        fallback: 'proxy-host',
        reserved: ['new'],
        constraint: 'proxy_hosts_slug_unique',
        write: async (slug) => {
          const [created] = await this.db
            .insert(proxyHosts)
            .values({
              type: input.type,
              nodeId: input.nodeId,
              ingressGroupId: placement.ingressGroupId,
              domainNames: input.domainNames,
              slug,
              forwardHost: input.forwardHost ?? null,
              forwardPort: input.forwardPort ?? null,
              forwardScheme: input.forwardScheme,
              ...upstreamData,
              sslEnabled: input.sslEnabled,
              sslForced: input.sslForced,
              http2Support: input.http2Support,
              websocketSupport: input.websocketSupport,
              sslCertificateId: input.sslCertificateId ?? null,
              internalCertificateId: input.internalCertificateId ?? null,
              redirectUrl: input.redirectUrl ?? null,
              redirectStatusCode: input.redirectStatusCode ?? 301,
              customHeaders: input.customHeaders,
              cacheEnabled: input.cacheEnabled,
              cacheOptions: input.cacheOptions ?? null,
              rateLimitEnabled: input.rateLimitEnabled,
              rateLimitMode: input.rateLimitMode,
              rateLimitOptions: input.rateLimitOptions ?? null,
              customRewrites: input.customRewrites,
              advancedConfig: input.advancedConfig ?? null,
              rawConfig: (input as any).rawConfig ?? null,
              rawConfigEnabled: (input as any).rawConfigEnabled ?? false,
              accessListId: input.accessListId ?? null,
              folderId: input.folderId ?? null,
              nginxTemplateId: input.nginxTemplateId ?? null,
              templateVariables: input.templateVariables ?? {},
              healthCheckEnabled: input.healthCheckEnabled,
              healthCheckUrl: input.healthCheckUrl ?? '/',
              healthCheckInterval: input.healthCheckInterval ?? 30,
              healthCheckExpectedStatus: input.healthCheckExpectedStatus ?? null,
              healthCheckExpectedBody: input.healthCheckExpectedBody ?? null,
              healthCheckBodyMatchMode: input.healthCheckBodyMatchMode ?? 'includes',
              healthStatus: input.healthCheckEnabled ? 'unknown' : 'disabled',
              createdById: userId,
            })
            .returning()
            .catch(mapProxyHostCertificateReferenceError)
            .catch((error) => rethrowProxyHostDomainConflict(this.db, error));
          return created;
        },
      });
    });

    // 2. Resolve SSL cert paths and build nginx config. The host and node locks
    // fence reconnect cleanup and concurrent edits until the create settles.
    await withProxyLocks([proxyHostLockKey(host.id), ...nodeLockKeys], async () => {
      try {
        if (host.upstreamKind === 'pages') {
          if (!this.pageRoutes || !input.pageProjectId || !input.pageTagId) {
            throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route service is unavailable');
          }
          // A Pages route on an ingress group is materialised on every member.
          const pageNodes = host.ingressGroupId ? await this.ingressNodesOf(host) : host.nodeId!;
          await this.pageRoutes.activateNewHost(host.id, pageNodes, input.pageProjectId, input.pageTagId);
        } else if (isDockerUpstream(host.upstreamKind)) {
          if (!this.secureLinks) throw new Error('Proxy Secure Links are unavailable');
          host = await this.secureLinks.prepare(host, true);
          host = (await this.secureLinks.commitCutover(host.id)) ?? host;
        }
        // 3. Render and apply on every node that serves the route
        await this.deliverHost(host);
        if (isDockerUpstream(host.upstreamKind)) {
          await this.secureLinks?.activate(host.id);
          const availabilityManaged = (await this.availabilityIngressReconciler?.(host.id)) ?? false;
          if (!availabilityManaged) this.queueSecureLinkRuntimeSample(host);
        }
      } catch (error) {
        // 4. If nginx fails, delete the DB row and throw
        logger.error('Failed to apply nginx config for new proxy host, rolling back DB insert', {
          hostId: host.id,
          error,
        });
        // Fence the failed row before any network cleanup. Docker upstream
        // reconciliation runs concurrently and must not be able to re-apply a
        // config after removeConfigFromNode but before the row is deleted.
        await this.db
          .update(proxyHosts)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(proxyHosts.id, host.id));
        // Applying a config can fail after nginx-daemon has already persisted the
        // file (for example while the relay policy is being committed). Remove
        // that partial deployment before deleting the row or a stale server_name
        // can shadow the next successful create for the same domain.
        await this.withdrawHost(host).catch((cleanupError) => {
          logger.warn('Failed to remove partially applied proxy config after create rollback', {
            hostId: host.id,
            cleanupError,
          });
        });
        await this.secureLinks?.cleanup(host).catch((cleanupError) => {
          logger.warn('Failed to cleanup secure link after proxy create rollback', { hostId: host.id, cleanupError });
        });
        let preservePageRouteOwnership = false;
        if (host.upstreamKind === 'pages') {
          try {
            // activateNewHost can return after its own best-effort marker write
            // failed. Persist the failed-create claim before attempting another
            // daemon cleanup so reconciliation never infers ownership from a
            // generic staging row.
            await this.pageRoutes?.claimFailedCreateCleanup(host.id);
            await this.pageRoutes?.removeHost(
              host.id,
              host.ingressGroupId ? await this.ingressNodesOf(host) : host.nodeId
            );
          } catch (cleanupError) {
            preservePageRouteOwnership = true;
            logger.warn('Preserving Pages Route ownership after proxy create rollback cleanup failure', {
              hostId: host.id,
              cleanupError,
            });
            await this.disablePageHostForDeferredCleanup(host.id, cleanupError);
          }
        }
        if (!preservePageRouteOwnership) {
          try {
            await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
          } catch (deleteError) {
            if (host.upstreamKind !== 'pages') throw deleteError;
            preservePageRouteOwnership = true;
            await this.disablePageHostForDeferredCleanup(host.id, deleteError);
          }
        }
        if (error instanceof AppError) throw error;
        throw new AppError(
          500,
          'NGINX_CONFIG_FAILED',
          `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    });

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { type: host.type, domainNames: host.domainNames, ...rawConfigAuditDetails(input, options) },
    });

    logger.info('Created proxy host', { hostId: host.id, domains: host.domainNames });
    await grantCreatedResourcePermissions(userId, 'proxy', host.id, {
      folderId: host.folderId ?? null,
      nodeId: host.nodeId ?? null,
    });
    this.emitHost(host.id, 'created', host.domainNames?.[0]);

    // 6. Fire-and-forget immediate health check
    if (host.healthCheckEnabled) {
      this.runImmediateHealthCheck(host.id);
    }

    await this.refreshAppOverlay(host);

    // 7. Return created host
    return (await attachDockerUpstreamDisplay(this.db, [host]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  async updateProxyHost(
    id: string,
    input: UpdateProxyHostInput,
    userId: string,
    validationOptions: ProxyValidationInput = {}
  ) {
    await this.appFreeze?.assertRoute(id);
    if (this.appFreeze && input.dockerContainerName && !input.dockerNodeId) {
      const [current] = await this.db
        .select({ dockerNodeId: proxyHosts.dockerNodeId })
        .from(proxyHosts)
        .where(eq(proxyHosts.id, id))
        .limit(1);
      await this.assertUpstreamNotAppFrozen(input, current?.dockerNodeId);
    } else {
      await this.assertUpstreamNotAppFrozen(input);
    }
    // Serialize the DB write and node apply with every other change to this
    // host, so the node always serves the last committed row. A move also
    // fences reconnect cleanup on the target node.
    const updated = await withProxyLocks([proxyHostLockKey(id), input.nodeId && proxyNodeLockKey(input.nodeId)], () =>
      this.updateProxyHostLocked(id, input, userId, validationOptions)
    );
    // A type or raw-mode change decides whether the route can carry its environment's maintenance overlay.
    await this.refreshAppOverlay(
      updated as { id: string; folderId?: string | null; appMaintenanceMode?: string | null }
    );
    return updated;
  }

  private async updateProxyHostLocked(
    id: string,
    input: UpdateProxyHostInput,
    userId: string,
    validationOptions: ProxyValidationInput = {}
  ): Promise<ProxyHostView> {
    const options = normalizeProxyValidationOptions(validationOptions);

    // 0. Validate advanced config if provided
    if (input.advancedConfig && !options.bypassAdvancedValidation) {
      const validation = this.configGenerator.validateAdvancedConfig(input.advancedConfig);
      if (!validation.valid) {
        throw new AppError(
          400,
          'INVALID_ADVANCED_CONFIG',
          `Advanced config is invalid: ${validation.errors.join(', ')}`
        );
      }
    }
    if ((input as any).rawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        (input as any).rawConfig,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    // 1. Get existing host
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    // A change between one node and an ingress group (or between groups) is a planned placement change that keeps
    // the route served throughout; the other fields of the request are applied afterwards.
    const placementChange = requestedPlacementChange(existing, input);
    if (placementChange) {
      await this.changeRoutePlacementLocked(existing, placementChange, userId, options);
      const { nodeId: _nodeId, ingressGroupId: _ingressGroupId, ...rest } = input;
      if (Object.keys(rest).length === 0) {
        const moved = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
        return (await attachDockerUpstreamDisplay(this.db, [moved!]))[0]!;
      }
      return this.updateProxyHostLocked(id, rest, userId, validationOptions);
    }
    if (existing.ingressGroupId) {
      // Unchanged placement echoed by a full-object PUT; the primary member is Gateway-maintained.
      delete input.nodeId;
      delete input.ingressGroupId;
    }
    const effectiveRelaySpreadMode = input.relaySpreadMode ?? existing.relaySpreadMode;
    const effectiveRelaySpreadCount =
      input.relaySpreadMode !== undefined && input.relaySpreadMode !== 'fixed'
        ? null
        : input.relaySpreadCount !== undefined
          ? input.relaySpreadCount
          : existing.relaySpreadCount;
    if (effectiveRelaySpreadMode === 'fixed' && effectiveRelaySpreadCount == null) {
      throw new AppError(400, 'RELAY_SPREAD_COUNT_REQUIRED', 'Relay spread count is required in fixed mode');
    }
    if (effectiveRelaySpreadMode !== 'fixed' && effectiveRelaySpreadCount != null) {
      throw new AppError(400, 'RELAY_SPREAD_COUNT_INVALID', 'Relay spread count is only available in fixed mode');
    }
    await this.additionalRoutes?.assertHostTemplateMutationAllowed(
      existing,
      input as unknown as Record<string, unknown>
    );
    if (existing.upstreamKind === 'pages' && (input.type === 'redirect' || input.type === '404')) {
      throw new AppError(
        409,
        'PAGES_ROUTE_TYPE_CHANGE_UNSUPPORTED',
        'Recreate the Route to change its Pages target type'
      );
    }
    if (existing.upstreamKind === 'pages' && (input.type === 'raw' || input.rawConfigEnabled === true)) {
      throw new AppError(400, 'PAGES_ROUTE_SETTINGS_INVALID', 'Pages Routes do not support Raw Config mode');
    }
    if (existing.upstreamKind === 'pages' && input.nginxTemplateId !== undefined) {
      await this.assertPagesTemplateCompatible(input.nginxTemplateId);
    }
    if (existing.upstreamKind === 'pages' && input.websocketSupport === true) {
      throw new AppError(
        400,
        'PAGES_ROUTE_SETTINGS_INVALID',
        'WebSocket upgrades are not available for static Pages Routes'
      );
    }
    if (existing.isSystem && !(options.allowSystemNodeMove && Object.keys(input).every((key) => key === 'nodeId'))) {
      throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be edited');
    }
    if (input.advancedConfig !== undefined) {
      await this.secureLinks?.assertAdditionalReferences(existing.id, input.advancedConfig);
    }
    if (
      existing.maintenanceEnabled &&
      ((input.type !== undefined && input.type !== 'proxy') || input.rawConfigEnabled === true)
    ) {
      throw new AppError(
        409,
        'MAINTENANCE_MODE_CONFLICT',
        'Exit maintenance mode before changing the host type or enabling raw config'
      );
    }

    const storedRawConfig = storedRawConfigForRawModeEnablement(existing, input);
    if (storedRawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        storedRawConfig as string,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    if (input.nodeId && input.nodeId !== existing.nodeId) {
      if ((await this.secureLinks?.listAdditional(existing.id))?.length) {
        throw new AppError(
          409,
          'ADDITIONAL_SECURE_LINK_NODE_MOVE_BLOCKED',
          'Remove additional Secure Link bindings before moving this proxy host to another node'
        );
      }
      await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
      await assertAppPlacement(this.db, 'routes', existing.folderId, [input.nodeId]);
    }
    const effectiveNodeId = input.nodeId ?? existing.nodeId;
    if (!effectiveNodeId) throw new AppError(400, 'NODE_REQUIRED', 'A node must be selected for the proxy host');
    const domainAssignmentChanged =
      (input.nodeId !== undefined && input.nodeId !== existing.nodeId) ||
      (input.domainNames !== undefined && !sameDomainNames(input.domainNames, existing.domainNames));
    if (domainAssignmentChanged && !options.skipDomainNodeValidation) {
      await assertRegisteredDomainsUseTarget(this.db, input.domainNames ?? existing.domainNames, {
        nodeId: effectiveNodeId,
        ingressGroupId: existing.ingressGroupId,
      });
    }
    const servingNodeIds = existing.ingressGroupId ? await this.ingressNodesOf(existing) : [effectiveNodeId];

    assertSslPrerequisitesForUpdate(existing, input);

    const upstreamData = await this.prepareUpdateUpstream(existing, input, options);
    let pageNodeMigration: PageRouteNodeMigration | null = null;
    let additionalRouteMigration: AdditionalRouteNodeMigration | null = null;

    // 2. Update DB
    const { pageProjectId, pageTagId, ...proxyInput } = input;
    const updateData: Record<string, unknown> = {
      ...proxyInput,
      ...upstreamData,
      ...(input.relaySpreadMode !== undefined && input.relaySpreadMode !== 'fixed' ? { relaySpreadCount: null } : {}),
      updatedAt: new Date(),
    };

    // Raw mode bypasses managed upstream settings, so managed health checks are not meaningful.
    const enablesRawMode = input.rawConfigEnabled === true || input.type === 'raw';
    if (enablesRawMode) {
      updateData.healthCheckEnabled = false;
      updateData.healthStatus = 'disabled';
    }

    // Update healthStatus when healthCheckEnabled changes
    if (!enablesRawMode && input.healthCheckEnabled !== undefined) {
      if (!input.healthCheckEnabled) {
        updateData.healthStatus = 'disabled';
      } else if (!existing.healthCheckEnabled) {
        // Was disabled, now enabled — set to unknown until first check
        updateData.healthStatus = 'unknown';
      }
    }

    const updateHost = async (slug?: string) => {
      const write = (executor: DrizzleExecutor) =>
        executor
          .update(proxyHosts)
          .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
          .where(eq(proxyHosts.id, id))
          .returning();
      const [updated] = await (options.restoringPriorState ? restoringProxyHostState(this.db, write) : write(this.db))
        .catch(mapProxyHostCertificateReferenceError)
        .catch((error) => rethrowProxyHostDomainConflict(this.db, error));
      return updated;
    };
    const primaryDomainChanged = input.domainNames !== undefined && input.domainNames[0] !== existing.domainNames[0];
    const writeHost = () =>
      primaryDomainChanged
        ? writeWithAllocatedSlug({
            source: input.domainNames?.[0] ?? '',
            fallback: 'proxy-host',
            reserved: ['new'],
            constraint: 'proxy_hosts_slug_unique',
            write: updateHost,
          })
        : updateHost();
    // A domain change or move of a serving host takes the target node's lock
    // for the overlap check and the write (host lock, then node lock, the same
    // order every other proxy operation uses). An ingress migration's move
    // (skipDomainNodeValidation) skips only the registered-domain node check:
    // two hosts serving one name on the target would still be duplicates.
    let updated =
      domainAssignmentChanged && existing.enabled && !options.restoringPriorState
        ? await withProxyLocks(servingNodeIds.map(proxyNodeLockKey), async () => {
            await assertNoProxyDomainOverlapOnNodes(
              this.db,
              servingNodeIds,
              input.domainNames ?? existing.domainNames,
              id
            );
            return writeHost();
          })
        : await writeHost();

    // The UI can submit a complete form on an unrelated edit. Gate old
    // daemons on an actual TLS or placement change, not on field presence,
    // so existing HTTPS hosts remain editable during a mixed-fleet rollout.
    const tlsReferenceChanged =
      updated.sslEnabled !== existing.sslEnabled ||
      updated.sslCertificateId !== existing.sslCertificateId ||
      updated.internalCertificateId !== existing.internalCertificateId ||
      updated.nodeId !== existing.nodeId;
    const nodeChanged = updated.nodeId !== existing.nodeId;
    const existingUsesRawMode = existing.type === 'raw' || existing.rawConfigEnabled;
    const updatedUsesRawMode = updated.type === 'raw' || updated.rawConfigEnabled;
    const formerDockerNodeId =
      isDockerUpstream(existing.upstreamKind) &&
      isDockerUpstream(updated.upstreamKind) &&
      existing.dockerNodeId &&
      updated.dockerNodeId !== existing.dockerNodeId
        ? existing.dockerNodeId
        : null;
    let appliedOnTargetNode = false;
    // The nodes that took the new config: a later step that fails rolls the database back, and these nodes must
    // serve the restored route again (IG-1), not the rejected one.
    let deliveredNodeIds: string[] = [];

    // 3. Regenerate nginx config
    try {
      if (existing.upstreamKind === 'pages' && updated.nodeId !== existing.nodeId && options.allowPagesNodeMove) {
        if (!existing.nodeId || !updated.nodeId || !this.pageRoutes) {
          throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route migration is unavailable');
        }
        pageNodeMigration = await this.pageRoutes.stageNodeMigration(existing.id, existing.nodeId, updated.nodeId);
      }
      if (nodeChanged && updated.enabled && existing.nodeId && updated.nodeId && this.additionalRoutes) {
        additionalRouteMigration = await this.additionalRoutes.stageNodeMigration(
          existing.id,
          existing.nodeId,
          updated.nodeId
        );
      }
      // Raw mode keeps the Route's Secure Link: the raw config seeded from the rendered one proxies to its socket,
      // and so does the config Gateway still renders while no raw config is stored. The link follows its target as
      // on a managed Route; raw mode only hands the server block over to the user.
      const managesSecureLink =
        isDockerUpstream(updated.upstreamKind) && (!updatedUsesRawMode || existing.secureLinkGeneration > 0);
      if (managesSecureLink) {
        if (!this.secureLinks) throw new Error('Proxy Secure Links are unavailable');
        const requiresSecureLink =
          !updatedUsesRawMode &&
          (existing.upstreamKind === 'manual' ||
            existingUsesRawMode ||
            (existing.secureLinkGeneration < 1 && Object.keys(upstreamData).length > 0));
        updated = await this.secureLinks.prepare(updated, requiresSecureLink, nodeChanged);
        if (updated.secureLinkGeneration > 0 && updated.secureLinkStatus !== 'active') {
          // Existing legacy/manual config must stop serving before the durable
          // no-fallback cutover marker is committed.
          if (existing.secureLinkGeneration === 0 && existing.enabled) {
            await this.withdrawHost(existing);
          }
          updated = (await this.secureLinks.commitCutover(id)) ?? updated;
        }
      }
      if (updated.enabled) {
        // 4. Apply config (on every member of a group route) with rollback on failure
        const delivery = await this.deliverHost(updated, {
          certOptions: { preserveLegacyOnUnsupported: existing.sslEnabled && !tlsReferenceChanged },
          pagesRouteIncludePathOverride: pageNodeMigration?.targetIncludePath,
        });
        deliveredNodeIds = [...delivery.configs.keys()].filter(Boolean);
        if (managesSecureLink) {
          await this.secureLinks?.activate(id);
          this.queueSecureLinkRuntimeSample(updated);
        }
        appliedOnTargetNode = true;

        // The new target is now known-good. Only then retire the former
        // node's config and begin its certificate replica grace period.
        if (nodeChanged && existing.enabled && !options.preserveFormerNodeConfig) {
          await this.removeConfigFromNode(id, existing.nodeId);
          await this.certificateDistribution.deactivateHost(id, existing.nodeId);
        }
      } else {
        // If disabled, remove config and reload
        await this.withdrawHost(nodeChanged ? existing : updated);
      }
      if (updated.upstreamKind === 'pages' && (pageProjectId || pageTagId)) {
        if (!this.pageRoutes || !pageProjectId || !pageTagId) {
          throw new AppError(400, 'PAGES_ROUTE_TARGET_REQUIRED', 'Select both a Page Project and Tag');
        }
        await this.pageRoutes.retarget(id, pageProjectId, pageTagId, userId);
      }
      const leavesManagedDocker = isDockerUpstream(existing.upstreamKind) && !isDockerUpstream(updated.upstreamKind);
      if (leavesManagedDocker && existing.secureLinkGeneration > 0) {
        try {
          await this.secureLinks?.cleanup(existing);
        } catch (cleanupError) {
          // The manual config is already committed. Keep it active and
          // retry the independent Secure Link teardown.
          logger.warn('Proxy left managed Docker mode; Secure Link cleanup will retry', {
            hostId: id,
            cleanupError,
          });
          this.queueDockerReconciliation();
        }
      }
      if (formerDockerNodeId) await this.secureLinks?.reconcileTargetNode(formerDockerNodeId);
      if (pageNodeMigration) await this.pageRoutes?.commitNodeMigration(pageNodeMigration);
      if (additionalRouteMigration) await this.additionalRoutes?.commitNodeMigration(additionalRouteMigration);
    } catch (error) {
      let failure = error;
      if (additionalRouteMigration) {
        try {
          await this.additionalRoutes?.rollbackNodeMigration(additionalRouteMigration);
        } catch (rollbackError) {
          logger.error('Failed to rollback Additional Route node migration', {
            hostId: id,
            migration: additionalRouteMigration,
            rollbackError,
          });
          failure = new AppError(
            500,
            'ADDITIONAL_ROUTE_MIGRATION_ROLLBACK_FAILED',
            'Additional Route migration rollback failed'
          );
        }
      }
      if (pageNodeMigration) {
        try {
          await this.pageRoutes?.rollbackNodeMigration(pageNodeMigration);
        } catch (rollbackError) {
          logger.error('Failed to rollback Pages Route node migration', {
            hostId: id,
            migration: pageNodeMigration,
            rollbackError,
          });
          failure = new AppError(500, 'PAGES_ROUTE_MIGRATION_ROLLBACK_FAILED', 'Pages Route migration rollback failed');
        }
      }
      const currentSecureState = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
      const mustRollForwardSecureLink =
        currentSecureState?.secureLinkMigratedAt != null &&
        (currentSecureState.secureLinkStatus === 'provisioning' ||
          currentSecureState.secureLinkStatus === 'updating' ||
          currentSecureState.secureLinkStatus === 'cutover_ready');
      if (mustRollForwardSecureLink) {
        await this.secureLinks?.markCutoverError(id, failure).catch(() => undefined);
        this.queueDockerReconciliation();
        if (failure instanceof AppError) throw failure;
        throw new AppError(
          500,
          'NGINX_CONFIG_FAILED',
          `Secure Link cutover will retry: ${failure instanceof Error ? failure.message : 'unknown error'}`
        );
      }
      if (nodeChanged && appliedOnTargetNode) {
        try {
          await this.removeConfigFromNode(id, updated.nodeId);
          await this.certificateDistribution.deactivateHost(id, updated.nodeId);
        } catch (cleanupError) {
          logger.warn('Failed to remove new-node config after proxy host move rollback', {
            hostId: id,
            nodeId: updated.nodeId,
            cleanupError,
          });
        }
        if (existing.enabled) {
          try {
            await this.restoreConfigOnNode(existing);
          } catch (restoreError) {
            logger.error('Failed to restore former-node config after proxy host move rollback', {
              hostId: id,
              nodeId: existing.nodeId,
              restoreError,
            });
          }
        }
      }
      // Roll back every field changed by the request or by upstream resolution.
      logger.error('Failed to apply nginx config during update, rolling back DB', {
        hostId: id,
        error: failure,
      });
      const rollbackData: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(proxyInput), ...Object.keys(upstreamData)])) {
        rollbackData[key] = (existing as Record<string, unknown>)[key];
      }
      if (primaryDomainChanged) rollbackData.slug = existing.slug;
      if (isDockerUpstream(existing.upstreamKind) || isDockerUpstream(updated.upstreamKind)) {
        for (const key of [
          'forwardHost',
          'forwardPort',
          'dockerHostPort',
          'secureLinkGeneration',
          'secureLinkStatus',
          'secureLinkLastError',
          'secureLinkTargetNetwork',
          'secureLinkTargetContainer',
          'secureLinkTargetHost',
          'secureLinkListenerPort',
          'secureLinkConnectorPort',
          'secureLinkMigratedAt',
        ] as const) {
          rollbackData[key] = existing[key];
        }
      }
      const rollbackSecureLinkGeneration =
        existing.secureLinkGeneration > 0
          ? Math.max(existing.secureLinkGeneration, updated.secureLinkGeneration) + 1
          : existing.secureLinkGeneration;
      rollbackData.secureLinkGeneration = rollbackSecureLinkGeneration;
      rollbackData.updatedAt = existing.updatedAt;
      try {
        // nginx still serves the previous state: restore it even when another host took one of its names meanwhile.
        await restoringProxyHostState(this.db, (tx) =>
          tx.update(proxyHosts).set(rollbackData).where(eq(proxyHosts.id, id))
        );
        if (updated.secureLinkGeneration > 0 && existing.secureLinkGeneration === 0) {
          await this.secureLinks?.cleanup(updated);
        } else if (existing.secureLinkGeneration > 0) {
          await this.secureLinks?.reconcileExisting({
            ...existing,
            secureLinkGeneration: rollbackSecureLinkGeneration,
          });
          if (formerDockerNodeId && updated.dockerNodeId) {
            await this.secureLinks?.reconcileTargetNode(updated.dockerNodeId);
          }
        }
      } catch (rollbackError) {
        logger.error('Failed to rollback DB after nginx config failure', {
          hostId: id,
          rollbackError,
        });
      }
      // Nodes that already took the new config serve the restored row again: a group member the delivery reached
      // before another member failed, and every node that took it when a later step failed (the Secure Link
      // activation, IG-1). Re-delivering also records what each member serves, so the delivery state is true.
      const appliedNodeIds =
        failure instanceof IngressDeliveryError ? failure.appliedNodeIds : nodeChanged ? [] : deliveredNodeIds;
      if (appliedNodeIds.length > 0 && existing.enabled) {
        try {
          const restored = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
          if (restored?.enabled) {
            await this.deliverHost(restored, {
              certOptions: { preserveLegacyOnUnsupported: true },
              ...(restored.ingressGroupId ? { nodeIds: appliedNodeIds } : {}),
            });
          }
        } catch (restoreError) {
          logger.error('Failed to restore the route on the nodes that took the rejected config', {
            hostId: id,
            nodeIds: appliedNodeIds,
            restoreError,
          });
        }
      }
      if (failure instanceof AppError) throw failure;
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${failure instanceof Error ? failure.message : 'unknown error'}`
      );
    }

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.update',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { changes: Object.keys(input), ...rawConfigAuditDetails(input, options) },
    });

    logger.info('Updated proxy host', { hostId: id });
    this.emitHost(
      id,
      'updated',
      updated.domainNames?.[0],
      updated.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: updated.slug }
    );

    // Fire immediate health check if healthcheck was just enabled
    if (input.healthCheckEnabled && !existing.healthCheckEnabled && updated.enabled) {
      this.runImmediateHealthCheck(id);
    }

    if (
      updated.relaySpreadMode !== existing.relaySpreadMode ||
      updated.relaySpreadCount !== existing.relaySpreadCount
    ) {
      await this.relayPool?.stageProxyWorkloadRebalance(id, userId).catch((error) => {
        logger.warn('Failed to stage Relay Pool redistribution after workload spread update', {
          hostId: id,
          error,
        });
      });
    }

    return (await attachDockerUpstreamDisplay(this.db, [updated]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------
}
