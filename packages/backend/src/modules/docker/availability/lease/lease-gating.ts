import type { DockerAvailabilityLeaseReason } from '@/db/schema/index.js';
import { AVAILABILITY_LEASE_CAPABILITY } from './lease-constants.js';
import type { DockerAvailabilityLeaseExclusionReason } from './lease-types.js';

export interface LeaseGatingInput {
  /** The paid controller runs the lease-mode branch (edition contract). */
  controllerSupportsLease: boolean;
  /** The controller holds this policy on the legacy path. */
  legacyRequested?: boolean;
  policyMode: 'single' | 'replicated' | 'failover';
  /**
   * The source says lease mode is not possible (edition, a hold on the backend path, an explicit close). Checked
   * first; an immediate reason closes at once.
   */
  unavailable?: { code: string; message: string; immediate: boolean } | null;
  /** A policy key can sign lease manifests. */
  signingReady: boolean;
  /** The policy is on the legacy path and would bootstrap lease mode now (stricter than staying in it). */
  entering?: boolean;
  /**
   * Candidate docker nodes: why each is excluded (D3; null when it takes part) and whether it serves right now. A
   * bootstrap reserves the serving nodes, so they must be able to hold before lease mode starts.
   */
  candidates: Array<{ nodeId: string; exclusion: DockerAvailabilityLeaseExclusionReason | null; serving?: boolean }>;
  /** Slots with an observed holder right now. */
  heldSlots?: number;
  /** Ingress nginx node ids of the policy's routes and whether each advertises availability_lease_v2. */
  ingress: Array<{ nodeId: string; capable: boolean }>;
  /**
   * Relay instances carrying the policy's member endpoints and managed-database routes, and whether each is capable.
   * An old relay ignores lease_policy_id and would admit a stale holder (A2.4, A11).
   */
  relays?: Array<{ relayId: string; capable: boolean }>;
  /**
   * The voter selection from members that may vote (D3). viable: at least a quorum of its target size exists.
   * Omitted: treated as viable (callers that only check the other conditions).
   */
  voters?: { viable: boolean; nonVotingCandidateIds: string[] };
  /**
   * Entering only: participants the policy needs (candidates, ingress nginx nodes, carrying relays, witnesses) that
   * have not been fully capable for LEASE_ENTRY_STABLE_MS without a restart (a fleet in the middle of an update).
   */
  unsettled?: { nodeIds: string[]; relayIds: string[] };
  /**
   * The capabilities the reasons name: availability_lease_v2 for Availability, the full list of a policy that needs
   * more (a stateful policy: availability_lease_v3 and its application capability).
   */
  capabilityLabel?: string;
}

export type LeaseGatingResult =
  | { eligible: true }
  | {
      eligible: false;
      reason: DockerAvailabilityLeaseReason;
      /**
       * An explicit request (a lifecycle hold, a disable) closes lease mode at once. Every other reason is a
       * condition that may pass: a lease-mode policy leaves only after it lasted 2 minutes without a break (D3).
       */
      immediate: boolean;
    };

/** Availability reasons the source reports as `unavailable` (edition, legacy hold, disabled). */
export const AVAILABILITY_CONTROLLER_UNSUPPORTED = {
  code: 'controller_unsupported',
  message: 'This Opfield edition runs Availability failover from the backend only',
  immediate: false,
} as const;
export const AVAILABILITY_LEGACY_REQUESTED = {
  code: 'legacy_requested',
  message: 'The Availability controller runs this policy on the backend path',
  immediate: true,
} as const;
export const AVAILABILITY_DISABLED = {
  code: 'availability_disabled',
  message: 'Availability is not enabled',
  immediate: true,
} as const;

/** Exclusions that keep a candidate from holding for a reason of its own (not merely offline to Opfield). */
const CANNOT_HOLD: ReadonlySet<DockerAvailabilityLeaseExclusionReason> = new Set([
  'watchdog_missing',
  'daemon_outdated',
  'identity_pending',
]);

function candidatesReason(
  nodes: Array<{ nodeId: string; exclusion: DockerAvailabilityLeaseExclusionReason | null }>,
  label: string
): DockerAvailabilityLeaseReason {
  const nodeIds = [...new Set(nodes.map(({ nodeId }) => nodeId))].sort();
  if (nodes.every(({ exclusion }) => exclusion === 'watchdog_missing')) {
    return {
      code: 'watchdog_missing',
      message:
        'The lease watchdog is not running on the Docker nodes that would hold this workload, so they cannot hold the lease; start it or re-run the node installer on them',
      nodeIds,
    };
  }
  return {
    code: 'candidates_not_capable',
    message: `The Docker nodes that would hold this workload run a daemon without ${label}, have not reported a lease identity yet, or have no running lease watchdog; update them`,
    nodeIds,
  };
}

/**
 * D10 as amended by D3 (rc.20). Per-node conditions never decide the mode: a candidate that is offline, has no
 * watchdog or runs an outdated daemon is only excluded (the lease view lists it). Lease mode is impossible when:
 * the controller does not run it (edition, license), the policy is disabled or held on legacy, it has no candidates,
 * no candidate can hold and no slot is held, an ingress nginx node or a carrying relay lacks availability_lease_v2,
 * fewer members that may vote exist than a quorum needs, or no key signs manifests. Entering lease mode additionally
 * needs every serving node to be able to hold, because the bootstrap reserves them, and every participant to have
 * been fully capable for 2 minutes without a restart, so a fleet in the middle of an update never enters it.
 */
export function evaluateLeaseGating(input: LeaseGatingInput): LeaseGatingResult {
  const label = input.capabilityLabel ?? AVAILABILITY_LEASE_CAPABILITY;
  if (input.unavailable) {
    return {
      eligible: false,
      immediate: input.unavailable.immediate,
      reason: { code: input.unavailable.code, message: input.unavailable.message },
    };
  }
  if (!input.controllerSupportsLease) {
    return { eligible: false, immediate: false, reason: reasonOf(AVAILABILITY_CONTROLLER_UNSUPPORTED) };
  }
  if (input.legacyRequested) {
    return { eligible: false, immediate: true, reason: reasonOf(AVAILABILITY_LEGACY_REQUESTED) };
  }
  if (input.policyMode === 'single') {
    return { eligible: false, immediate: true, reason: reasonOf(AVAILABILITY_DISABLED) };
  }
  if (input.candidates.length === 0) {
    return {
      eligible: false,
      immediate: false,
      reason: { code: 'no_candidates', message: 'The policy has no candidate placements yet' },
    };
  }
  if (input.entering) {
    const blocked = input.candidates.filter(
      (candidate) => candidate.serving && candidate.exclusion && CANNOT_HOLD.has(candidate.exclusion)
    );
    if (blocked.length > 0) return { eligible: false, immediate: false, reason: candidatesReason(blocked, label) };
  }
  const unable = input.candidates.filter((candidate) => candidate.exclusion && CANNOT_HOLD.has(candidate.exclusion));
  if (unable.length === input.candidates.length && (input.heldSlots ?? 0) === 0) {
    // HA-11: a node that loses its lease watchdog stops renewing and kills the copy it holds; once no slot is held,
    // no copy runs and none can start in lease mode, so waiting out the 2 minutes only prolongs the outage. The close
    // still waits for the voters to confirm it before the backend starts a copy, so two copies never run.
    const watchdogsMissing = unable.every(({ exclusion }) => exclusion === 'watchdog_missing');
    return { eligible: false, immediate: watchdogsMissing, reason: candidatesReason(unable, label) };
  }
  const incapableIngress = input.ingress.filter((node) => !node.capable).map(({ nodeId }) => nodeId);
  if (incapableIngress.length > 0) {
    return {
      eligible: false,
      immediate: false,
      reason: {
        code: 'ingress_not_capable',
        message: `Some Nginx nodes that route to this workload run a daemon without ${label} (data-plane failover); update them`,
        nodeIds: [...new Set(incapableIngress)].sort(),
      },
    };
  }
  const incapableRelays = (input.relays ?? []).filter((relay) => !relay.capable).map(({ relayId }) => relayId);
  if (incapableRelays.length > 0) {
    return {
      eligible: false,
      immediate: false,
      reason: {
        code: 'relays_not_capable',
        message: `Some relays that carry this workload run a version without ${label} (the lease data-path gate); update them before data-plane failover can run`,
        relayIds: [...new Set(incapableRelays)].sort(),
      },
    };
  }
  if (input.voters && !input.voters.viable) {
    return {
      eligible: false,
      immediate: false,
      reason: {
        code: 'insufficient_voters',
        message: `Fewer members that can vote (Docker nodes and relays with ${label} and a lease identity) exist than a quorum needs; update the candidate nodes or add a relay as witness`,
        nodeIds: [...new Set(input.voters.nonVotingCandidateIds)].sort(),
      },
    };
  }
  if (!input.signingReady) {
    return {
      eligible: false,
      immediate: false,
      reason: {
        code: 'signing_key_pending',
        message: 'No relay policy signing key can sign lease manifests yet',
      },
    };
  }
  const unsettled = input.unsettled;
  if (input.entering && unsettled && unsettled.nodeIds.length + unsettled.relayIds.length > 0) {
    return {
      eligible: false,
      immediate: false,
      reason: {
        code: 'participants_settling',
        message: `Data-plane failover starts once every node and relay of this workload has run ${label} (with its lease watchdog and identity) for 2 minutes without a restart`,
        ...(unsettled.nodeIds.length > 0 ? { nodeIds: [...new Set(unsettled.nodeIds)].sort() } : {}),
        ...(unsettled.relayIds.length > 0 ? { relayIds: [...new Set(unsettled.relayIds)].sort() } : {}),
      },
    };
  }
  return { eligible: true };
}

function reasonOf(reason: { code: string; message: string }): DockerAvailabilityLeaseReason {
  return { code: reason.code, message: reason.message };
}

/** D7: standbys are fixed at min(2, candidates - slots); a created-but-not-started standby costs only disk. */
export function availabilityStandbyCount(candidateNodes: number, slots: number): number {
  return Math.max(0, Math.min(2, candidateNodes - slots));
}
