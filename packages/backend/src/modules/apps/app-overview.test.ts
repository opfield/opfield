import { describe, expect, it } from 'vitest';
import {
  APP_OVERVIEW_ALERT_TONES,
  bucketSeries,
  environmentAlerts,
  OVERVIEW_POINTS,
  sumSeries,
} from './app-overview.service.js';

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

  it('sums series element-wise, ignoring gaps', () => {
    const a = Array.from({ length: OVERVIEW_POINTS }, (_, index) => (index === 0 ? 1 : null));
    const b = Array.from({ length: OVERVIEW_POINTS }, (_, index) => (index === 0 ? 2 : index === 1 ? 3 : null));
    const summed = sumSeries([a, b, []]);
    expect(summed[0]).toBe(3);
    expect(summed[1]).toBe(3);
    expect(summed[2]).toBe(null);
    expect(sumSeries([[], []])).toEqual([]);
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
