import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_CATCH_UP_TIMEOUT_MS,
  AVAILABILITY_SET_POLICY_PREFIX,
  LEASE_PEER_SETTLE_TIMEOUT_MS,
  type LeaseUpdatePeerState,
  type LeaseUpdateView,
  leasePoliciesOf,
  leaseUpdateBlockers,
  setHoldsUpdates,
} from './daemon-update-lease-gate.js';

const NOW = 1_800_000_000_000;

function view(
  policies: Record<string, string[]>,
  states: Record<string, Partial<LeaseUpdatePeerState>>,
  holders: string[] = []
): LeaseUpdateView {
  return {
    topology: {
      policyMembers: new Map(Object.entries(policies).map(([id, members]) => [id, new Set(members)])),
      holders: new Set(holders),
    },
    states: new Map(
      Object.entries(states).map(([id, state]) => [
        id,
        { updating: false, since: NOW - 3_600_000, reportedAt: NOW - 1_000, abstaining: false, ...state },
      ])
    ),
  };
}

describe('leaseUpdateBlockers', () => {
  const settled = { d1: {}, d2: {}, witness: { since: null } };

  it('lets a member update while every peer of its lease policies is settled', () => {
    const current = view({ checkout: ['d1', 'd2', 'witness'] }, settled);
    expect(leaseUpdateBlockers(current, 'd2', NOW)).toEqual({ blockers: [], settleTimedOut: [] });
  });

  it('holds a member back while a peer is updating, reconnecting without a lease report, or abstaining', () => {
    const policies = { checkout: ['d1', 'd2', 'witness'] };
    expect(leaseUpdateBlockers(view(policies, { ...settled, d1: { updating: true } }), 'd2', NOW).blockers).toEqual([
      { memberId: 'd1', policyId: 'checkout', reason: 'updating' },
    ]);
    // Back online 5 s ago, its last lease report is from before the restart.
    expect(
      leaseUpdateBlockers(
        view(policies, { ...settled, d1: { since: NOW - 5_000, reportedAt: NOW - 20_000 } }),
        'd2',
        NOW
      ).blockers
    ).toEqual([{ memberId: 'd1', policyId: 'checkout', reason: 'reconnecting' }]);
    // First start onto rc.20 from an rc.19 store: the acceptor abstains ~33 s.
    expect(
      leaseUpdateBlockers(
        view(policies, { ...settled, d1: { since: NOW - 10_000, reportedAt: NOW - 1_000, abstaining: true } }),
        'd2',
        NOW
      ).blockers
    ).toEqual([{ memberId: 'd1', policyId: 'checkout', reason: 'abstaining' }]);
  });

  it('holds a member back while a relay voter of its policy abstains, going by its fresh report', () => {
    const current = view(
      { hafo: ['a1', 'a2', 'relay-137'] },
      {
        a1: {},
        a2: {},
        'relay-137': { since: null, abstaining: true, reportedAt: NOW - 5_000 },
      }
    );
    expect(leaseUpdateBlockers(current, 'a1', NOW).blockers).toEqual([
      { memberId: 'relay-137', policyId: 'hafo', reason: 'abstaining' },
    ]);
    const stale = view(
      { hafo: ['a1', 'a2', 'relay-137'] },
      {
        'relay-137': { since: null, abstaining: true, reportedAt: NOW - 120_000 },
      }
    );
    expect(leaseUpdateBlockers(stale, 'a1', NOW).blockers).toEqual([]);
  });

  it('stops waiting for a peer that has not settled within the settle timeout', () => {
    const current = view(
      { checkout: ['d1', 'd2'] },
      {
        d1: { since: NOW - LEASE_PEER_SETTLE_TIMEOUT_MS, abstaining: true },
      }
    );
    expect(leaseUpdateBlockers(current, 'd2', NOW)).toEqual({
      blockers: [],
      settleTimedOut: [{ memberId: 'd1', policyId: 'checkout', reason: 'abstaining' }],
    });
  });

  it('does not wait for an offline peer that is not updating', () => {
    const current = view({ checkout: ['d1', 'd2'] }, { d1: { since: null, reportedAt: NOW - 600_000 } });
    expect(leaseUpdateBlockers(current, 'd2', NOW).blockers).toEqual([]);
  });

  it('only looks at the policies the member shares', () => {
    const current = view({ checkout: ['d1', 'd2'], hafo: ['a1', 'a2'] }, { a1: { updating: true } });
    expect(leaseUpdateBlockers(current, 'd1', NOW).blockers).toEqual([]);
    expect(leaseUpdateBlockers(current, 'nginx-1', NOW).blockers).toEqual([]);
    expect(leasePoliciesOf(current.topology, 'a2')).toEqual(['hafo']);
    expect(leasePoliciesOf(current.topology, 'nginx-1')).toEqual([]);
  });

  it('holds the other members of a database set while a restarted copy catches up, up to its own timeout', () => {
    const policy = 'set-lease';
    const catching = { since: NOW - 60_000, catchingUpIn: new Set([policy]) };
    expect(leaseUpdateBlockers(view({ [policy]: ['p', 'c'] }, { p: {}, c: catching }), 'p', NOW).blockers).toEqual([
      { memberId: 'c', policyId: policy, reason: 'availability_catching_up' },
    ]);
    const long = { since: NOW - AVAILABILITY_CATCH_UP_TIMEOUT_MS, catchingUpIn: new Set([policy]) };
    expect(leaseUpdateBlockers(view({ [policy]: ['p', 'c'] }, { p: {}, c: long }), 'p', NOW)).toEqual({
      blockers: [],
      settleTimedOut: [{ memberId: 'c', policyId: policy, reason: 'availability_catching_up' }],
    });
  });

  it('sequences a manual pair by its pseudo policy without lease reports', () => {
    const policy = `${AVAILABILITY_SET_POLICY_PREFIX}pair`;
    // Its nodes report no lease state: only an update or a copy catching up holds the other member back.
    const quiet = { since: NOW - 10_000, reportedAt: null };
    expect(leaseUpdateBlockers(view({ [policy]: ['p', 'c'] }, { p: quiet, c: quiet }), 'p', NOW).blockers).toEqual([]);
    expect(
      leaseUpdateBlockers(view({ [policy]: ['p', 'c'] }, { p: quiet, c: { ...quiet, updating: true } }), 'p', NOW)
        .blockers
    ).toEqual([{ memberId: 'c', policyId: policy, reason: 'updating' }]);
  });
});

describe('setHoldsUpdates', () => {
  it('lets a set that has not converged or is being turned off hold no node update', () => {
    expect(setHoldsUpdates({ state: 'healthy', operation: null })).toBe(true);
    expect(setHoldsUpdates({ state: 'degraded', operation: { kind: 'add_member' } })).toBe(true);
    expect(setHoldsUpdates({ state: 'converting', operation: { kind: 'convert' } })).toBe(false);
    // A convert past the lease start still seeds its copies.
    expect(setHoldsUpdates({ state: 'degraded', operation: { kind: 'create' } })).toBe(false);
    expect(setHoldsUpdates({ state: 'closing', operation: { kind: 'disable' } })).toBe(false);
  });
});
