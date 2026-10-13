import { describe, expect, it } from 'vitest';
import { availabilityStandbyCount, evaluateLeaseGating, type LeaseGatingInput } from './lease-gating.js';
import {
  holdsEveryMajority,
  type LeaseVoterCandidateNode,
  type LeaseWitnessCandidate,
  leaseVoterMargin,
  quorumSize,
  selectPolicyVoters,
} from './lease-voters.js';

function candidate(
  id: string,
  hostKey = `host-${id}`,
  faultDomains: string[] = [],
  voterCapable = true
): LeaseVoterCandidateNode {
  return { id, hostKey, faultDomains, publicKey: `pk-${id}`, voterCapable };
}

function witness(
  id: string,
  extra: Partial<Omit<LeaseWitnessCandidate, 'rttFrom'>> & { rtt?: Record<string, number> } = {}
): LeaseWitnessCandidate {
  const { rtt, ...rest } = extra;
  return {
    id,
    kind: 'relay',
    hostKey: `host-${id}`,
    faultDomain: `fd-${id}`,
    capable: true,
    publicKey: `pk-${id}`,
    rttFrom: (candidateId) => rtt?.[candidateId],
    ...rest,
  };
}

describe('per-policy lease voters (A18, A20)', () => {
  it('takes the distinct candidate hosts in rank order and needs no witness for an odd count of three', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2'), candidate('d3')],
      pool: [witness('r1')],
      configuredWitness: null,
    });
    expect(selection).toEqual({
      voterIds: ['d1', 'd2', 'd3'],
      witnesses: [],
      warning: null,
      viable: true,
      nonVotingCandidateIds: [],
    });
  });

  it('gives one vote per physical host across daemons and relays', () => {
    const selection = selectPolicyVoters({
      // Two candidate daemons on one VM count once.
      candidates: [candidate('d1', 'vm-a'), candidate('d1b', 'vm-a'), candidate('d2', 'vm-b')],
      pool: [
        // Two relays on one VM give one vote; a relay on a candidate's VM gives none.
        witness('r1', { hostKey: 'vm-c' }),
        witness('r2', { hostKey: 'vm-c' }),
        witness('r3', { hostKey: 'vm-a' }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'r1']);
  });

  it('caps the voters at seven; candidates beyond the cap do not vote', () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(`d${index}`));
    const selection = selectPolicyVoters({ candidates, pool: [witness('r1')], configuredWitness: null });
    expect(selection.voterIds).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    expect(selection.witnesses).toEqual([]);
  });
});

describe('lease witness (A19)', () => {
  it('picks the member with the largest minimum round trip to every candidate', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [
        witness('near', { rtt: { d1: 1.2, d2: 80 } }),
        witness('far', { rtt: { d1: 35, d2: 42 } }),
        witness('half', { rtt: { d1: 60 } }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'far']);
    expect(selection.witnesses).toEqual([{ memberId: 'far', kind: 'relay', auto: true, minRttMs: 35 }]);
    expect(selection.warning).toBeNull();
  });

  it('warns when the only witness is within 2 ms of a candidate', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('near', { rtt: { d1: 1.2, d2: 80 } })],
      configuredWitness: null,
    });
    expect(selection.witnesses[0]).toMatchObject({ memberId: 'near', minRttMs: 1.2 });
    expect(selection.warning).toBe('witness_near_candidate');
  });

  it('falls back to a relay in a fault domain no candidate host shares, then to docker nodes', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1', 'host-d1', ['site-a']), candidate('d2', 'host-d2', ['site-b'])],
      pool: [
        witness('docker-w', { kind: 'docker', faultDomain: null }),
        witness('same-site', { faultDomain: 'site-a' }),
        witness('other-site', { faultDomain: 'site-c' }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'other-site']);
    expect(
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2')],
        pool: [witness('docker-w', { kind: 'docker', faultDomain: null })],
        configuredWitness: null,
      }).voterIds
    ).toEqual(['d1', 'd2', 'docker-w']);
  });

  it('uses a configured witness first and falls back to auto with a warning when it is not eligible', () => {
    const pool = [witness('far', { rtt: { d1: 40, d2: 40 } }), witness('chosen', { rtt: { d1: 5, d2: 5 } })];
    const configured = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool,
      configuredWitness: 'chosen',
    });
    expect(configured.witnesses).toEqual([{ memberId: 'chosen', kind: 'relay', auto: false, minRttMs: 5 }]);
    const notCapable = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [...pool.slice(0, 1), witness('chosen', { capable: false })],
      configuredWitness: 'chosen',
    });
    expect(notCapable.voterIds).toEqual(['d1', 'd2', 'far']);
    expect(notCapable.warning).toBe('configured_witness_unavailable');
    const onCandidateHost = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('chosen', { hostKey: 'host-d1' })],
      configuredWitness: 'chosen',
    });
    expect(onCandidateHost.voterIds).toEqual(['d1', 'd2']);
    expect(onCandidateHost.warning).toBe('configured_witness_unavailable');
  });

  it('keeps the count odd when a witness is configured for three candidates', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2'), candidate('d3')],
      pool: [witness('chosen'), witness('extra')],
      configuredWitness: 'chosen',
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'd3', 'chosen', 'extra']);
  });

  it('warns that failover needs a candidate majority when no eligible witness exists', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('old', { capable: false }), witness('keyless', { publicKey: null })],
      configuredWitness: null,
    });
    expect(selection).toMatchObject({ voterIds: ['d1', 'd2'], witnesses: [], warning: 'no_eligible_witness' });
    // Two voters are still a quorum of the three the policy needs: lease mode runs, with margin 0.
    expect(selection.viable).toBe(true);
  });

  it('keeps a current automatic witness instead of churning to a farther one', () => {
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool: [witness('current', { rtt: { d1: 10, d2: 10 } }), witness('farther', { rtt: { d1: 90, d2: 90 } })],
      configuredWitness: null,
      currentAutoWitnesses: ['current'],
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'current']);
  });

  it('never picks the local relay while another ready relay can witness, and moves off it (N-2)', () => {
    // Stand rc20: checkout/payments had the local relay as witness (it had RTT data first and stayed sticky), so the
    // margin was 0 and losing the Opfield host plus one node fenced a slot.
    const pool = [
      witness('local', { local: true, rtt: { d1: 0.2, d2: 0.3 } }),
      witness('r136', { rtt: { d1: 0.6, d2: 0.7 } }),
      witness('r137'),
    ];
    const selection = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2')],
      pool,
      configuredWitness: null,
      currentAutoWitnesses: ['local'],
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'r136']);
    // A remote relay that is not ready (or cannot vote) does not count as another relay.
    expect(
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2')],
        pool: [
          witness('local', { local: true }),
          witness('r136', { ready: false }),
          witness('old', { capable: false }),
        ],
        configuredWitness: null,
        currentAutoWitnesses: ['local'],
      }).voterIds
    ).toEqual(['d1', 'd2', 'local']);
    // Without a remote relay the local one keeps its usual rank (a relay in its own fault domain).
    expect(
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2')],
        pool: [witness('local', { local: true }), witness('docker-w', { kind: 'docker', faultDomain: null })],
        configuredWitness: null,
      }).voterIds
    ).toEqual(['d1', 'd2', 'local']);
    // A configured local relay is respected.
    expect(
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2')],
        pool: [witness('local', { local: true }), witness('r136')],
        configuredWitness: 'local',
      }).voterIds
    ).toEqual(['d1', 'd2', 'local']);
  });

  it('keeps its choice under round-trip jitter and prefers a ready relay for a new pick', () => {
    const pick = (rtt136: number, rtt137: number, current: string[] = []) =>
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2')],
        pool: [
          witness('r136', { rtt: { d1: rtt136, d2: rtt136 + 0.1 } }),
          witness('r137', { rtt: { d1: rtt137, d2: rtt137 + 0.1 } }),
        ],
        configuredWitness: null,
        currentAutoWitnesses: current,
      });
    // Sub-millisecond differences tie; the member id decides, whatever the jitter.
    expect(pick(0.6, 0.8).voterIds).toEqual(['d1', 'd2', 'r136']);
    expect(pick(0.8, 0.6).voterIds).toEqual(['d1', 'd2', 'r136']);
    // A current witness stays even when another one measures farther now.
    expect(pick(3, 40, ['r136']).voterIds).toEqual(['d1', 'd2', 'r136']);
    // The stored round trip is kept to a tenth of a millisecond, so jitter below that rewrites nothing.
    expect(pick(0.61, 0.8).witnesses[0]?.minRttMs).toBe(pick(0.64, 0.8).witnesses[0]?.minRttMs);
    expect(
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2')],
        pool: [witness('down', { ready: false, rtt: { d1: 50, d2: 50 } }), witness('up', { rtt: { d1: 5, d2: 5 } })],
        configuredWitness: null,
      }).voterIds
    ).toEqual(['d1', 'd2', 'up']);
  });

  it('takes voters only from members with availability_lease_v2 and says when a quorum is impossible (D3)', () => {
    const outdated = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2', 'host-d2', [], false), candidate('d3')],
      pool: [witness('r1')],
      configuredWitness: null,
    });
    expect(outdated.voterIds).toEqual(['d1', 'd3', 'r1']);
    expect(outdated.nonVotingCandidateIds).toEqual(['d2']);
    expect(outdated.viable).toBe(true);
    const lonely = selectPolicyVoters({
      candidates: [candidate('d1'), candidate('d2', 'host-d2', [], false)],
      pool: [witness('old', { capable: false })],
      configuredWitness: null,
    });
    expect(lonely.voterIds).toEqual(['d1']);
    expect(lonely.viable).toBe(false);
    // The outdated candidate's host still is a candidate host: no witness may run there.
    expect(
      selectPolicyVoters({
        candidates: [candidate('d1'), candidate('d2', 'host-d2', [], false)],
        pool: [witness('co-hosted', { hostKey: 'host-d2' })],
        configuredWitness: null,
      }).viable
    ).toBe(false);
  });

  it('survives the loss of any one site in a two-site layout with a witness site', () => {
    // Site A: one VM (docker d1 and relay r1). Site B: a VM at another provider (docker d2 and relay r2). Site C: witness.
    const selection = selectPolicyVoters({
      candidates: [candidate('d1', 'vm-a', ['fd-a']), candidate('d2', 'vm-b', ['fd-b'])],
      pool: [
        witness('r1', { hostKey: 'vm-a', faultDomain: 'fd-a', rtt: { d1: 0.3, d2: 21 } }),
        witness('r2', { hostKey: 'vm-b', faultDomain: 'fd-b', rtt: { d1: 21, d2: 0.4 } }),
        witness('r3', { hostKey: 'vm-witness', faultDomain: 'fd-c', rtt: { d1: 14, d2: 18 } }),
      ],
      configuredWitness: null,
    });
    expect(selection.voterIds).toEqual(['d1', 'd2', 'r3']);
    expect(selection.warning).toBeNull();
    for (const site of [['d1'], ['d2'], ['r3']]) {
      const survivors = new Set(selection.voterIds.filter((id) => !site.includes(id)));
      expect(holdsEveryMajority([selection.voterIds], survivors)).toBe(true);
    }
  });
});

describe('availability lease quorum math', () => {
  it('needs a majority of every quorum set while joint', () => {
    expect(quorumSize(['a', 'b', 'c'])).toBe(2);
    const sets = [
      ['a', 'b', 'c'],
      ['c', 'd', 'e'],
    ];
    expect(holdsEveryMajority(sets, new Set(['a', 'b', 'c']))).toBe(false);
    expect(holdsEveryMajority(sets, new Set(['a', 'c', 'd']))).toBe(true);
    expect(holdsEveryMajority([], new Set(['a']))).toBe(false);
  });

  it('reports the smallest reachability margin over the quorum sets', () => {
    const margin = leaseVoterMargin(
      7,
      [
        ['a', 'b', 'c'],
        ['c', 'd', 'e', 'f', 'g'],
      ],
      new Set(['a', 'b', 'c', 'd', 'e'])
    );
    expect(margin).toEqual({ epoch: 7, joint: true, voters: 5, reachable: 3, required: 3, margin: 0 });
    expect(leaseVoterMargin(1, [], new Set())).toBeNull();
  });
});

describe('availability lease capability gating (D10, D3)', () => {
  const [n1, n2, n3] = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '44444444-4444-4444-8444-444444444444',
  ];
  const eligible: LeaseGatingInput = {
    controllerSupportsLease: true,
    policyMode: 'failover',
    signingReady: true,
    candidates: [
      { nodeId: n1, exclusion: null, serving: true },
      { nodeId: n2, exclusion: null },
    ],
    heldSlots: 1,
    ingress: [{ nodeId: '33333333-3333-4333-8333-333333333333', capable: true }],
    voters: { viable: true, nonVotingCandidateIds: [] },
  };

  it('never leaves or refuses lease mode for a per-node condition of a standby (D3)', () => {
    expect(evaluateLeaseGating(eligible)).toEqual({ eligible: true });
    for (const exclusion of ['offline', 'watchdog_missing', 'daemon_outdated', 'identity_pending'] as const) {
      const candidates = [eligible.candidates[0]!, { nodeId: n2, exclusion }];
      expect(evaluateLeaseGating({ ...eligible, candidates })).toEqual({ eligible: true });
      expect(evaluateLeaseGating({ ...eligible, candidates, entering: true })).toEqual({ eligible: true });
    }
    // The holder's own watchdog loss (stand l) is a per-node condition too: the successor takes over in lease mode.
    expect(
      evaluateLeaseGating({
        ...eligible,
        heldSlots: 0,
        candidates: [{ nodeId: n1, exclusion: 'watchdog_missing', serving: true }, eligible.candidates[1]!],
      })
    ).toEqual({ eligible: true });
  });

  it('enters lease mode only when the serving nodes can hold, since the bootstrap reserves them', () => {
    expect(
      evaluateLeaseGating({
        ...eligible,
        entering: true,
        candidates: [{ nodeId: n1, exclusion: 'daemon_outdated', serving: true }, eligible.candidates[1]!],
      })
    ).toMatchObject({ eligible: false, immediate: false, reason: { code: 'candidates_not_capable', nodeIds: [n1] } });
    expect(
      evaluateLeaseGating({
        ...eligible,
        entering: true,
        candidates: [{ nodeId: n1, exclusion: 'watchdog_missing', serving: true }, eligible.candidates[1]!],
      })
    ).toMatchObject({
      eligible: false,
      reason: {
        code: 'watchdog_missing',
        message: expect.stringContaining('re-run the node installer'),
        nodeIds: [n1],
      },
    });
    // Offline is not the node's own condition: the reservation waits for it (and is reissued when it stays away).
    expect(
      evaluateLeaseGating({
        ...eligible,
        entering: true,
        candidates: [{ nodeId: n1, exclusion: 'offline', serving: true }, eligible.candidates[1]!],
      })
    ).toEqual({ eligible: true });
  });

  it('is impossible when no candidate can hold and no slot is held', () => {
    const unable = [
      { nodeId: n1, exclusion: 'watchdog_missing' as const },
      { nodeId: n2, exclusion: 'daemon_outdated' as const },
      { nodeId: n3, exclusion: 'identity_pending' as const },
    ];
    expect(evaluateLeaseGating({ ...eligible, candidates: unable, heldSlots: 0 })).toMatchObject({
      eligible: false,
      immediate: false,
      reason: { code: 'candidates_not_capable', nodeIds: [n1, n2, n3].sort() },
    });
    // An outdated holder still serves: keep lease mode until it hands over or is updated.
    expect(evaluateLeaseGating({ ...eligible, candidates: unable, heldSlots: 1 })).toEqual({ eligible: true });
    // HA-11: every candidate lost its watchdog and killed its copy: leave at once instead of after 2 minutes.
    const watchdogsMissing = [
      { nodeId: n1, exclusion: 'watchdog_missing' as const },
      { nodeId: n2, exclusion: 'watchdog_missing' as const },
    ];
    expect(evaluateLeaseGating({ ...eligible, candidates: watchdogsMissing, heldSlots: 0 })).toMatchObject({
      eligible: false,
      immediate: true,
      reason: { code: 'watchdog_missing' },
    });
    // A copy that still holds keeps lease mode: it stops by itself, and only then is nothing held.
    expect(evaluateLeaseGating({ ...eligible, candidates: watchdogsMissing, heldSlots: 1 })).toEqual({
      eligible: true,
    });
    // Every node offline to Opfield says nothing about the data plane.
    expect(
      evaluateLeaseGating({
        ...eligible,
        heldSlots: 0,
        candidates: [
          { nodeId: n1, exclusion: 'offline' },
          { nodeId: n2, exclusion: 'offline' },
        ],
      })
    ).toEqual({ eligible: true });
  });

  it('is impossible without v2 ingress, v2 relays, a voter quorum, a signing key or the controller', () => {
    expect(
      evaluateLeaseGating({ ...eligible, ingress: [{ nodeId: eligible.ingress[0]!.nodeId, capable: false }] })
    ).toMatchObject({ eligible: false, immediate: false, reason: { code: 'ingress_not_capable' } });
    // H4: every relay carrying the policy's endpoints and DB routes must run the lease gate.
    expect(
      evaluateLeaseGating({
        ...eligible,
        relays: [
          { relayId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', capable: false },
          { relayId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', capable: true },
        ],
      })
    ).toMatchObject({
      eligible: false,
      reason: { code: 'relays_not_capable', relayIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] },
    });
    expect(
      evaluateLeaseGating({ ...eligible, relays: [{ relayId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', capable: true }] })
    ).toEqual({ eligible: true });
    expect(
      evaluateLeaseGating({ ...eligible, voters: { viable: false, nonVotingCandidateIds: [n2, n1] } })
    ).toMatchObject({ eligible: false, immediate: false, reason: { code: 'insufficient_voters', nodeIds: [n1, n2] } });
    expect(evaluateLeaseGating({ ...eligible, signingReady: false })).toMatchObject({
      eligible: false,
      immediate: false,
      reason: { code: 'signing_key_pending' },
    });
    expect(evaluateLeaseGating({ ...eligible, controllerSupportsLease: false })).toMatchObject({
      eligible: false,
      immediate: false,
      reason: { code: 'controller_unsupported' },
    });
    expect(evaluateLeaseGating({ ...eligible, candidates: [] })).toMatchObject({
      eligible: false,
      immediate: false,
      reason: { code: 'no_candidates' },
    });
  });

  it('enters lease mode only once every participant ran v2 for 2 minutes without a restart', () => {
    const relay = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(
      evaluateLeaseGating({ ...eligible, entering: true, unsettled: { nodeIds: [n2], relayIds: [relay] } })
    ).toMatchObject({
      eligible: false,
      immediate: false,
      reason: { code: 'participants_settling', nodeIds: [n2], relayIds: [relay] },
    });
    expect(evaluateLeaseGating({ ...eligible, entering: true, unsettled: { nodeIds: [], relayIds: [] } })).toEqual({
      eligible: true,
    });
    // Staying in lease mode never waits for it: per-node conditions only exclude.
    expect(evaluateLeaseGating({ ...eligible, unsettled: { nodeIds: [n2], relayIds: [] } })).toEqual({
      eligible: true,
    });
  });

  it('closes at once only for an explicit request: a lifecycle hold or a disable', () => {
    expect(evaluateLeaseGating({ ...eligible, legacyRequested: true })).toMatchObject({
      eligible: false,
      immediate: true,
      reason: { code: 'legacy_requested' },
    });
    expect(evaluateLeaseGating({ ...eligible, policyMode: 'single' })).toMatchObject({
      eligible: false,
      immediate: true,
      reason: { code: 'availability_disabled' },
    });
  });

  it('fixes the standby count at min(2, candidates - slots) (D7)', () => {
    expect(availabilityStandbyCount(5, 1)).toBe(2);
    expect(availabilityStandbyCount(2, 1)).toBe(1);
    expect(availabilityStandbyCount(3, 3)).toBe(0);
    expect(availabilityStandbyCount(1, 2)).toBe(0);
  });
});
