import { and, eq, inArray, sql } from 'drizzle-orm';
import { managedDatabaseInstances, relayEndpoints } from '@/db/schema/index.js';

interface RelaySessionLimitOwner {
  ownerKind: string;
  maxConcurrentSessions: number;
  /** The endpoint's own ID (endpoints). */
  id?: string;
  /** The endpoint a route reaches (routes). */
  targetEndpointId?: string;
}

/**
 * The connection limits of the managed databases behind relay endpoints, by endpoint ID. Loaded once per policy
 * snapshot or grant bundle; a link without an entry keeps the fallback limits below.
 */
export interface RelaySessionLimits {
  databaseByEndpoint: ReadonlyMap<string, number>;
}

// HTTP traffic (proxy Secure Links, storage links) has no fixed session cap: relay admission bounds it by real load
// (CPU, memory, file descriptors) and shares it fairly between routes under pressure. Grants and daemons read 0 as
// "no limit named" (an older Opfield), so the absence of a cap is this value, far above any reachable connection count.
export const RELAY_UNCAPPED_SESSIONS = 1_000_000;

// A container link carries every connection of its consumer to one port of its target, whatever the protocol
// (HTTP clients, connection pools, queues). On a relay without registry fair share it keeps this cap, because it
// is in the database admission class there.
export const CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS = 1024;

/**
 * A relay that reports this shares the registry traffic class fairly between routes under pressure. Container links
 * move into that class without a fixed cap, in the snapshot of such a relay and in the grants for it only; every other
 * relay keeps them in the database class with CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS.
 */
export const RELAY_REGISTRY_FAIR_SHARE_CAPABILITY = 'relay_registry_fair_share_v1';

/** What a relay instance supports that changes the limits Opfield gives it. */
export interface RelaySessionLimitTarget {
  registryFairShare: boolean;
}

/** The limit target of a relay instance from its reported features (a missing or malformed list supports nothing). */
export function relaySessionLimitTarget(features: unknown): RelaySessionLimitTarget {
  return {
    registryFairShare: Array.isArray(features) && features.includes(RELAY_REGISTRY_FAIR_SHARE_CAPABILITY),
  };
}

// A managed database link carries every connection of its workload (both slots of a deployment during a rollout,
// every container of a Compose service or Availability placement). It may use as many connections as the database
// accepts, so the database stays the limit and answers with its own error. This is the cap when the database is unknown.
export const MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS = 64;

// The database endpoint carries every link of the database plus Opfield's own connections; the extra sessions let a
// client past the database limit receive the database's own refusal instead of a relay reset.
const MANAGED_DATABASE_ENDPOINT_HEADROOM = 64;

const POSTGRES_DEFAULT_MAX_CONNECTIONS = 100;
const REDIS_DEFAULT_MAX_CLIENTS = 10_000;
const CLICKHOUSE_DEFAULT_MAX_CONNECTIONS = 4096;

const UNCAPPED_OWNER_KINDS = new Set(['proxy_host_secure_link', 'managed_storage', 'managed_storage_binding']);

/** The connections a managed database accepts, from its engine settings. */
export function managedDatabaseConnectionLimit(type: string, engineConfig: unknown): number {
  const config = (engineConfig ?? {}) as {
    postgresConfig?: { maxConnections?: unknown };
    redisConfig?: { maxclients?: unknown };
  };
  if (type === 'postgres') {
    const value = config.postgresConfig?.maxConnections;
    return typeof value === 'number' && value > 0 ? value : POSTGRES_DEFAULT_MAX_CONNECTIONS;
  }
  if (type === 'redis') {
    const value = config.redisConfig?.maxclients;
    return typeof value === 'number' && value > 0 ? value : REDIS_DEFAULT_MAX_CLIENTS;
  }
  return CLICKHOUSE_DEFAULT_MAX_CONNECTIONS;
}

/**
 * Reads the limits of the managed databases behind `endpoints` (every endpoint when omitted). Takes the client or a
 * transaction (repeatable-read snapshot builds); a snapshot without database endpoints reads nothing.
 */
export async function loadRelaySessionLimits(
  db: any,
  endpoints?: ReadonlyArray<{ id: string; ownerKind: string }>
): Promise<RelaySessionLimits> {
  const endpointIds = endpoints?.filter(({ ownerKind }) => ownerKind === 'managed_database').map(({ id }) => id);
  if (endpointIds && endpointIds.length === 0) return { databaseByEndpoint: new Map() };
  const rows: Array<{ endpointId: string; type: string; engineConfig: unknown }> = await db
    .select({
      endpointId: relayEndpoints.id,
      type: managedDatabaseInstances.type,
      engineConfig: managedDatabaseInstances.engineConfig,
    })
    .from(relayEndpoints)
    .innerJoin(managedDatabaseInstances, sql`${managedDatabaseInstances.id}::text = ${relayEndpoints.ownerId}`)
    .where(
      endpointIds
        ? and(eq(relayEndpoints.ownerKind, 'managed_database'), inArray(relayEndpoints.id, endpointIds))
        : eq(relayEndpoints.ownerKind, 'managed_database')
    );
  return {
    databaseByEndpoint: new Map(
      rows.map((row) => [row.endpointId, managedDatabaseConnectionLimit(row.type, row.engineConfig)])
    ),
  };
}

/**
 * The session limit Opfield puts into the relay policy and into every grant of a route or endpoint. The relay
 * enforces the lower of the two, and daemons hold a link's whole node-side traffic at the grant's value. A policy and
 * the grants scoped to the same relay instance must use the same `target`; grants not scoped to one relay (legacy
 * grants) omit it.
 */
export function effectiveRelayMaxConcurrentSessions(
  owner: RelaySessionLimitOwner,
  limits?: RelaySessionLimits,
  target?: RelaySessionLimitTarget
): number {
  if (UNCAPPED_OWNER_KINDS.has(owner.ownerKind)) return RELAY_UNCAPPED_SESSIONS;
  if (owner.ownerKind === 'container_link') {
    if (target?.registryFairShare) return RELAY_UNCAPPED_SESSIONS;
    return Math.max(owner.maxConcurrentSessions, CONTAINER_LINK_RELAY_MAX_CONCURRENT_SESSIONS);
  }
  if (owner.ownerKind === 'managed_database_binding') {
    const limit = owner.targetEndpointId ? limits?.databaseByEndpoint.get(owner.targetEndpointId) : undefined;
    return limit ?? Math.max(owner.maxConcurrentSessions, MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS);
  }
  if (owner.ownerKind === 'managed_database') {
    const limit = owner.id ? limits?.databaseByEndpoint.get(owner.id) : undefined;
    return limit === undefined
      ? owner.maxConcurrentSessions
      : Math.max(owner.maxConcurrentSessions, limit + MANAGED_DATABASE_ENDPOINT_HEADROOM);
  }
  return owner.maxConcurrentSessions;
}
