import { describe, expect, it } from 'vitest';
import { GRANT_AUDIENCE_OPFIELD_CAPABILITY, relayGrantAudience } from './relay-grant-signing.js';

describe('relay grant audience', () => {
  it('uses opfield-relay only when every relay of the pool accepts it', () => {
    expect(relayGrantAudience([[GRANT_AUDIENCE_OPFIELD_CAPABILITY], ['x', GRANT_AUDIENCE_OPFIELD_CAPABILITY]])).toBe(
      'opfield-relay'
    );
  });

  it('keeps wiolett-relay for a mixed pool, a relay without capabilities, or no relay at all', () => {
    expect(relayGrantAudience([[GRANT_AUDIENCE_OPFIELD_CAPABILITY], []])).toBe('wiolett-relay');
    expect(relayGrantAudience([[GRANT_AUDIENCE_OPFIELD_CAPABILITY], null])).toBe('wiolett-relay');
    expect(relayGrantAudience([])).toBe('wiolett-relay');
  });
});
