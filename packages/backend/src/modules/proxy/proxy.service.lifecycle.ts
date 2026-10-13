import { eq } from 'drizzle-orm';
import { accessLists } from '@/db/schema/access-lists.js';
import { certificates } from '@/db/schema/certificates.js';
import { ingressGroups, proxyHosts } from '@/db/schema/index.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import { ingressGroupMemberRows } from '@/modules/ingress-groups/ingress-nodes.js';
import { stripProxyHealthHistory } from './proxy.service-helpers.js';
import { withProxyHostLock } from './proxy-host-lock.js';
import { forgetIngressMemberDeliveries, listIngressMemberDeliveries } from './proxy-ingress-delivery.js';
import type { CreateProxyAdditionalSecureLinkInput } from './proxy-secure-link.service.js';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';

export { __testOnly } from './proxy.service-helpers.js';

import { logger, type ProxyHostRow } from './proxy.service.core.js';
import { ProxyServiceMutations } from './proxy.service.mutations.js';

export abstract class ProxyServiceLifecycle extends ProxyServiceMutations {
  // One replaceable token fences stale collection snapshots, without retaining
  // deleted resource IDs. Already-started samples have their own write leases.
  protected secureLinkRuntimeCollectionEpoch: object = {};

  async deleteProxyHost(id: string, userId: string, options: { abandonOfflineNode?: boolean } = {}) {
    // A route the app kill switch holds stays until it is turned off (the node of a route that is abandoned with its
    // offline node is gone either way). A shut-down app holds nothing: Start skips a route deleted meanwhile.
    if (!options.abandonOfflineNode) await this.appFreeze?.assertRoute(id);
    return withProxyHostLock(id, () => this.deleteProxyHostLocked(id, userId, options));
  }

  private async deleteProxyHostLocked(id: string, userId: string, options: { abandonOfflineNode?: boolean }) {
    // 1. Get existing host
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    if (existing.isSystem && !options.abandonOfflineNode) {
      throw new AppError(403, 'SYSTEM_HOST', 'System routes cannot be deleted');
    }
    // Capture child keys before cleanup removes the bindings from persistence.
    const additionalLinks = (await this.secureLinks?.listAdditional?.(id)) ?? [];

    // A route on an ingress group is removed from its connected members; an offline member drops the stale config
    // in the full sync that follows its reconnect resync, so a group route never needs the abandon path.
    const abandoningOfflineNode = options.abandonOfflineNode === true && !existing.ingressGroupId;
    if (abandoningOfflineNode) {
      if (this.nodeDispatch.isNodeConnected(existing.nodeId)) {
        throw new AppError(409, 'NGINX_NODE_CONNECTED', 'Connected Nginx nodes require confirmed config cleanup');
      }
      if (existing.nodeId) {
        await this.certificateDistribution.deactivateHost(id, existing.nodeId);
      }
      await this.secureLinks?.abandonOfflineSource(existing);
    } else {
      // Preserve the currently active deployment until Nginx has confirmed
      // the config removal. This avoids GCing a certificate for a still-serving host.
      try {
        await this.withdrawHost(existing);
      } catch (error) {
        throw new AppError(
          500,
          'NGINX_CONFIG_FAILED',
          `Failed to remove Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    }

    // 3. Delete the database row only after the active deployment is safely gone.
    if (!abandoningOfflineNode) {
      await this.secureLinks?.cleanupAdditionalForHost(existing);
      await this.secureLinks?.cleanup(existing);
    }
    if (existing.upstreamKind === 'pages') {
      await this.pageRoutes?.removeHost(
        id,
        existing.ingressGroupId ? await this.ingressNodesOf(existing) : existing.nodeId,
        abandoningOfflineNode
      );
    }
    await this.additionalRoutes?.cleanupForHost(existing, abandoningOfflineNode);
    try {
      await transactionWithScopeCleanup(this.db, (tx) => tx.delete(proxyHosts).where(eq(proxyHosts.id, id)));
    } catch (error) {
      if (existing.upstreamKind === 'pages') {
        await this.disablePageHostForDeferredCleanup(id, error);
      }
      throw error;
    }

    if (existing.ingressGroupId) await forgetIngressMemberDeliveries(this.db, id);
    await this.secureLinks?.releaseOrphanedRelayState?.();
    this.forgetSecureLinkRuntime(id);
    this.hostConfigEpochs.delete(id);
    for (const binding of additionalLinks) this.forgetSecureLinkRuntime(`additional:${binding.id}`);

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.delete',
      resourceType: 'proxy_host',
      resourceId: id,
      details: {
        domainNames: existing.domainNames,
        abandonedOfflineNode: abandoningOfflineNode,
        ...(abandoningOfflineNode ? { nodeId: existing.nodeId, orphanedNginxConfigPossible: true } : {}),
      },
    });

    logger.info('Deleted route', { hostId: id, domains: existing.domainNames });
    this.emitHost(id, 'deleted', existing.domainNames?.[0]);
    this.reconcileMaintenanceAlerts(id);
  }

  // -----------------------------------------------------------------------
  // Get single
  // -----------------------------------------------------------------------

  async getProxyHost(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    if (host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');

    // Resolve relations
    const sslCert = host.sslCertificateId
      ? await this.db.query.sslCertificates.findFirst({
          where: eq(sslCertificates.id, host.sslCertificateId),
        })
      : null;

    const internalCert = host.internalCertificateId
      ? await this.db.query.certificates.findFirst({
          where: eq(certificates.id, host.internalCertificateId),
        })
      : null;

    const accessList = host.accessListId
      ? await this.db.query.accessLists.findFirst({
          where: eq(accessLists.id, host.accessListId),
        })
      : null;
    const tlsDistribution = await this.certificateDistribution.getStatusForHost(host);
    const ingress = await this.ingressPlacementView(host);
    const [displayHost] = await attachDockerUpstreamDisplay(this.db, [host]);
    return {
      ...stripProxyHealthHistory(displayHost!),
      sslCertificate: sslCert
        ? {
            id: sslCert.id,
            name: sslCert.name,
            type: sslCert.type,
            domainNames: sslCert.domainNames,
            status: sslCert.status,
            notAfter: sslCert.notAfter,
          }
        : null,
      internalCertificate: internalCert
        ? {
            id: internalCert.id,
            commonName: internalCert.commonName,
            status: internalCert.status,
            notAfter: internalCert.notAfter,
          }
        : null,
      accessList: accessList
        ? {
            id: accessList.id,
            name: accessList.name,
          }
        : null,
      tlsDistribution,
      ...ingress,
      pageTarget: displayHost?.pageTarget ?? null,
    };
  }

  /**
   * Where a route is served: the nodes, and for a route on an ingress group the group, its members and the
   * per-member delivery (config and certificate version each member confirmed, pending or failed with the reason).
   */
  protected async ingressPlacementView(host: ProxyHostRow) {
    const servingNodeIds = await this.ingressNodesOf(host);
    if (!host.ingressGroupId) return { servingNodeIds, ingressGroup: null, ingressDelivery: [] };
    const [group, members, deliveries] = await Promise.all([
      this.db.query.ingressGroups.findFirst({
        where: eq(ingressGroups.id, host.ingressGroupId),
        columns: { id: true, name: true, slug: true, dnsFailoverMode: true },
      }),
      ingressGroupMemberRows(this.db, host.ingressGroupId),
      listIngressMemberDeliveries(this.db, [host.id]),
    ]);
    return {
      servingNodeIds,
      ingressGroup: group
        ? {
            ...group,
            members: members.map((member) => ({
              nodeId: member.nodeId,
              state: member.state,
              priority: member.priority,
            })),
          }
        : null,
      ingressDelivery: members.map((member) => {
        const delivery = deliveries.find((candidate) => candidate.nodeId === member.nodeId);
        return {
          nodeId: member.nodeId,
          status: !host.enabled ? 'disabled' : (delivery?.status ?? 'pending'),
          appliedConfigHash: delivery?.appliedConfigHash ?? null,
          desiredConfigHash: delivery?.desiredConfigHash ?? null,
          appliedCertificateVersion: delivery?.appliedCertificateVersion ?? null,
          desiredCertificateVersion: delivery?.desiredCertificateVersion ?? null,
          lastError: delivery?.lastError ?? null,
          appliedAt: delivery?.appliedAt ?? null,
        };
      }),
    };
  }

  async getProxyHostBySlug(slug: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.slug, slug),
      columns: { id: true, isSystem: true },
    });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    return this.getProxyHost(host.id);
  }

  async getProxyHostHealthHistory(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
      columns: { id: true, isSystem: true, healthHistory: true },
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    if (host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    return host.healthHistory ?? [];
  }

  async listAdditionalSecureLinks(id: string) {
    await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    const [bindings, routes] = await Promise.all([
      this.secureLinks.listAllAdditional(id),
      this.additionalRoutes?.list(id) ?? Promise.resolve([]),
    ]);
    const routePaths = new Map(routes.map((route) => [route.id, route.path]));
    return bindings.map((binding) => ({
      ...binding,
      managedRoutePath:
        binding.purpose === 'additional_route' && binding.referenceId
          ? (routePaths.get(binding.referenceId) ?? null)
          : null,
    }));
  }

  async createAdditionalSecureLink(
    id: string,
    input: CreateProxyAdditionalSecureLinkInput,
    userId: string,
    actorScopes?: string[]
  ) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    await this.appFreeze?.assertRoute(id);
    await this.assertUpstreamNotAppFrozen(input);
    const binding = await this.secureLinks.createAdditional(host, input, actorScopes);
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.create',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { bindingId: binding.id, name: binding.name, target: binding.targetContainer },
    });
    return binding;
  }

  async retryAdditionalSecureLink(id: string, bindingId: string, userId: string, actorScopes?: string[]) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    await this.appFreeze?.assertRoute(id);
    const binding = await this.secureLinks.retryAdditional(host, bindingId, actorScopes);
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.retry',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { bindingId, name: binding.name },
    });
    return binding;
  }

  /**
   * Points an Additional Secure Link at another target without deleting it,
   * so its name and id stay valid in the Route config. When the scheme
   * changes (a managed storage cluster with TLS replacing one without), the
   * Route config that renders the link upstream is applied again; when that
   * fails, the retarget fails and a managed storage link goes back to its
   * previous cluster.
   */
  async retargetAdditionalSecureLink(
    id: string,
    bindingId: string,
    input: Omit<CreateProxyAdditionalSecureLinkInput, 'name'>,
    userId: string,
    actorScopes?: string[]
  ) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    await this.appFreeze?.assertRoute(id);
    await this.assertUpstreamNotAppFrozen(input);
    const before = (await this.secureLinks.listAdditional(id)).find((binding) => binding.id === bindingId);
    // The Route upstream for the link carries its scheme, so a scheme change
    // must reach nginx; a failure fails (and rolls back) the retarget. After
    // an attempt, the rollback applies the config again for the old scheme.
    let applied = false;
    const binding = await this.secureLinks.retargetAdditional(host, bindingId, input, actorScopes, async (link) => {
      if (!applied && before?.forwardScheme === link.forwardScheme) return;
      applied = true;
      await this.reapplyHostConfig(id);
    });
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.retarget',
      resourceType: 'proxy_host',
      resourceId: id,
      details: {
        bindingId,
        name: binding.name,
        from: before
          ? {
              upstreamKind: before.upstreamKind,
              managedStorageId: before.managedStorageId,
              target: before.targetContainer,
            }
          : null,
        to: {
          upstreamKind: binding.upstreamKind,
          managedStorageId: binding.managedStorageId,
          target: binding.targetContainer,
        },
        status: binding.status,
      },
    });
    return binding;
  }

  async deleteAdditionalSecureLink(id: string, bindingId: string, userId: string) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    await this.appFreeze?.assertRoute(id);
    await this.secureLinks.deleteAdditional(host, bindingId);
    this.forgetSecureLinkRuntime(`additional:${bindingId}`);
    this.queueDockerReconciliation(true);
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.delete',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { bindingId },
    });
  }

  protected forgetSecureLinkRuntime(key: string): void {
    this.secureLinkRuntimeCollectionEpoch = {};
    this.secureLinkRuntimeHistory.delete(key);
    // The promise itself is the write lease: removing it fences late samples
    // without retaining a tombstone for every deleted host/binding.
    this.secureLinkRuntimeSamplesInFlight.delete(key);
  }
}
