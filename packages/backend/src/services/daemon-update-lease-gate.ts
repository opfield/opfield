import { and, inArray, isNotNull, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  availabilityLeaseMembers,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  nodes,
  relayInstances,
  relayPoolUpdateSteps,
} from '@/db/schema/index.js';
import type { NodeRegistryService } from './node-registry.service.js';

/**
 * Lease-aware daemon and relay updates.
 *
 * A restarted lease voter abstains after its start (a fresh store, a reboot, the first start after an upgrade from
 * rc.19 or older: ~33 s), and a restarting candidate holds or recovers slots. Two voters or candidates of the same
 * availability policy restarting at once can cost the policy its quorum and fail a slot over (second stand instance,
 * rolling rc.19 -> rc.20 update). So a member of a lease policy is updated only while every other voter and candidate of
 * each of its lease policies is settled: not updating, back online after its last restart, and reporting its lease
 * state with an acceptor that does not abstain. Members of no lease policy update in parallel as before.
 */

/** How long a restarted peer may take to report a non-abstaining acceptor before updates go on without it. */
export const LEASE_PEER_SETTLE_TIMEOUT_MS = 3 * 60_000;
/** A relay's lease report counts while this fresh; relays report with every health probe. */
export const LEASE_RELAY_REPORT_FRESH_MS = 60_000;

export interface LeaseUpdateTopology {
  /** Lease-mode policy id -> ids of the members that vote in it or are its candidates. */
  policyMembers: Map<string, Set<string>>;
  /** Members that hold a slot of a lease policy now. */
  holders: Set<string>;
}

export interface LeaseUpdatePeerState {
  /** Its daemon or relay update runs: dispatched, restarting, verifying. */
  updating: boolean;
  /** When its current run started (control session start); null when unknown or offline. */
  since: number | null;
  /** Its last lease report; null when it never reported. */
  reportedAt: number | null;
  abstaining: boolean;
}

/**
 * Why a member waits. `ingress_last`: an ingress (nginx) node of a batch waits for the other nodes of the batch to
 * finish their updates (the blocker's memberId is that node; it has no policy).
 */
export type LeaseUpdateBlockReason = 'updating' | 'reconnecting' | 'abstaining' | 'ingress_last';

export interface LeaseUpdateBlocker {
  memberId: string;
  policyId: string;
  reason: LeaseUpdateBlockReason;
}

export interface LeaseUpdateView {
  topology: LeaseUpdateTopology;
  states: Map<string, LeaseUpdatePeerState>;
}

/** The lease policies a member votes in or is a candidate of. */
export function leasePoliciesOf(topology: LeaseUpdateTopology, memberId: string): string[] {
  const policies: string[] = [];
  for (const [policyId, members] of topology.policyMembers) if (members.has(memberId)) policies.push(policyId);
  return policies.sort();
}

/**
 * What keeps a member from being updated now: every other voter or candidate of its lease policies that is updating,
 * back but not yet reporting its lease state, or reporting an abstaining acceptor. `settleTimedOut` lists peers that
 * would still block but have had LEASE_PEER_SETTLE_TIMEOUT_MS since their restart: they no longer hold updates back.
 * An offline peer that is not updating does not block: waiting would not bring it back.
 */
export function leaseUpdateBlockers(
  view: LeaseUpdateView,
  memberId: string,
  now: number
): { blockers: LeaseUpdateBlocker[]; settleTimedOut: LeaseUpdateBlocker[] } {
  const blockers: LeaseUpdateBlocker[] = [];
  const settleTimedOut: LeaseUpdateBlocker[] = [];
  for (const policyId of leasePoliciesOf(view.topology, memberId)) {
    for (const peerId of [...(view.topology.policyMembers.get(policyId) ?? [])].sort()) {
      if (peerId === memberId) continue;
      const state = view.states.get(peerId);
      if (!state) continue;
      if (state.updating) {
        blockers.push({ memberId: peerId, policyId, reason: 'updating' });
        continue;
      }
      let reason: LeaseUpdateBlockReason | null = null;
      if (state.since !== null) {
        if (state.reportedAt === null || state.reportedAt < state.since) reason = 'reconnecting';
        else if (state.abstaining) reason = 'abstaining';
        if (reason && now - state.since >= LEASE_PEER_SETTLE_TIMEOUT_MS) {
          settleTimedOut.push({ memberId: peerId, policyId, reason });
          continue;
        }
      } else if (
        state.abstaining &&
        state.reportedAt !== null &&
        now - state.reportedAt <= LEASE_RELAY_REPORT_FRESH_MS
      ) {
        // A relay: no session start is known, its fresh report says it abstains.
        reason = 'abstaining';
      }
      if (reason) blockers.push({ memberId: peerId, policyId, reason });
    }
  }
  return { blockers, settleTimedOut };
}

const ACTIVE_RELAY_UPDATE_STEP_STATES = ['draining', 'updating', 'verifying', 'rolling_back'] as const;
const ACTIVE_NODE_UPDATE_PHASES = new Set(['executing', 'reconnecting']);

/** Reads the lease policies, their voters, candidates and holders, and every member's update and report state. */
export async function loadLeaseUpdateView(
  db: DrizzleClient,
  registry: Pick<NodeRegistryService, 'getNode'>
): Promise<LeaseUpdateView> {
  const states = await db
    .select({
      policyId: dockerAvailabilityLeaseState.policyId,
      quorumSets: dockerAvailabilityLeaseState.quorumSets,
      voterMembers: dockerAvailabilityLeaseState.voterMembers,
      candidateMemberIds: dockerAvailabilityLeaseState.candidateMemberIds,
    })
    .from(dockerAvailabilityLeaseState)
    .where(ne(dockerAvailabilityLeaseState.mode, 'legacy'));
  const policyMembers = new Map<string, Set<string>>();
  for (const state of states) {
    const members = new Set<string>();
    for (const set of state.quorumSets ?? []) for (const id of set) members.add(id);
    for (const voter of state.voterMembers ?? []) if (voter.id) members.add(voter.id);
    // Candidates of every lease policy kind (Availability's placements below are a superset of its candidates).
    for (const id of state.candidateMemberIds ?? []) members.add(id);
    policyMembers.set(state.policyId, members);
  }
  const policyIds = [...policyMembers.keys()];
  const holders = new Set<string>();
  if (policyIds.length > 0) {
    const [placements, observations] = await Promise.all([
      db
        .select({ policyId: dockerAvailabilityPlacements.policyId, nodeId: dockerAvailabilityPlacements.nodeId })
        .from(dockerAvailabilityPlacements)
        .where(
          and(
            inArray(dockerAvailabilityPlacements.policyId, policyIds),
            ne(dockerAvailabilityPlacements.desiredState, 'removed')
          )
        ),
      db
        .select({
          policyId: dockerAvailabilityLeaseObservations.policyId,
          holderId: dockerAvailabilityLeaseObservations.holderId,
        })
        .from(dockerAvailabilityLeaseObservations)
        .where(
          and(
            inArray(dockerAvailabilityLeaseObservations.policyId, policyIds),
            isNotNull(dockerAvailabilityLeaseObservations.holderId)
          )
        ),
    ]);
    for (const placement of placements) policyMembers.get(placement.policyId)?.add(placement.nodeId);
    for (const observation of observations) {
      if (!observation.holderId) continue;
      holders.add(observation.holderId);
      policyMembers.get(observation.policyId)?.add(observation.holderId);
    }
  }
  const memberIds = new Set([...policyMembers.values()].flatMap((members) => [...members]));
  const peerStates = new Map<string, LeaseUpdatePeerState>();
  if (memberIds.size === 0) return { topology: { policyMembers, holders }, states: peerStates };

  const ids = [...memberIds];
  const [memberRows, nodeRows, relayRows, activeSteps] = await Promise.all([
    db.select().from(availabilityLeaseMembers).where(inArray(availabilityLeaseMembers.memberId, ids)),
    db.select({ id: nodes.id, metadata: nodes.metadata }).from(nodes),
    db.select({ id: relayInstances.id, nodeId: relayInstances.nodeId }).from(relayInstances),
    db
      .select({ relayInstanceId: relayPoolUpdateSteps.relayInstanceId })
      .from(relayPoolUpdateSteps)
      .where(inArray(relayPoolUpdateSteps.state, [...ACTIVE_RELAY_UPDATE_STEP_STATES])),
  ]);
  const members = new Map(memberRows.map((row) => [row.memberId, row]));
  const nodeUpdating = new Map(
    nodeRows.map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      // An update past its deadline (for example one a Gateway restart left behind) no longer holds its peers.
      const deadlineAt =
        typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
      return [
        row.id,
        metadata.updateInProgress === true &&
          ACTIVE_NODE_UPDATE_PHASES.has(String(metadata.updatePhase ?? '')) &&
          !(Number.isFinite(deadlineAt) && Date.now() >= deadlineAt),
      ];
    })
  );
  const relayNode = new Map(relayRows.map((row) => [row.id, row.nodeId]));
  const relaysUpdating = new Set(activeSteps.map((step) => step.relayInstanceId));
  for (const id of ids) {
    const member = members.get(id);
    const reportedAt = member?.reportedAt ? member.reportedAt.getTime() : null;
    const abstaining = member?.abstaining === true;
    if (relayNode.has(id)) {
      const nodeId = relayNode.get(id) ?? null;
      peerStates.set(id, {
        updating: relaysUpdating.has(id) || (nodeId !== null && nodeUpdating.get(nodeId) === true),
        since: null,
        reportedAt,
        abstaining,
      });
      continue;
    }
    const connected = registry.getNode(id);
    peerStates.set(id, {
      updating: nodeUpdating.get(id) === true,
      since: connected ? connected.connectedAt.getTime() : null,
      reportedAt,
      abstaining,
    });
  }
  return { topology: { policyMembers, holders }, states: peerStates };
}
