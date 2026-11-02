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
});
