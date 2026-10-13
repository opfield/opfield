import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { domains, nodes, proxyAdditionalRoutes, proxyAdditionalSecureLinks, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { proxyHostsServedByNode } from '@/modules/ingress-groups/ingress-nodes.js';
import { effectiveMaintenance, IN_EFFECTIVE_MAINTENANCE } from './effective-maintenance.js';
import { runImmediateProxyHealthCheck } from './proxy-health-check.js';
import {
  proxyHostLockKey,
  proxyNodeLockKey,
  runOutsideProxyLocks,
  withProxyHostLock,
  withProxyLocks,
} from './proxy-host-lock.js';

export { __testOnly } from './proxy.service-helpers.js';

import { isNodeNotConnectedError } from '@/services/node-connection-errors.js';
import { isDockerUpstream, logger, type ProxyHostRow } from './proxy.service.core.js';
import { ProxyServiceListing } from './proxy.service.listing.js';
import { rawConfigUsesSecureLink } from './proxy.service-helpers.js';

interface AppliedNodeHostConfig {
  config: string;
  configOwnership: string;
  epoch: number;
}

export class ProxyServiceReconciliation extends ProxyServiceListing {
  async reconcileDockerContainerRecreate(_nodeId: string): Promise<void> {
    await this.reconcileDockerUpstreams(true);
  }

  protected runImmediateHealthCheck(hostId: string): void {
    runOutsideProxyLocks(() =>
      runImmediateProxyHealthCheck({
        db: this.db,
        hostId,
        logger,
        nodeDispatch: this.nodeDispatch,
        eventBus: this.eventBus,
      })
    );
  }

  protected async refreshExternalBranding(): Promise<void> {
    // The 404 page, and the maintenance page: rendered during maintenance, and in every managed route on a node that
    // keeps maintenance flags. The changes of a node load with one reload.
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(
        eq(proxyHosts.enabled, true),
        or(
          eq(proxyHosts.type, '404'),
          IN_EFFECTIVE_MAINTENANCE,
          and(eq(proxyHosts.type, 'proxy'), eq(proxyHosts.isSystem, false), eq(proxyHosts.rawConfigEnabled, false))
        )
      ),
    });
    for (const host of hosts) {
      // A node without a control session renders the current branding in its reconnect sync.
      if (host.nodeId && !this.nodeDispatch.isNodeConnected(host.nodeId)) continue;
      try {
        await this.reapplyHostConfig(host.id, { deferReload: true, reuseActiveBundle: true });
      } catch (error) {
        if (!isNodeNotConnectedError(error)) throw error;
      }
    }
  }

  protected queueDockerReconciliation(force = false): void {
    if (!this.dockerUpstreams) return;
    this.dockerReconcileDirty = true;
    this.dockerReconcileForce ||= force;
    if (this.dockerReconcileRunning) return;
    this.dockerReconcileRunning = true;
    // Detached: callers often hold a per-host lock that this pass must wait for, not inherit.
    runOutsideProxyLocks(() => this.runDockerReconciliationLoop());
  }

  private runDockerReconciliationLoop(): void {
    void (async () => {
      try {
        do {
          this.dockerReconcileDirty = false;
          const reconcileForce = this.dockerReconcileForce;
          this.dockerReconcileForce = false;
          await this.reconcileDockerUpstreams(reconcileForce);
        } while (this.dockerReconcileDirty);
      } catch (error) {
        logger.error('Docker proxy upstream reconciliation failed', { error });
        this.scheduleDockerReconciliationRetry();
      } finally {
        this.dockerReconcileRunning = false;
        if (this.dockerReconcileDirty) this.queueDockerReconciliation();
        if (this.secureLinkRuntimeCollectionPending) {
          void this.collectSecureLinkRuntimeSnapshots();
        }
      }
    })();
  }

  protected scheduleDockerReconciliationRetry(): void {
    if (this.dockerReconcileRetry) return;
    const delay = this.dockerReconcileBackoffMs;
    this.dockerReconcileBackoffMs = Math.min(this.dockerReconcileBackoffMs * 2, 5 * 60_000);
    this.dockerReconcileRetry = runOutsideProxyLocks(() =>
      setTimeout(() => {
        this.dockerReconcileRetry = undefined;
        this.queueDockerReconciliation(true);
      }, delay)
    );
  }

  protected async updateRenamedContainerReferences(nodeId: string, oldName: string, newName: string): Promise<void> {
    const updated = await this.db.transaction(async (tx) => {
      const hosts = await tx
        .update(proxyHosts)
        .set({
          dockerContainerName: newName,
          secureLinkTargetContainer: sql`case
            when ${proxyHosts.secureLinkTargetContainer} = ${oldName} then ${newName}
            else ${proxyHosts.secureLinkTargetContainer}
          end`,
          // An active primary link needs a new relay/daemon generation after
          // its container name changes. Keeping this durable state makes a
          // failed immediate reconciliation recoverable after restart.
          secureLinkStatus: sql`case
            when ${proxyHosts.secureLinkGeneration} > 0 and ${proxyHosts.secureLinkStatus} = 'active' then 'updating'
            else ${proxyHosts.secureLinkStatus}
          end`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyHosts.upstreamKind, 'docker_container'),
            eq(proxyHosts.dockerNodeId, nodeId),
            eq(proxyHosts.dockerContainerName, oldName)
          )
        )
        .returning();

      await tx
        .update(proxyAdditionalRoutes)
        .set({ dockerContainerName: newName, updatedAt: new Date() })
        .where(
          and(
            eq(proxyAdditionalRoutes.targetKind, 'docker_container'),
            eq(proxyAdditionalRoutes.dockerNodeId, nodeId),
            eq(proxyAdditionalRoutes.dockerContainerName, oldName)
          )
        );

      await tx
        .update(proxyAdditionalSecureLinks)
        .set({
          dockerContainerName: newName,
          targetContainer: sql`case
            when ${proxyAdditionalSecureLinks.targetContainer} = ${oldName} then ${newName}
            else ${proxyAdditionalSecureLinks.targetContainer}
          end`,
          generation: sql`${proxyAdditionalSecureLinks.generation} + 1`,
          status: 'provisioning',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyAdditionalSecureLinks.upstreamKind, 'docker_container'),
            eq(proxyAdditionalSecureLinks.dockerNodeId, nodeId),
            eq(proxyAdditionalSecureLinks.dockerContainerName, oldName),
            ne(proxyAdditionalSecureLinks.status, 'cleanup_pending')
          )
        );
      return hosts;
    });
    for (const host of updated) this.emitHost(host.id, 'updated', host.domainNames?.[0]);
    this.queueDockerReconciliation(true);
  }

  /**
   * Whether a raw-mode Route needs its Secure Link. It keeps the link it has; a link an earlier release tore
   * down when the Route entered raw mode comes back while the raw config, or the config Opfield renders while no
   * raw config is stored, still proxies to it.
   */
  protected async rawRouteUsesSecureLink(host: ProxyHostRow): Promise<boolean> {
    if (host.secureLinkGeneration > 0) return true;
    if (host.rawConfig) return rawConfigUsesSecureLink(host.id, host.rawConfig);
    const members = await this.secureLinks?.getActiveAvailabilityMembers?.(host.id, `proxy-host:${host.id}`);
    return !members?.length;
  }

  protected async resolveStoredDockerUpstream(host: ProxyHostRow, force = false): Promise<ProxyHostRow> {
    if (!isDockerUpstream(host.upstreamKind) || !this.dockerUpstreams) return host;
    if ((host.type === 'raw' || host.rawConfigEnabled) && !(await this.rawRouteUsesSecureLink(host))) return host;
    const resolved = await this.dockerUpstreams.resolve(host, { allowPortRebind: true });
    const changed =
      host.dockerContainerPort !== resolved.dockerContainerPort ||
      host.dockerNodeId !== resolved.dockerNodeId ||
      host.dockerContainerName !== resolved.dockerContainerName ||
      host.dockerComposeProjectId !== resolved.dockerComposeProjectId ||
      host.dockerComposeServiceName !== resolved.dockerComposeServiceName ||
      host.dockerDeploymentId !== resolved.dockerDeploymentId ||
      (host.secureLinkGeneration > 0 && host.secureLinkTargetContainer !== resolved.dockerContainerName);
    // A link whose relay endpoint still reaches the node its target left (a migration) is re-pointed even when the
    // Route row itself did not change.
    if (
      !changed &&
      host.secureLinkStatus === 'active' &&
      !force &&
      !((await this.secureLinks?.targetMoved?.(host)) ?? false)
    ) {
      return host;
    }
    let updated = host;
    if (changed) {
      const [persisted] = await this.db
        .update(proxyHosts)
        .set({
          upstreamKind: resolved.upstreamKind,
          dockerNodeId: resolved.dockerNodeId,
          dockerContainerName: resolved.dockerContainerName,
          dockerComposeProjectId: resolved.dockerComposeProjectId,
          dockerComposeServiceName: resolved.dockerComposeServiceName,
          dockerDeploymentId: resolved.dockerDeploymentId,
          dockerContainerPort: resolved.dockerContainerPort,
          dockerProtocol: resolved.dockerProtocol,
          updatedAt: new Date(),
        })
        .where(eq(proxyHosts.id, host.id))
        .returning();
      updated = persisted ?? host;
    }
    return this.secureLinks ? this.secureLinks.reconcileExisting(updated) : updated;
  }

  protected async reconcileDockerUpstreams(force = false): Promise<void> {
    let retryNeeded = false;
    if (await this.secureLinks?.reconcileAdditionalLifecycle?.()) retryNeeded = true;
    if (await this.additionalRoutes?.reconcileDockerTargets(force)) retryNeeded = true;
    const pendingCleanups = await this.db.query.proxyHosts.findMany({
      where: eq(proxyHosts.secureLinkStatus, 'cleanup_pending'),
    });
    for (const host of pendingCleanups) {
      try {
        await this.secureLinks?.cleanup(host);
      } catch (error) {
        logger.debug('Secure Link cleanup is still pending', { hostId: host.id, error });
        retryNeeded = true;
      }
    }
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(
        inArray(proxyHosts.type, ['proxy', 'raw']),
        inArray(proxyHosts.upstreamKind, ['docker_container', 'docker_deployment']),
        ne(proxyHosts.secureLinkStatus, 'cleanup_pending')
      ),
    });
    for (const listedHost of hosts) {
      try {
        if (!(await this.reconcileDockerHost(listedHost.id, force))) retryNeeded = true;
      } catch (error) {
        // External disappearance/offline state intentionally keeps the last
        // resolved endpoint and the existing Nginx configuration intact.
        logger.debug('Keeping last resolved Docker proxy upstream', { hostId: listedHost.id, error });
        retryNeeded = true;
      }
    }
    if (retryNeeded) this.scheduleDockerReconciliationRetry();
    else this.dockerReconcileBackoffMs = 5_000;
  }

  /**
   * Reconciles one Docker Route under its host lock: resolves its target, provisions or re-points its Secure Link,
   * and re-applies its Nginx config when the link changed. Returns false when the config could not be applied yet.
   */
  private async reconcileDockerHost(hostId: string, force: boolean): Promise<boolean> {
    return withProxyHostLock(hostId, async () => {
      // Re-read under the host lock: an edit that finished after the batch
      // query must never be overwritten with the stale listed row.
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
      if (
        !host ||
        (host.type !== 'proxy' && host.type !== 'raw') ||
        !isDockerUpstream(host.upstreamKind) ||
        host.secureLinkStatus === 'cleanup_pending'
      ) {
        return true;
      }
      // A raw-mode Route keeps its Secure Link (see rawRouteUsesSecureLink): it follows its target here like a
      // managed Route's. Availability places the ingress of managed Routes only.
      const rawMode = host.type === 'raw' || host.rawConfigEnabled;
      const availabilityManaged = !rawMode && ((await this.availabilityIngressReconciler?.(host.id)) ?? false);
      if (availabilityManaged) return true;
      const updated = await this.resolveStoredDockerUpstream(host, force);
      const secureLinkChanged =
        updated.forwardHost !== host.forwardHost ||
        updated.forwardPort !== host.forwardPort ||
        updated.secureLinkGeneration !== host.secureLinkGeneration ||
        updated.secureLinkStatus !== host.secureLinkStatus ||
        updated.secureLinkListenerPort !== host.secureLinkListenerPort ||
        updated.secureLinkTargetNetwork !== host.secureLinkTargetNetwork ||
        updated.secureLinkTargetContainer !== host.secureLinkTargetContainer;
      const cutoverPending =
        updated.secureLinkGeneration > 0 &&
        (updated.secureLinkStatus === 'provisioning' ||
          updated.secureLinkStatus === 'updating' ||
          updated.secureLinkStatus === 'cutover_ready');
      if (!secureLinkChanged && !cutoverPending) return true;
      let cutoverHost = updated;
      if (updated.secureLinkGeneration > 0 && updated.secureLinkStatus !== 'active') {
        if (host.secureLinkGeneration === 0 && host.enabled) {
          await this.withdrawHost(host);
        }
        cutoverHost = (await this.secureLinks?.commitCutover(updated.id)) ?? updated;
      }
      if (cutoverHost.enabled) {
        try {
          await this.deliverHost(cutoverHost, { certOptions: { preserveLegacyOnUnsupported: true } });
          if (cutoverHost.secureLinkGeneration > 0) {
            await this.secureLinks?.activate(cutoverHost.id);
            this.queueSecureLinkRuntimeSample(cutoverHost);
          }
        } catch (error) {
          // Keep the newly resolved endpoint. A disconnected Nginx node will
          // receive it through the existing resync path after reconnecting.
          logger.warn('Resolved Docker upstream but could not apply Nginx config yet', {
            hostId: updated.id,
            error,
          });
          this.emitHost(updated.id, 'updated', updated.domainNames?.[0]);
          return false;
        }
      } else if (cutoverPending) {
        await this.secureLinks?.activate(cutoverHost.id);
        this.queueSecureLinkRuntimeSample(cutoverHost);
      }
      this.emitHost(updated.id, 'updated', updated.domainNames?.[0]);
      return true;
    });
  }

  /**
   * Points the Routes of a migrated container or deployment at its target node right away instead of on the next
   * reconciliation pass: each Route's Secure Link follows the target (its relay endpoint moves, the former node's
   * binding and grant are withdrawn). The Additional Secure Links and Additional Routes the cutover moved follow in a
   * background pass, which does not hold up the end of the Route's maintenance. A Route that cannot follow now is
   * retried by the reconciliation, which detects the move on its own. Returns whether every Route followed.
   */
  async followMigratedDockerRoutes(hostIds: readonly string[]): Promise<boolean> {
    let followed = true;
    for (const hostId of hostIds) {
      try {
        if (!(await this.reconcileDockerHost(hostId, false))) followed = false;
      } catch (error) {
        logger.warn('A migrated Route did not follow its target yet; the reconciliation retries it', {
          hostId,
          error: error instanceof Error ? error.message : String(error),
        });
        followed = false;
      }
    }
    this.queueDockerReconciliation();
    if (!followed) this.scheduleDockerReconciliationRetry();
    return followed;
  }

  // -----------------------------------------------------------------------
  // Resync all hosts on a node (used on reconnect with hash mismatch)
  // -----------------------------------------------------------------------

  async resyncAllHostsOnNode(nodeId: string): Promise<void> {
    // Only resync enabled hosts this node serves: its own routes and the routes of its ingress groups
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(proxyHostsServedByNode(this.db, nodeId), eq(proxyHosts.enabled, true)),
    });

    logger.info('Resyncing all hosts on node', { nodeId, hostCount: hosts.length });
    const supportsDistribution = hosts.length > 0 ? await this.certificateDistribution.supportsNode(nodeId) : false;
    const applied = new Map<string, AppliedNodeHostConfig>();
    let failures = 0;

    for (const storedHost of hosts) {
      try {
        const result = await withProxyHostLock(storedHost.id, async () => {
          // Re-read under the host lock so an edit that committed after the
          // batch query is never overwritten with the stale listed row.
          const current = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, storedHost.id) });
          if (!current?.enabled || !(await this.servesOn(current, nodeId))) return null;
          let host = current;
          try {
            host = await this.resolveStoredDockerUpstream(current);
          } catch (error) {
            // A node reconnect can race the background Docker reconciler. Never
            // render the stale pre-cutover row: it could restore a published-IP
            // upstream after the Secure Link was already committed.
            const latest = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, storedHost.id) });
            if (!latest?.enabled || !(await this.servesOn(latest, nodeId))) return null;
            host = latest;
            logger.debug('Using current proxy state after Docker resync resolution failed', {
              hostId: storedHost.id,
              error,
            });
          }
          // A member of an ingress group may have missed Pages publications of the host's Additional Routes while it
          // was offline: bring its bindings up to date before the config that includes them is applied.
          if (host.ingressGroupId) {
            await this.additionalRoutes?.syncServingNodes(host, [nodeId], []).catch((error) =>
              logger.warn('Additional Pages Routes of a reconnected ingress member are retried on its next resync', {
                hostId: host.id,
                nodeId,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
          // Existing hosts on an old daemon retain their legacy config and
          // certificate paths. A new bundle is never initiated for that fleet.
          // A group route is re-applied on this member only.
          // Every route is re-sent: content the node already runs is neither rewritten nor reloaded, the changes
          // load with one reload at the end of the resync (the full sync below), and an unchanged TLS bundle is not
          // sent again.
          const delivered = await this.renderAndApplyHost(
            host,
            supportsDistribution ? {} : { legacy: true },
            host.ingressGroupId ? [nodeId] : undefined,
            { deferReload: true, reuseActiveBundle: true }
          );
          return { ...delivered, config: delivered.configs.get(nodeId) ?? delivered.config };
        });
        if (result) applied.set(storedHost.id, result);
      } catch (err) {
        failures += 1;
        logger.error('Failed to resync host config', {
          hostId: storedHost.id,
          nodeId,
          error: (err as Error).message,
        });
      }
    }

    logger.info('Node resync complete', { nodeId, hostCount: hosts.length, failures });
    try {
      // The node's full Secure Link source set: listeners of links it no longer sources (a route that left its
      // ingress group while it was offline) are dropped, new ones (a group it joined) are opened.
      await this.secureLinks?.reconcileSourceNode(nodeId);
    } catch (error) {
      logger.warn('Secure Link source reconciliation after node resync failed; it is retried', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await this.removeStaleConfigsOnNode(nodeId, applied, failures);
    } catch (error) {
      logger.warn('Stale proxy config cleanup failed after node resync', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove proxy-host configs that no longer belong to an enabled host on this
   * node (for example a host deleted or moved while the node was unreachable).
   *
   * The daemon has no listing command, but every nginx-daemon version supports
   * FullSync, which rewrites the given host configs and deletes any other
   * `proxy-host-*.conf`. It is sent only with the exact configs that this
   * resync just applied, so it never changes a live host and never touches
   * Pages, maintenance or other non-proxy-host files. Cleanup is skipped
   * whenever that cannot be guaranteed: a host failed to resync, another write
   * raced the resync, or an ingress migration still keeps this node serving
   * its former routes until DNS moves.
   */
  protected async removeStaleConfigsOnNode(
    nodeId: string,
    applied: Map<string, AppliedNodeHostConfig>,
    failures: number
  ): Promise<void> {
    if (failures > 0) {
      logger.warn('Skipping stale proxy config cleanup: not every host resynced', { nodeId, failures });
      return;
    }
    if (!this.nodeDispatch.isNodeConnected(nodeId)) return;
    const [node] = await this.db
      .select({ type: nodes.type, configVersionHash: nodes.configVersionHash })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (node?.type !== 'nginx') return;
    const [migration] = await this.db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.ingressMigrationSourceNodeId, nodeId))
      .limit(1);
    if (migration) {
      logger.info('Skipping stale proxy config cleanup during ingress migration', { nodeId });
      return;
    }

    await withProxyLocks([...[...applied.keys()].map(proxyHostLockKey), proxyNodeLockKey(nodeId)], async () => {
      const current = await this.db.query.proxyHosts.findMany({
        where: and(proxyHostsServedByNode(this.db, nodeId), eq(proxyHosts.enabled, true)),
        columns: { id: true, enabled: true, maintenanceEnabled: true, appMaintenanceMode: true },
      });
      const unchanged =
        current.length === applied.size &&
        current.every((host) => {
          const entry = applied.get(host.id);
          return entry !== undefined && (this.hostConfigEpochs.get(host.id) ?? 0) === entry.epoch;
        });
      if (!unchanged) {
        logger.info('Skipping stale proxy config cleanup: hosts changed during resync', { nodeId });
        return;
      }
      // The full set of the node's routes carries their maintenance flags; the node drops the flags of other routes.
      const keepsFlags = await this.nodeKeepsMaintenanceFlags(nodeId);
      const maintenance = new Map(current.map((host) => [host.id, host.enabled && effectiveMaintenance(host)]));
      const result = await this.nodeDispatch.fullSync(
        nodeId,
        [...applied].map(([hostId, entry]) => ({
          hostId,
          configContent: entry.config,
          configOwnership: entry.configOwnership,
          maintenance: keepsFlags ? maintenance.get(hostId) : undefined,
        })),
        [],
        '',
        [],
        node.configVersionHash ?? ''
      );
      if (!result.success) {
        logger.warn('Stale proxy config cleanup was rejected by the node', { nodeId, error: result.error });
        return;
      }
      logger.info('Removed stale proxy configs after node resync', { nodeId, hostCount: applied.size });
    });
  }

  async resyncTlsHost(id: string, userId: string) {
    return withProxyHostLock(id, () => this.resyncTlsHostLocked(id, userId));
  }

  private async resyncTlsHostLocked(id: string, userId: string) {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (!host.sslEnabled || !this.certificateDistribution.referenceForHost(host)) {
      throw new AppError(409, 'TLS_NOT_CONFIGURED', 'This proxy host has no TLS certificate to synchronize');
    }
    if (!host.enabled) {
      throw new AppError(
        409,
        'PROXY_HOST_DISABLED',
        'Enable the proxy host before synchronizing its TLS configuration'
      );
    }

    // Every member of a group route gets the bundle again.
    await this.deliverHost(host);
    const distribution = await this.certificateDistribution.getStatusForHost(host);
    await this.auditService.log({
      userId,
      action: 'proxy_host.tls_resync',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { nodeId: host.nodeId },
    });
    this.emitHost(host.id, 'tls_distribution_resynced', host.domainNames?.[0]);
    return { distribution };
  }

  async cleanupMigratedHostSource(id: string, sourceNodeId: string): Promise<{ orphanedConfigPossible: boolean }> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
    if (!host) return { orphanedConfigPossible: false };
    if (host.nodeId === sourceNodeId || (await this.servesOn(host, sourceNodeId))) {
      throw new AppError(409, 'PROXY_HOST_NOT_MIGRATED', 'Proxy host still belongs to the source Nginx node');
    }

    const connected = this.nodeDispatch.isNodeConnected(sourceNodeId);
    if (connected) {
      await this.removeConfigFromNode(id, sourceNodeId);
    }
    await this.certificateDistribution.deactivateHost(id, sourceNodeId);
    if (host.upstreamKind === 'pages') {
      await this.pageRoutes?.cleanupMigratedSource(id, sourceNodeId, connected);
    }
    await this.secureLinks?.reconcileSourceNode(sourceNodeId);
    return { orphanedConfigPossible: !connected };
  }

  /** Whether the node serves the route (its node, or a member of its ingress group). */
  protected async servesOn(host: Pick<ProxyHostRow, 'nodeId' | 'ingressGroupId'>, nodeId: string): Promise<boolean> {
    if (!host.ingressGroupId) return host.nodeId === nodeId;
    return (await this.ingressNodesOf(host)).includes(nodeId);
  }

  // -----------------------------------------------------------------------
  // Get rendered nginx config for a host
  // -----------------------------------------------------------------------

  async getRenderedConfig(id: string): Promise<string> {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy host config cannot be rendered here');

    const certPaths = await this.resolveCertPaths(host, { prepare: false });
    const accessList = await this.resolveAccessList(host.accessListId);
    return this.buildNginxConfig(host, certPaths, accessList);
  }

  /**
   * Whether the maintenance page of a route in maintenance offers team access: its guard carries the access-code
   * bypass, which a config that sets secure_link itself cannot (nginx-template.service.ts, applyMaintenanceGuard).
   */
  async maintenanceAccessOffered(id: string): Promise<boolean> {
    const rendered = await this.getRenderedConfig(id);
    return rendered.includes(`maintenance-access.sock:/redeem/${id};`);
  }

  // -----------------------------------------------------------------------
  // Internal system host management
  // -----------------------------------------------------------------------
}
