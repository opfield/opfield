import { describe, expect, it } from 'vitest';
import { availabilityMemberHealth } from './app-availability-overview.js';
import {
  combineHealth,
  composeHealth,
  containerHealth,
  deploymentHealth,
  healthFromStatus,
  withAvailabilityState,
} from './app-health.service.js';

describe('app health aggregation', () => {
  it('combines member states: failing beats degraded beats healthy, empty is healthy', () => {
    expect(combineHealth([])).toBe('healthy');
    expect(combineHealth(['healthy', 'none'])).toBe('healthy');
    expect(combineHealth(['healthy', 'degraded'])).toBe('degraded');
    expect(combineHealth(['degraded', 'failing', 'healthy'])).toBe('failing');
  });

  it.each([
    ['online', 'healthy'],
    ['degraded', 'degraded'],
    ['offline', 'failing'],
    ['unknown', 'none'],
    ['disabled', 'none'],
  ] as const)('route/database/storage %s -> %s', (status, health) => {
    expect(healthFromStatus(status)).toBe(health);
  });

  it.each([
    ['running', null, 'healthy'],
    ['running', 'offline', 'failing'],
    ['running', 'degraded', 'degraded'],
    ['restarting', null, 'degraded'],
    ['exited', null, 'failing'],
    [null, null, 'failing'],
  ] as const)('container %s with check %s -> %s', (state, check, health) => {
    expect(containerHealth(state, check)).toBe(health);
  });

  it('maps deployments and Compose projects', () => {
    expect(deploymentHealth('ready', null)).toBe('healthy');
    expect(deploymentHealth('ready', 'offline')).toBe('failing');
    expect(deploymentHealth('deploying', null)).toBe('degraded');
    expect(deploymentHealth('stopped', null)).toBe('failing');
    expect(composeHealth('running')).toBe('healthy');
    expect(composeHealth('degraded')).toBe('degraded');
    expect(composeHealth('stopped')).toBe('failing');
  });

  it('maps an availability set: degraded or no failover is degraded, never down while the primary answers', () => {
    expect(withAvailabilityState('healthy', null)).toBe('healthy');
    expect(withAvailabilityState('healthy', 'healthy')).toBe('healthy');
    expect(withAvailabilityState('healthy', 'degraded')).toBe('degraded');
    expect(withAvailabilityState('healthy', 'no_failover')).toBe('degraded');
    expect(withAvailabilityState('failing', 'failing_over')).toBe('degraded');
    expect(withAvailabilityState('failing', 'no_failover')).toBe('failing');
    expect(withAvailabilityState('none', 'degraded')).toBe('none');
  });

  it('reads each set member as healthy, degraded, down or stopped', () => {
    const now = 1_800_000_000_000;
    const seen = new Date(now - 5_000);
    const member = (role: string, eligible: boolean, lastReportedAt: Date | null = seen, stopped = false) => ({
      role,
      eligible,
      lastReportedAt,
      enginePosition: stopped ? { 'runtime.stopped': 'true' } : {},
    });
    expect(availabilityMemberHealth(member('primary', false), true, now)).toBe('healthy');
    expect(availabilityMemberHealth(member('copy', true), false, now)).toBe('healthy');
    expect(availabilityMemberHealth(member('copy', false), false, now)).toBe('degraded');
    expect(availabilityMemberHealth(member('rebuilding', false), false, now)).toBe('degraded');
    expect(availabilityMemberHealth(member('copy', true, new Date(now - 120_000)), false, now)).toBe('down');
    expect(availabilityMemberHealth(member('fenced', false), false, now)).toBe('down');
    expect(availabilityMemberHealth(member('copy', false, seen, true), false, now)).toBe('stopped');
  });
});
