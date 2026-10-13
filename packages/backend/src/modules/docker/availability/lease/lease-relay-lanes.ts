import { and, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  nodes,
  relayInstances,
} from '@/db/schema/index.js';
import { advertisesLeaseProtocol, STORAGE_PROFILE_NODE_TYPES } from './lease-constants.js';
import { isOperatorOwnedRelayPool } from './lease-participants.js';

/** Relay transport of a lease lane, in the shape of a relay grant candidate's transport fields. */
export interface LeaseLaneRelay {
  id: string;
  poolId: string;
  kind: 'local' | 'remote';
  addresses: string[];
  port: number;
  certificateIdentity: string;
  certificateFingerprint: string;
  capabilities: string[];
}

function features(value: unknown): string[] {
  const list = (value as { features?: unknown } | null)?.features;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Docker nodes that take part in a policy outside legacy mode: its voters and the nodes of its placements (the
 * candidates). They need lease lanes to every member relay.
 */
export async function leaseLaneNodeIds(db: DrizzleClient): Promise<string[]> {
  const states = await db
    .select({
      policyId: dockerAvailabilityLeaseState.policyId,
      quorumSets: dockerAvailabilityLeaseState.quorumSets,
      candidateMemberIds: dockerAvailabilityLeaseState.candidateMemberIds,
    })
    .from(dockerAvailabilityLeaseState)
    .where(ne(dockerAvailabilityLeaseState.mode, 'legacy'));
  if (states.length === 0) return [];
  const placements = await db
    .select({ nodeId: dockerAvailabilityPlacements.nodeId })
    .from(dockerAvailabilityPlacements)
    .where(
      and(
        inArray(
          dockerAvailabilityPlacements.policyId,
          states.map((state) => state.policyId)
        ),
        ne(dockerAvailabilityPlacements.desiredState, 'removed')
      )
    );
  // Candidates of every kind (a managed database's members); for Availability they are a subset of the placements.
  const ids = [
    ...new Set([
      ...states.flatMap((state) => [...state.quorumSets.flat(), ...state.candidateMemberIds]),
      ...placements.map(({ nodeId }) => nodeId),
    ]),
  ];
  if (ids.length === 0) return [];
  // Quorum sets also name relays (witnesses): only docker and storage-profile nodes get relay grant bundles.
  const dockerNodes = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(inArray(nodes.id, ids), inArray(nodes.type, ['docker', ...STORAGE_PROFILE_NODE_TYPES])));
  return dockerNodes.map(({ id }) => id).sort();
}

/**
 * Lease lanes (stand run c1). A docker daemon exchanges lease frames only over the relay transports it holds, and it
 * used to hold transports only to relays that carry one of its Secure Link endpoints: a voter whose endpoints were all
 * assigned to the local relay could vote only through Opfield, so with Opfield down its vote was lost. Every node that
 * takes part in a lease-mode policy gets a transport to every relay the manifests list as a member (every capable
 * relay of the operator's pools, A18), independent of endpoint assignment. Empty for any other node.
 */
export async function leaseLaneRelays(db: DrizzleClient, nodeId: string): Promise<LeaseLaneRelay[]> {
  if (!(await leaseLaneNodeIds(db)).includes(nodeId)) return [];
  const rows = await db
    .select({
      id: relayInstances.id,
      poolId: relayInstances.poolId,
      kind: relayInstances.kind,
      addresses: relayInstances.advertisedAddresses,
      port: relayInstances.servicePort,
      certificateIdentity: relayInstances.certificateIdentity,
      certificateFingerprint: relayInstances.certificateFingerprint,
      capabilities: relayInstances.capabilities,
    })
    .from(relayInstances)
    .where(inArray(relayInstances.state, ['ready', 'draining']));
  return rows
    .filter((row) => {
      const advertised = features(row.capabilities);
      return (
        isOperatorOwnedRelayPool(row.poolId) &&
        advertisesLeaseProtocol(advertised) &&
        advertised.includes('relay_pool_v1') &&
        (row.kind === 'local' || Boolean(row.certificateIdentity && row.certificateFingerprint))
      );
    })
    .map((row) => ({
      id: row.id,
      poolId: row.poolId,
      kind: row.kind,
      addresses: row.addresses,
      port: row.port,
      certificateIdentity: row.certificateIdentity ?? '',
      certificateFingerprint: row.certificateFingerprint ?? '',
      capabilities: features(row.capabilities),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
