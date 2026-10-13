import { describe, expect, it } from 'vitest';
import { acceptedTokenPrefixes, hasTokenPrefix, TOKEN_PREFIXES } from './token-prefixes.js';

describe('token prefixes', () => {
  it('issues the Opfield prefixes', () => {
    expect(TOKEN_PREFIXES).toEqual({
      api: 'opf_',
      oauthAccess: 'opfo_',
      oauthRefresh: 'opfr_',
      oauthCode: 'opfo_code_',
      inference: 'opfi_',
      logging: 'opfl_',
      pagesDeploy: 'opfp_',
    });
  });

  it.each([
    ['api', 'opf_abc', 'gw_abc'],
    ['oauthAccess', 'opfo_abc', 'gwo_abc'],
    ['oauthRefresh', 'opfr_abc', 'gwr_abc'],
    ['inference', 'opfi_abc', 'gwi_abc'],
    ['logging', 'opfl_abc', 'gwl_abc'],
    ['pagesDeploy', 'opfp_abc', 'gwp_abc'],
  ] as const)('accepts new and pre-2.12.1 %s tokens', (kind, current, legacy) => {
    expect(hasTokenPrefix(current, kind)).toBe(true);
    expect(hasTokenPrefix(legacy, kind)).toBe(true);
    expect(acceptedTokenPrefixes(kind)[0]).toBe(TOKEN_PREFIXES[kind]);
  });

  it('keeps the kinds apart', () => {
    expect(hasTokenPrefix('opfo_abc', 'api')).toBe(false);
    expect(hasTokenPrefix('gwo_abc', 'api')).toBe(false);
    expect(hasTokenPrefix('opf_abc', 'oauthAccess')).toBe(false);
    expect(hasTokenPrefix('gw_node_v2_x', 'oauthAccess')).toBe(false);
    expect(hasTokenPrefix('opfi_abc', 'logging')).toBe(false);
    expect(hasTokenPrefix('', 'api')).toBe(false);
    expect(hasTokenPrefix(undefined, 'api')).toBe(false);
  });
});
