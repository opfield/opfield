import { and, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, type relayEndpoints, relayInstances, relayRoutes } from '@/db/schema/index.js';
import {
  attachEndpointRtts,
  type EndpointLatencyPath,
  grantEndpointNodeId,
  type NodeRelayLatencies,
  parseNodeRelayLatencies,
  parseNodeRelayReachability,
  relayDataPlaneFailures,
} from './relay-topology.js';

/** Daemons report every 30 s; latencies of a node silent this long are unknown, not stale. */
const LATENCY_FRESH_MS = 5 * 60_000;
/** Reachability counts only from reports this recent: three report intervals. */
const REACHABILITY_FRESH_MS = 90_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RelayLatencyTarget {
  relayInstanceId: string;
  addresses: string[];
  port: number;
}

/**
 * Reads the relay round trips daemons measured. They live with each node's last health report,
 * which every report replaces, so they need no storage or cleanup of their own.
 */
export class RelayTopologyService {
  constructor(private readonly db: DrizzleClient) {}

  async nodeLatencies(nodeIds: string[], now = Date.now()): Promise<Map<string, NodeRelayLatencies>> {
    const ids = [...new Set(nodeIds.filter((id) => UUID_PATTERN.test(id)))];
    const result = new Map<string, NodeRelayLatencies>();
    if (!ids.length) return result;
    const rows = await this.db
      .select({
        id: nodes.id,
        lastSeenAt: nodes.lastSeenAt,
        relayLatencies: sql<unknown>`${nodes.lastHealthReport}->'relayLatencies'`,
      })
      .from(nodes)
      .where(inArray(nodes.id, ids));
    for (const row of rows) {
      if (!row.lastSeenAt || now - row.lastSeenAt.getTime() > LATENCY_FRESH_MS) continue;
      const latencies = parseNodeRelayLatencies(row.relayLatencies);
      if (latencies.size) result.set(row.id, latencies);
    }
    return result;
  }

  /** The measured distances around each daemon endpoint, keyed by endpoint id. */
  async endpointPaths(
    endpoints: Array<Pick<typeof relayEndpoints.$inferSelect, 'id' | 'subjectKind' | 'subjectId'>>
  ): Promise<Map<string, EndpointLatencyPath>> {
    const daemonEndpoints = endpoints.filter(({ subjectKind }) => subjectKind === 'daemon');
    const result = new Map<string, EndpointLatencyPath>();
    if (!daemonEndpoints.length) return result;
    const routes = await this.db
      .select({ endpointId: relayRoutes.targetEndpointId, sourceId: relayRoutes.sourceId })
      .from(relayRoutes)
      .where(
        and(
          inArray(
            relayRoutes.targetEndpointId,
            daemonEndpoints.map(({ id }) => id)
          ),
          eq(relayRoutes.sourceKind, 'daemon')
        )
      );
    const latencies = await this.nodeLatencies([
      ...daemonEndpoints.map(({ subjectId }) => subjectId),
      ...routes.map(({ sourceId }) => sourceId),
    ]);
    for (const endpoint of daemonEndpoints) {
      const sourceIds = new Set(routes.filter((route) => route.endpointId === endpoint.id).map((r) => r.sourceId));
      result.set(endpoint.id, {
        endpoint: latencies.get(endpoint.subjectId),
        sources: [...sourceIds].flatMap((id) => (latencies.has(id) ? [latencies.get(id)!] : [])),
      });
    }
    return result;
  }

  /**
   * Completes a node's grant bundle: placed candidates get the endpoint side of their path cost,
   * and a node that uses the pool gets every relay to measure.
   */
  async completeGrantBundle(
    grants: Parameters<typeof attachEndpointRtts>[0],
    endpoints: Array<Pick<typeof relayEndpoints.$inferSelect, 'id' | 'subjectKind' | 'subjectId'>>
  ): Promise<RelayLatencyTarget[]> {
    if (!grants.some(({ candidates }) => candidates?.length)) return [];
    const endpointNodes = new Map(
      endpoints.filter(({ subjectKind }) => subjectKind === 'daemon').map(({ id, subjectId }) => [id, subjectId])
    );
    const placed = grants.filter(({ candidates }) => candidates?.some(({ topology }) => topology));
    if (placed.length) {
      const nodeIds = placed.flatMap((grant) => grantEndpointNodeId(grant, endpointNodes) ?? []);
      attachEndpointRtts(placed, endpointNodes, await this.nodeLatencies(nodeIds));
    }
    return this.latencyTargets();
  }

  /**
   * The relays whose data plane fails for most of the nodes that measure them (relayDataPlaneFailures), from
   * the health reports of the nodes seen lately.
   */
  async relayDataPlaneFailures(now = Date.now()): Promise<Set<string>> {
    const rows = await this.db
      .select({ relayLatencies: sql<unknown>`${nodes.lastHealthReport}->'relayLatencies'` })
      .from(nodes)
      .where(gte(nodes.lastSeenAt, new Date(now - REACHABILITY_FRESH_MS)));
    return relayDataPlaneFailures(rows.map(({ relayLatencies }) => parseNodeRelayReachability(relayLatencies)));
  }

  /**
   * Every relay of the pool that serves or may serve again, for daemons to measure before any assignment uses
   * it. A relay whose control stream ended (offline) stays in: daemons keep measuring it, so placement and
   * tunnel selection know its distance the moment it is back, and the daemons' failure reports tell a data
   * plane that is gone from a control stream that dropped.
   */
  async latencyTargets(): Promise<RelayLatencyTarget[]> {
    const rows = await this.db
      .select({
        id: relayInstances.id,
        addresses: relayInstances.advertisedAddresses,
        port: relayInstances.servicePort,
      })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          inArray(relayInstances.state, ['ready', 'draining', 'offline']),
          or(eq(relayInstances.kind, 'local'), isNotNull(relayInstances.certificateFingerprint))
        )
      );
    return rows
      .map(({ id, addresses, port }) => ({ relayInstanceId: id, addresses, port }))
      .sort((left, right) => left.relayInstanceId.localeCompare(right.relayInstanceId));
  }

  /**
   * The remote relays of the pool that serve or may serve again, for Opfield to measure its own round trip to (its
   * local relay runs on its host). Its streams then know every relay's distance whenever they move.
   */
  async remoteLatencyTargets(): Promise<RelayLatencyTarget[]> {
    const rows = await this.db
      .select({
        id: relayInstances.id,
        addresses: relayInstances.advertisedAddresses,
        port: relayInstances.servicePort,
      })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          inArray(relayInstances.state, ['ready', 'draining', 'offline']),
          eq(relayInstances.kind, 'remote'),
          isNotNull(relayInstances.certificateFingerprint)
        )
      );
    return rows.map(({ id, addresses, port }) => ({ relayInstanceId: id, addresses, port }));
  }
}
