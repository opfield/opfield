import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  dockerAvailabilityLeaseObservations,
  type ManagedAvailabilityEngine,
  type ManagedAvailabilityMode,
  type ManagedAvailabilityOwnerKind,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedAvailabilityWitnesses,
  managedDatabaseInstances,
  managedStorageClusters,
  nodes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayRoutes,
} from '@/db/schema/index.js';
import {
  MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER,
  MANAGED_AVAILABILITY_PEER_ENDPOINT_OWNER,
} from '@/modules/docker/availability/lease/lease-policy-relays.js';
import { setLeaseCandidates } from '@/modules/docker/availability/lease/managed-availability-lease-source.js';

/**
 * Relay data paths of database and storage availability sets (member mesh, decision 3 of the plan).
 *
 * Client paths. The resource's existing endpoint (owner kind managed_database / managed_storage) stays and becomes the
 * client endpoint of the member on its node (the origin member), so turning availability on cuts no tunnel; every
 * other member gets its own client endpoint (owner kind managed_availability_member, owner id = member id, subject =
 * the member's node). Every route to the resource's endpoint (bindings, links, Opfield tools, backups) gets one member
 * route per other member (owner kind `set_member:<route's kind>`, owner id `<route id>:<member id>`, parent route =
 * the route), with the same source. The daemons and Opfield receive the routes as one lease group and open the
 * holder's route first; while the set's lease runs the relays admit only the holder (endpoint lease gate).
 *
 * Peer paths (engine to engine). Every member has one peer endpoint per port of its engine (owner kind
 * managed_availability_peer, owner id `<member id>:<port>`), and every member has a route to every other member's
 * peer endpoint of each port (owner kind managed_member_peer, owner id `<source member>><target member>:<port>`).
 * A primary port (pg-repl, kv-repl, sw-master) is lease-gated at the endpoint like the client paths and reached as
 * `primary-<port>`; any other port reaches each member as `member-<id>-<port>`. Peer routes are never source-gated.
 */
export const SET_CLIENT_ENDPOINT_KIND = MANAGED_AVAILABILITY_MEMBER_ENDPOINT_OWNER;
export const SET_PEER_ENDPOINT_KIND = MANAGED_AVAILABILITY_PEER_ENDPOINT_OWNER;
export const SET_PEER_ROUTE_KIND = 'managed_member_peer';
export const SET_MEMBER_ROUTE_PREFIX = 'set_member:';
/**
 * A ClickHouse Keeper witness on a relay: its relay-local endpoint (owner id = witness id, subject the relay, served on
 * the relay's loopback) and the routes between it and the members' Keeper ports (owner kind managed_witness_peer,
 * owner id `<member id>><witness id>` toward the witness, `<witness id>><member id>` from it; the latter starts at the
 * relay and is opened by its supervisor with DialRoute).
 */
export const SET_WITNESS_ENDPOINT_KIND = 'managed_availability_witness';
export const SET_WITNESS_ROUTE_KIND = 'managed_witness_peer';
/** Relay-local endpoints and relay-originated routes have no certificate; the relay requires a non-empty marker. */
export const RELAY_LOCAL_CERTIFICATE_MARKER = 'relay-local';
const KEEPER_PORT: MemberPortName = 'ch-keeper';

export type MemberPortName =
  | 'pg-repl'
  | 'kv-repl'
  | 'sw-master'
  | 'sw-master-grpc'
  | 'sw-volume'
  | 'sw-volume-grpc'
  | 'sw-filer'
  | 'sw-filer-grpc'
  | 'ch-interserver'
  | 'ch-keeper'
  | 'member-control'
  | 'db-backup';

/**
 * The member runtime's own port on every engine: a manual pair's member asks its peer for the primary assignment
 * over it.
 */
const MEMBER_CONTROL_PORT = { name: 'member-control', primary: false } as const;
/**
 * Backups from a copy (P3-T06): every database member serves its own engine on this port, whatever its role (never
 * lease-gated). Only backup runs route to it (from their executor node); members have no routes to each other's.
 */
export const BACKUP_SOURCE_PORT = { name: 'db-backup', primary: false, peerRoutes: false } as const;

/**
 * The engine-to-engine ports of each engine; primary ports reach the primary only. `peerRoutes: false`: an endpoint
 * on every member without member-to-member routes.
 */
export const ENGINE_MEMBER_PORTS: Record<
  ManagedAvailabilityEngine,
  ReadonlyArray<{ name: MemberPortName; primary: boolean; peerRoutes?: false }>
> = {
  postgres: [{ name: 'pg-repl', primary: true }, MEMBER_CONTROL_PORT, BACKUP_SOURCE_PORT],
  valkey: [{ name: 'kv-repl', primary: true }, MEMBER_CONTROL_PORT, BACKUP_SOURCE_PORT],
  seaweedfs: [
    // SeaweedFS serves HTTP and gRPC on separate ports: each component has a port of each.
    { name: 'sw-master', primary: true },
    { name: 'sw-master-grpc', primary: true },
    { name: 'sw-volume', primary: false },
    { name: 'sw-volume-grpc', primary: false },
    { name: 'sw-filer', primary: false },
    { name: 'sw-filer-grpc', primary: false },
    MEMBER_CONTROL_PORT,
  ],
  clickhouse: [
    { name: 'ch-interserver', primary: false },
    { name: 'ch-keeper', primary: false },
    MEMBER_CONTROL_PORT,
    BACKUP_SOURCE_PORT,
  ],
};

export function isPrimaryMemberPort(engine: ManagedAvailabilityEngine, port: string): boolean {
  return ENGINE_MEMBER_PORTS[engine].some((entry) => entry.name === port && entry.primary);
}

/** The resource's own endpoint kind: the origin member's client endpoint while the set exists. */
export function setAnchorEndpointKind(ownerKind: ManagedAvailabilityOwnerKind): 'managed_database' | 'managed_storage' {
  return ownerKind === 'managed_database' ? 'managed_database' : 'managed_storage';
}

export function memberRouteKind(parentKind: string): string {
  return `${SET_MEMBER_ROUTE_PREFIX}${parentKind}`;
}

/** The kind of the route a member route repeats; null for any other route kind. */
export function parentKindOfMemberRoute(kind: string): string | null {
  return kind.startsWith(SET_MEMBER_ROUTE_PREFIX) ? kind.slice(SET_MEMBER_ROUTE_PREFIX.length) : null;
}

export function memberRouteOwnerId(parentRouteId: string, memberId: string): string {
  return `${parentRouteId}:${memberId}`;
}

export function peerEndpointOwnerId(memberId: string, port: string): string {
  return `${memberId}:${port}`;
}

export function parsePeerEndpointOwnerId(ownerId: string): { memberId: string; port: string } | null {
  const separator = ownerId.indexOf(':');
  if (separator <= 0 || separator === ownerId.length - 1) return null;
  return { memberId: ownerId.slice(0, separator), port: ownerId.slice(separator + 1) };
}

export function peerRouteOwnerId(sourceMemberId: string, targetMemberId: string, port: string): string {
  return `${sourceMemberId}>${targetMemberId}:${port}`;
}

export function parsePeerRouteOwnerId(
  ownerId: string
): { sourceMemberId: string; targetMemberId: string; port: string } | null {
  const match = /^([^>:]+)>([^>:]+):(.+)$/.exec(ownerId);
  return match ? { sourceMemberId: match[1]!, targetMemberId: match[2]!, port: match[3]! } : null;
}

export interface SetRelayMember {
  id: string;
  nodeId: string;
  memberIndex: number;
  priority: number;
  /** Fallback order (0 first), as the lease candidates: priority, then member index. */
  rank: number;
  /** 'member' or 'removing'; a removing member keeps its paths until its row is deleted. */
  desiredState: string;
}

export interface SetRelayView {
  setId: string;
  ownerKind: ManagedAvailabilityOwnerKind;
  ownerId: string;
  engine: ManagedAvailabilityEngine;
  mode: ManagedAvailabilityMode;
  /** The set's current lease policy (automatic mode); null in manual mode or before the first enable. */
  leasePolicyId: string | null;
  primaryMemberId: string | null;
  /** The resource is up (ready or updating): its client endpoints serve. */
  resourceActive: boolean;
  members: SetRelayMember[];
}

/** Every availability set with its members in rank order; `filter` narrows to sets or owners. */
export async function loadSetRelayViews(
  db: DrizzleExecutor,
  filter: { setIds?: string[]; owner?: { kind: ManagedAvailabilityOwnerKind; id: string } } = {}
): Promise<SetRelayView[]> {
  if (filter.setIds && filter.setIds.length === 0) return [];
  const sets = await db
    .select({
      id: managedAvailabilitySets.id,
      ownerKind: managedAvailabilitySets.ownerKind,
      ownerId: managedAvailabilitySets.ownerId,
      engine: managedAvailabilitySets.engine,
      mode: managedAvailabilitySets.mode,
      leasePolicyId: managedAvailabilitySets.leasePolicyId,
      primaryMemberId: managedAvailabilitySets.primaryMemberId,
      databaseStatus: managedDatabaseInstances.status,
      storageStatus: managedStorageClusters.status,
    })
    .from(managedAvailabilitySets)
    .leftJoin(managedDatabaseInstances, eq(managedDatabaseInstances.id, managedAvailabilitySets.managedDatabaseId))
    .leftJoin(managedStorageClusters, eq(managedStorageClusters.id, managedAvailabilitySets.managedStorageClusterId))
    .where(
      and(
        filter.setIds ? inArray(managedAvailabilitySets.id, filter.setIds) : undefined,
        filter.owner
          ? and(
              eq(managedAvailabilitySets.ownerKind, filter.owner.kind),
              eq(managedAvailabilitySets.ownerId, filter.owner.id)
            )
          : undefined
      )
    );
  if (sets.length === 0) return [];
  const members = await db
    .select({
      id: managedAvailabilityMembers.id,
      setId: managedAvailabilityMembers.setId,
      nodeId: managedAvailabilityMembers.nodeId,
      memberIndex: managedAvailabilityMembers.memberIndex,
      priority: managedAvailabilityMembers.priority,
      desiredState: managedAvailabilityMembers.desiredState,
    })
    .from(managedAvailabilityMembers)
    .where(
      inArray(
        managedAvailabilityMembers.setId,
        sets.map((set) => set.id)
      )
    );
  return sets.map((set) => {
    const own = members.filter((member) => member.setId === set.id);
    const order = new Map(setLeaseCandidates(own).map((candidate) => [candidate.memberId, candidate.rank]));
    const status = set.ownerKind === 'managed_database' ? set.databaseStatus : set.storageStatus;
    return {
      setId: set.id,
      ownerKind: set.ownerKind,
      ownerId: set.ownerId,
      engine: set.engine,
      mode: set.mode,
      leasePolicyId: set.mode === 'automatic' ? set.leasePolicyId : null,
      primaryMemberId: set.primaryMemberId,
      resourceActive: status === 'ready' || status === 'updating',
      members: own
        .map((member) => ({ ...member, rank: order.get(member.nodeId) ?? 0 }))
        .sort((left, right) => left.rank - right.rank),
    };
  });
}

/**
 * Whether a member's endpoint serves: the resource is up, and in manual mode only the primary's (the endpoint is
 * single-serving there and Opfield moves it on every switch). Peer endpoints of non-primary ports serve on every member.
 */
export function setEndpointActive(view: SetRelayView, memberId: string, port: string | null): boolean {
  if (port !== null && !isPrimaryMemberPort(view.engine, port)) return true;
  if (!view.resourceActive) return false;
  return view.mode === 'automatic' || view.primaryMemberId === memberId;
}

type EndpointRow = typeof relayEndpoints.$inferSelect;
type RouteRow = typeof relayRoutes.$inferSelect;

interface DesiredEndpoint {
  ownerKind: string;
  ownerId: string;
  subjectId: string;
  certificateSha256: string;
  status: 'active' | 'inactive';
}

/** Creates or updates an endpoint row to the desired subject and status; returns its id and whether it changed. */
async function upsertEndpoint(
  tx: DrizzleExecutor,
  existing: EndpointRow | undefined,
  desired: DesiredEndpoint
): Promise<{ id: string; changed: boolean }> {
  if (!existing) {
    const [created] = await tx
      .insert(relayEndpoints)
      .values({
        ownerKind: desired.ownerKind,
        ownerId: desired.ownerId,
        subjectKind: 'daemon',
        subjectId: desired.subjectId,
        certificateSha256: desired.certificateSha256,
        status: desired.status,
      })
      .returning({ id: relayEndpoints.id });
    return { id: created!.id, changed: true };
  }
  if (
    existing.subjectId === desired.subjectId &&
    existing.certificateSha256 === desired.certificateSha256 &&
    existing.status === desired.status
  ) {
    return { id: existing.id, changed: false };
  }
  await tx
    .update(relayEndpoints)
    .set({
      subjectId: desired.subjectId,
      certificateSha256: desired.certificateSha256,
      status: desired.status,
      generation: sql`${relayEndpoints.generation} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(relayEndpoints.id, existing.id));
  return { id: existing.id, changed: true };
}

interface DesiredRoute {
  ownerKind: string;
  ownerId: string;
  sourceKind: string;
  sourceId: string;
  sourceCertificateSha256: string;
  targetEndpointId: string;
  parentRouteId: string | null;
  maxConcurrentSessions: number;
  maxFrameBytes: number;
}

async function upsertRoute(
  tx: DrizzleExecutor,
  existing: RouteRow | undefined,
  desired: DesiredRoute
): Promise<boolean> {
  if (!existing) {
    await tx.insert(relayRoutes).values(desired);
    return true;
  }
  if (
    existing.sourceKind === desired.sourceKind &&
    existing.sourceId === desired.sourceId &&
    existing.sourceCertificateSha256 === desired.sourceCertificateSha256 &&
    existing.targetEndpointId === desired.targetEndpointId &&
    existing.parentRouteId === desired.parentRouteId &&
    existing.maxConcurrentSessions === desired.maxConcurrentSessions &&
    existing.maxFrameBytes === desired.maxFrameBytes
  ) {
    return false;
  }
  await tx
    .update(relayRoutes)
    .set({
      sourceKind: desired.sourceKind,
      sourceId: desired.sourceId,
      sourceCertificateSha256: desired.sourceCertificateSha256,
      targetEndpointId: desired.targetEndpointId,
      parentRouteId: desired.parentRouteId,
      maxConcurrentSessions: desired.maxConcurrentSessions,
      maxFrameBytes: desired.maxFrameBytes,
      generation: sql`${relayRoutes.generation} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(relayRoutes.id, existing.id));
  return true;
}

/**
 * Reconciles the relay paths of availability sets (all of them, or `setIds`) in the caller's transaction, under the
 * relay policy lock. Returns whether anything changed (the caller bumps the policy revision). A member whose node has
 * no certificate yet gets no paths until it has one.
 */
export async function reconcileSetRelayPaths(tx: DrizzleExecutor, setIds?: string[]): Promise<boolean> {
  const views = await loadSetRelayViews(tx, setIds ? { setIds } : {});
  const identities = await tx.select({ id: nodes.id, fingerprint: nodes.certificateFingerprint }).from(nodes);
  const fingerprints = new Map(identities.flatMap(({ id, fingerprint }) => (fingerprint ? [[id, fingerprint]] : [])));
  let changed = false;
  for (const view of views) changed = (await reconcileOneSet(tx, view, fingerprints)) || changed;
  if (!setIds) changed = (await removeOrphanedSetPaths(tx, views)) || changed;
  return changed;
}

async function reconcileOneSet(
  tx: DrizzleExecutor,
  view: SetRelayView,
  fingerprints: Map<string, string>
): Promise<boolean> {
  let changed = false;
  const anchorKind = setAnchorEndpointKind(view.ownerKind);
  const memberIds = view.members.map((member) => member.id);
  const [anchors, clientEndpoints, peerEndpoints] = await Promise.all([
    tx
      .select()
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.ownerKind, anchorKind), eq(relayEndpoints.ownerId, view.ownerId))),
    memberIds.length
      ? tx
          .select()
          .from(relayEndpoints)
          .where(
            and(eq(relayEndpoints.ownerKind, SET_CLIENT_ENDPOINT_KIND), inArray(relayEndpoints.ownerId, memberIds))
          )
      : Promise.resolve([] as EndpointRow[]),
    tx
      .select()
      .from(relayEndpoints)
      .where(
        and(
          eq(relayEndpoints.ownerKind, SET_PEER_ENDPOINT_KIND),
          sql`split_part(${relayEndpoints.ownerId}, ':', 1) in (${sql.join(
            memberIds.length ? memberIds.map((id) => sql`${id}`) : [sql`''`],
            sql`, `
          )})`
        )
      ),
  ]);
  let anchor = anchors[0];
  // The resource's endpoint is the client endpoint of the member on its node. Without one (no relay path was ever
  // needed), it is made for the primary member (or the first one) on that member's node.
  if (!anchor) {
    const first = view.members.find((member) => member.id === view.primaryMemberId) ?? view.members[0];
    const certificate = first ? fingerprints.get(first.nodeId) : undefined;
    if (first && certificate) {
      const created = await upsertEndpoint(tx, undefined, {
        ownerKind: anchorKind,
        ownerId: view.ownerId,
        subjectId: first.nodeId,
        certificateSha256: certificate,
        status: setEndpointActive(view, first.id, null) ? 'active' : 'inactive',
      });
      [anchor] = await tx.select().from(relayEndpoints).where(eq(relayEndpoints.id, created.id));
      changed = true;
    }
  }
  const origin = anchor ? view.members.find((member) => member.nodeId === anchor!.subjectId) : undefined;
  if (anchor) {
    // The anchor keeps its subject (retargeting it would cut its tunnels); it serves while its member exists.
    const status = origin && setEndpointActive(view, origin.id, null) ? 'active' : 'inactive';
    const result = await upsertEndpoint(tx, anchor, {
      ownerKind: anchorKind,
      ownerId: view.ownerId,
      subjectId: anchor.subjectId,
      certificateSha256: fingerprints.get(anchor.subjectId) ?? anchor.certificateSha256,
      status,
    });
    changed ||= result.changed;
  }
  const clientEndpointOf = new Map<string, string>();
  if (anchor && origin) clientEndpointOf.set(origin.id, anchor.id);
  for (const member of view.members) {
    if (member.id === origin?.id) continue;
    const certificate = fingerprints.get(member.nodeId);
    const existing = clientEndpoints.find((endpoint) => endpoint.ownerId === member.id);
    if (!certificate) continue;
    const result = await upsertEndpoint(tx, existing, {
      ownerKind: SET_CLIENT_ENDPOINT_KIND,
      ownerId: member.id,
      subjectId: member.nodeId,
      certificateSha256: certificate,
      status: setEndpointActive(view, member.id, null) ? 'active' : 'inactive',
    });
    clientEndpointOf.set(member.id, result.id);
    changed ||= result.changed;
  }
  for (const endpoint of clientEndpoints) {
    if (clientEndpointOf.get(endpoint.ownerId) === endpoint.id) continue;
    await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, endpoint.id));
    changed = true;
  }
  for (const member of view.members) {
    const endpointId = clientEndpointOf.get(member.id) ?? null;
    const [row] = await tx
      .select({ relayEndpointId: managedAvailabilityMembers.relayEndpointId })
      .from(managedAvailabilityMembers)
      .where(eq(managedAvailabilityMembers.id, member.id));
    if (row && row.relayEndpointId !== endpointId) {
      await tx
        .update(managedAvailabilityMembers)
        .set({ relayEndpointId: endpointId, updatedAt: new Date() })
        .where(eq(managedAvailabilityMembers.id, member.id));
    }
  }

  // Peer endpoints, one per member and engine port.
  const ports = ENGINE_MEMBER_PORTS[view.engine];
  const peerEndpointOf = new Map<string, string>();
  for (const member of view.members) {
    const certificate = fingerprints.get(member.nodeId);
    if (!certificate) continue;
    for (const port of ports) {
      const ownerId = peerEndpointOwnerId(member.id, port.name);
      const result = await upsertEndpoint(
        tx,
        peerEndpoints.find((endpoint) => endpoint.ownerId === ownerId),
        {
          ownerKind: SET_PEER_ENDPOINT_KIND,
          ownerId,
          subjectId: member.nodeId,
          certificateSha256: certificate,
          status: setEndpointActive(view, member.id, port.name) ? 'active' : 'inactive',
        }
      );
      peerEndpointOf.set(ownerId, result.id);
      changed ||= result.changed;
    }
  }
  for (const endpoint of peerEndpoints) {
    if (peerEndpointOf.get(endpoint.ownerId) === endpoint.id) continue;
    await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, endpoint.id));
    changed = true;
  }

  // Peer routes: every member to every other member, per port. Endpoint-gated only.
  const desiredPeerRoutes = new Map<string, DesiredRoute>();
  for (const source of view.members) {
    const certificate = fingerprints.get(source.nodeId);
    if (!certificate) continue;
    for (const target of view.members) {
      if (target.id === source.id) continue;
      for (const port of ports) {
        if (port.peerRoutes === false) continue;
        const targetEndpointId = peerEndpointOf.get(peerEndpointOwnerId(target.id, port.name));
        if (!targetEndpointId) continue;
        const ownerId = peerRouteOwnerId(source.id, target.id, port.name);
        desiredPeerRoutes.set(ownerId, {
          ownerKind: SET_PEER_ROUTE_KIND,
          ownerId,
          sourceKind: 'daemon',
          sourceId: source.nodeId,
          sourceCertificateSha256: certificate,
          targetEndpointId,
          parentRouteId: null,
          maxConcurrentSessions: 64,
          maxFrameBytes: 1024 * 1024,
        });
      }
    }
  }
  const peerRoutes = await tx
    .select()
    .from(relayRoutes)
    .where(
      and(
        eq(relayRoutes.ownerKind, SET_PEER_ROUTE_KIND),
        sql`split_part(${relayRoutes.ownerId}, '>', 1) in (${sql.join(
          memberIds.length ? memberIds.map((id) => sql`${id}`) : [sql`''`],
          sql`, `
        )})`
      )
    );
  for (const route of peerRoutes) {
    const desired = desiredPeerRoutes.get(route.ownerId);
    if (!desired) {
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
      continue;
    }
    changed = (await upsertRoute(tx, route, desired)) || changed;
    desiredPeerRoutes.delete(route.ownerId);
  }
  for (const desired of desiredPeerRoutes.values()) changed = (await upsertRoute(tx, undefined, desired)) || changed;

  // Member routes: every route to the resource's endpoint, repeated toward every other member's client endpoint.
  if (anchor)
    changed = (await reconcileMemberRoutes(tx, anchor.id, origin?.id ?? null, view, clientEndpointOf)) || changed;
  changed = (await reconcileWitnessPaths(tx, view, fingerprints, peerEndpointOf)) || changed;
  return changed;
}

/**
 * ClickHouse Keeper witnesses. On a relay: a relay-local endpoint per witness (placed on its relay only), a route from
 * every member to it, and a relay-originated route from it to every member's Keeper port, whose peer endpoint is also
 * placed on the witness's relay (DialRoute needs both ends in that relay's policy). On a docker node (decision 8, a
 * non-member node witness): the witness endpoint's subject is that node's daemon (it serves the Keeper container),
 * placed like any member endpoint, and the routes from it to the members start at that daemon.
 */
async function reconcileWitnessPaths(
  tx: DrizzleExecutor,
  view: SetRelayView,
  fingerprints: Map<string, string>,
  peerEndpointOf: Map<string, string>
): Promise<boolean> {
  let changed = false;
  const witnesses =
    view.engine === 'clickhouse'
      ? (
          await tx
            .select({
              id: managedAvailabilityWitnesses.id,
              hostKind: managedAvailabilityWitnesses.hostKind,
              relayInstanceId: managedAvailabilityWitnesses.relayInstanceId,
              nodeId: managedAvailabilityWitnesses.nodeId,
              relayLocalPort: managedAvailabilityWitnesses.relayLocalPort,
              desiredState: managedAvailabilityWitnesses.desiredState,
            })
            .from(managedAvailabilityWitnesses)
            .where(
              and(
                eq(managedAvailabilityWitnesses.setId, view.setId),
                eq(managedAvailabilityWitnesses.purpose, 'keeper')
              )
            )
        ).filter(
          // A retired witness keeps its paths until the holder's Keeper dropped it (relay-witness.service.ts).
          (witness) =>
            witness.relayLocalPort &&
            ((witness.hostKind === 'relay' && witness.relayInstanceId) ||
              (witness.hostKind === 'node' && witness.nodeId && fingerprints.has(witness.nodeId)))
        )
      : [];
  const witnessIds = witnesses.map((witness) => witness.id);
  const existingEndpoints = await tx
    .select()
    .from(relayEndpoints)
    .where(
      and(
        eq(relayEndpoints.ownerKind, SET_WITNESS_ENDPOINT_KIND),
        // The set's witnesses, and witnesses dropped since (their row is gone once the holder's Keeper dropped them).
        sql`(${relayEndpoints.ownerId} in (select ${managedAvailabilityWitnesses.id}::text from ${managedAvailabilityWitnesses} where ${managedAvailabilityWitnesses.setId} = ${view.setId}) or ${relayEndpoints.ownerId} not in (select ${managedAvailabilityWitnesses.id}::text from ${managedAvailabilityWitnesses}))`
      )
    );
  const endpointOf = new Map<string, string>();
  for (const witness of witnesses) {
    const onNode = witness.hostKind === 'node';
    const desired = onNode
      ? {
          subjectKind: 'daemon',
          subjectId: witness.nodeId!,
          certificateSha256: fingerprints.get(witness.nodeId!)!,
          relayLocalPort: null,
        }
      : {
          subjectKind: 'relay_instance',
          subjectId: witness.relayInstanceId!,
          certificateSha256: RELAY_LOCAL_CERTIFICATE_MARKER,
          relayLocalPort: witness.relayLocalPort!,
        };
    let existing = existingEndpoints.find((endpoint) => endpoint.ownerId === witness.id);
    if (existing && existing.subjectKind !== desired.subjectKind) {
      // A witness never changes host kind in place; a stale row of another kind is replaced.
      await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, existing.id));
      existing = undefined;
      changed = true;
    }
    let endpointId: string;
    if (!existing) {
      const [created] = await tx
        .insert(relayEndpoints)
        .values({
          ownerKind: SET_WITNESS_ENDPOINT_KIND,
          ownerId: witness.id,
          subjectKind: desired.subjectKind,
          subjectId: desired.subjectId,
          certificateSha256: desired.certificateSha256,
          relayLocalPort: desired.relayLocalPort,
          status: 'active',
        })
        .returning({ id: relayEndpoints.id });
      endpointId = created!.id;
      changed = true;
    } else {
      endpointId = existing.id;
      if (
        existing.subjectId !== desired.subjectId ||
        existing.relayLocalPort !== desired.relayLocalPort ||
        existing.certificateSha256 !== desired.certificateSha256
      ) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: desired.subjectId,
            relayLocalPort: desired.relayLocalPort,
            certificateSha256: desired.certificateSha256,
            generation: sql`${relayEndpoints.generation} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, existing.id));
        changed = true;
      }
    }
    endpointOf.set(witness.id, endpointId);
    if (onNode) continue;
    // The witness endpoint lives on its relay only; the members' Keeper ports must be there too.
    changed = (await placeOnRelay(tx, endpointId, desired.subjectId, true)) || changed;
    for (const member of view.members) {
      const keeper = peerEndpointOf.get(peerEndpointOwnerId(member.id, KEEPER_PORT));
      if (keeper) changed = (await placeOnRelay(tx, keeper, desired.subjectId, false)) || changed;
    }
  }
  for (const endpoint of existingEndpoints) {
    if (endpointOf.get(endpoint.ownerId) === endpoint.id) continue;
    await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, endpoint.id));
    changed = true;
  }
  const desiredRoutes = new Map<string, DesiredRoute>();
  for (const witness of witnesses) {
    const witnessEndpoint = endpointOf.get(witness.id)!;
    for (const member of view.members) {
      const certificate = fingerprints.get(member.nodeId);
      const keeper = peerEndpointOf.get(peerEndpointOwnerId(member.id, KEEPER_PORT));
      if (certificate) {
        const toWitness = `${member.id}>${witness.id}`;
        desiredRoutes.set(toWitness, {
          ownerKind: SET_WITNESS_ROUTE_KIND,
          ownerId: toWitness,
          sourceKind: 'daemon',
          sourceId: member.nodeId,
          sourceCertificateSha256: certificate,
          targetEndpointId: witnessEndpoint,
          parentRouteId: null,
          maxConcurrentSessions: 16,
          maxFrameBytes: 1024 * 1024,
        });
      }
      if (keeper) {
        const fromWitness = `${witness.id}>${member.id}`;
        desiredRoutes.set(fromWitness, {
          ownerKind: SET_WITNESS_ROUTE_KIND,
          ownerId: fromWitness,
          ...(witness.hostKind === 'node'
            ? {
                sourceKind: 'daemon',
                sourceId: witness.nodeId!,
                sourceCertificateSha256: fingerprints.get(witness.nodeId!)!,
              }
            : {
                sourceKind: 'relay_instance',
                sourceId: witness.relayInstanceId!,
                sourceCertificateSha256: RELAY_LOCAL_CERTIFICATE_MARKER,
              }),
          targetEndpointId: keeper,
          parentRouteId: null,
          maxConcurrentSessions: 16,
          maxFrameBytes: 1024 * 1024,
        });
      }
    }
  }
  const ids = [...view.members.map((member) => member.id), ...witnessIds];
  const existingRoutes = await tx
    .select()
    .from(relayRoutes)
    .where(
      and(
        eq(relayRoutes.ownerKind, SET_WITNESS_ROUTE_KIND),
        sql`(split_part(${relayRoutes.ownerId}, '>', 1) in (${sql.join(
          ids.length ? ids.map((id) => sql`${id}`) : [sql`''`],
          sql`, `
        )}) or split_part(${relayRoutes.ownerId}, '>', 2) in (${sql.join(
          ids.length ? ids.map((id) => sql`${id}`) : [sql`''`],
          sql`, `
        )}))`
      )
    );
  for (const route of existingRoutes) {
    const desired = desiredRoutes.get(route.ownerId);
    if (!desired) {
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
      continue;
    }
    changed = (await upsertRoute(tx, route, desired)) || changed;
    desiredRoutes.delete(route.ownerId);
  }
  for (const desired of desiredRoutes.values()) changed = (await upsertRoute(tx, undefined, desired)) || changed;
  return changed;
}

/**
 * Makes sure `endpointId` is assigned to `relayInstanceId` in its active assignment generation, creating that
 * generation (with this relay only) when the endpoint has none. `only`: the relay is the endpoint's only one.
 */
async function placeOnRelay(
  tx: DrizzleExecutor,
  endpointId: string,
  relayInstanceId: string,
  only: boolean
): Promise<boolean> {
  const [active] = await tx
    .select({ id: relayEndpointAssignmentGenerations.id })
    .from(relayEndpointAssignmentGenerations)
    .where(
      and(
        eq(relayEndpointAssignmentGenerations.endpointId, endpointId),
        eq(relayEndpointAssignmentGenerations.state, 'active')
      )
    )
    .limit(1);
  if (!active) {
    if (!only) return false;
    const [latest] = await tx
      .select({ generation: sql<number>`coalesce(max(${relayEndpointAssignmentGenerations.generation}), 0)` })
      .from(relayEndpointAssignmentGenerations)
      .where(eq(relayEndpointAssignmentGenerations.endpointId, endpointId));
    const [created] = await tx
      .insert(relayEndpointAssignmentGenerations)
      .values({
        endpointId,
        generation: Number(latest?.generation ?? 0) + 1,
        state: 'active',
        desiredRedundancy: 1,
        activatedAt: new Date(),
      })
      .returning({ id: relayEndpointAssignmentGenerations.id });
    await tx.insert(relayEndpointAssignments).values({
      assignmentGenerationId: created!.id,
      relayInstanceId,
      role: 'primary',
      targetRegistrationState: 'ready',
      targetRegisteredAt: new Date(),
    });
    return true;
  }
  const assignments = await tx
    .select({ id: relayEndpointAssignments.id, relayInstanceId: relayEndpointAssignments.relayInstanceId })
    .from(relayEndpointAssignments)
    .where(eq(relayEndpointAssignments.assignmentGenerationId, active.id));
  if (assignments.some((assignment) => assignment.relayInstanceId === relayInstanceId)) return false;
  await tx.insert(relayEndpointAssignments).values({
    assignmentGenerationId: active.id,
    relayInstanceId,
    role: 'fallback',
    targetRegistrationState: only ? 'ready' : 'pending',
    ...(only ? { targetRegisteredAt: new Date() } : {}),
  });
  return true;
}

async function reconcileMemberRoutes(
  tx: DrizzleExecutor,
  anchorEndpointId: string,
  originMemberId: string | null,
  view: SetRelayView,
  clientEndpointOf: Map<string, string>
): Promise<boolean> {
  let changed = false;
  const parents = await tx
    .select()
    .from(relayRoutes)
    .where(and(eq(relayRoutes.targetEndpointId, anchorEndpointId), isNull(relayRoutes.parentRouteId)));
  const existing = parents.length
    ? await tx
        .select()
        .from(relayRoutes)
        .where(
          inArray(
            relayRoutes.parentRouteId,
            parents.map((parent) => parent.id)
          )
        )
    : [];
  const desired = new Map<string, DesiredRoute>();
  for (const parent of parents) {
    for (const member of view.members) {
      if (member.id === originMemberId) continue;
      const targetEndpointId = clientEndpointOf.get(member.id);
      if (!targetEndpointId) continue;
      const ownerId = memberRouteOwnerId(parent.id, member.id);
      desired.set(ownerId, {
        ownerKind: memberRouteKind(parent.ownerKind),
        ownerId,
        sourceKind: parent.sourceKind,
        sourceId: parent.sourceId,
        sourceCertificateSha256: parent.sourceCertificateSha256,
        targetEndpointId,
        parentRouteId: parent.id,
        maxConcurrentSessions: parent.maxConcurrentSessions,
        maxFrameBytes: parent.maxFrameBytes,
      });
    }
  }
  for (const route of existing) {
    const wanted = desired.get(route.ownerId);
    if (!wanted || wanted.ownerKind !== route.ownerKind) {
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
      continue;
    }
    changed = (await upsertRoute(tx, route, wanted)) || changed;
    desired.delete(route.ownerId);
  }
  for (const wanted of desired.values()) changed = (await upsertRoute(tx, undefined, wanted)) || changed;
  return changed;
}

/** Member and peer paths of sets (or members) that no longer exist. */
async function removeOrphanedSetPaths(tx: DrizzleExecutor, views: SetRelayView[]): Promise<boolean> {
  const memberIds = new Set(views.flatMap((view) => view.members.map((member) => member.id)));
  const anchorIds = new Set(
    (
      await tx
        .select({ id: relayEndpoints.id, ownerKind: relayEndpoints.ownerKind, ownerId: relayEndpoints.ownerId })
        .from(relayEndpoints)
        .where(inArray(relayEndpoints.ownerKind, ['managed_database', 'managed_storage']))
    )
      .filter((endpoint) =>
        views.some(
          (view) => view.ownerId === endpoint.ownerId && setAnchorEndpointKind(view.ownerKind) === endpoint.ownerKind
        )
      )
      .map((endpoint) => endpoint.id)
  );
  let changed = false;
  const endpoints = await tx
    .select({ id: relayEndpoints.id, ownerKind: relayEndpoints.ownerKind, ownerId: relayEndpoints.ownerId })
    .from(relayEndpoints)
    .where(inArray(relayEndpoints.ownerKind, [SET_CLIENT_ENDPOINT_KIND, SET_PEER_ENDPOINT_KIND]));
  for (const endpoint of endpoints) {
    const memberId =
      endpoint.ownerKind === SET_CLIENT_ENDPOINT_KIND
        ? endpoint.ownerId
        : parsePeerEndpointOwnerId(endpoint.ownerId)?.memberId;
    if (memberId && memberIds.has(memberId)) continue;
    await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, endpoint.id));
    changed = true;
  }
  // Member routes whose parent no longer leads to a set's resource endpoint (the set is gone or the route moved).
  const memberRoutes = await tx
    .select({ id: relayRoutes.id, parentRouteId: relayRoutes.parentRouteId })
    .from(relayRoutes)
    .where(sql`${relayRoutes.ownerKind} like ${`${SET_MEMBER_ROUTE_PREFIX}%`}`);
  if (memberRoutes.length) {
    const parents = await tx
      .select({ id: relayRoutes.id, targetEndpointId: relayRoutes.targetEndpointId })
      .from(relayRoutes)
      .where(
        inArray(
          relayRoutes.id,
          memberRoutes.flatMap((route) => (route.parentRouteId ? [route.parentRouteId] : []))
        )
      );
    const parentTarget = new Map(parents.map((parent) => [parent.id, parent.targetEndpointId]));
    for (const route of memberRoutes) {
      const target = route.parentRouteId ? parentTarget.get(route.parentRouteId) : undefined;
      if (target && anchorIds.has(target)) continue;
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
    }
  }
  const peerRoutes = await tx
    .select({ id: relayRoutes.id, ownerId: relayRoutes.ownerId })
    .from(relayRoutes)
    .where(eq(relayRoutes.ownerKind, SET_PEER_ROUTE_KIND));
  for (const route of peerRoutes) {
    const parsed = parsePeerRouteOwnerId(route.ownerId);
    if (parsed && memberIds.has(parsed.sourceMemberId) && memberIds.has(parsed.targetMemberId)) continue;
    await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
    changed = true;
  }
  return changed;
}

/**
 * Turning a set off (AS9 close, back to a single node on `keepMemberId`): the kept member's client paths become the
 * resource's single-node paths in place, in one revision, so the tunnels to it survive: its client endpoint takes over
 * the resource's endpoint kind and id (the old resource endpoint, on another node, is deleted with its routes), and its
 * member routes become their parent routes. Every other member and peer path is removed. Run in the caller's
 * transaction before the set row is deleted; returns whether anything changed.
 */
export async function releaseSetRelayPaths(tx: DrizzleExecutor, setId: string, keepMemberId: string): Promise<boolean> {
  const [view] = await loadSetRelayViews(tx, { setIds: [setId] });
  if (!view) return false;
  const keep = view.members.find((member) => member.id === keepMemberId);
  if (!keep) throw new Error('The kept member is not a member of the availability set');
  const anchorKind = setAnchorEndpointKind(view.ownerKind);
  const [anchor] = await tx
    .select()
    .from(relayEndpoints)
    .where(and(eq(relayEndpoints.ownerKind, anchorKind), eq(relayEndpoints.ownerId, view.ownerId)));
  let changed = false;
  if (anchor && anchor.subjectId !== keep.nodeId) {
    const [kept] = await tx
      .select()
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.ownerKind, SET_CLIENT_ENDPOINT_KIND), eq(relayEndpoints.ownerId, keep.id)));
    if (kept) {
      // Parents of member routes (to the old resource endpoint) are replaced by the kept member's routes.
      const parents = await tx.select().from(relayRoutes).where(eq(relayRoutes.targetEndpointId, anchor.id));
      const keptRoutes = await tx.select().from(relayRoutes).where(eq(relayRoutes.targetEndpointId, kept.id));
      for (const parent of parents) {
        const replacement = keptRoutes.find((route) => route.parentRouteId === parent.id);
        if (!replacement) continue;
        // The replacement takes over the parent's identity; it keeps its id and generation, so its tunnels stay.
        await tx.update(relayRoutes).set({ parentRouteId: null }).where(eq(relayRoutes.id, replacement.id));
        await tx.delete(relayRoutes).where(eq(relayRoutes.id, parent.id));
        await tx
          .update(relayRoutes)
          .set({
            ownerKind: parent.ownerKind,
            ownerId: parent.ownerId,
            managedDatabaseListener: parent.managedDatabaseListener,
            secureLinkEgress: parent.secureLinkEgress,
            updatedAt: new Date(),
          })
          .where(eq(relayRoutes.id, replacement.id));
      }
      await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, anchor.id));
      await tx
        .update(relayEndpoints)
        .set({ ownerKind: anchorKind, ownerId: view.ownerId, status: 'active', updatedAt: new Date() })
        .where(eq(relayEndpoints.id, kept.id));
      changed = true;
    }
  } else if (anchor && anchor.status !== 'active' && view.resourceActive) {
    await tx
      .update(relayEndpoints)
      .set({ status: 'active', generation: sql`${relayEndpoints.generation} + 1`, updatedAt: new Date() })
      .where(eq(relayEndpoints.id, anchor.id));
    changed = true;
  }
  // Everything else of the set: other members' client endpoints (their member routes cascade), peer endpoints and
  // peer routes.
  const memberIds = view.members.map((member) => member.id);
  const others = await tx
    .delete(relayEndpoints)
    .where(and(eq(relayEndpoints.ownerKind, SET_CLIENT_ENDPOINT_KIND), inArray(relayEndpoints.ownerId, memberIds)))
    .returning({ id: relayEndpoints.id });
  const peers = await tx
    .delete(relayEndpoints)
    .where(
      and(
        eq(relayEndpoints.ownerKind, SET_PEER_ENDPOINT_KIND),
        sql`split_part(${relayEndpoints.ownerId}, ':', 1) in (${sql.join(
          memberIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
    )
    .returning({ id: relayEndpoints.id });
  return changed || others.length > 0 || peers.length > 0;
}

/** The set serving a managed resource, when it has one (one plain read when there is none). */
export async function setOfOwner(
  db: DrizzleExecutor,
  ownerKind: ManagedAvailabilityOwnerKind,
  ownerId: string
): Promise<SetRelayView | null> {
  const [owned] = await db
    .select({ id: managedAvailabilitySets.id })
    .from(managedAvailabilitySets)
    .where(
      ownerKind === 'managed_database'
        ? eq(managedAvailabilitySets.managedDatabaseId, ownerId)
        : eq(managedAvailabilitySets.managedStorageClusterId, ownerId)
    )
    .limit(1);
  if (typeof owned?.id !== 'string') return null;
  const [view] = await loadSetRelayViews(db, { setIds: [owned.id] });
  return view ?? null;
}

/**
 * After a route to `endpointId` was made or moved: when that endpoint is the resource endpoint of an availability set,
 * the set's member routes follow now (under the relay policy lock, in the caller's transaction) instead of at the next
 * reconcile. Returns whether anything changed.
 */
export async function reconcileSetPathsOfEndpoint(tx: DrizzleExecutor, endpointId: string): Promise<boolean> {
  const [endpoint] = await tx
    .select({ ownerKind: relayEndpoints.ownerKind, ownerId: relayEndpoints.ownerId })
    .from(relayEndpoints)
    .where(eq(relayEndpoints.id, endpointId))
    .limit(1);
  if (!endpoint || (endpoint.ownerKind !== 'managed_database' && endpoint.ownerKind !== 'managed_storage'))
    return false;
  const [set] = await tx
    .select({ id: managedAvailabilitySets.id })
    .from(managedAvailabilitySets)
    .where(
      endpoint.ownerKind === 'managed_database'
        ? eq(managedAvailabilitySets.managedDatabaseId, endpoint.ownerId)
        : eq(managedAvailabilitySets.managedStorageClusterId, endpoint.ownerId)
    )
    .limit(1);
  if (typeof set?.id !== 'string') return false;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-reconciliation'))`);
  return reconcileSetRelayPaths(tx, [set.id]);
}

/** The relay endpoints of availability sets (client, peer and resource endpoints), for placement. */
export async function setEndpointIds(db: DrizzleExecutor, setIds?: string[]): Promise<string[]> {
  const views = await loadSetRelayViews(db, setIds ? { setIds } : {});
  if (views.length === 0) return [];
  const memberIds = views.flatMap((view) => view.members.map((member) => member.id));
  const rows = await db
    .select({
      id: relayEndpoints.id,
      ownerKind: relayEndpoints.ownerKind,
      ownerId: relayEndpoints.ownerId,
      subjectKind: relayEndpoints.subjectKind,
    })
    .from(relayEndpoints)
    .where(
      inArray(relayEndpoints.ownerKind, [
        SET_CLIENT_ENDPOINT_KIND,
        SET_PEER_ENDPOINT_KIND,
        SET_WITNESS_ENDPOINT_KIND,
        'managed_database',
        'managed_storage',
      ])
    );
  const owners = new Set(views.map((view) => `${setAnchorEndpointKind(view.ownerKind)}:${view.ownerId}`));
  const members = new Set(memberIds);
  return rows
    .filter((row) => {
      if (row.ownerKind === SET_CLIENT_ENDPOINT_KIND) return members.has(row.ownerId);
      // A Keeper witness on a docker node is placed like a member endpoint (a relay witness lives on its relay).
      if (row.ownerKind === SET_WITNESS_ENDPOINT_KIND) return row.subjectKind === 'daemon';
      if (row.ownerKind === SET_PEER_ENDPOINT_KIND) {
        const parsed = parsePeerEndpointOwnerId(row.ownerId);
        return Boolean(parsed && members.has(parsed.memberId));
      }
      return owners.has(`${row.ownerKind}:${row.ownerId}`);
    })
    .map((row) => row.id);
}

/**
 * The routes a connection to a set's resource may take, holder first: the resource route itself (the origin member's)
 * and its member routes, ordered with `holderMemberId`'s route first, then by member rank. Used for Opfield's own
 * tunnels; daemons get the same group in their grant bundles.
 */
export async function orderedSetRoutes(
  db: DrizzleExecutor,
  parentRouteId: string,
  view: SetRelayView,
  holderMemberId: string | null
): Promise<Array<{ routeId: string; memberId: string }>> {
  const [parent] = await db
    .select({ id: relayRoutes.id, targetEndpointId: relayRoutes.targetEndpointId })
    .from(relayRoutes)
    .where(eq(relayRoutes.id, parentRouteId))
    .limit(1);
  if (!parent) return [];
  const [anchor] = await db
    .select({ subjectId: relayEndpoints.subjectId, status: relayEndpoints.status })
    .from(relayEndpoints)
    .where(eq(relayEndpoints.id, parent.targetEndpointId))
    .limit(1);
  const members = await db
    .select({ id: relayRoutes.id, ownerId: relayRoutes.ownerId })
    .from(relayRoutes)
    .where(eq(relayRoutes.parentRouteId, parentRouteId));
  const routes: Array<{ routeId: string; memberId: string; rank: number }> = [];
  const origin = anchor ? view.members.find((member) => member.nodeId === anchor.subjectId) : undefined;
  if (origin && anchor?.status === 'active')
    routes.push({ routeId: parent.id, memberId: origin.id, rank: origin.rank });
  for (const route of members) {
    const memberId = route.ownerId.slice(route.ownerId.lastIndexOf(':') + 1);
    const member = view.members.find((entry) => entry.id === memberId);
    if (member) routes.push({ routeId: route.id, memberId, rank: member.rank });
  }
  return routes
    .sort((left, right) => {
      const leftHolder = left.memberId === holderMemberId;
      const rightHolder = right.memberId === holderMemberId;
      if (leftHolder !== rightHolder) return leftHolder ? -1 : 1;
      return left.rank - right.rank;
    })
    .map(({ routeId, memberId }) => ({ routeId, memberId }));
}

/**
 * The member serving the set now, as Opfield knows it: the holder of the lease's primary slot (automatic), or the
 * primary of the manual pair; the set's recorded primary while no holder was observed. Only orders Opfield's attempts:
 * the relays admit the holder alone.
 */
export async function setServingMemberId(db: DrizzleExecutor, view: SetRelayView): Promise<string | null> {
  if (view.mode === 'automatic' && view.leasePolicyId) {
    const [observation] = await db
      .select({ holderId: dockerAvailabilityLeaseObservations.holderId })
      .from(dockerAvailabilityLeaseObservations)
      .where(
        and(
          eq(dockerAvailabilityLeaseObservations.policyId, view.leasePolicyId),
          eq(dockerAvailabilityLeaseObservations.slot, 0)
        )
      )
      .limit(1);
    const holder = observation?.holderId ? view.members.find((member) => member.nodeId === observation.holderId) : null;
    if (holder) return holder.id;
  }
  return view.primaryMemberId;
}
