import { describe, expect, it } from 'vitest';
import { isGatedProbeRefusal } from './relay-pool-errors.js';

describe('A source probe the relay refused after it authorized the path', () => {
  it('counts as verified for the lease gate, a dormant member, admission pressure and session limits', () => {
    for (const message of [
      '9 FAILED_PRECONDITION: availability lease gate closed',
      '14 UNAVAILABLE: target endpoint is dormant',
      // Stand 2.12 N-1: a relay under pressure refused every probe of a staged generation.
      '8 RESOURCE_EXHAUSTED: relay adaptive admission rejected proxy tunnel: database_reserve',
      'rpc error: code = ResourceExhausted desc = relay adaptive admission rejected registry tunnel: hard_pressure',
      '8 RESOURCE_EXHAUSTED: relay route session capacity reached',
      '8 RESOURCE_EXHAUSTED: relay endpoint session capacity reached',
    ]) {
      expect(isGatedProbeRefusal(new Error(message))).toBe(true);
    }
  });

  it('fails the probe for a refusal before that', () => {
    for (const message of [
      '9 FAILED_PRECONDITION: availability lease gate closed: lease coordination is not running',
      '14 UNAVAILABLE: target endpoint is not registered',
      '7 PERMISSION_DENIED: connect grant route was revoked',
      '8 RESOURCE_EXHAUSTED: relay adaptive admission rejected proxy tunnel: unknown_traffic_class',
      '8 RESOURCE_EXHAUSTED: Received message larger than max',
    ]) {
      expect(isGatedProbeRefusal(new Error(message))).toBe(false);
    }
  });
});
