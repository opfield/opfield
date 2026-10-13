import { describe, expect, it } from 'vitest';
import {
  createNodeEnrollmentToken,
  isNodeEnrollmentTokenExpired,
  NODE_ENROLLMENT_TOKEN_TTL_MS,
  nodeEnrollmentTokenExpiresAt,
  parseNodeEnrollmentToken,
} from './node-enrollment-token.js';

describe('node enrollment token helpers', () => {
  it('creates parseable v2 tokens with a selector', () => {
    const enrollmentToken = createNodeEnrollmentToken();

    expect(enrollmentToken.token).toMatch(/^opf_node_v2_[0-9a-f]{16}_[0-9a-f]{48}$/);
    expect(parseNodeEnrollmentToken(enrollmentToken.token)).toEqual({
      kind: 'v2',
      selector: enrollmentToken.selector,
    });
  });

  it('still parses unused v2 tokens issued before 2.12.1', () => {
    const selector = '0123456789abcdef';
    expect(parseNodeEnrollmentToken(`gw_node_v2_${selector}_${'b'.repeat(48)}`)).toEqual({ kind: 'v2', selector });
  });

  it('keeps pre-v2 node tokens in the legacy path', () => {
    expect(parseNodeEnrollmentToken(`gw_node_${'a'.repeat(48)}`)).toEqual({ kind: 'legacy' });
  });

  it('rejects malformed v2 tokens instead of falling back to a scan', () => {
    expect(parseNodeEnrollmentToken('opf_node_v2_short_secret')).toEqual({ kind: 'invalid' });
    expect(parseNodeEnrollmentToken('gw_node_v2_short_secret')).toEqual({ kind: 'invalid' });
  });

  it('rejects malformed legacy-like tokens instead of falling back to a scan', () => {
    expect(parseNodeEnrollmentToken('gw_node_nothex')).toEqual({ kind: 'invalid' });
  });

  it('expires tokens after the default TTL and keeps legacy tokens without expiry valid', () => {
    const now = new Date('2026-09-23T00:00:00.000Z');
    const expiresAt = nodeEnrollmentTokenExpiresAt(now);

    expect(expiresAt.getTime() - now.getTime()).toBe(NODE_ENROLLMENT_TOKEN_TTL_MS);
    expect(NODE_ENROLLMENT_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(isNodeEnrollmentTokenExpired(expiresAt, now)).toBe(false);
    expect(isNodeEnrollmentTokenExpired(expiresAt, new Date(expiresAt.getTime()))).toBe(true);
    expect(isNodeEnrollmentTokenExpired(null, now)).toBe(false);
  });
});
