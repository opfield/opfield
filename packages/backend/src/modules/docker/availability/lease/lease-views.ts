import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  relayInstances,
} from '@/db/schema/index.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { leaseManifestClosure } from './lease-codec.js';
import { MEMBER_REPORT_FRESH_MS, RELAY_CONNECTIONS_FRESH_MS } from './lease-constants.js';
import { type LeaseParticipants, loadLeaseParticipants, restrictLeaseParticipants } from './lease-participants.js';
import { leaseCandidatePlacements } from './lease-planning.js';
import { loadLeasePolicy } from './lease-policy-registry.js';
import { keepsRunningThroughClose } from './lease-policy-rules.js';
import type { LeaseCertifiedStateDetail, LeasePolicyKind } from './lease-policy-source.js';
import {
  type LeaseStateRow,
  leaseReachableMemberIds,
  loadLeaseMembers,
  type RelayConnectedMembers,
} from './lease-store.js';
import type {
  DockerAvailabilityLeaseExcludedNode,
  DockerAvailabilityLeaseView,
  DockerAvailabilityLeaseWitnessView,
  LeasePolicyCertifiedStateView,
  LeasePolicyExcludedMember,
  LeasePolicyView,
} from './lease-types.js';
import { type LeaseWitnessWarning, leaseVoterMargin } from './lease-voters.js';

type Registry = Pick<NodeRegistryService, 'getNode'>;

export interface LeaseViewContext {
  db: DrizzleClient;
  registry: Registry;
  /** Members each relay last reported a live Coordinate stream from (voter reachability). */
  relayConnections: Iterable<RelayConnectedMembers>;
}

/** D3: the policy's candidate nodes that cannot hold or receive a standby now, with the reason. */
export function leaseExcludedNodes(
  participants: Pick<LeaseParticipants, 'byId'>,
  candidateNodeIds: Iterable<string>
): DockerAvailabilityLeaseExcludedNode[] {
  return [...new Set(candidateNodeIds)].sort().flatMap((nodeId) => {
    const participant = participants.byId.get(nodeId);
    // A candidate without a docker node row cannot be reached at all.
    const reason = participant ? participant.exclusion : 'offline';
    return reason ? [{ nodeId, reason }] : [];
  });
}

function leaseWitnessView(state: LeaseStateRow | null): DockerAvailabilityLeaseWitnessView | null {
  if (!state) return null;
  const first = state.witnesses[0];
  return {
    memberId: first?.memberId ?? null,
    kind: first?.kind ?? null,
    auto: first?.auto ?? true,
    minRttMs: first?.minRttMs ?? null,
    warning: (state.witnessWarning as LeaseWitnessWarning | null) ?? null,
  };
}

async function reachableVoters(context: LeaseViewContext, now: Date) {
  const [members, localRelays] = await Promise.all([
    loadLeaseMembers(context.db),
    context.db.select({ id: relayInstances.id }).from(relayInstances).where(eq(relayInstances.kind, 'local')),
  ]);
  const reachable = leaseReachableMemberIds({
    members,
    connections: context.relayConnections,
    localRelayIds: new Set(localRelays.map(({ id }) => id)),
    now: now.getTime(),
    memberFreshMs: MEMBER_REPORT_FRESH_MS,
    connectionFreshMs: RELAY_CONNECTIONS_FRESH_MS,
  });
  return { members, reachable };
}

/** The hosts of the given voters (lease member ids) and whether the lease reaches each now. */
export async function leaseVoterHosts(
  context: LeaseViewContext,
  voters: readonly string[],
  now: Date
): Promise<Array<{ memberId: string; nodeId: string | null; relayInstanceId: string | null; reachable: boolean }>> {
  if (voters.length === 0) return [];
  const { members, reachable } = await reachableVoters(context, now);
  const byId = new Map(members.map((member) => [member.memberId, member]));
  return voters.map((memberId) => ({
    memberId,
    nodeId: byId.get(memberId)?.nodeId ?? null,
    relayInstanceId: byId.get(memberId)?.relayInstanceId ?? null,
    reachable: reachable.has(memberId),
  }));
}

async function loadStateAndObservations(db: DrizzleClient, leasePolicyId: string) {
  const [[state], observations] = await Promise.all([
    db
      .select()
      .from(dockerAvailabilityLeaseState)
      .where(eq(dockerAvailabilityLeaseState.policyId, leasePolicyId))
      .limit(1),
    db
      .select()
      .from(dockerAvailabilityLeaseObservations)
      .where(eq(dockerAvailabilityLeaseObservations.policyId, leasePolicyId)),
  ]);
  return { state: state ?? null, observations: observations.sort((left, right) => left.slot - right.slot) };
}

/** Read-only lease state of an Availability policy (its API shape). */
export async function availabilityLeaseView(
  context: LeaseViewContext,
  policyId: string,
  now: Date
): Promise<DockerAvailabilityLeaseView> {
  const [[state], observations, members, localRelays, placements, [policy]] = await Promise.all([
    context.db
      .select()
      .from(dockerAvailabilityLeaseState)
      .where(eq(dockerAvailabilityLeaseState.policyId, policyId))
      .limit(1),
    context.db
      .select()
      .from(dockerAvailabilityLeaseObservations)
      .where(eq(dockerAvailabilityLeaseObservations.policyId, policyId)),
    loadLeaseMembers(context.db),
    context.db.select({ id: relayInstances.id }).from(relayInstances).where(eq(relayInstances.kind, 'local')),
    context.db
      .select({
        id: dockerAvailabilityPlacements.id,
        nodeId: dockerAvailabilityPlacements.nodeId,
        desiredState: dockerAvailabilityPlacements.desiredState,
        serving: dockerAvailabilityPlacements.serving,
        createdAt: dockerAvailabilityPlacements.createdAt,
      })
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policyId)),
    context.db
      .select({
        mode: dockerAvailabilityPolicies.mode,
        desiredReplicaCount: dockerAvailabilityPolicies.desiredReplicaCount,
      })
      .from(dockerAvailabilityPolicies)
      .where(eq(dockerAvailabilityPolicies.id, policyId))
      .limit(1),
  ]);
  // A slot that left the manifest (fewer replicas, surge lowered) keeps its observation row; once nobody holds it, it
  // is no slot of the policy any more and is not listed (stand run x4: Failover 1 showed an empty slot 1).
  const slots = policy
    ? policy.mode === 'replicated'
      ? Math.min(32, policy.desiredReplicaCount + (state?.surgeSlots ?? 0))
      : 1
    : Number.POSITIVE_INFINITY;
  const candidateNodeIds = leaseCandidatePlacements(placements).map((placement) => placement.nodeId);
  const excludedNodes =
    state && state.mode !== 'legacy' && candidateNodeIds.length > 0
      ? leaseExcludedNodes(
          await loadLeaseParticipants(
            context.db,
            context.registry,
            new Map(members.map((member) => [member.memberId, member])),
            now.getTime()
          ),
          candidateNodeIds
        )
      : [];
  const reachable = leaseReachableMemberIds({
    members,
    connections: context.relayConnections,
    localRelayIds: new Set(localRelays.map(({ id }) => id)),
    now: now.getTime(),
    memberFreshMs: MEMBER_REPORT_FRESH_MS,
    connectionFreshMs: RELAY_CONNECTIONS_FRESH_MS,
  });
  return {
    mode: state?.mode ?? 'legacy',
    reason: state?.reason ?? null,
    manifestVersion: state?.manifestVersion ?? 0,
    epoch: state?.voterEpoch ?? 0,
    publishedPartitionMode: state?.publishedPartitionMode ?? null,
    holders: observations
      .filter((observation) => observation.slot < slots || observation.holderId !== null)
      .sort((left, right) => left.slot - right.slot)
      .map((observation) => ({
        slot: observation.slot,
        holderNodeId: observation.holderId,
        placementId: observation.placementId,
        ballot: observation.ballot,
        observedAt: observation.observedAt,
        holderSince: observation.holderSince,
        source: observation.source,
      })),
    bootstrap: (state?.bootstrap ?? []).map((entry) => ({ slot: entry.slot, holderNodeId: entry.holderId })),
    strictPending: state?.mode === 'bootstrapping' && state.strictRequestedAt !== null,
    surgeSlots: state?.surgeSlots ?? 0,
    copiesStoppedAt: state?.copiesStoppedAt ?? null,
    modeChangedAt: state?.modeChangedAt ?? null,
    excludedNodes,
    retainedHolders:
      state?.mode === 'closing'
        ? (leaseManifestClosure(state.manifestBlock)?.retained ?? []).map((entry) => ({
            slot: entry.slot,
            holderNodeId: entry.holderId,
            confirmed: keepsRunningThroughClose(
              entry,
              observations.find((observation) => observation.slot === entry.slot),
              new Set(
                members
                  .filter((member) => {
                    const ack = member.manifestAcks[policyId];
                    return ack?.closed === true && ack.version >= state.manifestVersion;
                  })
                  .map((member) => member.memberId)
              )
            ),
          }))
        : [],
    voterMargin: state ? leaseVoterMargin(state.voterEpoch, state.quorumSets, reachable) : null,
    voters: state?.quorumSets.at(-1) ?? [],
    witness: leaseWitnessView(state ?? null),
    witnesses: state?.witnesses ?? [],
  };
}

/** Candidates that cannot hold now, with capability_missing for a required capability the daemon lacks. */
function excludedMembers(participants: LeaseParticipants, candidateIds: string[]): LeasePolicyExcludedMember[] {
  return [...new Set(candidateIds)].sort().flatMap((memberId): LeasePolicyExcludedMember[] => {
    const participant = participants.byId.get(memberId);
    if (!participant) return [{ memberId, reason: 'offline' }];
    if (participant.missingCapabilities.length > 0 && participant.exclusion !== 'offline') {
      return [{ memberId, reason: 'capability_missing', missingCapabilities: [...participant.missingCapabilities] }];
    }
    return participant.exclusion ? [{ memberId, reason: participant.exclusion }] : [];
  });
}

/** Per slot: the observed commit of a stateful key with the source's decoded summary of its certified state. */
function certifiedStateViews(
  observations: Array<typeof dockerAvailabilityLeaseObservations.$inferSelect>,
  details: LeaseCertifiedStateDetail[]
): LeasePolicyCertifiedStateView[] {
  const slots = [...new Set([...observations.map(({ slot }) => slot), ...details.map(({ slot }) => slot)])].sort(
    (left, right) => left - right
  );
  return slots.map((slot) => {
    const observation = observations.find((entry) => entry.slot === slot);
    return {
      slot,
      holderMemberId: observation?.holderId ?? null,
      stateHash: observation?.stateHash ?? null,
      observedAt: observation?.observedAt ?? null,
      detail: details.find((entry) => entry.slot === slot) ?? null,
    };
  });
}

/** Read-only lease state of any lease policy; null when no such lease policy is registered. */
export async function leasePolicyView(
  context: LeaseViewContext,
  leasePolicyId: string,
  now: Date,
  certifiedStateDetails?: (leasePolicyId: string, kind: LeasePolicyKind) => Promise<LeaseCertifiedStateDetail[]>
): Promise<LeasePolicyView | null> {
  const registration = await loadLeasePolicy(context.db, leasePolicyId);
  if (!registration) return null;
  const [{ state, observations }, { members, reachable }, details] = await Promise.all([
    loadStateAndObservations(context.db, leasePolicyId),
    reachableVoters(context, now),
    registration.stateful && certifiedStateDetails
      ? certifiedStateDetails(leasePolicyId, registration.kind).catch(() => [])
      : [],
  ]);
  const candidates = state?.candidateMemberIds ?? [];
  const excluded =
    state && state.mode !== 'legacy' && candidates.length > 0
      ? excludedMembers(
          restrictLeaseParticipants(
            await loadLeaseParticipants(
              context.db,
              context.registry,
              new Map(members.map((member) => [member.memberId, member])),
              now.getTime()
            ),
            state.requiredCapabilities,
            new Set(candidates)
          ),
          candidates
        )
      : [];
  const mode = state?.mode ?? 'legacy';
  const reason = state?.reason ?? null;
  return {
    leasePolicyId,
    kind: registration.kind,
    resourceId: registration.resourceId,
    stateful: registration.stateful,
    mode,
    reason,
    degraded: registration.stateful && reason !== null && (mode === 'lease' || mode === 'bootstrapping'),
    manifestVersion: state?.manifestVersion ?? 0,
    epoch: state?.voterEpoch ?? 0,
    joint: (state?.quorumSets.length ?? 0) > 1,
    publishedPartitionMode: state?.publishedPartitionMode ?? null,
    holders: observations.map((observation) => ({
      slot: observation.slot,
      holderMemberId: observation.holderId,
      placementId: observation.placementId,
      ballot: observation.ballot,
      observedAt: observation.observedAt,
      holderSince: observation.holderSince,
      source: observation.source,
      stateHash: observation.stateHash,
    })),
    bootstrap: (state?.bootstrap ?? []).map((entry) => ({ slot: entry.slot, holderMemberId: entry.holderId })),
    candidates,
    excludedMembers: excluded,
    voterMargin: state ? leaseVoterMargin(state.voterEpoch, state.quorumSets, reachable) : null,
    voters: state?.quorumSets.at(-1) ?? [],
    quorumSets: state?.quorumSets ?? [],
    witness: leaseWitnessView(state),
    witnesses: state?.witnesses ?? [],
    certifiedState: registration.stateful ? certifiedStateViews(observations, details) : null,
  };
}
