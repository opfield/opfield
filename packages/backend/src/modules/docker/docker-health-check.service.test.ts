import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCKER_HEALTH_RECHECK_DEBOUNCE_MS,
  DOCKER_HEALTH_RECONNECT_GRACE_MS,
  DockerHealthCheckService,
} from './docker-health-check.service.js';

type Handler = (payload: unknown) => void;

function setup(
  options: {
    bindings?: Array<{ status: string }>;
    connected?: boolean;
    updating?: boolean;
    reconnecting?: boolean;
  } = {}
) {
  const updates: Array<Record<string, unknown>> = [];
  const bindings = options.bindings ?? [];
  const row: any = {
    id: 'hc-1',
    target: 'container',
    nodeId: 'node-1',
    containerName: 'web',
    deploymentId: null,
    enabled: true,
    healthStatus: 'online',
    healthHistory: [],
    intervalSeconds: 30,
    lastHealthCheckAt: new Date(Date.now() - 60_000),
  };
  const db: any = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
          Object.assign(row, values);
        },
      }),
    }),
    select: () => ({ from: () => ({ where: async () => bindings }) }),
    query: { dockerHealthChecks: { findFirst: vi.fn(async () => row) } },
  };
  const dispatch: any = {
    isNodeConnected: () => options.connected ?? true,
    isNodeReconnecting: () => options.reconnecting ?? false,
    isNodeUpdateInProgress: async () => options.updating ?? false,
  };
  const service = new DockerHealthCheckService(db, dispatch);
  const internals = service as any;
  internals.isIntentionallyStopped = async () => false;
  internals.getDeploymentName = async () => 'web';
  const probe = vi.fn();
  internals.probeRow = probe;
  const evaluator = { observeStatefulEvent: vi.fn(async () => undefined) };
  service.setEvaluator(evaluator as any);
  const subscriptions = new Map<string, Handler>();
  const bus = {
    subscribe: vi.fn((topic: string, handler: Handler) => subscriptions.set(topic, handler)),
    publish: vi.fn(),
  };
  service.setEventBus(bus as any);
  const outsideStartupGrace = () => {
    internals.startedAt = Date.now() - DOCKER_HEALTH_RECONNECT_GRACE_MS - 1;
  };
  const check = () => internals.checkAndStore({ ...row }) as Promise<void>;
  return {
    service,
    internals,
    row,
    updates,
    probe,
    evaluator,
    bus,
    subscriptions,
    bindings,
    outsideStartupGrace,
    check,
  };
}

const unreachable = { ok: false, status: 'offline', unreachableNodeId: 'node-1' };
const failed = { ok: false, status: 'offline' };
const healthy = { ok: true, status: 'online', responseMs: 4 };

afterEach(() => {
  vi.useRealTimers();
});

describe('Docker health: node not connected', () => {
  it('records nothing while Opfield has just started and the node has not reconnected', async () => {
    const t = setup({ connected: false });
    t.probe.mockResolvedValue(unreachable);
    await t.check();
    expect(t.updates).toEqual([]);
    expect(t.evaluator.observeStatefulEvent).not.toHaveBeenCalled();
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('records nothing while the node daemon is being updated or the node is reconnecting', async () => {
    for (const state of [{ updating: true }, { reconnecting: true }]) {
      const t = setup({ connected: false, ...state });
      t.outsideStartupGrace();
      t.probe.mockResolvedValue(unreachable);
      await t.check();
      await t.check();
      expect(t.updates).toEqual([]);
      expect(t.evaluator.observeStatefulEvent).not.toHaveBeenCalled();
    }
  });

  it('turns an inspect that cannot reach the node into a deferred probe, not a missing route', async () => {
    const t = setup({ connected: false });
    t.internals.probeRow = Object.getPrototypeOf(t.service).probeRow;
    t.internals.availabilityHealth = async () => null;
    t.internals.resolveAvailabilityProbeNodeId = async () => 'node-1';
    t.internals.getContainerRouteOptions = async () => {
      throw new Error('Node node-1 is not connected');
    };
    await t.check();
    expect(t.updates).toEqual([]);
  });

  it('reports a node that stays away outside every grace after two failed probes', async () => {
    const t = setup({ connected: false });
    t.outsideStartupGrace();
    t.probe.mockResolvedValue(unreachable);
    await t.check();
    expect(t.updates).toEqual([]);
    await t.check();
    expect(t.updates.at(-1)?.healthStatus).toBe('offline');
  });
});

describe('Docker health: consecutive failures', () => {
  it('goes offline on the second failed probe on a connected node, and online on the first success', async () => {
    const t = setup();
    t.outsideStartupGrace();
    t.probe.mockResolvedValue(failed);
    await t.check();
    expect(t.updates).toEqual([]);
    expect(t.evaluator.observeStatefulEvent).not.toHaveBeenCalled();

    await t.check();
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]?.healthStatus).toBe('offline');
    expect(t.evaluator.observeStatefulEvent).toHaveBeenCalledWith(
      'container',
      'health.offline',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );

    t.probe.mockResolvedValue(healthy);
    await t.check();
    expect(t.updates.at(-1)?.healthStatus).toBe('online');
  });

  it('a failure between successes leaves no history entry', async () => {
    const t = setup();
    t.probe.mockResolvedValueOnce(healthy).mockResolvedValueOnce(failed).mockResolvedValueOnce(healthy);
    await t.check();
    await t.check();
    await t.check();
    const history = t.row.healthHistory as Array<{ status: string }>;
    expect(t.updates.map((update) => update.healthStatus)).toEqual(['online', 'online']);
    expect(history.some((entry) => entry.status === 'offline')).toBe(false);
  });

  it('checks one row at a time', async () => {
    const t = setup();
    let release!: () => void;
    t.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(healthy);
        })
    );
    const first = t.check();
    const second = t.check();
    await second;
    release();
    await first;
    expect(t.probe).toHaveBeenCalledTimes(1);
  });
});

describe('Docker health: database dependency', () => {
  it('a binding error on one check does not take the workload offline; one that persists does', async () => {
    const t = setup({ bindings: [{ status: 'error' }] });
    t.probe.mockResolvedValue(healthy);
    await t.check();
    expect(t.updates.at(-1)?.healthStatus).toBe('online');
    await t.check();
    expect(t.updates.at(-1)?.healthStatus).toBe('offline');

    t.bindings.splice(0, 1, { status: 'ready' });
    await t.check();
    expect(t.updates.at(-1)?.healthStatus).toBe('online');
  });

  it('a flip to error and back never reports the workload offline', async () => {
    const t = setup({ bindings: [{ status: 'ready' }] });
    t.probe.mockResolvedValue(healthy);
    for (const status of ['error', 'ready', 'error', 'ready']) {
      t.bindings.splice(0, 1, { status });
      await t.check();
    }
    expect(t.updates.every((update) => update.healthStatus === 'online')).toBe(true);
  });

  it('ignores relay health events: a critical local relay does not override a working binding', async () => {
    const t = setup({ bindings: [{ status: 'ready' }] });
    expect(t.subscriptions.has('system.relay.health.changed')).toBe(false);
    t.probe.mockResolvedValue(healthy);
    await t.check();
    expect(t.updates.at(-1)?.healthStatus).toBe('online');
  });
});

describe('Docker health: binding event rechecks', () => {
  const bindingEvent = {
    resourceKind: 'managed_database_binding',
    targetNodeId: 'node-1',
    targetType: 'container',
    targetResourceId: 'web',
  };

  it('a burst of binding events causes one recheck, and only when the row is due', async () => {
    vi.useFakeTimers();
    const t = setup();
    const checkAndStore = vi.fn(async () => undefined);
    t.internals.checkAndStore = checkAndStore;
    const emit = t.subscriptions.get('database.changed')!;
    for (let i = 0; i < 10; i++) emit(bindingEvent);
    await vi.advanceTimersByTimeAsync(DOCKER_HEALTH_RECHECK_DEBOUNCE_MS);
    expect(checkAndStore).toHaveBeenCalledTimes(1);

    // Checked moments ago: the event waits for the scheduled run instead of adding a history sample.
    t.row.lastHealthCheckAt = new Date();
    for (let i = 0; i < 10; i++) emit(bindingEvent);
    await vi.advanceTimersByTimeAsync(DOCKER_HEALTH_RECHECK_DEBOUNCE_MS);
    expect(checkAndStore).toHaveBeenCalledTimes(1);
  });
});
