import { describe, expect, it } from 'vitest';
import type { relayInstances } from '@/db/schema/index.js';
import { relayLatencyHealth } from '../grpc/services/health-report.js';
import { planRelays, RelayPoolService } from './relay-pool.service.js';
import {
  candidateTopology,
  chooseByRendezvous,
  chooseRelayAssignments,
  type EndpointLatencyPath,
  inDisconnectGrace,
  parseNodeRelayLatencies,
  parseNodeRelayReachability,
  placementInstances,
  RELAY_DISCONNECT_GRACE_MS,
  RELAY_RETURN_HOLD_MS,
  relayDataPlaneFailures,
  samePlannedAssignments,
} from './relay-topology.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

const NOW = Date.UTC(2026, 9, 8, 2, 20);

/** A relay of the pool in the incident's shape: local next to the nodes, UK near, NL far. */
function relay(id: string, overrides: Partial<RelayInstanceRow> = {}): RelayInstanceRow {
  return {
    id,
    poolId: 'system',
    kind: id === 'relay-local' ? 'local' : 'remote',
    nodeId: null,
    faultDomainId: `fd-${id}`,
    displayName: id,
    advertisedAddresses: [],
    servicePort: 9443,
    state: 'ready',
    manualDrainStartedAt: null,
    drainForcedAt: null,
    drainDeadlineAt: null,
    certificateIdentity: 'identity',
    certificateFingerprint: 'fingerprint',
    certificateExpiresAt: null,
    policySigningKeyId: null,
    policyPublicKeyFingerprint: null,
    buildVersion: null,
    protocolMajor: 1,
    capabilities: { protocolMajor: 1, features: ['relay_pool_v1'] },
    appliedPolicyRevision: 1,
    policyExpiresAt: null,
    lastSeenAt: new Date(NOW),
    health: { admissionState: 'ready' } as RelayInstanceRow['health'],
    desiredArtifact: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  } as RelayInstanceRow;
}

/** The NL relay whose control stream ended `ago` ms before NOW. */
function disconnected(ago: number, overrides: Partial<RelayInstanceRow> = {}) {
  return relay('relay-nl', { state: 'offline', lastSeenAt: new Date(NOW - ago), ...overrides });
}

/** Round trips (ms) every node measured: the endpoint and one source node. */
const path: EndpointLatencyPath = {
  endpoint: new Map([
    ['relay-local', 0.7],
    ['relay-uk', 62],
    ['relay-nl', 298],
  ]),
  sources: [
    new Map([
      ['relay-local', 0.7],
      ['relay-uk', 62],
      ['relay-nl', 298],
    ]),
  ],
};

const placedOnAll = [
  { relayInstanceId: 'relay-local', role: 'primary' },
  { relayInstanceId: 'relay-uk', role: 'fallback' },
  { relayInstanceId: 'relay-nl', role: 'fallback' },
];

function plan(instances: RelayInstanceRow[], reference = placedOnAll, holdBack?: ReadonlySet<string>) {
  const ready = new Set(instances.filter(({ state }) => state === 'ready').map(({ faultDomainId }) => faultDomainId));
  return planRelays('endpoint-1', instances, ready.size, false, path, reference, false, undefined, holdBack);
}

describe('Relay disconnect grace', () => {
  it('keeps a relay whose control stream ended in placement for 3 minutes', () => {
    const failing = new Set<string>();
    expect(inDisconnectGrace(disconnected(10_000), NOW, failing)).toBe(true);
    expect(inDisconnectGrace(disconnected(RELAY_DISCONNECT_GRACE_MS - 1), NOW, failing)).toBe(true);
    expect(inDisconnectGrace(disconnected(RELAY_DISCONNECT_GRACE_MS), NOW, failing)).toBe(false);
    // Only a relay that served: not one an operator drained, nor one that reported draining, nor the local relay.
    expect(inDisconnectGrace(disconnected(10_000, { manualDrainStartedAt: new Date(NOW) }), NOW, failing)).toBe(false);
    expect(
      inDisconnectGrace(
        disconnected(10_000, { health: { admissionState: 'draining' } as RelayInstanceRow['health'] }),
        NOW,
        failing
      )
    ).toBe(false);
    expect(inDisconnectGrace(relay('relay-local', { state: 'offline' }), NOW, failing)).toBe(false);
    expect(inDisconnectGrace(relay('relay-nl'), NOW, failing)).toBe(false);
  });

  it('changes no plan while the relay is within its grace, and drops it after 3 minutes', () => {
    const grace = new Set(['relay-nl']);
    const keep = new Set(placedOnAll.map(({ relayInstanceId }) => relayInstanceId));
    const flapping = [relay('relay-local'), relay('relay-uk'), disconnected(30_000)];
    const kept = plan(placementInstances(flapping, grace, keep));
    expect(samePlannedAssignments(placedOnAll, kept)).toBe(true);

    const gone = [relay('relay-local'), relay('relay-uk'), disconnected(RELAY_DISCONNECT_GRACE_MS + 1_000)];
    const graceOver = new Set(
      gone.filter((instance) => inDisconnectGrace(instance, NOW, new Set())).map(({ id }) => id)
    );
    const replanned = plan(placementInstances(gone, graceOver, keep));
    expect(replanned.map(({ instance }) => instance.id).sort()).toEqual(['relay-local', 'relay-uk']);
  });

  it('adds no new work to a relay in its grace: it stays only where it already serves', () => {
    const instances = placementInstances(
      [relay('relay-local'), relay('relay-uk'), disconnected(30_000)],
      new Set(['relay-nl']),
      new Set(['relay-local', 'relay-uk'])
    );
    expect(instances.find(({ id }) => id === 'relay-nl')?.state).toBe('offline');
  });

  it('evacuates a relay at once when the daemons that measure it fail to reach it', () => {
    const failing = relayDataPlaneFailures([
      [
        { relayInstanceId: 'relay-nl', failingMs: 20_000 },
        { relayInstanceId: 'relay-uk', failingMs: 0 },
      ],
      [{ relayInstanceId: 'relay-nl', failingMs: 16_000 }],
    ]);
    expect([...failing]).toEqual(['relay-nl']);
    expect(inDisconnectGrace(disconnected(20_000), NOW, failing)).toBe(false);
    const instances = [relay('relay-local'), relay('relay-uk'), disconnected(20_000)];
    const grace = new Set(
      instances.filter((instance) => inDisconnectGrace(instance, NOW, failing)).map(({ id }) => id)
    );
    const evacuated = plan(placementInstances(instances, grace, new Set(['relay-local', 'relay-uk', 'relay-nl'])));
    expect(evacuated.map(({ instance }) => instance.id).sort()).toEqual(['relay-local', 'relay-uk']);
  });

  it('judges a data plane failing by a clear majority of the nodes that measure the relay', () => {
    const report = (failingMs: number) => [{ relayInstanceId: 'relay-nl', failingMs }];
    // Half is no majority, and a failure shorter than 15 s counts only among the reports.
    expect(relayDataPlaneFailures([report(60_000), report(0)]).size).toBe(0);
    expect(relayDataPlaneFailures([report(60_000), report(5_000)]).size).toBe(0);
    expect(relayDataPlaneFailures([report(5_000)]).size).toBe(0);
    // A daemon on the relay's own host reaches it while the rest of the fleet cannot.
    expect([...relayDataPlaneFailures([report(150_000), report(150_000), report(0)])]).toEqual(['relay-nl']);
    expect([...relayDataPlaneFailures([report(16_000)])]).toEqual(['relay-nl']);
    // A daemon without failure reports always counts as reaching the relay.
    expect(parseNodeRelayReachability([{ relayInstanceId: 'relay-nl', rttMs: 298 }])).toEqual([
      { relayInstanceId: 'relay-nl', failingMs: 0 },
    ]);
  });

  it('stores how long a daemon failed to reach each relay with its health report', () => {
    expect(
      relayLatencyHealth([
        { relayInstanceId: 'relay-nl', rttMicros: 298000, failingMs: 18000 },
        { relayInstanceId: 'relay-uk', rttMicros: 62000 },
      ])
    ).toEqual({
      relayLatencies: [
        { relayInstanceId: 'relay-nl', rttMs: 298, failingMs: 18000 },
        { relayInstanceId: 'relay-uk', rttMs: 62 },
      ],
    });
    // Failing for longer than the daemon keeps a round trip: still reported, its distance unknown.
    const { relayLatencies } = relayLatencyHealth([
      { relayInstanceId: 'relay-nl', rttMicros: 0, failingMs: 600000 },
      { relayInstanceId: 'relay-uk', rttMicros: 0 },
    ]);
    expect(relayLatencies).toEqual([{ relayInstanceId: 'relay-nl', rttMs: 0, failingMs: 600000 }]);
    expect(parseNodeRelayLatencies(relayLatencies).size).toBe(0);
    expect(parseNodeRelayReachability(relayLatencies)).toEqual([{ relayInstanceId: 'relay-nl', failingMs: 600000 }]);
  });
});

type PlacementView = {
  grace: Set<string>;
  holdBack: Set<string>;
  readyFaultDomains: Set<string>;
  instancesFor(current: Array<{ relayInstanceId: string }>): RelayInstanceRow[];
};

function placementViewOf(service: RelayPoolService) {
  return (instances: RelayInstanceRow[], failing: ReadonlySet<string>, at: number) =>
    (
      service as unknown as {
        placementView(instances: RelayInstanceRow[], failing: ReadonlySet<string>, now: number): PlacementView;
      }
    ).placementView(instances, failing, at);
}

// The rc.3 stand (F-1): NL's control stream came back while its relay port stayed dead. Gateway placed it again
// within a minute although every node reported it failing, and that generation failed after about 70 s for all
// 17 endpoints, retried every 5 minutes.
describe('Relay whose data plane fails while its control stream is up', () => {
  const instances = [relay('relay-local'), relay('relay-uk'), relay('relay-nl')];
  const failing = new Set(['relay-nl']);

  it('is neither placed nor kept, and counts toward no fault domain', () => {
    const view = placementViewOf(
      new RelayPoolService({} as never, {} as never, { publish: () => undefined } as never, {} as never, {} as never)
    );
    const failed = view(instances, failing, NOW);
    expect(failed.readyFaultDomains.size).toBe(2);
    expect(failed.grace.size).toBe(0);
    // Kept: the active generation still holds it.
    const planned = plan(failed.instancesFor(placedOnAll));
    expect(planned.map(({ instance }) => instance.id).sort()).toEqual(['relay-local', 'relay-uk']);
    // Nor in its disconnect grace: an offline relay whose data plane fails leaves at once (S4).
    const offline = view([relay('relay-local'), relay('relay-uk'), disconnected(20_000)], failing, NOW);
    expect(offline.grace.size).toBe(0);
    expect(plan(offline.instancesFor(placedOnAll)).map(({ instance }) => instance.id)).not.toContain('relay-nl');
  });

  it('is placed again at once when the nodes reach it, held back to free slots for a while', () => {
    const view = placementViewOf(
      new RelayPoolService({} as never, {} as never, { publish: () => undefined } as never, {} as never, {} as never)
    );
    view(instances, failing, NOW);
    const reached = view(instances, new Set(), NOW + 30_000);
    expect(reached.readyFaultDomains.size).toBe(3);
    expect([...reached.holdBack]).toEqual(['relay-nl']);
    // Nearest relay now, yet it takes a free (fallback) slot only, without displacing the serving primary.
    const nearerNl: EndpointLatencyPath = {
      endpoint: new Map([
        ['relay-local', 40],
        ['relay-uk', 62],
        ['relay-nl', 1],
      ]),
      sources: [],
    };
    const withoutNl = placedOnAll.filter(({ relayInstanceId }) => relayInstanceId !== 'relay-nl');
    const returned = planRelays(
      'endpoint-1',
      reached.instancesFor(withoutNl),
      3,
      false,
      nearerNl,
      withoutNl,
      false,
      undefined,
      reached.holdBack
    );
    expect(returned.find(({ instance }) => instance.id === 'relay-nl')?.role).toBe('fallback');
    expect(returned.find(({ instance }) => instance.id === 'relay-local')?.role).toBe('primary');
    expect(view(instances, new Set(), NOW + 30_000 + RELAY_RETURN_HOLD_MS).holdBack.size).toBe(0);
  });

  it('keeps its role where it still serves when it recovers before a generation moved the endpoint off it', () => {
    const service = new RelayPoolService(
      {} as never,
      {} as never,
      { publish: () => undefined } as never,
      {} as never,
      {} as never
    );
    const view = placementViewOf(service);
    const nearNl: EndpointLatencyPath = {
      endpoint: new Map([
        ['relay-local', 40],
        ['relay-uk', 62],
        ['relay-nl', 1],
      ]),
      sources: [],
    };
    const planEndpoint = (current: PlacementView, active: typeof placedOnAll) =>
      (
        service as unknown as {
          planEndpoint(
            endpointId: string,
            instances: RelayInstanceRow[],
            desiredCount: number,
            localOnly: boolean,
            path: EndpointLatencyPath,
            active: typeof placedOnAll,
            availabilityMember: boolean,
            notes: undefined,
            holdBack: ReadonlySet<string>
          ): ReturnType<typeof planRelays>;
        }
      ).planEndpoint(
        'endpoint-1',
        current.instancesFor(active),
        current.readyFaultDomains.size,
        false,
        nearNl,
        active,
        false,
        undefined,
        current.holdBack
      );
    const active = [
      { relayInstanceId: 'relay-nl', role: 'primary' },
      { relayInstanceId: 'relay-local', role: 'fallback' },
      { relayInstanceId: 'relay-uk', role: 'fallback' },
    ];
    // Failing for a moment: planned without it, but nothing was staged before it recovered.
    const failed = planEndpoint(view(instances, failing, NOW), active);
    expect(failed.map(({ instance }) => instance.id)).not.toContain('relay-nl');
    // Back: its endpoint still runs through it, so it is not held back and the plan is the active one again.
    expect(samePlannedAssignments(active, planEndpoint(view(instances, new Set(), NOW + 20_000), active))).toBe(true);
  });

  it('is judged from fresh reports each pass, so a healthy relay is never kept out by an earlier judgement', async () => {
    let failingNow = new Set(['relay-nl']);
    const service = new RelayPoolService(
      {} as never,
      {} as never,
      { publish: () => undefined } as never,
      {} as never,
      {} as never
    );
    service.setTopology({ endpointPaths: async () => new Map(), relayDataPlaneFailures: async () => failingNow });
    const judge = () =>
      (
        service as unknown as { dataPlaneFailures(instances: RelayInstanceRow[]): Promise<Set<string>> }
      ).dataPlaneFailures(instances);
    expect([...(await judge())]).toEqual(['relay-nl']);
    failingNow = new Set();
    expect((await judge()).size).toBe(0);
    // Without the reports (a read failure) relays are placed by their control state.
    service.setTopology({
      endpointPaths: async () => new Map(),
      relayDataPlaneFailures: async () => {
        throw new Error('database unavailable');
      },
    });
    expect((await judge()).size).toBe(0);
  });

  it('retries at once an attempt planned before a relay of it failed or recovered on its data plane', async () => {
    // The judgement is timed by the clock: the attempts were planned two minutes ago and failed one minute ago.
    const failedAt = Date.now() - 60_000;
    const attempt = (id: string, endpointId: string) => ({
      id,
      endpointId,
      createdAt: new Date(failedAt - 60_000),
      updatedAt: new Date(failedAt),
    });
    const attempts = [attempt('gen-13', 'endpoint-1'), attempt('gen-20', 'endpoint-2')];
    const relaysOf: Record<string, string[]> = { 'gen-13': ['relay-local', 'relay-nl'], 'gen-20': ['relay-local'] };
    const db = {
      select: () => ({
        from: () => ({
          where: async () =>
            Object.entries(relaysOf).flatMap(([generationId, ids]) =>
              ids.map((relayInstanceId) => ({ generationId, relayInstanceId }))
            ),
        }),
      }),
    };
    let failingNow = new Set<string>();
    const service = new RelayPoolService(
      db as never,
      {} as never,
      { publish: () => undefined } as never,
      {} as never,
      {} as never
    );
    service.setTopology({ endpointPaths: async () => new Map(), relayDataPlaneFailures: async () => failingNow });
    const internals = service as unknown as {
      dataPlaneFailures(instances: RelayInstanceRow[]): Promise<Set<string>>;
      failureRetryTimes(failures: typeof attempts): Promise<Map<string, number>>;
    };
    await internals.dataPlaneFailures(instances);
    const fiveMinutes = 5 * 60_000;
    // Nothing changed since the failures: both wait out the failure cooldown.
    expect(await internals.failureRetryTimes(attempts)).toEqual(
      new Map([
        ['endpoint-1', failedAt + fiveMinutes],
        ['endpoint-2', failedAt + fiveMinutes],
      ])
    );
    // NL is judged failing after the attempt that held it was planned: that endpoint goes again at once.
    failingNow = new Set(['relay-nl']);
    await internals.dataPlaneFailures(instances);
    const retry = await internals.failureRetryTimes(attempts);
    expect(retry.get('endpoint-1')).toBe(0);
    expect(retry.get('endpoint-2')).toBe(failedAt + fiveMinutes);
    // The attempt planned after that judgement waits out the cooldown again when it fails.
    const replanned = {
      id: 'gen-14',
      endpointId: 'endpoint-1',
      createdAt: new Date(Date.now() + 1_000),
      updatedAt: new Date(Date.now() + 2_000),
    };
    expect((await internals.failureRetryTimes([replanned])).get('endpoint-1')).toBe(
      replanned.updatedAt.getTime() + fiveMinutes
    );
  });
});

describe('Relay coming back', () => {
  it('fills a free slot only: it neither becomes a primary nor displaces a serving relay', () => {
    const nearerNl: EndpointLatencyPath = {
      endpoint: new Map([
        ['relay-local', 40],
        ['relay-uk', 62],
        ['relay-nl', 1],
      ]),
      sources: [],
    };
    const reference = [
      { relayInstanceId: 'relay-local', role: 'primary' },
      { relayInstanceId: 'relay-uk', role: 'fallback' },
    ];
    const instances = [relay('relay-local'), relay('relay-uk'), relay('relay-nl')];
    const held = chooseRelayAssignments('endpoint-1', instances, 3, nearerNl, reference, new Set(['relay-nl']));
    expect(held.find(({ instance }) => instance.id === 'relay-nl')?.role).toBe('fallback');
    expect(held.find(({ instance }) => instance.id === 'relay-local')?.role).toBe('primary');
    // With two slots it takes none of them while the relays there serve.
    for (const endpointId of ['endpoint-1', 'endpoint-2', 'endpoint-3', 'endpoint-4', 'endpoint-5', 'endpoint-6']) {
      const chosen = chooseByRendezvous(
        endpointId,
        instances,
        2,
        [],
        new Set(['relay-local', 'relay-uk']),
        new Set(['relay-nl'])
      );
      expect(chosen.map(({ id }) => id).sort()).toEqual(['relay-local', 'relay-uk']);
    }
  });

  it('holds back a relay that served again only for a while', () => {
    const service = new RelayPoolService(
      {} as never,
      {} as never,
      { publish: () => undefined } as never,
      {} as never,
      {} as never
    );
    const view = (instances: RelayInstanceRow[], at: number) =>
      (
        service as unknown as {
          placementView(
            instances: RelayInstanceRow[],
            failing: ReadonlySet<string>,
            now: number
          ): {
            grace: Set<string>;
            holdBack: Set<string>;
            readyFaultDomains: Set<string>;
            instancesFor(current: Array<{ relayInstanceId: string }>): RelayInstanceRow[];
          };
        }
      ).placementView(instances, new Set(), at);
    // A short control-stream loss: kept, counted among the fault domains, never held back.
    const flap = view([relay('relay-local'), relay('relay-uk'), disconnected(30_000)], NOW);
    expect([...flap.grace]).toEqual(['relay-nl']);
    expect(flap.readyFaultDomains.size).toBe(3);
    expect(flap.instancesFor([{ relayInstanceId: 'relay-nl' }]).find(({ id }) => id === 'relay-nl')?.state).toBe(
      'ready'
    );
    expect(view([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], NOW + 60_000).holdBack.size).toBe(0);
    // Gone past its grace, then back: held back for RELAY_RETURN_HOLD_MS.
    const gone = view([relay('relay-local'), relay('relay-uk'), disconnected(RELAY_DISCONNECT_GRACE_MS + 1)], NOW);
    expect(gone.grace.size).toBe(0);
    expect(gone.readyFaultDomains.size).toBe(2);
    expect([...view([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], NOW + 1_000).holdBack]).toEqual([
      'relay-nl',
    ]);
    expect(
      view([relay('relay-local'), relay('relay-uk'), relay('relay-nl')], NOW + RELAY_RETURN_HOLD_MS + 1).holdBack.size
    ).toBe(0);
  });
});

describe('Candidate topology', () => {
  it('gives an endpoint placed without latency data primaries, so daemons still order its relays by distance', () => {
    expect(candidateTopology('active')).toEqual({ role: 'primary', endpointRttMicros: 0 });
    expect(candidateTopology('primary')).toEqual({ role: 'primary', endpointRttMicros: 0 });
    expect(candidateTopology('fallback')).toEqual({ role: 'standby', endpointRttMicros: 0 });
  });
});
