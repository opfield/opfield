import { describe, expect, it } from 'vitest';
import {
  CONTAINER_STATS_MINUTE_MAX,
  CONTAINER_STATS_MINUTE_TTL,
  containerMinutePoint,
  NodeMonitoringService,
  recordContainerMinuteSample,
  rollContainerMinute,
} from './node-monitoring.service.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

/** In-memory stand-in for the few Redis calls the minute series makes. */
function fakeRedis() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();
  const client = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    multi() {
      const ops: Array<() => void> = [];
      const tx = {
        lpush(key: string, value: string) {
          ops.push(() => lists.set(key, [value, ...(lists.get(key) ?? [])]));
          return tx;
        },
        ltrim(key: string, start: number, stop: number) {
          ops.push(() => lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1)));
          return tx;
        },
        expire(key: string, seconds: number) {
          ops.push(() => ttls.set(key, seconds));
          return tx;
        },
        set(key: string, value: string, _mode: 'EX', seconds: number) {
          ops.push(() => {
            values.set(key, value);
            ttls.set(key, seconds);
          });
          return tx;
        },
        async exec() {
          for (const op of ops) op();
          return [];
        },
      };
      return tx;
    },
  };
  return { client, values, lists, ttls };
}

describe('container minute series', () => {
  it('averages CPU and memory within a minute and keeps the last counters', () => {
    let state = rollContainerMinute(
      null,
      { cpuPercent: 10, memoryUsageBytes: 100, networkRxBytes: 5, pids: 3 },
      T0 + 1_000
    );
    expect(state.finished).toBeNull();
    state = rollContainerMinute(
      state.next,
      { cpu_percent: 30, memory_usage_bytes: 300, network_rx_bytes: 9, pids: 4 },
      T0 + 30_000
    );
    expect(state.finished).toBeNull();
    const point = containerMinutePoint(state.next);
    expect(point).toMatchObject({
      timestamp: T0,
      samples: 2,
      cpuPercent: 20,
      memoryUsageBytes: 200,
      memoryLastBytes: 300,
      networkRxBytes: 9,
      pids: 4,
    });
  });

  it('closes the minute when a sample of the next minute arrives', () => {
    const first = rollContainerMinute(null, { cpuPercent: 50 }, T0 + 59_000);
    const second = rollContainerMinute(first.next, { cpuPercent: 10 }, T0 + MINUTE + 1_000);
    expect(second.finished?.minute).toBe(T0);
    expect(second.next).toMatchObject({ minute: T0 + MINUTE, samples: 1, cpuSum: 10 });
  });

  it('writes one point per finished minute, trims to the hour and refreshes TTLs', async () => {
    const redis = fakeRedis();
    for (let minute = 0; minute < 80; minute += 1) {
      for (const offset of [5_000, 35_000]) {
        await recordContainerMinuteSample(
          redis.client,
          'c1',
          { cpuPercent: minute, memoryUsageBytes: 1 },
          T0 + minute * MINUTE + offset
        );
      }
    }
    const list = redis.lists.get('container-stats-1m:c1') ?? [];
    expect(list).toHaveLength(CONTAINER_STATS_MINUTE_MAX);
    // Newest finished minute first: minute 78 (79 is still in progress).
    expect(JSON.parse(list[0])).toMatchObject({ timestamp: T0 + 78 * MINUTE, cpuPercent: 78, samples: 2 });
    expect(JSON.parse(list.at(-1)!)).toMatchObject({ timestamp: T0 + (79 - CONTAINER_STATS_MINUTE_MAX) * MINUTE });
    expect(JSON.parse(redis.values.get('container-stats-1m-current:c1')!)).toMatchObject({ minute: T0 + 79 * MINUTE });
    expect(redis.ttls.get('container-stats-1m:c1')).toBe(CONTAINER_STATS_MINUTE_TTL);
    expect(redis.ttls.get('container-stats-1m-current:c1')).toBe(CONTAINER_STATS_MINUTE_TTL);
  });

  it('pushes nothing while the minute does not change', async () => {
    const redis = fakeRedis();
    await recordContainerMinuteSample(redis.client, 'c2', { cpuPercent: 1 }, T0 + 1_000);
    await recordContainerMinuteSample(redis.client, 'c2', { cpuPercent: 3 }, T0 + 20_000);
    expect(redis.lists.get('container-stats-1m:c2')).toBeUndefined();
    expect(JSON.parse(redis.values.get('container-stats-1m-current:c2')!)).toMatchObject({ samples: 2, cpuSum: 4 });
  });

  it('reads the hour oldest first with the minute in progress last', async () => {
    const redis = fakeRedis();
    for (let minute = 0; minute < 70; minute += 1) {
      await recordContainerMinuteSample(redis.client, 'c3', { cpuPercent: minute }, T0 + minute * MINUTE + 1_000);
    }
    const client = {
      ...redis.client,
      async lrange(key: string) {
        return redis.lists.get(key) ?? [];
      },
    };
    const service = new NodeMonitoringService({} as never, { getClient: () => client } as never);
    try {
      const points = await service.getContainerStatsHourHistory('c3', T0 + 69 * MINUTE + 2_000);
      expect(points.at(-1)).toMatchObject({ timestamp: T0 + 69 * MINUTE, cpuPercent: 69 });
      expect(points.map((point) => point.timestamp)).toEqual(
        [...points.map((point) => point.timestamp)].sort((a, b) => Number(a) - Number(b))
      );
      expect(points.length).toBeGreaterThanOrEqual(61);
    } finally {
      service.destroy();
    }
  });
});
