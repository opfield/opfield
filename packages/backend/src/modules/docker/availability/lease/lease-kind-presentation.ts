import { eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { type ManagedAvailabilityOwnerKind, managedAvailabilitySets } from '@/db/schema/index.js';
import type { LeaseTakeoverSource } from './lease-planning.js';
import type { LeaseHolderChangeNotice, LeaseModeChange, LeasePolicyKind } from './lease-policy-source.js';

/**
 * How the host names lease transitions of each kind in the audit log and on the event bus. Availability keeps its
 * names (docker.availability.lease_failover / lease_handoff on the policy). An availability set's failover and planned
 * switchover are audited once, here, as availability.failover / availability.switchover on the set's owner (the
 * managed database or storage cluster), dated when the new primary took over; the control plane does not audit them
 * again.
 */
export interface LeaseAuditSubject {
  resourceType: string;
  resourceId: string;
  action: string;
  /** Extra audit details besides the lease transition (never for Availability: its entries stay as they were). */
  details: Record<string, unknown>;
}

export interface LeaseSetOwner {
  setId: string;
  ownerKind: ManagedAvailabilityOwnerKind;
  ownerId: string;
}

/** The owner of an availability set, for audit and events; null once the set is gone. */
export async function loadLeaseSetOwner(db: DrizzleExecutor, setId: string): Promise<LeaseSetOwner | null> {
  const [row] = await db
    .select({ ownerKind: managedAvailabilitySets.ownerKind, ownerId: managedAvailabilitySets.ownerId })
    .from(managedAvailabilitySets)
    .where(eq(managedAvailabilitySets.id, setId))
    .limit(1);
  return row ? { setId, ...row } : null;
}

/** The kind of a holder change; takeover audits stored before 2.12 are Availability. */
export function noticeKind(notice: Pick<LeaseHolderChangeNotice, 'leaseKind'>): LeasePolicyKind {
  return notice.leaseKind ?? 'docker_availability';
}

/** Where the audit row of a failover or planned handoff goes; null when the subject no longer exists. */
export function leaseAuditSubject(
  notice: LeaseHolderChangeNotice & { kind: 'failover' | 'handoff' },
  owner: LeaseSetOwner | null
): LeaseAuditSubject | null {
  if (noticeKind(notice) === 'docker_availability') {
    return {
      resourceType: 'docker_availability_policy',
      resourceId: notice.policyId,
      action: `docker.availability.lease_${notice.kind}`,
      details: {},
    };
  }
  if (!owner) return null;
  return {
    resourceType: owner.ownerKind,
    resourceId: owner.ownerId,
    action: notice.kind === 'handoff' ? 'availability.switchover' : 'availability.failover',
    details: { setId: owner.setId, leasePolicyId: notice.policyId, stateHash: notice.stateHash ?? null },
  };
}

/** The audit entry of an autonomous failover or planned handoff (D9), dated when the new holder took over (N-5). */
export function leaseHolderAuditEntry(input: {
  subject: LeaseAuditSubject;
  notice: LeaseHolderChangeNotice;
  takeoverId: string;
  takeoverAt: Date;
  source: LeaseTakeoverSource;
  noticedAt: Date;
}) {
  const { subject, notice, takeoverAt } = input;
  return {
    userId: null,
    action: subject.action,
    resourceType: subject.resourceType,
    resourceId: subject.resourceId,
    // N-5 / B-14: the transition happened when the new holder took over, which after an autonomous failover while
    // Gateway was down is well before Gateway learns about it.
    occurredAt: takeoverAt,
    details: {
      slot: notice.slot,
      fromNodeId: notice.from,
      toNodeId: notice.to,
      placementId: notice.placementId,
      ballot: notice.ballot,
      observedBy: notice.sourceId,
      source: notice.source,
      takeoverAt: takeoverAt.toISOString(),
      // holder: the new holder's own acquisition time; voters: the earliest voter sighting; noticed: nobody reported
      // a time, this is when Gateway noticed the change.
      takeoverSource: input.source,
      noticedAt: input.noticedAt.toISOString(),
      takeoverId: input.takeoverId,
      // C-4: the lost-range estimate of a set failover at takeover.
      ...(notice.loss ? { lossBytes: notice.loss.bytes, lossSince: notice.loss.since } : {}),
      ...subject.details,
    },
  };
}

/** The event of a lease transition (holder change or mode change) of any kind. */
export function leaseEvent(
  kind: LeasePolicyKind,
  leasePolicyId: string,
  resourceId: string,
  action: string,
  owner: LeaseSetOwner | null
): { channel: string; payload: Record<string, unknown> } {
  if (kind === 'docker_availability') {
    return { channel: 'docker.availability.changed', payload: { policyId: leasePolicyId, action } };
  }
  return {
    channel: 'availability.set.changed',
    payload: {
      setId: resourceId,
      ownerKind: owner?.ownerKind ?? null,
      ownerId: owner?.ownerId ?? null,
      leasePolicyId,
      action,
    },
  };
}

export function leaseModeEvent(change: LeaseModeChange, owner: LeaseSetOwner | null) {
  return leaseEvent(change.leaseKind, change.leasePolicyId, change.resourceId, `lease_${change.to}`, owner);
}
