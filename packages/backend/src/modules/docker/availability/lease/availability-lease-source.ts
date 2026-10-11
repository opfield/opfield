import { and, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityLeaseState,
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AVAILABILITY_LEASE_CAPABILITY } from './lease-constants.js';
import {
  AVAILABILITY_CONTROLLER_UNSUPPORTED,
  AVAILABILITY_DISABLED,
  AVAILABILITY_LEGACY_REQUESTED,
} from './lease-gating.js';
import { leaseIngressNodesOfPlacements } from './lease-participants.js';
import { bootstrapFromServing, leaseCandidatePlacements, orderLeaseCandidates } from './lease-planning.js';
import type {
  LeaseHolderChangeNotice,
  LeaseModeChange,
  LeasePolicyDescriptor,
  LeasePolicySource,
} from './lease-policy-source.js';
import type { DockerAvailabilityLeaseController } from './lease-types.js';

const logger = createChildLogger('AvailabilityLeaseSource');

/**
 * D1: operations that change the workload's runtime on the legacy path. Lease bootstrap waits until none of them is
 * pending, waiting or running: the switch never lands in the middle of one (stand run rc20 B-1: bootstrapping began 5 s
 * into an enable, reserved no holder because the origin was not recorded serving yet, and the daemons' lease gate
 * then refused the enable's own activation).
 */
const BOOTSTRAP_WAITS_FOR_OPERATIONS = ['enable', 'rollout'] as const;

/**
 * Docker Availability as a lease policy source (the first kind). Every Availability policy is its own lease policy
 * (same id). The paid controller decides placements and attaches here; without one (Community, or no license) every
 * policy stays on the legacy backend-driven path.
 */
export class AvailabilityLeaseSource implements LeasePolicySource {
  readonly kind = 'docker_availability' as const;
  private controller: DockerAvailabilityLeaseController | null = null;

  constructor(private readonly db: DrizzleClient) {}

  attachController(controller: DockerAvailabilityLeaseController): void {
    this.controller = controller;
  }

  /** Every policy with Availability enabled, and every disabled one whose lease has not returned to legacy yet. */
  async listDesired(): Promise<LeasePolicyDescriptor[]> {
    const controllerSupportsLease = this.controller?.leaseModeSupported() === true;
    const policies = await this.db
      .select({
        id: dockerAvailabilityPolicies.id,
        mode: dockerAvailabilityPolicies.mode,
        desiredReplicaCount: dockerAvailabilityPolicies.desiredReplicaCount,
        partitionMode: dockerAvailabilityPolicies.partitionMode,
        priorityMode: dockerAvailabilityPolicies.priorityMode,
        nodePriority: dockerAvailabilityPolicies.nodePriority,
        specFingerprint: dockerAvailabilityPolicies.specFingerprint,
        witness: dockerAvailabilityPolicies.witness,
        containerName: dockerAvailabilityPolicies.containerName,
        deploymentId: dockerAvailabilityPolicies.deploymentId,
        composeProjectId: dockerAvailabilityPolicies.composeProjectId,
      })
      .from(dockerAvailabilityPolicies);
    if (policies.length === 0) return [];
    const states = await this.db
      .select({
        policyId: dockerAvailabilityLeaseState.policyId,
        mode: dockerAvailabilityLeaseState.mode,
        surgeSlots: dockerAvailabilityLeaseState.surgeSlots,
        legacyRequested: dockerAvailabilityLeaseState.legacyRequested,
      })
      .from(dockerAvailabilityLeaseState)
      .where(
        inArray(
          dockerAvailabilityLeaseState.policyId,
          policies.map((policy) => policy.id)
        )
      );
    const stateByPolicy = new Map(states.map((state) => [state.policyId, state]));
    const relevant = policies.filter(
      (policy) => policy.mode !== 'single' || (stateByPolicy.get(policy.id)?.mode ?? 'legacy') !== 'legacy'
    );
    if (relevant.length === 0) return [];
    const policyIds = relevant.map((policy) => policy.id);
    const [placements, runtimeOperations] = await Promise.all([
      this.db
        .select({
          id: dockerAvailabilityPlacements.id,
          policyId: dockerAvailabilityPlacements.policyId,
          nodeId: dockerAvailabilityPlacements.nodeId,
          desiredState: dockerAvailabilityPlacements.desiredState,
          serving: dockerAvailabilityPlacements.serving,
          createdAt: dockerAvailabilityPlacements.createdAt,
        })
        .from(dockerAvailabilityPlacements)
        .where(inArray(dockerAvailabilityPlacements.policyId, policyIds)),
      this.db
        .select({ policyId: dockerAvailabilityOperations.policyId })
        .from(dockerAvailabilityOperations)
        .where(
          and(
            inArray(dockerAvailabilityOperations.policyId, policyIds),
            inArray(dockerAvailabilityOperations.type, [...BOOTSTRAP_WAITS_FOR_OPERATIONS]),
            inArray(dockerAvailabilityOperations.status, ['pending', 'waiting', 'running'])
          )
        ),
    ]);
    const runtimeChanging = new Set(runtimeOperations.map((operation) => operation.policyId));
    const placementIds = placements.map((placement) => placement.id);
    // Every source of a member link: all members of the route's ingress group, else the route's node.
    const ingressRows = await leaseIngressNodesOfPlacements(this.db, placementIds);
    const policyOfPlacement = new Map(placements.map((placement) => [placement.id, placement.policyId]));
    return relevant.map((policy) => {
      const state = stateByPolicy.get(policy.id);
      const policyPlacements = placements.filter((placement) => placement.policyId === policy.id);
      const candidatePlacements = leaseCandidatePlacements(policyPlacements);
      const ranked = orderLeaseCandidates(policy, policyPlacements);
      // D9: a rollout's surge is a temporary extra slot; failover stays at one slot.
      const slots =
        policy.mode === 'replicated' ? Math.min(32, policy.desiredReplicaCount + (state?.surgeSlots ?? 0)) : 1;
      const unavailable = !controllerSupportsLease
        ? AVAILABILITY_CONTROLLER_UNSUPPORTED
        : state?.legacyRequested
          ? AVAILABILITY_LEGACY_REQUESTED
          : policy.mode === 'single'
            ? AVAILABILITY_DISABLED
            : null;
      return {
        leasePolicyId: policy.id,
        kind: 'docker_availability',
        resourceId: policy.id,
        resourceName: policy.containerName ?? policy.deploymentId ?? policy.composeProjectId ?? policy.id,
        mode: policy.mode === 'replicated' ? 'replicated' : 'failover',
        slots,
        partitionMode: policy.partitionMode,
        stateful: false,
        candidates: ranked.map((nodeId, rank) => ({ memberId: nodeId, nodeId, rank })),
        witnessMemberId: policy.witness,
        bootstrap: bootstrapFromServing(policyPlacements, slots).map((entry) => ({
          slot: entry.slot,
          holderMemberId: entry.holderId,
        })),
        closed: false,
        requiredCapabilities: [AVAILABILITY_LEASE_CAPABILITY],
        specFingerprint: policy.specFingerprint,
        unavailable,
        observerNodeIds: ingressRows
          .filter((row) => row.referenceId && policyOfPlacement.get(row.referenceId) === policy.id)
          .map((row) => row.nodeId),
        servingMemberIds: [
          ...new Set(candidatePlacements.filter((placement) => placement.serving).map((placement) => placement.nodeId)),
        ],
        entryHold: runtimeChanging.has(policy.id),
      } satisfies LeasePolicyDescriptor;
    });
  }

  /** The controller reconciles placements from the holder; it gets the notice without the host's kind fields. */
  async holderChanged(change: LeaseHolderChangeNotice): Promise<void> {
    const { leaseKind: _kind, resourceId: _resource, stateHash: _stateHash, ...notice } = change;
    try {
      await this.controller?.leaseHolderChanged(notice);
    } catch (error) {
      logger.warn('The Availability controller did not take a lease holder change', {
        policyId: change.policyId,
        slot: change.slot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async modeChanged(change: LeaseModeChange): Promise<void> {
    try {
      await this.controller?.leaseModeChanged({
        policyId: change.leasePolicyId,
        from: change.from,
        to: change.to,
        reason: change.reason,
        lastHolders: change.lastHolders,
        retainedHolders: change.retainedHolders,
      });
    } catch (error) {
      logger.warn('The Availability controller did not take a lease mode change', {
        policyId: change.leasePolicyId,
        to: change.to,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
