/**
 * Availability data-plane lease constants. The protocol timing is fixed in daemon-shared/availabilitylease
 * (timing.go, D5 amended by A1/A3); the values here only mirror what the Gateway needs to wait for.
 */

/**
 * Capability every lease participant (docker daemon, nginx daemon, relay) of this release advertises, and the one the
 * Gateway requires (D3 of the rc.20 fixes): peer-time freeze detection, release after a confirmed fence and the other
 * lease timing fixes only exist from v2 on. A participant that advertises only availability_lease_v1 is outdated.
 */
export const AVAILABILITY_LEASE_CAPABILITY = 'availability_lease_v2';

/**
 * v3 (S10): certified holder state. Every participant of a stateful lease policy (candidates, voters, relay members,
 * carrying relays) must advertise it; stateless policies keep running on v2 participants.
 */
export const AVAILABILITY_LEASE_V3_CAPABILITY = 'availability_lease_v3';

/** Storage-profile docker daemons that run the member runtime of database and storage availability sets. */
export const MANAGED_AVAILABILITY_MEMBER_CAPABILITY = 'managed_availability_member_v1';

/** Node types whose docker daemon runs the storage profile (managed databases and storage, availability members). */
export const STORAGE_PROFILE_NODE_TYPES = ['storage', 'databases'] as const;

export function isStorageProfileNodeType(type: string): boolean {
  return (STORAGE_PROFILE_NODE_TYPES as readonly string[]).includes(type);
}

/** The first lease protocol capability (rc.18/rc.19). Same wire protocol; counted as outdated. */
export const AVAILABILITY_LEASE_V1_CAPABILITY = 'availability_lease_v1';

/**
 * Every capability that means "speaks the lease wire protocol". Outdated participants keep receiving manifests, lease
 * lanes, dormant members and handoff requests: a holder that runs an old daemon must still see a closed manifest and
 * hand its slot over.
 */
export const AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES: readonly string[] = [
  AVAILABILITY_LEASE_CAPABILITY,
  AVAILABILITY_LEASE_V1_CAPABILITY,
];

/** Whether a capability list or set names any lease protocol version. */
export function advertisesLeaseProtocol(capabilities: Iterable<string>): boolean {
  for (const capability of capabilities) {
    if (AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES.includes(capability)) return true;
  }
  return false;
}

/**
 * A docker daemon that has no lease watchdog and cannot install one itself (it runs without root, or the host has no
 * service manager) advertises this marker; the node installer must be re-run on it.
 */
export const AVAILABILITY_LEASE_WATCHDOG_MISSING_CAPABILITY = 'availability_lease_watchdog_missing_v1';

/** Acceptor lease T. Manifests restate it; it is not configurable. */
export const LEASE_TERM_MS = 30_000;

/** An acceptor refuses other proposers for T x 1.1 after its last accept (D5). */
export const ACCEPTOR_HOLD_MS = (LEASE_TERM_MS * 11) / 10;

/** ACCEPTOR_HOLD_MS measured by a clock running 10% fast, rounded up (A1). */
const DRIFTED_ACCEPTOR_HOLD_MS = Math.ceil((ACCEPTOR_HOLD_MS * 10) / 9);

/**
 * A joint epoch settles only after both majorities persisted it, every active lease renewed under it, and at least
 * T x 1.1 / 0.9 (about 37 s) passed since those acks (A16): the time bound keeps settlement safe even when the
 * Gateway's view of active leases is incomplete.
 */
export const EPOCH_SETTLE_MS = DRIFTED_ACCEPTOR_HOLD_MS + 2_000;

/**
 * Relay gate window (A15): a relay admits a holder for at most this long after its own promise. A bootstrap, and a
 * switch from available to strict, completes only once every other copy stopped and this window passed (A16).
 */
export const GATE_WINDOW_MS = 24_000;

/** Upper bound for a holder's graceful stop after it fenced (D5: min(stop timeout, 10 s) then kill). */
const FENCE_STOP_MARGIN_MS = 10_000;

/**
 * Closing a lease (A5): once a voter majority persisted the lease-closed manifest, no renewal can succeed, so every
 * holder has fenced within T x 1.1 plus its stop margin.
 */
export const CLOSE_SETTLE_MS = DRIFTED_ACCEPTOR_HOLD_MS + FENCE_STOP_MARGIN_MS;

/** At most this many daemons vote besides the relays (D2). */
export const MAX_DAEMON_VOTERS = 12;

/** A member whose last lease report is older than this does not count as reachable. */
export const MEMBER_REPORT_FRESH_MS = 90_000;

/** A relay's list of connected members counts this long; the local relay's health is probed every 5 s. */
export const RELAY_CONNECTIONS_FRESH_MS = 15_000;

/** A candidate whose daemon has been offline this long stops being a voter; the next choice replaces it. */
export const VOTER_OFFLINE_REPLACE_MS = 10 * 60_000;

/**
 * D3: a policy leaves lease mode only after lease mode stayed impossible this long without a break, and a per-node
 * condition (an outdated daemon, a missing identity) changes a policy's voters or manifest candidates only after it
 * lasted this long. Short conditions (a daemon or watchdog restart, a rolling update) never flip anything.
 */
export const LEASE_IMPOSSIBLE_HYSTERESIS_MS = 2 * 60_000;

/**
 * A legacy policy enters lease mode only after every participant it needs (candidate docker nodes, ingress nginx
 * nodes, carrying relays, witnesses) has been fully capable this long without a break and without a restart, so a
 * fleet in the middle of a rolling update (Gateway first, then the nodes one by one) never enters lease mode.
 */
export const LEASE_ENTRY_STABLE_MS = 2 * 60_000;

/** A planned handoff classifies the next holder change as a handoff for this long (D9). */
export const PLANNED_HANDOFF_TTL_MS = 5 * 60_000;

/** Rotation links kept in the published chain: with its first key the chain spans the 8 keys a node keeps. */
export const MAX_KEY_ROTATION_LINKS = 7;

/** A daemon that has not confirmed the current distribution revision gets it again after this long. */
export const DAEMON_SYNC_RETRY_MS = 30_000;

/**
 * Daemon roles (availabilitylease.Role) in which the daemon's copy of the workload may run. A key whose claimants
 * include anyone but the reserved holder is not bootstrapped yet.
 */
export const ACTIVE_LEASE_ROLES: ReadonlySet<string> = new Set([
  'bootstrapping',
  'recovering',
  'holding',
  'fencing',
  'abandoned',
  'releasing',
  'retained',
]);

/**
 * Graceful close: the role of a slot's named holder once a majority of every quorum set of the closed manifest
 * confirmed the close to it (gateway.v1 AvailabilityLeaseHeld.retained). Its copy keeps running without a lease.
 */
export const RETAINED_LEASE_ROLE = 'retained';

/** Roles in which a daemon holds a committed lease (or, retained, keeps serving after the close) and may serve. */
export const HOLDING_LEASE_ROLES: ReadonlySet<string> = new Set(['holding', 'recovering', RETAINED_LEASE_ROLE]);

/** Cluster row id of the singleton voter config. */
export const LEASE_CLUSTER_ID = 'default';
