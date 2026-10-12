import { describe, expect, it } from 'vitest';
import {
  APP_OVERVIEW_ALERT_TONES,
  averageSeries,
  bucketSeries,
  environmentAlerts,
  fillGaps,
  healthySeries,
  OVERVIEW_POINTS,
  restartSeries,
  routeLatency,
  sumSeries,
  throughputOf,
} from './app-overview.service.js';
import { restartCountOf } from './app-workload-sampler.js';

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

  it('is unknown until two readings with a count exist, and a new runtime counts from 0', () => {
    expect(restartSeries([], '1h', now)).toEqual({ total: null, history: [] });
    expect(restartSeries([sample(5, 2)], '1h', now)).toEqual({ total: null, history: [] });
    expect(restartSeries([sample(5, null), sample(4, null)], '1h', now).total).toBe(null);
    expect(restartSeries([sample(5, 4, 'slot-a'), sample(4, 0, 'slot-b')], '1h', now).total).toBe(0);
    expect(restartSeries([sample(5, 4), sample(4, 1)], '1h', now).total).toBe(0);
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

  it('picks the throughput metric the engine reports', () => {
    const points = (metric: string) => (metric === 'instantaneous_ops_per_sec' ? series(7) : []);
    expect(throughputOf({ instantaneous_ops_per_sec: 7 }, points)).toMatchObject({
      transactionsPerSecond: 7,
      throughputUnit: 'ops',
    });
    expect(throughputOf({}, () => [])).toEqual({
      transactionsPerSecond: null,
      transactionsHistory: [],
      throughputUnit: 'tx',
    });
  });
});

describe('app overview alerts', () => {
  it('uses the console Notice tones: destructive for a failing member, warning for disk and 5xx', () => {
    const alerts = environmentAlerts({
      envName: 'production',
      failing: [{ name: 'shop-api', family: 'containers' }],
      disks: [
        { name: 'shop-db', diskPercent: 90 },
        { name: 'shop-s3', diskPercent: 40 },
        { name: 'shop-kv', diskPercent: null },
      ],
      routeRps: 10,
      routeErrors: 1,
    });
    expect(alerts).toEqual([
      { tone: 'destructive', title: 'shop-api is failing', detail: 'containers member of production' },
      { tone: 'warning', title: 'shop-db disk is 90% full', detail: 'Free space or grow the volume' },
      { tone: 'warning', title: '10% of requests fail with 5xx', detail: 'Routes of production' },
    ]);
    for (const alert of alerts) expect(APP_OVERVIEW_ALERT_TONES).toContain(alert.tone);
    expect([...APP_OVERVIEW_ALERT_TONES]).toEqual(['destructive', 'warning']);
  });

  it('raises nothing for a healthy environment', () => {
    const quiet = { envName: 'staging', failing: [], disks: [] };
    expect(environmentAlerts({ ...quiet, routeRps: null, routeErrors: null })).toEqual([]);
    expect(environmentAlerts({ ...quiet, routeRps: 100, routeErrors: 1 })).toEqual([]);
  });
});
