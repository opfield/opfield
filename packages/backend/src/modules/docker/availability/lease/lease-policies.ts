import { randomInt } from 'node:crypto';
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type DockerAvailabilityLeaseMode,
  type DockerAvailabilityLeaseReason,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  type LeasePolicyKind,
  leasePolicies,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  type LeaseRetainedSlot,
  type LeaseSigner,
  leaseManifestClosure,
  leaseManifestSupportsStateful,
} from './lease-codec.js';
import {
  AVAILABILITY_LEASE_CAPABILITY,
  CLOSE_SETTLE_MS,
  GATE_WINDOW_MS,
  LEASE_IMPOSSIBLE_HYSTERESIS_MS,
} from './lease-constants.js';
import { evaluateLeaseGating } from './lease-gating.js';
import { publishLeaseManifest } from './lease-manifest.js';
import {
  type LeaseParticipants,
  leaseVoterCandidates,
  leaseWitnessPool,
  restrictLeaseParticipants,
} from './lease-participants.js';
import { bootstrapAcknowledged, bootstrapFromHolders } from './lease-planning.js';
import {
  type LeasePolicyRegistration,
  leasePolicyRegistrationConflict,
  registerLeasePolicies,
} from './lease-policy-registry.js';
import { loadLeasePolicyRelays } from './lease-policy-relays.js';
import {
  CLOSE_REQUESTED,
  closedEverywhere,
  descriptorProblem,
  filterWitnessPool,
  impossibleSince,
  keepsRunningThroughClose,
  LEASE_REENTRY_HOLD_MS,
  lastHolders,
  participantExclusion,
  requiredLeaseCapabilities,
  retainedFromObservations,
  SOURCE_MISSING,
  STATEFUL_STRICT_ONLY,
  STATEFUL_UNSUPPORTED,
  STRICT_SWITCH_PENDING,
  withoutRetainedHolder,
} from './lease-policy-rules.js';
import type { LeaseDegradedChange, LeaseModeChange, LeasePolicyDescriptor } from './lease-policy-source.js';
import type { LeaseClusterRow, LeaseMemberRow, LeaseStateRow } from './lease-store.js';
import { ensureLeaseState } from './lease-store.js';
import { holdsEveryMajority, type PolicyVoterSelection, selectPolicyVoters } from './lease-voters.js';

const logger = createChildLogger('LeasePolicies');

type ObservationRow = typeof dockerAvailabilityLeaseObservations.$inferSelect;
type StateUpdates = Partial<typeof dockerAvailabilityLeaseState.$inferInsert>;

export { keepsRunningThroughClose, requiredLeaseCapabilities };

export interface LeasePoliciesOutcome {
  changed: boolean;
  modeChanges: LeaseModeChange[];
  /** Stateful policies whose degraded reason appeared, changed or cleared (AS9). */
  degradedChanges: LeaseDegradedChange[];
}

export interface LeasePoliciesContext {
  participants: LeaseParticipants;
  members: Map<string, LeaseMemberRow>;
  cluster: LeaseClusterRow;
  now: Date;
}

/** Per-policy lease mode (D10, A5, A7, AS1, AS8, AS9) and its signed manifest (D4), for every kind of source. */
export class LeasePolicies {
  constructor(
    private readonly db: DrizzleClient,
    private readonly sign: LeaseSigner
  ) {}

  /**
   * Reconciles every descriptor of the registered sources. `sourcedKinds` are the kinds whose source answered: a
   * published policy of such a kind that its source no longer lists keeps running as last published (source_missing).
   */
  async reconcile(
    context: LeasePoliciesContext,
    descriptors: LeasePolicyDescriptor[],
    sourcedKinds: ReadonlySet<LeasePolicyKind>
  ): Promise<LeasePoliciesOutcome> {
    const outcome: LeasePoliciesOutcome = { changed: false, modeChanges: [], degradedChanges: [] };
    const valid = descriptors.filter((descriptor) => {
      const problem = descriptorProblem(descriptor);
      if (problem)
        logger.warn('A lease policy descriptor was not published', {
          leasePolicyId: descriptor.leasePolicyId,
          problem,
        });
      return !problem;
    });
    const registrations: LeasePolicyRegistration[] = valid.map((descriptor) => ({
      leasePolicyId: descriptor.leasePolicyId,
      kind: descriptor.kind,
      resourceId: descriptor.resourceId,
      stateful: descriptor.stateful,
    }));
    const registered = await registerLeasePolicies(this.db, registrations);
    const accepted = valid.filter((descriptor, index) => {
      const row = registered.get(descriptor.leasePolicyId);
      const conflict = row ? leasePolicyRegistrationConflict(row, registrations[index]!) : 'not registered';
      if (conflict)
        logger.warn('A lease policy descriptor conflicts with its registration', {
          leasePolicyId: descriptor.leasePolicyId,
          conflict,
        });
      return !conflict;
    });
    const ids = accepted.map((descriptor) => descriptor.leasePolicyId);
    const [states, orphans] = await Promise.all([
      ids.length
        ? this.db.select().from(dockerAvailabilityLeaseState).where(inArray(dockerAvailabilityLeaseState.policyId, ids))
        : [],
      this.loadOrphans(ids, sourcedKinds),
    ]);
    const orphanIds = orphans.map(({ state }) => state.policyId);
    const allIds = [...ids, ...orphanIds];
    if (allIds.length === 0) return outcome;
    const [observations, relays] = await Promise.all([
      this.db
        .select()
        .from(dockerAvailabilityLeaseObservations)
        .where(inArray(dockerAvailabilityLeaseObservations.policyId, allIds)),
      loadLeasePolicyRelays(
        this.db,
        accepted.map((descriptor) => ({ kind: descriptor.kind, leasePolicyId: descriptor.leasePolicyId }))
      ),
    ]);
    const stateById = new Map(states.map((state) => [state.policyId, state]));
    const observationsOf = (id: string) => observations.filter((observation) => observation.policyId === id);
    for (const descriptor of accepted) {
      try {
        const state =
          stateById.get(descriptor.leasePolicyId) ?? (await ensureLeaseState(this.db, descriptor.leasePolicyId));
        const relayIds = [
          ...new Set([...(relays.get(descriptor.leasePolicyId) ?? []), ...(descriptor.carryingRelayIds ?? [])]),
        ];
        const result = await this.reconcilePolicy(
          descriptor,
          state,
          observationsOf(descriptor.leasePolicyId),
          relayIds,
          context
        );
        outcome.changed ||= result.changed;
        if (result.modeChange) outcome.modeChanges.push(result.modeChange);
        if (result.degradedChange) outcome.degradedChanges.push(result.degradedChange);
      } catch (error) {
        logger.warn('Lease reconciliation of a policy failed; it will be retried', {
          leasePolicyId: descriptor.leasePolicyId,
          kind: descriptor.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const orphan of orphans) {
      const degraded = await this.markSourceMissing(
        orphan.state,
        orphan.kind,
        orphan.resourceId,
        orphan.stateful,
        context.now
      );
      if (degraded) outcome.degradedChanges.push(degraded);
    }
    return outcome;
  }

  /** Published policies of an answering source's kind that the source no longer lists. */
  private async loadOrphans(listed: string[], kinds: ReadonlySet<LeasePolicyKind>) {
    if (kinds.size === 0) return [];
    const rows = await this.db
      .select({
        state: dockerAvailabilityLeaseState,
        kind: leasePolicies.kind,
        resourceId: leasePolicies.resourceId,
        stateful: leasePolicies.stateful,
      })
      .from(dockerAvailabilityLeaseState)
      .innerJoin(leasePolicies, eq(leasePolicies.id, dockerAvailabilityLeaseState.policyId))
      .where(
        and(
          ne(dockerAvailabilityLeaseState.mode, 'legacy'),
          inArray(leasePolicies.kind, [...kinds]),
          listed.length ? notInArray(dockerAvailabilityLeaseState.policyId, listed) : undefined
        )
      );
    return rows;
  }

  private async markSourceMissing(
    state: LeaseStateRow,
    kind: LeasePolicyKind,
    resourceId: string,
    stateful: boolean,
    now: Date
  ): Promise<LeaseDegradedChange | null> {
    if (state.reason?.code === SOURCE_MISSING.code) return null;
    const reason = { ...SOURCE_MISSING, since: now.toISOString() };
    await this.db
      .update(dockerAvailabilityLeaseState)
      .set({ reason, updatedAt: now })
      .where(eq(dockerAvailabilityLeaseState.policyId, state.policyId));
    logger.warn('A published lease policy is no longer listed by its source; it keeps running', {
      leasePolicyId: state.policyId,
      kind,
    });
    return stateful ? { leasePolicyId: state.policyId, leaseKind: kind, resourceId, mode: state.mode, reason } : null;
  }

  private async reconcilePolicy(
    descriptor: LeasePolicyDescriptor,
    state: LeaseStateRow,
    observations: ObservationRow[],
    relayIds: string[],
    context: LeasePoliciesContext
  ): Promise<{ changed: boolean; modeChange: LeaseModeChange | null; degradedChange: LeaseDegradedChange | null }> {
    const now = context.now;
    const required = requiredLeaseCapabilities(descriptor);
    const ranked = [...descriptor.candidates]
      .sort((left, right) => left.rank - right.rank)
      .map((candidate) => candidate.memberId);
    const participants = restrictLeaseParticipants(context.participants, required, new Set(ranked));
    const candidateNodes = [...new Set(ranked)];
    const servingNodes = new Set(descriptor.servingMemberIds ?? []);
    const ingressNodes = [...new Set(descriptor.observerNodeIds ?? [])];
    const selection = this.selectVoters(descriptor, state, ranked, participants);
    const entering = state.mode === 'legacy';
    const entryStable = (id: string) => participants.byId.get(id)?.entryStable === true;
    const statefulProblem = descriptor.stateful
      ? descriptor.partitionMode !== 'strict'
        ? STATEFUL_STRICT_ONLY
        : leaseManifestSupportsStateful()
          ? null
          : STATEFUL_UNSUPPORTED
      : null;
    const gating = evaluateLeaseGating({
      controllerSupportsLease: true,
      policyMode: descriptor.mode,
      unavailable: descriptor.closed ? CLOSE_REQUESTED : (descriptor.unavailable ?? statefulProblem),
      signingReady: Boolean(context.cluster.signingKeyId),
      entering,
      candidates: candidateNodes.map((nodeId) => ({
        nodeId,
        exclusion: participantExclusion(participants, nodeId),
        serving: servingNodes.has(nodeId),
      })),
      heldSlots: observations.filter((observation) => observation.holderId !== null).length,
      ingress: ingressNodes.map((nodeId) => ({ nodeId, capable: participants.byId.get(nodeId)?.capable ?? false })),
      relays: relayIds.map((relayId) => ({ relayId, capable: participants.byId.get(relayId)?.capable ?? false })),
      voters: { viable: selection.viable, nonVotingCandidateIds: selection.nonVotingCandidateIds },
      unsettled: entering
        ? {
            nodeIds: [
              ...candidateNodes,
              ...ingressNodes,
              ...selection.witnesses.filter((witness) => witness.kind === 'docker').map(({ memberId }) => memberId),
            ].filter((id) => !entryStable(id)),
            relayIds: [
              ...relayIds,
              ...selection.witnesses.filter((witness) => witness.kind === 'relay').map(({ memberId }) => memberId),
            ].filter((id) => !entryStable(id)),
          }
        : undefined,
      capabilityLabel: required.length ? [AVAILABILITY_LEASE_CAPABILITY, ...required].join(', ') : undefined,
    });
    const slots = descriptor.slots;
    const observationBySlot = new Map(observations.map((observation) => [observation.slot, observation]));
    // Graceful close: the closed manifest being published names the retained holders; they stay the same for the whole
    // close (read back from the published block), and a new close names the committed holders seen now.
    const closedManifest = state.mode === 'closing' ? leaseManifestClosure(state.manifestBlock) : null;
    const closure = { retained: closedManifest?.closed ? closedManifest.retained : [] };
    let retainedNow: LeaseRetainedSlot[] = [];
    const updates: StateUpdates = {};
    let next: DockerAvailabilityLeaseMode = state.mode;
    const plannedHandoffs = state.plannedHandoffs.filter((handoff) => Date.parse(handoff.expiresAt) > now.getTime());
    if (plannedHandoffs.length !== state.plannedHandoffs.length) updates.plannedHandoffs = plannedHandoffs;
    if (JSON.stringify(ranked) !== JSON.stringify(state.candidateMemberIds)) updates.candidateMemberIds = ranked;
    if (JSON.stringify(required) !== JSON.stringify(state.requiredCapabilities))
      updates.requiredCapabilities = required;
    // D3: a lease-mode policy leaves only after lease mode stayed impossible for 2 minutes without a break; an
    // explicit request (lifecycle hold, disable, close) closes at once. Meanwhile the lease keeps running as it is.
    // AS9: a stateful policy never leaves by itself: only an explicit close does; otherwise it runs degraded.
    const since = gating.eligible ? null : gating.immediate ? now : impossibleSince(state.reason, now);
    const explicitClose = descriptor.closed || (!descriptor.stateful && !gating.eligible && gating.immediate);
    const leaving =
      !gating.eligible &&
      state.mode !== 'legacy' &&
      state.mode !== 'closing' &&
      (descriptor.stateful
        ? descriptor.closed
        : explicitClose || now.getTime() - since!.getTime() >= LEASE_IMPOSSIBLE_HYSTERESIS_MS);

    if (state.mode === 'legacy') {
      // Only a policy that already left lease mode waits; a policy that never ran one bootstraps right away.
      const settled =
        state.manifestVersion === 0 || now.getTime() - state.modeChangedAt.getTime() >= LEASE_REENTRY_HOLD_MS;
      if (gating.eligible && settled && !descriptor.entryHold) {
        next = 'bootstrapping';
        updates.bootstrapId = randomInt(1, 2 ** 47);
        updates.bootstrap = (descriptor.bootstrap ?? [])
          .filter((entry) => entry.slot < slots)
          .map((entry) => ({ slot: entry.slot, holderId: entry.holderMemberId }));
        updates.strictRequestedAt = null;
        updates.copiesStoppedAt = null;
        updates.closingStartedAt = null;
        updates.closingAckedAt = null;
      }
    } else if (leaving) {
      next = 'closing';
      updates.closingStartedAt = now;
      updates.closingAckedAt = null;
    } else if (
      gating.eligible &&
      state.mode === 'lease' &&
      state.publishedPartitionMode === 'available' &&
      descriptor.partitionMode === 'strict'
    ) {
      // A7: strict takes over like a bootstrap, with the holder observed now named for each slot.
      next = 'bootstrapping';
      updates.bootstrapId = randomInt(1, 2 ** 47);
      updates.bootstrap = bootstrapFromHolders(
        observations.map((observation) => ({ slot: observation.slot, holderId: observation.holderId })),
        slots
      );
      updates.strictRequestedAt = now;
      updates.copiesStoppedAt = null;
    } else if (state.mode === 'bootstrapping') {
      // A5/A7/A16: the reserved holders hold, nobody else reports a running copy, and the relay gate window passed
      // since, so no relay still admits another copy. The entry stays in every manifest version until then.
      if (!bootstrapAcknowledged(state.bootstrap, observationBySlot)) {
        if (state.copiesStoppedAt) updates.copiesStoppedAt = null;
      } else if (!state.copiesStoppedAt) {
        updates.copiesStoppedAt = now;
      } else if (now.getTime() - state.copiesStoppedAt.getTime() >= GATE_WINDOW_MS) {
        next = 'lease';
        updates.bootstrap = [];
        updates.bootstrapId = 0;
        updates.strictRequestedAt = null;
        updates.copiesStoppedAt = null;
      }
    }
    let closeAckers: ReadonlySet<string> = new Set();
    if (state.mode === 'closing') {
      const closedAckers = new Set(
        [...context.members.values()]
          .filter((member) => {
            const ack = member.manifestAcks[descriptor.leasePolicyId];
            return ack?.closed === true && ack.version >= state.manifestVersion;
          })
          .map((member) => member.memberId)
      );
      closeAckers = closedAckers;
      let ackedAt = state.closingAckedAt;
      if (!ackedAt && holdsEveryMajority(state.quorumSets, closedAckers)) {
        ackedAt = now;
        updates.closingAckedAt = now;
      }
      // Graceful close + D3: legacy starts nothing before every held slot is retained by its named holder (its copy
      // keeps running, legacy adopts it as running) or expired, and every other copy is gone. Retained: the holder
      // reports that a majority of every quorum set confirmed the close to it; nobody can acquire the key any more.
      // Released: besides the retained copies no copy runs anywhere and every node that could hold knows the lease is
      // closed. Expired: a voter majority persisted the close, so no renewal succeeded since, and T x 1.1 / 0.9 plus
      // the fence stop margin passed; a named holder that never reported retained (partitioned) fenced by then.
      const retainedBySlot = new Map(closure.retained.map((entry) => [entry.slot, entry.holderId]));
      retainedNow = closure.retained.filter((entry) =>
        keepsRunningThroughClose(entry, observationBySlot.get(entry.slot), closedAckers)
      );
      const released =
        retainedNow.length === closure.retained.length &&
        closedEverywhere({
          observations: observations.map((observation) =>
            withoutRetainedHolder(observation, retainedBySlot.get(observation.slot))
          ),
          bootstrap: state.bootstrap,
          candidateNodeIds: candidateNodes,
          closedAckers,
          everySlotRetained: Array.from({ length: slots }, (_, slot) => slot).every((slot) =>
            retainedNow.some((entry) => entry.slot === slot)
          ),
        });
      if (released || (ackedAt && now.getTime() - ackedAt.getTime() >= CLOSE_SETTLE_MS)) {
        next = 'legacy';
        updates.manifestBlock = null;
        updates.bootstrap = [];
        updates.bootstrapId = 0;
      }
    }

    if (next !== state.mode) {
      updates.mode = next;
      updates.modeChangedAt = now;
    }
    const strictRequestedAt =
      updates.strictRequestedAt !== undefined ? updates.strictRequestedAt : state.strictRequestedAt;
    const reason: DockerAvailabilityLeaseReason | null = !gating.eligible
      ? { ...gating.reason, ...(gating.immediate ? {} : { since: since!.toISOString() }) }
      : next === 'bootstrapping' && strictRequestedAt
        ? STRICT_SWITCH_PENDING
        : null;
    const reasonChanged = JSON.stringify(reason) !== JSON.stringify(state.reason ?? null);
    if (reasonChanged) updates.reason = reason;
    const merged: LeaseStateRow = { ...state, ...(updates as Partial<LeaseStateRow>) };
    let blockChanged = false;
    if (next !== 'legacy') {
      const published = await publishLeaseManifest({
        descriptor,
        state: merged,
        slots,
        observations,
        participants,
        members: context.members,
        cluster: context.cluster,
        ranked,
        // Voters change only to a viable selection, and never while the lease closes (the close needs stable sets).
        selection: selection.viable && next !== 'closing' ? selection : null,
        retained:
          next === 'closing'
            ? closedManifest?.closed
              ? closure.retained
              : retainedFromObservations(observations, slots, state.mode === 'bootstrapping' ? state.bootstrap : [])
            : undefined,
        sign: this.sign,
        now,
      });
      Object.assign(updates, published.updates);
      blockChanged = published.published;
    }
    if (Object.keys(updates).length > 0) {
      await this.db
        .update(dockerAvailabilityLeaseState)
        .set({ ...updates, updatedAt: now })
        .where(eq(dockerAvailabilityLeaseState.policyId, descriptor.leasePolicyId));
    }
    const modeChange: LeaseModeChange | null =
      next !== state.mode
        ? {
            leasePolicyId: descriptor.leasePolicyId,
            leaseKind: descriptor.kind,
            resourceId: descriptor.resourceId,
            from: state.mode,
            to: next,
            reason,
            lastHolders: lastHolders(observations, state.bootstrap),
            retainedHolders:
              next === 'legacy' && state.mode === 'closing'
                ? retainedNow.map(({ slot, holderId }) => ({ slot, holderId }))
                : [],
            closeAckedBy: [...closeAckers].sort(),
          }
        : null;
    if (modeChange) {
      logger.info('Lease mode changes', {
        leasePolicyId: modeChange.leasePolicyId,
        kind: modeChange.leaseKind,
        from: modeChange.from,
        to: modeChange.to,
        reason: modeChange.reason,
      });
    }
    // AS9: a stateful policy that stays up but cannot run as it should is reported, never closed by the host.
    const degradedChange: LeaseDegradedChange | null =
      descriptor.stateful &&
      next !== 'legacy' &&
      reason?.code !== (state.reason?.code ?? undefined) &&
      next !== 'closing'
        ? {
            leasePolicyId: descriptor.leasePolicyId,
            leaseKind: descriptor.kind,
            resourceId: descriptor.resourceId,
            mode: next,
            reason,
          }
        : null;
    return { changed: blockChanged || (next === 'legacy' && state.mode === 'closing'), modeChange, degradedChange };
  }

  /**
   * The desired voters (A18, D3): voter-capable candidates, then witnesses. A current voter or witness keeps its place
   * through a short incapability (grace), so a daemon restart or a rolling update never changes the voters.
   */
  private selectVoters(
    descriptor: LeasePolicyDescriptor,
    state: LeaseStateRow,
    ranked: string[],
    participants: LeaseParticipants
  ): PolicyVoterSelection {
    const currentVoters = new Set(state.quorumSets.flat());
    const currentAuto = state.witnesses.filter((witness) => witness.auto).map((witness) => witness.memberId);
    const pool = leaseWitnessPool(participants, new Set(state.witnesses.map((witness) => witness.memberId)));
    return selectPolicyVoters({
      candidates: leaseVoterCandidates(participants, ranked, currentVoters),
      pool: filterWitnessPool(pool, descriptor.witnessFilter),
      configuredWitness: descriptor.witnessMemberId,
      currentAutoWitnesses: currentAuto,
      ...(descriptor.preferredVoterCount !== undefined ? { preferredVoterCount: descriptor.preferredVoterCount } : {}),
    });
  }
}
