import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { NotificationEvaluatorService, outageStart } from './notification-evaluator.service.js';

const T0 = Date.UTC(2026, 9, 18, 17, 0);
const NODE = '22222222-2222-4222-8222-222222222222';

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

/**
 * Stand 2.12.6-rc.1, O-4: a Container Stopped rule with a fire window never fired for a container Opfield stopped. The
 * node's health reports (every 30 s here) say "exited" for it; they now keep the Stopped window covered too.
 */
describe('Container Stopped rule', () => {
  let service: NotificationEvaluatorService;
  let fired: ReturnType<typeof vi.fn>;
  let nodes: NodeRegistryService;
  let pending: Promise<unknown>[];

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    service = new NotificationEvaluatorService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getClient: () => fakeRedis() } as never,
      { getNode: () => undefined } as never
    );
    const internals = service as any;
    internals.getEventRules = async () => [
      {
        id: 'rule-stopped',
        category: 'container',
        eventPattern: 'stopped',
        resourceIds: ['web'],
        durationSeconds: 60,
        fireThresholdPercent: 100,
        resolveAfterSeconds: 60,
        resolveThresholdPercent: 100,
      },
    ];
    let firing: { id: string } | null = null;
    fired = vi.fn(async () => {
      firing = { id: 'state-1' };
    });
    internals.getActiveAlertState = async () => firing;
    internals.fireAlert = fired;
    internals.resolveAlert = vi.fn(async () => {
      firing = null;
    });
    // The registry does not wait for the evaluator; the test waits for every observation it starts.
    const observe = service.observeStatefulEvent.bind(service);
    pending = [];
    nodes = new NodeRegistryService({} as never, { offlineDebounceMs: 0 });
    nodes.setEvaluator({
      observeStatefulEvent: (...args: Parameters<typeof observe>) => {
        const run = observe(...args);
        pending.push(run);
        return run;
      },
    } as never);
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
  });

  const report = async (state: string) => {
    nodes.observeDockerContainerState(NODE, 'c1', 'web', state);
    await Promise.all(pending.splice(0));
  };

  it('fires once the container stayed stopped for the fire window', async () => {
    await report('running');
    await vi.advanceTimersByTimeAsync(30_000);
    // Stopped through Opfield: Docker reports it exited from now on.
    for (let elapsed = 0; elapsed <= 60_000; elapsed += 30_000) {
      await report('exited');
      if (elapsed < 60_000) expect(fired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fired).toHaveBeenCalledTimes(1);
    expect((fired.mock.calls[0] as unknown[])[0]).toMatchObject({ id: 'rule-stopped' });
  });

  // Stand 2.12.6-rc.2, O-9: the resolve message counted from the firing ("running again after 1m 35s") instead of from
  // the stop (3m 43s).
  it('records when the container stopped, so the resolve message counts the whole stop', async () => {
    await report('running');
    await vi.advanceTimersByTimeAsync(30_000);
    const stoppedAt = Date.now();
    for (let elapsed = 0; elapsed <= 60_000; elapsed += 30_000) {
      await report('exited');
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fired).toHaveBeenCalledTimes(1);
    const details = (fired.mock.calls[0] as unknown[])[4] as { details: Record<string, unknown> };
    expect(details.details.outage_since).toBe(new Date(stoppedAt).toISOString());
    const firedAt = new Date(stoppedAt + 60_000);
    expect(outageStart(details, firedAt)).toEqual(new Date(stoppedAt));
  });

  it('does not fire for a container that keeps running', async () => {
    for (let i = 0; i < 5; i++) {
      await report('running');
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fired).not.toHaveBeenCalled();
  });
});
