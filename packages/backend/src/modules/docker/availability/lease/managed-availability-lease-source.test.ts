import { describe, expect, it } from 'vitest';
import { relayMayHostWitnesses } from '@/services/relay-witness-hosting.js';
import { filterWitnessPool } from './lease-policy-rules.js';
import { type LeaseVoterCandidateNode, type LeaseWitnessCandidate, selectPolicyVoters } from './lease-voters.js';
import {
  setLeaseCandidates,
  setWitnessFilter,
  TWO_MEMBER_PREFERRED_VOTERS,
} from './managed-availability-lease-source.js';

const member = (id: string): LeaseVoterCandidateNode => ({
  id,
  hostKey: `host-${id}`,
  faultDomains: [],
  publicKey: 'pk',
});
const relay = (id: string, local = false): LeaseWitnessCandidate => ({
  id,
  kind: 'relay',
  hostKey: `host-${id}`,
  faultDomain: `domain-${id}`,
  capable: true,
  local,
  ready: true,
  publicKey: 'pk',
  rttFrom: () => undefined,
});
const dockerNode = (id: string): LeaseWitnessCandidate => ({
  id,
  kind: 'docker',
  hostKey: `host-${id}`,
  faultDomain: null,
  capable: true,
  publicKey: 'pk',
  rttFrom: () => undefined,
});

/** The voters of a set the way the lease host chooses them: the set's witness filter, then the voter selection. */
function setVoters(input: {
  members: number;
  relays: Array<{
    id: string;
    allowed: boolean;
    local?: 'allowed' | 'protected_needs_opt_in' | null;
    isLocal?: boolean;
  }>;
  dockerNodes?: string[];
}) {
  const members = Array.from({ length: input.members }, (_, index) => member(`m${index}`));
  const allowedRelayIds = input.relays
    .filter((entry) =>
      relayMayHostWitnesses({ witnessHostingAllowed: entry.allowed, witnessHostingLocal: entry.local ?? 'allowed' })
    )
    .map((entry) => entry.id);
  const pool = [
    ...input.relays.map((entry) => relay(entry.id, entry.isLocal)),
    ...(input.dockerNodes ?? []).map(dockerNode),
  ];
  return selectPolicyVoters({
    candidates: members,
    pool: filterWitnessPool(pool, setWitnessFilter({ allowedRelayIds, picked: [] })),
    configuredWitness: null,
    ...(input.members === 2 ? { preferredVoterCount: TWO_MEMBER_PREFERRED_VOTERS } : {}),
  });
}

describe('availability set lease voters', () => {
  it('chooses odd voter counts from allowed witnesses only (members x allowed witnesses x protected relays)', () => {
    const relays = (allowed: number, protectedRelays = 0) => [
      ...Array.from({ length: allowed }, (_, index) => ({ id: `r${index}`, allowed: true })),
      ...Array.from({ length: protectedRelays }, (_, index) => ({
        id: `p${index}`,
        allowed: true,
        local: 'protected_needs_opt_in' as const,
      })),
      // Never allowed by the admin.
      { id: 'off', allowed: false },
    ];
    // members, allowed witness relays, protected relays without opt-in, expected witnesses, enough for an odd count
    const table: Array<[number, number, number, string[], boolean]> = [
      [2, 0, 0, [], false],
      [2, 0, 2, [], false],
      [2, 1, 0, ['r0'], true],
      [2, 1, 2, ['r0'], true],
      // 2 witnesses would make 4 voters, which tolerate no more failures than 3: stay at 3.
      [2, 2, 0, ['r0'], true],
      [2, 2, 1, ['r0'], true],
      [2, 3, 0, ['r0', 'r1', 'r2'], true],
      [3, 0, 0, [], true],
      [3, 2, 2, [], true],
      [4, 0, 0, [], false],
      [4, 1, 0, ['r0'], true],
      [4, 2, 2, ['r0'], true],
      [5, 0, 0, [], true],
      [5, 2, 0, [], true],
    ];
    for (const [members, allowed, protectedRelays, witnesses, odd] of table) {
      const selection = setVoters({ members, relays: relays(allowed, protectedRelays) });
      const label = `${members} members, ${allowed} allowed, ${protectedRelays} protected`;
      expect(
        selection.witnesses.map((witness) => witness.memberId),
        label
      ).toEqual(witnesses);
      expect(selection.voterIds, label).toHaveLength(members + witnesses.length);
      expect(selection.voterIds.length % 2 === 1, label).toBe(odd);
      expect(selection.warning === 'no_eligible_witness', label).toBe(!odd);
      expect(
        selection.voterIds.some((id) => id === 'off' || id.startsWith('p')),
        label
      ).toBe(false);
    }
  });

  it('uses a docker node on another host as a witness, and only the picked ones when the admin picked', () => {
    const auto = setVoters({ members: 2, relays: [], dockerNodes: ['d1'] });
    expect(auto.witnesses.map((witness) => witness.memberId)).toEqual(['d1']);
    const picked = setWitnessFilter({
      allowedRelayIds: ['r0', 'r1'],
      picked: [
        { hostKind: 'relay', relayInstanceId: 'r1', nodeId: null },
        { hostKind: 'relay', relayInstanceId: 'r-not-allowed', nodeId: null },
        { hostKind: 'node', relayInstanceId: null, nodeId: 'd2' },
      ],
    });
    expect(picked).toEqual({ relayIds: ['r1'], nodeIds: ['d2'] });
    const pool = [relay('r0'), relay('r1'), dockerNode('d1'), dockerNode('d2')];
    expect(filterWitnessPool(pool, picked).map((entry) => entry.id)).toEqual(['r1', 'd2']);
  });

  it('keeps the whole pool for Docker Availability (no filter, no preferred count)', () => {
    const pool = [relay('r0'), relay('r1'), dockerNode('d1')];
    expect(filterWitnessPool(pool, undefined)).toEqual(pool);
    const selection = selectPolicyVoters({ candidates: [member('a'), member('b')], pool, configuredWitness: null });
    expect(selection.voterIds).toHaveLength(3);
  });

  it('ranks candidates by priority, then member index, with the node as the lease identity', () => {
    expect(
      setLeaseCandidates([
        { id: 'm-a', nodeId: 'node-a', priority: 0, memberIndex: 0 },
        { id: 'm-b', nodeId: 'node-b', priority: 10, memberIndex: 1 },
        { id: 'm-c', nodeId: 'node-c', priority: 0, memberIndex: 2 },
      ])
    ).toEqual([
      { memberId: 'node-b', nodeId: 'node-b', rank: 0 },
      { memberId: 'node-a', nodeId: 'node-a', rank: 1 },
      { memberId: 'node-c', nodeId: 'node-c', rank: 2 },
    ]);
  });
});
