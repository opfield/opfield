import { eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  relayEndpoints,
  relayInstancePolicyState,
  relayInstances,
  relayPolicyState,
  relayPools,
  relayRoutes,
} from '@/db/schema/index.js';
import type { RelayPolicyRouteEntry } from '@/db/schema/relay.js';
import { LEGACY_LOCK_RELAY_REMOTE_POLICY_REVISION } from '@/lib/legacy-compat.js';
import {
  type BuiltPolicyRoute,
  type CurrentPolicyRoute,
  projectBuiltRoutes,
  type RelayRevokedRouteFence,
  reconcileRevocations,
  revocationFencesForEndpoints,
  staleRelaysByRoute,
  trustedAcknowledgement,
} from './relay-revocation-fence.js';

/**
 * Serializes route history writes with policy snapshot builds, which hold the same lock.
 *
 * Lock order: this advisory lock, then relay_policy_state (FOR SHARE in builds), then
 * relay_pools and relay_instance_policy_state. Nothing here locks a relay_instances row: pool
 * reconciliation updates an instance and then bumps relay_policy_state without this lock, so an
 * instance row lock taken after relay_policy_state would deadlock with it.
 */
export const RELAY_POLICY_REVISION_LOCK = LEGACY_LOCK_RELAY_REMOTE_POLICY_REVISION;

const HAS_UNACKNOWLEDGED_REMOVAL = sql`jsonb_path_exists(${relayInstancePolicyState.routes}, '$[*] ? (exists(@.removedAtRevision))')`;
const HAS_STALE_ROUTE = sql`jsonb_path_exists(${relayInstancePolicyState.routes}, '$[*] ? (exists(@.staleAt))')`;

export interface RelayRevocationTransition {
  instanceId: string;
  poolId: string;
  displayName: string;
  /** Whether the relay is now stale for at least one revoked route. */
  stale: boolean;
  staleRoutes: number;
}

export interface RelayRevocationOutcome {
  transitions: RelayRevocationTransition[];
  /** Daemons whose grant bundles change: sources lose the stale relay, endpoints gain or lose fences. */
  nodeIds: string[];
}

const NO_OUTCOME: RelayRevocationOutcome = { transitions: [], nodeIds: [] };

export type InstancePolicyState = typeof relayInstancePolicyState.$inferSelect;

/** The bookkeeping row of one relay, read inside a snapshot build transaction. */
export async function loadInstancePolicyState(
  tx: Pick<DrizzleClient, 'select'>,
  instanceId: string
): Promise<InstancePolicyState | undefined> {
  const [row] =
    (await tx
      .select()
      .from(relayInstancePolicyState)
      .where(eq(relayInstancePolicyState.instanceId, instanceId))
      .limit(1)) ?? [];
  return row;
}

export interface BuiltSnapshotRecord {
  key: string;
  revision: number;
  issuedAtUnix: number;
  expiresAtUnix: number;
}

/**
 * Records, inside a snapshot build transaction that holds RELAY_POLICY_REVISION_LOCK, the snapshot
 * just built for the relay and the route tuples it carries, keeping earlier tuples until the relay
 * acknowledges. Only builds that allocate a new revision call this.
 */
export async function recordBuiltSnapshot(
  tx: Pick<DrizzleClient, 'insert'>,
  instanceId: string,
  previous: Pick<InstancePolicyState, 'routes'> | undefined,
  built: BuiltPolicyRoute[],
  snapshot: BuiltSnapshotRecord
): Promise<void> {
  const values = {
    routes: projectBuiltRoutes(previous?.routes, built, snapshot.revision),
    snapshotKey: snapshot.key,
    snapshotRevision: snapshot.revision,
    snapshotIssuedAtUnix: snapshot.issuedAtUnix,
    snapshotExpiresAtUnix: snapshot.expiresAtUnix,
    updatedAt: new Date(),
  };
  await tx
    .insert(relayInstancePolicyState)
    .values({ instanceId, ...values })
    .onConflictDoUpdate({ target: relayInstancePolicyState.instanceId, set: values });
}

/**
 * Whether the relay already holds a snapshot with this content: Opfield built it, the relay
 * reports that exact revision, and more than half of the relay's lease length is left. Rebuilding it
 * would only spend a revision and make the relay re-apply the same policy.
 */
export function holdsCurrentSnapshot(
  previous:
    | Pick<InstancePolicyState, 'snapshotKey' | 'snapshotRevision' | 'snapshotIssuedAtUnix' | 'snapshotExpiresAtUnix'>
    | undefined,
  key: string,
  reportedRevision: number,
  nowUnix: number,
  /** This relay's lease length now; the key covers it, so a changed length already rebuilds. */
  leaseSeconds: number
): boolean {
  if (!previous?.snapshotKey || previous.snapshotKey !== key) return false;
  const { snapshotRevision, snapshotExpiresAtUnix } = previous;
  if (snapshotRevision == null || snapshotExpiresAtUnix == null) return false;
  if (snapshotRevision !== reportedRevision) return false;
  return snapshotExpiresAtUnix - nowUnix > leaseSeconds / 2;
}

/** Relays stale for at least one revoked route, with their route history. */
export async function loadStaleRelayRoutes(
  db: Pick<DrizzleClient, 'select'>
): Promise<Array<{ id: string; policyRoutes: RelayPolicyRouteEntry[] | null }>> {
  return db
    .select({ id: relayInstancePolicyState.instanceId, policyRoutes: relayInstancePolicyState.routes })
    .from(relayInstancePolicyState)
    .innerJoin(relayInstances, eq(relayInstances.id, relayInstancePolicyState.instanceId))
    .where(HAS_STALE_ROUTE);
}

/** Every relay's route history, for health surfaces. */
export async function loadRelayRouteHistories(
  db: Pick<DrizzleClient, 'select'>
): Promise<Map<string, RelayPolicyRouteEntry[]>> {
  const rows = await db
    .select({ instanceId: relayInstancePolicyState.instanceId, routes: relayInstancePolicyState.routes })
    .from(relayInstancePolicyState);
  return new Map(rows.map(({ instanceId, routes }) => [instanceId, routes]));
}

/** What grant issuance needs to keep stale relays away from the routes they may still admit. */
export async function loadRevocationFenceState(db: Pick<DrizzleClient, 'select'>) {
  const stale = await loadStaleRelayRoutes(db);
  return {
    staleRelaysByRoute: staleRelaysByRoute(stale),
    async fencesForEndpoints(endpointIds: string[]): Promise<RelayRevokedRouteFence[]> {
      const endpoints = new Set(endpointIds);
      const routeIds = [
        ...new Set(
          stale.flatMap(({ policyRoutes }) =>
            (policyRoutes ?? [])
              .filter((entry) => entry.staleAt && endpoints.has(entry.endpointId))
              .map(({ routeId }) => routeId)
          )
        ),
      ];
      if (!routeIds.length) return [];
      const routes = await db
        .select({
          id: relayRoutes.id,
          generation: relayRoutes.generation,
          targetEndpointId: relayRoutes.targetEndpointId,
        })
        .from(relayRoutes)
        .where(inArray(relayRoutes.id, routeIds));
      return revocationFencesForEndpoints(
        stale,
        endpoints,
        new Map(routes.map((route) => [route.id, route satisfies CurrentPolicyRoute]))
      );
    },
  };
}

/**
 * Tracks, per relay, the route tuples it may still admit and whether it applied the policy that
 * revoked them in time. Relays report the revision they applied every few seconds, so a relay
 * that Opfield can reach clears a revocation long before the deadline; one cut off from Opfield
 * does not, and becomes stale only for the revoked routes.
 */
export class RelayRevocationFenceService {
  private lastEvaluatedRevision: number | null = null;

  constructor(private readonly db: DrizzleClient) {}

  async evaluate(now = new Date(), judgeFrom = 0): Promise<RelayRevocationOutcome> {
    const [state] = await this.db
      .select({ revision: relayPolicyState.revision })
      .from(relayPolicyState)
      .where(eq(relayPolicyState.id, 'current'))
      .limit(1);
    if (!state) return NO_OUTCOME;
    // Tuples turn into revocations only when the policy changes; otherwise only relays still
    // holding dropped tuples can acknowledge them or run past their deadline.
    const full = state.revision !== this.lastEvaluatedRevision;
    const candidates = await this.db
      .select({ id: relayInstancePolicyState.instanceId })
      .from(relayInstancePolicyState)
      .where(full ? undefined : HAS_UNACKNOWLEDGED_REMOVAL);
    if (!candidates.length) {
      this.lastEvaluatedRevision = state.revision;
      return NO_OUTCOME;
    }
    const outcome = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RELAY_POLICY_REVISION_LOCK}))`);
      // Bookkeeping of removed relays: no foreign key cascades it (see the table).
      if (full) {
        const orphans = await tx
          .select({ id: relayInstancePolicyState.instanceId })
          .from(relayInstancePolicyState)
          .leftJoin(relayInstances, eq(relayInstances.id, relayInstancePolicyState.instanceId))
          .where(isNull(relayInstances.id));
        if (orphans.length)
          await tx.delete(relayInstancePolicyState).where(
            inArray(
              relayInstancePolicyState.instanceId,
              orphans.map(({ id }) => id)
            )
          );
      }
      // One connection: the reads run in turn. Plain reads of relay_instances take no row lock.
      const instances = await tx
        .select({
          id: relayInstances.id,
          poolId: relayInstances.poolId,
          displayName: relayInstances.displayName,
          appliedPolicyRevision: relayInstances.appliedPolicyRevision,
          policyRoutes: relayInstancePolicyState.routes,
        })
        .from(relayInstancePolicyState)
        .innerJoin(relayInstances, eq(relayInstances.id, relayInstancePolicyState.instanceId))
        .where(
          inArray(
            relayInstancePolicyState.instanceId,
            candidates.map(({ id }) => id)
          )
        );
      const pools = await tx.select({ id: relayPools.id, revision: relayPools.desiredPolicyRevision }).from(relayPools);
      const routes = await tx
        .select({
          id: relayRoutes.id,
          generation: relayRoutes.generation,
          targetEndpointId: relayRoutes.targetEndpointId,
          sourceKind: relayRoutes.sourceKind,
          sourceId: relayRoutes.sourceId,
        })
        .from(relayRoutes);
      const endpoints = await tx
        .select({
          id: relayEndpoints.id,
          generation: relayEndpoints.generation,
          subjectKind: relayEndpoints.subjectKind,
          subjectId: relayEndpoints.subjectId,
        })
        .from(relayEndpoints);
      const poolRevisions = new Map(pools.map((pool) => [pool.id, pool.revision]));
      const routeById = new Map(routes.map((route) => [route.id, route]));
      const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
      const endpointGenerations = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.generation]));
      const transitions: RelayRevocationTransition[] = [];
      const nodeIds = new Set<string>();
      for (const instance of instances) {
        const issued = poolRevisions.get(instance.poolId) ?? 0;
        const reconciled = reconcileRevocations(instance.policyRoutes, {
          acknowledgedRevision: trustedAcknowledgement(instance.appliedPolicyRevision, issued),
          nextRevision: issued + 1,
          routes: routeById,
          endpointGenerations,
          now,
          judgeFrom,
        });
        if (!reconciled.changed) continue;
        await tx
          .update(relayInstancePolicyState)
          .set({ routes: reconciled.entries, updatedAt: new Date() })
          .where(eq(relayInstancePolicyState.instanceId, instance.id));
        if (!reconciled.newlyStale.length && !reconciled.cleared.length) continue;
        const staleRoutes = new Set(reconciled.entries.filter((e) => e.staleAt).map(({ routeId }) => routeId));
        transitions.push({
          instanceId: instance.id,
          poolId: instance.poolId,
          displayName: instance.displayName,
          stale: staleRoutes.size > 0,
          staleRoutes: staleRoutes.size,
        });
        for (const entry of [...reconciled.newlyStale, ...reconciled.cleared]) {
          const route = routeById.get(entry.routeId);
          if (route?.sourceKind === 'daemon') nodeIds.add(route.sourceId);
          const endpoint = endpointById.get(entry.endpointId);
          if (endpoint?.subjectKind === 'daemon') nodeIds.add(endpoint.subjectId);
        }
      }
      return { transitions, nodeIds: [...nodeIds].sort() };
    });
    this.lastEvaluatedRevision = state.revision;
    return outcome;
  }
}
