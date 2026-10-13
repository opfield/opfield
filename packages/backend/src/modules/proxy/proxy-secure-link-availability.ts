import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  nodes,
  type proxyAdditionalSecureLinks,
} from '@/db/schema/index.js';
// Daemons that gate Availability member sockets and connectors by the data-plane lease (D8): any lease protocol
// version (availability_lease_v2 since rc.20, availability_lease_v1 before) understands dormant members.
import { AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES } from '@/modules/docker/availability/lease/lease-constants.js';

type LinkRow = typeof proxyAdditionalSecureLinks.$inferSelect;

export interface AvailabilityMemberSyncContext {
  /** The daemon receiving the bindings understands dormant members. */
  leaseCapable: boolean;
  policyByPlacement: Map<string, string>;
  /** Policies in lease mode: only their members are gated by the lease (B2). */
  leasePolicies: ReadonlySet<string>;
}

/** Lease fields of an Availability member binding in SyncProxySecureLinksCommand. */
export interface AvailabilityMemberBindingFields {
  dormant?: boolean;
  availabilityPolicyId?: string;
  availabilityCandidateId?: string;
}

/**
 * What a secure-link sync needs to describe Availability members: whether the daemon understands dormant members,
 * and the lease policy of each member's placement. Nothing is queried when the node has no Availability member.
 */
export async function availabilityMemberSyncContext(
  db: DrizzleClient,
  nodeId: string,
  bindings: LinkRow[]
): Promise<AvailabilityMemberSyncContext> {
  const placementIds = bindings
    .filter((binding) => binding.purpose === 'availability_member' && binding.referenceId)
    .map((binding) => binding.referenceId!);
  if (placementIds.length === 0) return { leaseCapable: false, policyByPlacement: new Map(), leasePolicies: new Set() };
  const [[node], placements, leaseStates] = await Promise.all([
    db.select({ capabilities: nodes.capabilities }).from(nodes).where(eq(nodes.id, nodeId)).limit(1),
    db
      .select({ id: dockerAvailabilityPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
      .from(dockerAvailabilityPlacements)
      .where(inArray(dockerAvailabilityPlacements.id, placementIds)),
    db
      .select({ policyId: dockerAvailabilityLeaseState.policyId })
      .from(dockerAvailabilityLeaseState)
      .where(eq(dockerAvailabilityLeaseState.mode, 'lease')),
  ]);
  const reported = (node?.capabilities as Record<string, unknown> | null | undefined)?.capabilities;
  return {
    leaseCapable:
      Array.isArray(reported) &&
      AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES.some((capability) => reported.includes(capability)),
    policyByPlacement: new Map(placements.map((placement) => [placement.id, placement.policyId])),
    leasePolicies: new Set(leaseStates.map(({ policyId }) => policyId)),
  };
}

/**
 * A daemon without any lease protocol would serve a dormant member like any other; it never receives one, so a
 * standby is reachable only through daemons that open its socket only while it holds the lease.
 */
export function syncableAvailabilityMember(binding: LinkRow, context: AvailabilityMemberSyncContext): boolean {
  return !binding.dormant || context.leaseCapable;
}

export function availabilityMemberBindingFields(
  binding: LinkRow,
  context: AvailabilityMemberSyncContext
): AvailabilityMemberBindingFields {
  if (binding.purpose !== 'availability_member' || !binding.referenceId) return {};
  const policyId = context.policyByPlacement.get(binding.referenceId);
  if (!policyId) return { dormant: binding.dormant };
  if (!context.leasePolicies.has(policyId)) {
    // B2 + B-12c: outside lease mode (legacy, bootstrapping, closing) a member whose copy serves is a plain link: its
    // socket listens and no lease gates it, so entering or leaving lease mode never closes the serving copy's socket.
    // Every other member (a standby, a stopped copy) is sent dormant AND gated: the nginx daemon keeps its socket
    // closed (no relay gate view ever names it) and the Docker daemon keeps its endpoint dormant, so nginx never sends
    // a request, a POST included, to a copy that does not run; it only fails a connect and tries the next member.
    // Before, a dormant member without the policy kept an open socket in every mode but lease.
    if (!binding.dormant) return { dormant: false };
    return { dormant: true, availabilityPolicyId: policyId, availabilityCandidateId: binding.dockerNodeId };
  }
  // In lease mode the lease, not the member's dormant flag, decides where the workload runs (D8), and Opfield learns
  // it after the fact: a successor's container starts after Opfield already marked its member live, and a takeover
  // happens while Opfield still marks the member dormant. Every lease-mode member is sent dormant, so a target daemon
  // keeps it committed while its container is stopped and binds it once the holder starts, instead of rejecting the
  // whole set; a rejected member used to be dropped from the node's committed bindings.
  return { dormant: true, availabilityPolicyId: policyId, availabilityCandidateId: binding.dockerNodeId };
}
