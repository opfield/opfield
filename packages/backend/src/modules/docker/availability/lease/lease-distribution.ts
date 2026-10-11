import { inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAvailabilityLeaseState, relayPolicySigningKeys } from '@/db/schema/index.js';
import type { SyncAvailabilityLeaseCommand } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  decodeLeaseSignedBlock,
  encodeLeaseKeyRotation,
  type LeaseKeyRotationValue,
  type LeaseSignedBlockValue,
} from './lease-codec.js';
import {
  AVAILABILITY_LEASE_WATCHDOG_MISSING_CAPABILITY,
  advertisesLeaseProtocol,
  DAEMON_SYNC_RETRY_MS,
  isStorageProfileNodeType,
} from './lease-constants.js';
import { type LeaseMemberRow, loadLeaseCluster, loadLeaseKeyRotations } from './lease-store.js';

const logger = createChildLogger('AvailabilityLeaseDistribution');
const SYNC_TIMEOUT_MS = 15_000;

export interface LeaseDistributionPayload {
  revision: number;
  manifests: Buffer[];
  rotations: LeaseKeyRotationValue[];
  policyKeys: Array<{ keyId: string; publicKey: Buffer; publicKeyFingerprint: string }>;
}

/** The relay.v1 PolicyEnvelopePayload fields 40 and 41. */
export interface RelayLeasePolicyFields {
  leaseBlocks: LeaseSignedBlockValue[];
  leaseKeyRotations: LeaseKeyRotationValue[];
}

/**
 * Delivers the signed manifests (with their voters, A18) and key chain (D4, A4, A14): to daemons over CommandStream, to relays
 * inside the signed policy envelope. Blocks are never trusted because of the transport; receivers verify them.
 */
export class AvailabilityLeaseDistribution {
  /** Per daemon connection: the revision last delivered and when. */
  private readonly delivered = new Map<string, { revision: number; at: number }>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly registry: Pick<NodeRegistryService, 'getAllNodes' | 'sendCommand'>
  ) {}

  async payload(): Promise<LeaseDistributionPayload> {
    const [cluster, states, rotations, keys] = await Promise.all([
      loadLeaseCluster(this.db),
      this.db
        .select({ block: dockerAvailabilityLeaseState.manifestBlock, policyId: dockerAvailabilityLeaseState.policyId })
        .from(dockerAvailabilityLeaseState)
        .where(ne(dockerAvailabilityLeaseState.mode, 'legacy')),
      loadLeaseKeyRotations(this.db),
      this.db
        .select({
          keyId: relayPolicySigningKeys.keyId,
          publicKey: relayPolicySigningKeys.publicKey,
          fingerprint: relayPolicySigningKeys.publicKeyFingerprint,
        })
        .from(relayPolicySigningKeys)
        .where(inArray(relayPolicySigningKeys.status, ['pending', 'active', 'verification_only'])),
    ]);
    return {
      revision: cluster?.revision ?? 0,
      manifests: states
        .filter((state) => state.block)
        .sort((left, right) => left.policyId.localeCompare(right.policyId))
        .map((state) => Buffer.from(state.block!, 'base64')),
      rotations: rotations.map((link) => ({
        previousKeyId: link.previousKeyId,
        keyId: link.keyId,
        publicKey: Buffer.from(link.publicKey, 'base64'),
        publicKeyFingerprint: link.publicKeyFingerprint,
        signature: Buffer.from(link.signature, 'base64'),
      })),
      policyKeys: keys
        .map((key) => ({
          keyId: key.keyId,
          publicKey: Buffer.from(key.publicKey, 'base64'),
          publicKeyFingerprint: key.fingerprint,
        }))
        .sort((left, right) => left.keyId.localeCompare(right.keyId)),
    };
  }

  /** PolicyEnvelopePayload lease fields for every relay: each manifest carries its policy's voters and members (A18). */
  async relayFields(): Promise<RelayLeasePolicyFields> {
    const payload = await this.payload();
    return {
      leaseBlocks: payload.manifests.map((manifest) => decodeLeaseSignedBlock(manifest)),
      leaseKeyRotations: payload.rotations,
    };
  }

  daemonCommand(payload: LeaseDistributionPayload, memberId: string): SyncAvailabilityLeaseCommand {
    return {
      revision: String(payload.revision),
      memberId,
      policyKeys: payload.policyKeys,
      keyRotations: payload.rotations.map((link) => encodeLeaseKeyRotation(link)),
      // Voters travel in each manifest since A18; the field stays for older daemons.
      voterConfig: Buffer.alloc(0),
      manifests: payload.manifests,
    };
  }

  /**
   * Sends the current distribution to every connected docker, storage-profile and nginx daemon that runs the lease protocol (any
   * version: an outdated holder must still see a closed manifest) and has not applied it. A daemon that reported the
   * revision is up to date; one that did not gets it again after a short retry interval.
   */
  async syncDaemons(members: Map<string, LeaseMemberRow>, now = Date.now()): Promise<void> {
    const targets = this.registry
      .getAllNodes()
      .filter(
        (node) =>
          (node.type === 'docker' || node.type === 'nginx' || isStorageProfileNodeType(node.type)) &&
          (advertisesLeaseProtocol(node.capabilities) ||
            node.capabilities.has(AVAILABILITY_LEASE_WATCHDOG_MISSING_CAPABILITY))
      );
    const live = new Set(targets.map((node) => node.connectionId));
    for (const connectionId of this.delivered.keys()) if (!live.has(connectionId)) this.delivered.delete(connectionId);
    if (targets.length === 0) return;
    let payload: LeaseDistributionPayload | null = null;
    for (const node of targets) {
      const last = this.delivered.get(node.connectionId);
      const applied = members.get(node.nodeId)?.leaseRevision ?? 0;
      payload ??= await this.payload();
      if (payload.revision === 0) return;
      if (
        last?.revision === payload.revision &&
        (applied >= payload.revision || now - last.at < DAEMON_SYNC_RETRY_MS)
      ) {
        continue;
      }
      this.delivered.set(node.connectionId, { revision: payload.revision, at: now });
      const command = this.daemonCommand(payload, node.nodeId);
      void this.registry
        .sendCommand(node.nodeId, { syncAvailabilityLease: command }, SYNC_TIMEOUT_MS)
        .then((result) => {
          if (!result.success) {
            logger.warn('A daemon refused the availability lease distribution', {
              nodeId: node.nodeId,
              revision: command.revision,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          logger.debug('Availability lease distribution will be retried', {
            nodeId: node.nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}
