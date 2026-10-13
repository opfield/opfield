import { createHash } from 'node:crypto';
import type { relayInstances } from '@/db/schema/index.js';
import { type LocalRelayOutage, upWhenLocalRelayWentDown } from './local-relay-outage.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

/** How an assignment serves: `active` when Opfield placed it without latency data. */
export type RelayAssignmentRole = 'primary' | 'fallback' | 'active';

export interface PlannedRelayAssignment {
  instance: RelayInstanceRow;
  role: RelayAssignmentRole;
}

/** Round-trip times one node measured, in milliseconds by relay instance id. */
export type NodeRelayLatencies = ReadonlyMap<string, number>;

/** The measured distances around one endpoint: its own node and every source node of a route to it. */
export interface EndpointLatencyPath {
  endpoint: NodeRelayLatencies | undefined;
  /** Only sources that report latencies at all; an old daemon must not hide the rest. */
  sources: NodeRelayLatencies[];
}

/**
 * The primary group has its own hysteresis. A relay joins it within 20% or 3 ms of the group's
 * anchor cost, so relays in one data center share the load even at sub-millisecond costs, and
 * leaves it only beyond both 35% and 6 ms; in between it keeps the role it has, so a relay whose
 * cost wobbles across one line never flips and never restarts the settle.
 */
const PRIMARY_ENTER_RATIO = 1.2;
const PRIMARY_ENTER_MS = 3;
const PRIMARY_LEAVE_RATIO = 1.35;
const PRIMARY_LEAVE_MS = 6;
/**
 * Moving primaries means a new generation and a drain, so a nearer relay replaces the current
 * primaries only when it is clearly nearer, both relatively and absolutely.
 */
const SWITCH_COST_RATIO = 0.7;
const SWITCH_MIN_GAIN_MS = 5;
/**
 * Rendezvous scores weigh in each relay's live pressure, which drifts. A relay of the current
 * placement keeps its slot until a challenger beats its score by a quarter: without this margin
 * two relays whose scores cross moved the endpoint (a new generation, probes and a drain) and
 * moved it back once the load turned.
 */
const MEMBER_SCORE_NUMERATOR = 5n;
const MEMBER_SCORE_DENOMINATOR = 4n;

export function rendezvousScore(endpointId: string, instance: RelayInstanceRow): bigint {
  const digest = createHash('sha256').update(`${endpointId}:${instance.id}`).digest();
  const raw = digest.readBigUInt64BE(0);
  const pressure = BigInt(Math.max(0, Math.min(99, instance.health?.pressurePercent ?? 0)));
  return raw * (100n - pressure);
}

function byRendezvous(endpointId: string, memberIds?: ReadonlySet<string>) {
  const score = (instance: RelayInstanceRow) => {
    const raw = rendezvousScore(endpointId, instance);
    return memberIds?.has(instance.id) ? (raw * MEMBER_SCORE_NUMERATOR) / MEMBER_SCORE_DENOMINATOR : raw;
  };
  return (left: RelayInstanceRow, right: RelayInstanceRow) => {
    const delta = score(right) - score(left);
    return delta > 0n ? 1 : delta < 0n ? -1 : left.id.localeCompare(right.id);
  };
}

/**
 * Fills the slots left after `taken` from ready relays by rendezvous score, one relay per fault
 * domain, until `desiredCount` relays are placed in total. `memberIds`: the relays of the current
 * placement, which keep their slots within a margin (see MEMBER_SCORE_NUMERATOR). `holdBack`: relays
 * that only fill slots no other relay takes (a relay that just came back must not displace the
 * relays an endpoint's traffic runs through).
 */
export function chooseByRendezvous(
  endpointId: string,
  instances: RelayInstanceRow[],
  desiredCount: number,
  taken: RelayInstanceRow[] = [],
  memberIds?: ReadonlySet<string>,
  holdBack?: ReadonlySet<string>
): RelayInstanceRow[] {
  const takenIds = new Set(taken.map(({ id }) => id));
  const faultDomains = new Set(taken.map(({ faultDomainId }) => faultDomainId));
  const selected: RelayInstanceRow[] = [];
  const held = (id: string) => (holdBack?.has(id) && !memberIds?.has(id) ? 1 : 0);
  const rendezvous = byRendezvous(endpointId, memberIds);
  const ranked = instances
    .filter(({ state, id }) => state === 'ready' && !takenIds.has(id))
    .sort((left, right) => held(left.id) - held(right.id) || rendezvous(left, right));
  for (const instance of ranked) {
    if (taken.length + selected.length >= desiredCount) break;
    if (faultDomains.has(instance.faultDomainId)) continue;
    faultDomains.add(instance.faultDomainId);
    selected.push(instance);
  }
  return selected;
}

/**
 * Cost of carrying the endpoint's traffic through a relay: the relay's round trip to the endpoint
 * node plus the average round trip from the source nodes. Unknown unless the endpoint node and
 * every reporting source measured the relay.
 */
export function relayPathCost(path: EndpointLatencyPath, instanceId: string): number | undefined {
  const endpointRtt = path.endpoint?.get(instanceId);
  if (endpointRtt === undefined) return undefined;
  if (!path.sources.length) return endpointRtt;
  let total = 0;
  for (const source of path.sources) {
    const rtt = source.get(instanceId);
    if (rtt === undefined) return undefined;
    total += rtt;
  }
  return endpointRtt + total / path.sources.length;
}

function entersPrimaryGroup(cost: number, anchor: number): boolean {
  return cost <= anchor * PRIMARY_ENTER_RATIO || cost <= anchor + PRIMARY_ENTER_MS;
}

function leavesPrimaryGroup(cost: number, anchor: number): boolean {
  return cost > anchor * PRIMARY_LEAVE_RATIO && cost > anchor + PRIMARY_LEAVE_MS;
}

/**
 * Places one endpoint on `desiredCount` relays. With latency data, the nearest relays form the
 * primary group and the remaining slots are standbys, nearest first (chooseStandbys). Without it, every relay
 * is active by rendezvous score, as before latency placement existed.
 *
 * `reference` holds the roles the placement is judged against: the last plan for the endpoint, or
 * its active assignments. Relays keep their role inside the hysteresis band, a relay that is
 * merely nearer than the current primaries does not displace them, and the group is anchored on
 * the current primaries until a relay is clearly nearer. Measurement noise so never changes the
 * planned roles, neither of a placed endpoint nor of one waiting for its first latency placement.
 */
export function chooseRelayAssignments(
  endpointId: string,
  instances: RelayInstanceRow[],
  desiredCount: number,
  path: EndpointLatencyPath | undefined,
  reference: ReadonlyArray<{ relayInstanceId: string; role: string }> = [],
  holdBack?: ReadonlySet<string>
): PlannedRelayAssignment[] {
  const ready = instances.filter(({ state }) => state === 'ready');
  const referenceIds = new Set(reference.map(({ relayInstanceId }) => relayInstanceId));
  const costs = new Map<string, number>();
  for (const instance of path ? ready : []) {
    // A relay that just came back is neither a primary nor the anchor of the group yet.
    if (holdBack?.has(instance.id) && !referenceIds.has(instance.id)) continue;
    const cost = relayPathCost(path!, instance.id);
    if (cost !== undefined) costs.set(instance.id, cost);
  }
  const referencePrimaryIds = new Set(
    reference.filter(({ role }) => role === 'primary').map(({ relayInstanceId }) => relayInstanceId)
  );
  const keptPrimaries = ready.filter(({ id }) => referencePrimaryIds.has(id));
  let primaries: RelayInstanceRow[];
  if (!costs.size) {
    // Latency reports lapsed (a daemon restarts, a node goes quiet): keep a latency placement
    // whose primaries all still serve instead of flapping back to hashing and forth again.
    if (!referencePrimaryIds.size || keptPrimaries.length !== referencePrimaryIds.size) {
      return chooseByRendezvous(endpointId, instances, desiredCount, [], referenceIds, holdBack).map((instance) => ({
        instance,
        role: 'active',
      }));
    }
    primaries = keptPrimaries;
  } else {
    const best = Math.min(...costs.values());
    const keptCosts = keptPrimaries.flatMap(({ id }) => (costs.has(id) ? [costs.get(id)!] : []));
    const currentCost = keptCosts.length ? Math.min(...keptCosts) : undefined;
    const clearlyNearer =
      currentCost === undefined || (best < currentCost * SWITCH_COST_RATIO && currentCost - best >= SWITCH_MIN_GAIN_MS);
    primaries = primaryGroup(endpointId, ready, costs, referencePrimaryIds, clearlyNearer ? best : currentCost!, {
      admitNewcomers: clearlyNearer,
    });
  }
  primaries = primaries.slice(0, desiredCount);
  const standbys = chooseStandbys(endpointId, instances, desiredCount, primaries, costs, referenceIds, holdBack);
  return [
    ...primaries.map((instance) => ({ instance, role: 'primary' as const })),
    ...standbys.map((instance) => ({ instance, role: 'fallback' as const })),
  ];
}

/**
 * The standbys of an endpoint: the slots left after its primaries, filled nearest first. A standby carries the
 * endpoint's traffic whenever its primaries fail, drain or restart, and daemons and Opfield can only move to the
 * relays the assignment lists, so a standby picked by hash alone sent every stream of the endpoint to a 300-ms relay
 * while a 60-ms one served its neighbours (stand rc.7, F-3).
 *
 * Relays within the primary band of the nearest measured one count as equally near and share endpoints by rendezvous
 * score; farther ones follow by cost, unmeasured ones last, and a relay that just came back (`holdBack`) only takes a
 * slot no other relay takes. A current standby (`memberIds`) keeps its slot unless a challenger is clearly nearer
 * (SWITCH_COST_RATIO and SWITCH_MIN_GAIN_MS, as for primaries), so jittery round trips never move a standby. Without
 * any measurement the standbys are chosen by rendezvous score, as before latency placement existed.
 */
function chooseStandbys(
  endpointId: string,
  instances: RelayInstanceRow[],
  desiredCount: number,
  taken: RelayInstanceRow[],
  costs: ReadonlyMap<string, number>,
  memberIds: ReadonlySet<string>,
  holdBack?: ReadonlySet<string>
): RelayInstanceRow[] {
  if (!costs.size) return chooseByRendezvous(endpointId, instances, desiredCount, taken, memberIds, holdBack);
  const takenIds = new Set(taken.map(({ id }) => id));
  const faultDomains = new Set(taken.map(({ faultDomainId }) => faultDomainId));
  const held = (id: string) => (holdBack?.has(id) && !memberIds.has(id) ? 1 : 0);
  const pool = instances.filter(({ state, id }) => state === 'ready' && !takenIds.has(id));
  const measured = pool.filter(({ id }) => !held(id) && costs.has(id)).map(({ id }) => costs.get(id)!);
  const nearest = measured.length ? Math.min(...measured) : undefined;
  const bucket = (id: string) => {
    const cost = costs.get(id);
    if (cost === undefined) return { bucket: 2, cost: 0 };
    return nearest === undefined || entersPrimaryGroup(cost, nearest) ? { bucket: 0, cost: 0 } : { bucket: 1, cost };
  };
  const rendezvous = byRendezvous(endpointId, memberIds);
  const ranked = pool.sort((left, right) => {
    const a = bucket(left.id);
    const b = bucket(right.id);
    return held(left.id) - held(right.id) || a.bucket - b.bucket || a.cost - b.cost || rendezvous(left, right);
  });
  const clearlyNearer = (challenger: number, current: number) =>
    challenger < current * SWITCH_COST_RATIO && current - challenger >= SWITCH_MIN_GAIN_MS;
  const selected: RelayInstanceRow[] = [];
  while (taken.length + selected.length < desiredCount) {
    const eligible = ranked.filter(
      (instance) => !selected.includes(instance) && !faultDomains.has(instance.faultDomainId)
    );
    let next = eligible[0];
    if (!next) break;
    const nextCost = costs.get(next.id);
    if (!memberIds.has(next.id) && nextCost !== undefined && !held(next.id)) {
      const kept = eligible.find(({ id }) => {
        const cost = costs.get(id);
        return memberIds.has(id) && cost !== undefined && !clearlyNearer(nextCost, cost);
      });
      if (kept) next = kept;
    }
    faultDomains.add(next.faultDomainId);
    selected.push(next);
  }
  return selected;
}

/**
 * The measured relays in the primary group around `anchor`: current members stay until they
 * leave the wider band, others join within the narrow one (only while the group may change
 * membership at all). Members come first, so the spread cap never swaps equal relays either.
 */
function primaryGroup(
  endpointId: string,
  ready: RelayInstanceRow[],
  costs: ReadonlyMap<string, number>,
  memberIds: ReadonlySet<string>,
  anchor: number,
  options: { admitNewcomers: boolean }
): RelayInstanceRow[] {
  const rendezvous = byRendezvous(endpointId);
  const faultDomains = new Set<string>();
  const member = (id: string) => (memberIds.has(id) ? 0 : 1);
  return ready
    .filter(({ id }) => {
      const cost = costs.get(id);
      if (cost === undefined) return false;
      if (memberIds.has(id)) return !leavesPrimaryGroup(cost, anchor);
      return options.admitNewcomers && entersPrimaryGroup(cost, anchor);
    })
    .sort(
      (left, right) =>
        member(left.id) - member(right.id) || costs.get(left.id)! - costs.get(right.id)! || rendezvous(left, right)
    )
    .filter(({ faultDomainId }) => {
      if (faultDomains.has(faultDomainId)) return false;
      faultDomains.add(faultDomainId);
      return true;
    });
}

/**
 * Makes a placement include a relay that is not co-located with Opfield (the local relay is) whenever the endpoint's
 * node can reach one, keeping its size: the local relay's slot goes to a remote relay in the same role. A placement of
 * the local relay alone does not survive the loss of the Opfield host (stand run c).
 *
 * Reachability comes from the round trips the endpoint node (and every reporting source node) measured: the nearest
 * measured remote relay is taken. When the node measured relays but none off the Opfield host, the placement stays as
 * it is and `opfieldHostOnly` says so: moving it would only produce a generation that fails its probes. A node that
 * reports no measurement keeps a remote relay it already uses and is otherwise left alone.
 */
export function includeRemoteRelay(
  endpointId: string,
  planned: PlannedRelayAssignment[],
  instances: RelayInstanceRow[],
  path?: EndpointLatencyPath,
  reference: ReadonlyArray<{ relayInstanceId: string }> = []
): { planned: PlannedRelayAssignment[]; opfieldHostOnly: boolean } {
  const unchanged = { planned, opfieldHostOnly: false };
  if (!planned.length || planned.some(({ instance }) => instance.kind !== 'local')) return unchanged;
  const taken = new Set(planned.map(({ instance }) => instance.id));
  const remotes = instances.filter(
    (instance) => instance.kind !== 'local' && instance.state === 'ready' && !taken.has(instance.id)
  );
  if (!remotes.length) return unchanged;
  let remote: RelayInstanceRow | undefined;
  if (path?.endpoint?.size) {
    const costs = new Map(
      remotes.flatMap((instance) => {
        const cost = relayPathCost(path, instance.id);
        return cost === undefined ? [] : [[instance.id, cost] as const];
      })
    );
    if (!costs.size) return { planned, opfieldHostOnly: true };
    const rendezvous = byRendezvous(endpointId);
    [remote] = remotes
      .filter(({ id }) => costs.has(id))
      .sort((left, right) => costs.get(left.id)! - costs.get(right.id)! || rendezvous(left, right));
  } else {
    const used = new Set(reference.map(({ relayInstanceId }) => relayInstanceId));
    [remote] = chooseByRendezvous(
      endpointId,
      remotes.filter(({ id }) => used.has(id)),
      1
    );
  }
  if (!remote) return unchanged;
  let index = planned.length - 1;
  while (index > 0 && planned[index]!.instance.kind !== 'local') index -= 1;
  return {
    planned: planned.map((entry, position) => (position === index ? { instance: remote!, role: entry.role } : entry)),
    opfieldHostOnly: false,
  };
}

/** Whether a generation's assignments already are the planned relays in the planned roles. */
export function samePlannedAssignments(
  assignments: ReadonlyArray<{ relayInstanceId: string; role: string }>,
  planned: ReadonlyArray<{ instance: { id: string }; role: RelayAssignmentRole }>
): boolean {
  if (assignments.length !== planned.length) return false;
  const roles = new Map(planned.map(({ instance, role }) => [instance.id, role]));
  return assignments.every(
    ({ relayInstanceId, role }) => roles.has(relayInstanceId) && roles.get(relayInstanceId) === role
  );
}

/**
 * Whether the planned relays are the generation's relays without some that drain, each other one in its role.
 * Placement then keeps the generation: a drained relay stays in it, draining there (its streams move off, it takes no
 * new tunnel), and the workload's streams on the other relays stay where they are. A new generation re-pathed every one
 * of them onto a new grant on the same relay, when the relay drained and again when it was resumed, though it carried
 * none of them (stand 2.12 R-5). Resumed, the relay serves in the generation again and nothing moves.
 */
export function onlyDrainedRelaysLeave(
  assignments: ReadonlyArray<{ relayInstanceId: string; role: string }>,
  planned: ReadonlyArray<{ instance: { id: string }; role: RelayAssignmentRole }>,
  instances: ReadonlyArray<{ id: string; state: string }>
): boolean {
  if (!planned.length || planned.length >= assignments.length) return false;
  const roles = new Map(assignments.map(({ relayInstanceId, role }) => [relayInstanceId, role]));
  if (!planned.every(({ instance, role }) => roles.get(instance.id) === role)) return false;
  const kept = new Set(planned.map(({ instance }) => instance.id));
  const states = new Map(instances.map(({ id, state }) => [id, state]));
  return assignments.every(
    ({ relayInstanceId }) => kept.has(relayInstanceId) || states.get(relayInstanceId) === 'draining'
  );
}

/**
 * The assignments a drained relay keeps in active generations next to other relays (onlyDrainedRelaysLeave). They do
 * not hold up its removal: the other relays of each generation serve the workload, and removal deletes them with the
 * relay once it carries no tunnel.
 */
export function parkedDrainedAssignmentIds(
  instance: { id: string; state: string },
  assignments: ReadonlyArray<{ id: string; assignmentGenerationId: string; relayInstanceId: string }>,
  generations: ReadonlyArray<{ id: string; state: string }>
): Set<string> {
  if (instance.state !== 'draining') return new Set();
  const active = new Set(generations.filter(({ state }) => state === 'active').map(({ id }) => id));
  const shared = new Set(
    assignments
      .filter(
        ({ relayInstanceId, assignmentGenerationId }) =>
          relayInstanceId !== instance.id && active.has(assignmentGenerationId)
      )
      .map(({ assignmentGenerationId }) => assignmentGenerationId)
  );
  return new Set(
    assignments
      .filter(
        ({ relayInstanceId, assignmentGenerationId }) =>
          relayInstanceId === instance.id && shared.has(assignmentGenerationId)
      )
      .map(({ id }) => id)
  );
}

/**
 * A remote relay whose control stream ended stays in placement this long, where it already serves:
 * otherwise a control stream that drops and comes back moves every endpoint twice, through two
 * generations. Its data plane is judged apart (relayDataPlaneFailures). The time the local relay
 * does not serve does not count (disconnectGraceStart).
 */
export const RELAY_DISCONNECT_GRACE_MS = 3 * 60_000;
/** A daemon that failed to reach a relay this long (failingMs) reports its data plane failing. */
export const RELAY_DATA_PLANE_FAILING_MS = 15_000;
/**
 * A relay that came back (ready again after it was not, or reachable again after its data plane
 * failed) only fills free slots for this long: it neither becomes a primary nor displaces a relay
 * an endpoint's traffic runs through.
 */
export const RELAY_RETURN_HOLD_MS = 2 * 60_000;

/** One node's relay round trips with how long it has failed to reach each relay. */
export type NodeRelayReachability = ReadonlyArray<{ relayInstanceId: string; failingMs: number }>;

/**
 * The relays whose data plane fails, by a clear majority of the nodes that measure them: more than
 * half of the fresh reports that name a relay say the node has failed to reach it for at least
 * RELAY_DATA_PLANE_FAILING_MS. A report of a shorter failure counts toward the reports, not toward
 * the failing ones. Such a relay is out of placement whatever its control state: a relay whose
 * control stream is up while its relay port is dead fails every generation placed on it.
 *
 * A majority, not every node: a daemon on the relay's own host (or its network) reaches the relay
 * while the rest of the fleet cannot. Nodes that do not measure a relay say nothing about it, and
 * daemons report a relay they fail to reach for as long as they keep trying it, so a relay that
 * recovered counts as reached again with their next report. Daemons without failure reports count
 * as reaching it, so with them a relay is judged by the disconnect grace alone.
 */
export function relayDataPlaneFailures(reports: ReadonlyArray<NodeRelayReachability>): Set<string> {
  const counts = new Map<string, { reports: number; failing: number }>();
  for (const report of reports) {
    for (const { relayInstanceId, failingMs } of report) {
      const count = counts.get(relayInstanceId) ?? { reports: 0, failing: 0 };
      count.reports += 1;
      if (failingMs >= RELAY_DATA_PLANE_FAILING_MS) count.failing += 1;
      counts.set(relayInstanceId, count);
    }
  }
  return new Set([...counts].filter(([, count]) => count.failing * 2 > count.reports).map(([id]) => id));
}

/** Parses how long a node failed to reach each relay it measures (relayLatencies of its health report). */
export function parseNodeRelayReachability(value: unknown): NodeRelayReachability {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sample) => {
    const { relayInstanceId, failingMs } = (sample ?? {}) as { relayInstanceId?: unknown; failingMs?: unknown };
    if (typeof relayInstanceId !== 'string' || !relayInstanceId) return [];
    const failing = typeof failingMs === 'number' && Number.isFinite(failingMs) && failingMs > 0 ? failingMs : 0;
    return [{ relayInstanceId, failingMs: failing }];
  });
}

/**
 * When a remote relay's disconnect grace starts: when it was last seen, or, for a relay that was up
 * when the local relay went down, once the local relay serves again. Every remote relay reaches
 * Opfield through the local relay, so its control stream ends with it; that time is not its own.
 */
export function disconnectGraceStart(
  lastSeenAt: number,
  outage: LocalRelayOutage | null | undefined,
  now: number
): number {
  if (!outage || !upWhenLocalRelayWentDown(lastSeenAt, outage)) return lastSeenAt;
  return Math.max(lastSeenAt, outage.servingAgainAt ?? now);
}

/**
 * Whether a relay counts as serving for placement although its control stream ended: a remote
 * relay last seen ready (not drained by an operator) within RELAY_DISCONNECT_GRACE_MS, not
 * counting a local relay outage (`outage`), whose data plane is not known to fail.
 */
export function inDisconnectGrace(
  instance: Pick<RelayInstanceRow, 'id' | 'kind' | 'state' | 'manualDrainStartedAt' | 'lastSeenAt' | 'health'>,
  now: number,
  failing: ReadonlySet<string>,
  outage?: LocalRelayOutage | null
): boolean {
  return (
    instance.kind === 'remote' &&
    instance.state === 'offline' &&
    !instance.manualDrainStartedAt &&
    instance.health?.admissionState === 'ready' &&
    Boolean(instance.lastSeenAt) &&
    now - disconnectGraceStart(instance.lastSeenAt!.getTime(), outage, now) < RELAY_DISCONNECT_GRACE_MS &&
    !failing.has(instance.id)
  );
}

/**
 * The relays placement sees: a relay in its disconnect grace counts as ready where it already
 * serves (`keep`), so a short control-stream loss changes no plan; elsewhere it stays out. A relay
 * whose data plane fails (`failing`, relayDataPlaneFailures) is out everywhere, even while its
 * control stream is up.
 */
export function placementInstances(
  instances: RelayInstanceRow[],
  grace: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  failing: ReadonlySet<string> = new Set()
): RelayInstanceRow[] {
  return instances.map((instance) => {
    if (failing.has(instance.id))
      return instance.state === 'ready' ? { ...instance, state: 'offline' as const } : instance;
    return grace.has(instance.id) && keep.has(instance.id) ? { ...instance, state: 'ready' as const } : instance;
  });
}

/** Parses the relay latencies stored with a node's health report. */
export function parseNodeRelayLatencies(value: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (!Array.isArray(value)) return result;
  for (const sample of value) {
    const { relayInstanceId, rttMs } = (sample ?? {}) as { relayInstanceId?: unknown; rttMs?: unknown };
    if (typeof relayInstanceId === 'string' && typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0) {
      result.set(relayInstanceId, rttMs);
    }
  }
  return result;
}

/**
 * The candidate role daemons see: a fallback assignment is a standby. An endpoint Opfield placed
 * without latency data (`active`) has only equal relays, each a primary to daemons: its candidates
 * still carry the relay's round trip to the endpoint (attachEndpointRtts), so daemons order them by
 * distance rather than by load. Without it an empty far relay won every new tunnel.
 */
export function candidateTopology(
  role: string
): { role: 'primary' | 'standby'; endpointRttMicros: number } | undefined {
  if (role === 'primary' || role === 'active') return { role: 'primary', endpointRttMicros: 0 };
  if (role === 'fallback') return { role: 'standby', endpointRttMicros: 0 };
  return undefined;
}

/** Whole microseconds, never 0: daemons read 0 as unknown. */
export function toRttMicros(rttMs: number): number {
  return Math.max(1, Math.round(rttMs * 1000));
}

interface GrantWithCandidates {
  endpointId?: string;
  targetEndpointId?: string;
  candidates?: Array<{ relayInstanceId: string; topology?: { endpointRttMicros: number } }>;
}

/** The endpoint node each grant's candidates lead to. */
export function grantEndpointNodeId(
  grant: GrantWithCandidates,
  endpointNodes: ReadonlyMap<string, string>
): string | undefined {
  return endpointNodes.get(grant.endpointId ?? grant.targetEndpointId ?? '');
}

/** Gives every placed candidate the last known round trip between its relay and the endpoint node. */
export function attachEndpointRtts(
  grants: GrantWithCandidates[],
  endpointNodes: ReadonlyMap<string, string>,
  latencies: ReadonlyMap<string, NodeRelayLatencies>
): void {
  for (const grant of grants) {
    const nodeId = grantEndpointNodeId(grant, endpointNodes);
    const measured = nodeId ? latencies.get(nodeId) : undefined;
    for (const candidate of grant.candidates ?? []) {
      const rtt = measured?.get(candidate.relayInstanceId);
      if (candidate.topology && rtt !== undefined) candidate.topology.endpointRttMicros = toRttMicros(rtt);
    }
  }
}

/**
 * The relay a staged generation leaves out although it serves again since the generation was planned (`plannedAt`):
 * it was planned while that relay drained, restarted or failed, so its placement is out of date. Activated anyway, it
 * put the workloads on the farther relay left over, and a Relay Pool update then drained the next relay into that
 * placement (stand rc.8, F-2: generations planned while UK drained for its update were activated 1 s after UK was
 * ready again, and the local relay's traffic went to the 300-ms relay). `backAt`: when each relay last started to
 * serve again; `serving`: the relays that serve now. Null when the generation is current.
 */
export function relayBackSincePlanned(
  plannedAt: number,
  relayIds: ReadonlySet<string>,
  backAt: ReadonlyMap<string, number>,
  serving: ReadonlySet<string>
): string | null {
  for (const [id, at] of backAt) {
    if (at > plannedAt && !relayIds.has(id) && serving.has(id)) return id;
  }
  return null;
}
