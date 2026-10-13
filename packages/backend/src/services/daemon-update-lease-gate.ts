import { and, inArray, isNotNull, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  availabilityLeaseMembers,
  dockerAvailabilityLeaseObservations,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  managedAvailabilityMembers,
  managedAvailabilitySets,
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
/**
 * How long a database or storage set member that is catching up (a copy not eligible again after its node restarted)
 * holds back the updates of the other members of its set before they go on without it (a large copy may take long).
 */
export const AVAILABILITY_CATCH_UP_TIMEOUT_MS = 15 * 60_000;
/** A set member's report counts while this fresh (members report with every heartbeat). */
const SET_MEMBER_REPORT_FRESH_MS = 45_000;
/** Pseudo policy of a manual database or storage pair (it has no lease policy): its two members update one by one. */
export const AVAILABILITY_SET_POLICY_PREFIX = 'availability-set:';
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
  /**
   * Policies (a set's lease policy, or the pseudo policy of a manual pair) in which this node's set member is a copy
   * that is not eligible to take over yet: the other members of that set wait (database and storage availability).
   */
  catchingUpIn?: Set<string>;
  /**
   * Policies of database and storage sets this node holds a data member of. Only those members wait for a catching-up
   * copy: a witness (a relay or a docker node) has no data the copy protects, so it never waits for one.
   */
  dataMemberIn?: Set<string>;
}

/**
 * Why a member waits. `ingress_last`: an ingress (nginx) node of a batch waits for the other nodes of the batch to
 * finish their updates (the blocker's memberId is that node; it has no policy).
 */
export type LeaseUpdateBlockReason =
  | 'updating'
  | 'reconnecting'
  | 'abstaining'
  | 'ingress_last'
  | 'availability_catching_up';

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
      // A manual pair's pseudo policy has no lease reports: only updates and catching up count there.
      const pseudo = policyId.startsWith(AVAILABILITY_SET_POLICY_PREFIX);
      if (!pseudo && state.since !== null) {
        if (state.reportedAt === null || state.reportedAt < state.since) reason = 'reconnecting';
        else if (state.abstaining) reason = 'abstaining';
        if (reason && now - state.since >= LEASE_PEER_SETTLE_TIMEOUT_MS) {
          settleTimedOut.push({ memberId: peerId, policyId, reason });
          continue;
        }
      } else if (
        !pseudo &&
        state.abstaining &&
        state.reportedAt !== null &&
        now - state.reportedAt <= LEASE_RELAY_REPORT_FRESH_MS
      ) {
        // A relay: no session start is known, its fresh report says it abstains.
        reason = 'abstaining';
      }
      if (reason) {
        blockers.push({ memberId: peerId, policyId, reason });
        continue;
      }
      // A connected copy of a database or storage set that is not eligible again yet holds its set's other data
      // members (never its witnesses).
      if (
        state.since !== null &&
        state.catchingUpIn?.has(policyId) &&
        view.states.get(memberId)?.dataMemberIn?.has(policyId)
      ) {
        const blocker: LeaseUpdateBlocker = { memberId: peerId, policyId, reason: 'availability_catching_up' };
        if (now - state.since >= AVAILABILITY_CATCH_UP_TIMEOUT_MS) settleTimedOut.push(blocker);
        else blockers.push(blocker);
      }
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
  const { catchingUp, dataMembers } = await addAvailabilitySets(db, registry, policyMembers, holders);
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
      // An update past its deadline (for example one an Opfield restart left behind) no longer holds its peers.
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
      ...(catchingUp.has(id) ? { catchingUpIn: catchingUp.get(id) } : {}),
      ...(dataMembers.has(id) ? { dataMemberIn: dataMembers.get(id) } : {}),
    });
  }
  return { topology: { policyMembers, holders }, states: peerStates };
}

/**
 * Eligibility reasons a copy does not get over by catching up (it needs a rebuild, or there is nothing to catch up
 * with): such a copy holds no update back.
 */
const NOT_CATCHING_UP_REASONS = new Set([
  'other_history',
  'no_certified_state',
  'certified_state_unreadable',
  'removing',
  'stopped',
  'volume_not_registered',
]);

/**
 * Database and storage availability sets in the update topology: a manual pair (no lease policy) becomes a pseudo
 * policy of its two member nodes with its primary as holder, so its members update one at a time, the copy first.
 * Every set marks its copies that are not eligible to take over yet (catching up after a restart): the set's other
 * data members wait for them. A paused set's stopped copies do not count, nor do the copies of a set without a
 * primary that serves (no lease holder; a manual pair's primary not reporting): there is nothing they catch up with.
 */
async function addAvailabilitySets(
  db: Pick<DrizzleClient, 'select'>,
  registry: Pick<NodeRegistryService, 'getNode'>,
  policyMembers: Map<string, Set<string>>,
  holders: Set<string>
): Promise<{ catchingUp: Map<string, Set<string>>; dataMembers: Map<string, Set<string>> }> {
  const [sets, members, observations] = await Promise.all([
    db
      .select({
        id: managedAvailabilitySets.id,
        mode: managedAvailabilitySets.mode,
        leasePolicyId: managedAvailabilitySets.leasePolicyId,
        primaryMemberId: managedAvailabilitySets.primaryMemberId,
        state: managedAvailabilitySets.state,
        operation: managedAvailabilitySets.operation,
      })
      .from(managedAvailabilitySets),
    db
      .select({
        id: managedAvailabilityMembers.id,
        setId: managedAvailabilityMembers.setId,
        nodeId: managedAvailabilityMembers.nodeId,
        desiredState: managedAvailabilityMembers.desiredState,
        eligible: managedAvailabilityMembers.eligible,
        eligibilityReason: managedAvailabilityMembers.eligibilityReason,
        lastReportedAt: managedAvailabilityMembers.lastReportedAt,
        enginePosition: managedAvailabilityMembers.enginePosition,
      })
      .from(managedAvailabilityMembers),
    db
      .select({
        policyId: dockerAvailabilityLeaseObservations.policyId,
        slot: dockerAvailabilityLeaseObservations.slot,
        holderId: dockerAvailabilityLeaseObservations.holderId,
      })
      .from(dockerAvailabilityLeaseObservations)
      .where(isNotNull(dockerAvailabilityLeaseObservations.holderId)),
  ]);
  const leaseHolder = new Map<string, string>();
  for (const observation of observations) {
    if (observation.slot === 0 && observation.holderId) leaseHolder.set(observation.policyId, observation.holderId);
  }
  return planAvailabilitySetGate({
    sets,
    members,
    leaseHolder,
    policyMembers,
    holders,
    now: Date.now(),
    connectedAt: (nodeId) => registry.getNode(nodeId)?.connectedAt?.getTime() ?? null,
  });
}

export interface AvailabilitySetGateInput {
  sets: Array<{
    id: string;
    leasePolicyId: string | null;
    primaryMemberId: string | null;
    state: string;
    operation: { kind: string } | null;
  }>;
  members: Array<{
    id: string;
    setId: string;
    nodeId: string;
    desiredState: string;
    eligible: boolean;
    eligibilityReason: string | null;
    lastReportedAt: Date | null;
    enginePosition: unknown;
  }>;
  /** Lease policy id -> node holding its slot 0. */
  leaseHolder: Map<string, string>;
  policyMembers: Map<string, Set<string>>;
  holders: Set<string>;
  now: number;
  /** When a node's current control session started (null: not connected). */
  connectedAt(nodeId: string): number | null;
}

/** See addAvailabilitySets: the sets' pseudo policies, catching-up copies and data members. */
export function planAvailabilitySetGate(input: AvailabilitySetGateInput): {
  catchingUp: Map<string, Set<string>>;
  dataMembers: Map<string, Set<string>>;
} {
  const { sets, members, leaseHolder, policyMembers, holders, now } = input;
  const catchingUp = new Map<string, Set<string>>();
  const dataMembers = new Map<string, Set<string>>();
  for (const set of sets) {
    // A set that has not converged yet (create or convert running, or failed and being turned off) or is being turned
    // off holds no update: there is no replication to protect, and its copies may never become eligible.
    if (!setHoldsUpdates(set)) continue;
    const active = members.filter((member) => member.setId === set.id && member.desiredState === 'member');
    if (active.length === 0) continue;
    let policyId = set.leasePolicyId && policyMembers.has(set.leasePolicyId) ? set.leasePolicyId : null;
    const primary = active.find((member) => member.id === set.primaryMemberId);
    // Whether a member serves: the set's lease holder; a manual pair's primary while it reports.
    const serving = policyId
      ? active.some((member) => member.nodeId === leaseHolder.get(policyId!))
      : !!primary?.lastReportedAt && now - primary.lastReportedAt.getTime() <= SET_MEMBER_REPORT_FRESH_MS;
    if (!policyId) {
      policyId = `${AVAILABILITY_SET_POLICY_PREFIX}${set.id}`;
      policyMembers.set(policyId, new Set(active.map((member) => member.nodeId)));
      if (primary) holders.add(primary.nodeId);
    }
    for (const member of active) {
      const policies = dataMembers.get(member.nodeId) ?? new Set<string>();
      policies.add(policyId);
      dataMembers.set(member.nodeId, policies);
    }
    if (!serving) continue;
    for (const member of active) {
      if (member.id === set.primaryMemberId) continue;
      if (member.eligibilityReason && NOT_CATCHING_UP_REASONS.has(member.eligibilityReason)) continue;
      const position = (member.enginePosition ?? {}) as Record<string, unknown>;
      if (position['runtime.stopped'] === 'true') continue;
      // A member that never reported never ran (its configuration never arrived): it is not catching up.
      if (!member.lastReportedAt) continue;
      const fresh = !!member.lastReportedAt && now - member.lastReportedAt.getTime() <= SET_MEMBER_REPORT_FRESH_MS;
      // A report from before the node's current session describes the member before its restart.
      const connectedAt = input.connectedAt(member.nodeId);
      const sinceRestart =
        connectedAt === null || (!!member.lastReportedAt && member.lastReportedAt.getTime() >= connectedAt);
      if (fresh && sinceRestart && member.eligible) continue;
      const policies = catchingUp.get(member.nodeId) ?? new Set<string>();
      policies.add(policyId);
      catchingUp.set(member.nodeId, policies);
    }
  }
  return { catchingUp, dataMembers };
}

/** Operations during which a set has not converged (its copies are being seeded, or it is being turned off). */
const UNCONVERGED_OPERATIONS = new Set(['create', 'convert', 'disable']);

/** Whether a set's members sequence the daemon updates of their nodes (see addAvailabilitySets). */
export function setHoldsUpdates(set: { state: string; operation: { kind: string } | null }): boolean {
  if (set.state === 'converting' || set.state === 'closing') return false;
  return !(set.operation && UNCONVERGED_OPERATIONS.has(set.operation.kind));
}
