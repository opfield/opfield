import { describe, expect, it } from 'vitest';
import { bucketSeries, OVERVIEW_POINTS, sumSeries } from './app-overview.service.js';

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
