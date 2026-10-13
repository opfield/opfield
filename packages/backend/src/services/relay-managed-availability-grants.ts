import { inArray } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { managedAvailabilityWitnesses, type relayEndpoints, type relayRoutes } from '@/db/schema/index.js';
import {
  isPrimaryMemberPort,
  loadSetRelayViews,
  parentKindOfMemberRoute,
  parsePeerEndpointOwnerId,
  parsePeerRouteOwnerId,
  SET_CLIENT_ENDPOINT_KIND,
  SET_PEER_ENDPOINT_KIND,
  SET_PEER_ROUTE_KIND,
  SET_WITNESS_ENDPOINT_KIND,
  SET_WITNESS_ROUTE_KIND,
  type SetRelayMember,
  type SetRelayView,
  setAnchorEndpointKind,
} from './relay-managed-availability.js';

type EndpointRow = typeof relayEndpoints.$inferSelect;
type RouteRow = typeof relayRoutes.$inferSelect;

/** The relay.v1/opfield.v1 RelayLeaseTarget of a set member as grant bundles carry it. */
export interface SetLeaseTarget {
  setId: string;
  memberId: string;
  candidateId: string;
  leasePolicyId: string;
  rank: number;
  ownerKind: string;
  ownerId: string;
  portName?: string;
  primaryPort?: boolean;
  witnessId?: string;
}

/** The parts of a grant assignment this module reads and writes (see RelayGrantAssignment in the issuer). */
export interface SetGrantAssignment {
  role: string;
  ownerKind: string;
  ownerId: string;
  endpointId?: string;
  routeId?: string;
  targetEndpointId?: string;
  grant: unknown;
  schemaVersion?: number;
  candidates?: unknown[];
  streamResume?: unknown;
  leaseTarget?: SetLeaseTarget;
  leaseGroup?: Array<{
    routeId: string;
    targetEndpointId: string;
    grant: unknown;
    candidates?: unknown[];
    streamResume?: unknown;
    target: SetLeaseTarget;
    schemaVersion?: number;
  }>;
}

function target(view: SetRelayView, member: SetRelayMember, port?: string): SetLeaseTarget {
  return {
    setId: view.setId,
    memberId: member.id,
    candidateId: member.nodeId,
    leasePolicyId: view.leasePolicyId ?? '',
    rank: member.rank,
    ownerKind: view.ownerKind,
    ownerId: view.ownerId,
    ...(port ? { portName: port, primaryPort: isPrimaryMemberPort(view.engine, port) } : {}),
  };
}

/**
 * Whether a bundle can involve an availability set at all (cheap check before loading the sets). Every member node
 * has peer endpoints and every source of a set's resource has member routes, so a bundle without either has nothing
 * of a set.
 */
function mayInvolveSets(grants: SetGrantAssignment[], ownRoutes: RouteRow[]): boolean {
  return (
    grants.some(
      (grant) =>
        grant.ownerKind === SET_CLIENT_ENDPOINT_KIND ||
        grant.ownerKind === SET_PEER_ENDPOINT_KIND ||
        grant.ownerKind === SET_PEER_ROUTE_KIND ||
        grant.ownerKind === SET_WITNESS_ROUTE_KIND ||
        grant.ownerKind === SET_WITNESS_ENDPOINT_KIND ||
        parentKindOfMemberRoute(grant.ownerKind) !== null
    ) || ownRoutes.some((route) => Boolean(route.parentRouteId))
  );
}

/**
 * Completes a node's grant bundle for availability sets:
 * - endpoint assignments of set members (client, peer, and the resource endpoint as the origin member's) name the
 *   member and port they serve (lease_target);
 * - peer route assignments name the member and port they reach;
 * - a route to a set's resource and its member routes become one connect assignment with the group (lease_group):
 *   the resource route's owner, listener and egress, every member's route with its target. The group's own route
 *   fields are its first member's, for daemons that do not know groups.
 * Bundles without set paths are returned as they are.
 */
export async function completeSetGrants<T extends SetGrantAssignment>(
  db: DrizzleExecutor,
  grants: T[],
  ownRoutes: RouteRow[],
  endpoints: EndpointRow[]
): Promise<T[]> {
  if (!mayInvolveSets(grants, ownRoutes)) return grants;
  const views = await loadSetRelayViews(db);
  if (views.length === 0) return grants;
  const memberById = new Map<string, { view: SetRelayView; member: SetRelayMember }>();
  for (const view of views) for (const member of view.members) memberById.set(member.id, { view, member });
  const viewOfResource = new Map(
    views.map((view) => [`${setAnchorEndpointKind(view.ownerKind)}:${view.ownerId}`, view])
  );
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  /** The member a client endpoint serves: its owner, or for a resource endpoint the member on its node. */
  const clientMemberOf = (endpoint: EndpointRow | undefined) => {
    if (!endpoint) return null;
    if (endpoint.ownerKind === SET_CLIENT_ENDPOINT_KIND) return memberById.get(endpoint.ownerId) ?? null;
    const view = viewOfResource.get(`${endpoint.ownerKind}:${endpoint.ownerId}`);
    const member = view?.members.find((entry) => entry.nodeId === endpoint.subjectId);
    return view && member ? { view, member } : null;
  };

  // Keeper witnesses on docker nodes serve an endpoint of their own (owner id = witness id).
  const witnessGrantIds = grants
    .filter((grant) => grant.role === 'endpoint' && grant.ownerKind === SET_WITNESS_ENDPOINT_KIND)
    .map((grant) => grant.ownerId);
  const witnessSet = new Map(
    witnessGrantIds.length
      ? (
          await db
            .select({ id: managedAvailabilityWitnesses.id, setId: managedAvailabilityWitnesses.setId })
            .from(managedAvailabilityWitnesses)
            .where(inArray(managedAvailabilityWitnesses.id, witnessGrantIds))
        ).map((row) => [row.id, row.setId])
      : []
  );
  const viewBySet = new Map(views.map((view) => [view.setId, view]));
  for (const grant of grants) {
    if (grant.role === 'endpoint' && grant.ownerKind === SET_WITNESS_ENDPOINT_KIND) {
      const view = viewBySet.get(witnessSet.get(grant.ownerId) ?? '');
      if (view) {
        grant.leaseTarget = {
          setId: view.setId,
          memberId: '',
          candidateId: '',
          leasePolicyId: view.leasePolicyId ?? '',
          rank: 0,
          ownerKind: view.ownerKind,
          ownerId: view.ownerId,
          portName: 'ch-keeper',
          primaryPort: false,
          witnessId: grant.ownerId,
        };
      }
      continue;
    }
    if (grant.role === 'endpoint') {
      if (grant.ownerKind === SET_PEER_ENDPOINT_KIND) {
        const parsed = parsePeerEndpointOwnerId(grant.ownerId);
        const found = parsed ? memberById.get(parsed.memberId) : undefined;
        if (parsed && found) grant.leaseTarget = target(found.view, found.member, parsed.port);
        continue;
      }
      const found = clientMemberOf(grant.endpointId ? endpointById.get(grant.endpointId) : undefined);
      if (found) grant.leaseTarget = target(found.view, found.member);
      continue;
    }
    if (grant.role === 'connect' && grant.ownerKind === SET_PEER_ROUTE_KIND) {
      const parsed = parsePeerRouteOwnerId(grant.ownerId);
      const found = parsed ? memberById.get(parsed.targetMemberId) : undefined;
      if (parsed && found) grant.leaseTarget = target(found.view, found.member, parsed.port);
      continue;
    }
    if (grant.role === 'connect' && grant.ownerKind === SET_WITNESS_ROUTE_KIND) {
      // A member's route to a Keeper witness: `<member id>><witness id>`; a docker-node witness's route to a member:
      // `<witness id>><member id>` (a relay witness's routes start at its relay, never in a daemon's bundle).
      const [sourceMemberId, witnessId] = grant.ownerId.split('>');
      const found = sourceMemberId ? memberById.get(sourceMemberId) : undefined;
      const reached = !found && witnessId ? memberById.get(witnessId) : undefined;
      if (reached && sourceMemberId) {
        grant.leaseTarget = { ...target(reached.view, reached.member, 'ch-keeper'), witnessId: sourceMemberId };
        continue;
      }
      if (found && witnessId) {
        grant.leaseTarget = {
          setId: found.view.setId,
          memberId: '',
          candidateId: '',
          leasePolicyId: found.view.leasePolicyId ?? '',
          rank: 0,
          ownerKind: found.view.ownerKind,
          ownerId: found.view.ownerId,
          portName: 'ch-keeper',
          primaryPort: false,
          witnessId,
        };
      }
    }
  }

  // Lease groups: the routes to a set's resource endpoint and their member routes.
  const parentRoutes = ownRoutes.filter((route) => {
    const endpoint = endpointById.get(route.targetEndpointId);
    return (
      route.parentRouteId === null &&
      endpoint !== undefined &&
      viewOfResource.has(`${endpoint.ownerKind}:${endpoint.ownerId}`)
    );
  });
  if (parentRoutes.length === 0) return grants;
  const byRouteId = new Map(grants.filter((grant) => grant.routeId).map((grant) => [grant.routeId!, grant]));
  const grouped = new Set<string>();
  const result: T[] = [];
  const groupOf = new Map<string, T>();
  for (const parent of parentRoutes) {
    const endpoint = endpointById.get(parent.targetEndpointId)!;
    const view = viewOfResource.get(`${endpoint.ownerKind}:${endpoint.ownerId}`)!;
    const members: NonNullable<SetGrantAssignment['leaseGroup']> = [];
    const parentGrant = byRouteId.get(parent.id);
    const origin = clientMemberOf(endpoint);
    if (parentGrant && origin) {
      members.push(groupRoute(parentGrant, target(view, origin.member)));
      grouped.add(parent.id);
    }
    for (const route of ownRoutes) {
      if (route.parentRouteId !== parent.id) continue;
      const memberGrant = byRouteId.get(route.id);
      const memberId = route.ownerId.slice(route.ownerId.lastIndexOf(':') + 1);
      const found = memberById.get(memberId);
      if (!memberGrant || !found) continue;
      members.push(groupRoute(memberGrant, target(view, found.member)));
      grouped.add(route.id);
    }
    if (members.length === 0) continue;
    members.sort((left, right) => left.target.rank - right.target.rank);
    const first = members[0]!;
    // Without a served resource route (its member was removed), the group keeps the route's listener and egress.
    const base = parentGrant ?? {
      ...byRouteId.get(first.routeId)!,
      managedDatabaseListener: parent.managedDatabaseListener
        ? { ...parent.managedDatabaseListener, routeGeneration: parent.generation }
        : undefined,
      secureLinkEgress: parent.secureLinkEgress
        ? { ...parent.secureLinkEgress, routeGeneration: parent.generation }
        : undefined,
    };
    groupOf.set(parent.id, {
      ...base,
      ownerKind: parent.ownerKind,
      ownerId: parent.ownerId,
      routeId: first.routeId,
      targetEndpointId: first.targetEndpointId,
      grant: first.grant,
      candidates: first.candidates,
      schemaVersion: first.schemaVersion,
      streamResume: first.streamResume,
      leaseGroup: members,
    } as T);
  }
  for (const grant of grants) {
    if (grant.routeId && grouped.has(grant.routeId)) {
      // The group takes the place of its resource route (or of its first member when that route is not served).
      const parentId = parentRoutes.find(
        (parent) =>
          parent.id === grant.routeId ||
          ownRoutes.some((route) => route.id === grant.routeId && route.parentRouteId === parent.id)
      )?.id;
      const group = parentId ? groupOf.get(parentId) : undefined;
      if (group && !result.includes(group)) result.push(group);
      continue;
    }
    result.push(grant);
  }
  return result;
}

function groupRoute(grant: SetGrantAssignment, leaseTarget: SetLeaseTarget) {
  return {
    routeId: grant.routeId!,
    targetEndpointId: grant.targetEndpointId!,
    grant: grant.grant,
    ...(grant.candidates ? { candidates: grant.candidates } : {}),
    ...(grant.streamResume ? { streamResume: grant.streamResume } : {}),
    ...(grant.schemaVersion !== undefined ? { schemaVersion: grant.schemaVersion } : {}),
    target: leaseTarget,
  };
}
