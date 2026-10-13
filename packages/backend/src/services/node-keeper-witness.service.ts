import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedAvailabilityWitnesses } from '@/db/schema/index.js';
import type {
  ApplyWitnessesCommand,
  CommandResult,
  OpfieldCommand,
  WitnessPeer,
  WitnessSpec,
} from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { createKeeperPeerResolver, keeperLoopbackHost } from './clickhouse-keeper-addressing.js';

const logger = createChildLogger('NodeKeeperWitness');

/** Docker daemons that run ClickHouse Keeper witness containers (decision 8, a non-member docker node witness). */
export const NODE_KEEPER_WITNESS_CAPABILITY = 'node_keeper_witness_v1';
/** A node is pushed its desired set again at most this often when nothing changed (it may have restarted). */
const REPUSH_MS = 5 * 60_000;

export interface NodeKeeperWitnessRow {
  id: string;
  setId: string;
  nodeId: string;
  keeperServerId: number;
  relayLocalPort: number;
  artifactVersion: string | null;
}

/**
 * The desired Keeper witness containers of one docker node. The witness's raft port (stored in relay_local_port when
 * it was placed: it is part of the Keeper cluster configuration) is where the daemon serves its witness endpoint; its
 * client port is the port below it. Peers are the set's members at their loopback endpoints with the witness's route
 * to each (the daemon binds them in the witness container's network namespace and carries them over those routes).
 */
export function planNodeKeeperWitnesses(
  witnesses: readonly NodeKeeperWitnessRow[],
  peersOf: ReadonlyMap<string, { peers: WitnessPeer[]; raftHost?: string }>
): WitnessSpec[] {
  return witnesses
    .map((witness) => {
      const resolved = peersOf.get(witness.id);
      return {
        id: witness.id,
        setId: witness.setId,
        kind: 'clickhouse_keeper',
        role: 'active',
        artifact: {
          version: witness.artifactVersion ?? '',
          downloadUrl: '',
          sha256: '',
          signedManifest: '',
          component: 'witness-clickhouse-keeper-image',
        },
        serverId: witness.keeperServerId,
        clientPort: witness.relayLocalPort - 1,
        raftPort: witness.relayLocalPort,
        raftHost: resolved?.raftHost || keeperLoopbackHost(witness.setId),
        peers: (resolved?.peers ?? []).filter((peer) => peer.routeId !== ''),
        leasePolicyId: '',
      } satisfies WitnessSpec;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface Registry {
  hasCapability(nodeId: string, capability: string): boolean;
  sendCommand(nodeId: string, command: Partial<OpfieldCommand>, timeoutMs?: number): Promise<CommandResult>;
}

/**
 * Pushes the desired Keeper witness containers to docker nodes (ApplyWitnesses, the same command relays take). The
 * daemon keeps the last applied set and runs it without Gateway.
 */
export class NodeKeeperWitnessService {
  private readonly pushed = new Map<string, { hash: string; revision: number; at: number }>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly registry: Registry,
    private readonly now: () => number = Date.now
  ) {}

  /** Pushes to every node that hosts (or hosted) a witness of the set. */
  async syncSet(setId: string): Promise<void> {
    const rows = await this.db
      .selectDistinct({ nodeId: managedAvailabilityWitnesses.nodeId })
      .from(managedAvailabilityWitnesses)
      .where(and(eq(managedAvailabilityWitnesses.setId, setId), eq(managedAvailabilityWitnesses.hostKind, 'node')));
    for (const row of rows) if (row.nodeId) await this.syncNode(row.nodeId);
  }

  async syncNode(nodeId: string, options: { force?: boolean } = {}): Promise<void> {
    if (!this.registry.hasCapability(nodeId, NODE_KEEPER_WITNESS_CAPABILITY)) return;
    try {
      const rows = await this.db
        .select({
          id: managedAvailabilityWitnesses.id,
          setId: managedAvailabilityWitnesses.setId,
          nodeId: managedAvailabilityWitnesses.nodeId,
          keeperServerId: managedAvailabilityWitnesses.keeperServerId,
          relayLocalPort: managedAvailabilityWitnesses.relayLocalPort,
          artifactVersion: managedAvailabilityWitnesses.artifactVersion,
        })
        .from(managedAvailabilityWitnesses)
        .where(
          and(
            eq(managedAvailabilityWitnesses.nodeId, nodeId),
            eq(managedAvailabilityWitnesses.hostKind, 'node'),
            // A retired witness keeps running until the holder's Keeper dropped it (relay-witness.service.ts).
            eq(managedAvailabilityWitnesses.purpose, 'keeper')
          )
        );
      const witnesses = rows.filter(
        (row): row is NodeKeeperWitnessRow => row.keeperServerId !== null && row.relayLocalPort !== null && !!row.nodeId
      );
      const resolve = createKeeperPeerResolver(this.db);
      const peersOf = new Map<string, { peers: WitnessPeer[]; raftHost?: string }>();
      for (const witness of witnesses) {
        const resolved = await resolve(
          {
            id: witness.id,
            setId: witness.setId,
            purpose: 'keeper',
            hostKind: 'node',
            role: 'active',
            desiredState: 'running',
            keeperServerId: witness.keeperServerId,
            artifactVersion: witness.artifactVersion,
            artifactSha256: null,
            createdAt: new Date(0),
            leasePolicyId: null,
            relayLocalPort: witness.relayLocalPort,
          },
          {
            id: nodeId,
            nodeId,
            witnessHostingAllowed: false,
            witnessHostingLocal: null,
            features: [],
            architecture: null,
          }
        );
        peersOf.set(witness.id, Array.isArray(resolved) ? { peers: resolved } : resolved);
      }
      const specs = planNodeKeeperWitnesses(witnesses, peersOf);
      const hash = createHash('sha256').update(JSON.stringify(specs)).digest('hex');
      const previous = this.pushed.get(nodeId);
      const now = this.now();
      if (!options.force && previous && previous.hash === hash && now - previous.at < REPUSH_MS) return;
      const revision = Math.max(now, (previous?.revision ?? 0) + 1);
      const command: ApplyWitnessesCommand = { revision: String(revision), witnesses: specs };
      const result = await this.registry.sendCommand(nodeId, { applyWitnesses: command }, 15_000);
      const ids = specs.map((spec) => spec.id);
      if (!result.success) {
        logger.warn('Node refused its Keeper witness set', { nodeId, error: result.error });
        this.pushed.set(nodeId, { hash: '', revision, at: now });
        if (ids.length) {
          await this.db
            .update(managedAvailabilityWitnesses)
            .set({
              status: 'error',
              observedState: 'refused',
              lastError: (result.error ?? 'refused').slice(0, 1000),
              updatedAt: new Date(),
            })
            .where(inArray(managedAvailabilityWitnesses.id, ids));
        }
        return;
      }
      this.pushed.set(nodeId, { hash, revision, at: now });
      if (ids.length) {
        // The daemon took the set and runs it; it reports no witness status of its own.
        await this.db
          .update(managedAvailabilityWitnesses)
          .set({ status: 'ready', observedState: 'running', lastError: null, updatedAt: new Date() })
          .where(and(inArray(managedAvailabilityWitnesses.id, ids), ne(managedAvailabilityWitnesses.status, 'ready')));
      }
    } catch (error) {
      logger.warn('Node Keeper witness set was not pushed', { nodeId, error: String(error) });
    }
  }
}
