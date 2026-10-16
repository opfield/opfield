import { describe, expect, it } from 'vitest';
import { retryAfterSecondsFromDetails } from './inference-retry-after.js';

describe('Retry-After from error details', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');

  it('counts the seconds until recoveryAt, at least one', () => {
    expect(retryAfterSecondsFromDetails({ recoveryAt: '2026-10-17T13:00:00.500Z' }, now)).toBe(3601);
    expect(retryAfterSecondsFromDetails({ recoveryAt: '2026-10-17T11:00:00Z' }, now)).toBe(1);
  });

  it('prefers an explicit retryAfterSeconds and ignores anything else', () => {
    expect(retryAfterSecondsFromDetails({ retryAfterSeconds: 30, recoveryAt: '2026-10-17T13:00:00Z' }, now)).toBe(30);
    expect(retryAfterSecondsFromDetails({ recoveryAt: 'soon' }, now)).toBeUndefined();
    expect(retryAfterSecondsFromDetails(undefined, now)).toBeUndefined();
  });
});
