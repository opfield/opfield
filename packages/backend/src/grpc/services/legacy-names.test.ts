import { describe, expect, it } from 'vitest';
import { legacyNameCounts, legacyNameTotal } from './legacy-names.js';

describe('legacy name counts from a daemon health report', () => {
  it('keeps positive whole counts by kind', () => {
    expect(legacyNameCounts({ containers: 3, networks: '2', paths: 0, units: -1, 'bad kind': 4, labels: 1.5 })).toEqual(
      {
        containers: 3,
        networks: 2,
      }
    );
  });

  it('reports none for older daemons and empty maps', () => {
    expect(legacyNameCounts(undefined)).toBeNull();
    expect(legacyNameCounts({})).toBeNull();
    expect(legacyNameCounts([1])).toBeNull();
    expect(legacyNameTotal(null)).toBe(0);
    expect(legacyNameTotal({ containers: 3, paths: 2 })).toBe(5);
  });
});
