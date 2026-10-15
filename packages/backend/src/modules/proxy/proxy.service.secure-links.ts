import { and, eq, inArray } from 'drizzle-orm';
import { nodes, proxyAdditionalRoutes, proxyAdditionalSecureLinks, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { runOutsideProxyLocks } from './proxy-host-lock.js';
import type { ProxyAdditionalSecureLinkRow } from './proxy-secure-link.service.js';
import { mergeTrafficRuntimes } from './proxy-traffic-merge.js';

export { __testOnly } from './proxy.service-helpers.js';

import {
  isDockerUpstream,
  logger,
  type ProxyHostRow,
  type ProxyHostTrafficRuntime,
  type ProxySecureLinkRuntimeSample,
  type ProxySecureLinkRuntimeSnapshot,
  SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES,
  SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES,
  SECURE_LINK_RUNTIME_CACHE_PREFIX,
  SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS,
  SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS,
  SECURE_LINK_TRAFFIC_WINDOW_SECONDS,
} from './proxy.service.core.js';
import { ProxyServiceLifecycle } from './proxy.service.lifecycle.js';

const SECURE_LINK_TELEMETRY_STALE_AFTER_MS = 30_000;

export abstract class ProxyServiceSecureLinks extends ProxyServiceLifecycle {
  protected async requireManagedProxyHost(id: string): Promise<ProxyHostRow> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    if (host.type !== 'proxy' || host.rawConfigEnabled) {
      throw new AppError(409, 'ADDITIONAL_SECURE_LINK_UNAVAILABLE', 'Additional Secure Links require a managed route');
    }
    return host;
  }

  async getProxySecureLinkStatus(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
      columns: {
        id: true,
        isSystem: true,
        upstreamKind: true,
        nodeId: true,
        ingressGroupId: true,
        dockerNodeId: true,
        secureLinkGeneration: true,
        secureLinkStatus: true,
        secureLinkLastError: true,
        secureLinkMigratedAt: true,
        healthCheckEnabled: true,
        healthCheckInterval: true,
        rateLimitEnabled: true,
        rateLimitMode: true,
        rateLimitOptions: true,
      },
    });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
    // A route whose primary target is not Docker (Pages, a manual address) has no primary Secure Link, but its
    // additional routes and user-managed links can still run through Secure Links: those are listed without it.
    const hasPrimary = isDockerUpstream(host.upstreamKind);

    const sourceNodeIds = hasPrimary ? await this.ingressNodesOf(host) : [];
    const nodeIds = [...sourceNodeIds, host.dockerNodeId].filter((nodeId): nodeId is string => Boolean(nodeId));
    const [linkNodes, cachedHistory, allAdditionalBindings] = await Promise.all([
      nodeIds.length && hasPrimary
        ? this.db
            .select({ id: nodes.id, hostname: nodes.hostname, displayName: nodes.displayName, status: nodes.status })
            .from(nodes)
            .where(inArray(nodes.id, nodeIds))
        : Promise.resolve([]),
      hasPrimary ? this.getSecureLinkRuntimeHistory(host.id) : Promise.resolve([]),
      this.secureLinks?.listAllAdditional?.(host.id) ?? this.secureLinks?.listAdditional?.(host.id) ?? [],
    ]);
    // Availability members are internal to Availability: only user-managed links and the links of additional
    // routes are shown.
    const additionalBindings = allAdditionalBindings.filter((binding) => binding.purpose !== 'availability_member');
    const routeIds = additionalBindings.flatMap((binding) =>
      binding.purpose === 'additional_route' && binding.referenceId ? [binding.referenceId] : []
    );
    const routePaths = new Map(
      routeIds.length
        ? (
            await this.db
              .select({ id: proxyAdditionalRoutes.id, path: proxyAdditionalRoutes.path })
              .from(proxyAdditionalRoutes)
              .where(inArray(proxyAdditionalRoutes.id, routeIds))
          ).map((route) => [route.id, route.path])
        : []
    );
    let history = cachedHistory;
    let latestSnapshot = history.at(-1);
    let runtime = latestSnapshot?.runtime ?? null;
    let traffic = latestSnapshot?.traffic ?? null;

    const focusedSample = hasPrimary
      ? this.sampleSecureLinkRuntime(host, SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES)
      : null;
    if (focusedSample && (!runtime || !traffic)) {
      // A partial cached sample must not be exposed as a current "telemetry
      // unavailable" state. Collect Relay and Nginx telemetry as one snapshot
      // on the first incomplete read; subsequent reads stay cache-fast.
      try {
        const refreshed = await focusedSample;
        history = refreshed.history;
        latestSnapshot = refreshed.snapshot;
        runtime = latestSnapshot.runtime;
        traffic = latestSnapshot.traffic;
      } catch (error) {
        logger.debug('Focused Proxy Secure Link telemetry collection failed', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (focusedSample) {
      void focusedSample.catch((error) => {
        logger.debug('Focused Proxy Secure Link telemetry collection failed', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const nodeById = new Map(linkNodes.map((node) => [node.id, node]));
    const sourceNode = host.nodeId ? nodeById.get(host.nodeId) : undefined;
    const targetNode = host.dockerNodeId ? nodeById.get(host.dockerNodeId) : undefined;
    const rateLimitMode = host.rateLimitMode ?? (host.rateLimitEnabled ? 'custom' : 'inherit');
    const rateLimitOptions = (host.rateLimitOptions ?? {}) as {
      requestsPerSecond?: number;
      burst?: number;
      connectionsPerIp?: number;
    };
    const rateLimitEnabled = rateLimitMode !== 'disabled';
    const additionalLinks = await Promise.all(
      additionalBindings.map(async (binding) => {
        const historyKey = this.additionalSecureLinkRuntimeKey(binding.id);
        let bindingHistory = await this.getSecureLinkRuntimeHistory(historyKey);
        let bindingRuntime = bindingHistory.at(-1)?.runtime ?? null;
        if (binding.status === 'active') {
          const focusedSample = this.sampleAdditionalSecureLinkRuntime(binding);
          if (!bindingRuntime) {
            try {
              const refreshed = await focusedSample;
              bindingHistory = refreshed.history;
              bindingRuntime = refreshed.snapshot.runtime;
            } catch (error) {
              logger.debug('Focused additional Secure Link telemetry collection failed', {
                hostId: host.id,
                bindingId: binding.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            void focusedSample.catch((error) => {
              logger.debug('Focused additional Secure Link telemetry collection failed', {
                hostId: host.id,
                bindingId: binding.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
        return {
          id: binding.id,
          name: binding.name,
          purpose: binding.purpose,
          referenceId: binding.referenceId,
          label:
            binding.purpose === 'additional_route'
              ? ((binding.referenceId ? routePaths.get(binding.referenceId) : undefined) ?? binding.name)
              : binding.name,
          status: binding.status,
          generation: binding.generation,
          targetContainer: binding.targetContainer,
          forwardScheme: binding.forwardScheme,
          lastError: binding.lastError,
          runtime: bindingRuntime,
          history: bindingHistory.map(({ timestamp, runtime: snapshotRuntime }) => ({
            timestamp,
            runtime: snapshotRuntime,
          })),
        };
      })
    );
    if (!hasPrimary) {
      return {
        hasPrimary: false as const,
        state: null,
        generation: null,
        sourceNodeId: null,
        targetNodeId: null,
        transport: null,
        migratedAt: null,
        lastError: null,
        telemetrySampledAt: null,
        telemetryStale: false,
        healthCheck: null,
        sourceNode: null,
        sourceNodes: [],
        ingressGroupId: host.ingressGroupId,
        targetNode: null,
        rateLimit: null,
        runtime: null,
        traffic: null,
        history: [],
        additionalLinks,
      };
    }
    const telemetrySampledAt = latestSnapshot?.timestamp ?? null;
    const telemetrySampledAtMs = telemetrySampledAt ? Date.parse(telemetrySampledAt) : Number.NaN;
    const telemetryStale =
      telemetrySampledAt != null &&
      (!Number.isFinite(telemetrySampledAtMs) ||
        Date.now() - telemetrySampledAtMs > SECURE_LINK_TELEMETRY_STALE_AFTER_MS);
    return {
      hasPrimary: true as const,
      state: host.secureLinkStatus,
      generation: host.secureLinkGeneration,
      sourceNodeId: host.nodeId,
      targetNodeId: host.dockerNodeId,
      transport: 'grpc-http2-mtls',
      migratedAt: host.secureLinkMigratedAt?.toISOString() ?? null,
      lastError: host.secureLinkLastError,
      telemetrySampledAt,
      telemetryStale,
      healthCheck: {
        enabled: host.healthCheckEnabled,
        intervalSeconds: host.healthCheckInterval ?? 30,
      },
      sourceNode: sourceNode
        ? { id: sourceNode.id, name: sourceNode.displayName || sourceNode.hostname, status: sourceNode.status }
        : null,
      // Every source nginx node of the link: all members of the route's ingress group, else its node.
      sourceNodes: sourceNodeIds.flatMap((nodeId) => {
        const node = nodeById.get(nodeId);
        return node ? [{ id: node.id, name: node.displayName || node.hostname, status: node.status }] : [];
      }),
      ingressGroupId: host.ingressGroupId,
      targetNode: targetNode
        ? { id: targetNode.id, name: targetNode.displayName || targetNode.hostname, status: targetNode.status }
        : null,
      rateLimit: {
        mode: rateLimitMode,
        enabled: rateLimitEnabled,
        requestsPerSecond:
          rateLimitMode === 'custom' ? (rateLimitOptions.requestsPerSecond ?? 1000) : rateLimitEnabled ? 1000 : 0,
        burst: rateLimitMode === 'custom' ? (rateLimitOptions.burst ?? 3000) : rateLimitEnabled ? 3000 : 0,
        connectionsPerIp:
          rateLimitMode === 'custom' ? (rateLimitOptions.connectionsPerIp ?? 1000) : rateLimitEnabled ? 1000 : 0,
      },
      runtime,
      traffic,
      history,
      additionalLinks,
    };
  }

  /**
   * Collects the same runtime snapshots that the focused Link Runtime page
   * requests, but for every enabled active Secure Link. This background path
   * keeps monitoring history independent from browser sessions.
   */
  collectSecureLinkRuntimeSnapshots(): Promise<void> {
    if (this.secureLinkRuntimeBackgroundInFlight) return this.secureLinkRuntimeBackgroundInFlight;
    if (this.dockerReconcileRunning) {
      this.secureLinkRuntimeCollectionPending = true;
      return Promise.resolve();
    }

    this.secureLinkRuntimeCollectionPending = false;
    const task = this.collectSecureLinkRuntimeSnapshotsOnce().finally(() => {
      if (this.secureLinkRuntimeBackgroundInFlight === task) {
        this.secureLinkRuntimeBackgroundInFlight = null;
      }
    });
    this.secureLinkRuntimeBackgroundInFlight = task;
    return task;
  }

  protected async collectSecureLinkRuntimeSnapshotsOnce(): Promise<void> {
    if (!this.secureLinks) return;
    const epoch = this.secureLinkRuntimeCollectionEpoch;
    const [hosts, additionalBindings] = await Promise.all([
      this.db.query.proxyHosts.findMany({
        where: and(
          eq(proxyHosts.isSystem, false),
          eq(proxyHosts.enabled, true),
          inArray(proxyHosts.upstreamKind, ['docker_container', 'docker_deployment']),
          eq(proxyHosts.secureLinkStatus, 'active')
        ),
        columns: { id: true, nodeId: true, ingressGroupId: true },
      }),
      this.db.query.proxyAdditionalSecureLinks?.findMany
        ? this.db.query.proxyAdditionalSecureLinks.findMany({
            where: and(
              inArray(proxyAdditionalSecureLinks.purpose, ['user_managed', 'additional_route']),
              eq(proxyAdditionalSecureLinks.status, 'active')
            ),
          })
        : Promise.resolve([]),
    ]);

    // Keep daemon and Relay fan-out bounded when an installation has many
    // Secure Links. A slow route cannot create overlapping background rounds.
    const concurrency = 4;
    for (let offset = 0; offset < hosts.length; offset += concurrency) {
      if (this.secureLinkRuntimeCollectionEpoch !== epoch) return;
      const batch = hosts.slice(offset, offset + concurrency);
      const results = await Promise.allSettled(
        batch.map((host) => this.sampleSecureLinkRuntime(host, SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES))
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.debug('Background Proxy Secure Link telemetry collection failed', {
            hostId: batch[index]?.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    }

    for (let offset = 0; offset < additionalBindings.length; offset += concurrency) {
      if (this.secureLinkRuntimeCollectionEpoch !== epoch) return;
      const batch = additionalBindings.slice(offset, offset + concurrency);
      const results = await Promise.allSettled(batch.map((binding) => this.sampleAdditionalSecureLinkRuntime(binding)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.debug('Background additional Secure Link telemetry collection failed', {
            bindingId: batch[index]?.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    }
  }

  protected sampleSecureLinkRuntime(
    host: { id: string; nodeId: string | null; ingressGroupId?: string | null },
    trafficTailLines: number
  ): Promise<ProxySecureLinkRuntimeSample> {
    const active = this.secureLinkRuntimeSamplesInFlight.get(host.id);
    if (active) return active;

    const task = this.collectSecureLinkRuntimeSnapshot(host, trafficTailLines)
      .then(async (snapshot) => {
        if (this.secureLinkRuntimeSamplesInFlight.get(host.id) !== task) return { snapshot, history: [] };
        const current = await this.getSecureLinkRuntimeHistory(host.id);
        if (this.secureLinkRuntimeSamplesInFlight.get(host.id) !== task) return { snapshot, history: [] };
        const previous = current.at(-1);
        if (previous && (snapshot.runtime == null || snapshot.traffic == null)) {
          return { snapshot: previous, history: current };
        }
        this.secureLinkRuntimeHistory.set(host.id, current);
        const history = this.recordSecureLinkRuntimeSnapshot(host.id, snapshot);
        await this.persistSecureLinkRuntimeHistory(host.id, history);
        return { snapshot, history };
      })
      .finally(() => {
        if (this.secureLinkRuntimeSamplesInFlight.get(host.id) === task) {
          this.secureLinkRuntimeSamplesInFlight.delete(host.id);
        }
      });
    this.secureLinkRuntimeSamplesInFlight.set(host.id, task);
    return task;
  }

  protected additionalSecureLinkRuntimeKey(bindingId: string): string {
    return `additional:${bindingId}`;
  }

  protected sampleAdditionalSecureLinkRuntime(
    binding: Pick<ProxyAdditionalSecureLinkRow, 'id'>
  ): Promise<ProxySecureLinkRuntimeSample> {
    const historyKey = this.additionalSecureLinkRuntimeKey(binding.id);
    const active = this.secureLinkRuntimeSamplesInFlight.get(historyKey);
    if (active) return active;

    const task = (this.secureLinks?.getRuntime(binding.id) ?? Promise.resolve(null))
      .then(async (runtime) => {
        const snapshot: ProxySecureLinkRuntimeSnapshot = {
          timestamp: new Date().toISOString(),
          runtime,
          traffic: null,
        };
        if (this.secureLinkRuntimeSamplesInFlight.get(historyKey) !== task) return { snapshot, history: [] };
        const current = await this.getSecureLinkRuntimeHistory(historyKey);
        if (this.secureLinkRuntimeSamplesInFlight.get(historyKey) !== task) return { snapshot, history: [] };
        this.secureLinkRuntimeHistory.set(historyKey, current);
        const history = this.recordSecureLinkRuntimeSnapshot(historyKey, snapshot);
        await this.persistSecureLinkRuntimeHistory(historyKey, history);
        return { snapshot, history };
      })
      .finally(() => {
        if (this.secureLinkRuntimeSamplesInFlight.get(historyKey) === task) {
          this.secureLinkRuntimeSamplesInFlight.delete(historyKey);
        }
      });
    this.secureLinkRuntimeSamplesInFlight.set(historyKey, task);
    return task;
  }

  protected queueSecureLinkRuntimeSample(host: {
    id: string;
    nodeId: string | null;
    ingressGroupId?: string | null;
  }): void {
    if (!this.secureLinks || !host.nodeId) return;
    runOutsideProxyLocks(() => {
      void this.sampleSecureLinkRuntime(host, SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES).catch((error) => {
        logger.debug('Initial Proxy Secure Link telemetry collection failed', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  protected async collectSecureLinkRuntimeSnapshot(
    host: {
      id: string;
      nodeId: string | null;
      ingressGroupId?: string | null;
    },
    trafficTailLines: number
  ): Promise<ProxySecureLinkRuntimeSnapshot> {
    if (host.ingressGroupId) return this.collectGroupSecureLinkRuntimeSnapshot(host, trafficTailLines);
    const [runtime, trafficResult] = await Promise.all([
      this.secureLinks?.getRuntime(host.id).catch((error) => {
        logger.debug('Proxy Secure Link route telemetry is unavailable', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }) ?? Promise.resolve(null),
      host.nodeId
        ? this.nodeDispatch
            .requestTrafficStats(host.nodeId, trafficTailLines, {
              hostId: host.id,
              windowSeconds: SECURE_LINK_TRAFFIC_WINDOW_SECONDS,
            })
            .catch((error) => {
              logger.debug('Proxy Secure Link HTTP telemetry is unavailable', {
                hostId: host.id,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            })
        : Promise.resolve(null),
    ]);

    let traffic: ProxyHostTrafficRuntime | null = null;
    if (trafficResult?.success && trafficResult.detail) {
      try {
        const parsed = JSON.parse(trafficResult.detail) as ProxyHostTrafficRuntime;
        // Older daemons ignore host_id and return node-global data. Never
        // present that fallback as telemetry for one Secure Link.
        if (parsed.hostId === host.id) traffic = parsed;
      } catch {
        traffic = null;
      }
    }

    return { timestamp: new Date().toISOString(), runtime, traffic };
  }

  /** A group route: relay runtime summed over its member routes, HTTP telemetry merged over connected members. */
  private async collectGroupSecureLinkRuntimeSnapshot(
    host: { id: string; nodeId: string | null; ingressGroupId?: string | null },
    trafficTailLines: number
  ): Promise<ProxySecureLinkRuntimeSnapshot> {
    const members = (
      await this.ingressNodesOf({ nodeId: host.nodeId, ingressGroupId: host.ingressGroupId ?? null })
    ).filter((nodeId) => this.nodeDispatch.isNodeConnected(nodeId));
    const [runtime, reports] = await Promise.all([
      this.secureLinks?.getRuntime(host.id).catch(() => null) ?? Promise.resolve(null),
      Promise.all(
        members.map((nodeId) =>
          this.nodeDispatch
            .requestTrafficStats(nodeId, trafficTailLines, {
              hostId: host.id,
              windowSeconds: SECURE_LINK_TRAFFIC_WINDOW_SECONDS,
            })
            .then((result) => {
              if (!result?.success || !result.detail) return null;
              const parsed = JSON.parse(result.detail) as ProxyHostTrafficRuntime;
              return parsed.hostId === host.id ? parsed : null;
            })
            .catch(() => null)
        )
      ),
    ]);
    const traffic = mergeTrafficRuntimes(reports.filter((report): report is ProxyHostTrafficRuntime => !!report));
    return { timestamp: new Date().toISOString(), runtime, traffic };
  }

  protected recordSecureLinkRuntimeSnapshot(
    hostId: string,
    snapshot: ProxySecureLinkRuntimeSnapshot
  ): ProxySecureLinkRuntimeSnapshot[] {
    const current = this.secureLinkRuntimeHistory.get(hostId) ?? [];
    const previous = current.at(-1);
    const relayRestarted =
      previous?.runtime != null &&
      snapshot.runtime != null &&
      (previous.runtime.metricsSince !== snapshot.runtime.metricsSince ||
        Number(snapshot.runtime.openedTotal) < Number(previous.runtime.openedTotal));
    const retained = relayRestarted ? [] : current;
    const previousTimestamp = retained.at(-1)?.timestamp;
    const elapsed = previousTimestamp
      ? new Date(snapshot.timestamp).getTime() - new Date(previousTimestamp).getTime()
      : Number.POSITIVE_INFINITY;
    const updated =
      elapsed < SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS
        ? [...retained.slice(0, -1), snapshot]
        : [...retained, snapshot].slice(-60);
    this.secureLinkRuntimeHistory.set(hostId, updated);
    return [...updated];
  }

  /** Cached traffic samples of a route (its Secure Link telemetry), oldest first; no node is asked. */
  async cachedTrafficHistory(hostId: string): Promise<Array<{ timestamp: string; traffic: ProxyHostTrafficRuntime }>> {
    return (await this.getSecureLinkRuntimeHistory(hostId)).flatMap((snapshot) =>
      snapshot.traffic ? [{ timestamp: snapshot.timestamp, traffic: snapshot.traffic }] : []
    );
  }

  protected async getSecureLinkRuntimeHistory(hostId: string): Promise<ProxySecureLinkRuntimeSnapshot[]> {
    const current = this.secureLinkRuntimeHistory.get(hostId);
    if (current) return [...current];
    if (!this.cache) return [];

    try {
      const cached = await this.cache.get<ProxySecureLinkRuntimeSnapshot[]>(
        `${SECURE_LINK_RUNTIME_CACHE_PREFIX}${hostId}`
      );
      const history = Array.isArray(cached)
        ? cached
            .filter(
              (snapshot): snapshot is ProxySecureLinkRuntimeSnapshot =>
                snapshot != null &&
                typeof snapshot === 'object' &&
                typeof (snapshot as ProxySecureLinkRuntimeSnapshot).timestamp === 'string'
            )
            .slice(-60)
        : [];
      // Only the owning sample may populate process-local history. A Redis read
      // started by a status request can otherwise resurrect a deleted host.
      return [...history];
    } catch (error) {
      logger.debug('Proxy Secure Link runtime history cache is unavailable', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  protected async persistSecureLinkRuntimeHistory(
    hostId: string,
    history: ProxySecureLinkRuntimeSnapshot[]
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.set(
        `${SECURE_LINK_RUNTIME_CACHE_PREFIX}${hostId}`,
        history,
        SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS
      );
    } catch (error) {
      logger.debug('Failed to persist Proxy Secure Link runtime history', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------
}
