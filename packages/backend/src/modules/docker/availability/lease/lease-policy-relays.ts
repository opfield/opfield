import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  containerLinkPlacements,
  dockerAvailabilityPlacements,
  type LeasePolicyKind,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedDatabaseBindingPlacements,
  proxyAdditionalSecureLinks,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayRoutes,
} from '@/db/schema/index.js';

/**
 * relay_endpoints.owner_kind of an availability set member endpoint: owner id = the member row id, subject = the
 * member's node (its lease identity). In automatic mode the endpoint is gated by the set's lease policy (relay.v1
 * EndpointPolicy.lease_policy_id); in manual mode only the primary's endpoint serves.
 */
export const MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER = 'managed_availability_member';

/**
 * The relay instances that carry each policy's lease-gated traffic: the relays assigned to the Secure Link endpoint of
 * every Availability member and to the container link endpoint of every target placement, and to the target endpoint
 * of every managed-database binding route of its placements.
 * An old relay ignores lease_policy_id and would admit a stale holder, so each of them must be lease-capable (H4).
 */
export async function loadPolicyRelays(db: DrizzleClient, policyIds: string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (policyIds.length === 0) return result;
  const [members, projections, targets] = await Promise.all([
    db
      .select({ ownerId: proxyAdditionalSecureLinks.id, policyId: dockerAvailabilityPlacements.policyId })
      .from(proxyAdditionalSecureLinks)
      .innerJoin(
        dockerAvailabilityPlacements,
        eq(dockerAvailabilityPlacements.id, proxyAdditionalSecureLinks.referenceId)
      )
      .where(
        and(
          eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
          inArray(dockerAvailabilityPlacements.policyId, policyIds)
        )
      ),
    db
      .select({ ownerId: managedDatabaseBindingPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
      .from(managedDatabaseBindingPlacements)
      .innerJoin(
        dockerAvailabilityPlacements,
        eq(dockerAvailabilityPlacements.id, managedDatabaseBindingPlacements.availabilityPlacementId)
      )
      .where(inArray(dockerAvailabilityPlacements.policyId, policyIds)),
    db
      .select({ ownerId: containerLinkPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
      .from(containerLinkPlacements)
      .innerJoin(
        dockerAvailabilityPlacements,
        eq(dockerAvailabilityPlacements.id, containerLinkPlacements.availabilityPlacementId)
      )
      .where(
        and(eq(containerLinkPlacements.role, 'target'), inArray(dockerAvailabilityPlacements.policyId, policyIds))
      ),
  ]);
  const policyOfMember = new Map(members.map((row) => [row.ownerId, row.policyId]));
  const policyOfProjection = new Map(projections.map((row) => [row.ownerId, row.policyId]));
  const policyOfTarget = new Map(targets.map((row) => [row.ownerId, row.policyId]));
  const [endpoints, routes, targetEndpoints] = await Promise.all([
    policyOfMember.size
      ? db
          .select({ endpointId: relayEndpoints.id, ownerId: relayEndpoints.ownerId })
          .from(relayEndpoints)
          .where(
            and(
              eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
              inArray(relayEndpoints.ownerId, [...policyOfMember.keys()])
            )
          )
      : [],
    policyOfProjection.size
      ? db
          .select({ endpointId: relayRoutes.targetEndpointId, ownerId: relayRoutes.ownerId })
          .from(relayRoutes)
          .where(
            and(
              eq(relayRoutes.ownerKind, 'managed_database_binding'),
              inArray(relayRoutes.ownerId, [...policyOfProjection.keys()])
            )
          )
      : [],
    policyOfTarget.size
      ? db
          .select({ endpointId: relayEndpoints.id, ownerId: relayEndpoints.ownerId })
          .from(relayEndpoints)
          .where(
            and(
              eq(relayEndpoints.ownerKind, 'container_link'),
              inArray(relayEndpoints.ownerId, [...policyOfTarget.keys()])
            )
          )
      : [],
  ]);
  const policiesOfEndpoint = new Map<string, Set<string>>();
  const add = (endpointId: string, policyId: string | undefined) => {
    if (!policyId) return;
    const set = policiesOfEndpoint.get(endpointId) ?? new Set<string>();
    set.add(policyId);
    policiesOfEndpoint.set(endpointId, set);
  };
  for (const row of endpoints) add(row.endpointId, policyOfMember.get(row.ownerId));
  for (const row of routes) add(row.endpointId, policyOfProjection.get(row.ownerId));
  for (const row of targetEndpoints) add(row.endpointId, policyOfTarget.get(row.ownerId));
  return relaysOfEndpoints(db, policiesOfEndpoint);
}

/**
 * The relays that carry each availability set's lease policy traffic (AS12/M7): every relay assigned to a member
 * endpoint of the set. Every route of a set (bindings, links, Gateway tools, backups, monitoring, member peer routes)
 * targets a member endpoint, so these are all the relays that carry it; each of them shadow-accepts the policy.
 */
export async function loadManagedSetLeaseRelays(
  db: DrizzleClient,
  leasePolicyIds: string[]
): Promise<Map<string, Set<string>>> {
  if (leasePolicyIds.length === 0) return new Map();
  const members = await db
    .select({ memberId: managedAvailabilityMembers.id, leasePolicyId: managedAvailabilitySets.leasePolicyId })
    .from(managedAvailabilityMembers)
    .innerJoin(managedAvailabilitySets, eq(managedAvailabilitySets.id, managedAvailabilityMembers.setId))
    .where(inArray(managedAvailabilitySets.leasePolicyId, leasePolicyIds));
  const policyOfMember = new Map(
    members.flatMap((row) => (row.leasePolicyId ? [[row.memberId, row.leasePolicyId]] : []))
  );
  if (policyOfMember.size === 0) return new Map();
  const endpoints = await db
    .select({ endpointId: relayEndpoints.id, ownerId: relayEndpoints.ownerId })
    .from(relayEndpoints)
    .where(
      and(
        eq(relayEndpoints.ownerKind, MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER),
        inArray(relayEndpoints.ownerId, [...policyOfMember.keys()])
      )
    );
  const policiesOfEndpoint = new Map<string, Set<string>>();
  for (const row of endpoints) {
    const policyId = policyOfMember.get(row.ownerId);
    if (policyId) policiesOfEndpoint.set(row.endpointId, new Set([policyId]));
  }
  return relaysOfEndpoints(db, policiesOfEndpoint);
}

/** Carrying relays of lease policies of any kind. */
export async function loadLeasePolicyRelays(
  db: DrizzleClient,
  policies: Array<{ kind: LeasePolicyKind; leasePolicyId: string }>
): Promise<Map<string, Set<string>>> {
  const ids = (kind: LeasePolicyKind) =>
    policies.filter((policy) => policy.kind === kind).map((policy) => policy.leasePolicyId);
  const [availability, databases] = await Promise.all([
    loadPolicyRelays(db, ids('docker_availability')),
    loadManagedSetLeaseRelays(db, ids('managed_availability_set')),
  ]);
  return new Map([...availability, ...databases]);
}

/** Relays assigned (active, staging or draining) to the endpoints, collected per lease policy. */
async function relaysOfEndpoints(
  db: DrizzleClient,
  policiesOfEndpoint: Map<string, Set<string>>
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (policiesOfEndpoint.size === 0) return result;
  const assignments = await db
    .select({
      endpointId: relayEndpointAssignmentGenerations.endpointId,
      relayInstanceId: relayEndpointAssignments.relayInstanceId,
    })
    .from(relayEndpointAssignments)
    .innerJoin(
      relayEndpointAssignmentGenerations,
      eq(relayEndpointAssignmentGenerations.id, relayEndpointAssignments.assignmentGenerationId)
    )
    .where(
      and(
        inArray(relayEndpointAssignmentGenerations.endpointId, [...policiesOfEndpoint.keys()]),
        inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])
      )
    );
  for (const { endpointId, relayInstanceId } of assignments) {
    for (const policyId of policiesOfEndpoint.get(endpointId) ?? []) {
      const set = result.get(policyId) ?? new Set<string>();
      set.add(relayInstanceId);
      result.set(policyId, set);
    }
  }
  return result;
}
