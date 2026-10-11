import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_FAILOVER_SHOWN_MS,
  type AvailabilitySetFacts,
  availabilityAttention,
  availabilityAttentionSeverity,
} from './managed-availability-attention.js';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const healthy: AvailabilitySetFacts = {
  mode: 'automatic',
  state: 'healthy',
  stateReason: null,
  primaryLastReportedAt: null,
  lastFailoverAt: null,
};

describe('Dashboard attention of databases and storage on several servers', () => {
  it('leaves healthy sets and sets turning on or off alone', () => {
    expect(availabilityAttention(healthy, NOW)).toBeNull();
    expect(availabilityAttention({ ...healthy, mode: 'manual', state: 'converting' }, NOW)).toBeNull();
  });

  it('names the most urgent reason', () => {
    expect(
      availabilityAttention(
        { ...healthy, state: 'no_failover', stateReason: { code: 'no_eligible_copy', message: 'No copy is eligible' } },
        NOW
      )
    ).toMatchObject({ reason: 'no_failover', message: 'No copy is eligible' });
    expect(
      availabilityAttention(
        {
          ...healthy,
          state: 'degraded',
          stateReason: {
            code: 'member_offline',
            message: '1 member(s) do not report',
            reasons: [
              { code: 'member_offline', message: '1 member(s) do not report' },
              { code: 'witness_offline', message: 'Witness r1 does not respond' },
            ],
          },
        },
        NOW
      )
    ).toMatchObject({ reason: 'witness_lost', message: 'Witness r1 does not respond' });
    expect(
      availabilityAttention({ ...healthy, state: 'degraded', stateReason: { code: 'copy_not_streaming' } }, NOW)
    ).toMatchObject({
      reason: 'degraded',
    });
  });

  it('shows a manual pair whose primary stopped reporting, and a failover for a day', () => {
    const pair = { ...healthy, mode: 'manual', primaryLastReportedAt: new Date(NOW - 10_000) };
    expect(availabilityAttention(pair, NOW)).toBeNull();
    expect(availabilityAttention({ ...pair, primaryLastReportedAt: new Date(NOW - 60_000) }, NOW)).toMatchObject({
      reason: 'primary_unreachable',
    });
    expect(availabilityAttention({ ...healthy, lastFailoverAt: new Date(NOW - 60_000) }, NOW)).toMatchObject({
      reason: 'failover',
      since: new Date(NOW - 60_000).toISOString(),
    });
    expect(
      availabilityAttention({ ...healthy, lastFailoverAt: new Date(NOW - AVAILABILITY_FAILOVER_SHOWN_MS - 1) }, NOW)
    ).toBeNull();
  });

  it('is critical when a set cannot fail over or a pair lost its primary', () => {
    const item = { kind: 'database' as const, id: 'c', slug: 's', name: 'n', message: null, since: null };
    expect(availabilityAttentionSeverity([{ ...item, reason: 'witness_lost' }])).toBe('warning');
    expect(
      availabilityAttentionSeverity([
        { ...item, reason: 'failover' },
        { ...item, reason: 'no_failover' },
      ])
    ).toBe('critical');
    expect(availabilityAttentionSeverity([{ ...item, reason: 'primary_unreachable' }])).toBe('critical');
  });
});
