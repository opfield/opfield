import { describe, expect, it } from 'vitest';
import type { RelayPolicyRouteEntry } from '@/db/schema/relay.js';
import {
  type CurrentPolicyRoute,
  describeRelayRevocation,
  projectBuiltRoutes,
  RELAY_REVOCATION_ACK_TIMEOUT_MS,
  type ReconcileRevocationInput,
  reconcileRevocations,
  revocationFencesForEndpoints,
  staleRelaysByRoute,
  trustedAcknowledgement,
} from './relay-revocation-fence.js';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');

const revokedRoute = { routeId: 'route-revoked', endpointId: 'endpoint-1', routeGeneration: 1, endpointGeneration: 1 };
const keptRoute = { routeId: 'route-kept', endpointId: 'endpoint-1', routeGeneration: 1, endpointGeneration: 1 };

/** Opfield state after route-revoked was deleted; route-kept is unchanged. */
function afterRevocation(overrides: Partial<ReconcileRevocationInput> = {}): ReconcileRevocationInput {
  return {
    acknowledgedRevision: 10,
    nextRevision: 12,
    routes: new Map<string, CurrentPolicyRoute>([['route-kept', { generation: 1, targetEndpointId: 'endpoint-1' }]]),
    endpointGenerations: new Map([['endpoint-1', 1]]),
    now: new Date(T0),
    judgeFrom: 0,
    ...overrides,
  };
}

/** The relay applied revision 10 carrying both routes; Opfield then built revision 11 without the revoked one. */
function builtAfterRevocation(): RelayPolicyRouteEntry[] {
  return projectBuiltRoutes(projectBuiltRoutes(null, [revokedRoute, keptRoute], 10), [keptRoute], 11);
}

describe('relay route history', () => {
  it('keeps a dropped tuple until the relay acknowledges the snapshot that dropped it', () => {
    const entries = builtAfterRevocation();
    expect(entries).toEqual([keptRoute, { ...revokedRoute, removedAtRevision: 11 }]);
    // A later snapshot keeps the first revision that dropped it.
    expect(projectBuiltRoutes(entries, [keptRoute], 12).find(({ routeId }) => routeId === 'route-revoked')).toEqual({
      ...revokedRoute,
      removedAtRevision: 11,
    });
  });

  it('clears a revocation the relay acknowledged in time without ever fencing it', () => {
    const recorded = reconcileRevocations(builtAfterRevocation(), afterRevocation());
    expect(recorded.entries.find(({ routeId }) => routeId === 'route-revoked')).toMatchObject({
      removedAtRevision: 11,
      revokedAt: new Date(T0).toISOString(),
    });
    expect(recorded.newlyStale).toEqual([]);
    expect(describeRelayRevocation(recorded.entries)?.state).toBe('pending');

    const acknowledged = reconcileRevocations(
      recorded.entries,
      afterRevocation({ acknowledgedRevision: 11, now: new Date(T0 + 5_000) })
    );
    expect(acknowledged.entries).toEqual([keptRoute]);
    expect(acknowledged.cleared).toEqual([]);
    expect(describeRelayRevocation(acknowledged.entries)).toBeNull();
    expect(staleRelaysByRoute([{ id: 'relay-1', policyRoutes: acknowledged.entries }]).size).toBe(0);
  });

  it('marks the relay stale for the revoked route only once the deadline passes unacknowledged', () => {
    const recorded = reconcileRevocations(builtAfterRevocation(), afterRevocation());
    const early = reconcileRevocations(
      recorded.entries,
      afterRevocation({ now: new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS - 1) })
    );
    expect(early.newlyStale).toEqual([]);
    const late = reconcileRevocations(
      recorded.entries,
      afterRevocation({ now: new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS) })
    );
    expect(late.newlyStale.map(({ routeId }) => routeId)).toEqual(['route-revoked']);
    expect(late.entries.find(({ routeId }) => routeId === 'route-kept')).toEqual(keptRoute);

    const instances = [
      { id: 'relay-stale', policyRoutes: late.entries },
      { id: 'relay-current', policyRoutes: [keptRoute] },
    ];
    expect([...staleRelaysByRoute(instances)]).toEqual([['route-revoked', new Set(['relay-stale'])]]);
    expect(revocationFencesForEndpoints(instances, new Set(['endpoint-1']), afterRevocation().routes)).toEqual([
      {
        relayInstanceId: 'relay-stale',
        endpointId: 'endpoint-1',
        routes: [{ routeId: 'route-revoked', allowedGeneration: '0' }],
      },
    ]);
    // Other endpoints of the same daemon get no fence from this relay.
    expect(revocationFencesForEndpoints(instances, new Set(['endpoint-2']), afterRevocation().routes)).toEqual([]);
    expect(describeRelayRevocation(late.entries)).toMatchObject({
      state: 'stale',
      staleRoutes: 1,
      pendingRoutes: 0,
      requiredRevision: 11,
    });
  });

  it('clears the stale state when the relay acknowledges the revoking revision', () => {
    const stale = reconcileRevocations(
      reconcileRevocations(builtAfterRevocation(), afterRevocation()).entries,
      afterRevocation({ now: new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS) })
    ).entries;
    const lower = reconcileRevocations(
      stale,
      afterRevocation({ acknowledgedRevision: 10, now: new Date(T0 + 200_000) })
    );
    expect(lower.cleared).toEqual([]);
    const acknowledged = reconcileRevocations(
      stale,
      afterRevocation({ acknowledgedRevision: 14, now: new Date(T0 + 200_000) })
    );
    expect(acknowledged.cleared.map(({ routeId }) => routeId)).toEqual(['route-revoked']);
    expect(acknowledged.entries).toEqual([keptRoute]);
    expect(describeRelayRevocation(acknowledged.entries)).toBeNull();
  });

  it('records a revocation for a relay no snapshot reached since, against the next revision issued', () => {
    // The relay went offline holding both routes; no snapshot was built for it afterwards.
    const offline = projectBuiltRoutes(null, [revokedRoute, keptRoute], 10);
    const recorded = reconcileRevocations(offline, afterRevocation({ nextRevision: 40 }));
    expect(recorded.entries.find(({ routeId }) => routeId === 'route-revoked')?.removedAtRevision).toBe(40);
    const acknowledgedOld = reconcileRevocations(recorded.entries, afterRevocation({ acknowledgedRevision: 39 }));
    expect(acknowledgedOld.entries.some(({ routeId }) => routeId === 'route-revoked')).toBe(true);
  });

  it('does not treat a route moved to another relay as a revocation', () => {
    const moved = projectBuiltRoutes(projectBuiltRoutes(null, [revokedRoute, keptRoute], 10), [keptRoute], 11);
    const rebalanced = reconcileRevocations(
      moved,
      afterRevocation({
        routes: new Map([
          ['route-kept', { generation: 1, targetEndpointId: 'endpoint-1' }],
          ['route-revoked', { generation: 1, targetEndpointId: 'endpoint-1' }],
        ]),
        now: new Date(T0 + 10 * RELAY_REVOCATION_ACK_TIMEOUT_MS),
      })
    );
    expect(rebalanced.changed).toBe(false);
    expect(describeRelayRevocation(rebalanced.entries)).toBeNull();
  });

  it('fences a narrowed route to its current generation only', () => {
    const narrowed = { ...revokedRoute, routeGeneration: 2 };
    const entries = projectBuiltRoutes(projectBuiltRoutes(null, [revokedRoute], 10), [narrowed], 11);
    const routes = new Map([['route-revoked', { generation: 2, targetEndpointId: 'endpoint-1' }]]);
    const stale = reconcileRevocations(
      reconcileRevocations(entries, afterRevocation({ routes })).entries,
      afterRevocation({ routes, now: new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS) })
    );
    expect(stale.entries).toEqual([
      {
        ...revokedRoute,
        removedAtRevision: 11,
        revokedAt: new Date(T0).toISOString(),
        staleAt: new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS).toISOString(),
      },
      narrowed,
    ]);
    const instances = [{ id: 'relay-stale', policyRoutes: stale.entries }];
    expect(revocationFencesForEndpoints(instances, new Set(['endpoint-1']), routes)).toEqual([
      {
        relayInstanceId: 'relay-stale',
        endpointId: 'endpoint-1',
        routes: [{ routeId: 'route-revoked', allowedGeneration: '2' }],
      },
    ]);
  });

  it('does not judge a relay before Gateway had the deadline to reach it', () => {
    const recorded = reconcileRevocations(builtAfterRevocation(), afterRevocation());
    const startedAt = T0 + 60_000;
    const afterStart = reconcileRevocations(
      recorded.entries,
      afterRevocation({ now: new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS + 1_000), judgeFrom: startedAt })
    );
    expect(afterStart.newlyStale).toEqual([]);
    const later = reconcileRevocations(
      recorded.entries,
      afterRevocation({ now: new Date(startedAt + RELAY_REVOCATION_ACK_TIMEOUT_MS), judgeFrom: startedAt })
    );
    expect(later.newlyStale).toHaveLength(1);
  });

  it('trusts only acknowledgements of revisions Gateway issued', () => {
    expect(trustedAcknowledgement(12, 20)).toBe(12);
    expect(trustedAcknowledgement(25, 20)).toBe(0);
    expect(trustedAcknowledgement(Number.NaN, 20)).toBe(0);
  });
});
