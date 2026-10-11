import type { DockerAvailabilityLeaseReason, dockerAvailabilityLeaseObservations } from '@/db/schema/index.js';
import type { LeaseRetainedSlot } from './lease-codec.js';
import {
  AVAILABILITY_LEASE_CAPABILITY,
  AVAILABILITY_LEASE_V3_CAPABILITY,
  RETAINED_LEASE_ROLE,
} from './lease-constants.js';
import type { LeaseParticipants } from './lease-participants.js';
import type { LeasePolicyDescriptor } from './lease-policy-source.js';
import type { LeaseWitnessCandidate } from './lease-voters.js';

type ObservationRow = typeof dockerAvailabilityLeaseObservations.$inferSelect;

/** A policy that left lease mode waits this long before it may bootstrap again, so a flapping gate cannot thrash. */
export const LEASE_REENTRY_HOLD_MS = 60_000;

/** A7/A16: shown while a switch from available to strict waits for the other copies and the relay gate window. */
export const STRICT_SWITCH_PENDING: DockerAvailabilityLeaseReason = {
  code: 'strict_switch_pending',
  message:
    'Strict partition mode becomes active once every other copy has stopped and the relay gate window (24 s) has passed',
};

/** An explicit close of a lease policy (the only way a stateful lease closes, AS9). */
export const CLOSE_REQUESTED = {
  code: 'close_requested',
  message: 'The lease policy is being closed',
  immediate: true,
};

/** AS8: stateful keys never run in available partition mode. */
export const STATEFUL_STRICT_ONLY = {
  code: 'stateful_partition_mode_invalid',
  message: 'A lease policy with certified holder state runs only in strict partition mode',
  immediate: false,
};

export const STATEFUL_UNSUPPORTED = {
  code: 'stateful_protocol_unavailable',
  message: 'This Gateway build cannot publish lease policies with certified holder state (availability_lease_v3)',
  immediate: false,
};

/** A published policy its source no longer lists: kept as it is (never closed implicitly), reported instead. */
export const SOURCE_MISSING: DockerAvailabilityLeaseReason = {
  code: 'source_missing',
  message: 'The lease policy is published but its source no longer lists it; it keeps running as last published',
};

/** D3 exclusion of a candidate node; a node Gateway has no docker row for cannot be reached at all. */
export function participantExclusion(participants: LeaseParticipants, nodeId: string) {
  const participant = participants.byId.get(nodeId);
  return participant ? participant.exclusion : ('offline' as const);
}

/** Since when lease mode has been impossible without a break, from the stored reason; now when it just became so. */
export function impossibleSince(reason: DockerAvailabilityLeaseReason | null | undefined, now: Date): Date {
  const since = reason?.since ? Date.parse(reason.since) : Number.NaN;
  return Number.isFinite(since) && since <= now.getTime() ? new Date(since) : now;
}

/**
 * Graceful close: the retained holders a new closed manifest names, one per slot: the committed holder Gateway sees
 * for the slot now (its ballot is the one it proposed with). Closing from bootstrapping also names each slot's
 * reserved holder Gateway saw no commit of, with an empty ballot: if its bootstrap commit raced the close the acceptors
 * confirm it on the commit they hold and its copy is retained instead of fenced; if it never committed nothing changes
 * (its legacy copy was never lease-bound). Any other unheld slot has none; its holder, if any, fences.
 */
export function retainedFromObservations(
  observations: ObservationRow[],
  slots: number,
  bootstrap: Array<{ slot: number; holderId: string }> = []
): LeaseRetainedSlot[] {
  const committed = committedHolders(observations, slots);
  const named = new Set(committed.map((entry) => entry.slot));
  const reserved = bootstrap
    .filter((entry) => entry.slot < slots && !named.has(entry.slot))
    .map((entry) => ({ slot: entry.slot, holderId: entry.holderId, ballot: null }));
  return [...committed, ...reserved].sort((left, right) => left.slot - right.slot);
}

function committedHolders(observations: ObservationRow[], slots: number): LeaseRetainedSlot[] {
  return observations
    .filter(
      (observation) =>
        observation.slot < slots &&
        observation.holderId !== null &&
        observation.ballot !== null &&
        observation.ballot.proposerId === observation.holderId
    )
    .sort((left, right) => left.slot - right.slot)
    .map((observation) => ({
      slot: observation.slot,
      holderId: observation.holderId!,
      // Field order fixed (jsonb reorders keys): the manifest digest must not change from one reconcile to the next.
      ballot: {
        round: observation.ballot!.round,
        incarnation: observation.ballot!.incarnation,
        proposerId: observation.ballot!.proposerId,
      },
    }));
}

/**
 * A named holder's copy keeps running through the close: it reported itself retained (a majority of every quorum set
 * confirmed the close to it), or it is a reserved bootstrap holder named without a ballot that persisted the close,
 * does not hold the key and runs no lease role for it. A not-yet-acquired bootstrap holder drops its round on the
 * closed manifest and can no longer commit, and the close never touches its legacy copy; a bootstrap commit that raced
 * the close shows as a lease role (holding, then retained or fencing) in its reports first.
 */
export function keepsRunningThroughClose(
  entry: LeaseRetainedSlot,
  observation: Pick<ObservationRow, 'claimants' | 'holderId'> | undefined,
  closedAckers: ReadonlySet<string>
): boolean {
  if (reportsRetained(observation, entry.holderId)) return true;
  if (entry.ballot !== null) return false;
  const holds = observation?.holderId === entry.holderId;
  const leaseRole = Boolean(observation?.claimants?.[entry.holderId]);
  return !holds && !leaseRole && closedAckers.has(entry.holderId);
}

/** The named holder reported itself retained: a majority of every quorum set confirmed the close to it. */
export function reportsRetained(observation: Pick<ObservationRow, 'claimants'> | undefined, holderId: string): boolean {
  return observation?.claimants?.[holderId]?.role === RETAINED_LEASE_ROLE;
}

/** The observation without the slot's retained holder, whose copy legitimately keeps running. */
export function withoutRetainedHolder(observation: ObservationRow, holderId: string | undefined): ObservationRow {
  if (!holderId) return observation;
  const claimants = { ...(observation.claimants ?? {}) };
  delete claimants[holderId];
  return { ...observation, holderId: observation.holderId === holderId ? null : observation.holderId, claimants };
}

/**
 * A5 / D3: closing may hand the policy to legacy before the settle time only when no copy can run anywhere: no slot has
 * a holder or a daemon reporting a role in which its copy may run, and every node that could hold (candidates, last
 * holders, claimants, reserved holders) persisted the closed manifest, so none of them acquires again.
 */
export function closedEverywhere(input: {
  observations: ObservationRow[];
  bootstrap: Array<{ slot: number; holderId: string }>;
  candidateNodeIds: readonly string[];
  closedAckers: ReadonlySet<string>;
  /** Every slot has a confirmed retained holder: nobody can acquire any key any more, acks are not needed. */
  everySlotRetained?: boolean;
}): boolean {
  const running = input.observations.some(
    (observation) => observation.holderId !== null || Object.keys(observation.claimants ?? {}).length > 0
  );
  if (running) return false;
  if (input.everySlotRetained) return true;
  const possible = new Set<string>(input.candidateNodeIds);
  for (const observation of input.observations) {
    if (observation.lastHolderId) possible.add(observation.lastHolderId);
  }
  for (const entry of input.bootstrap) possible.add(entry.holderId);
  return possible.size > 0 && [...possible].every((id) => input.closedAckers.has(id));
}

/**
 * The last holder per slot; before any holder was observed, the reserved bootstrap holders, whose legacy copies kept
 * running while they tried to acquire (A5).
 */
export function lastHolders(
  observations: ObservationRow[],
  bootstrap: Array<{ slot: number; holderId: string }>
): Array<{ slot: number; holderId: string }> {
  const observed = observations.flatMap((observation) => {
    const holderId = observation.holderId ?? observation.lastHolderId;
    return holderId ? [{ slot: observation.slot, holderId }] : [];
  });
  const slots = new Set(observed.map(({ slot }) => slot));
  return [...observed, ...bootstrap.filter((entry) => !slots.has(entry.slot))].sort((a, b) => a.slot - b.slot);
}

/** The capabilities a descriptor requires beyond the lease protocol; stateful always includes v3 (AS8). */
export function requiredLeaseCapabilities(
  descriptor: Pick<LeasePolicyDescriptor, 'stateful' | 'requiredCapabilities'>
) {
  const required = new Set(
    descriptor.requiredCapabilities.filter((capability) => capability !== AVAILABILITY_LEASE_CAPABILITY)
  );
  if (descriptor.stateful) required.add(AVAILABILITY_LEASE_V3_CAPABILITY);
  return [...required].sort();
}

/** Why a descriptor cannot be published at all; null when it is well-formed. */
export function descriptorProblem(descriptor: LeasePolicyDescriptor): string | null {
  if (!Number.isInteger(descriptor.slots) || descriptor.slots < 1 || descriptor.slots > 32) return 'slots out of range';
  if (descriptor.mode === 'failover' && descriptor.slots !== 1) return 'failover policies have one slot';
  const members = descriptor.candidates.map((candidate) => candidate.memberId);
  if (new Set(members).size !== members.length) return 'duplicate candidates';
  return null;
}

/**
 * The witness pool a descriptor's filter allows (availability sets, decision 7): only the listed relays, and only the
 * listed docker nodes when nodeIds is given. No filter: the whole pool (Docker Availability, unchanged).
 */
export function filterWitnessPool<T extends Pick<LeaseWitnessCandidate, 'id' | 'kind'>>(
  pool: readonly T[],
  filter: LeasePolicyDescriptor['witnessFilter']
): T[] {
  if (!filter) return [...pool];
  const relayIds = new Set(filter.relayIds);
  const nodeIds = filter.nodeIds ? new Set(filter.nodeIds) : null;
  return pool.filter((member) =>
    member.kind === 'relay' ? relayIds.has(member.id) : nodeIds === null || nodeIds.has(member.id)
  );
}
