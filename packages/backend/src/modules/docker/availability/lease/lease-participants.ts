import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, proxyAdditionalSecureLinks, proxyHosts, relayInstances } from '@/db/schema/index.js';
import { ingressGroupMembersByGroup } from '@/modules/ingress-groups/ingress-nodes.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  AVAILABILITY_LEASE_CAPABILITY,
  AVAILABILITY_LEASE_V1_CAPABILITY,
  AVAILABILITY_LEASE_WATCHDOG_MISSING_CAPABILITY,
  isStorageProfileNodeType,
  LEASE_ENTRY_STABLE_MS,
  LEASE_IMPOSSIBLE_HYSTERESIS_MS,
  MEMBER_REPORT_FRESH_MS,
  STORAGE_PROFILE_NODE_TYPES,
  VOTER_OFFLINE_REPLACE_MS,
} from './lease-constants.js';
import type { LeaseMemberRow } from './lease-store.js';
import type { DockerAvailabilityLeaseExclusionReason } from './lease-types.js';
import type { LeaseVoterCandidateNode, LeaseWitnessCandidate } from './lease-voters.js';

export type LeaseProtocolVersion = 'v2' | 'v1' | null;

/** Capabilities of the lease protocol itself (as opposed to an application capability a source requires). */
const LEASE_PROTOCOL_CAPABILITY_PREFIX = 'availability_lease_';

/** The lease protocol itself (v2, and v1 counted as outdated) is judged by the base participant rules. */
const AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES_SET: ReadonlySet<string> = new Set([
  AVAILABILITY_LEASE_CAPABILITY,
  AVAILABILITY_LEASE_V1_CAPABILITY,
]);

export interface LeaseParticipant {
  id: string;
  role: 'relay' | 'daemon';
  kind: 'docker' | 'nginx' | 'relay';
  /** Node id of the daemon; for relays the relay daemon's node, null for the local relay. */
  nodeId: string | null;
  /**
   * Physical host (A20). Daemons: their host identity, else their node id. Relays: the host identity of the node that
   * runs them, else that node's id; a relay without a node (the local combined relay) uses its fault domain, so relays
   * sharing a fault domain count as one host. Voters are deduplicated by this key across docker, nginx and relay.
   */
  hostKey: string;
  /** Relay fault domain; null for daemons. */
  faultDomain: string | null;
  /** Newest lease protocol the participant advertises; only v2 counts as current (D3). */
  protocol: LeaseProtocolVersion;
  /**
   * May vote (A18, D3): advertises availability_lease_v2 and reported an identity key; a docker daemon also must not
   * have been offline for VOTER_OFFLINE_REPLACE_MS. The watchdog does not matter for a vote.
   */
  voterCapable: boolean;
  /** Relays: voterCapable. Docker daemons: voterCapable and a running watchdog (may hold). Nginx daemons: v2. */
  capable: boolean;
  /**
   * Docker daemons only: why the node cannot hold or receive a standby right now (D3); null when it takes part.
   * Relays and nginx daemons: always null.
   */
  exclusion: DockerAvailabilityLeaseExclusionReason | null;
  /**
   * Not voter-capable for less than LEASE_IMPOSSIBLE_HYSTERESIS_MS (a daemon restarting into an update, a node
   * rolled back for a moment): a current voter or manifest candidate keeps its place meanwhile. Set by the
   * service's capability tracker; false until it ran.
   */
  withinGrace: boolean;
  /** Docker and nginx daemons: control connection to Opfield now. Relays: not offline or in error. */
  online: boolean;
  /**
   * A storage-profile docker daemon (node type storage or databases): a lease candidate of the availability sets it
   * runs a member of, never an automatic witness (the witness choice of existing policies stays as it was).
   */
  storageNode: boolean;
  /** Relays: Opfield's local relay, which stops with Opfield. */
  local: boolean;
  /** Relays: state ready. */
  ready: boolean;
  /** Docker daemons: offline for VOTER_OFFLINE_REPLACE_MS or more (never a voter then). */
  offlineLong: boolean;
  /**
   * Fully capable for a policy to enter lease mode right now: docker: v2, identity, watchdog, connected; nginx: v2,
   * connected; relay: v2, identity, ready.
   */
  entryReady: boolean;
  /**
   * Restart markers: the daemon's control connection (ms) and the lease incarnation it reports (bumped on every
   * start, A3). A change restarts the entry stability clock.
   */
  connectedAt: number | null;
  incarnation: number | null;
  /**
   * entryReady without a break or a restart for LEASE_ENTRY_STABLE_MS. Set by the service's capability tracker;
   * false until it ran.
   */
  entryStable: boolean;
  publicKey: string | null;
  /** Every capability the participant advertises (relays: their features). */
  capabilities: ReadonlySet<string>;
  /**
   * Set by restrictLeaseParticipants for one policy: capabilities the policy requires that the participant lacks.
   * Empty when it has them all (or the policy needs nothing beyond the lease protocol).
   */
  missingCapabilities: readonly string[];
}

export interface LeaseParticipants {
  relays: LeaseParticipant[];
  daemons: LeaseParticipant[];
  byId: Map<string, LeaseParticipant>;
  /** Fault domains of relays running on each host key, for the witness fallback (A19). */
  hostFaultDomains: Map<string, string[]>;
  /** Smoothed round trip (ms) a node last reported to a relay, from the relay topology data. */
  relayRtt(nodeId: string, relayId: string): number | undefined;
}

/**
 * A9: only relays in the operator's own enrolled pools take part. Every relay pool Opfield knows today is enrolled by
 * the operator; a managed or third-party pool type must return false here.
 */
export function isOperatorOwnedRelayPool(_poolId: string): boolean {
  return true;
}

function persistedCapabilities(value: unknown): string[] {
  const list = (value as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

function relayLatencies(report: unknown): Map<string, number> {
  const list = (report as { relayLatencies?: unknown } | null)?.relayLatencies;
  const result = new Map<string, number>();
  if (!Array.isArray(list)) return result;
  for (const entry of list as Array<{ relayInstanceId?: unknown; rttMs?: unknown }>) {
    // 0: a relay the node fails to reach without a recent round trip, no distance.
    if (
      typeof entry?.relayInstanceId === 'string' &&
      typeof entry.rttMs === 'number' &&
      Number.isFinite(entry.rttMs) &&
      entry.rttMs > 0
    ) {
      result.set(entry.relayInstanceId, entry.rttMs);
    }
  }
  return result;
}

/** The newest lease protocol a capability list advertises. */
export function leaseProtocolOf(has: (capability: string) => boolean): LeaseProtocolVersion {
  if (has(AVAILABILITY_LEASE_CAPABILITY)) return 'v2';
  if (has(AVAILABILITY_LEASE_V1_CAPABILITY)) return 'v1';
  return null;
}

/**
 * A member can take part in the lease only with the current capability (v2), a reported identity key and, for
 * docker daemons, a fresh watchdog heartbeat (A12.4). Nginx daemons observe only and need just the capability.
 */
export function leaseMemberCapable(
  kind: 'docker' | 'nginx' | 'relay',
  advertised: boolean,
  member: LeaseMemberRow | undefined
): boolean {
  if (!advertised) return false;
  // Nginx daemons only observe leases: no identity, no vote. The capability is all they need; their applied
  // revision only drives redelivery, so a restarted nginx daemon does not move policies out of lease mode.
  if (kind === 'nginx') return true;
  if (!member?.identityPublicKey) return false;
  return kind !== 'docker' || member.watchdogReady;
}

/**
 * D3: why a docker candidate cannot hold or get a standby. An offline node is only known as offline. A connected
 * daemon without v2 is outdated, unless it tells (or its lease reports show) that only its watchdog is missing: a
 * daemon may stop advertising the lease capability while its watchdog is down, and that is a watchdog problem.
 */
export function classifyDockerLeaseNode(input: {
  connected: boolean;
  has(capability: string): boolean;
  member: LeaseMemberRow | undefined;
  now: number;
}): DockerAvailabilityLeaseExclusionReason | null {
  if (!input.connected) return 'offline';
  const { member } = input;
  const markerMissing = input.has(AVAILABILITY_LEASE_WATCHDOG_MISSING_CAPABILITY);
  const protocol = leaseProtocolOf(input.has);
  if (protocol === 'v2') {
    if (!member?.identityPublicKey) return 'identity_pending';
    if (markerMissing || !member.watchdogReady) return 'watchdog_missing';
    return null;
  }
  if (markerMissing) return 'watchdog_missing';
  if (protocol === 'v1') return 'daemon_outdated';
  const reportsLease =
    member?.reportedAt !== null &&
    member?.reportedAt !== undefined &&
    input.now - member.reportedAt.getTime() <= MEMBER_REPORT_FRESH_MS;
  if (reportsLease && member.identityPublicKey && !member.watchdogReady) return 'watchdog_missing';
  return 'daemon_outdated';
}

/** Relays, docker and nginx daemons with what the lease needs to know about each. */
export async function loadLeaseParticipants(
  db: DrizzleClient,
  registry: Pick<NodeRegistryService, 'getNode'> & Partial<Pick<NodeRegistryService, 'isAwaitingLocalRelay'>>,
  members: Map<string, LeaseMemberRow>,
  now = Date.now()
): Promise<LeaseParticipants> {
  const [relayRows, daemonRows] = await Promise.all([
    db
      .select({
        id: relayInstances.id,
        poolId: relayInstances.poolId,
        kind: relayInstances.kind,
        state: relayInstances.state,
        nodeId: relayInstances.nodeId,
        faultDomainId: relayInstances.faultDomainId,
        capabilities: relayInstances.capabilities,
        hostIdentityId: nodes.hostIdentityId,
      })
      .from(relayInstances)
      .leftJoin(nodes, eq(nodes.id, relayInstances.nodeId))
      .where(ne(relayInstances.state, 'joining')),
    db
      .select({
        id: nodes.id,
        type: nodes.type,
        hostIdentityId: nodes.hostIdentityId,
        capabilities: nodes.capabilities,
        lastHealthReport: nodes.lastHealthReport,
        lastSeenAt: nodes.lastSeenAt,
        status: nodes.status,
      })
      .from(nodes)
      // Storage-profile daemons run the lease runtime for the availability set members they host.
      .where(inArray(nodes.type, ['docker', 'nginx', ...STORAGE_PROFILE_NODE_TYPES])),
  ]);
  const relays: LeaseParticipant[] = relayRows
    .filter((relay) => isOperatorOwnedRelayPool(relay.poolId))
    .map((relay) => {
      const member = members.get(relay.id);
      const features = relay.capabilities?.features ?? [];
      const protocol = leaseProtocolOf((capability) => features.includes(capability));
      const voterCapable = leaseMemberCapable('relay', protocol === 'v2', member);
      const ready = relay.state === 'ready';
      return {
        id: relay.id,
        role: 'relay' as const,
        kind: 'relay' as const,
        nodeId: relay.nodeId,
        hostKey: relay.hostIdentityId ?? relay.nodeId ?? `relay-fault-domain:${relay.faultDomainId}`,
        faultDomain: relay.faultDomainId,
        storageNode: false,
        protocol,
        voterCapable,
        capable: voterCapable,
        exclusion: null,
        withinGrace: false,
        online: relay.state !== 'offline' && relay.state !== 'error',
        local: relay.kind === 'local',
        ready,
        offlineLong: false,
        entryReady: voterCapable && ready,
        connectedAt: null,
        incarnation: member?.incarnation ?? null,
        entryStable: false,
        publicKey: member?.identityPublicKey ?? null,
        capabilities: new Set(features),
        missingCapabilities: [],
      };
    });
  const latencies = new Map<string, Map<string, number>>();
  const daemons: LeaseParticipant[] = daemonRows.map((node) => {
    const member = members.get(node.id);
    const connected = registry.getNode(node.id);
    const has = (capability: string) =>
      connected
        ? connected.capabilities.has(capability)
        : persistedCapabilities(node.capabilities).includes(capability);
    const protocol = leaseProtocolOf(has);
    const kind = node.type === 'nginx' ? ('nginx' as const) : ('docker' as const);
    latencies.set(node.id, relayLatencies(connected?.lastHealthReport ?? node.lastHealthReport));
    // Online, and away only because the local relay does not serve: not offline, however long that lasts.
    const awaitingLocalRelay = node.status === 'online' && Boolean(registry.isAwaitingLocalRelay?.(node.id, now));
    const offlineLong =
      !connected &&
      !awaitingLocalRelay &&
      (node.lastSeenAt === null || now - node.lastSeenAt.getTime() >= VOTER_OFFLINE_REPLACE_MS);
    const voterCapable = kind === 'docker' && protocol === 'v2' && Boolean(member?.identityPublicKey) && !offlineLong;
    const exclusion =
      kind === 'docker' ? classifyDockerLeaseNode({ connected: Boolean(connected), has, member, now }) : null;
    return {
      id: node.id,
      role: 'daemon' as const,
      kind,
      nodeId: node.id,
      hostKey: node.hostIdentityId ?? node.id,
      faultDomain: null,
      storageNode: isStorageProfileNodeType(node.type),
      protocol,
      voterCapable,
      capable: leaseMemberCapable(kind, protocol === 'v2', member),
      exclusion,
      withinGrace: false,
      online: Boolean(connected),
      local: false,
      ready: Boolean(connected),
      offlineLong,
      entryReady: kind === 'docker' ? exclusion === null : protocol === 'v2' && Boolean(connected),
      connectedAt: connected?.connectedAt ? connected.connectedAt.getTime() : null,
      incarnation: kind === 'docker' ? (member?.incarnation ?? null) : null,
      entryStable: false,
      publicKey: member?.identityPublicKey ?? null,
      capabilities: connected ? connected.capabilities : new Set(persistedCapabilities(node.capabilities)),
      missingCapabilities: [],
    };
  });
  const byId = new Map<string, LeaseParticipant>();
  for (const participant of [...relays, ...daemons]) byId.set(participant.id, participant);
  const hostFaultDomains = new Map<string, string[]>();
  for (const relay of relays) {
    if (relay.faultDomain)
      hostFaultDomains.set(relay.hostKey, [...(hostFaultDomains.get(relay.hostKey) ?? []), relay.faultDomain]);
  }
  return {
    relays,
    daemons,
    byId,
    hostFaultDomains,
    relayRtt: (nodeId, relayId) => latencies.get(nodeId)?.get(relayId),
  };
}

/**
 * Remembers since when each member has not been voter-capable for a reason other than being offline (an outdated
 * daemon or relay, a missing identity key). A current voter or manifest candidate keeps its place until that lasted
 * LEASE_IMPOSSIBLE_HYSTERESIS_MS (D3), so a daemon restarting through an update causes no voter or manifest change.
 * In memory: after an Opfield restart the grace starts again, which only delays a change.
 */
export class LeaseCapabilityTracker {
  private readonly incapableSince = new Map<string, number>();
  /** Since when each member has been entryReady, with the restart markers seen then. */
  private readonly readySince = new Map<
    string,
    { since: number; connectedAt: number | null; incarnation: number | null }
  >();

  observe(participants: LeaseParticipants, now: number): void {
    const seen = new Set<string>();
    for (const participant of participants.byId.values()) {
      seen.add(participant.id);
      this.observeEntry(participant, now);
      // An offline daemon's capabilities are the persisted ones from its last registration: not new evidence.
      if (participant.role === 'daemon' && !participant.online) {
        const since = this.incapableSince.get(participant.id);
        participant.withinGrace = since === undefined || now - since < LEASE_IMPOSSIBLE_HYSTERESIS_MS;
        continue;
      }
      const incapable = participant.protocol !== 'v2' || !participant.publicKey;
      if (!incapable) {
        this.incapableSince.delete(participant.id);
        participant.withinGrace = true;
        continue;
      }
      const since = this.incapableSince.get(participant.id) ?? now;
      this.incapableSince.set(participant.id, since);
      participant.withinGrace = now - since < LEASE_IMPOSSIBLE_HYSTERESIS_MS;
    }
    for (const id of this.incapableSince.keys()) if (!seen.has(id)) this.incapableSince.delete(id);
    for (const id of this.readySince.keys()) if (!seen.has(id)) this.readySince.delete(id);
  }

  /** Entry stability: a loss of readiness, a reconnect or a new incarnation (a restart) starts the clock again. */
  private observeEntry(participant: LeaseParticipant, now: number): void {
    if (!participant.entryReady) {
      this.readySince.delete(participant.id);
      participant.entryStable = false;
      return;
    }
    const previous = this.readySince.get(participant.id);
    const entry =
      previous &&
      previous.connectedAt === participant.connectedAt &&
      (previous.incarnation === null ||
        participant.incarnation === null ||
        previous.incarnation === participant.incarnation)
        ? { ...previous, incarnation: previous.incarnation ?? participant.incarnation }
        : { since: now, connectedAt: participant.connectedAt, incarnation: participant.incarnation };
    this.readySince.set(participant.id, entry);
    participant.entryStable = now - entry.since >= LEASE_ENTRY_STABLE_MS;
  }
}

/**
 * The participants as one lease policy sees them when it requires capabilities beyond the lease protocol (a stateful
 * policy needs availability_lease_v3 on every participant and its application capability on every candidate, AS8): a
 * member that lacks one cannot vote, hold, witness, keep shadow accepts or carry the policy's traffic, and keeps no
 * grace (a v2 acceptor never counts for a stateful key). A docker candidate without them is excluded like an
 * outdated daemon.
 */
export function restrictLeaseParticipants(
  participants: LeaseParticipants,
  requiredCapabilities: readonly string[],
  candidateIds: ReadonlySet<string> = new Set()
): LeaseParticipants {
  const extra = [...new Set(requiredCapabilities)].filter(
    (capability) => !AVAILABILITY_LEASE_PROTOCOL_CAPABILITIES_SET.has(capability)
  );
  if (extra.length === 0) return participants;
  // Lease protocol capabilities (availability_lease_v3) bind every participant; an application capability (the
  // managed-database member runtime) binds the candidates only: relays and witnesses never run the application.
  const protocol = extra.filter((capability) => capability.startsWith(LEASE_PROTOCOL_CAPABILITY_PREFIX));
  const restrict = (participant: LeaseParticipant): LeaseParticipant => {
    const needed = candidateIds.has(participant.id) ? extra : protocol;
    const missing = needed.filter((capability) => !participant.capabilities.has(capability));
    if (missing.length === 0) return participant;
    return {
      ...participant,
      voterCapable: false,
      capable: false,
      entryReady: false,
      entryStable: false,
      withinGrace: false,
      exclusion: participant.kind === 'docker' ? (participant.exclusion ?? 'daemon_outdated') : participant.exclusion,
      missingCapabilities: missing,
    };
  };
  const relays = participants.relays.map(restrict);
  const daemons = participants.daemons.map(restrict);
  const byId = new Map<string, LeaseParticipant>();
  for (const participant of [...relays, ...daemons]) byId.set(participant.id, participant);
  return { ...participants, relays, daemons, byId };
}

/**
 * A member that may keep a voter place it already has (D3): voter-capable, or inside the grace of a short
 * incapability while it still has an identity key. Never a daemon offline for VOTER_OFFLINE_REPLACE_MS.
 */
export function keepsLeaseVoterPlace(participant: LeaseParticipant | undefined): boolean {
  if (!participant) return false;
  if (participant.voterCapable) return true;
  return (
    !participant.offlineLong &&
    participant.withinGrace &&
    Boolean(participant.publicKey) &&
    participant.protocol !== null
  );
}

/**
 * D3: whether a candidate node goes into the manifest (may acquire). Not a node whose daemon is outdated or has not
 * reported an identity, unless it holds or runs a copy now (removing it would fence it) or it is listed already and
 * the condition is younger than the grace. Offline and watchdog-less nodes stay listed: the data plane keeps them
 * from holding by itself.
 */
export function manifestCandidateAllowed(
  participant: LeaseParticipant | undefined,
  context: { active: boolean; listed: boolean }
): boolean {
  if (!participant?.publicKey) return false;
  if (context.active) return true;
  if (participant.exclusion !== 'daemon_outdated' && participant.exclusion !== 'identity_pending') return true;
  return context.listed && participant.withinGrace;
}

/** Candidate nodes of a policy, in rank order, as voter candidates (A18). */
export function leaseVoterCandidates(
  participants: LeaseParticipants,
  rankedNodeIds: string[],
  currentVoters: ReadonlySet<string> = new Set()
): LeaseVoterCandidateNode[] {
  return rankedNodeIds.flatMap((id) => {
    const participant = participants.byId.get(id);
    if (!participant) return [];
    const votes = participant.voterCapable || (currentVoters.has(id) && keepsLeaseVoterPlace(participant));
    return [
      {
        id,
        hostKey: participant.hostKey,
        faultDomains: participants.hostFaultDomains.get(participant.hostKey) ?? [],
        publicKey: participant.publicKey,
        voterCapable: votes,
      },
    ];
  });
}

/**
 * Members that may be a witness (A19): relays and docker daemons that may vote (D3: v2 only; a current witness keeps
 * its place through a short incapability). nginx daemons are observers only. Round trips are known only from a
 * candidate node to a relay (relay topology data); docker witnesses rank without one.
 */
export function leaseWitnessPool(
  participants: LeaseParticipants,
  currentWitnesses: ReadonlySet<string> = new Set()
): LeaseWitnessCandidate[] {
  return [
    ...participants.relays,
    ...participants.daemons.filter((daemon) => daemon.kind === 'docker' && !daemon.storageNode),
  ].map((participant) => ({
    id: participant.id,
    kind: participant.kind === 'relay' ? ('relay' as const) : ('docker' as const),
    hostKey: participant.hostKey,
    faultDomain: participant.faultDomain,
    capable: participant.voterCapable || (currentWitnesses.has(participant.id) && keepsLeaseVoterPlace(participant)),
    local: participant.local,
    ready: participant.kind === 'relay' ? participant.ready && participant.voterCapable : participant.voterCapable,
    publicKey: participant.publicKey,
    rttFrom: (candidateId: string) =>
      participant.kind === 'relay' ? participants.relayRtt(candidateId, participant.id) : undefined,
  }));
}

/**
 * The ingress nginx nodes of a policy's routes: for each Availability placement, every node that sources its member
 * Secure Link. A route on an ingress group has a source on every member (each opens the member's socket while the
 * placement's candidate holds the lease), so every member takes part in the policy; a single-node route keeps its
 * one node. Returned as (placement id, node id) pairs.
 */
export async function leaseIngressNodesOfPlacements(
  db: DrizzleClient,
  placementIds: readonly string[]
): Promise<Array<{ referenceId: string; nodeId: string }>> {
  if (placementIds.length === 0) return [];
  const rows = await db
    .select({
      referenceId: proxyAdditionalSecureLinks.referenceId,
      sourceNodeId: proxyAdditionalSecureLinks.sourceNodeId,
      ingressGroupId: proxyHosts.ingressGroupId,
    })
    .from(proxyAdditionalSecureLinks)
    .innerJoin(proxyHosts, eq(proxyHosts.id, proxyAdditionalSecureLinks.proxyHostId))
    .where(
      and(
        eq(proxyAdditionalSecureLinks.purpose, 'availability_member'),
        inArray(proxyAdditionalSecureLinks.referenceId, [...placementIds])
      )
    );
  const groups = await ingressGroupMembersByGroup(
    db,
    rows.flatMap((row) => (row.ingressGroupId ? [row.ingressGroupId] : []))
  );
  return rows.flatMap((row) => {
    if (!row.referenceId) return [];
    const members = row.ingressGroupId ? (groups.get(row.ingressGroupId) ?? []) : [];
    const sources = members.length > 0 ? members : [row.sourceNodeId];
    return sources.map((nodeId) => ({ referenceId: row.referenceId!, nodeId }));
  });
}
