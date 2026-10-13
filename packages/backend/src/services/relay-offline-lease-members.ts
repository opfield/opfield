import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { availabilityLeaseMembers, type relayInstances } from '@/db/schema/index.js';

/** A remote relay offline this long that is still an availability lease member gets a Relay Pool warning. */
export const OFFLINE_LEASE_MEMBER_WARN_MS = 24 * 60 * 60_000;

type Instance = Pick<
  typeof relayInstances.$inferSelect,
  'id' | 'kind' | 'state' | 'displayName' | 'lastSeenAt' | 'updatedAt'
>;

/**
 * A remote relay that has been offline for a long time and still signs up as a member of every availability lease
 * manifest: it keeps the pool degraded, and older docker daemons wait for it on every planned handoff (C-2).
 */
export interface OfflineLeaseMemberWarning {
  code: 'offline_lease_member';
  relayInstanceId: string;
  offlineSince: string;
  message: string;
}

export function offlineLeaseMemberWarnings(
  instances: Instance[],
  leaseMemberIds: ReadonlySet<string>,
  now = Date.now()
): OfflineLeaseMemberWarning[] {
  return instances.flatMap((instance) => {
    if (instance.kind !== 'remote' || instance.state !== 'offline' || !leaseMemberIds.has(instance.id)) return [];
    const since = instance.lastSeenAt ?? instance.updatedAt;
    if (now - since.getTime() < OFFLINE_LEASE_MEMBER_WARN_MS) return [];
    const days = Math.floor((now - since.getTime()) / (24 * 60 * 60_000));
    const name = instance.displayName || instance.id;
    return [
      {
        code: 'offline_lease_member' as const,
        relayInstanceId: instance.id,
        offlineSince: since.toISOString(),
        message:
          `Relay ${name} has been offline for ${days === 1 ? '1 day' : `${days} days`} and is still a member of ` +
          'the availability leases. Remove it from the pool if it is not coming back: until then the pool stays ' +
          'degraded, and planned Availability handoffs on nodes with older daemons wait up to 30 seconds for it.',
      },
    ];
  });
}

/** Offline remote relays still listed as lease members, as warnings; advisory, so callers ignore a failure. */
export async function loadOfflineLeaseMemberWarnings(
  db: DrizzleClient,
  instances: Instance[],
  now = Date.now()
): Promise<OfflineLeaseMemberWarning[]> {
  const offline = instances.filter(({ kind, state }) => kind === 'remote' && state === 'offline').map(({ id }) => id);
  if (!offline.length) return [];
  const members = await db
    .select({ relayInstanceId: availabilityLeaseMembers.relayInstanceId })
    .from(availabilityLeaseMembers)
    .where(
      and(
        eq(availabilityLeaseMembers.kind, 'relay'),
        inArray(availabilityLeaseMembers.relayInstanceId, offline),
        isNotNull(availabilityLeaseMembers.identityPublicKey)
      )
    );
  return offlineLeaseMemberWarnings(
    instances,
    new Set(members.flatMap(({ relayInstanceId }) => (relayInstanceId ? [relayInstanceId] : []))),
    now
  );
}
