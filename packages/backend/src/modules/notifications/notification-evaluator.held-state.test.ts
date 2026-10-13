import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationEvaluatorService, outageStart } from './notification-evaluator.service.js';

const T0 = Date.UTC(2026, 9, 8, 14, 0);
const RELAY = 'system.relay.health.changed';

/** The sorted-set calls the evaluator's alert windows make, in memory. */
function fakeRedis() {
  const sets = new Map<string, Map<string, number>>();
  const bound = (value: string | number) => {
    if (typeof value === 'number') return { value, open: false };
    if (value === '+inf') return { value: Number.POSITIVE_INFINITY, open: false };
    if (value === '-inf') return { value: Number.NEGATIVE_INFINITY, open: false };
    return value.startsWith('(')
      ? { value: Number(value.slice(1)), open: true }
      : { value: Number(value), open: false };
  };
  const within = (score: number, min: string | number, max: string | number) => {
    const low = bound(min);
    const high = bound(max);
    return (
      (low.open ? score > low.value : score >= low.value) && (high.open ? score < high.value : score <= high.value)
    );
  };
  const members = (key: string) => [...(sets.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]);
  return {
    zadd: async (key: string, score: number, member: string) => {
      const set = sets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sets.set(key, set);
      return 1;
    },
    zrangebyscore: async (key: string, min: string | number, max: string | number) =>
      members(key)
        .filter(([, score]) => within(score, min, max))
        .map(([member]) => member),
    zrevrangebyscore: async (key: string, max: string | number, min: string | number, ...limit: unknown[]) => {
      const found = members(key)
        .filter(([, score]) => within(score, min, max))
        .reverse()
        .map(([member]) => member);
      return limit[0] === 'LIMIT' ? found.slice(Number(limit[1]), Number(limit[1]) + Number(limit[2])) : found;
    },
    zremrangebyscore: async (key: string, min: string | number, max: string | number) => {
      const set = sets.get(key);
      for (const [member, score] of [...(set ?? new Map()).entries()]) if (within(score, min, max)) set!.delete(member);
      return 1;
    },
    expire: async () => 1,
  };
}

function setup(rule: Record<string, unknown>) {
  const service = new NotificationEvaluatorService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getClient: () => fakeRedis() } as never,
    {} as never
  );
  const internals = service as any;
  internals.getEventRules = async () => [
    { id: 'rule-1', category: 'opfield', resourceIds: [], durationSeconds: 0, resolveAfterSeconds: 60, ...rule },
  ];
  let firing: { id: string } | null = null;
  const fired = vi.fn(async () => {
    firing = { id: 'state-1' };
  });
  const resolved = vi.fn(async () => {
    firing = null;
  });
  internals.getActiveAlertState = async () => firing;
  internals.fireAlert = fired;
  internals.resolveAlert = resolved;
  const publish = async (payload: Record<string, unknown>) => {
    await internals.handleBusEvent(RELAY, payload);
  };
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.allSettled([...internals.activeHandlers]);
  };
  return { service, fired, resolved, publish, advance };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(async () => {
  vi.useRealTimers();
});

describe('Gateway relay alert: the supervisor state holds until its next change', () => {
  it('resolves within its resolve window once the relay serves again, with no further event', async () => {
    const t = setup({ eventPattern: 'relay.unavailable' });
    await t.publish({ state: 'critical', reason: 'unreachable', attempt: 0 });
    expect(t.fired).toHaveBeenCalledTimes(1);

    await t.advance(30_000);
    await t.publish({ state: 'healthy', reason: null, attempt: 0 });
    // One healthy sample does not cover the 60-s window yet.
    expect(t.resolved).not.toHaveBeenCalled();

    await t.advance(59_000);
    expect(t.resolved).not.toHaveBeenCalled();
    await t.advance(2_000);
    expect(t.resolved).toHaveBeenCalledTimes(1);
    await t.service.stop();
  });

  it('stays firing through an outage: pool events and the held critical state resolve nothing', async () => {
    const t = setup({ eventPattern: 'relay.unavailable' });
    await t.publish({ state: 'critical', reason: 'unreachable', attempt: 0 });
    await t.advance(70_000);
    await t.publish({ poolId: 'system', action: 'instances_offline' });
    await t.publish({ nodeId: 'node-1', instanceId: 'relay-uk', action: 'runtime_status_changed' });
    await t.advance(5 * 60_000);
    expect(t.resolved).not.toHaveBeenCalled();
    expect(t.fired).toHaveBeenCalledTimes(1);
    await t.service.stop();
  });

  it('a healthy sample a new outage replaced does not resolve the alert later', async () => {
    const t = setup({ eventPattern: 'relay.unavailable' });
    await t.publish({ state: 'critical', reason: 'unreachable', attempt: 0 });
    await t.advance(30_000);
    await t.publish({ state: 'healthy', reason: null, attempt: 0 });
    await t.advance(5_000);
    // The next outage: a first failed probe (suspect reads as healthy), then critical.
    await t.publish({ state: 'suspect', reason: 'unreachable', attempt: 0 });
    await t.advance(5_000);
    await t.publish({ state: 'critical', reason: 'unreachable', attempt: 0 });
    await t.advance(3 * 60_000);
    expect(t.resolved).not.toHaveBeenCalled();
    await t.service.stop();
  });

  it('fires a rule with a duration once the critical state held that long', async () => {
    const t = setup({ eventPattern: 'relay.unavailable', durationSeconds: 30 });
    await t.publish({ state: 'healthy', reason: null, attempt: 0 });
    await t.advance(10 * 60_000);
    await t.publish({ state: 'critical', reason: 'unreachable', attempt: 0 });
    expect(t.fired).not.toHaveBeenCalled();
    await t.advance(32_000);
    expect(t.fired).toHaveBeenCalledTimes(1);
    await t.service.stop();
  });

  it('observes nothing again after the evaluator stopped', async () => {
    const t = setup({ eventPattern: 'relay.unavailable' });
    await t.publish({ state: 'critical', reason: 'unreachable', attempt: 0 });
    await t.advance(30_000);
    await t.publish({ state: 'healthy', reason: null, attempt: 0 });
    await t.service.stop();
    await t.advance(2 * 60_000);
    expect(t.resolved).not.toHaveBeenCalled();
  });
});

describe('Gateway relay alert duration (rc.8 O-1)', () => {
  it('keeps the outage start the supervisor reports with the firing', async () => {
    const t = setup({ eventPattern: 'relay.unavailable' });
    const since = new Date(T0 - 8_000).toISOString();
    await t.publish({ state: 'critical', reason: 'unreachable', attempt: 0, outageSince: since });
    const details = (t.fired.mock.calls[0] as unknown[])[4] as { details: Record<string, unknown> };
    expect(details.details.outage_since).toBe(since);
    await t.service.stop();
  });

  it('counts a resolved alert from the outage start, not from its firing', () => {
    const firedAt = new Date(T0);
    expect(outageStart({ details: { outage_since: new Date(T0 - 8_000).toISOString() } }, firedAt)).toEqual(
      new Date(T0 - 8_000)
    );
    // No start, a start after the firing, or one from an older outage: the firing.
    expect(outageStart({}, firedAt)).toBe(firedAt);
    expect(outageStart({ details: { outage_since: new Date(T0 + 1_000).toISOString() } }, firedAt)).toBe(firedAt);
    expect(outageStart({ details: { outage_since: new Date(T0 - 3_600_000).toISOString() } }, firedAt)).toBe(firedAt);
  });
});
