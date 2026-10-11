import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedAvailabilityMembers, relayRoutes } from '@/db/schema/index.js';
import type { WitnessPeer } from '@/grpc/generated/types.js';
import type { KeeperPeerResolver } from './relay-witness.service.js';

/**
 * Keeper addressing of a ClickHouse availability set (daemon internal/chha, P2-T07/T08).
 *
 * Keeper replicates one endpoint string per server in its cluster configuration, so every node of the set (member
 * containers and the witness relays) must reach every server under the same host:port. A set uses one loopback host
 * 127.a.b.1 (from its id) and a port per server:
 * - member Keeper raft port: 39500 + server id (server id = member index + 1; a learner Keeper, the 4th/5th member of
 *   an automatic set, has member index + 201 so its promotion to a voter is a fresh server id: re-adding a removed id
 *   crashed Keeper 25.8);
 * - witness Keeper raft port: the witness's relay-local port (39400-39499, stored on the witness row when placed);
 * - member interserver (replication fetch) port: 39000 + member index.
 * Relays bind forwarders for the members' endpoints (WitnessPeer), member daemons bind forwarders inside each member's
 * container for every other server's endpoint.
 */
export const KEEPER_MEMBER_PORT_BASE = 39500;
export const KEEPER_INTERSERVER_PORT_BASE = 39000;
/** Witness Keeper server ids start here (member server ids are member index + 1, at most 499). */
export const KEEPER_WITNESS_SERVER_ID_BASE = 1001;
/** Member indexes a ClickHouse set can address (voter and learner ids and ports stay inside their ranges). */
export const KEEPER_MAX_MEMBER_INDEX = 198;
/** Learner Keeper server ids start here (member index + this). */
export const KEEPER_LEARNER_SERVER_ID_BASE = 201;

export function keeperLoopbackHost(setId: string): string {
  const digest = createHash('sha256').update(setId).digest();
  const a = digest[0]!;
  let b = digest[1]!;
  if (a === 0 && b === 0) b = 1;
  return `127.${a}.${b}.1`;
}

export function memberKeeperServerId(memberIndex: number, learner = false): number {
  return learner ? KEEPER_LEARNER_SERVER_ID_BASE + memberIndex : memberIndex + 1;
}

export function memberKeeperPort(memberIndex: number, learner = false): number {
  return KEEPER_MEMBER_PORT_BASE + memberKeeperServerId(memberIndex, learner);
}

export function memberInterserverPort(memberIndex: number): number {
  return KEEPER_INTERSERVER_PORT_BASE + memberIndex;
}

/** Owner id of the relay-originated route from a witness to a member's Keeper port (relay-managed-availability). */
export function witnessToMemberRouteOwnerId(witnessId: string, memberId: string): string {
  return `${witnessId}>${memberId}`;
}

/**
 * The relay witness service's peer resolver for ClickHouse Keeper witnesses: the set's members as the witness reaches
 * them (their endpoint and the relay-originated route to each member's Keeper port) and the set's loopback host for
 * the witness's own raft entry. Witnesses never talk to each other: data members lead.
 */
export function createKeeperPeerResolver(db: DrizzleClient): KeeperPeerResolver {
  return async (witness) => {
    const members = await db
      .select({ id: managedAvailabilityMembers.id, memberIndex: managedAvailabilityMembers.memberIndex })
      .from(managedAvailabilityMembers)
      .where(eq(managedAvailabilityMembers.setId, witness.setId));
    const owners = members.map((member) => witnessToMemberRouteOwnerId(witness.id, member.id));
    const routes = owners.length
      ? await db
          .select({ id: relayRoutes.id, ownerId: relayRoutes.ownerId })
          .from(relayRoutes)
          .where(and(eq(relayRoutes.ownerKind, 'managed_witness_peer'), inArray(relayRoutes.ownerId, owners)))
      : [];
    const routeOf = new Map(routes.map((route) => [route.ownerId, route.id]));
    const host = keeperLoopbackHost(witness.setId);
    const peers: WitnessPeer[] = [];
    for (const member of [...members].sort((a, b) => a.memberIndex - b.memberIndex)) {
      if (member.memberIndex > KEEPER_MAX_MEMBER_INDEX) continue;
      const routeId = routeOf.get(witnessToMemberRouteOwnerId(witness.id, member.id));
      if (!routeId) continue;
      peers.push({
        serverId: memberKeeperServerId(member.memberIndex),
        host,
        port: memberKeeperPort(member.memberIndex),
        routeId,
        assignmentGeneration: '0',
      });
    }
    return { peers, raftHost: host };
  };
}
