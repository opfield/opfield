import { describe, expect, it } from 'vitest';
import {
  ALERT_FIRST_ISSUANCE_AFTER_MS,
  failureAlertLevel,
  isRenewalDue,
  isValidConsoleDomain,
  MAX_CHECK_INTERVAL_MS,
  nextCheckDelayMs,
  ORDER_RETRY_MAX_MS,
  orderRetryDelayMs,
  PROBE_RETRY_MAX_MS,
  probeRetryDelayMs,
  renewalDueAt,
  resolveDirectoryOverride,
  shouldOrder,
  UNPROBED_ORDER_INTERVAL_MS,
} from './console-tls-policy.js';

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-10-12T00:00:00Z');
const at = (days: number) => new Date(start.getTime() + days * DAY);
const ninetyDays = { notBefore: start, notAfter: at(90) };

describe('console certificate renewal schedule', () => {
  it('renews a 90-day certificate with 30 days left', () => {
    expect(renewalDueAt(ninetyDays)).toEqual(at(60));
    expect(isRenewalDue(ninetyDays, at(59.9))).toBe(false);
    expect(isRenewalDue(ninetyDays, at(60))).toBe(true);
  });

  it('renews a short-lived certificate with a third of its lifetime left', () => {
    const fortyFive = { notBefore: start, notAfter: at(45) };
    expect(renewalDueAt(fortyFive)).toEqual(at(30));
    const sixDays = { notBefore: start, notAfter: at(6) };
    expect(renewalDueAt(sixDays)).toEqual(at(4));
  });

  it('checks again at the renewal time, never more than six hours away, and at once when due', () => {
    expect(nextCheckDelayMs(ninetyDays, at(1))).toBe(MAX_CHECK_INTERVAL_MS);
    expect(nextCheckDelayMs(ninetyDays, new Date(at(60).getTime() - 60_000))).toBe(60_000);
    expect(nextCheckDelayMs(ninetyDays, at(70))).toBe(0);
  });

  it('backs failed orders off from two minutes to at most three hours', () => {
    expect(orderRetryDelayMs(1)).toBe(2 * 60 * 1000);
    expect(orderRetryDelayMs(2)).toBe(4 * 60 * 1000);
    expect(orderRetryDelayMs(5)).toBe(32 * 60 * 1000);
    expect(orderRetryDelayMs(50)).toBe(ORDER_RETRY_MAX_MS);
  });

  it('probes a domain that does not reach the host yet every 15 s up to every 2 min', () => {
    expect(probeRetryDelayMs(1)).toBe(15_000);
    expect(probeRetryDelayMs(3)).toBe(60_000);
    expect(probeRetryDelayMs(100)).toBe(PROBE_RETRY_MAX_MS);
  });
});

describe('ordering decision', () => {
  it('orders when the domain reaches the challenge listener, but not inside a backoff', () => {
    expect(shouldOrder({ now: at(0), probeReachable: true, lastOrderAt: at(0), nextOrderAllowedAt: null })).toBe(true);
    expect(shouldOrder({ now: at(0), probeReachable: true, lastOrderAt: null, nextOrderAllowedAt: at(1) })).toBe(false);
  });

  it('still orders without a reachable probe the first time and every 30 minutes (no hairpin NAT)', () => {
    expect(shouldOrder({ now: at(0), probeReachable: false, lastOrderAt: null, nextOrderAllowedAt: null })).toBe(true);
    const recent = new Date(start.getTime() - UNPROBED_ORDER_INTERVAL_MS + 1);
    expect(shouldOrder({ now: start, probeReachable: false, lastOrderAt: recent, nextOrderAllowedAt: null })).toBe(
      false
    );
    const old = new Date(start.getTime() - UNPROBED_ORDER_INTERVAL_MS);
    expect(shouldOrder({ now: start, probeReachable: false, lastOrderAt: old, nextOrderAllowedAt: null })).toBe(true);
  });
});

describe('failure alerts', () => {
  it('alerts on a failing renewal from 14 days left, critical from 7', () => {
    expect(failureAlertLevel({ now: at(70), certificate: ninetyDays, failingSince: at(60) })).toBeNull();
    expect(failureAlertLevel({ now: at(76), certificate: ninetyDays, failingSince: at(60) })).toBe('warning');
    expect(failureAlertLevel({ now: at(83), certificate: ninetyDays, failingSince: at(60) })).toBe('critical');
  });

  it('alerts when no certificate could be obtained for six hours', () => {
    const since = start;
    const early = new Date(start.getTime() + ALERT_FIRST_ISSUANCE_AFTER_MS - 1);
    const late = new Date(start.getTime() + ALERT_FIRST_ISSUANCE_AFTER_MS);
    expect(failureAlertLevel({ now: early, certificate: null, failingSince: since })).toBeNull();
    expect(failureAlertLevel({ now: late, certificate: null, failingSince: since })).toBe('warning');
  });
});

describe('configuration', () => {
  it('accepts plain DNS names only', () => {
    expect(isValidConsoleDomain('acme.opfield.cloud')).toBe(true);
    expect(isValidConsoleDomain('a-1.example.com')).toBe(true);
    for (const bad of ['localhost', '*.example.com', '10.0.0.1', 'example.com:443', '-a.example.com', 'a..b', '']) {
      expect(isValidConsoleDomain(bad)).toBe(false);
    }
  });

  it('reads the ACME directory override', () => {
    expect(resolveDirectoryOverride(undefined)).toEqual({ staging: false });
    expect(resolveDirectoryOverride('staging')).toEqual({ staging: true });
    expect(resolveDirectoryOverride('https://pebble:14000/dir')).toEqual({
      staging: false,
      directoryUrl: 'https://pebble:14000/dir',
    });
    expect(() => resolveDirectoryOverride('ftp://x')).toThrow();
  });
});
