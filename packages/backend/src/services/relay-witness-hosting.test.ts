import { describe, expect, it } from 'vitest';
import { parseRelayWitnessHostingLocal, relayMayHostWitnesses, relayWitnessHosting } from './relay-witness-hosting.js';

describe('relay witness hosting', () => {
  it('needs the admin flag and the relay reporting local hosting allowed', () => {
    const cases: Array<[boolean, string | null, string, boolean]> = [
      [false, null, 'disabled', false],
      [false, 'allowed', 'disabled', false],
      [true, null, 'not_reported', false],
      [true, 'allowed', 'allowed', true],
      [true, 'protected_needs_opt_in', 'protected_needs_opt_in', false],
      [true, 'disabled', 'disabled', false],
      [true, 'something-new', 'disabled', false],
    ];
    for (const [witnessHostingAllowed, witnessHostingLocal, hosting, may] of cases) {
      const relay = { witnessHostingAllowed, witnessHostingLocal };
      expect(relayWitnessHosting(relay)).toBe(hosting);
      expect(relayMayHostWitnesses(relay)).toBe(may);
    }
  });

  it('keeps only the local states this build knows', () => {
    expect(parseRelayWitnessHostingLocal('allowed')).toBe('allowed');
    expect(parseRelayWitnessHostingLocal('protected_needs_opt_in')).toBe('protected_needs_opt_in');
    expect(parseRelayWitnessHostingLocal('disabled')).toBe('disabled');
    expect(parseRelayWitnessHostingLocal('maybe')).toBeNull();
    expect(parseRelayWitnessHostingLocal(undefined)).toBeNull();
  });
});
