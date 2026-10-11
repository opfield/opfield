import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityLeaseState,
  leasePolicies,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedAvailabilityWitnesses,
  relayInstances,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { relayMayHostWitnesses } from '@/services/relay-witness-hosting.js';
import { AVAILABILITY_LEASE_V3_CAPABILITY, MANAGED_AVAILABILITY_MEMBER_CAPABILITY } from './lease-constants.js';
import type {
  LeaseDegradedChange,
  LeaseHolderChangeNotice,
  LeaseModeChange,
  LeasePolicyCandidate,
  LeasePolicyDescriptor,
  LeasePolicySource,
} from './lease-policy-source.js';

const logger = createChildLogger('ManagedAvailabilityLeaseSource');

/** The capabilities every participant of a set's lease policy needs: v3 everywhere, the member runtime on candidates. */
export const MANAGED_AVAILABILITY_LEASE_CAPABILITIES = [
  AVAILABILITY_LEASE_V3_CAPABILITY,
  MANAGED_AVAILABILITY_MEMBER_CAPABILITY,
] as const;

/** Voters a set of 2 data members asks for, so one data node and one witness can be lost without Gateway. */
export const TWO_MEMBER_PREFERRED_VOTERS = 5;

/**
 * The control plane of availability sets (commercial orchestration) attaches here to follow its sets' leases. The
 * callbacks run after the host persisted the change; a failure is logged and the controller reads the persisted state
 * on its next reconcile.
 */
export interface ManagedAvailabilitySetController {
  holderChanged?(change: LeaseHolderChangeNotice): Promise<void>;
  modeChanged?(change: LeaseModeChange): Promise<void>;
  degradedChanged?(change: LeaseDegradedChange): Promise<void>;
}

/** Candidate order (D5): higher priority first, then the member index. The lease identity is the member's node id. */
export function setLeaseCandidates(
  members: Array<{ id: string; nodeId: string; priority: number; memberIndex: number }>
): LeasePolicyCandidate[] {
  return [...members]
    .sort((left, right) => right.priority - left.priority || left.memberIndex - right.memberIndex)
    .map((member, rank) => ({ memberId: member.nodeId, nodeId: member.nodeId, rank }));
}

/**
 * Which witnesses a set may get (decision 7): relays with the admin flag whose supervisor reports local hosting
 * allowed, and any docker node outside the members' hosts (the host's eligibility rules). Witnesses the admin picked
 * for the set narrow that to the picked ones that are still allowed.
 */
export function setWitnessFilter(input: {
  allowedRelayIds: readonly string[];
  picked: Array<{ hostKind: 'relay' | 'node'; relayInstanceId: string | null; nodeId: string | null }>;
}): NonNullable<LeasePolicyDescriptor['witnessFilter']> {
  if (input.picked.length === 0) return { relayIds: [...input.allowedRelayIds].sort() };
  const allowed = new Set(input.allowedRelayIds);
  return {
    relayIds: input.picked
      .flatMap((witness) => (witness.hostKind === 'relay' && witness.relayInstanceId ? [witness.relayInstanceId] : []))
      .filter((id) => allowed.has(id))
      .sort(),
    nodeIds: input.picked
      .flatMap((witness) => (witness.hostKind === 'node' && witness.nodeId ? [witness.nodeId] : []))
      .sort(),
  };
}

/**
 * Database and storage availability sets in automatic mode as a lease policy source. Each set's lease policy has one
 * slot (the primary role), is stateful (lease v3: the engine certifies who may take over) and strict, and gets a fresh
 * id on every enable. The host never closes it by itself (AS9): only closeSetPolicy does. A lease policy of a set that
 * is no longer the set's current one (an earlier period) is listed closed until it returned to legacy.
 */
export class ManagedAvailabilityLeaseSource implements LeasePolicySource {
  readonly kind = 'managed_availability_set' as const;
  private controller: ManagedAvailabilitySetController | null = null;

  constructor(private readonly db: DrizzleClient) {}

  attachController(controller: ManagedAvailabilitySetController): void {
    this.controller = controller;
  }

  async listDesired(): Promise<LeasePolicyDescriptor[]> {
    const registered = await this.db
      .select({
        leasePolicyId: leasePolicies.id,
        setId: leasePolicies.managedAvailabilitySetId,
        closeRequested: dockerAvailabilityLeaseState.legacyRequested,
        mode: dockerAvailabilityLeaseState.mode,
      })
      .from(leasePolicies)
      .leftJoin(dockerAvailabilityLeaseState, eq(dockerAvailabilityLeaseState.policyId, leasePolicies.id))
      .where(
        and(eq(leasePolicies.kind, 'managed_availability_set'), isNotNull(leasePolicies.managedAvailabilitySetId))
      );
    if (registered.length === 0) return [];
    const setIds = [...new Set(registered.flatMap((row) => (row.setId ? [row.setId] : [])))];
    const [sets, members, witnesses, relays] = await Promise.all([
      this.db
        .select({
          id: managedAvailabilitySets.id,
          engine: managedAvailabilitySets.engine,
          mode: managedAvailabilitySets.mode,
          state: managedAvailabilitySets.state,
          leasePolicyId: managedAvailabilitySets.leasePolicyId,
          primaryMemberId: managedAvailabilitySets.primaryMemberId,
          ownerKind: managedAvailabilitySets.ownerKind,
          ownerId: managedAvailabilitySets.ownerId,
        })
        .from(managedAvailabilitySets)
        .where(inArray(managedAvailabilitySets.id, setIds)),
      this.db
        .select({
          id: managedAvailabilityMembers.id,
          setId: managedAvailabilityMembers.setId,
          nodeId: managedAvailabilityMembers.nodeId,
          priority: managedAvailabilityMembers.priority,
          memberIndex: managedAvailabilityMembers.memberIndex,
          desiredState: managedAvailabilityMembers.desiredState,
        })
        .from(managedAvailabilityMembers)
        .where(inArray(managedAvailabilityMembers.setId, setIds)),
      this.db
        .select({
          setId: managedAvailabilityWitnesses.setId,
          hostKind: managedAvailabilityWitnesses.hostKind,
          relayInstanceId: managedAvailabilityWitnesses.relayInstanceId,
          nodeId: managedAvailabilityWitnesses.nodeId,
        })
        .from(managedAvailabilityWitnesses)
        .where(
          and(
            inArray(managedAvailabilityWitnesses.setId, setIds),
            eq(managedAvailabilityWitnesses.purpose, 'lease'),
            ne(managedAvailabilityWitnesses.desiredState, 'removed')
          )
        ),
      this.db
        .select({
          id: relayInstances.id,
          witnessHostingAllowed: relayInstances.witnessHostingAllowed,
          witnessHostingLocal: relayInstances.witnessHostingLocal,
        })
        .from(relayInstances),
    ]);
    const allowedRelayIds = relays.filter((relay) => relayMayHostWitnesses(relay)).map((relay) => relay.id);
    const setById = new Map(sets.map((set) => [set.id, set]));
    const descriptors: LeasePolicyDescriptor[] = [];
    for (const row of registered) {
      const set = row.setId ? setById.get(row.setId) : undefined;
      if (!set) continue;
      const current = set.leasePolicyId === row.leasePolicyId && set.mode === 'automatic';
      // An earlier period's policy is only listed until it is back in legacy (closed below).
      if (!current && (row.mode ?? 'legacy') === 'legacy') continue;
      const setMembers = members.filter((member) => member.setId === set.id);
      const candidates = setLeaseCandidates(setMembers.filter((member) => member.desiredState === 'member'));
      const primary = setMembers.find((member) => member.id === set.primaryMemberId);
      descriptors.push({
        leasePolicyId: row.leasePolicyId,
        kind: 'managed_availability_set',
        resourceId: set.id,
        resourceName: `${set.ownerKind}:${set.ownerId}`,
        mode: 'failover',
        slots: 1,
        partitionMode: 'strict',
        stateful: true,
        candidates,
        witnessMemberId: null,
        witnessFilter: setWitnessFilter({
          allowedRelayIds,
          picked: witnesses.filter((witness) => witness.setId === set.id),
        }),
        ...(candidates.length === 2 ? { preferredVoterCount: TWO_MEMBER_PREFERRED_VOTERS } : {}),
        // The bootstrap reserves the slot for the member that serves now, so the switch to the lease never moves it.
        bootstrap: primary ? [{ slot: 0, holderMemberId: primary.nodeId }] : null,
        closed: !current || row.closeRequested === true,
        requiredCapabilities: [...MANAGED_AVAILABILITY_LEASE_CAPABILITIES],
        specFingerprint: set.engine,
        servingMemberIds: primary ? [primary.nodeId] : [],
        // Seeding a new member or converting a single node runs outside the lease; it starts once that is done.
        entryHold: set.state === 'converting',
      });
    }
    return descriptors;
  }

  async holderChanged(change: LeaseHolderChangeNotice): Promise<void> {
    await this.deliver('holder change', change.policyId, () => this.controller?.holderChanged?.(change));
  }

  async modeChanged(change: LeaseModeChange): Promise<void> {
    await this.deliver('mode change', change.leasePolicyId, () => this.controller?.modeChanged?.(change));
  }

  async degradedChanged(change: LeaseDegradedChange): Promise<void> {
    await this.deliver('degraded change', change.leasePolicyId, () => this.controller?.degradedChanged?.(change));
  }

  private async deliver(what: string, leasePolicyId: string, call: () => Promise<void> | undefined): Promise<void> {
    try {
      await call();
    } catch (error) {
      logger.warn(`The availability set controller did not take a lease ${what}`, {
        leasePolicyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
