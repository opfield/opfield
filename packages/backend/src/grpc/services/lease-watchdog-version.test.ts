import { describe, expect, it } from 'vitest';
import { leaseWatchdogVersion } from './lease-watchdog-version.js';

describe('leaseWatchdogVersion', () => {
  it('keeps a reported version', () => {
    expect(leaseWatchdogVersion({ leaseWatchdogVersion: 'v2.12.1-rc.3' })).toEqual({
      leaseWatchdogVersion: 'v2.12.1-rc.3',
    });
    expect(leaseWatchdogVersion({ leaseWatchdogVersion: ' 2.12.1 ' })).toEqual({ leaseWatchdogVersion: '2.12.1' });
  });

  it('leaves the field out when the daemon reports none or something else', () => {
    expect(leaseWatchdogVersion({})).toEqual({});
    expect(leaseWatchdogVersion(null)).toEqual({});
    expect(leaseWatchdogVersion({ leaseWatchdogVersion: '' })).toEqual({});
    expect(leaseWatchdogVersion({ leaseWatchdogVersion: 42 })).toEqual({});
    expect(leaseWatchdogVersion({ leaseWatchdogVersion: '<script>' })).toEqual({});
  });
});
