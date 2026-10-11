import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type ManagedAvailabilityMode,
  type ManagedAvailabilityState,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedDatabaseInstances,
  managedStorageClusters,
  nodes,
} from '@/db/schema/index.js';

/** A member report older than this no longer describes the member (members report with every heartbeat). */
const MEMBER_REPORT_FRESH_MS = 45_000;

/**
 * A member's health in an app overview: healthy (the serving primary, or a copy that can take over), degraded (a copy
 * catching up or rebuilding, a primary between roles), down (not reporting, fenced or unknown), stopped (the set is
 * paused, for example by an app shutdown).
 */
export type AvailabilityMemberHealth = 'healthy' | 'degraded' | 'down' | 'stopped';

export interface AvailabilityOverviewMember {
  memberId: string;
  nodeId: string;
  nodeName: string | null;
  role: string;
  primary: boolean;
  eligible: boolean;
  health: AvailabilityMemberHealth;
  lastReportedAt: string | null;
}

/** A database or storage that runs on several servers, as an app overview shows it (P3-T08). */
export interface AvailabilityOverview {
  state: ManagedAvailabilityState;
  mode: ManagedAvailabilityMode;
  stateReason: string | null;
  members: AvailabilityOverviewMember[];
}

export function availabilityMemberHealth(
  member: {
    role: string;
    eligible: boolean;
    lastReportedAt: Date | null;
    enginePosition: Record<string, unknown> | null;
  },
  primary: boolean,
  now: number
): AvailabilityMemberHealth {
  if (member.enginePosition?.['runtime.stopped'] === 'true') return 'stopped';
  const fresh = !!member.lastReportedAt && now - member.lastReportedAt.getTime() <= MEMBER_REPORT_FRESH_MS;
  if (!fresh || member.role === 'fenced' || member.role === 'unknown') return 'down';
  if (primary) return member.role === 'primary' ? 'healthy' : 'degraded';
  return member.role === 'copy' && member.eligible ? 'healthy' : 'degraded';
}

/** The availability set of each database (by connection id) or storage (by storage connection id) that has one. */
export async function availabilityOverviews(
  db: DrizzleClient,
  kind: 'database' | 'storage',
  connectionIds: readonly string[],
  now = Date.now()
): Promise<Map<string, AvailabilityOverview>> {
  const result = new Map<string, AvailabilityOverview>();
  if (connectionIds.length === 0) return result;
  const sets =
    kind === 'database'
      ? await db
          .select({ connectionId: managedDatabaseInstances.databaseConnectionId, set: managedAvailabilitySets })
          .from(managedAvailabilitySets)
          .innerJoin(
            managedDatabaseInstances,
            eq(managedDatabaseInstances.id, managedAvailabilitySets.managedDatabaseId)
          )
          .where(inArray(managedDatabaseInstances.databaseConnectionId, [...connectionIds]))
      : await db
          .select({ connectionId: managedStorageClusters.objectStorageConnectionId, set: managedAvailabilitySets })
          .from(managedAvailabilitySets)
          .innerJoin(
            managedStorageClusters,
            eq(managedStorageClusters.id, managedAvailabilitySets.managedStorageClusterId)
          )
          .where(inArray(managedStorageClusters.objectStorageConnectionId, [...connectionIds]));
  if (sets.length === 0) return result;
  const members = await db
    .select({
      member: managedAvailabilityMembers,
      nodeName: nodes.displayName,
      hostname: nodes.hostname,
    })
    .from(managedAvailabilityMembers)
    .innerJoin(nodes, eq(nodes.id, managedAvailabilityMembers.nodeId))
    .where(
      and(
        inArray(
          managedAvailabilityMembers.setId,
          sets.map((row) => row.set.id)
        ),
        eq(managedAvailabilityMembers.desiredState, 'member')
      )
    );
  for (const { connectionId, set } of sets) {
    if (!connectionId) continue;
    const own = members
      .filter((row) => row.member.setId === set.id)
      .sort((a, b) => a.member.memberIndex - b.member.memberIndex);
    result.set(connectionId, {
      state: set.state,
      mode: set.mode,
      stateReason: set.stateReason?.message ?? null,
      members: own.map(({ member, nodeName, hostname }) => {
        const primary = member.id === set.primaryMemberId;
        return {
          memberId: member.id,
          nodeId: member.nodeId,
          nodeName: nodeName || hostname || null,
          role: member.role,
          primary,
          eligible: member.eligible,
          health: availabilityMemberHealth(member, primary, now),
          lastReportedAt: member.lastReportedAt ? member.lastReportedAt.toISOString() : null,
        };
      }),
    });
  }
  return result;
}
