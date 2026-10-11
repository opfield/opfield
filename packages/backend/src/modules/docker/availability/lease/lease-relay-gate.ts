import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  containerLinkPlacements,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedDatabaseBindingPlacements,
  proxyAdditionalSecureLinks,
} from '@/db/schema/index.js';
import {
  MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER,
  MANAGED_AVAILABILITY_PEER_ENDPOINT_OWNER,
  MANAGED_AVAILABILITY_PRIMARY_PORTS,
} from './lease-policy-relays.js';

/** A relay endpoint or route as the policy snapshot builder knows it. */
export interface RelayLeaseOwner {
  id: string;
  ownerKind: string;
  ownerId: string;
}

/** relay.v1 EndpointPolicy.lease_policy_id (10) and RoutePolicy.lease_policy_id (12), keyed by endpoint or route id. */
export interface RelayLeasePolicyIds {
  endpoints: Map<string, string>;
  routes: Map<string, string>;
}

/**
 * Which relay endpoints and routes the relay must admit only through its lease gate (A2.4, A8, A11): the Secure
 * Link endpoints of every Availability member (serving or dormant), the container link endpoints of every target
 * placement, the managed-database binding routes of every placement (app-side gate), and the member endpoints of every
 * availability set in automatic mode (endpoint gate), for lease policies in lease mode only. Bootstrapping keeps legacy
 * admission so the serving copy keeps its registration until its first commit; closing and legacy clear the field.
 */
export async function relayLeasePolicyIds(
  db: DrizzleClient,
  endpoints: RelayLeaseOwner[],
  routes: RelayLeaseOwner[]
): Promise<RelayLeasePolicyIds> {
  const result: RelayLeasePolicyIds = { endpoints: new Map(), routes: new Map() };
  const linkIds = endpoints.filter((endpoint) => endpoint.ownerKind === 'proxy_host_secure_link').map((e) => e.ownerId);
  const projectionIds = routes.filter((route) => route.ownerKind === 'managed_database_binding').map((r) => r.ownerId);
  const targetIds = endpoints.filter((endpoint) => endpoint.ownerKind === 'container_link').map((e) => e.ownerId);
  const setMemberIds = endpoints
    .filter((endpoint) => endpoint.ownerKind === MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER)
    .map((endpoint) => endpoint.ownerId);
  // A set's resource endpoint (the origin member's client endpoint) and its members' primary peer endpoints.
  const setResourceEndpoints = endpoints.filter(
    (endpoint) => endpoint.ownerKind === 'managed_database' || endpoint.ownerKind === 'managed_storage'
  );
  const setPeerEndpoints = endpoints.filter(
    (endpoint) => endpoint.ownerKind === MANAGED_AVAILABILITY_PEER_ENDPOINT_OWNER
  );
  if (
    linkIds.length === 0 &&
    projectionIds.length === 0 &&
    targetIds.length === 0 &&
    setMemberIds.length === 0 &&
    setResourceEndpoints.length === 0 &&
    setPeerEndpoints.length === 0
  )
    return result;
  const leasePolicies = new Set(
    (
      await db
        .select({ policyId: dockerAvailabilityLeaseState.policyId })
        .from(dockerAvailabilityLeaseState)
        .where(eq(dockerAvailabilityLeaseState.mode, 'lease'))
    ).map(({ policyId }) => policyId)
  );
  if (leasePolicies.size === 0) return result;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const [members, projections, targets] = await Promise.all([
    linkIds.some((id) => uuid.test(id))
      ? db
          .select({ ownerId: proxyAdditionalSecureLinks.id, policyId: dockerAvailabilityPlacements.policyId })
          .from(proxyAdditionalSecureLinks)
          .innerJoin(
            dockerAvailabilityPlacements,
            eq(dockerAvailabilityPlacements.id, proxyAdditionalSecureLinks.referenceId)
          )
          .where(
            and(
              eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
              inArray(
                proxyAdditionalSecureLinks.id,
                linkIds.filter((id) => uuid.test(id))
              )
            )
          )
      : [],
    projectionIds.some((id) => uuid.test(id))
      ? db
          .select({ ownerId: managedDatabaseBindingPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
          .from(managedDatabaseBindingPlacements)
          .innerJoin(
            dockerAvailabilityPlacements,
            eq(dockerAvailabilityPlacements.id, managedDatabaseBindingPlacements.availabilityPlacementId)
          )
          .where(
            and(
              isNotNull(managedDatabaseBindingPlacements.availabilityPlacementId),
              inArray(
                managedDatabaseBindingPlacements.id,
                projectionIds.filter((id) => uuid.test(id))
              )
            )
          )
      : [],
    // A container link reaches an Availability target through one endpoint per target placement; the link's own
    // endpoint (a single-node target) is not a placement and stays ungated.
    targetIds.some((id) => uuid.test(id))
      ? db
          .select({ ownerId: containerLinkPlacements.id, policyId: dockerAvailabilityPlacements.policyId })
          .from(containerLinkPlacements)
          .innerJoin(
            dockerAvailabilityPlacements,
            eq(dockerAvailabilityPlacements.id, containerLinkPlacements.availabilityPlacementId)
          )
          .where(
            and(
              eq(containerLinkPlacements.role, 'target'),
              inArray(
                containerLinkPlacements.id,
                targetIds.filter((id) => uuid.test(id))
              )
            )
          )
      : [],
  ]);
  const memberPolicy = new Map(members.map((row) => [row.ownerId, row.policyId]));
  for (const row of targets) memberPolicy.set(`container_link:${row.ownerId}`, row.policyId);
  const projectionPolicy = new Map(projections.map((row) => [row.ownerId, row.policyId]));
  for (const endpoint of endpoints) {
    const policyId =
      endpoint.ownerKind === 'proxy_host_secure_link'
        ? memberPolicy.get(endpoint.ownerId)
        : endpoint.ownerKind === 'container_link'
          ? memberPolicy.get(`container_link:${endpoint.ownerId}`)
          : undefined;
    if (policyId && leasePolicies.has(policyId)) result.endpoints.set(endpoint.id, policyId);
  }
  for (const route of routes) {
    const policyId = route.ownerKind === 'managed_database_binding' ? projectionPolicy.get(route.ownerId) : undefined;
    if (policyId && leasePolicies.has(policyId)) result.routes.set(route.id, policyId);
  }
  await gateSetResourceAndPeerEndpoints(db, setResourceEndpoints, setPeerEndpoints, leasePolicies, result);
  const setMembers = setMemberIds.filter((id) => uuid.test(id));
  if (setMembers.length > 0) {
    // A member endpoint of an availability set admits only the holder of the set's current lease policy (subject =
    // the member's lease identity). Member peer routes stay endpoint-gated only, never source-gated (AS12/M7).
    const memberPolicies = await db
      .select({ memberId: managedAvailabilityMembers.id, leasePolicyId: managedAvailabilitySets.leasePolicyId })
      .from(managedAvailabilityMembers)
      .innerJoin(managedAvailabilitySets, eq(managedAvailabilitySets.id, managedAvailabilityMembers.setId))
      .where(inArray(managedAvailabilityMembers.id, setMembers));
    const policyOfMember = new Map(memberPolicies.map((row) => [row.memberId, row.leasePolicyId]));
    for (const endpoint of endpoints) {
      if (endpoint.ownerKind !== MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER) continue;
      const policyId = policyOfMember.get(endpoint.ownerId);
      if (policyId && leasePolicies.has(policyId)) result.endpoints.set(endpoint.id, policyId);
    }
  }
  return result;
}

/**
 * The resource endpoint of a set in lease mode admits only the lease holder like every member's client endpoint, and
 * so does every member's peer endpoint of a primary port (pg-repl, kv-repl, sw-master). Peer endpoints of the other
 * ports reach each member by its own alias and are never gated.
 */
async function gateSetResourceAndPeerEndpoints(
  db: DrizzleClient,
  resourceEndpoints: RelayLeaseOwner[],
  peerEndpoints: RelayLeaseOwner[],
  leaseModePolicies: ReadonlySet<string>,
  result: RelayLeasePolicyIds
): Promise<void> {
  if (resourceEndpoints.length === 0 && peerEndpoints.length === 0) return;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ownerIds = [...new Set(resourceEndpoints.map((endpoint) => endpoint.ownerId).filter((id) => uuid.test(id)))];
  const peerMembers = peerEndpoints.flatMap((endpoint) => {
    const separator = endpoint.ownerId.indexOf(':');
    const memberId = separator > 0 ? endpoint.ownerId.slice(0, separator) : '';
    const port = separator > 0 ? endpoint.ownerId.slice(separator + 1) : '';
    return uuid.test(memberId) && MANAGED_AVAILABILITY_PRIMARY_PORTS.has(port) ? [{ endpoint, memberId }] : [];
  });
  const [sets, members] = await Promise.all([
    ownerIds.length
      ? db
          .select({
            ownerKind: managedAvailabilitySets.ownerKind,
            ownerId: managedAvailabilitySets.ownerId,
            leasePolicyId: managedAvailabilitySets.leasePolicyId,
          })
          .from(managedAvailabilitySets)
          .where(inArray(managedAvailabilitySets.ownerId, ownerIds))
      : [],
    peerMembers.length
      ? db
          .select({ memberId: managedAvailabilityMembers.id, leasePolicyId: managedAvailabilitySets.leasePolicyId })
          .from(managedAvailabilityMembers)
          .innerJoin(managedAvailabilitySets, eq(managedAvailabilitySets.id, managedAvailabilityMembers.setId))
          .where(
            inArray(
              managedAvailabilityMembers.id,
              peerMembers.map(({ memberId }) => memberId)
            )
          )
      : [],
  ]);
  for (const endpoint of resourceEndpoints) {
    const set = sets.find((entry) => entry.ownerKind === endpoint.ownerKind && entry.ownerId === endpoint.ownerId);
    if (set?.leasePolicyId && leaseModePolicies.has(set.leasePolicyId)) {
      result.endpoints.set(endpoint.id, set.leasePolicyId);
    }
  }
  const policyOfMember = new Map(members.map((row) => [row.memberId, row.leasePolicyId]));
  for (const { endpoint, memberId } of peerMembers) {
    const policyId = policyOfMember.get(memberId);
    if (policyId && leaseModePolicies.has(policyId)) result.endpoints.set(endpoint.id, policyId);
  }
}
