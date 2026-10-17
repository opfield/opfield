import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { userWindowState } from './inference-usage.service.js';

// Stand rc.3 O-B: a user override that turned on a 5-hour window the default turns off was accepted
// silently and never limited the user.
describe('user credit windows against the default policy', () => {
  const off = { credits5hEnabled: false, credits7dEnabled: false, credits30dEnabled: true };

  it('reports which windows apply and warns about one the default turns off', () => {
    const state = userWindowState({ credits5hEnabled: true, credits7dEnabled: false, credits30dEnabled: true }, off);
    expect(state.effectiveWindows).toEqual({
      credits5hEnabled: false,
      credits7dEnabled: false,
      credits30dEnabled: true,
    });
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toContain('5-hour window is off in the default limits');
    expect(state.warnings[0]).toContain('credits5hEnabled: true');
  });

  it('has no warning when every enabled window applies', () => {
    expect(
      userWindowState({ credits5hEnabled: false, credits7dEnabled: false, credits30dEnabled: true }, off).warnings
    ).toEqual([]);
    expect(
      userWindowState({ credits5hEnabled: true, credits7dEnabled: true, credits30dEnabled: true }, undefined).warnings
    ).toEqual([]);
  });
});
