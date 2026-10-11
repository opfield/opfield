import { describe, expect, it } from 'vitest';
import { EPOCH_SETTLE_MS } from './lease-constants.js';
import { type PolicyVoterState, planPolicyVoters } from './lease-policy-voters.js';

const NOW = new Date('2026-09-28T00:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const member = (id: string, key = `pk-${id}`) => ({ id, role: 'daemon' as const, publicKey: key });
const EMPTY: PolicyVoterState = {
  voterEpoch: 0,
  quorumSets: [],
  voterMembers: [],
  jointVersion: 0,
  jointAckedAt: null,
};

function plan(
  state: PolicyVoterState,
  desired: string[],
  options: { acked?: Record<string, number>; active?: number[]; now?: Date; keys?: Record<string, string> } = {}
) {
  return planPolicyVoters({
    state,
    desired,
    memberOf: (id) => member(id, options.keys?.[id]),
    ackedEpoch: (id) => options.acked?.[id] ?? 0,
    activeLeaseEpochs: options.active ?? [],
    now: options.now ?? NOW,
  });
}

describe('per-policy voter epochs and joint consensus (A4, A16, A18)', () => {
  it('publishes the first voter set as epoch 1', () => {
    expect(plan(EMPTY, ['d1', 'd2', 'w1']).next).toMatchObject({ voterEpoch: 1, quorumSets: [['d1', 'd2', 'w1']] });
  });

  it('changes candidates through a joint epoch that settles only after both majorities, renewals and 37 s', () => {
    const settled = plan(EMPTY, ['d1', 'd2', 'w1']).next;
    const joint = plan(settled, ['d1', 'd3', 'w1']);
    expect(joint.jointStarted).toBe(true);
    expect(joint.next).toMatchObject({
      voterEpoch: 2,
      quorumSets: [
        ['d1', 'd2', 'w1'],
        ['d1', 'd3', 'w1'],
      ],
    });
    const state = { ...joint.next, jointVersion: 5 };
    // A majority of the old set only: not acked.
    expect(plan(state, ['d1', 'd3', 'w1'], { acked: { d1: 2, d2: 2 } }).next.jointAckedAt).toBeNull();
    // Both majorities acked: the settle hold starts.
    const acked = plan(state, ['d1', 'd3', 'w1'], { acked: { d1: 2, w1: 2 } }).next;
    expect(acked).toMatchObject({ voterEpoch: 2, jointAckedAt: NOW });
    // Not before the hold passed, and not while a lease still renews under the old epoch.
    expect(plan(acked, ['d1', 'd3', 'w1'], { now: at(EPOCH_SETTLE_MS - 1) }).next.voterEpoch).toBe(2);
    expect(plan(acked, ['d1', 'd3', 'w1'], { now: at(EPOCH_SETTLE_MS), active: [1] }).next.voterEpoch).toBe(2);
    const done = plan(acked, ['d1', 'd3', 'w1'], { now: at(EPOCH_SETTLE_MS), active: [2] }).next;
    expect(done).toMatchObject({
      voterEpoch: 3,
      quorumSets: [['d1', 'd3', 'w1']],
      jointVersion: 0,
      jointAckedAt: null,
    });
    expect(done.voterMembers.map(({ id }) => id)).toEqual(['d1', 'd3', 'w1']);
  });

  it('keeps a departed voter in the old set with its published key', () => {
    const settled = plan(EMPTY, ['d1', 'd2', 'w1']).next;
    const joint = planPolicyVoters({
      state: settled,
      desired: ['d1', 'd3', 'w1'],
      memberOf: (id) => (id === 'd2' ? null : member(id)),
      ackedEpoch: () => 0,
      activeLeaseEpochs: [],
      now: NOW,
    }).next;
    expect(joint.voterMembers.map(({ id }) => id)).toEqual(['d1', 'd2', 'd3', 'w1']);
  });

  it('settles a stateful joint epoch only after every slot has a live holder that renewed under it (AS1)', () => {
    const settled = plan(EMPTY, ['d1', 'd2', 'w1']).next;
    const joint = plan(settled, ['d1', 'd3', 'w1']).next;
    const acked = plan({ ...joint, jointVersion: 5 }, ['d1', 'd3', 'w1'], { acked: { d1: 2, w1: 2 } }).next;
    const stateful = (bySlot: Array<[number, number]>, slots = 1) =>
      planPolicyVoters({
        state: acked,
        desired: ['d1', 'd3', 'w1'],
        memberOf: (id) => member(id),
        ackedEpoch: () => 2,
        activeLeaseEpochs: bySlot.map(([, epoch]) => epoch),
        liveHolderEpochs: { slots, bySlot: new Map(bySlot) },
        now: at(EPOCH_SETTLE_MS),
      }).next.voterEpoch;
    // A stateless policy without an active lease settles; a stateful one without a live holder never does.
    expect(plan(acked, ['d1', 'd3', 'w1'], { now: at(EPOCH_SETTLE_MS) }).next.voterEpoch).toBe(3);
    expect(stateful([])).toBe(2);
    expect(stateful([[0, 1]])).toBe(2);
    expect(stateful([[0, 2]])).toBe(3);
    // Every slot needs its live holder's renewal under the joint epoch.
    expect(stateful([[0, 2]], 2)).toBe(2);
    expect(
      stateful(
        [
          [0, 2],
          [1, 2],
        ],
        2
      )
    ).toBe(3);
  });

  it('bumps the epoch without a joint phase when a voter only changed its key', () => {
    const settled = plan(EMPTY, ['d1', 'd2', 'w1']).next;
    const rotated = plan(settled, ['d1', 'd2', 'w1'], { keys: { d2: 'pk-new' } });
    expect(rotated.jointStarted).toBe(false);
    expect(rotated.next).toMatchObject({ voterEpoch: 2, quorumSets: [['d1', 'd2', 'w1']] });
    expect(plan(rotated.next, ['d1', 'd2', 'w1'], { keys: { d2: 'pk-new' } }).next).toBe(rotated.next);
  });
});
