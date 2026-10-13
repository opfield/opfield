import { connect } from 'node:net';
import type { OpfieldStream, OpfieldStreamRegistry } from '@/grpc/tunnel-worker/host.js';
import { createChildLogger } from '@/lib/logger.js';
import type { LocalRelayOutageSignal } from './local-relay-outage.js';

const logger = createChildLogger('OpfieldRelayPaths');

/**
 * Opfield's own relayed streams (database viewer, storage browser, database monitoring, PG links) choose and leave
 * relays as the daemons do (relaybridge OrderCandidates, ReturnTarget, relayresume.Returner): by measured distance, and
 * back to the nearest relay once it is stable again. Before, they took the assignment's order: during a local relay
 * outage they went to whichever relay came first, a 300-ms one rather than a 60-ms one, and stayed there (stand rc.5,
 * O-1).
 *
 * Like the daemons, Opfield measures every remote relay of the pool all the time, not only the relays its recent
 * assignments named: its long-lived streams open no new path for hours, and a relay measured only around new paths
 * had no distance left when a quiet period ended in a local relay stop, so its streams took the first listed relay
 * (stand rc.6, F-3).
 */

/** How often Opfield measures its round trip to each remote relay of the pool (as daemons). */
export const OPFIELD_RELAY_SAMPLE_INTERVAL_MS = 30_000;
/**
 * A round trip measured longer ago than this no longer averages with a new one and makes no relay stable for a
 * return; it still orders the relays until a fresher one exists.
 */
const LATENCY_MAX_AGE_MS = 3 * 60_000;
/** The share of a new sample in the moving average (as daemons). */
const LATENCY_WEIGHT = 0.3;
const PROBE_TIMEOUT_MS = 3_000;
/** A relay outside the pool that no assignment named for this long is no longer measured. */
const TARGET_TTL_MS = 10 * 60_000;
/** How long a new stream waits for the first round trip of a relay never measured before it orders its relays. */
export const OPFIELD_FIRST_SAMPLE_WAIT_MS = 1_000;
/** A relay must have been reached without a break this long before streams return to it (ReturnStableFor). */
export const OPFIELD_RETURN_STABLE_MS = 20_000;
/** A route's candidates are fetched again for a return judgement once they are this old. */
const ROUTE_CANDIDATES_FRESH_MS = 30_000;
/** Returner pacing, as relayresume: a pass every 10 s, at most 32 moves a pass, none for a stream moved within 20 s. */
export const OPFIELD_RETURN_INTERVAL_MS = 10_000;
const OPFIELD_RETURN_BATCH = 32;
export const OPFIELD_RETURN_COOLDOWN_MS = 20_000;
/** After a placement change, the return pass runs this soon (assignmentsChanged): the measuring pass ends first. */
export const OPFIELD_PROMPT_RETURN_MS = 3_000;

/** Relays of one role within this band of the nearest are equally near (relaybridge costBand). */
const COST_BAND_RATIO = 1.2;
const COST_BAND_FLOOR_MS = 3;
/** A stream returns from a farther relay of its role only beyond this band (relaybridge returnBand). */
const RETURN_BAND_RATIO = 1.5;
const RETURN_BAND_FLOOR_MS = 10;

export interface OpfieldRelayCandidate {
  relayInstanceId: string;
  assignmentState: string;
  addresses: string[];
  port: number;
  local?: boolean;
  topology?: { role: 'primary' | 'standby' };
}

/** A remote relay of the pool for Opfield to measure. */
export interface OpfieldRelayTarget {
  relayInstanceId: string;
  addresses: string[];
  port: number;
}

/** Where one relay stands for Opfield: reachable now, its measured round trip, reached without a break long enough. */
export interface OpfieldRelayPlace {
  available: boolean;
  rttMs?: number;
  stable: boolean;
}

const roleRank = (candidate: OpfieldRelayCandidate) => (candidate.topology?.role === 'standby' ? 1 : 0);
const costBand = (nearest: number) => Math.max(nearest * COST_BAND_RATIO, nearest + COST_BAND_FLOOR_MS);
const returnBand = (nearest: number) => Math.max(nearest * RETURN_BAND_RATIO, nearest + RETURN_BAND_FLOOR_MS);

/**
 * The order to try relays for one of Opfield's streams (relaybridge OrderCandidates): the relay being left last, relays
 * reachable now first, primaries before standbys, then by distance: relays of a role within the band of the nearest
 * reachable one are equally near, farther ones follow by round trip, unmeasured ones last. Only then an active
 * assignment before a staging one, then the assignment's order.
 *
 * Distance before assignment state: while a placement change is staged, the serving relay of the staged assignment
 * (registered on both ends, probed) is a better path than the farther fallback of the assignment it replaces. Before,
 * a stream opened while the local relay's assignment was staged after its restart, and the active one's nearer relay
 * did not answer, went to the 300-ms fallback instead of the local relay (stand rc.10, F-1).
 */
export function orderOpfieldRelayCandidates<T extends OpfieldRelayCandidate>(
  candidates: readonly T[],
  place: (candidate: T) => OpfieldRelayPlace,
  avoidRelayId: string | null = null
): T[] {
  const places = new Map(candidates.map((candidate) => [candidate, place(candidate)]));
  const nearest = new Map<number, number>();
  for (const [candidate, at] of places) {
    if (!at.available || at.rttMs === undefined) continue;
    const role = roleRank(candidate);
    nearest.set(role, Math.min(nearest.get(role) ?? Number.POSITIVE_INFINITY, at.rttMs));
  }
  const tier = (candidate: T) => {
    const at = places.get(candidate)!;
    if (at.rttMs === undefined) return { tier: 2, cost: 0 };
    const best = nearest.get(roleRank(candidate));
    return best === undefined || at.rttMs <= costBand(best) ? { tier: 0, cost: 0 } : { tier: 1, cost: at.rttMs };
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, at: places.get(candidate)!, tier: tier(candidate) }))
    .sort(
      (a, b) =>
        Number(a.candidate.relayInstanceId === avoidRelayId) - Number(b.candidate.relayInstanceId === avoidRelayId) ||
        Number(b.at.available) - Number(a.at.available) ||
        roleRank(a.candidate) - roleRank(b.candidate) ||
        a.tier.tier - b.tier.tier ||
        a.tier.cost - b.tier.cost ||
        Number(a.candidate.assignmentState === 'staging') - Number(b.candidate.assignmentState === 'staging') ||
        a.index - b.index
    )
    .map(({ candidate }) => candidate);
}

/**
 * The relay a stream on `currentRelayId` should move back to, if any (relaybridge ReturnTarget): the nearest relay
 * reachable and stable for a while, when it stands clearly better than the current one: a primary while the stream is
 * on a standby, a relay of the same role nearer by more than the return band, or a measured one while the current
 * relay's distance is unknown. A stream whose relay is down is left to its path failure.
 */
export function opfieldReturnTarget<T extends OpfieldRelayCandidate>(
  candidates: readonly T[],
  place: (candidate: T) => OpfieldRelayPlace,
  currentRelayId: string
): T | null {
  const active = candidates.filter(({ assignmentState }) => assignmentState === 'active');
  const current = active.find(({ relayInstanceId }) => relayInstanceId === currentRelayId);
  if (!current || active.length < 2) return null;
  const currentPlace = place(current);
  if (!currentPlace.available) return null;
  // Another relay counts only once it has been reachable without a break for a while: one that just came back (or
  // keeps flapping) takes nothing yet.
  const steady = (candidate: T): OpfieldRelayPlace => {
    const at = place(candidate);
    return candidate === current || at.stable ? at : { ...at, available: false };
  };
  const best = orderOpfieldRelayCandidates(active, steady).find((candidate) => steady(candidate).available);
  if (!best || best === current) return null;
  const target = place(best);
  if (roleRank(best) < roleRank(current)) return best;
  if (roleRank(best) > roleRank(current) || target.rttMs === undefined) return null;
  if (currentPlace.rttMs === undefined) return best;
  return currentPlace.rttMs > returnBand(target.rttMs) ? best : null;
}

interface LatencySample {
  rttMs: number | null;
  at: number;
  /** Since when it has been reached without a failure; null while it fails. */
  reachedSince: number | null;
}

type Dial = (address: string, port: number, timeoutMs: number) => Promise<number>;

/** One TCP handshake's round trip, as daemons measure a relay they keep no lanes to. */
const dialRoundTrip: Dial = (address, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = connect({ host: address, port });
    const timer = setTimeout(() => socket.destroy(new Error('relay round trip timed out')), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      const rtt = performance.now() - startedAt;
      socket.destroy();
      resolve(rtt);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

/**
 * Opfield's view of the relays its own streams use: the remote relays' measured round trips, the local relay's state
 * from its supervisor, and the routes' candidates; it orders a stream's relays and moves streams back to the nearest
 * relay, paced.
 */
export class OpfieldRelayPaths {
  private readonly samples = new Map<string, LatencySample>();
  private readonly targets = new Map<string, { addresses: string[]; port: number; seenAt: number }>();
  private readonly routes = new Map<string, { candidates: OpfieldRelayCandidate[]; at: number }>();
  private localRelay?: Pick<LocalRelayOutageSignal, 'latestOutage'>;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private returner: ReturnType<typeof setInterval> | null = null;
  private promptReturn: ReturnType<typeof setTimeout> | null = null;
  private sampling: Promise<void> | null = null;
  /** The remote relays of the pool at the last measuring pass: measured for as long as they are in it. */
  private pool = new Set<string>();
  private readonly now: () => number;
  private readonly dial: Dial;
  private readonly poolRelays?: () => Promise<OpfieldRelayTarget[]>;

  constructor(
    private readonly registry: OpfieldStreamRegistry,
    /** A fresh assignment of an Opfield route (its candidates now). */
    private readonly fetchCandidates: (routeId: string) => Promise<OpfieldRelayCandidate[]>,
    options: { now?: () => number; dial?: Dial; poolRelays?: () => Promise<OpfieldRelayTarget[]> } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.dial = options.dial ?? dialRoundTrip;
    this.poolRelays = options.poolRelays;
  }

  setLocalRelay(signal: Pick<LocalRelayOutageSignal, 'latestOutage'>): void {
    this.localRelay = signal;
  }

  /** Where a relay stands now (OpfieldRelayPlace). The local relay is on Opfield's host: no distance to speak of. */
  place(candidate: OpfieldRelayCandidate): OpfieldRelayPlace {
    const now = this.now();
    if (candidate.local) {
      const outage = this.localRelay?.latestOutage() ?? null;
      const serving = !outage || outage.servingAgainAt !== null;
      const stable = serving && (!outage || now - outage.servingAgainAt! >= OPFIELD_RETURN_STABLE_MS);
      return { available: serving, rttMs: 0, stable };
    }
    const sample = this.samples.get(candidate.relayInstanceId);
    if (!sample) return { available: true, stable: false };
    if (now - sample.at > LATENCY_MAX_AGE_MS) {
      // Not measured lately: its last round trip still orders it until a fresher one exists, but it is not stable.
      return { available: true, ...(sample.rttMs !== null ? { rttMs: sample.rttMs } : {}), stable: false };
    }
    return {
      available: sample.reachedSince !== null,
      ...(sample.rttMs !== null ? { rttMs: sample.rttMs } : {}),
      stable: sample.reachedSince !== null && now - sample.reachedSince >= OPFIELD_RETURN_STABLE_MS,
    };
  }

  /** The candidates of one of Opfield's streams in the order to try them (orderOpfieldRelayCandidates). */
  order<T extends OpfieldRelayCandidate>(routeId: string, candidates: readonly T[], avoidRelayId: string | null): T[] {
    this.note(routeId, candidates);
    return orderOpfieldRelayCandidates(candidates, (candidate) => this.place(candidate), avoidRelayId);
  }

  /** Remembers a route's candidates and the remote relays to measure; measures new ones at once. */
  note(routeId: string, candidates: readonly OpfieldRelayCandidate[]): void {
    const now = this.now();
    this.routes.set(routeId, { candidates: [...candidates], at: now });
    let unmeasured = false;
    for (const candidate of candidates) {
      if (candidate.local || !candidate.addresses.length || !candidate.port) continue;
      unmeasured ||= !this.samples.has(candidate.relayInstanceId);
      this.targets.set(candidate.relayInstanceId, {
        addresses: candidate.addresses,
        port: candidate.port,
        seenAt: now,
      });
    }
    this.start();
    if (unmeasured) void this.sample();
  }

  /**
   * Waits, at most maxWaitMs, for a first round trip of the candidates' remote relays that were never measured (a
   * relay that just joined the pool, or Opfield that just started): ordered without one, a stream would take the
   * relay listed first.
   */
  async measure(
    routeId: string,
    candidates: readonly OpfieldRelayCandidate[],
    maxWaitMs = OPFIELD_FIRST_SAMPLE_WAIT_MS
  ): Promise<void> {
    const unmeasured = () =>
      candidates.some(
        (candidate) =>
          !candidate.local &&
          candidate.addresses.length > 0 &&
          candidate.port > 0 &&
          !this.samples.has(candidate.relayInstanceId)
      );
    if (!unmeasured()) return;
    this.note(routeId, candidates);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), maxWaitMs);
      timer.unref?.();
    });
    try {
      // A pass already running may have started before these relays were known: then one more.
      for (let pass = 0; pass < 2 && unmeasured(); pass += 1) {
        if (!(await Promise.race([this.sample().then(() => true), timeout]))) return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Measures every remote relay of the pool and of a recent assignment once (concurrent calls share one pass). */
  sample(): Promise<void> {
    this.sampling ??= this.runSample().finally(() => {
      this.sampling = null;
    });
    return this.sampling;
  }

  private async runSample(): Promise<void> {
    await this.refreshPool();
    const now = this.now();
    for (const [id, target] of this.targets) {
      if (!this.pool.has(id) && now - target.seenAt > TARGET_TTL_MS) {
        this.targets.delete(id);
        this.samples.delete(id);
      }
    }
    await Promise.all(
      [...this.targets].map(async ([id, target]) => {
        let rttMs: number | null = null;
        for (const address of target.addresses) {
          try {
            rttMs = await this.dial(address, target.port, PROBE_TIMEOUT_MS);
            break;
          } catch {
            // The next address, if any.
          }
        }
        this.observe(id, rttMs);
      })
    );
  }

  /** Takes the pool's remote relays as targets; on a failed read the last pool stays. */
  private async refreshPool(): Promise<void> {
    if (!this.poolRelays) return;
    let relays: OpfieldRelayTarget[];
    try {
      relays = await this.poolRelays();
    } catch (error) {
      logger.debug('The relay pool was not read for Opfield relay round trips', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const now = this.now();
    const pool = new Set<string>();
    for (const relay of relays) {
      if (!relay.addresses.length || !relay.port) continue;
      pool.add(relay.relayInstanceId);
      this.targets.set(relay.relayInstanceId, { addresses: relay.addresses, port: relay.port, seenAt: now });
    }
    this.pool = pool;
  }

  /** Folds one measurement in (null: the relay was not reached; its last round trip stays, as daemons keep it). */
  observe(relayInstanceId: string, rttMs: number | null): void {
    const now = this.now();
    const previous = this.samples.get(relayInstanceId);
    const fresh = previous && now - previous.at <= LATENCY_MAX_AGE_MS ? previous : undefined;
    if (rttMs === null) {
      this.samples.set(relayInstanceId, { rttMs: previous?.rttMs ?? null, at: now, reachedSince: null });
      return;
    }
    const smoothed = fresh && fresh.rttMs !== null ? fresh.rttMs + LATENCY_WEIGHT * (rttMs - fresh.rttMs) : rttMs;
    this.samples.set(relayInstanceId, { rttMs: smoothed, at: now, reachedSince: fresh?.reachedSince ?? now });
  }

  /**
   * One returner pass (relayresume.Returner): each open stream that has not moved for the cooldown and stands on a
   * relay with a clearly nearer one (opfieldReturnTarget) moves through the planned path, at a random time within the
   * pass, at most a batch per pass. A planned move keeps the stream where it is when no new path opens; nothing is cut.
   */
  async returnPass(random: () => number = Math.random): Promise<number> {
    const now = this.now();
    // The streams live in the tunnel worker: a fresh list each pass.
    const sessions = [...(await this.registry.liveSessions())];
    for (let index = sessions.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [sessions[index], sessions[other]] = [sessions[other]!, sessions[index]!];
    }
    let moved = 0;
    for (const session of sessions) {
      if (moved >= OPFIELD_RETURN_BATCH) break;
      const relayId = session.relayId;
      if (!relayId || !session.movable || now - session.lastMoveAt < OPFIELD_RETURN_COOLDOWN_MS) continue;
      if (!(await this.nearerRelay(session, relayId))) continue;
      const delay = Math.floor(random() * OPFIELD_RETURN_INTERVAL_MS);
      // Bound to the relay judged here: a stream that moved meanwhile is not moved again.
      this.registry.timers.setTimeout(() => this.registry.schedule(() => session.migrate('return', relayId)), delay);
      moved += 1;
    }
    return moved;
  }

  /**
   * Judged on the route's current candidates, looked up again once they are ROUTE_CANDIDATES_FRESH_MS old. The
   * candidates the stream last dialed are not enough: after a placement change the nearest relay is often not among
   * them (a stream that moved to UK while the local relay drained had dialed {UK, NL}; the assignment that put the
   * local relay back was never looked at), so the stream stayed on the farther relay for hours (stand rc.7, F-3).
   */
  private async nearerRelay(session: OpfieldStream, relayId: string): Promise<boolean> {
    const place = (candidate: OpfieldRelayCandidate) => this.place(candidate);
    let route = this.routes.get(session.routeId);
    if (!route) return false;
    if (this.now() - route.at > ROUTE_CANDIDATES_FRESH_MS) {
      try {
        this.note(session.routeId, await this.fetchCandidates(session.routeId));
      } catch (error) {
        logger.debug('A Opfield route was not looked up for a return to a nearer relay', {
          routeId: session.routeId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      route = this.routes.get(session.routeId)!;
    }
    return opfieldReturnTarget(route.candidates, place, relayId) !== null;
  }

  /**
   * An assignment generation became active (a placement change): the routes' candidates are looked up again at the
   * next return judgement, every relay is measured now, and a return pass runs shortly instead of at the next tick, so
   * Opfield's own streams leave a farther relay as soon as the nearer one is in their assignment and stable (stand
   * rc.8, F-2: they stayed on the 300-ms relay for 80 s after the generation with the 60-ms relay was active).
   */
  assignmentsChanged(): void {
    for (const route of this.routes.values()) route.at = Number.NEGATIVE_INFINITY;
    void this.sample();
    if (this.promptReturn) return;
    this.promptReturn = setTimeout(() => {
      this.promptReturn = null;
      void this.returnPass().catch((error) =>
        logger.debug('Opfield relay return pass failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }, OPFIELD_PROMPT_RETURN_MS);
    this.promptReturn.unref?.();
  }

  /** Starts measuring the pool at once and every interval, and returning (idempotent). */
  startMeasuring(): void {
    this.start();
    void this.sample();
  }

  /** Starts measuring and returning (idempotent); both timers let the process exit. */
  start(): void {
    if (!this.sampler) {
      this.sampler = setInterval(() => void this.sample(), OPFIELD_RELAY_SAMPLE_INTERVAL_MS);
      this.sampler.unref?.();
    }
    if (!this.returner) {
      this.returner = setInterval(() => {
        void this.returnPass().catch((error) =>
          logger.debug('Opfield relay return pass failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }, OPFIELD_RETURN_INTERVAL_MS);
      this.returner.unref?.();
    }
  }

  stop(): void {
    if (this.sampler) clearInterval(this.sampler);
    if (this.returner) clearInterval(this.returner);
    if (this.promptReturn) clearTimeout(this.promptReturn);
    this.promptReturn = null;
    this.sampler = null;
    this.returner = null;
  }
}
