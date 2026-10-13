import { describe, expect, it } from 'vitest';
import {
  APP_OVERVIEW_ALERT_TONES,
  averageSeries,
  bucketSeries,
  databaseCards,
  environmentAlerts,
  fillGaps,
  healthySeries,
  OVERVIEW_POINTS,
  restartSeries,
  restartsSince,
  routeLatency,
  routeTraffic,
  storageCards,
  sumSeries,
  throughputOf,
} from './app-overview.service.js';
import { APP_OVERVIEW_DATABASE_METRICS, APP_OVERVIEW_STORAGE_METRICS } from './app-overview-metrics.js';
import { mergeTrafficReplies, restartCountOf } from './app-workload-sampler.js';

describe('app overview series', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');

  it('buckets samples into 24 points over the range, empty buckets null', () => {
    const series = bucketSeries(
      [
        { at: now - 59 * 60 * 1000, value: 10 },
        { at: now - 58 * 60 * 1000, value: 20 },
        { at: now - 60 * 1000, value: 5 },
      ],
      '1h',
      now
    );
    expect(series).toHaveLength(OVERVIEW_POINTS);
    expect(series[0]).toBe(15);
    expect(series[OVERVIEW_POINTS - 1]).toBe(5);
    expect(series[5]).toBe(null);
  });

  it('leaves unknown series empty and drops samples outside the range', () => {
    expect(bucketSeries([], '24h', now)).toEqual([]);
    expect(bucketSeries([{ at: now - 2 * 60 * 60 * 1000, value: 1 }], '1h', now)).toEqual([]);
  });

  it('sums series element-wise; a gap carries its last value instead of dropping to 0', () => {
    const a = Array.from({ length: OVERVIEW_POINTS }, (_, index) => (index === 0 ? 1 : null));
    const b = Array.from({ length: OVERVIEW_POINTS }, (_, index) => (index === 0 ? 2 : index === 1 ? 3 : null));
    const summed = sumSeries([a, b, []]);
    expect(summed[0]).toBe(3);
    expect(summed[1]).toBe(4);
    expect(summed[OVERVIEW_POINTS - 1]).toBe(4);
    expect(sumSeries([[], []])).toEqual([]);
  });

  it('keeps leading gaps null and never turns a gap into 0', () => {
    expect(fillGaps([null, 5, null, null, 7, null])).toEqual([null, 5, 5, 5, 7, 7]);
    const late = Array.from({ length: OVERVIEW_POINTS }, (_, index) => (index < 10 ? null : 10));
    const early = Array.from({ length: OVERVIEW_POINTS }, (_, index) => (index % 2 === 0 ? 4 : null));
    const summed = sumSeries([late, early]);
    expect(summed.slice(0, 10)).toEqual(Array(10).fill(4));
    expect(summed.slice(10)).toEqual(Array(OVERVIEW_POINTS - 10).fill(14));
    expect(summed).not.toContain(0);
    const averaged = averageSeries([late, early]);
    expect(averaged[0]).toBe(4);
    expect(averaged[11]).toBe(7);
  });

  it('sums per-bucket counts without carrying them', () => {
    const counts = Array.from({ length: OVERVIEW_POINTS }, (_, index) => (index === 3 ? 2 : null));
    const summed = sumSeries([counts], { carry: false });
    expect(summed[3]).toBe(2);
    expect(summed[4]).toBe(null);
  });
});

describe('app overview restarts and health samples', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const minute = 60 * 1000;
  const sample = (minutesAgo: number, restartCount: number | null, runtime = 'shop-api', healthy = true) => ({
    at: now - minutesAgo * minute,
    healthy,
    restartCount,
    runtime,
  });

  it('counts the increase of the restart count over the range and per bucket', () => {
    const { total, history } = restartSeries(
      [sample(50, 3), sample(49, 3), sample(30, 5), sample(29, 5), sample(1, 6)],
      '1h',
      now
    );
    expect(total).toBe(3);
    expect(history).toHaveLength(OVERVIEW_POINTS);
    expect(history.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(3);
    expect(history[OVERVIEW_POINTS - 1]).toBe(1);
    expect(history[0]).toBe(null);
  });

  it('is unknown until a reading with a count exists, then counts from 0; a new runtime counts from 0', () => {
    expect(restartSeries([], '1h', now)).toEqual({ total: null, history: [], since: null });
    const single = restartSeries([sample(5, 2)], '1h', now);
    expect(single.total).toBe(0);
    expect(single.since).toBe(now - 5 * minute);
    expect(single.history).toHaveLength(OVERVIEW_POINTS);
    expect(restartSeries([sample(5, null), sample(4, null)], '1h', now)).toEqual({
      total: null,
      history: [],
      since: null,
    });
    expect(restartSeries([sample(5, null), sample(4, 3)], '1h', now).since).toBe(now - 4 * minute);
    expect(restartSeries([sample(5, 4, 'slot-a'), sample(4, 0, 'slot-b')], '1h', now).total).toBe(0);
    expect(restartSeries([sample(5, 4), sample(4, 1)], '1h', now).total).toBe(0);
  });

  it('says since when restart sampling began until the samples cover the range', () => {
    expect(restartsSince([], '1h', now)).toBe(null);
    expect(restartsSince([null], '1h', now)).toBe(null);
    expect(restartsSince([now - 5 * minute, null, now - 20 * minute], '1h', now)).toBe(
      new Date(now - 20 * minute).toISOString()
    );
    // The sampler keeps 60 one-minute samples: the oldest, 59 minutes back, covers the hour.
    expect(restartsSince([now - 59 * minute], '1h', now)).toBe(null);
    expect(restartsSince([now - 59 * minute], '24h', now)).toBe(new Date(now - 59 * minute).toISOString());
  });

  it('reads the restart count from a container inspect', () => {
    expect(restartCountOf(JSON.stringify({ RestartCount: 2 }))).toBe(2);
    expect(restartCountOf({ RestartCount: 0 })).toBe(0);
    expect(restartCountOf('{}')).toBe(null);
    expect(restartCountOf('not json')).toBe(null);
  });

  it('reports the healthy share per bucket', () => {
    const history = healthySeries(
      [sample(1, 0, 'a', true), sample(1.5, 0, 'a', false), sample(40, 0, 'a', true)],
      '1h',
      now
    );
    expect(history[OVERVIEW_POINTS - 1]).toBe(50);
    expect(history).toContain(100);
    // Minutes stopped on request count neither way.
    const stopped = healthySeries(
      [sample(1, 0, 'a', true), { ...sample(1.5, 0, 'a', false), state: 'stopped' as const }],
      '1h',
      now
    );
    expect(stopped[OVERVIEW_POINTS - 1]).toBe(100);
  });
});

describe('app overview routes latency and database throughput', () => {
  const series = (value: number | null) => Array.from({ length: OVERVIEW_POINTS }, () => value);

  it('uses request latency with traffic, probe latency when idle, and nothing without either', () => {
    const route = {
      requestsPerSecond: 0,
      latencyMs: null,
      latencyHistory: [],
      probeLatencyMs: 40,
      probeLatencyHistory: series(40),
    };
    expect(routeLatency([route, { ...route, probeLatencyMs: 60, probeLatencyHistory: series(60) }])).toMatchObject({
      latencyMs: 50,
      latencySource: 'probe',
    });
    expect(routeLatency([{ ...route, requestsPerSecond: 3, latencyMs: 120, latencyHistory: series(120) }])).toEqual({
      latencyMs: 120,
      latencyHistory: series(120),
      latencySource: 'traffic',
    });
    expect(routeLatency([{ ...route, probeLatencyMs: null, probeLatencyHistory: [] }])).toEqual({
      latencyMs: null,
      latencyHistory: [],
      latencySource: null,
    });
  });

  it('picks the throughput metric of the engine, older key-value samples under transaction_rate', () => {
    const points = (metric: string) => (metric === 'instantaneous_ops_per_sec' ? series(7) : []);
    const latest = (metric: string) => (metric === 'instantaneous_ops_per_sec' ? 7 : null);
    expect(throughputOf('redis', latest, points)).toMatchObject({ transactionsPerSecond: 7, throughputUnit: 'ops' });
    const legacy = (metric: string) => (metric === 'transaction_rate' ? series(3) : []);
    expect(throughputOf('clickhouse', () => null, legacy)).toMatchObject({
      transactionsHistory: series(3),
      throughputUnit: 'q',
    });
    expect(
      throughputOf(
        'postgres',
        () => null,
        () => []
      )
    ).toEqual({
      transactionsPerSecond: null,
      transactionsHistory: [],
      throughputUnit: 'tx',
    });
  });

  it('reads route traffic per second from minute samples, latency in milliseconds', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    const at = now - 60_000;
    const merged = mergeTrafficReplies(
      [
        JSON.stringify({
          hostId: 'r1',
          totalRequests: 120,
          statusCodes: { s5xx: 6 },
          totalBytes: 6000,
          windowSeconds: 60,
          p95ResponseTime: 0.25,
        }),
        JSON.stringify({
          hostId: 'r1',
          totalRequests: 60,
          statusCodes: { s5xx: 0 },
          totalBytes: 0,
          windowSeconds: 60,
          p95ResponseTime: 0.1,
        }),
        JSON.stringify({ hostId: 'other', totalRequests: 999 }),
        null,
      ],
      'r1',
      at
    )!;
    expect(merged).toEqual({ at, requests: 180, errors: 6, bytes: 6000, seconds: 60, p95Ms: 250 });
    expect(mergeTrafficReplies([null], 'r1', at)).toBe(null);
    // A log without upstream times reports 0: no latency, not 0 ms.
    expect(
      mergeTrafficReplies([JSON.stringify({ hostId: 'r1', totalRequests: 5, p95ResponseTime: 0 })], 'r1', at)?.p95Ms
    ).toBe(null);
    const traffic = routeTraffic([merged], '1h', now);
    expect(traffic).toMatchObject({
      requestsPerSecond: 3,
      errorsPerSecond: 0.1,
      trafficBytesPerSecond: 100,
      latencyMs: 250,
    });
    expect(traffic.requestsHistory[OVERVIEW_POINTS - 1]).toBe(3);
    // A stale newest sample is no current rate.
    expect(routeTraffic([{ ...merged, at: now - 10 * 60_000 }], '1h', now).requestsPerSecond).toBe(null);
  });
});

describe('app overview alerts', () => {
  it('uses the console Notice tones: warning for a nearly full disk and 5xx', () => {
    const alerts = environmentAlerts({
      envName: 'production',
      disks: [
        { name: 'shop-db', diskPercent: 90 },
        { name: 'shop-s3', diskPercent: 40 },
        { name: 'shop-kv', diskPercent: null },
      ],
      routeRequests: 100,
      routeErrors: 10,
    });
    expect(alerts).toEqual([
      { tone: 'warning', title: 'shop-db disk is 90% full', detail: 'Free space or grow the volume' },
      { tone: 'warning', title: '10% of requests fail with 5xx', detail: 'Routes of production, last 5 minutes' },
    ]);
    for (const alert of alerts) expect(APP_OVERVIEW_ALERT_TONES).toContain(alert.tone);
    expect([...APP_OVERVIEW_ALERT_TONES]).toEqual(['destructive', 'warning']);
  });

  it('raises nothing for a healthy environment', () => {
    const quiet = { envName: 'staging', disks: [] };
    expect(environmentAlerts({ ...quiet, routeRequests: null, routeErrors: null })).toEqual([]);
    expect(environmentAlerts({ ...quiet, routeRequests: 100, routeErrors: 1 })).toEqual([]);
  });
});

/**
 * The overview reads database and storage metrics from the commercial core's overview series. Every metric a card
 * reads must be in the contract list the core's writer stores (its test compares the lists), or the card stays empty.
 */
describe('app overview metric contract', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const recording = (read: Set<string>) =>
    new Proxy({} as Record<string, number | null>, {
      get: (_target, key) => {
        if (typeof key === 'string') read.add(key);
        return 1;
      },
    });
  const samples = (read: Set<string>) =>
    [2, 1].map((minutes) => ({ timestamp: new Date(now - minutes * 60_000).toISOString(), metrics: recording(read) }));

  it.each(['postgres', 'redis', 'clickhouse'])('reads only contract metrics of a %s database', (type) => {
    const read = new Set<string>();
    databaseCards({ type, manualSizeLimitMb: 100 }, samples(read), '1h', now);
    expect(read.size).toBeGreaterThan(0);
    for (const metric of read) expect(APP_OVERVIEW_DATABASE_METRICS).toContain(metric);
  });

  it('reads only contract metrics of a storage', () => {
    const read = new Set<string>();
    storageCards(samples(read), [], '1h', now);
    for (const metric of read) expect(APP_OVERVIEW_STORAGE_METRICS).toContain(metric);
  });

  it('fills every database card from a sample with the contract metrics', () => {
    const metrics = Object.fromEntries(APP_OVERVIEW_DATABASE_METRICS.map((metric) => [metric, 5]));
    const cards = databaseCards(
      { type: 'postgres', manualSizeLimitMb: 1 },
      [{ timestamp: new Date(now - 60_000).toISOString(), metrics }],
      '1h',
      now
    );
    expect(cards).toMatchObject({ connections: 5, transactionsPerSecond: 5, cacheHitPercent: 5, cpuPercent: 5 });
    for (const series of [cards.diskHistory, cards.connectionsHistory, cards.cacheHitHistory, cards.cpuHistory]) {
      expect(series.at(-1)).toBe(5);
    }
  });
});
