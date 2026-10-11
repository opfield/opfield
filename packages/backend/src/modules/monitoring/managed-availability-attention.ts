import { and, eq, gt, inArray, max } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  auditLog,
  databaseConnections,
  type ManagedAvailabilityStateReason,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedDatabaseInstances,
  managedStorageClusters,
  objectStorageConnections,
} from '@/db/schema/index.js';
import { hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';

/** Why a database or storage on several servers is on the Dashboard, most urgent first. */
export type AvailabilityAttentionReason =
  | 'primary_unreachable'
  | 'no_failover'
  | 'witness_lost'
  | 'degraded'
  | 'failover';

/** A managed database or storage on several servers that needs a look, as the Dashboard lists it. */
export interface DashboardAvailabilityAttention {
  kind: 'storage' | 'database';
  /** The canonical connection the UI links to and permissions are issued for. */
  id: string;
  slug: string;
  name: string;
  reason: AvailabilityAttentionReason;
  /** The set's own explanation (its state reason), when it has one. */
  message: string | null;
  /** Since when (the failover's time for `failover`). */
  since: string | null;
}

/** A member's report counts as current for this long (the control plane's freshness). */
export const AVAILABILITY_REPORT_FRESH_MS = 45_000;
/** A failover stays on the Dashboard for a day, so it is seen even when it healed by itself. */
export const AVAILABILITY_FAILOVER_SHOWN_MS = 24 * 60 * 60 * 1000;
const WITNESS_REASON_CODES = new Set(['witness_offline', 'keeper_quorum_lost', 'no_witness_relay']);

export interface AvailabilitySetFacts {
  mode: string;
  state: string;
  stateReason: ManagedAvailabilityStateReason | null;
  /** Manual pairs: when the assigned primary last reported (null: never). */
  primaryLastReportedAt: Date | null;
  /** The newest failover of the set's resource in the shown window. */
  lastFailoverAt: Date | null;
}

/** The one reason a set is on the Dashboard (the most urgent), or null when it needs no look. */
export function availabilityAttention(
  facts: AvailabilitySetFacts,
  now: number
): { reason: AvailabilityAttentionReason; message: string | null; since: string | null } | null {
  // Turning on or off: the operation's own progress shows on the resource page.
  if (facts.state === 'converting' || facts.state === 'closing') return null;
  const reason = facts.stateReason;
  const since = reason?.since ?? null;
  const message = reason?.message ?? null;
  if (
    facts.mode === 'manual' &&
    (!facts.primaryLastReportedAt || now - facts.primaryLastReportedAt.getTime() > AVAILABILITY_REPORT_FRESH_MS)
  ) {
    return {
      reason: 'primary_unreachable',
      message: 'The primary does not report; make the copy primary if it does not come back',
      since: facts.primaryLastReportedAt?.toISOString() ?? null,
    };
  }
  if (facts.state === 'no_failover') return { reason: 'no_failover', message, since };
  const codes = [reason?.code, ...(reason?.reasons ?? []).map((entry) => entry.code)];
  const witness = (reason?.reasons ?? []).find((entry) => WITNESS_REASON_CODES.has(entry.code));
  if (codes.some((code) => code && WITNESS_REASON_CODES.has(code))) {
    return { reason: 'witness_lost', message: witness?.message ?? message, since };
  }
  if (facts.state === 'degraded' || facts.state === 'error') return { reason: 'degraded', message, since };
  if (facts.lastFailoverAt && now - facts.lastFailoverAt.getTime() <= AVAILABILITY_FAILOVER_SHOWN_MS) {
    return { reason: 'failover', message: null, since: facts.lastFailoverAt.toISOString() };
  }
  return null;
}

/** Notice severity: a set that cannot fail over (or a pair whose primary is gone) is critical. */
export function availabilityAttentionSeverity(
  items: readonly DashboardAvailabilityAttention[]
): 'critical' | 'warning' {
  return items.some((item) => item.reason === 'no_failover' || item.reason === 'primary_unreachable')
    ? 'critical'
    : 'warning';
}

/**
 * Databases and storage on several servers that need attention (primary unreachable, no automatic failover, witness
 * lost, degraded, or a failover in the last day), limited to what the viewer may see (`databases:view` /
 * `storage:view`, broad or for that connection).
 */
export async function visibleManagedAvailabilityAttention(
  db: DrizzleClient,
  scopes: string[],
  now = Date.now()
): Promise<DashboardAvailabilityAttention[]> {
  const canViewStorage = hasScopeBase(scopes, 'storage:view');
  const canViewDatabases = hasScopeBase(scopes, 'databases:view');
  if (!canViewStorage && !canViewDatabases) return [];
  const sets = await db
    .select({
      ownerKind: managedAvailabilitySets.ownerKind,
      ownerId: managedAvailabilitySets.ownerId,
      mode: managedAvailabilitySets.mode,
      state: managedAvailabilitySets.state,
      stateReason: managedAvailabilitySets.stateReason,
      primaryMemberId: managedAvailabilitySets.primaryMemberId,
    })
    .from(managedAvailabilitySets);
  const visibleSets = sets.filter((set) => (set.ownerKind === 'managed_storage' ? canViewStorage : canViewDatabases));
  if (visibleSets.length === 0) return [];

  const primaryIds = visibleSets
    .filter((set) => set.mode === 'manual' && set.primaryMemberId)
    .map((set) => set.primaryMemberId!);
  const ownerIds = visibleSets.map((set) => set.ownerId);
  const databaseIds = visibleSets.filter((set) => set.ownerKind === 'managed_database').map((set) => set.ownerId);
  const storageIds = visibleSets.filter((set) => set.ownerKind === 'managed_storage').map((set) => set.ownerId);
  const [primaries, failovers, databases, storages] = await Promise.all([
    primaryIds.length
      ? db
          .select({ id: managedAvailabilityMembers.id, lastReportedAt: managedAvailabilityMembers.lastReportedAt })
          .from(managedAvailabilityMembers)
          .where(inArray(managedAvailabilityMembers.id, primaryIds))
      : Promise.resolve([] as Array<{ id: string; lastReportedAt: Date | null }>),
    db
      .select({ resourceId: auditLog.resourceId, at: max(auditLog.createdAt) })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'availability.failover'),
          inArray(auditLog.resourceId, ownerIds),
          gt(auditLog.createdAt, new Date(now - AVAILABILITY_FAILOVER_SHOWN_MS))
        )
      )
      .groupBy(auditLog.resourceId),
    databaseIds.length
      ? db
          .select({
            ownerId: managedDatabaseInstances.id,
            id: databaseConnections.id,
            slug: databaseConnections.slug,
            name: databaseConnections.name,
          })
          .from(managedDatabaseInstances)
          .innerJoin(databaseConnections, eq(databaseConnections.id, managedDatabaseInstances.databaseConnectionId))
          .where(inArray(managedDatabaseInstances.id, databaseIds))
      : Promise.resolve([] as Array<{ ownerId: string; id: string; slug: string; name: string }>),
    storageIds.length
      ? db
          .select({
            ownerId: managedStorageClusters.id,
            id: objectStorageConnections.id,
            slug: objectStorageConnections.slug,
            name: objectStorageConnections.name,
          })
          .from(managedStorageClusters)
          .innerJoin(
            objectStorageConnections,
            eq(objectStorageConnections.id, managedStorageClusters.objectStorageConnectionId)
          )
          .where(inArray(managedStorageClusters.id, storageIds))
      : Promise.resolve([] as Array<{ ownerId: string; id: string; slug: string; name: string }>),
  ]);
  const primaryReport = new Map(primaries.map((row) => [row.id, row.lastReportedAt]));
  const failoverAt = new Map(failovers.map((row) => [row.resourceId, row.at]));
  const owners = new Map([...databases, ...storages].map((row) => [row.ownerId, row]));

  return visibleSets.flatMap((set): DashboardAvailabilityAttention[] => {
    const storage = set.ownerKind === 'managed_storage';
    const resource = owners.get(set.ownerId);
    if (!resource) return [];
    if (!hasScopeForResource(scopes, storage ? 'storage:view' : 'databases:view', resource.id)) return [];
    const attention = availabilityAttention(
      {
        mode: set.mode,
        state: set.state,
        stateReason: set.stateReason ?? null,
        primaryLastReportedAt: set.primaryMemberId ? (primaryReport.get(set.primaryMemberId) ?? null) : null,
        lastFailoverAt: failoverAt.get(set.ownerId) ?? null,
      },
      now
    );
    if (!attention) return [];
    return [
      {
        kind: storage ? 'storage' : 'database',
        id: resource.id,
        slug: resource.slug,
        name: resource.name,
        ...attention,
      },
    ];
  });
}
