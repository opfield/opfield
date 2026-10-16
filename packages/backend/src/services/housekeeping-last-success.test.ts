import { describe, expect, it } from 'vitest';
import { type HousekeepingRunResult, isHousekeepingStale, repairedLastSuccess } from './housekeeping.service.js';

function run(startedAt: string, completedAt: string, safetyOk = true): HousekeepingRunResult {
  return {
    startedAt,
    completedAt,
    trigger: 'scheduled',
    totalDurationMs: 1000,
    overallSuccess: safetyOk,
    categories: [
      { category: 'Operation History', success: safetyOk, itemsCleaned: 0, durationMs: 10 },
      { category: 'Docker Images', success: true, itemsCleaned: 0, durationMs: 10 },
    ],
  } as HousekeepingRunResult;
}

describe('Housekeeping last success (rc.2 X-O-17)', () => {
  it('replaces the update time migration 0260 stored with the last successful run of the history', () => {
    const history = [
      run('2026-10-16T02:00:00.000Z', '2026-10-16T02:00:41.000Z'),
      run('2026-10-15T02:00:00.000Z', '2026-10-15T02:00:39.000Z'),
    ];
    expect(repairedLastSuccess('2026-10-16T19:23:28.120Z', history)).toEqual({
      changed: true,
      lastSuccessAt: '2026-10-16T02:00:41.000Z',
    });
  });

  it('names no success when no run of the history kept the data bounded', () => {
    const history = [run('2026-10-16T02:00:00.000Z', '2026-10-16T02:00:41.000Z', false)];
    expect(repairedLastSuccess('2026-10-16T19:23:28.120Z', history)).toEqual({ changed: true, lastSuccessAt: null });
    expect(repairedLastSuccess('2026-10-16T19:23:28.120Z', [])).toEqual({ changed: true, lastSuccessAt: null });
  });

  it('keeps a success a run of the history finished at, or one older than every run it still keeps', () => {
    const history = [run('2026-10-16T02:00:00.000Z', '2026-10-16T02:00:41.000Z')];
    expect(repairedLastSuccess('2026-10-16T02:00:41.000Z', history)).toEqual({
      changed: false,
      lastSuccessAt: '2026-10-16T02:00:41.000Z',
    });
    expect(repairedLastSuccess('2026-10-01T02:00:41.000Z', history)).toEqual({
      changed: false,
      lastSuccessAt: '2026-10-01T02:00:41.000Z',
    });
  });

  it('counts staleness from the baseline when no run succeeded', () => {
    const now = Date.parse('2026-10-20T00:00:00.000Z');
    expect(isHousekeepingStale('2026-10-16T19:23:28.120Z', now)).toBe(true);
    expect(isHousekeepingStale(null, now)).toBe(false);
  });
});
