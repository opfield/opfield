/**
 * How a staged Relay Pool generation treats what went wrong while it was prepared.
 *
 * - A gated refusal is a verified source probe. The relay checks the grant's signature, its route and its
 *   endpoint before it asks the Availability lease whether traffic may pass, so a refusal by the lease gate (or by
 *   the dormant registration of a standby member) proves every part of the path the probe exists to verify. Whether
 *   the workload behind the endpoint serves is decided by the lease at run time and never by placement: a standby
 *   member refuses every probe until a takeover, and failing its placement for that would keep the pool degraded for
 *   as long as it stands by. A relay without lease coordination is the exception: it can never admit lease traffic.
 *   A refusal for the relay's admission pressure or a session limit is decided later still, after the target's
 *   registration: it proves the path as well, and a load that passes by itself must not fail the placement (stand 2.12
 *   N-1).
 * - A transient condition proves nothing about the placement either: the daemon was busy, a node or the local relay
 *   was briefly unreachable, or an Opfield restart interrupted the preparation. Such a generation is rolled back as
 *   not attempted and retried shortly, instead of being recorded as a failure.
 * - Everything else (a relay that refuses the grant, a missing candidate grant, a source that cannot reach the relay)
 *   is a genuine failure and stays visible.
 */

export function relayPoolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GATED_REFUSAL =
  /availability lease gate closed|target endpoint is dormant|relay adaptive admission rejected \w+ tunnel: (hard_pressure|database_reserve|fair_share)|relay (route|endpoint) session capacity reached/i;
const LEASE_COORDINATION_MISSING = /lease gate closed: lease coordination is not running/i;

/** A source probe refused only after the relay authorized its path: the Availability lease gate, pressure, a limit. */
export function isGatedProbeRefusal(error: unknown): boolean {
  const message = relayPoolErrorMessage(error);
  return GATED_REFUSAL.test(message) && !LEASE_COORDINATION_MISSING.test(message);
}

/** A command the daemon never ran: every handler slot was taken, or the node was not connected. Retried at once. */
const DISPATCH_REFUSED = [
  /daemon is busy handling long-running commands/i,
  /command expired while waiting for a free handler slot/i,
  /\bNode \S+ is not connected\b/,
  /^Node disconnected$/,
  /^Failed to send command\b/,
];

/** Transient, but already slow to surface: retried by a later attempt rather than within the preparation. */
const TRANSIENT_LATER = [
  // Opfield's command deadline; the daemon did not answer in time.
  /^Command \S+ timed out after \d+ms$/,
  // Opfield's own gRPC channel to the local relay while it restarts (grpc-js status 14).
  /\b14 UNAVAILABLE\b/,
  /Channel has been shut down/i,
  // The local relay has not applied the policy revision the grants were signed for yet.
  /Relay policy revision \d+ has not been durably acknowledged/i,
  /Rebalance preparation was interrupted/i,
];

/** A condition that passes by itself; see the module comment. */
export function isTransientRelayPoolError(error: unknown): boolean {
  const message = relayPoolErrorMessage(error);
  return [...DISPATCH_REFUSED, ...TRANSIENT_LATER].some((pattern) => pattern.test(message));
}

/** A transient condition worth retrying within the same preparation, after a short pause. */
export function isRetryableDispatchError(error: unknown): boolean {
  const message = relayPoolErrorMessage(error);
  return DISPATCH_REFUSED.some((pattern) => pattern.test(message));
}
