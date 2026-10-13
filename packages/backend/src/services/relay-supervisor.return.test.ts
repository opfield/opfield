import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger.js';
import { RelaySupervisorService } from './relay-supervisor.service.js';

const T0 = Date.UTC(2026, 9, 8, 14, 0);

function relayHealth() {
  return {
    buildVersion: 'relay-1',
    protocolMajor: 1,
    liveness: true,
    readiness: true,
    reason: '',
    registeredEndpoints: '0',
    activeTunnels: '0',
  };
}

/**
 * A local relay behind a gRPC channel that, once it failed, keeps failing until it is replaced: grpc-js waits out its
 * reconnect backoff and keeps the address it resolved, while the relay may come back elsewhere.
 */
function setup(persisted: unknown = null, options: { lookup?: () => Promise<void> } = {}) {
  let relayUp = true;
  let channelFailed = false;
  const published: Array<Record<string, unknown>> = [];
  const getHealth = vi.fn(async () => {
    if (!relayUp) channelFailed = true;
    if (channelFailed) throw Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    return relayHealth();
  });
  const reconnectIfDown = vi.fn(() => {
    const replaced = channelFailed;
    channelFailed = false;
    return replaced;
  });
  const updateChain = { set: () => ({ where: async () => [] }) };
  const supervisor = new RelaySupervisorService(
    {
      update: () => updateChain,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              await options.lookup?.();
              return [];
            },
          }),
        }),
      }),
    } as never,
    { get: async () => persisted, set: async () => undefined } as never,
    { getHealth, reconnectIfDown } as never,
    null,
    { getConfig: async () => ({ relayAutoRecovery: false }) } as never,
    { publish: (_channel: string, payload: Record<string, unknown>) => published.push(payload) } as never,
    { log: vi.fn() } as never,
    { required: true, managed: false, expectedImage: null, expectedService: 'relay' }
  );
  return {
    supervisor,
    getHealth,
    reconnectIfDown,
    published,
    relay: (up: boolean) => {
      relayUp = up;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('relay supervisor: a local relay that comes back', () => {
  it('is seen serving within about a second, on a fresh channel, while the regular probe waits 5 s (O-2)', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.supervisor.start();
    t.relay(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.supervisor.getSnapshot(true)?.state).toBe('critical');
    expect(t.supervisor.latestOutage()?.servingAgainAt).toBeNull();

    // Back just after a regular probe: that probe's next turn is almost 5 s away.
    await vi.advanceTimersByTimeAsync(100);
    const backAt = Date.now();
    t.relay(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.supervisor.getSnapshot(true)?.state).toBe('healthy');
    expect(t.supervisor.latestOutage()!.servingAgainAt! - backAt).toBeLessThanOrEqual(1_500);
    await t.supervisor.stop();
  });

  it('reconnects Opfield’s other channels to the relay as soon as it serves again (F-2)', async () => {
    const t = setup();
    await t.supervisor.probeNow();
    t.relay(false);
    await t.supervisor.probeNow();
    await t.supervisor.probeNow();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('critical');
    const before = t.reconnectIfDown.mock.calls.length;

    t.relay(true);
    // The supervisor's own channel came back (here: replaced by the return check); the others had not.
    await t.supervisor.watchReturn();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('healthy');
    // Once for the check, once when the outage ended: the tunnel broker and policy channels reconnect now.
    expect(t.reconnectIfDown.mock.calls.length - before).toBe(2);
  });

  it('logs the reconnect of its channels at every return, also when the return watch had replaced them (O-6)', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const t = setup();
    await t.supervisor.probeNow();
    t.relay(false);
    await t.supervisor.probeNow();
    await t.supervisor.probeNow();
    t.relay(true);
    // The return check replaces the failed channel and finds the relay serving: at serving-again no channel is down.
    await t.supervisor.watchReturn();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('healthy');
    const calls = info.mock.calls as unknown as Array<[unknown, Record<string, unknown>?]>;
    const lines = calls.filter(([message]) => message === 'Opfield reconnected its channels to the local relay');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toMatchObject({ replacedNow: false });
  });

  it('checks nothing while the relay serves or an update recreates it', async () => {
    const t = setup();
    await t.supervisor.probeNow();
    await t.supervisor.watchReturn();
    await t.supervisor.setMaintenance(true);
    await t.supervisor.watchReturn();
    expect(t.getHealth).toHaveBeenCalledTimes(1);
    expect(t.reconnectIfDown).not.toHaveBeenCalled();
  });
});

describe('relay supervisor: an answer from before the relay went down (stand rc.7, O-1)', () => {
  it('does not end the outage with a probe that was under way when a hard stop was recorded', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    let release: () => void = () => undefined;
    let held: Promise<void> | null = null;
    const t = setup(null, { lookup: () => held ?? Promise.resolve() });
    await t.supervisor.probeNow();
    // The regular probe gets its healthy answer, then writes the relay's health report (held here)...
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = t.supervisor.probeNow();
    await vi.waitFor(() => expect(t.getHealth).toHaveBeenCalledTimes(2));
    // ...while the relay is killed: a node's control stream ends and its on-demand check finds the relay down.
    t.relay(false);
    await t.supervisor.confirmLocalRelay();
    const outage = t.supervisor.latestOutage();
    expect(outage?.servingAgainAt).toBeNull();
    held = null;
    release();
    await probe;
    expect(t.supervisor.latestOutage()).toEqual(outage);
    const lines = (info.mock.calls as unknown as Array<[unknown]>).map(([message]) => message);
    expect(lines).not.toContain('Opfield relay serves again; nodes and relays get a reconnect grace');
    expect(lines).not.toContain('Opfield reconnected its channels to the local relay');

    // The relay really comes back: a check started after the outage ends it.
    t.relay(true);
    await t.supervisor.watchReturn();
    expect(t.supervisor.latestOutage()?.servingAgainAt).not.toBeNull();
    expect(t.supervisor.latestOutage()?.since).toBe(outage?.since);
  });

  it('does not open an outage again with a failed check that started before the relay served again', async () => {
    const t = setup();
    await t.supervisor.probeNow();
    t.relay(false);
    await t.supervisor.probeNow();
    await t.supervisor.probeNow();
    expect(t.supervisor.latestOutage()?.servingAgainAt).toBeNull();
    // An on-demand check fails while the relay is down; its answer arrives after the relay serves again.
    let failCheck: (error: Error) => void = () => undefined;
    t.getHealth.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failCheck = reject;
        })
    );
    const late = t.supervisor.confirmLocalRelay();
    t.relay(true);
    await t.supervisor.watchReturn();
    const ended = t.supervisor.latestOutage();
    expect(ended?.servingAgainAt).not.toBeNull();
    failCheck(Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 }));
    await late;
    expect(t.supervisor.latestOutage()).toEqual(ended);
  });
});

describe('relay supervisor: Opfield start', () => {
  const persistedOutage = {
    state: 'critical',
    reason: 'unreachable',
    attempt: 0,
    maxAttempts: 3,
    attemptHistory: [],
    lastHealthyAt: new Date(T0 - 60_000).toISOString(),
    lastProbeAt: new Date(T0 - 5_000).toISOString(),
    outage: { since: new Date(T0 - 60_000).toISOString(), servingAgainAt: null, planned: false },
  };

  it('restores an outage before its first answer, without probing the relay (O-5)', async () => {
    const t = setup(persistedOutage);
    expect(t.supervisor.getSnapshot(true)?.state).toBe('migration_pending');
    await t.supervisor.restore();
    expect(t.supervisor.getSnapshot(true)?.state).toBe('critical');
    expect(t.supervisor.latestOutage()).toEqual({ since: T0 - 60_000, servingAgainAt: null, planned: false });
    expect(t.supervisor.getSnapshot(false)?.outage?.phase).toBe('restarting');
    expect(t.getHealth).not.toHaveBeenCalled();
  });

  it('publishes its state once at start, so an alert the previous process left firing can resolve (F-1)', async () => {
    const t = setup({ ...persistedOutage, state: 'healthy', reason: null, outage: null });
    await t.supervisor.start();
    // Nothing changed (healthy then, healthy now), yet the evaluator gets the state.
    expect(t.published).toEqual([{ state: 'healthy', reason: null, attempt: 0, outageSince: null }]);
    await t.supervisor.stop();
  });
});
