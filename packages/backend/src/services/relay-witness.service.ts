import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { managedAvailabilitySets, managedAvailabilityWitnesses } from '@/db/schema/managed-availability.js';
import { relayInstances } from '@/db/schema/relay.js';
import type {
  ApplyWitnessesCommand,
  RelayRuntimeStatus,
  WitnessArtifact,
  WitnessPeer,
  WitnessSpec,
  WitnessStatus,
} from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import { RELAY_WITNESS_CAPABILITY } from './node-dispatch.service.js';
import { parseRelayWitnessHostingLocal, relayWitnessHosting } from './relay-witness-hosting.js';

const logger = createChildLogger('RelayWitness');

/** Worker capabilities a Keeper witness depends on: members reach it, it reaches members (decision 10). */
export const RELAY_LOCAL_ENDPOINTS_CAPABILITY = 'relay_local_endpoints_v1';
export const RELAY_DIAL_ROUTE_CAPABILITY = 'relay_dial_route_v1';
export const KEEPER_WITNESS_KIND = 'clickhouse_keeper';
/** Loopback ports of relay-local endpoints (daemon-shared relaylocal): one client/raft pair per witness. */
export const RELAY_LOCAL_PORT_MIN = 39400;
export const RELAY_LOCAL_PORT_MAX = 39499;
const PORT_PAIRS = (RELAY_LOCAL_PORT_MAX - RELAY_LOCAL_PORT_MIN + 1) / 2;
/** A relay pushes again at most this often, unless the desired set changed. */
const PUSH_RETRY_MS = 30_000;
/** Reports re-plan a relay at most this often (orchestrators call syncSet on every change). */
const REPLAN_MS = 60_000;

export interface RelayWitnessRelay {
  id: string;
  nodeId: string | null;
  witnessHostingAllowed: boolean;
  witnessHostingLocal: string | null;
  features: string[];
  architecture: string | null;
}

export interface RelayWitnessRow {
  id: string;
  setId: string;
  purpose: string;
  hostKind: string;
  role: string;
  desiredState: string;
  keeperServerId: number | null;
  artifactVersion: string | null;
  artifactSha256: string | null;
  createdAt: Date;
  leasePolicyId: string | null;
}

/** Signed witness artifacts per kind, version and architecture (witness catalog). */
export interface WitnessArtifactSource {
  resolve(kind: string, version: string, arch: string): Promise<WitnessArtifact | null>;
}

/** The other Keeper voters of a set as the witness reaches them (routes and loopback addresses; P2-T08). */
export type KeeperPeerResolver = (witness: RelayWitnessRow, relay: RelayWitnessRelay) => Promise<WitnessPeer[]>;

export interface RelayWitnessPlan {
  specs: WitnessSpec[];
  /** Witnesses of this relay that do not run, and why. */
  refused: { id: string; reason: string }[];
}

/**
 * Stable relay-local ports per witness of one relay: each takes the pair its id hashes to, or the next free one, in
 * creation order. A witness keeps its ports while it lives, unless an older witness that pushed it off its pair is
 * removed (it then moves back, which republishes its relay-local endpoints).
 */
export function allocateWitnessPorts(
  witnesses: readonly { id: string; createdAt: Date }[]
): Map<string, { clientPort: number; raftPort: number }> {
  const ordered = [...witnesses].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
  );
  const taken = new Set<number>();
  const ports = new Map<string, { clientPort: number; raftPort: number }>();
  for (const witness of ordered) {
    if (taken.size >= PORT_PAIRS) break;
    let pair = createHash('sha256').update(witness.id).digest().readUInt32BE(0) % PORT_PAIRS;
    while (taken.has(pair)) pair = (pair + 1) % PORT_PAIRS;
    taken.add(pair);
    const clientPort = RELAY_LOCAL_PORT_MIN + pair * 2;
    ports.set(witness.id, { clientPort, raftPort: clientPort + 1 });
  }
  return ports;
}

/** Why a relay runs none of its witnesses, or null when it may. */
export function relayWitnessRefusal(relay: RelayWitnessRelay): string | null {
  const hosting = relayWitnessHosting(relay);
  if (hosting === 'disabled' && !relay.witnessHostingAllowed) return 'witness hosting is not allowed on this relay';
  if (hosting === 'protected_needs_opt_in') {
    return 'this relay is protected and its owner has not allowed database witnesses on it';
  }
  if (hosting === 'not_reported') return 'the relay supervisor does not run witnesses yet (update the relay)';
  if (hosting !== 'allowed') return 'the relay reports that it cannot host witnesses';
  for (const capability of [RELAY_WITNESS_CAPABILITY, RELAY_LOCAL_ENDPOINTS_CAPABILITY, RELAY_DIAL_ROUTE_CAPABILITY]) {
    if (!relay.features.includes(capability)) return 'the relay needs an update to host witnesses';
  }
  return null;
}

function hexSha256(value: string | null): string {
  return (value ?? '').replace(/^sha256:/, '').toLowerCase();
}

/**
 * The desired witness processes of one relay: Keeper witnesses (purpose keeper, hosted by a relay) that are not
 * removed, with their artifact for the relay's architecture, stable ports and peers. Lease witnesses need no process:
 * the relay worker votes in the lease itself.
 */
export function planRelayWitnesses(
  relay: RelayWitnessRelay,
  witnesses: readonly RelayWitnessRow[],
  artifacts: ReadonlyMap<string, WitnessArtifact | null>,
  peers: ReadonlyMap<string, WitnessPeer[]>
): RelayWitnessPlan {
  const keepers = witnesses.filter(
    (witness) => witness.purpose === 'keeper' && witness.hostKind === 'relay' && witness.desiredState !== 'removed'
  );
  const refusal = relayWitnessRefusal(relay);
  if (refusal) return { specs: [], refused: keepers.map((witness) => ({ id: witness.id, reason: refusal })) };
  const ports = allocateWitnessPorts(keepers);
  const plan: RelayWitnessPlan = { specs: [], refused: [] };
  for (const witness of keepers) {
    const artifact = artifacts.get(witness.id) ?? null;
    const pair = ports.get(witness.id);
    if (!witness.keeperServerId) {
      plan.refused.push({ id: witness.id, reason: 'the witness has no Keeper server id' });
    } else if (!artifact) {
      plan.refused.push({
        id: witness.id,
        reason: `no signed witness artifact ${witness.artifactVersion ?? ''} for ${relay.architecture ?? 'this architecture'}`,
      });
    } else if (witness.artifactSha256 && hexSha256(witness.artifactSha256) !== artifact.sha256) {
      plan.refused.push({ id: witness.id, reason: 'the witness artifact does not match the recorded sha256' });
    } else if (!pair) {
      plan.refused.push({ id: witness.id, reason: 'no free relay-local port on this relay' });
    } else {
      plan.specs.push({
        id: witness.id,
        setId: witness.setId,
        kind: KEEPER_WITNESS_KIND,
        role: witness.role === 'standby' || witness.desiredState === 'standby' ? 'standby' : 'active',
        artifact,
        serverId: witness.keeperServerId,
        clientPort: pair.clientPort,
        raftPort: pair.raftPort,
        raftHost: '',
        peers: peers.get(witness.id) ?? [],
        leasePolicyId: witness.leasePolicyId ?? '',
      });
    }
  }
  plan.specs.sort((a, b) => a.id.localeCompare(b.id));
  return plan;
}

function witnessRowStatus(state: string): string {
  if (state === 'running' || state === 'staged') return 'ready';
  if (state === 'error' || state === 'refused') return 'error';
  return 'pending';
}

/**
 * Desired witness processes per relay, from managed_availability_witnesses (decision 9). Pushes ApplyWitnesses when
 * the desired set of a relay changes and when a relay reports an older applied set (it reconnected, restarted or lost
 * its state), and records what relays report about their witnesses and their local hosting gate.
 */
export class RelayWitnessService {
  private artifacts?: WitnessArtifactSource;
  private peers?: KeeperPeerResolver;
  private readonly pushed = new Map<string, { hash: string; revision: number; at: number }>();
  private readonly inFlight = new Set<string>();
  private readonly plannedAt = new Map<string, number>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: Pick<NodeDispatchService, 'applyRelayWitnesses'>,
    private readonly now: () => number = Date.now
  ) {}

  setArtifactSource(source: WitnessArtifactSource): void {
    this.artifacts = source;
  }

  setKeeperPeerResolver(resolver: KeeperPeerResolver): void {
    this.peers = resolver;
  }

  private async loadRelay(relayInstanceId: string): Promise<RelayWitnessRelay | null> {
    const [row] = await this.db
      .select({
        id: relayInstances.id,
        nodeId: relayInstances.nodeId,
        witnessHostingAllowed: relayInstances.witnessHostingAllowed,
        witnessHostingLocal: relayInstances.witnessHostingLocal,
        capabilities: relayInstances.capabilities,
        nodeCapabilities: nodes.capabilities,
      })
      .from(relayInstances)
      .leftJoin(nodes, eq(nodes.id, relayInstances.nodeId))
      .where(eq(relayInstances.id, relayInstanceId))
      .limit(1);
    if (!row) return null;
    const nodeCapabilities = (row.nodeCapabilities ?? {}) as Record<string, unknown>;
    const architecture =
      (typeof nodeCapabilities.architecture === 'string' ? nodeCapabilities.architecture : null) ??
      row.capabilities?.architecture ??
      null;
    return {
      id: row.id,
      nodeId: row.nodeId,
      witnessHostingAllowed: row.witnessHostingAllowed,
      witnessHostingLocal: row.witnessHostingLocal,
      features: row.capabilities?.features ?? [],
      architecture,
    };
  }

  private async loadWitnesses(relayInstanceId: string): Promise<RelayWitnessRow[]> {
    return this.db
      .select({
        id: managedAvailabilityWitnesses.id,
        setId: managedAvailabilityWitnesses.setId,
        purpose: managedAvailabilityWitnesses.purpose,
        hostKind: managedAvailabilityWitnesses.hostKind,
        role: managedAvailabilityWitnesses.role,
        desiredState: managedAvailabilityWitnesses.desiredState,
        keeperServerId: managedAvailabilityWitnesses.keeperServerId,
        artifactVersion: managedAvailabilityWitnesses.artifactVersion,
        artifactSha256: managedAvailabilityWitnesses.artifactSha256,
        createdAt: managedAvailabilityWitnesses.createdAt,
        leasePolicyId: managedAvailabilitySets.leasePolicyId,
      })
      .from(managedAvailabilityWitnesses)
      .innerJoin(managedAvailabilitySets, eq(managedAvailabilitySets.id, managedAvailabilityWitnesses.setId))
      .where(eq(managedAvailabilityWitnesses.relayInstanceId, relayInstanceId));
  }

  /** The desired witness set of one relay; null when the relay does not exist. */
  async plan(relayInstanceId: string): Promise<(RelayWitnessPlan & { relay: RelayWitnessRelay }) | null> {
    const relay = await this.loadRelay(relayInstanceId);
    if (!relay) return null;
    const witnesses = await this.loadWitnesses(relayInstanceId);
    const artifacts = new Map<string, WitnessArtifact | null>();
    const peers = new Map<string, WitnessPeer[]>();
    for (const witness of witnesses) {
      if (witness.purpose !== 'keeper' || witness.hostKind !== 'relay' || witness.desiredState === 'removed') continue;
      artifacts.set(
        witness.id,
        witness.artifactVersion && relay.architecture && this.artifacts
          ? await this.artifacts
              .resolve(KEEPER_WITNESS_KIND, witness.artifactVersion, relay.architecture)
              .catch((error) => {
                logger.warn('Witness artifact could not be resolved', { witnessId: witness.id, error: String(error) });
                return null;
              })
          : null
      );
      peers.set(witness.id, this.peers ? await this.peers(witness, relay) : []);
    }
    return { relay, ...planRelayWitnesses(relay, witnesses, artifacts, peers) };
  }

  /** Pushes the desired set to a relay when it changed or the relay is behind; force pushes it anyway. */
  async syncRelay(
    relayInstanceId: string,
    options: { force?: boolean; reportedRevision?: number; reportedWitnesses?: number } = {}
  ): Promise<void> {
    if (this.inFlight.has(relayInstanceId)) return;
    this.inFlight.add(relayInstanceId);
    try {
      this.plannedAt.set(relayInstanceId, this.now());
      const plan = await this.plan(relayInstanceId);
      if (!plan) return;
      await this.recordRefusals(plan.refused);
      const { relay } = plan;
      // A protected relay without the opt-in refuses the command, and its own gate already stops witnesses.
      if (!relay.nodeId || relay.witnessHostingLocal === 'protected_needs_opt_in') return;
      if (!relay.features.includes(RELAY_WITNESS_CAPABILITY)) return;
      const hash = createHash('sha256').update(JSON.stringify(plan.specs)).digest('hex');
      const previous = this.pushed.get(relayInstanceId);
      const now = this.now();
      const behind = options.reportedRevision !== undefined && previous && options.reportedRevision < previous.revision;
      const changed = !previous || previous.hash !== hash;
      if (!previous && plan.specs.length === 0 && options.reportedWitnesses === 0 && !options.force) {
        // Nothing to run and nothing running: no command for relays without witnesses.
        this.pushed.set(relayInstanceId, { hash, revision: options.reportedRevision ?? 0, at: now });
        return;
      }
      if (!options.force && !changed && !(behind && now - previous.at >= PUSH_RETRY_MS)) return;
      const revision = Math.max(now, (previous?.revision ?? 0) + 1, (options.reportedRevision ?? 0) + 1);
      const command: ApplyWitnessesCommand = { revision: String(revision), witnesses: plan.specs };
      const result = await this.dispatch.applyRelayWitnesses(relay.nodeId, command);
      if (!result) return;
      if (!result.success) {
        logger.warn('Relay refused its witness set', { relayInstanceId, error: result.error });
        this.pushed.set(relayInstanceId, { hash: '', revision, at: now });
        return;
      }
      this.pushed.set(relayInstanceId, { hash, revision, at: now });
    } catch (error) {
      logger.warn('Relay witness set was not pushed', { relayInstanceId, error: String(error) });
    } finally {
      this.inFlight.delete(relayInstanceId);
    }
  }

  /** Pushes to every relay that hosts a witness of the set. */
  async syncSet(setId: string): Promise<void> {
    const rows = await this.db
      .selectDistinct({ relayInstanceId: managedAvailabilityWitnesses.relayInstanceId })
      .from(managedAvailabilityWitnesses)
      .where(eq(managedAvailabilityWitnesses.setId, setId));
    for (const row of rows) {
      if (row.relayInstanceId) await this.syncRelay(row.relayInstanceId);
    }
  }

  private async recordRefusals(refused: RelayWitnessPlan['refused']): Promise<void> {
    for (const { id, reason } of refused) {
      await this.db
        .update(managedAvailabilityWitnesses)
        .set({ observedState: 'refused', status: 'error', lastError: reason.slice(0, 1000), updatedAt: new Date() })
        .where(and(eq(managedAvailabilityWitnesses.id, id), ne(managedAvailabilityWitnesses.status, 'error')));
    }
  }

  /**
   * A relay runtime report: records its local hosting gate and the state of its witnesses, and pushes the desired set
   * when the relay is behind or the set changed.
   */
  async ingestRuntime(relayInstanceId: string, runtime: RelayRuntimeStatus): Promise<void> {
    if (runtime.witnessHosting === undefined || runtime.witnessHosting === '') return;
    const local = parseRelayWitnessHostingLocal(runtime.witnessHosting);
    const [current] = await this.db
      .select({ witnessHostingLocal: relayInstances.witnessHostingLocal })
      .from(relayInstances)
      .where(eq(relayInstances.id, relayInstanceId))
      .limit(1);
    if (current && current.witnessHostingLocal !== local) {
      await this.db
        .update(relayInstances)
        .set({ witnessHostingLocal: local, updatedAt: new Date() })
        .where(eq(relayInstances.id, relayInstanceId));
    }
    const statuses = runtime.witnesses ?? [];
    await this.recordStatuses(relayInstanceId, statuses);
    const reportedRevision = Number(runtime.appliedWitnessRevision || 0);
    const previous = this.pushed.get(relayInstanceId);
    const due =
      !previous ||
      reportedRevision < previous.revision ||
      this.now() - (this.plannedAt.get(relayInstanceId) ?? 0) >= REPLAN_MS;
    if (due) await this.syncRelay(relayInstanceId, { reportedRevision, reportedWitnesses: statuses.length });
  }

  private async recordStatuses(relayInstanceId: string, statuses: WitnessStatus[]): Promise<void> {
    if (statuses.length === 0) return;
    const ids = statuses.map((status) => status.id);
    const rows = await this.db
      .select({
        id: managedAvailabilityWitnesses.id,
        observedState: managedAvailabilityWitnesses.observedState,
        status: managedAvailabilityWitnesses.status,
        lastError: managedAvailabilityWitnesses.lastError,
      })
      .from(managedAvailabilityWitnesses)
      .where(
        and(
          inArray(managedAvailabilityWitnesses.id, ids),
          eq(managedAvailabilityWitnesses.relayInstanceId, relayInstanceId)
        )
      );
    const known = new Map(rows.map((row) => [row.id, row]));
    for (const status of statuses) {
      const row = known.get(status.id);
      if (!row) continue;
      const next = {
        observedState: status.state.slice(0, 32),
        status: witnessRowStatus(status.state),
        lastError: status.error ? status.error.slice(0, 1000) : null,
      };
      if (row.observedState === next.observedState && row.status === next.status && row.lastError === next.lastError) {
        continue;
      }
      await this.db
        .update(managedAvailabilityWitnesses)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(managedAvailabilityWitnesses.id, status.id));
    }
  }
}
