import type {
  DockerAvailabilityLeaseBallot,
  DockerAvailabilityLeaseBootstrapSlot,
  DockerAvailabilityLeaseObservationSource,
  DockerAvailabilityLeasePlannedHandoff,
  DockerAvailabilityPlacementDesiredState,
} from '@/db/schema/index.js';
import { compareLeaseBallots } from './lease-codec.js';
import { ACTIVE_LEASE_ROLES, HOLDING_LEASE_ROLES } from './lease-constants.js';

export interface LeasePlanningPlacement {
  id: string;
  nodeId: string;
  desiredState: DockerAvailabilityPlacementDesiredState;
  serving: boolean;
  createdAt: Date;
}

/** Placements that take part in the lease: every placement the controller keeps, serving or standby. */
export function leaseCandidatePlacements<T extends LeasePlanningPlacement>(placements: T[]): T[] {
  return placements.filter((placement) => ['serving', 'standby', 'draining'].includes(placement.desiredState));
}

/**
 * Deterministic takeover order (D4, D5): priority mode follows nodePriority; otherwise serving placements come first,
 * then standbys, oldest first. The data plane never chooses freely.
 */
export function orderLeaseCandidates(
  policy: { priorityMode: boolean; nodePriority: string[] },
  placements: LeasePlanningPlacement[]
): string[] {
  const stateRank = (placement: LeasePlanningPlacement) =>
    placement.serving || placement.desiredState === 'serving' ? 0 : placement.desiredState === 'standby' ? 1 : 2;
  const priorityRank = (placement: LeasePlanningPlacement) => {
    if (!policy.priorityMode) return 0;
    const index = policy.nodePriority.indexOf(placement.nodeId);
    return index < 0 ? policy.nodePriority.length : index;
  };
  const ordered = [...leaseCandidatePlacements(placements)].sort(
    (left, right) =>
      priorityRank(left) - priorityRank(right) ||
      stateRank(left) - stateRank(right) ||
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.nodeId.localeCompare(right.nodeId)
  );
  return [...new Set(ordered.map((placement) => placement.nodeId))];
}

/** A5: the first manifest reserves each slot for a placement that serves right now, oldest first. */
export function bootstrapFromServing(
  placements: LeasePlanningPlacement[],
  slots: number
): DockerAvailabilityLeaseBootstrapSlot[] {
  return placements
    .filter((placement) => placement.serving)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .slice(0, slots)
    .map((placement, slot) => ({ slot, holderId: placement.nodeId }));
}

/** A7: switching available -> strict reserves every slot for the holder observed now. */
export function bootstrapFromHolders(
  holders: Array<{ slot: number; holderId: string | null }>,
  slots: number
): DockerAvailabilityLeaseBootstrapSlot[] {
  return holders
    .filter((holder): holder is { slot: number; holderId: string } => holder.holderId !== null && holder.slot < slots)
    .sort((left, right) => left.slot - right.slot)
    .map(({ slot, holderId }) => ({ slot, holderId }));
}

export interface LeaseObservationState {
  holderId: string | null;
  ballot: DockerAvailabilityLeaseBallot | null;
  epoch: number;
  manifestVersion: number;
  source: DockerAvailabilityLeaseObservationSource;
  sourceId: string;
  observedAt: Date;
  holderSince: Date | null;
  lastHolderId: string | null;
  claimants: Record<string, { role: string; observedAt: string }>;
  /** Stateful keys: "sha256:<hex>" of the state certified by the stored ballot, when a relay reported it. */
  stateHash?: string | null;
}

export interface LeaseObservationCandidate {
  holderId: string;
  ballot: DockerAvailabilityLeaseBallot;
  epoch: number;
  manifestVersion: number;
  source: DockerAvailabilityLeaseObservationSource;
  sourceId: string;
  /**
   * When the reporter saw this holder take the key: a voter's first commit of the holder, or the holder's own
   * acquisition time (N-5, B-14). Absent when the reporter does not know.
   */
  since?: Date | null;
  /** `since` is the holder's own acquisition time (its daemon knows it exactly), not a voter's sighting (B-14). */
  exact?: boolean;
  /**
   * `since` starts the holding and a daemon restart that kept the copy running does not move it (such a daemon reports
   * a recovered key's time as unknown): a later one than recorded is a new holding of the same node (M-5).
   */
  holdingStart?: boolean;
  /** Stateful keys (v3 relay views): the certified state hash of this ballot's commit. */
  stateHash?: string | null;
}

/** Where a takeover time came from: the holder itself, the earliest voter sighting, or when Opfield noticed it. */
export type LeaseTakeoverSource = 'holder' | 'voters' | 'noticed';

/**
 * M-5: a holder's own acquisition time this much later than the recorded start of its holding is a new holding: the
 * slot lapsed (a fence, the node stopped) and the same node acquired it again. Below it is clock jitter between
 * reports; a lapse and a fresh acquisition take longer than that.
 */
export const LEASE_REACQUIRE_MIN_GAP_MS = 5_000;

export interface LeaseHolderChange {
  from: string | null;
  to: string;
  /** The same node took the slot again after it lapsed (M-5): a new holding, audited as such. */
  reacquired?: boolean;
  ballot: DockerAvailabilityLeaseBallot | null;
  /** The takeover time: the holder's own, the earliest voter sighting, or when Opfield noticed it. */
  holderSince?: Date;
  takeoverSource?: LeaseTakeoverSource;
  /** When the previous holder was last seen holding: no voter sighting of the takeover can be earlier. */
  takeoverNotBefore?: Date | null;
}

/**
 * The holder's own acquisition time among the reports, if one carries it (B-14): exact, whichever voter reports
 * first. Never in the future.
 */
export function leaseExactHolderSince(
  holderId: string,
  candidates: LeaseObservationCandidate[],
  now: Date
): Date | null {
  const exact = candidates
    .filter((candidate) => candidate.holderId === holderId && candidate.exact && candidate.since instanceof Date)
    .map((candidate) => candidate.since!.getTime())
    .filter((time) => Number.isFinite(time) && time <= now.getTime());
  return exact.length > 0 ? new Date(Math.min(...exact)) : null;
}

/** M-5: the holder's own start of its current holding, from a daemon whose time a restart never moves. */
function leaseHoldingStart(holderId: string, candidates: LeaseObservationCandidate[], now: Date): Date | null {
  return leaseExactHolderSince(
    holderId,
    candidates.filter((candidate) => candidate.holdingStart),
    now
  );
}

/**
 * N-5 / B-14: the takeover time of a new holder, not when Opfield noticed it (after an autonomous failover while
 * Opfield was down that can be minutes later). The holder's own acquisition time wins. Otherwise a voter sighting is an
 * upper bound (a voter cannot see the commit before it happened, but may see it late), so the earliest one counts; it
 * is never before the previous holder was last seen holding, nor in the future.
 */
export function leaseTakeover(
  holderId: string,
  candidates: LeaseObservationCandidate[],
  bounds: { notBefore: Date | null; now: Date }
): { at: Date; source: LeaseTakeoverSource } {
  const exact = leaseExactHolderSince(holderId, candidates, bounds.now);
  if (exact) return { at: exact, source: 'holder' };
  const reported = candidates
    .filter((candidate) => candidate.holderId === holderId && !candidate.exact && candidate.since instanceof Date)
    .map((candidate) => candidate.since!.getTime())
    .filter((time) => Number.isFinite(time) && time <= bounds.now.getTime());
  if (reported.length === 0) return { at: bounds.now, source: 'noticed' };
  const earliest = Math.min(...reported);
  const floor = bounds.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY;
  return { at: new Date(Math.max(earliest, floor)), source: 'voters' };
}

export function leaseTakeoverTime(
  holderId: string,
  candidates: LeaseObservationCandidate[],
  bounds: { notBefore: Date | null; now: Date }
): Date {
  return leaseTakeover(holderId, candidates, bounds).at;
}

/**
 * Folds one report into the stored holder of a key. A strictly higher ballot names the holder; the same ballot only
 * refreshes it; a daemon that held the key and now reports another role (or omits the key) released or fenced. A
 * released key is never brought back by a report of the ballot it released.
 */
export function mergeLeaseObservation(
  stored: LeaseObservationState | null,
  input: {
    candidates: LeaseObservationCandidate[];
    /** Set for daemon reports: the reporter and its role for this key, null when the key is absent. */
    reporter?: { id: string; role: string | null };
    now: Date;
  }
): { next: LeaseObservationState; change: LeaseHolderChange | null } {
  const now = input.now;
  // Any report of the winning ballot that carries its certified state hash (relays report it, daemons do not).
  const stateHashOf = (winner: LeaseObservationCandidate): string | null =>
    input.candidates.find(
      (candidate) =>
        candidate.stateHash &&
        candidate.holderId === winner.holderId &&
        compareLeaseBallots(candidate.ballot, winner.ballot) === 0
    )?.stateHash ?? null;
  const next: LeaseObservationState = stored
    ? { ...stored, claimants: { ...stored.claimants } }
    : {
        holderId: null,
        ballot: null,
        epoch: 0,
        manifestVersion: 0,
        source: input.candidates[0]?.source ?? 'daemon',
        sourceId: input.candidates[0]?.sourceId ?? input.reporter?.id ?? '',
        observedAt: now,
        holderSince: null,
        lastHolderId: null,
        claimants: {},
      };
  const reporter = input.reporter;
  if (reporter) {
    if (reporter.role && ACTIVE_LEASE_ROLES.has(reporter.role)) {
      next.claimants[reporter.id] = { role: reporter.role, observedAt: now.toISOString() };
    } else {
      delete next.claimants[reporter.id];
    }
    if (next.holderId === reporter.id && !(reporter.role && HOLDING_LEASE_ROLES.has(reporter.role))) {
      next.holderId = null;
      next.holderSince = null;
      next.observedAt = now;
      next.source = 'daemon';
      next.sourceId = reporter.id;
    }
  }
  const best = input.candidates.reduce<LeaseObservationCandidate | null>(
    (winner, candidate) => (!winner || compareLeaseBallots(candidate.ballot, winner.ballot) > 0 ? candidate : winner),
    null
  );
  const previousHolder = stored?.holderId ?? null;
  const lastKnown = previousHolder ?? stored?.lastHolderId ?? null;
  // The previous holder was last seen holding when it was last observed; a takeover cannot be earlier.
  const previousSeenAt = stored?.holderId ? stored.observedAt : null;
  // When Opfield saw the last holder stop holding (a fence, a release), while the key has no holder since.
  const lapsedAt = !previousHolder && lastKnown && stored ? stored.observedAt : null;
  let takeoverSource: LeaseTakeoverSource | undefined;
  let reacquired = false;
  if (best) {
    const order = compareLeaseBallots(best.ballot, next.ballot);
    if (order > 0) {
      if (next.holderId !== best.holderId && best.holderId === lastKnown && lapsedAt) {
        // M-5: the node Opfield saw stop holding holds the key again. A new holding when a time proves it started after
        // that report: the node's own start, or a voter's first commit of it. A voter's sighting from before may date
        // from the holding that lapsed (stand run rc20pre2 d kept 15:10:04 for a re-acquisition at 15:37:06), and a
        // daemon that restarted reports its key before it recovered it, so without such a time nothing is audited and
        // the node's own start, once reported, decides below.
        const after = lapsedAt.getTime() - LEASE_REACQUIRE_MIN_GAP_MS;
        const started = leaseHoldingStart(best.holderId, input.candidates, now);
        const takeover = leaseTakeover(best.holderId, input.candidates, { notBefore: null, now });
        if (started && started.getTime() >= after) {
          reacquired = true;
          next.holderSince = started;
          takeoverSource = 'holder';
        } else if (takeover.source === 'voters' && takeover.at.getTime() >= after) {
          reacquired = true;
          next.holderSince = takeover.at;
          takeoverSource = 'voters';
        } else {
          next.holderSince = takeover.source === 'noticed' ? lapsedAt : takeover.at;
          takeoverSource = takeover.source;
        }
      } else if (next.holderId !== best.holderId) {
        const takeover = leaseTakeover(best.holderId, input.candidates, { notBefore: previousSeenAt, now });
        next.holderSince = takeover.at;
        takeoverSource = takeover.source;
      }
      next.holderId = best.holderId;
      next.ballot = best.ballot;
      next.epoch = best.epoch;
      next.manifestVersion = best.manifestVersion;
      next.source = best.source;
      next.sourceId = best.sourceId;
      next.observedAt = now;
      if (next.stateHash !== undefined || stateHashOf(best)) next.stateHash = stateHashOf(best);
    } else if (order === 0 && next.holderId === best.holderId && next.holderId !== null) {
      next.epoch = Math.max(next.epoch, best.epoch);
      next.manifestVersion = Math.max(next.manifestVersion, best.manifestVersion);
      next.observedAt = now;
      next.stateHash = stateHashOf(best) ?? next.stateHash;
    }
  }
  // B-14: the same holder's own acquisition time corrects a takeover time first taken from a voter that saw it late
  // (one that restarted after the takeover) or from when Opfield noticed it. M-5: recorded times of one holding are
  // never earlier than its acquisition, so a later acquisition is a new holding: the key lapsed and the same node took
  // it again while Opfield was away or between two reports.
  if (next.holderId && next.holderId === previousHolder) {
    const exact = leaseExactHolderSince(next.holderId, input.candidates, now);
    const started = leaseHoldingStart(next.holderId, input.candidates, now);
    if (started && next.holderSince && started.getTime() - next.holderSince.getTime() > LEASE_REACQUIRE_MIN_GAP_MS) {
      reacquired = true;
      takeoverSource = 'holder';
    }
    if (exact && exact.getTime() !== next.holderSince?.getTime()) next.holderSince = exact;
  }
  if (next.holderId) next.lastHolderId = next.holderId;
  const change =
    next.holderId && (reacquired || (next.holderId !== previousHolder && next.holderId !== lastKnown))
      ? {
          from: reacquired ? next.holderId : lastKnown,
          to: next.holderId,
          ballot: next.ballot,
          holderSince: next.holderSince ?? now,
          takeoverSource: takeoverSource ?? 'noticed',
          takeoverNotBefore:
            reacquired && lapsedAt ? new Date(lapsedAt.getTime() - LEASE_REACQUIRE_MIN_GAP_MS) : previousSeenAt,
          ...(reacquired ? { reacquired: true } : {}),
        }
      : null;
  return { next, change };
}

export type LeaseHolderChangeKind = 'failover' | 'handoff' | 'reacquired';

/**
 * D9 audit: a holder change the backend planned (a handoff command, or a release that named the new holder as its
 * designated successor) is a handoff; any other change of holder is an autonomous failover. The first holder of a key
 * is neither.
 */
export function classifyLeaseHolderChange(
  change: LeaseHolderChange,
  slot: number,
  planned: DockerAvailabilityLeasePlannedHandoff[],
  handoffSuccessors: ReadonlySet<string>,
  now: Date
): LeaseHolderChangeKind | null {
  if (!change.from) return null;
  if (change.reacquired) return 'reacquired';
  const plannedMatch = planned.some(
    (handoff) =>
      handoff.slot === slot &&
      handoff.toHolderId === change.to &&
      (handoff.fromHolderId === null || handoff.fromHolderId === change.from) &&
      Date.parse(handoff.expiresAt) > now.getTime()
  );
  return plannedMatch || handoffSuccessors.has(change.to) ? 'handoff' : 'failover';
}

/**
 * A5 / A7: a bootstrap is acked once every reserved holder holds its key under a committed ballot and no other daemon
 * reports a role in which its copy may still run.
 */
export function bootstrapAcknowledged(
  bootstrap: DockerAvailabilityLeaseBootstrapSlot[],
  observations: Map<number, Pick<LeaseObservationState, 'holderId' | 'claimants'>>
): boolean {
  return bootstrap.every((entry) => {
    const observation = observations.get(entry.slot);
    if (!observation || observation.holderId !== entry.holderId) return false;
    return Object.keys(observation.claimants).every((claimant) => claimant === entry.holderId);
  });
}
