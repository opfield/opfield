import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, proxyHosts, relayPoolUpdateRuns } from '@/db/schema/index.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { ingressHealthOf } from '@/modules/ingress-groups/ingress-health.js';
import { resolveIngressNodesForMany } from '@/modules/ingress-groups/ingress-nodes.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { NOT_IN_EFFECTIVE_MAINTENANCE } from '@/modules/proxy/effective-maintenance.js';
import {
  aggregateMemberOutcomes,
  type GroupRouteHealth,
  type MemberProbeStatus,
  withMemberIngressHealth,
} from '@/modules/proxy/proxy-group-health.js';
import {
  type DirectProxyProbeDeps,
  daemonProbeOutcome,
  PROXY_HEALTH_CHECK_TIMEOUT_MS,
  probeDirectProxyUpstream,
  resolvePagesRouteProbeDomain,
} from '@/modules/proxy/proxy-health-check.js';
import {
  loadAvailabilityRouteProbeLinks,
  probeSecureLinkRoute,
  SECURE_LINK_PROBE_BUSY_ERROR,
} from '@/modules/proxy/proxy-secure-link-health-probe.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  LOCAL_RELAY_RECONNECT_GRACE_MS,
  type LocalRelayOutageSignal,
  localRelayOutagePhase,
} from '@/services/local-relay-outage.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

const logger = createChildLogger('HealthCheckJob');

const HEALTH_CHECK_TIMEOUT_MS = PROXY_HEALTH_CHECK_TIMEOUT_MS;
const HEALTH_CHECK_CONCURRENCY = 8;
// A daemon accepts at most four asynchronous commands at once. Reserve one slot
// for interactive/synchronization work while scheduled probes are in flight.
const SECURE_LINK_PROBE_CONCURRENCY_PER_NODE = 3;
const DAEMON_BUSY_ERROR = SECURE_LINK_PROBE_BUSY_ERROR;
const SLOW_BASELINE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours of history for baseline avg
const SLOW_RESPONSE_FLOOR_MS = 250;
/**
 * Daemons re-register a few seconds after Opfield starts, and the first health run can come
 * first. Within this window a probe that failed only because its node has not reconnected yet is
 * retried on the next run instead of being recorded or reported.
 */
export const NODE_RECONNECT_GRACE_MS = 60_000;

/** The probe never reached the daemon: every attempt failed with the registry's not-connected error. */
/** The node registry's errors for a command its node never answered (isNodeConnectionError). */
const NODE_DISCONNECTED = 'Node disconnected';
const COMMAND_TIMED_OUT = /^Command \S+ timed out after \d+ms$/;

/**
 * Every probe got no answer from its node: it was not connected, its stream ended with the probe in flight, or the
 * probe timed out (the node may be updating).
 */
function failedOnlyBecauseNodeDidNotAnswer(nodeId: string, errors: string[]): boolean {
  const notConnected = `Node ${nodeId} is not connected`;
  return (
    errors.length > 0 &&
    errors.every((error) => error === notConnected || error === NODE_DISCONNECTED || COMMAND_TIMED_OUT.test(error))
  );
}

type HealthStatus = 'online' | 'offline' | 'degraded' | 'unknown';

interface HealthEntry {
  ts: string;
  status: string;
  responseMs?: number;
  slow?: boolean;
  /** Routes on an ingress group: the sample of each member. */
  members?: GroupRouteHealth['members'];
}

function healthCheckDue(host: typeof proxyHosts.$inferSelect, now: number): boolean {
  if (!host.lastHealthCheckAt) return true;
  const intervalMs = Math.max(5, host.healthCheckInterval ?? 30) * 1000;
  return now - new Date(host.lastHealthCheckAt).getTime() >= intervalMs;
}

function isRelayBacked(host: typeof proxyHosts.$inferSelect): boolean {
  return (
    (host.upstreamKind === 'docker_container' || host.upstreamKind === 'docker_deployment') &&
    host.secureLinkMigratedAt != null
  );
}

async function allSettledBounded<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export class HealthCheckJob {
  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  private relayUnavailable = false;
  private readonly startedAt = Date.now();
  /** Routes whose last probe failed but were kept up as a transient failure; the next failure takes them down. */
  private readonly pendingFailures = new Set<string>();
  private localRelay?: Pick<LocalRelayOutageSignal, 'latestOutage'>;
  /** A Relay Pool update moves relayed streams now or did within the reconnect grace (read at each run). */
  private relayPoolUpdating = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly nodeDispatch?: NodeDispatchService,
    private readonly probeDeps?: DirectProxyProbeDeps
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    (bus as Partial<EventBusService>).subscribe?.('system.relay.health.changed', (payload) => {
      // Most publishers announce a relay change without a state; only the supervisor's own state counts.
      const state = (payload as { state?: unknown } | null)?.state;
      if (typeof state === 'string') this.relayUnavailable = state === 'critical';
    });
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  /** The local relay's outages (its supervisor), see relayPathsSettling. */
  setLocalRelayOutage(signal: Pick<LocalRelayOutageSignal, 'latestOutage'>) {
    this.localRelay = signal;
  }

  /**
   * The local relay does not serve, or serves again within its reconnect grace: relayed routes' streams are moving
   * between relays and their endpoints registering again, so a relayed probe that fails or answers slowly says
   * nothing about the route yet (stand rc.6 O-7: a route went degraded on one slow probe 6 s after the relay served
   * again). Such samples are deferred, as for a node that reconnects.
   */
  private relayPathsSettling(): boolean {
    return this.relayPoolUpdating || localRelayOutagePhase(this.localRelay?.latestOutage() ?? null) !== null;
  }

  /**
   * Whether a Relay Pool update runs, or ended within LOCAL_RELAY_RECONNECT_GRACE_MS: it drains its relays one by one,
   * the local relay too, so relayed routes run over a remote relay for a while and come back after it. A probe then
   * measures the move, not the route (stand rc.7, F-3: routes went degraded while the update moved them to a far
   * relay). Unknown counts as no update.
   */
  private async readRelayPoolUpdating(now = Date.now()): Promise<boolean> {
    try {
      const [run] = await this.db
        .select({ state: relayPoolUpdateRuns.state, completedAt: relayPoolUpdateRuns.completedAt })
        .from(relayPoolUpdateRuns)
        .where(eq(relayPoolUpdateRuns.poolId, 'system'))
        .orderBy(desc(relayPoolUpdateRuns.startedAt))
        .limit(1);
      if (!run) return false;
      if (['draining', 'updating', 'verifying', 'rolling_back'].includes(run.state)) return true;
      return Boolean(run.completedAt && now - run.completedAt.getTime() < LOCAL_RELAY_RECONNECT_GRACE_MS);
    } catch (error) {
      logger.debug('Relay Pool update state was not read for route health', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async run(): Promise<void> {
    // Query proxy hosts with health checks enabled
    const candidates = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.healthCheckEnabled, true), eq(proxyHosts.enabled, true), NOT_IN_EFFECTIVE_MAINTENANCE),
    });
    const hosts = candidates.filter((host) => healthCheckDue(host, Date.now()));

    if (hosts.length === 0) {
      logger.debug('No proxy health checks are due');
      return;
    }

    logger.info(`Running health checks for ${hosts.length} host(s)`);
    this.relayPoolUpdating = await this.readRelayPoolUpdating();
    const availabilityMembers = await loadAvailabilityRouteProbeLinks(
      this.db,
      hosts.filter(isRelayBacked).map((host) => host.id)
    );
    const groupHosts = hosts.filter((host) => host.ingressGroupId);
    const servingNodes = groupHosts.length > 0 ? await resolveIngressNodesForMany(this.db, groupHosts) : new Map();

    const check = async (host: typeof proxyHosts.$inferSelect) => {
      const relayBacked = isRelayBacked(host);
      if (relayBacked && this.relayUnavailable) {
        await this.recordRelayUnavailable(host);
        return { hostId: host.id, status: 'skipped' as const };
      }
      const previousStatus = host.healthStatus as HealthStatus;
      const {
        status: checkStatus,
        responseMs,
        members: memberSamples,
        unreachable,
      } = await this.checkHost(host, availabilityMembers.get(host.id), servingNodes.get(host));

      if (relayBacked && this.relayUnavailable) {
        await this.recordRelayUnavailable(host);
        return { hostId: host.id, status: 'skipped' as const };
      }
      if (checkStatus === 'deferred') {
        // Nothing is recorded, so the next run probes again once the node is back.
        return { hostId: host.id, status: 'skipped' as const };
      }
      if (checkStatus === 'skipped') {
        await this.recordProbeIndeterminate(host);
        return { hostId: host.id, status: 'skipped' as const };
      }
      if (checkStatus === 'unknown') {
        await this.recordProbeUnknown(host);
        return { hostId: host.id, status: 'unknown' as const };
      }

      const now = Date.now();
      const existingHistory: HealthEntry[] = (host.healthHistory as HealthEntry[]) ?? [];

      // Compute slow flag: compare response time against baseline average. A relayed route is not judged slow while
      // its relay paths settle after a local relay outage.
      let slow = false;
      if (checkStatus === 'online' && responseMs != null && !(relayBacked && this.relayPathsSettling())) {
        const threshold = host.healthCheckSlowThreshold ?? 3;
        if (threshold > 0) {
          const baselineCutoff = now - SLOW_BASELINE_WINDOW_MS;
          const baselineTimes = existingHistory
            .filter((h) => h.status === 'online' && h.responseMs != null && new Date(h.ts).getTime() >= baselineCutoff)
            .map((h) => h.responseMs!);
          if (baselineTimes.length >= 5) {
            // need enough samples for a meaningful baseline
            const avgMs = baselineTimes.reduce((a, b) => a + b, 0) / baselineTimes.length;
            slow = responseMs >= Math.max(avgMs * threshold, SLOW_RESPONSE_FLOOR_MS);
          }
        }
      }

      // Derive the stored healthStatus field from the check
      const previousProbeFailed = this.pendingFailures.has(host.id) || existingHistory.at(-1)?.status === 'offline';
      const transientFailure =
        checkStatus === 'offline' &&
        (previousStatus === 'online' || previousStatus === 'degraded') &&
        !previousProbeFailed;
      if (transientFailure) {
        // The failure is absorbed: no history entry (it would read as an outage and keep the route "recovering"),
        // no alert, and lastHealthCheckAt stays so the next run confirms or clears it.
        this.pendingFailures.add(host.id);
        return { hostId: host.id, status: 'skipped' as const };
      }
      this.pendingFailures.delete(host.id);

      // Push new entry
      const entry: HealthEntry = { ts: new Date(now).toISOString(), status: checkStatus };
      if (responseMs != null) entry.responseMs = responseMs;
      if (slow) entry.slow = true;
      if (memberSamples) entry.members = memberSamples;
      const history = compactHealthHistory([...existingHistory, entry], { nowMs: now });

      // A group route with a failing member is degraded right away: the other members still serve it.
      const newStatus: HealthStatus =
        checkStatus === 'online' ? (slow ? 'degraded' : 'online') : checkStatus === 'degraded' ? 'degraded' : 'offline';

      // Write to DB
      const persisted = await this.db
        .update(proxyHosts)
        .set({
          healthStatus: newStatus,
          lastHealthCheckAt: new Date(),
          healthHistory: history,
        })
        .where(
          and(
            eq(proxyHosts.id, host.id),
            eq(proxyHosts.enabled, true),
            eq(proxyHosts.healthCheckEnabled, true),
            NOT_IN_EFFECTIVE_MAINTENANCE
          )
        )
        .returning({ id: proxyHosts.id });

      if (persisted.length === 0) {
        logger.debug('Discarded health result because host state changed', { hostId: host.id });
        return { hostId: host.id, status: 'skipped' as const };
      }

      await this.evaluator?.observeStatefulEvent(
        'proxy',
        newStatus === 'online' ? 'health.online' : newStatus === 'offline' ? 'health.offline' : 'health.degraded',
        {
          type: 'proxy',
          id: host.id,
          name: host.domainNames?.[0] ?? host.id,
        },
        // A probe Opfield sent itself that got no answer (DNS, connect, timeout): a route alert it raises folds
        // under "Opfield lost outbound connectivity" while that alert fires.
        newStatus === 'offline' && unreachable
          ? { health_status: newStatus, probe_failure: 'unreachable' }
          : { health_status: newStatus },
        undefined,
        // Alert windows need the previous sample as an anchor; keep it for at least the check interval.
        Math.max(5, host.healthCheckInterval ?? 30) * 1000
      );

      // Keep alerts/logging transition-based, but publish every persisted sample so
      // an open detail page can advance its health history without a reload.
      let healthAction = 'health.sampled';
      if (previousStatus !== newStatus) {
        logger.info(`Health status changed for ${host.domainNames?.join(', ') || host.id}`, {
          hostId: host.id,
          previousStatus,
          newStatus,
          forwardHost: host.forwardHost,
        });
        healthAction =
          newStatus === 'online' ? 'health.online' : newStatus === 'offline' ? 'health.offline' : 'health.degraded';
      }
      this.eventBus?.publish('proxy.host.changed', {
        id: host.id,
        action: healthAction,
        domain: host.domainNames?.[0],
        health_status: newStatus,
      });

      return { hostId: host.id, status: newStatus };
    };

    const directHosts: typeof hosts = [];
    const daemonHostsByNode = new Map<string, typeof hosts>();
    for (const host of hosts) {
      const relayBacked = isRelayBacked(host);
      // Group routes probe through every member; they run in the shared pool.
      if ((!relayBacked && host.upstreamKind !== 'pages') || host.ingressGroupId) {
        directHosts.push(host);
        continue;
      }
      const nodeKey = host.nodeId ?? '__missing_node__';
      const nodeHosts = daemonHostsByNode.get(nodeKey) ?? [];
      nodeHosts.push(host);
      daemonHostsByNode.set(nodeKey, nodeHosts);
    }

    const resultGroups = await Promise.all([
      allSettledBounded(directHosts, HEALTH_CHECK_CONCURRENCY, check),
      ...Array.from(daemonHostsByNode.values(), (nodeHosts) =>
        allSettledBounded(nodeHosts, SECURE_LINK_PROBE_CONCURRENCY_PER_NODE, check)
      ),
    ]);
    const results = resultGroups.flat();

    // Summarize results
    let online = 0;
    let offline = 0;
    let degraded = 0;
    let errors = 0;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        switch (result.value.status) {
          case 'online':
            online++;
            break;
          case 'offline':
            offline++;
            break;
          case 'degraded':
            degraded++;
            break;
        }
      } else {
        errors++;
        logger.error('Health check execution failed', { error: result.reason });
      }
    }

    if (offline > 0 || degraded > 0 || errors > 0) {
      logger.info('Health check summary', { online, offline, degraded, errors, total: hosts.length });
    }
  }

  private async recordRelayUnavailable(host: typeof proxyHosts.$inferSelect): Promise<void> {
    const now = Date.now();
    const existingHistory: HealthEntry[] = (host.healthHistory as HealthEntry[]) ?? [];
    const healthHistory = compactHealthHistory(
      [...existingHistory, { ts: new Date(now).toISOString(), status: 'unknown' }],
      { nowMs: now }
    );
    const persisted = await this.db
      .update(proxyHosts)
      .set({ lastHealthCheckAt: new Date(now), healthHistory })
      .where(
        and(
          eq(proxyHosts.id, host.id),
          eq(proxyHosts.enabled, true),
          eq(proxyHosts.healthCheckEnabled, true),
          NOT_IN_EFFECTIVE_MAINTENANCE
        )
      )
      .returning({ id: proxyHosts.id });
    if (persisted.length > 0) {
      this.eventBus?.publish('proxy.host.changed', {
        id: host.id,
        action: 'health.sampled',
        domain: host.domainNames?.[0],
        health_status: host.healthStatus,
      });
    }
  }

  private async recordProbeIndeterminate(host: typeof proxyHosts.$inferSelect): Promise<void> {
    await this.db
      .update(proxyHosts)
      .set({ lastHealthCheckAt: new Date() })
      .where(
        and(
          eq(proxyHosts.id, host.id),
          eq(proxyHosts.enabled, true),
          eq(proxyHosts.healthCheckEnabled, true),
          NOT_IN_EFFECTIVE_MAINTENANCE
        )
      );
  }

  private async recordProbeUnknown(host: typeof proxyHosts.$inferSelect): Promise<void> {
    const now = Date.now();
    const existingHistory: HealthEntry[] = (host.healthHistory as HealthEntry[]) ?? [];
    const healthHistory = compactHealthHistory(
      [...existingHistory, { ts: new Date(now).toISOString(), status: 'unknown' }],
      { nowMs: now }
    );
    const persisted = await this.db
      .update(proxyHosts)
      .set({ healthStatus: 'unknown', lastHealthCheckAt: new Date(now), healthHistory })
      .where(
        and(
          eq(proxyHosts.id, host.id),
          eq(proxyHosts.enabled, true),
          eq(proxyHosts.healthCheckEnabled, true),
          NOT_IN_EFFECTIVE_MAINTENANCE
        )
      )
      .returning({ id: proxyHosts.id });
    if (persisted.length > 0) {
      this.eventBus?.publish('proxy.host.changed', {
        id: host.id,
        action: 'health.unknown',
        domain: host.domainNames?.[0],
        health_status: 'unknown',
      });
    }
  }

  /**
   * Whether a probe failed only because its node is expected to be away: within the startup grace (nodes reconnect
   * after an Opfield restart), while it reconnects (its stream just closed, or the local relay restarts) or while the
   * node's daemon is being updated (it restarts on its own).
   */
  private async awaitingNodeReconnect(nodeId: string, errors: string[]): Promise<boolean> {
    if (!failedOnlyBecauseNodeDidNotAnswer(nodeId, errors)) return false;
    // The node's stream ended with the probe in flight (a daemon update, a reconnect): the next sample tells, and a
    // node that stays away fails it as not connected once its graces end (stand rc.12 F-2).
    if (errors.every((error) => error === NODE_DISCONNECTED)) return true;
    if (Date.now() - this.startedAt < NODE_RECONNECT_GRACE_MS) return true;
    if (this.nodeDispatch?.isNodeReconnecting?.(nodeId)) return true;
    return (await this.nodeDispatch?.isNodeUpdateInProgress?.(nodeId)?.catch(() => false)) === true;
  }

  /**
   * One health sample. A route on an ingress group is probed through every member (daemon probes) or once from
   * Opfield with the members' ingress health folded in (direct upstreams); see proxy-group-health.
   */
  private async checkHost(
    host: typeof proxyHosts.$inferSelect,
    memberLinkIds?: string[],
    servingNodeIds?: string[]
  ): Promise<{
    status: 'online' | 'offline' | 'degraded' | 'skipped' | 'deferred' | 'unknown';
    responseMs?: number;
    members?: GroupRouteHealth['members'];
    /** Opfield probed the upstream itself and got no answer. */
    unreachable?: boolean;
  }> {
    if (!host.ingressGroupId || !servingNodeIds || servingNodeIds.length === 0) {
      return this.checkHostOnNode(host, host.nodeId, memberLinkIds);
    }
    if (host.upstreamKind === 'pages' || isRelayBacked(host)) {
      const outcomes = await Promise.all(
        servingNodeIds.map(async (nodeId) => {
          if (this.nodeDispatch && !this.nodeDispatch.isNodeConnected(nodeId)) {
            // Expected back (an Opfield start, a stream that just closed, a local relay restart): no sample yet.
            const expectedBack =
              Date.now() - this.startedAt < NODE_RECONNECT_GRACE_MS || this.nodeDispatch.isNodeReconnecting?.(nodeId);
            return {
              nodeId,
              status: (expectedBack ? 'deferred' : 'offline') as MemberProbeStatus,
              error: 'The ingress node is not connected',
            };
          }
          const outcome = await this.checkHostOnNode(host, nodeId, memberLinkIds);
          return { nodeId, status: outcome.status, responseMs: outcome.responseMs };
        })
      );
      return aggregateMemberOutcomes(outcomes);
    }
    const upstream = await this.checkHostOnNode(host, host.nodeId, memberLinkIds);
    if (upstream.status !== 'online' && upstream.status !== 'offline') return upstream;
    const nodeRows = await this.db.query.nodes.findMany({
      where: inArray(nodes.id, servingNodeIds),
      columns: { id: true, lastHealthReport: true },
    });
    const combined = withMemberIngressHealth(
      upstream.status,
      servingNodeIds.map((nodeId) => ({
        nodeId,
        connected: this.nodeDispatch ? this.nodeDispatch.isNodeConnected(nodeId) : true,
        reconnecting: this.nodeDispatch?.isNodeReconnecting?.(nodeId) ?? false,
        serving: ingressHealthOf(nodeRows.find((row) => row.id === nodeId)?.lastHealthReport)?.serving ?? null,
      }))
    );
    return { ...combined, responseMs: upstream.responseMs, unreachable: upstream.unreachable };
  }

  private async checkHostOnNode(
    host: typeof proxyHosts.$inferSelect,
    nodeId: string | null,
    memberLinkIds?: string[]
  ): Promise<{
    status: 'online' | 'offline' | 'skipped' | 'deferred' | 'unknown';
    responseMs?: number;
    unreachable?: boolean;
  }> {
    if (host.upstreamKind === 'pages') {
      const domain = resolvePagesRouteProbeDomain(host);
      if (!nodeId || !this.nodeDispatch || !domain) return { status: 'unknown' };
      try {
        const result = await this.nodeDispatch.probePagesRoute(nodeId, {
          routeId: host.id,
          domain,
          tls: host.sslEnabled ?? false,
          path: host.healthCheckUrl || '/',
          expectedStatus: host.healthCheckExpectedStatus,
          expectedBody: host.healthCheckExpectedBody,
          bodyMatchMode: host.healthCheckBodyMatchMode,
          timeoutSeconds: Math.ceil(HEALTH_CHECK_TIMEOUT_MS / 1000),
        });
        if (result.skipped) {
          logger.debug('Pages Route health probe is unavailable', {
            hostId: host.id,
            nodeId: nodeId,
            domain,
            error: result.error,
          });
          return { status: 'unknown' };
        }
        if (!result.ok && result.error === DAEMON_BUSY_ERROR) {
          logger.debug('Pages Route health probe deferred', {
            hostId: host.id,
            nodeId: nodeId,
            domain,
            error: result.error,
          });
          return { status: 'skipped' };
        }
        if (!result.ok) {
          logger.warn('Pages Route health probe failed', {
            hostId: host.id,
            nodeId: nodeId,
            domain,
            httpStatus: result.httpStatus,
            error: result.error,
          });
        }
        return { status: daemonProbeOutcome(result), responseMs: result.responseMs };
      } catch (error) {
        if (await this.awaitingNodeReconnect(nodeId, [error instanceof Error ? error.message : String(error)])) {
          logger.debug('Pages Route health probe waits for its node to reconnect', {
            hostId: host.id,
            nodeId: nodeId,
            domain,
          });
          return { status: 'deferred' };
        }
        logger.warn('Pages Route health probe command failed', {
          hostId: host.id,
          nodeId: nodeId,
          domain,
          error,
        });
        return { status: 'offline' };
      }
    }
    if (isRelayBacked(host)) {
      if (!nodeId || !this.nodeDispatch) return { status: 'offline' };
      const result = await probeSecureLinkRoute(
        this.nodeDispatch,
        { ...host, nodeId },
        memberLinkIds,
        Math.ceil(HEALTH_CHECK_TIMEOUT_MS / 1000)
      );
      if (result.busy) {
        logger.debug('Secure Link health probe deferred because daemon is busy', {
          hostId: host.id,
          nodeId: nodeId,
          domain: host.domainNames?.[0],
        });
        return { status: 'skipped' };
      }
      if (
        !result.ok &&
        (await this.awaitingNodeReconnect(
          nodeId,
          result.failures.map((failure) => failure.error)
        ))
      ) {
        logger.debug('Secure Link health probe waits for its node to reconnect', {
          hostId: host.id,
          nodeId: nodeId,
          domain: host.domainNames?.[0],
        });
        return { status: 'deferred' };
      }
      if (!result.ok && this.relayPathsSettling()) {
        logger.debug(
          'Secure Link health probe waits for the relay paths to settle after a local relay outage or update',
          {
            hostId: host.id,
            nodeId: nodeId,
            domain: host.domainNames?.[0],
            error: result.failures.map((failure) => failure.error).join('; '),
          }
        );
        return { status: 'deferred' };
      }
      if (!result.ok) {
        logger.warn('Secure Link health probe failed', {
          hostId: host.id,
          nodeId: nodeId,
          domain: host.domainNames?.[0],
          httpStatus: result.httpStatus,
          error: result.failures.map((failure) => failure.error).join('; '),
          ...(memberLinkIds ? { availabilityMembers: result.failures } : {}),
        });
      }
      return { status: daemonProbeOutcome(result), responseMs: result.responseMs };
    }
    const probe = await probeDirectProxyUpstream(host, this.probeDeps);
    if (probe.status === 'blocked') {
      // Not an upstream failure: Opfield is not allowed to reach this target, so the health is unknown.
      if (host.healthStatus !== 'unknown') {
        logger.warn('Health check target blocked by outbound network policy', {
          hostId: host.id,
          domain: host.domainNames?.[0],
          reason: probe.reason,
        });
      }
      return { status: 'unknown' };
    }
    if (probe.status === 'offline') {
      logger.debug(`Health check failed for ${host.forwardHost}:${host.forwardPort}`, {
        httpStatus: probe.httpStatus,
        error: probe.error,
      });
    }
    return {
      status: probe.status,
      responseMs: probe.responseMs,
      unreachable: probe.status === 'offline' && probe.httpStatus === undefined,
    };
  }
}
