import { eq } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import { nodes, proxyHosts } from '@/db/schema/index.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  INTERNAL_REGISTRY_INGRESS_ID,
  INTERNAL_REGISTRY_INGRESS_PORT,
} from '@/modules/docker/docker-registry.constants.js';
import { assertCanPlaceOnMembers } from '@/modules/ingress-groups/ingress-group-access.js';
import { requireRoutableIngressGroup } from '@/modules/ingress-groups/ingress-group-routing.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import {
  buildStatusPageSystemHostRollbackData,
  defaultStatusPageUpstreamUrl,
  getStatusPageUpstream,
} from './proxy.service-helpers.js';
import { clearDockerUpstreamFields } from './proxy-docker-upstream.service.js';
import { restoringProxyHostState, rethrowProxyHostDomainConflict } from './proxy-domain-overlap.js';
import { proxyHostLockKey, proxyNodeLockKey, withProxyLocks } from './proxy-host-lock.js';

export { __testOnly } from './proxy.service-helpers.js';

import {
  logger,
  type ProxyHostRow,
  type RegistrySystemHostInput,
  type StatusPageSystemHostInput,
} from './proxy.service.core.js';
import { ProxyServiceReconciliation } from './proxy.service.reconciliation.js';

export class ProxyServiceSystemHosts extends ProxyServiceReconciliation {
  protected webTransportSettings?: Pick<WebTransportSettingsService, 'getConfig'>;

  /** Gateway's web listener protocol, which the default status page upstream follows. */
  setWebTransportSettings(settings: Pick<WebTransportSettingsService, 'getConfig'>) {
    this.webTransportSettings = settings;
  }

  /**
   * Without a configured upstream URL, the status page ingress node reaches
   * Gateway on loopback only when it runs on the Gateway host; any other node
   * uses the Gateway address nodes enroll with.
   */
  private async resolveStatusPageUpstreamUrl(nodeId: string | null, upstreamUrl: string | null | undefined) {
    if (upstreamUrl) return upstreamUrl;
    // On an ingress group every member renders the same upstream, so it is the address nodes enroll with
    // (a member on the Gateway host reaches it there too).
    const node = nodeId
      ? await this.db.query.nodes.findFirst({
          where: eq(nodes.id, nodeId),
          columns: { lastHealthReport: true },
        })
      : null;
    const endpoints = await this.generalSettings?.getOpfieldEndpointSettings().catch(() => null);
    const transport = await this.webTransportSettings?.getConfig().catch(() => null);
    const env = getEnv();
    return defaultStatusPageUpstreamUrl({
      nodeAddresses: [
        ...(node?.lastHealthReport?.localIpAddresses ?? []),
        ...(node?.lastHealthReport?.publicIpAddresses ?? []),
      ],
      opfieldHostAddresses: env.OPFIELD_LOCAL_HOSTS?.split(',') ?? [],
      opfieldLocalTarget: endpoints?.grpcLocalIp,
      opfieldPublicTarget: endpoints?.grpcPublicTarget,
      tlsEnabled: transport?.tlsEnabled === true,
      port: env.PORT,
    });
  }

  /**
   * Serialize one system-host kind and fence the host plus its target node
   * against concurrent edits and reconnect cleanup. Keys are taken together in
   * sorted order, so the current host id is read before locking.
   */
  private async withSystemHostLocks<T>(
    kind: 'status_page' | 'docker_registry',
    targetNodeIds: string | readonly string[] | null,
    fn: () => Promise<T>
  ): Promise<T> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, kind),
      columns: { id: true },
    });
    const nodeIds = targetNodeIds === null ? [] : typeof targetNodeIds === 'string' ? [targetNodeIds] : targetNodeIds;
    return withProxyLocks(
      [`proxy-system:${kind}`, existing && proxyHostLockKey(existing.id), ...nodeIds.map(proxyNodeLockKey)],
      fn
    );
  }

  /**
   * The status page route is placed for the caller who configures it, so its node, or every member of its ingress
   * group (which the caller must be able to view), needs proxy:create as a route of the caller's own would.
   */
  async assertSystemHostPlacementAccess(
    scopes: readonly string[],
    placement: { nodeId: string | null; ingressGroupId: string | null }
  ): Promise<void> {
    if (placement.ingressGroupId) {
      const group = await requireRoutableIngressGroup(this.db, placement.ingressGroupId, scopes);
      assertCanPlaceOnMembers(scopes, 'proxy:create', null, group.memberNodeIds);
      return;
    }
    if (placement.nodeId && hasScopeForCreation(scopes, 'proxy:create', null, placement.nodeId)) return;
    throw new AppError(403, 'FORBIDDEN', 'Missing proxy:create permission for the selected nginx node', {
      requiredScope: placement.nodeId ? `proxy:create:node/${placement.nodeId}` : 'proxy:create',
    });
  }

  async upsertStatusPageSystemHost(input: StatusPageSystemHostInput, userId: string): Promise<ProxyHostRow> {
    const group = input.ingressGroupId ? await requireRoutableIngressGroup(this.db, input.ingressGroupId) : null;
    return this.withSystemHostLocks('status_page', group ? group.memberNodeIds : input.nodeId, () =>
      this.upsertStatusPageSystemHostLocked(
        group
          ? { ...input, nodeId: group.primaryNodeId, ingressGroupId: group.group.id }
          : { ...input, ingressGroupId: null },
        userId,
        group?.memberNodeIds ?? [input.nodeId]
      )
    );
  }

  private async upsertStatusPageSystemHostLocked(
    input: StatusPageSystemHostInput,
    userId: string,
    servingNodeIds: string[]
  ): Promise<ProxyHostRow> {
    let existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'status_page'),
    });
    const ingressGroupId = input.ingressGroupId ?? null;
    if (existing && (existing.ingressGroupId ?? null) !== ingressGroupId) {
      // Between one node and an ingress group without downtime: a node that serves the page keeps serving it.
      existing = await this.changeRoutePlacementLocked(
        existing,
        { ingressGroupId, nodeId: ingressGroupId ? null : input.nodeId },
        userId,
        { allowSystemNodeMove: true }
      );
    }
    const previouslyServing = existing ? await this.ingressNodesOf(existing) : [];
    for (const nodeId of servingNodeIds) {
      if (!previouslyServing.includes(nodeId)) await assertNodeAllowsServiceCreation(this.db, nodeId, 'nginx');
    }
    const sslEnabled = !!input.sslCertificateId;
    const upstream = getStatusPageUpstream(
      await this.resolveStatusPageUpstreamUrl(ingressGroupId ? null : input.nodeId, input.upstreamUrl)
    );
    const data = {
      type: 'proxy' as const,
      domainNames: [input.domain],
      enabled: true,
      forwardHost: upstream.host,
      forwardPort: upstream.port,
      forwardScheme: upstream.scheme,
      sslEnabled,
      sslForced: sslEnabled,
      http2Support: true,
      websocketSupport: false,
      sslCertificateId: input.sslCertificateId ?? null,
      internalCertificateId: null,
      redirectUrl: null,
      redirectStatusCode: 301,
      customHeaders: [],
      cacheEnabled: false,
      cacheOptions: null,
      rateLimitEnabled: false,
      rateLimitOptions: null,
      customRewrites: [],
      advancedConfig: null,
      rawConfig: null,
      rawConfigEnabled: false,
      accessListId: null,
      folderId: null,
      nginxTemplateId: input.nginxTemplateId ?? null,
      templateVariables: {},
      nodeId: input.nodeId,
      ingressGroupId,
      healthCheckEnabled: false,
      healthCheckUrl: '/',
      healthCheckInterval: 30,
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: 'includes' as const,
      healthCheckSlowThreshold: 3,
      healthStatus: 'disabled' as const,
      isSystem: true,
      systemKind: 'status_page',
      updatedAt: new Date(),
    };

    const createdNew = !existing;
    const writeHost = async (slug?: string) => {
      const [host] = existing
        ? await this.db
            .update(proxyHosts)
            .set({ ...data, ...(slug === undefined ? {} : { slug }) })
            .where(eq(proxyHosts.id, existing.id))
            .returning()
        : await this.db
            .insert(proxyHosts)
            .values({
              ...data,
              slug: slug!,
              createdById: userId,
            })
            .returning();
      return host;
    };
    const primaryDomainChanged = !existing || existing.domainNames[0] !== input.domain;
    // A name another enabled host on the node already serves is refused by the database (409).
    const host = await (primaryDomainChanged
      ? writeWithAllocatedSlug({
          source: input.domain,
          fallback: 'proxy-host',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: writeHost,
        })
      : writeHost()
    ).catch((error) => rethrowProxyHostDomainConflict(this.db, error));

    try {
      await this.deliverHost(host);
    } catch (error) {
      logger.error('Failed to apply status page system proxy host config', {
        hostId: host.id,
        error,
      });
      if (createdNew) {
        await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
      } else if (existing) {
        await restoringProxyHostState(this.db, (tx) =>
          tx
            .update(proxyHosts)
            .set({ ...buildStatusPageSystemHostRollbackData(existing), slug: existing.slug } as any)
            .where(eq(proxyHosts.id, existing.id))
        );
      }
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply status page proxy config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: existing ? 'proxy_host.system_update' : 'proxy_host.system_create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { systemKind: 'status_page', domain: input.domain, nodeId: input.nodeId, ingressGroupId },
    });
    this.emitHost(host.id, 'updated', input.domain);
    return host;
  }

  async disableStatusPageSystemHost(userId: string): Promise<ProxyHostRow | null> {
    return this.withSystemHostLocks('status_page', null, () => this.disableStatusPageSystemHostLocked(userId));
  }

  private async disableStatusPageSystemHostLocked(userId: string): Promise<ProxyHostRow | null> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'status_page'),
    });
    if (!existing) return null;

    try {
      await this.withdrawHost(existing);
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, existing.id));
    } catch (error) {
      logger.error('Failed to remove status page system proxy host config', {
        hostId: existing.id,
        error,
      });
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to disable status page proxy config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: 'proxy_host.system_disable',
      resourceType: 'proxy_host',
      resourceId: existing.id,
      details: { systemKind: 'status_page' },
    });
    this.emitHost(existing.id, 'deleted', existing.domainNames?.[0]);
    return existing;
  }

  async upsertRegistrySystemHost(input: RegistrySystemHostInput, userId: string | null): Promise<ProxyHostRow> {
    return this.withSystemHostLocks('docker_registry', input.nodeId, () =>
      this.upsertRegistrySystemHostLocked(input, userId)
    );
  }

  private async upsertRegistrySystemHostLocked(
    input: RegistrySystemHostInput,
    userId: string | null
  ): Promise<ProxyHostRow> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'docker_registry'),
    });
    if (!existing || existing.nodeId !== input.nodeId) {
      await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    }
    const data = {
      type: 'proxy' as const,
      domainNames: [input.domain],
      enabled: true,
      upstreamKind: 'manual' as const,
      forwardHost: '127.0.0.1',
      forwardPort: INTERNAL_REGISTRY_INGRESS_PORT,
      forwardScheme: 'http' as const,
      ...clearDockerUpstreamFields(),
      sslEnabled: true,
      sslForced: true,
      http2Support: true,
      websocketSupport: false,
      sslCertificateId: input.sslCertificateId,
      internalCertificateId: null,
      redirectUrl: null,
      redirectStatusCode: 301,
      customHeaders: [],
      cacheEnabled: false,
      cacheOptions: null,
      rateLimitEnabled: false,
      rateLimitOptions: null,
      customRewrites: [],
      advancedConfig: ['client_max_body_size 0;', 'proxy_request_buffering off;', 'proxy_buffering off;'].join('\n'),
      rawConfig: null,
      rawConfigEnabled: false,
      accessListId: null,
      folderId: null,
      nginxTemplateId: null,
      templateVariables: {},
      nodeId: input.nodeId,
      healthCheckEnabled: false,
      healthCheckUrl: '/v2/',
      healthCheckInterval: 30,
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: 'includes' as const,
      healthCheckSlowThreshold: 3,
      healthStatus: 'disabled' as const,
      isSystem: true,
      systemKind: 'docker_registry',
      updatedAt: new Date(),
    };

    const createdNew = !existing;
    const previousNodeId = existing?.nodeId ?? null;
    const writeHost = async (slug?: string) => {
      const [host] = existing
        ? await this.db
            .update(proxyHosts)
            .set({ ...data, ...(slug === undefined ? {} : { slug }) })
            .where(eq(proxyHosts.id, existing.id))
            .returning()
        : userId
          ? await this.db
              .insert(proxyHosts)
              .values({
                id: INTERNAL_REGISTRY_INGRESS_ID,
                ...data,
                slug: slug!,
                createdById: userId,
              })
              .returning()
          : (() => {
              throw new AppError(
                503,
                'REGISTRY_INGRESS_OWNER_UNAVAILABLE',
                'Registry ingress cannot be recreated without its original owner'
              );
            })();
      return host;
    };
    const primaryDomainChanged = !existing || existing.domainNames[0] !== input.domain;
    // A name another enabled host on the node already serves is refused by the database (409).
    const host = await (primaryDomainChanged
      ? writeWithAllocatedSlug({
          source: input.domain,
          fallback: 'internal-registry',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: writeHost,
        })
      : writeHost()
    ).catch((error) => rethrowProxyHostDomainConflict(this.db, error));

    try {
      const certPaths = await this.resolveCertPaths(host);
      const config = await this.buildNginxConfig(host, certPaths, null);
      await this.applyConfigToNode(host.id, config, host.nodeId, certPaths.preparedTls, 'user_owned');
      if (previousNodeId && previousNodeId !== host.nodeId) {
        try {
          await this.removeConfigFromNode(host.id, previousNodeId);
          await this.certificateDistribution.deactivateHost(host.id, previousNodeId);
        } catch (cleanupError) {
          logger.warn('Registry ingress moved but old Nginx config requires deferred cleanup', {
            hostId: host.id,
            nodeId: previousNodeId,
            error: cleanupError,
          });
        }
      }
    } catch (error) {
      logger.error('Failed to apply internal registry system proxy host config', { hostId: host.id, error });
      if (createdNew) {
        await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
      } else if (existing) {
        await restoringProxyHostState(this.db, (tx) =>
          tx
            .update(proxyHosts)
            .set({ ...buildStatusPageSystemHostRollbackData(existing), slug: existing.slug } as any)
            .where(eq(proxyHosts.id, existing.id))
        );
      }
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply registry ingress config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: existing ? 'proxy_host.system_update' : 'proxy_host.system_create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { systemKind: 'docker_registry', domain: input.domain, nodeId: input.nodeId },
    });
    this.emitHost(host.id, 'updated', input.domain);
    return host;
  }

  async disableRegistrySystemHost(userId: string | null): Promise<ProxyHostRow | null> {
    return this.withSystemHostLocks('docker_registry', null, () => this.disableRegistrySystemHostLocked(userId));
  }

  private async disableRegistrySystemHostLocked(userId: string | null): Promise<ProxyHostRow | null> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'docker_registry'),
    });
    if (!existing) return null;
    try {
      await this.removeConfigFromNode(existing.id, existing.nodeId);
      await this.certificateDistribution.deactivateHost(existing.id, existing.nodeId);
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, existing.id));
    } catch (error) {
      logger.error('Failed to remove internal registry system proxy host config', { hostId: existing.id, error });
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to disable registry ingress config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
    await this.auditService.log({
      userId,
      action: 'proxy_host.system_disable',
      resourceType: 'proxy_host',
      resourceId: existing.id,
      details: { systemKind: 'docker_registry' },
    });
    this.emitHost(existing.id, 'deleted', existing.domainNames?.[0]);
    return existing;
  }

  // -----------------------------------------------------------------------
  // Validate advanced config snippet
  // -----------------------------------------------------------------------
}
