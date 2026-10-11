import { and, eq, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AvailabilityLeaseMemberKind,
  availabilityLeaseMembers,
  type DockerAvailabilityLeaseObservationSource,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  leasePolicies,
} from '@/db/schema/index.js';
import type { AvailabilityLeaseKeyView, AvailabilityLeaseReport } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { compareLeaseBallots, normalizeLeaseBallot } from './lease-codec.js';
import { HOLDING_LEASE_ROLES, RETAINED_LEASE_ROLE } from './lease-constants.js';
import {
  classifyLeaseHolderChange,
  type LeaseObservationCandidate,
  type LeaseObservationState,
  mergeLeaseObservation,
} from './lease-planning.js';
import type { LeaseHolderChangeNotice } from './lease-policy-source.js';
import { pendingLeaseTakeover, persistPendingLeaseTakeover } from './lease-takeover-audit.js';

const logger = createChildLogger('AvailabilityLeaseReports');

export type { LeaseHolderChangeNotice };

/**
 * "sha256:<hex>" of the certified state a v3 relay reports for a stateful key's commit (AvailabilityLeaseKeyView
 * committed_state_hash); null for stateless keys and older relays.
 */
function committedStateHash(view: AvailabilityLeaseKeyView): string | null {
  const value = (view as { committedStateHash?: unknown }).committedStateHash;
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}

/** Every holder report of a key in one lease report, for settling a takeover time noticed earlier (B-14). */
export interface LeaseTakeoverSighting {
  policyId: string;
  slot: number;
  candidates: LeaseObservationCandidate[];
}

export interface LeaseReportSender {
  memberId: string;
  kind: AvailabilityLeaseMemberKind;
  nodeId: string | null;
  relayInstanceId: string | null;
}

function toNumber(value: string | number | undefined | null): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function keyOf(policyId: string, slot: number): string {
  return `${policyId}/${slot}`;
}

/** A reported wall-clock time in Unix ms (int64 as a string or number); null when absent or zero. */
function reportedTime(value: string | number | undefined | null): Date | null {
  const ms = Number(value ?? 0);
  return Number.isSafeInteger(ms) && ms > 0 ? new Date(ms) : null;
}

/**
 * A running voter hears the holder at least every renewal (5 s). One that first stores a new holder's commit within
 * three renewals of its own start may be catching up on a takeover that happened while it was down (stand run rc20
 * B-14: the local relay, restarted with Gateway, reported its first sighting 86 s after the takeover).
 */
export const LEASE_VOTER_RESTART_GRACE_MS = 15_000;

/**
 * When the reporter started: incarnations are raised to the start's wall clock in ms (A3, IncarnationFloor). Null for
 * a value that is not such a timestamp.
 */
function reporterStartedAt(incarnation: string | number | undefined | null): Date | null {
  const started = reportedTime(incarnation);
  return started && started.getTime() >= Date.UTC(2020, 0, 1) ? started : null;
}

/**
 * N-15: how far a daemon's wall clock is from Gateway's, measured on the report itself: the daemon's clock when it
 * built the report against Gateway's when the report arrived. A VM resumed from suspend runs minutes behind until NTP
 * steps it (stand run rc20pre3 i: 101 s), and every time the daemon reports is on that clock.
 */
export interface LeaseReporterClock {
  /** The daemon's wall clock (Unix ms) from its health report; resolution one second. */
  healthTimestampMs?: number;
  /** Gateway's wall clock when the report arrived. */
  receivedAtMs: number;
}

/** Offsets up to this much are transit and clock resolution, not skew: times are taken as reported. */
export const LEASE_REPORTER_CLOCK_TOLERANCE_MS = 2_000;

/**
 * The reporter's clock offset (its clock minus Gateway's) in ms; null when the report arrived with a clock that cannot
 * be measured, so its reported times are not used (voters decide). Without a clock at all (a replayed report) the
 * times are taken as reported.
 */
export function leaseReporterClockOffset(
  report: Pick<AvailabilityLeaseReport, 'reportedAtUnixMs'>,
  clock: LeaseReporterClock | undefined
): number | null {
  if (!clock) return 0;
  const precise = Number(report.reportedAtUnixMs ?? 0);
  if (Number.isSafeInteger(precise) && precise > 0) return precise - clock.receivedAtMs;
  const coarse = Number(clock.healthTimestampMs ?? 0);
  // Whole seconds, truncated: the report was built up to a second after it.
  return Number.isSafeInteger(coarse) && coarse > 0 ? coarse + 500 - clock.receivedAtMs : null;
}

/** A time the reporter stated on its own clock, on Gateway's clock; null when the offset is unknown. */
function onGatewayClock(reported: Date | null, offsetMs: number | null): Date | null {
  if (!reported || offsetMs === null) return null;
  if (Math.abs(offsetMs) <= LEASE_REPORTER_CLOCK_TOLERANCE_MS) return reported;
  return new Date(reported.getTime() - offsetMs);
}

/** A voter's first sighting of the holder, unless it may only be the voter catching up after its own restart. */
function voterSighting(since: Date | null, startedAt: Date | null): Date | null {
  if (!since) return null;
  if (startedAt && since.getTime() - startedAt.getTime() < LEASE_VOTER_RESTART_GRACE_MS) return null;
  return since;
}

/**
 * Lease reports from daemon heartbeats and relay health (D9): persisted acks per member and the holder of every
 * key. A holder change without a planned handoff is audited as docker.availability.lease_failover, a planned one as
 * docker.availability.lease_handoff.
 */
export class AvailabilityLeaseReports {
  constructor(private readonly db: DrizzleClient) {}

  async ingest(
    sender: LeaseReportSender,
    report: AvailabilityLeaseReport,
    now = new Date(),
    clock?: LeaseReporterClock
  ): Promise<{ notices: LeaseHolderChangeNotice[]; sightings: LeaseTakeoverSighting[]; identityChanged: boolean }> {
    // Nginx daemons only observe leases and report just the applied revision, without a member id; the sender
    // itself comes from the authenticated control stream.
    const reportedMemberId = report.memberId || (sender.kind === 'nginx' ? sender.memberId : '');
    if (!reportedMemberId || reportedMemberId !== sender.memberId) {
      logger.warn('Ignored an availability lease report for another member', {
        memberId: sender.memberId,
        reported: report.memberId,
      });
      return { notices: [], sightings: [], identityChanged: false };
    }
    const identityChanged = await this.recordMember(sender, report, now);
    const source: DockerAvailabilityLeaseObservationSource = sender.kind === 'relay' ? 'relay' : 'daemon';
    const candidates = new Map<string, { policyId: string; slot: number; list: LeaseObservationCandidate[] }>();
    const addCandidate = (policyId: string, slot: number, candidate: LeaseObservationCandidate) => {
      const key = keyOf(policyId, slot);
      const entry = candidates.get(key) ?? { policyId, slot, list: [] };
      entry.list.push(candidate);
      candidates.set(key, entry);
    };
    const reporterRoles = new Map<string, { policyId: string; slot: number; role: string }>();
    const startedAt = reporterStartedAt(report.incarnation);
    // N-15: a daemon states times on its own wall clock; they are moved onto Gateway's by the measured offset, and not
    // used at all when it cannot be measured. Relays keep their times (their reports carry no clock yet).
    const offsetMs = sender.kind === 'relay' ? 0 : leaseReporterClockOffset(report, clock);
    const daemonTime = (value: string | number | undefined | null) => onGatewayClock(reportedTime(value), offsetMs);
    const startedOnGatewayClock = startedAt ? daemonTime(startedAt.getTime()) : null;
    const starting = Boolean(
      startedOnGatewayClock && now.getTime() - startedOnGatewayClock.getTime() < LEASE_VOTER_RESTART_GRACE_MS
    );
    // The holder's own acquired events carry its takeover time (N-5).
    const acquiredAt = new Map<string, Date>();
    for (const event of report.events ?? []) {
      const at = daemonTime(event.atUnixMs);
      if (event.kind !== 'acquired' || !event.policyId || !at) continue;
      const key = keyOf(event.policyId, event.slot);
      const known = acquiredAt.get(key);
      if (!known || at < known) acquiredAt.set(key, at);
    }
    if (sender.kind !== 'relay') {
      for (const held of report.held ?? []) {
        if (!held.policyId) continue;
        // Graceful close: a retained holder reports retained = true (role "retained"); either marks it.
        const role = held.retained === true ? RETAINED_LEASE_ROLE : held.role;
        reporterRoles.set(keyOf(held.policyId, held.slot), {
          policyId: held.policyId,
          slot: held.slot,
          role,
        });
        const ballot = normalizeLeaseBallot(held.ballot);
        if (!ballot || !HOLDING_LEASE_ROLES.has(role)) continue;
        // B-14: the holder reports when it acquired the key with every report; the acquired event is lost when the
        // report carrying it could not be delivered.
        const since = daemonTime(held.heldSinceUnixMs) ?? acquiredAt.get(keyOf(held.policyId, held.slot)) ?? null;
        addCandidate(held.policyId, held.slot, {
          holderId: sender.memberId,
          ballot,
          epoch: toNumber(held.epoch),
          manifestVersion: toNumber(held.manifestVersion),
          source: 'daemon',
          sourceId: sender.memberId,
          since,
          exact: since !== null,
          // A daemon that states its clock (N-15) also reports a key it recovered after a restart without a time.
          holdingStart: since !== null && Number(report.reportedAtUnixMs ?? 0) > 0,
        });
      }
    }
    for (const view of report.acceptor ?? []) {
      if (!view.policyId) continue;
      const ballot = normalizeLeaseBallot(view.committed);
      // When this voter first stored a commit of the committed ballot's proposer (N-5), unless that was right after
      // its own start (B-14).
      // Its own start is on the same clock as the sighting, so the restart check compares them as reported.
      const sighted = voterSighting(reportedTime(view.holderSinceUnixMs), startedAt);
      const commitSince = sighted ? daemonTime(sighted.getTime()) : null;
      const sinceFor = (holderId: string) => (commitSince && ballot?.proposerId === holderId ? commitSince : null);
      // Stateful keys: the certified state hash belongs to the committed ballot.
      const stateHash = committedStateHash(view);
      if (view.state === 'held' && view.holderId && ballot) {
        addCandidate(view.policyId, view.slot, {
          holderId: view.holderId,
          ballot,
          epoch: toNumber(view.epoch),
          manifestVersion: toNumber(view.manifestVersion),
          source: source === 'relay' ? 'relay' : 'acceptor',
          sourceId: sender.memberId,
          since: sinceFor(view.holderId),
          stateHash,
        });
        continue;
      }
      // An open relay gate names the holder of a verified commit that renewed within the last gate window (A11, A15),
      // also where the relay does not vote: the local relay only shadow-accepts. Its health report is the first lease
      // view Gateway gets after a restart, long before the nodes' control sessions reconnect (stand run ha18/b).
      const gateBallot = normalizeLeaseBallot(view.gateBallot);
      if (sender.kind === 'relay' && view.gateOpen && view.gateHolderId && gateBallot) {
        addCandidate(view.policyId, view.slot, {
          holderId: view.gateHolderId,
          ballot: gateBallot,
          epoch: toNumber(view.epoch),
          manifestVersion: toNumber(view.manifestVersion),
          source: 'relay',
          sourceId: sender.memberId,
          since: sinceFor(view.gateHolderId),
          stateHash: ballot && compareLeaseBallots(ballot, gateBallot) === 0 ? stateHash : null,
        });
      }
    }
    const handoffSuccessors = new Map<string, Set<string>>();
    for (const event of report.events ?? []) {
      if (event.kind !== 'handoff' || !event.successorId || !event.policyId) continue;
      const key = keyOf(event.policyId, event.slot);
      const set = handoffSuccessors.get(key) ?? new Set<string>();
      set.add(event.successorId);
      handoffSuccessors.set(key, set);
    }
    const keys = new Set([...candidates.keys(), ...reporterRoles.keys()]);
    if (sender.kind !== 'relay') {
      // A key this daemon held, or ran a copy for (a claimant: fencing, abandoned, releasing...), but no longer
      // reports was released or its copy stopped. Without the claimant case a fenced holder stayed listed forever,
      // which kept a bootstrap from settling and a closing lease from seeing that no copy runs (D3).
      const claimed = await this.db
        .select({
          policyId: dockerAvailabilityLeaseObservations.policyId,
          slot: dockerAvailabilityLeaseObservations.slot,
        })
        .from(dockerAvailabilityLeaseObservations)
        .where(
          or(
            eq(dockerAvailabilityLeaseObservations.holderId, sender.memberId),
            sql`jsonb_exists(${dockerAvailabilityLeaseObservations.claimants}, ${sender.memberId})`
          )
        );
      for (const { policyId, slot } of claimed) keys.add(keyOf(policyId, slot));
    }
    const notices: LeaseHolderChangeNotice[] = [];
    for (const key of keys) {
      const [policyId, slotText] = [key.slice(0, key.lastIndexOf('/')), key.slice(key.lastIndexOf('/') + 1)];
      const slot = Number(slotText);
      try {
        const role = reporterRoles.get(key)?.role ?? null;
        const notice = await this.applyKey(policyId, slot, {
          candidates: candidates.get(key)?.list ?? [],
          // A daemon that just started reports a key it recovers for a running copy only after its first step: until
          // then the key's absence says nothing (a restart would clear the holder and bring it back as new).
          reporter: sender.kind === 'relay' || (role === null && starting) ? undefined : { id: sender.memberId, role },
          handoffSuccessors: handoffSuccessors.get(key) ?? new Set(),
          now,
        });
        if (notice) notices.push(notice);
      } catch (error) {
        logger.debug('Availability lease observation was not applied', {
          policyId,
          slot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const sightings = [...candidates.values()].map(({ policyId, slot, list }) => ({
      policyId,
      slot,
      candidates: list,
    }));
    return { notices, sightings, identityChanged };
  }

  /** B-14: a better takeover time for the key's current holder, found after the change was recorded. */
  async correctHolderSince(policyId: string, slot: number, holderId: string, since: Date): Promise<void> {
    await this.db
      .update(dockerAvailabilityLeaseObservations)
      .set({ holderSince: since })
      .where(
        and(
          eq(dockerAvailabilityLeaseObservations.policyId, policyId),
          eq(dockerAvailabilityLeaseObservations.slot, slot),
          eq(dockerAvailabilityLeaseObservations.holderId, holderId)
        )
      );
  }

  /** Records the member's report; true when its identity key changed (a certificate renewal, H3). */
  private async recordMember(sender: LeaseReportSender, report: AvailabilityLeaseReport, now: Date): Promise<boolean> {
    const [previous] = await this.db
      .select({ identityPublicKey: availabilityLeaseMembers.identityPublicKey })
      .from(availabilityLeaseMembers)
      .where(eq(availabilityLeaseMembers.memberId, sender.memberId))
      .limit(1);
    const manifestAcks: Record<string, { version: number; closed: boolean; voterEpoch?: number }> = {};
    for (const ack of report.manifests ?? []) {
      if (!ack.policyId) continue;
      const voterEpoch = toNumber(ack.voterEpoch);
      manifestAcks[ack.policyId] = {
        version: toNumber(ack.manifestVersion),
        closed: ack.closed,
        ...(voterEpoch > 0 ? { voterEpoch } : {}),
      };
    }
    const values = {
      kind: sender.kind,
      nodeId: sender.nodeId,
      relayInstanceId: sender.relayInstanceId,
      identityPublicKey: report.identityPublicKey?.length
        ? Buffer.from(report.identityPublicKey).toString('base64')
        : null,
      watchdogReady: report.watchdogReady === true,
      incarnation: toNumber(report.incarnation),
      epochAck: toNumber(report.epoch),
      trustedKeyIds: (report.trustedPolicyKeyIds ?? []).filter((id) => typeof id === 'string' && id.length > 0),
      manifestAcks,
      leaseRevision: toNumber(report.leaseRevision),
      abstaining: report.acceptorAbstaining === true,
      reportedAt: now,
      updatedAt: now,
    };
    const identityChanged = Boolean(
      previous?.identityPublicKey && values.identityPublicKey && previous.identityPublicKey !== values.identityPublicKey
    );
    const rotation = identityChanged
      ? { previousIdentityPublicKey: previous!.identityPublicKey, identityRotatedAt: now }
      : {};
    await this.db
      .insert(availabilityLeaseMembers)
      .values({ memberId: sender.memberId, ...values, ...rotation })
      .onConflictDoUpdate({ target: availabilityLeaseMembers.memberId, set: { ...values, ...rotation } });
    return identityChanged;
  }

  private async applyKey(
    policyId: string,
    slot: number,
    input: {
      candidates: LeaseObservationCandidate[];
      reporter?: { id: string; role: string | null };
      handoffSuccessors: Set<string>;
      now: Date;
    }
  ): Promise<LeaseHolderChangeNotice | null> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 31) return null;
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select({
          plannedHandoffs: dockerAvailabilityLeaseState.plannedHandoffs,
          kind: leasePolicies.kind,
          resourceId: leasePolicies.resourceId,
        })
        .from(dockerAvailabilityLeaseState)
        .innerJoin(leasePolicies, eq(leasePolicies.id, dockerAvailabilityLeaseState.policyId))
        .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
        .limit(1);
      // Reports about a policy the Gateway never put in lease mode are not recorded.
      if (!state) return null;
      const [stored] = await tx
        .select()
        .from(dockerAvailabilityLeaseObservations)
        .where(
          and(
            eq(dockerAvailabilityLeaseObservations.policyId, policyId),
            eq(dockerAvailabilityLeaseObservations.slot, slot)
          )
        )
        .for('update');
      if (!stored && input.candidates.length === 0) return null;
      const previous: LeaseObservationState | null = stored
        ? {
            holderId: stored.holderId,
            ballot: stored.ballot,
            epoch: stored.epoch,
            manifestVersion: stored.manifestVersion,
            source: stored.source,
            sourceId: stored.sourceId,
            observedAt: stored.observedAt,
            holderSince: stored.holderSince,
            lastHolderId: stored.lastHolderId,
            claimants: stored.claimants,
            stateHash: stored.stateHash,
          }
        : null;
      const { next, change } = mergeLeaseObservation(previous, input);
      const placementId =
        next.holderId && state.kind === 'docker_availability'
          ? await this.placementOf(tx, policyId, next.holderId)
          : null;
      const row = { ...next, placementId, updatedAt: input.now };
      if (stored) {
        await tx
          .update(dockerAvailabilityLeaseObservations)
          .set(row)
          .where(
            and(
              eq(dockerAvailabilityLeaseObservations.policyId, policyId),
              eq(dockerAvailabilityLeaseObservations.slot, slot)
            )
          );
      } else {
        await tx.insert(dockerAvailabilityLeaseObservations).values({ policyId, slot, ...row });
      }
      if (!change) return null;
      const notice: LeaseHolderChangeNotice = {
        ...change,
        policyId,
        leaseKind: state.kind,
        resourceId: state.resourceId,
        slot,
        kind: classifyLeaseHolderChange(change, slot, state.plannedHandoffs, input.handoffSuccessors, input.now),
        placementId,
        source: next.source,
        sourceId: next.sourceId,
        noticedAt: input.now,
        stateHash: next.stateHash ?? null,
      };
      // B-14: its audit is stored with the change itself, so a crash before the audit row is written loses nothing.
      if (notice.kind) await persistPendingLeaseTakeover(tx, pendingLeaseTakeover(notice));
      return notice;
    });
  }

  private async placementOf(
    tx: Parameters<Parameters<DrizzleClient['transaction']>[0]>[0],
    policyId: string,
    nodeId: string
  ): Promise<string | null> {
    const [placement] = await tx
      .select({ id: dockerAvailabilityPlacements.id })
      .from(dockerAvailabilityPlacements)
      .where(and(eq(dockerAvailabilityPlacements.policyId, policyId), eq(dockerAvailabilityPlacements.nodeId, nodeId)))
      .limit(1);
    return placement?.id ?? null;
  }
}
