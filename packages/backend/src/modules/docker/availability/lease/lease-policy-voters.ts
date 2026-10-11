import type { AvailabilityLeaseVoterMember } from '@/db/schema/index.js';
import { EPOCH_SETTLE_MS } from './lease-constants.js';
import { holdsEveryMajority, sameVoterSet } from './lease-voters.js';

/** A policy's published voter state (A18). */
export interface PolicyVoterState {
  voterEpoch: number;
  quorumSets: string[][];
  voterMembers: AvailabilityLeaseVoterMember[];
  /** Manifest version that introduced the current joint epoch; 0 when settled. */
  jointVersion: number;
  jointAckedAt: Date | null;
}

export interface PolicyVoterPlan {
  next: PolicyVoterState;
  /** A joint epoch starts with the next manifest version; record that version as jointVersion. */
  jointStarted: boolean;
}

function sameMembers(left: AvailabilityLeaseVoterMember[], right: AvailabilityLeaseVoterMember[]): boolean {
  const key = (members: AvailabilityLeaseVoterMember[]) =>
    JSON.stringify([...members].sort((a, b) => a.id.localeCompare(b.id)).map((m) => [m.id, m.role, m.publicKey]));
  return key(left) === key(right);
}

/**
 * Per-policy joint consensus (A4, A16, A18). A voter change publishes epoch E+1 with the sets (old, new); E+2 with the
 * new set only follows once a majority of both sets persisted E+1, every active lease of the policy renewed under
 * E+1, and at least T x 1.1 / 0.9 passed since those acks. A key change of the same voters bumps the epoch without a
 * joint phase. The epoch never goes back.
 */
export function planPolicyVoters(input: {
  state: PolicyVoterState;
  /** Desired voters in rank order (candidate hosts, then witnesses). */
  desired: string[];
  /** The current identity of a member, when it reported one. */
  memberOf(id: string): AvailabilityLeaseVoterMember | null;
  /** The voter epoch a member persisted for this policy (its A4 ack). */
  ackedEpoch(memberId: string): number;
  /** Voter epochs under which the policy's currently held leases last renewed. */
  activeLeaseEpochs: number[];
  /**
   * Stateful policies (AS1): the epoch of the last renewal of a live holder, per slot. A stateful voter change settles
   * only once every slot's live holder renewed under the joint epoch (a stateful commit is a KNOWN quorum over both
   * sets); a slot without a live holder keeps the change joint.
   */
  liveHolderEpochs?: { slots: number; bySlot: ReadonlyMap<number, number> };
  now: Date;
}): PolicyVoterPlan {
  const { state, now } = input;
  const stored = new Map(state.voterMembers.map((member) => [member.id, member]));
  const membersFor = (ids: Iterable<string>) =>
    [...new Set(ids)].sort().flatMap((id) => {
      const member = input.memberOf(id) ?? stored.get(id);
      return member ? [member] : [];
    });
  const known = (ids: string[]) => ids.filter((id) => input.memberOf(id) ?? stored.get(id)).sort();
  const desired = known(input.desired);
  const unchanged: PolicyVoterPlan = { next: state, jointStarted: false };
  if (desired.length === 0) return unchanged;
  if (state.voterEpoch === 0 || state.quorumSets.length === 0) {
    return {
      next: {
        voterEpoch: state.voterEpoch + 1,
        quorumSets: [desired],
        voterMembers: membersFor(desired),
        jointVersion: 0,
        jointAckedAt: null,
      },
      jointStarted: false,
    };
  }
  if (state.quorumSets.length === 2) {
    const [previous, next] = state.quorumSets as [string[], string[]];
    const acked = new Set(
      [...new Set([...previous, ...next])].filter((id) => input.ackedEpoch(id) >= state.voterEpoch)
    );
    const ackedAt =
      state.jointAckedAt ?? (holdsEveryMajority([previous], acked) && holdsEveryMajority([next], acked) ? now : null);
    const live = input.liveHolderEpochs;
    const renewed =
      input.activeLeaseEpochs.every((epoch) => epoch >= state.voterEpoch) &&
      (!live ||
        Array.from({ length: live.slots }, (_, slot) => live.bySlot.get(slot) ?? 0).every(
          (epoch) => epoch >= state.voterEpoch
        ));
    if (ackedAt && renewed && now.getTime() - ackedAt.getTime() >= EPOCH_SETTLE_MS) {
      return {
        next: {
          voterEpoch: state.voterEpoch + 1,
          quorumSets: [next],
          voterMembers: membersFor(next),
          jointVersion: 0,
          jointAckedAt: null,
        },
        jointStarted: false,
      };
    }
    return ackedAt === state.jointAckedAt
      ? unchanged
      : { next: { ...state, jointAckedAt: ackedAt }, jointStarted: false };
  }
  const current = state.quorumSets[0]!;
  if (!sameVoterSet(current, desired)) {
    return {
      next: {
        voterEpoch: state.voterEpoch + 1,
        quorumSets: [current, desired],
        voterMembers: membersFor([...current, ...desired]),
        jointVersion: 0,
        jointAckedAt: null,
      },
      jointStarted: true,
    };
  }
  const refreshed = membersFor(current);
  if (!sameMembers(refreshed, state.voterMembers)) {
    // Same voters with a new identity key: a new epoch, no joint phase (the quorum sets are equal).
    return {
      next: {
        ...state,
        voterEpoch: state.voterEpoch + 1,
        voterMembers: refreshed,
        jointVersion: 0,
        jointAckedAt: null,
      },
      jointStarted: false,
    };
  }
  return unchanged;
}
