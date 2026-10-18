import { describe, expect, it } from 'vitest';
import { beginPlannedPortChange, endPlannedPortChange, inPlannedPortChange } from './relay-planned-port-changes.js';

describe('Planned relay port changes', () => {
  it('marks a relay only while its port change runs', () => {
    expect(inPlannedPortChange('relay-1')).toBe(false);
    beginPlannedPortChange('relay-1');
    expect(inPlannedPortChange('relay-1')).toBe(true);
    expect(inPlannedPortChange('relay-2')).toBe(false);
    endPlannedPortChange('relay-1');
    expect(inPlannedPortChange('relay-1')).toBe(false);
  });
});
