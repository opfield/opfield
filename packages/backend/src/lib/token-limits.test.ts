import { describe, expect, it } from 'vitest';
import {
  canonicalAllowedIp,
  isClientIpAllowed,
  isTokenExpired,
  MAX_TOKEN_ALLOWED_IPS,
  normalizeAllowedIps,
  parseTokenExpiry,
  TokenAllowedIpsSchema,
} from './token-limits.js';

describe('token limits', () => {
  it('stores addresses and ranges in one canonical form', () => {
    expect(canonicalAllowedIp(' 203.0.113.10 ')).toBe('203.0.113.10');
    expect(canonicalAllowedIp('10.0.0.0/08')).toBe('10.0.0.0/8');
    expect(canonicalAllowedIp('2001:DB8::/32')).toBe('2001:db8::/32');
    expect(canonicalAllowedIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    for (const invalid of ['', '198.51.100.300', '10.0.0.0/33', '2001:db8::/129', '1.2.3.4/8/1', 'example.com']) {
      expect(canonicalAllowedIp(invalid)).toBeNull();
    }
  });

  it('drops duplicates and refuses invalid entries or too many', () => {
    expect(normalizeAllowedIps(['10.0.0.1', '10.0.0.1 ', '10.0.0.0/8'])).toEqual(['10.0.0.1', '10.0.0.0/8']);
    expect(() => normalizeAllowedIps(['nope'])).toThrow(/not an IP address/);
    const many = Array.from({ length: MAX_TOKEN_ALLOWED_IPS + 1 }, (_, index) => `10.0.0.${index}`);
    expect(() => normalizeAllowedIps(many)).toThrow(/Up to 20/);
    expect(TokenAllowedIpsSchema.safeParse(many).success).toBe(false);
    expect(TokenAllowedIpsSchema.safeParse(['10.0.0.0/8', '2001:db8::1']).success).toBe(true);
    expect(TokenAllowedIpsSchema.safeParse(['10.0.0.0/40']).success).toBe(false);
  });

  it('matches the client address against single addresses and ranges', () => {
    expect(isClientIpAllowed([], undefined)).toBe(true);
    expect(isClientIpAllowed(['10.0.0.0/8'], '10.200.1.2')).toBe(true);
    expect(isClientIpAllowed(['10.0.0.0/8'], '::ffff:10.200.1.2')).toBe(true);
    expect(isClientIpAllowed(['203.0.113.10'], '203.0.113.11')).toBe(false);
    expect(isClientIpAllowed(['2001:db8::/32'], '2001:db8:1::5')).toBe(true);
    expect(isClientIpAllowed(['2001:db8::/32'], '10.0.0.1')).toBe(false);
    expect(isClientIpAllowed(['10.0.0.0/8'], undefined)).toBe(false);
  });

  it('takes only an expiry in the future', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(parseTokenExpiry(undefined, now)).toBeUndefined();
    expect(parseTokenExpiry(null, now)).toBeNull();
    expect(parseTokenExpiry('2026-10-14T12:00:00Z', now)?.toISOString()).toBe('2026-10-14T12:00:00.000Z');
    expect(() => parseTokenExpiry('2026-10-13T11:59:00Z', now)).toThrow(/future/);
    expect(isTokenExpired(new Date(now.getTime() - 1), now.getTime())).toBe(true);
    expect(isTokenExpired(null, now.getTime())).toBe(false);
  });
});
