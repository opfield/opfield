import type { RelayWitnessHostingLocal } from '@/db/schema/relay.js';

/**
 * Whether a relay may host availability witnesses (a lease voter of a database or storage availability set, a
 * ClickHouse Keeper witness):
 * - allowed: the admin allowed it and its supervisor reports local hosting allowed;
 * - protected_needs_opt_in: the admin allowed it, but the relay is protected and has no local opt-in file;
 * - not_reported: the admin allowed it, but its supervisor has not reported witness hosting (an older relay);
 * - disabled: the admin did not allow it, or the supervisor reports hosting disabled.
 */
export type RelayWitnessHosting = 'allowed' | 'protected_needs_opt_in' | 'not_reported' | 'disabled';

export interface RelayWitnessHostingFields {
  witnessHostingAllowed: boolean;
  witnessHostingLocal: RelayWitnessHostingLocal | string | null;
}

export function relayWitnessHosting(relay: RelayWitnessHostingFields): RelayWitnessHosting {
  if (!relay.witnessHostingAllowed) return 'disabled';
  switch (relay.witnessHostingLocal) {
    case 'allowed':
      return 'allowed';
    case 'protected_needs_opt_in':
      return 'protected_needs_opt_in';
    case null:
      return 'not_reported';
    default:
      return 'disabled';
  }
}

/** A relay that may be picked as a witness: allowed by the admin and locally (decision 7). */
export function relayMayHostWitnesses(relay: RelayWitnessHostingFields): boolean {
  return relayWitnessHosting(relay) === 'allowed';
}

const LOCAL_STATES: ReadonlySet<string> = new Set<RelayWitnessHostingLocal>([
  'allowed',
  'protected_needs_opt_in',
  'disabled',
]);

/** A supervisor-reported local state, or null for a value this build does not know. */
export function parseRelayWitnessHostingLocal(value: unknown): RelayWitnessHostingLocal | null {
  return typeof value === 'string' && LOCAL_STATES.has(value) ? (value as RelayWitnessHostingLocal) : null;
}
