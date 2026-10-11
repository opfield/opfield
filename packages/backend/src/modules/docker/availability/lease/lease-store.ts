import { eq, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  availabilityLeaseCluster,
  availabilityLeaseKeyRotations,
  availabilityLeaseMembers,
  dockerAvailabilityLeaseState,
  leasePolicies,
} from '@/db/schema/index.js';
import { LEASE_CLUSTER_ID, MAX_KEY_ROTATION_LINKS } from './lease-constants.js';
import { registerAvailabilityLeasePolicy } from './lease-policy-registry.js';

export type LeaseClusterRow = typeof availabilityLeaseCluster.$inferSelect;
export type LeaseMemberRow = typeof availabilityLeaseMembers.$inferSelect;
export type LeaseStateRow = typeof dockerAvailabilityLeaseState.$inferSelect;
export type LeaseKeyRotationRow = typeof availabilityLeaseKeyRotations.$inferSelect;
type Executor = DrizzleExecutor;

export async function loadLeaseCluster(db: Executor): Promise<LeaseClusterRow | null> {
  const [row] = await db
    .select()
    .from(availabilityLeaseCluster)
    .where(eq(availabilityLeaseCluster.id, LEASE_CLUSTER_ID))
    .limit(1);
  return row ?? null;
}

/** Creates the singleton cluster row on first use. */
export async function ensureLeaseCluster(db: Executor): Promise<LeaseClusterRow> {
  await db.insert(availabilityLeaseCluster).values({ id: LEASE_CLUSTER_ID }).onConflictDoNothing();
  const row = await loadLeaseCluster(db);
  if (!row) throw new Error('Availability lease cluster state is unavailable');
  return row;
}

/** Any change of a published block or of the key chain moves the distribution revision. */
export async function bumpLeaseRevision(db: Executor): Promise<number> {
  const [row] = await db
    .update(availabilityLeaseCluster)
    .set({ revision: sql`${availabilityLeaseCluster.revision} + 1`, updatedAt: new Date() })
    .where(eq(availabilityLeaseCluster.id, LEASE_CLUSTER_ID))
    .returning({ revision: availabilityLeaseCluster.revision });
  return row?.revision ?? 0;
}

export async function loadLeaseMembers(db: Executor): Promise<LeaseMemberRow[]> {
  return db.select().from(availabilityLeaseMembers);
}

/** Rotation links in chain order (oldest first), bounded like the daemon-side key chain. */
export async function loadLeaseKeyRotations(db: Executor): Promise<LeaseKeyRotationRow[]> {
  const rows = await db.select().from(availabilityLeaseKeyRotations);
  return rows
    .sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.keyId.localeCompare(right.keyId)
    )
    .slice(-MAX_KEY_ROTATION_LINKS);
}

/** Lease state of a policy, created in legacy on first use (an Availability policy is registered first). */
export async function ensureLeaseState(db: Executor, policyId: string): Promise<LeaseStateRow> {
  const [registered] = await db
    .select({ id: leasePolicies.id })
    .from(leasePolicies)
    .where(eq(leasePolicies.id, policyId))
    .limit(1);
  if (!registered) await registerAvailabilityLeasePolicy(db, policyId);
  // Dated on Gateway's clock like every later mode change.
  const now = new Date();
  await db
    .insert(dockerAvailabilityLeaseState)
    .values({ policyId, modeChangedAt: now, updatedAt: now })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(dockerAvailabilityLeaseState)
    .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
    .limit(1);
  if (!row) throw new Error(`Lease state for lease policy ${policyId} is unavailable`);
  return row;
}

/** Lease state of an Availability policy (its own lease policy), registered and created in legacy on first use. */
export async function ensureAvailabilityLeaseState(db: Executor, policyId: string): Promise<LeaseStateRow> {
  await registerAvailabilityLeasePolicy(db, policyId);
  return ensureLeaseState(db, policyId);
}

/** The members a relay last reported a live Coordinate stream from, and when. */
export interface RelayConnectedMembers {
  relayId: string;
  memberIds: readonly string[];
  reportedAt: number;
}

/**
 * Voters that can take part in a lease round without Gateway (D2 margin, stand runs ha18/b and c1):
 * - alive: its own report is fresh, or a relay reported its live Coordinate stream (after a Gateway restart the local
 *   relay reports within seconds, before the nodes' control sessions reconnect); never while it abstains;
 * - a relay counts unless it is Gateway's local relay, which stops with Gateway;
 * - a daemon counts only with a stream to a relay other than the local one, once any such relay reported its
 *   streams: a vote that reaches the others only through Gateway does not help a failover without it.
 */
export function leaseReachableMemberIds(input: {
  members: LeaseMemberRow[];
  connections: Iterable<RelayConnectedMembers>;
  localRelayIds: ReadonlySet<string>;
  now: number;
  memberFreshMs: number;
  connectionFreshMs: number;
}): Set<string> {
  const { members, localRelayIds, now } = input;
  const fresh = [...input.connections].filter((connection) => now - connection.reportedAt <= input.connectionFreshMs);
  const connected = new Set(fresh.flatMap((connection) => connection.memberIds));
  const remote = fresh.filter((connection) => !localRelayIds.has(connection.relayId));
  const connectedRemote = new Set(remote.flatMap((connection) => connection.memberIds));
  const reachable = new Set<string>();
  for (const member of members) {
    if (member.abstaining) continue;
    const reported = member.reportedAt !== null && now - member.reportedAt.getTime() <= input.memberFreshMs;
    if (!reported && !connected.has(member.memberId)) continue;
    if (member.kind === 'relay') {
      if (!localRelayIds.has(member.memberId)) reachable.add(member.memberId);
      continue;
    }
    if (remote.length === 0 || connectedRemote.has(member.memberId)) reachable.add(member.memberId);
  }
  return reachable;
}

/** Members whose report is recent and who do not abstain: the reachable voters (D2 margin). */
export function reachableMemberIds(members: LeaseMemberRow[], now: number, freshMs: number): Set<string> {
  return new Set(
    members
      .filter(
        (member) => !member.abstaining && member.reportedAt !== null && now - member.reportedAt.getTime() <= freshMs
      )
      .map((member) => member.memberId)
  );
}
