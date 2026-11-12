import { describe, expect, it } from 'vitest';
import { ProxyHostListQuerySchema } from '@/modules/proxy/proxy.schemas.js';
import { queryFlag } from './query-flag.js';

describe('boolean query parameters', () => {
  it('reads false as false', () => {
    expect(queryFlag('false')).toBe(false);
    expect(queryFlag('0')).toBe(false);
    expect(queryFlag('true')).toBe(true);
    expect(queryFlag('1')).toBe(true);
    expect(queryFlag(undefined)).toBeUndefined();
    expect(queryFlag('')).toBeUndefined();
    expect(ProxyHostListQuerySchema.parse({ enabled: 'false' }).enabled).toBe(false);
  });

  it('reads what other languages print for a boolean', () => {
    expect(ProxyHostListQuerySchema.parse({ enabled: 'True' }).enabled).toBe(true);
    expect(ProxyHostListQuerySchema.parse({ enabled: 'FALSE' }).enabled).toBe(false);
  });

  it('refuses a value it cannot read instead of taking it for false', () => {
    expect(ProxyHostListQuerySchema.safeParse({ enabled: 'yes' }).success).toBe(false);
    expect(ProxyHostListQuerySchema.parse({ excludeAppMembers: 'yes' }).excludeAppMembers).toBe(false);
  });
});
