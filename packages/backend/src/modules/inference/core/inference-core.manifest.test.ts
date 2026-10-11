import { describe, expect, it } from 'vitest';
import {
  compareOpenCodexVersions,
  OPENCODEX_RELEASE_TAG_RE,
  OPENCODEX_VERSION_RE,
  parseOpenCodexVersion,
} from './inference-core.manifest.js';

describe('core release lines', () => {
  it('accepts the wiolett, thesqlabs and opfield lines', () => {
    for (const tag of ['v2.25.0-wiolett.27', 'v2.60.6-thesqlabs.6', 'v2.61.0-opfield.1']) {
      expect(OPENCODEX_RELEASE_TAG_RE.test(tag)).toBe(true);
      expect(OPENCODEX_VERSION_RE.test(tag.slice(1))).toBe(true);
      expect(parseOpenCodexVersion(tag)).not.toBeNull();
    }
    expect(OPENCODEX_RELEASE_TAG_RE.test('v2.61.0-other.1')).toBe(false);
    expect(OPENCODEX_RELEASE_TAG_RE.test('v2.61.0-opfield')).toBe(false);
  });

  it('orders across the switch to the opfield line', () => {
    expect(compareOpenCodexVersions('2.61.0-opfield.1', '2.60.6-thesqlabs.6')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('v2.60.6-thesqlabs.6', 'v2.61.0-opfield.1')).toBeLessThan(0);
    // On the same base a later line wins whatever the build numbers.
    expect(compareOpenCodexVersions('2.60.0-opfield.1', '2.60.0-thesqlabs.9')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('2.60.0-thesqlabs.1', '2.60.0-wiolett.40')).toBeGreaterThan(0);
    expect(compareOpenCodexVersions('2.60.0-opfield.2', '2.60.0-opfield.10')).toBeLessThan(0);
    expect(compareOpenCodexVersions('2.61.0-opfield.3', 'v2.61.0-opfield.3')).toBe(0);
  });
});
