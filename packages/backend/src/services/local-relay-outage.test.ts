import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayInstances } from '@/db/schema/index.js';
import { EVENT_BUS_MAPPINGS } from '@/modules/notifications/notification-event-mappings.js';
import {
  LOCAL_RELAY_OUTAGE_RECHECK_MS,
  LOCAL_RELAY_RECONNECT_GRACE_MS,
  type LocalRelayOutage,
  localRelayOutagePhase,
  localRelayOutageWaitMs,
} from './local-relay-outage.js';
import { NodeRegistryService } from './node-registry.service.js';
import { RelayPoolService } from './relay-pool.service.js';
import { RelaySupervisorService } from './relay-supervisor.service.js';
import { inDisconnectGrace, RELAY_DISCONNECT_GRACE_MS } from './relay-topology.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

const T0 = Date.UTC(2026, 9, 8, 6, 0);

afterEach(() => {
  vi.useRealTimers();
});

describe('local relay outage window', () => {
  it('covers nodes while the relay does not serve and for the reconnect grace after it serves again', () => {
    const outage: LocalRelayOutage = { since: T0, servingAgainAt: null, planned: false };
    expect(localRelayOutagePhase(outage, T0 + 60 * 60_000)).toBe('restarting');
    expect(localRelayOutageWaitMs(outage, T0 + 60_000)).toBe(LOCAL_RELAY_OUTAGE_RECHECK_MS);

    const back = { ...outage, servingAgainAt: T0 + 5 * 60_000 };
    expect(localRelayOutagePhase(back, T0 + 6 * 60_000)).toBe('reconnecting');
    expect(localRelayOutageWaitMs(back, T0 + 6 * 60_000)).toBe(LOCAL_RELAY_RECONNECT_GRACE_MS - 60_000);
    expect(localRelayOutagePhase(back, T0 + 5 * 60_000 + LOCAL_RELAY_RECONNECT_GRACE_MS)).toBeNull();
    expect(localRelayOutageWaitMs(back, T0 + 5 * 60_000 + LOCAL_RELAY_RECONNECT_GRACE_MS)).toBeNull();
    expect(localRelayOutagePhase(null, T0)).toBeNull();
  });
});

function relayHealth(overrides: Record<string, unknown> = {}) {
  return {
    buildVersion: 'relay-1',
    protocolMajor: 1,
    liveness: true,
    readiness: true,
    reason: '',
    registeredEndpoints: '0',
    activeTunnels: '0',
    ...overrides,
  };
}

function supervisorSetup(options: { expectedVersion?: string } = {}) {
  let now = T0;
  const persisted: unknown[] = [];
  const getHealth = vi.fn(async () => relayHealth());
  const updateChain = { set: () => ({ where: async () => [] }) };
  const supervisor = new RelaySupervisorService(
    { update: () => updateChain } as never,
    {
      get: async () => null,
      set: async (_key: string, value: unknown) => {
        persisted.push(structuredClone(value));
      },
    } as never,
    { getHealth } as never,
    null,
    { getConfig: async () => ({ relayAutoRecovery: false }) } as never,
    { publish: vi.fn() } as never,
    { log: vi.fn() } as never,
    {
      required: true,
      managed: false,
      expectedImage: null,
      expectedService: 'relay',
      expectedVersion: options.expectedVersion,
      now: () => now,
    }
  );
  const unreachable = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 14 });
  return {
    supervisor,
    getHealth,
    persisted,
    unreachable,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('relay supervisor: local relay outages', () => {
  it('opens an outage at the first failed probe and closes it when the relay serves again', async () => {
    const t = supervisorSetup();
    await t.supervisor.probeNow();
    expect(t.supervisor.latestOutage()).toBeNull();

    t.getHealth.mockRejectedValue(t.unreachable());
    t.advance(5_000);
    await t.supervisor.probeNow();
    expect(t.supervisor.latestOutage()).toEqual({ since: T0 + 5_000, servingAgainAt: null, planned: false });
    expect(t.supervisor.getSnapshot(false)?.outage).toMatchObject({ phase: 'restarting', servingAgainAt: null });
    // Recorded with the supervisor state, so another Opfield process and a restarted one see it.
    expect(t.persisted.at(-1)).toMatchObject({ outage: { servingAgainAt: null } });

    // Still down: the outage keeps its start.
    t.advance(5_000);
    await t.supervisor.probeNow();
    expect(t.supervisor.latestOutage()?.since).toBe(T0 + 5_000);

    t.getHealth.mockResolvedValue(relayHealth());
    t.advance(5 * 60_000);
    await t.supervisor.probeNow();
    const servingAgainAt = T0 + 10_000 + 5 * 60_000;
    expect(t.supervisor.latestOutage()).toMatchObject({ since: T0 + 5_000, servingAgainAt });
    expect(t.supervisor.getSnapshot(false)?.outage?.phase).toBe('reconnecting');
    t.advance(LOCAL_RELAY_RECONNECT_GRACE_MS);
    expect(t.supervisor.getSnapshot(false)?.outage).toBeNull();
  });

  it('opens no outage for a relay that answers but is not what Gateway expects', async () => {
    const t = supervisorSetup({ expectedVersion: 'relay-2' });
    await t.supervisor.probeNow();
    await t.supervisor.probeNow();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('critical');
    expect(t.supervisor.latestOutage()).toBeNull();
  });

  it('marks an update recreating the relay as a planned outage until the relay serves again', async () => {
    const t = supervisorSetup();
    await t.supervisor.probeNow();
    await t.supervisor.setMaintenance(true);
    expect(t.supervisor.latestOutage()).toEqual({ since: T0, servingAgainAt: null, planned: true });
    // Nothing probes the relay in maintenance, not even a node asking.
    await t.supervisor.confirmLocalRelay();
    expect(t.getHealth).toHaveBeenCalledTimes(1);
    t.advance(20_000);
    await t.supervisor.setMaintenance(false);
    await t.supervisor.probeNow();
    expect(t.supervisor.latestOutage()).toEqual({ since: T0, servingAgainAt: T0 + 20_000, planned: true });
  });

  it('checks the relay once for every node that asks at the same time, and the next healthy probe ends it', async () => {
    const t = supervisorSetup();
    await t.supervisor.probeNow();
    t.getHealth.mockClear();
    t.getHealth.mockRejectedValue(t.unreachable());
    await Promise.all([
      t.supervisor.confirmLocalRelay(),
      t.supervisor.confirmLocalRelay(),
      t.supervisor.confirmLocalRelay(),
    ]);
    expect(t.getHealth).toHaveBeenCalledTimes(1);
    // The check records the outage only; supervision and recovery keep their own probes.
    expect(t.supervisor.getSnapshot(true)?.state).toBe('healthy');
    expect(t.supervisor.latestOutage()?.servingAgainAt).toBeNull();

    t.getHealth.mockResolvedValue(relayHealth());
    t.advance(3_000);
    await t.supervisor.probeNow();
    expect(t.supervisor.latestOutage()?.servingAgainAt).toBe(T0 + 3_000);
  });
});

function chain<T>(result: T) {
  return Object.assign(Promise.resolve(result), { limit: async () => result, returning: async () => result });
}

function registrySetup() {
  const updates: Array<Record<string, unknown>> = [];
  const relayUpdates: Array<Record<string, unknown>> = [];
  let onlineRows: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => chain(onlineRows.length ? onlineRows : [{ metadata: {}, healthHistory: [] }]),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          if (table === relayInstances) relayUpdates.push(values);
          return chain([{ metadata: {} }]);
        },
      }),
    }),
  };
  const registry = new NodeRegistryService(db as never, { offlineDebounceMs: 5_000 });
  registry.startAcceptingConnections(T0 - 60_000);
  const published: Array<{ channel: string; payload: any }> = [];
  registry.setEventBus({
    publish: (channel: string, payload: unknown) => published.push({ channel, payload }),
  } as never);
  let outage: LocalRelayOutage | null = null;
  // Stands in for the supervisor: the relay is found down at the first check after it went down.
  let relayDown = false;
  const confirmLocalRelay = vi.fn(async () => {
    if (relayDown && !outage) outage = { since: Date.now(), servingAgainAt: null, planned: false };
  });
  registry.setLocalRelayOutage({ latestOutage: () => outage, confirmLocalRelay });
  const audits: Array<{ nodeId: string; details: Record<string, unknown> }> = [];
  registry.setDisconnectAudit(async (nodeId, details) => {
    audits.push({ nodeId, details });
  });
  const stream = () => ({ write: vi.fn(), end: vi.fn(), destroy: vi.fn() }) as never;
  const offlineEvents = () =>
    published.filter(({ channel, payload }) => channel === 'node.changed' && payload.status === 'offline');
  return {
    registry,
    updates,
    relayUpdates,
    audits,
    offlineEvents,
    stream,
    confirmLocalRelay,
    relayGoesDown: () => {
      relayDown = true;
    },
    relayServesAgain: () => {
      relayDown = false;
      if (outage) outage = { ...outage, servingAgainAt: Date.now() };
    },
    setOnlineRows: (rows: Array<Record<string, unknown>>) => {
      onlineRows = rows;
    },
  };
}

describe("node registry: a remote relay's control reconnect", () => {
  it('keeps the relay out of offline through a planned control reconnect, and marks it offline once its grace ends', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = registrySetup();
    const first = t.stream();
    await t.registry.register('relay-uk', 'relay', 'relay-1', 'hash', first);
    // Stand rc.9: the relay supervisor reconnects the control stream ~45 s after the relay's update (back in 1.3 s).
    await t.registry.deregister('relay-uk', first);
    expect(t.registry.isReconnecting('relay-uk')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_300);
    const second = t.stream();
    await t.registry.register('relay-uk', 'relay', 'relay-1', 'hash', second);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.relayUpdates).toEqual([]);
    // One that does not come back is offline once the grace ends, the relay instance with it.
    await t.registry.deregister('relay-uk', second);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.relayUpdates).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.relayUpdates).toEqual([expect.objectContaining({ state: 'offline' })]);
  });
});

describe('node registry: nodes that drop with the local relay', () => {
  it('keeps a node reconnecting, not offline, while the relay restarts and it comes back', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = registrySetup();
    const stream = t.stream();
    await t.registry.register('node-1', 'docker', 'app-node-1', 'hash', stream);
    t.relayGoesDown();
    await t.registry.deregister('node-1', stream);
    expect(t.confirmLocalRelay).toHaveBeenCalled();
    // The node's disconnect row waits for the outcome.
    expect(await t.registry.holdDisconnectAudit('node-1', { reason: 'stream_ended' })).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.offlineEvents()).toEqual([]);
    expect(t.updates.some((values) => values.status === 'offline')).toBe(false);
    expect(t.registry.isReconnecting('node-1')).toBe(true);
    expect(t.registry.isAwaitingLocalRelay('node-1')).toBe(true);

    t.relayServesAgain();
    await vi.advanceTimersByTimeAsync(10_000);
    await t.registry.register('node-1', 'docker', 'app-node-1', 'hash', t.stream());
    await vi.advanceTimersByTimeAsync(LOCAL_RELAY_RECONNECT_GRACE_MS);
    expect(t.offlineEvents()).toEqual([]);
    expect(t.audits).toEqual([]);
    expect(t.registry.isAwaitingLocalRelay('node-1')).toBe(false);
  });

  it('marks a node that is not back after the reconnect grace offline then, with its disconnect row', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = registrySetup();
    const stream = t.stream();
    await t.registry.register('node-2', 'docker', 'app-node-2', 'hash', stream);
    t.relayGoesDown();
    await t.registry.deregister('node-2', stream);
    expect(await t.registry.holdDisconnectAudit('node-2', { reason: 'stream_ended' })).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    t.relayServesAgain();

    await vi.advanceTimersByTimeAsync(LOCAL_RELAY_RECONNECT_GRACE_MS - 10_000);
    expect(t.offlineEvents()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.offlineEvents()).toEqual([
      { channel: 'node.changed', payload: expect.objectContaining({ id: 'node-2', status: 'offline' }) },
    ]);
    expect(t.audits).toEqual([
      {
        nodeId: 'node-2',
        details: expect.objectContaining({ reason: 'stream_ended', disconnectedAt: expect.any(String) }),
      },
    ]);
  });

  it('still marks a node offline after the usual grace when the local relay serves throughout', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = registrySetup();
    const stream = t.stream();
    await t.registry.register('node-3', 'nginx', 'ingress-1', 'hash', stream);
    await t.registry.deregister('node-3', stream);
    expect(await t.registry.holdDisconnectAudit('node-3', { reason: 'error' })).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.offlineEvents()).toHaveLength(1);
    expect(t.registry.isReconnecting('node-3')).toBe(false);
  });

  it('judges no stale node while the relay restarts', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = registrySetup();
    t.setOnlineRows([{ id: 'node-4', hostname: 'storage-1', lastSeenAt: new Date(T0 - 10 * 60_000), metadata: {} }]);
    t.relayGoesDown();
    await t.confirmLocalRelay();
    await t.registry.markStaleNodesOffline();
    expect(t.offlineEvents()).toEqual([]);
    t.relayServesAgain();
    vi.setSystemTime(T0 + LOCAL_RELAY_RECONNECT_GRACE_MS);
    await t.registry.markStaleNodesOffline();
    expect(t.offlineEvents()).toHaveLength(1);
  });
});

function relay(id: string, overrides: Partial<RelayInstanceRow> = {}): RelayInstanceRow {
  return {
    id,
    poolId: 'system',
    kind: id === 'relay-local' ? 'local' : 'remote',
    nodeId: `node-${id}`,
    faultDomainId: `fd-${id}`,
    displayName: id,
    state: 'ready',
    manualDrainStartedAt: null,
    lastSeenAt: new Date(T0),
    health: { admissionState: 'ready' } as RelayInstanceRow['health'],
    ...overrides,
  } as RelayInstanceRow;
}

describe('relay pool: remote relays that drop with the local relay', () => {
  const outage: LocalRelayOutage = { since: T0 + 3_000, servingAgainAt: null, planned: false };
  const droppedWithIt = relay('relay-uk', { state: 'offline', lastSeenAt: new Date(T0) });

  it('does not count the outage toward their disconnect grace', () => {
    const later = T0 + 10 * 60_000;
    expect(inDisconnectGrace(droppedWithIt, later, new Set())).toBe(false);
    expect(inDisconnectGrace(droppedWithIt, later, new Set(), outage)).toBe(true);
    // From the moment the local relay serves again the grace runs as usual.
    const back = { ...outage, servingAgainAt: later };
    expect(inDisconnectGrace(droppedWithIt, later + RELAY_DISCONNECT_GRACE_MS - 1, new Set(), back)).toBe(true);
    expect(inDisconnectGrace(droppedWithIt, later + RELAY_DISCONNECT_GRACE_MS, new Set(), back)).toBe(false);
    // A relay that was gone before the outage gets nothing from it, nor one whose data plane fails.
    const goneBefore = relay('relay-nl', { state: 'offline', lastSeenAt: new Date(T0 - 2 * 60_000) });
    expect(inDisconnectGrace(goneBefore, T0 + 30_000, new Set(), outage)).toBe(true);
    expect(inDisconnectGrace(goneBefore, later, new Set(), outage)).toBe(false);
    expect(inDisconnectGrace(droppedWithIt, later, new Set(['relay-uk']), outage)).toBe(false);
  });

  it('keeps them in placement through a long outage', () => {
    const service = new RelayPoolService({} as never, {} as never, {} as never, {} as never, {} as never);
    service.setLocalRelayOutage({ latestOutage: () => outage });
    const view = (
      service as unknown as {
        placementView(instances: RelayInstanceRow[], failing: ReadonlySet<string>, now: number): { grace: Set<string> };
      }
    ).placementView([relay('relay-local', { state: 'offline' }), droppedWithIt], new Set(), T0 + 10 * 60_000);
    expect([...view.grace]).toEqual(['relay-uk']);
  });

  it('reads as one restarting local relay, and as reconnecting nodes until they are back', async () => {
    let current: LocalRelayOutage = outage;
    const awaiting = new Set(['node-a']);
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ id: 'node-a' }, { id: 'node-b' }] }) }),
    };
    const service = new RelayPoolService(db as never, {} as never, {} as never, {} as never, {} as never);
    service.setLocalRelayOutage({ latestOutage: () => current }, { isAwaitingLocalRelay: (id) => awaiting.has(id) });
    const describeOutage = (instances: RelayInstanceRow[], now: number) =>
      (
        service as unknown as {
          describeLocalRelayOutage(
            instances: RelayInstanceRow[],
            now: number
          ): Promise<{ phase: string; reconnectingNodes: number; reconnectingRelayIds: Set<string> } | null>;
        }
      ).describeLocalRelayOutage(instances, now);
    const instances = [relay('relay-local', { state: 'offline' }), droppedWithIt];

    const restarting = await describeOutage(instances, T0 + 60_000);
    expect(restarting).toMatchObject({ phase: 'restarting', reconnectingNodes: 1 });
    expect([...restarting!.reconnectingRelayIds]).toEqual(['relay-uk']);

    current = { ...outage, servingAgainAt: T0 + 2 * 60_000 };
    const back = [relay('relay-local'), relay('relay-uk', { lastSeenAt: new Date(T0 + 2 * 60_000) })];
    expect(await describeOutage(back, T0 + 2 * 60_000 + 5_000)).toMatchObject({
      phase: 'reconnecting',
      reconnectingNodes: 1,
    });
    awaiting.clear();
    expect(await describeOutage(back, T0 + 2 * 60_000 + 10_000)).toBeNull();
  });
});

describe('Gateway relay alert', () => {
  const [mapping] = EVENT_BUS_MAPPINGS['system.relay.health.changed']!;

  it('follows only the relay supervisor, not pool or relay runtime events', () => {
    expect(mapping!.match({ state: 'critical', reason: 'unreachable', attempt: 0 })).toBe(true);
    expect(mapping!.match({ poolId: 'system', action: 'instances_offline' })).toBe(false);
    expect(mapping!.match({ nodeId: 'node-1', instanceId: 'relay-uk', action: 'runtime_status_changed' })).toBe(false);
    expect(mapping!.match({ action: 'revocation_fence', instanceId: 'relay-uk', state: 'x' })).toBe(false);
  });
});
