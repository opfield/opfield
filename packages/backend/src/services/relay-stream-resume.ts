import { hkdfSync, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  nodes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import type { NodeRelayStreamReport } from '@/db/schema/nodes.js';
import type { RelayRouteResumeState } from '@/db/schema/relay.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from './crypto.service.js';

/**
 * Resumable relay streams (RSv1, packages/daemons/shared/relayresume/doc.go): Opfield's part.
 *
 * - One instance secret, envelope-encrypted in relay_policy_state. Every route resume key derives from it with
 *   HKDF-SHA256 and the route's key_version; keys reach the daemons only over their control sessions.
 * - A route is resumable only while its source (a daemon advertising the capability, or Opfield itself) and its
 *   target daemon both support it. Anything else keeps today's raw streams.
 * - Turning a route on, rotating its key and turning it off are ordered, so a source never holds a key its target
 *   does not accept: targets first when enabling or rotating, sources first when disabling. See
 *   RelayStreamResumeService.reconcile.
 */

const logger = createChildLogger('RelayStreamResume');

export const RELAY_STREAM_RESUME_CAPABILITY = 'relay_stream_resume_v1';
export const RELAY_STREAM_RESUME_VERSION = 1;
/** Opfield's own TypeScript source (database tools, storage browser) speaks RSv1 (task T6). */
export const OPFIELD_STREAM_RESUME_CAPABLE = true;
const KDF_DOMAIN = 'gw-relay-resume/v1';
const KEY_LEN = 32;
/** Route keys are replaced this often; the target keeps the previous key until the next rotation. */
export const RESUME_KEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
/** Proxy routes: what the relay's half-close reaping did (bridge.go), now enforced by the endpoints. */
export const PROXY_HALF_CLOSE_TIMEOUT_MS = 30_000;
/** Resumable streams leave a draining relay this long before its drain disconnects what is left. */
export const DRAIN_DEADLINE_MARGIN_MS = 15_000;

/** How long an update waits for a relay's streams to end on their own before it disconnects the rest. */
export const RELAY_UPDATE_DRAIN_GRACE_MS = 30 * 60_000;
/** An operator drain disconnects what is left after this long. */
export const MANUAL_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Either drain, when every stream through the relay can move to another relay on its own. */
export const RESUMABLE_DRAIN_GRACE_MS = 2 * 60_000;

/** The HKDF info of a route key: domain ‖ u16be(len(route_id)) ‖ route_id ‖ u64be(key_version). */
export function resumeKdfInfo(routeId: string, keyVersion: number | bigint): Buffer {
  const route = Buffer.from(routeId, 'utf8');
  if (route.length > 0xffff) throw new Error('Relay route id is too long for a resume key');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(route.length);
  const version = Buffer.alloc(8);
  version.writeBigUInt64BE(BigInt(keyVersion));
  return Buffer.concat([Buffer.from(KDF_DOMAIN, 'utf8'), length, route, version]);
}

export function deriveRouteResumeKey(secret: Buffer, routeId: string, keyVersion: number | bigint): Buffer {
  if (secret.length !== KEY_LEN) throw new Error('Relay stream resume secret must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), resumeKdfInfo(routeId, keyVersion), KEY_LEN));
}

export function resumeKeyId(keyVersion: number | bigint): string {
  return `v${keyVersion}`;
}

export interface RelayStreamResumeAssignment {
  version: number;
  keyId: string;
  key: Buffer;
  halfCloseTimeoutMs?: number;
}

export interface RelayRouteResumeAssignment {
  routeId: string;
  version: number;
  keyId: string;
  key: Buffer;
  prevKeyId?: string;
  prevKey?: Buffer;
}

type RouteResumeColumns = Pick<
  typeof relayRoutes.$inferSelect,
  'id' | 'ownerKind' | 'resumeState' | 'keyVersion' | 'prevKeyVersion'
>;

/** The target lists the route (accepts HELLO/RESUME) in every state but off. */
export function targetAcceptsResume(state: RelayRouteResumeState | null | undefined): boolean {
  return state === 'enabling' || state === 'on' || state === 'rotating' || state === 'disabling';
}

/** The key version sources open resumable streams with, or null for raw streams. */
export function sourceResumeKeyVersion(
  route: Pick<RouteResumeColumns, 'resumeState' | 'keyVersion' | 'prevKeyVersion'>
): number | null {
  if (route.resumeState === 'on') return route.keyVersion;
  // Until every target holds the new key, sources keep the one they have.
  if (route.resumeState === 'rotating') return route.prevKeyVersion ?? null;
  return null;
}

export function routeHalfCloseTimeoutMs(ownerKind: string): number {
  return ownerKind === 'proxy_host_secure_link' ? PROXY_HALF_CLOSE_TIMEOUT_MS : 0;
}

export function sourceStreamResume(
  secret: Buffer | null,
  route: RouteResumeColumns
): RelayStreamResumeAssignment | undefined {
  const version = sourceResumeKeyVersion(route);
  if (!secret || version == null) return undefined;
  const halfCloseTimeoutMs = routeHalfCloseTimeoutMs(route.ownerKind);
  return {
    version: RELAY_STREAM_RESUME_VERSION,
    keyId: resumeKeyId(version),
    key: deriveRouteResumeKey(secret, route.id, version),
    ...(halfCloseTimeoutMs ? { halfCloseTimeoutMs } : {}),
  };
}

export function targetRouteResume(
  secret: Buffer | null,
  route: RouteResumeColumns
): RelayRouteResumeAssignment | undefined {
  if (!secret || !targetAcceptsResume(route.resumeState)) return undefined;
  const prev = route.prevKeyVersion;
  return {
    routeId: route.id,
    version: RELAY_STREAM_RESUME_VERSION,
    keyId: resumeKeyId(route.keyVersion),
    key: deriveRouteResumeKey(secret, route.id, route.keyVersion),
    ...(prev != null && prev !== route.keyVersion
      ? { prevKeyId: resumeKeyId(prev), prevKey: deriveRouteResumeKey(secret, route.id, prev) }
      : {}),
  };
}

const DRAIN_GRACE_LOOKUP_TIMEOUT_MS = 5_000;

/** Drain grace: short when every stream through the relay moves on its own, today's otherwise. */
export function drainGraceMs(kind: 'update' | 'manual', fullyResumable: boolean): number {
  if (fullyResumable) return RESUMABLE_DRAIN_GRACE_MS;
  return kind === 'update' ? RELAY_UPDATE_DRAIN_GRACE_MS : MANUAL_DRAIN_TIMEOUT_MS;
}

/** Advertised by a relay that keeps serving its built-in local services while it drains (see relay-local-takeover). */
export const DRAIN_KEEPS_LOCAL_SERVICES_CAPABILITY = 'drain_keeps_local_services_v1';

/**
 * Raw streams through a relay that keep it busy in a drain. Daemons count the internal registry's streams as raw (the
 * registry is never resumable), but a local relay that keeps serving its built-in local services through a drain
 * keeps those streams; the relay's own per-endpoint tunnel counts tell how many there are, and they are left out.
 */
export function workloadLegacyStreams(
  legacySessions: number,
  instance: {
    kind: string;
    capabilities?: { features?: unknown } | null;
    health?: { assignmentTunnels?: Array<{ endpointId: string; activeTunnels: number }> } | null;
  },
  localServiceEndpointIds: ReadonlySet<string>
): number {
  if (legacySessions <= 0) return 0;
  const features = instance.capabilities?.features;
  const keepsLocalServices =
    instance.kind === 'local' && Array.isArray(features) && features.includes(DRAIN_KEEPS_LOCAL_SERVICES_CAPABILITY);
  if (!keepsLocalServices) return legacySessions;
  const kept = (instance.health?.assignmentTunnels ?? [])
    .filter(({ endpointId }) => localServiceEndpointIds.has(endpointId))
    .reduce((sum, { activeTunnels }) => sum + Number(activeTunnels || 0), 0);
  return Math.max(0, legacySessions - kept);
}

/**
 * Whether every route to an endpoint assigned to this relay is resumable: its streams then leave the relay by
 * themselves when it drains. Built-in local services are left out: a draining local relay keeps serving them.
 * A relay with no routed workload counts as resumable; there is nothing to wait for. `legacySessions`: raw streams
 * the daemons report through this relay (opened before their routes turned resumable, or by an older Opfield), which
 * only today's grace lets end on their own; those of the local services a draining local relay keeps do not count.
 */
export async function relayInstanceFullyResumable(
  db: DrizzleClient,
  instanceId: string,
  legacySessions = 0
): Promise<boolean> {
  if (legacySessions > 0) {
    const [[instance], localServices] = await Promise.all([
      db
        .select({ kind: relayInstances.kind, capabilities: relayInstances.capabilities, health: relayInstances.health })
        .from(relayInstances)
        .where(eq(relayInstances.id, instanceId))
        .limit(1),
      db.select({ id: relayEndpoints.id }).from(relayEndpoints).where(eq(relayEndpoints.subjectKind, 'local_service')),
    ]);
    const kept = new Set(localServices.map(({ id }) => id));
    if (!instance || workloadLegacyStreams(legacySessions, instance, kept) > 0) return false;
  }
  const rows = await db
    .selectDistinct({ routeId: relayRoutes.id, resumeState: relayRoutes.resumeState })
    .from(relayEndpointAssignments)
    .innerJoin(
      relayEndpointAssignmentGenerations,
      eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
    )
    .innerJoin(relayEndpoints, eq(relayEndpointAssignmentGenerations.endpointId, relayEndpoints.id))
    .innerJoin(relayRoutes, eq(relayRoutes.targetEndpointId, relayEndpoints.id))
    .where(
      and(
        eq(relayEndpointAssignments.relayInstanceId, instanceId),
        inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining']),
        ne(relayEndpoints.subjectKind, 'local_service')
      )
    );
  return rows.every(({ resumeState }) => resumeState === 'on');
}

export async function relayDrainGraceMs(
  db: DrizzleClient,
  instanceId: string,
  kind: 'update' | 'manual',
  legacySessions = 0
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded: a drain, and the resume after it, never wait on this lookup.
    const fullyResumable = await Promise.race([
      relayInstanceFullyResumable(db, instanceId, legacySessions),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('lookup timed out')), DRAIN_GRACE_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return drainGraceMs(kind, fullyResumable);
  } catch (error) {
    logger.warn('Could not tell whether a relay carries only resumable streams; using the full drain grace', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return drainGraceMs(kind, false);
  } finally {
    clearTimeout(timer);
  }
}

/** The deadline a drain starting now ends at, never later than one already running. */
export function drainDeadline(
  instance: { state: string; drainDeadlineAt: Date | null },
  graceMs: number,
  now = Date.now()
): Date {
  const candidate = now + graceMs;
  if (instance.state === 'draining' && instance.drainDeadlineAt) {
    return new Date(Math.min(instance.drainDeadlineAt.getTime(), candidate));
  }
  return new Date(candidate);
}

/** What a draining candidate tells resumable sources: leave before this (unix ms, int64 as a string). */
export function candidateDrainDeadline(drainDeadlineAt: Date | null | undefined): string | undefined {
  if (!drainDeadlineAt) return undefined;
  return String(Math.max(1, drainDeadlineAt.getTime() - DRAIN_DEADLINE_MARGIN_MS));
}

/**
 * The drain deadline a relay candidate carries: only a relay's own drain has one. A generation that placement drained
 * has none, and daemons keep the streams on its relays that stay in the new generation where they are: a deadline
 * would re-path every one of them onto the same relay (stand 2.12 N-2).
 */
export function relayCandidateDrainDeadline(
  assignmentState: 'active' | 'staging' | 'draining',
  instanceState: string,
  drainDeadlineAt: Date | null | undefined
): string | undefined {
  return assignmentState === 'draining' && instanceState === 'draining'
    ? candidateDrainDeadline(drainDeadlineAt)
    : undefined;
}

export type RelayStreamReports = ReadonlyArray<{ nodeId: string; report: NodeRelayStreamReport }>;

/**
 * Open streams through one relay as the daemons report them; each daemon counts the streams it opened (the source
 * side). `reporting` is false when no daemon reports streams at all.
 */
export function relaySessionSplit(
  reports: RelayStreamReports,
  relayInstanceId: string
): { resumable: number; legacy: number; reporting: boolean } {
  let resumable = 0;
  let legacy = 0;
  for (const { report } of reports) {
    for (const relay of report.byRelay) {
      if (relay.relayInstanceId !== relayInstanceId) continue;
      resumable += relay.resumable;
      legacy += relay.legacy;
    }
  }
  return { resumable, legacy, reporting: reports.length > 0 };
}

/** What Opfield's own relayed streams (RelayControlClient.relayResumeStats) look like as a daemon report. */
export interface OpfieldRelayResumeStats {
  sessions: { resumable: number; legacy: number };
  byRelay?: Record<string, { resumable: number; legacy: number }>;
  suspended: number;
  unackedBytes: number;
  migrations: Record<string, number>;
  migrationStallMs: { p50: number; p95: number };
  retransmittedBytes: number;
}

/**
 * Opfield's own streams as one more reporting source. Migration outcomes are keyed "trigger:result": "ok" moved a
 * stream, any other result is a failed move. Only a refused resume, and an unplanned move that ran out of time, cut a
 * live stream: a planned move that found no path or no answer keeps the stream where it was, and "rejected" is a
 * stream that had ended meanwhile (stand rc.6 O-3). Raw streams through a pre-pool relay are keyed "local", which is
 * the local relay.
 */
export function opfieldStreamReport(
  stats: OpfieldRelayResumeStats,
  localRelayInstanceId: string | null
): NodeRelayStreamReport {
  let moved = 0;
  let failed = 0;
  let cut = 0;
  let laneMoves = 0;
  for (const [key, count] of Object.entries(stats.migrations ?? {})) {
    if (key.endsWith(':resume_rejected') || key === 'path_failure:timeout') cut += count;
    // A move off a connection the target replaced is housekeeping, counted apart like the daemons do.
    if (key.startsWith('lane:')) {
      if (key === 'lane:ok') laneMoves += count;
    } else if (key.endsWith(':ok')) moved += count;
    else failed += count;
  }
  const byRelay = new Map<string, { resumable: number; legacy: number }>();
  for (const [relay, counts] of Object.entries(stats.byRelay ?? {})) {
    const relayInstanceId = relay === 'local' ? localRelayInstanceId : relay;
    if (!relayInstanceId) continue;
    const entry = byRelay.get(relayInstanceId) ?? { resumable: 0, legacy: 0 };
    entry.resumable += counts.resumable;
    entry.legacy += counts.legacy;
    byRelay.set(relayInstanceId, entry);
  }
  return {
    resumableSessions: stats.sessions.resumable,
    legacySessions: stats.sessions.legacy,
    suspendedSessions: stats.suspended,
    migrationsOkTotal: moved,
    migrationsFailedTotal: failed,
    cutTotal: cut,
    retransmittedBytesTotal: stats.retransmittedBytes,
    unackedBytes: stats.unackedBytes,
    migrationStallP50Ms: stats.migrationStallMs.p50,
    migrationStallP95Ms: stats.migrationStallMs.p95,
    resumeRefusedTotal: 0,
    laneRotationsTotal: 0,
    laneMovesTotal: laneMoves,
    byRelay: [...byRelay].map(([relayInstanceId, counts]) => ({ relayInstanceId, ...counts })),
  };
}

/** The report source name of Opfield's own streams. */
export const OPFIELD_STREAM_REPORT_SOURCE = 'gateway';

/** Per daemon: streams it moved to another relay and resumable streams it lost, since it started. */
export type RelayStreamCounters = Map<string, { moved: number; cut: number }>;

export function relayStreamCounters(reports: RelayStreamReports): RelayStreamCounters {
  return new Map(
    reports.map(({ nodeId, report }) => [nodeId, { moved: report.migrationsOkTotal, cut: report.cutTotal }])
  );
}

/**
 * What happened between two counter snapshots. A daemon that restarted meanwhile (its totals went back) counts from
 * zero; one that only appears in `after` is left out, as its totals do not start at `before`.
 */
export function relayStreamOutcome(
  before: RelayStreamCounters,
  after: RelayStreamCounters
): { moved: number; cut: number } {
  let moved = 0;
  let cut = 0;
  for (const [nodeId, current] of after) {
    const previous = before.get(nodeId);
    if (!previous) continue;
    moved += current.moved >= previous.moved ? current.moved - previous.moved : current.moved;
    cut += current.cut >= previous.cut ? current.cut - previous.cut : current.cut;
  }
  return { moved, cut };
}

/**
 * A drained relay's outcome, bounded by the resumable streams through it when its drain began. The daemons' counters
 * are pool-wide: a stream that moved between other relays meanwhile (a placement change) is not this relay's, and a
 * relay without streams reported every such move as its own (stand 2.12 N-3: "91 streams moved" for an empty relay).
 */
export function relayDrainOutcome(
  outcome: { moved: number; cut: number },
  carried: number
): { moved: number; cut: number } {
  const cut = Math.min(outcome.cut, carried);
  return { moved: Math.min(outcome.moved, Math.max(0, carried - cut)), cut };
}

function streams(count: number): string {
  return count === 1 ? '1 stream' : `${count} streams`;
}

/**
 * The step note of a drained relay: streams that moved to other relays and streams that were cut, the resumable ones
 * that could not move plus the raw ones the forced disconnect ended. Null when nothing moved or was cut.
 */
export function drainOutcomeNote(outcome: { moved: number; cut: number }, legacyDisconnected = 0): string | null {
  const cut = outcome.cut + legacyDisconnected;
  if (!outcome.moved && !cut) return null;
  if (!cut) return `${streams(outcome.moved)} moved to other relays, none cut.`;
  return `${streams(outcome.moved)} moved to other relays, ${streams(cut)} cut.`;
}

/** The step note of a local relay recreated without another relay: its resumable streams paused and resumed. */
export function localRelayPauseNote(pausedMs: number, outcome: { moved: number; cut: number }, reason: string): string {
  const seconds = Math.max(1, Math.round(pausedMs / 1000));
  const resumed = outcome.moved ? `; ${streams(outcome.moved)} resumed` : '';
  const cut = outcome.cut ? `, ${streams(outcome.cut)} cut` : '';
  return `Streams through the local relay paused for ${seconds} s while it was recreated (${reason})${resumed}${cut}.`;
}

export interface ResumeRouteState {
  id: string;
  resumeState: RelayRouteResumeState;
  keyRotatedAt: Date | null;
  /** Source and target both support resumable streams. */
  desired: boolean;
}

export interface ResumeTransitionPlan {
  /** Targets first, then sources. off → enabling, or an enabling route whose targets were not confirmed yet. */
  enable: string[];
  /** Targets first, then sources. on → rotating with a new key, or a rotation whose targets were not confirmed yet. */
  rotate: string[];
  /** Targets only: enabling → off (no source ever got a key). */
  cancel: string[];
  /** Sources first, then targets. on/rotating → disabling, or a disable whose sources were not confirmed yet. */
  disable: string[];
  /** Sources only: disabling → on (the targets never dropped the route). */
  reenable: string[];
}

export function planResumeTransitions(routes: readonly ResumeRouteState[], now = Date.now()): ResumeTransitionPlan {
  const plan: ResumeTransitionPlan = { enable: [], rotate: [], cancel: [], disable: [], reenable: [] };
  for (const route of routes) {
    switch (route.resumeState) {
      case 'off':
        if (route.desired) plan.enable.push(route.id);
        break;
      case 'enabling':
        (route.desired ? plan.enable : plan.cancel).push(route.id);
        break;
      case 'on':
        if (!route.desired) plan.disable.push(route.id);
        else if (!route.keyRotatedAt || now - route.keyRotatedAt.getTime() >= RESUME_KEY_ROTATION_MS) {
          plan.rotate.push(route.id);
        }
        break;
      case 'rotating':
        (route.desired ? plan.rotate : plan.disable).push(route.id);
        break;
      case 'disabling':
        (route.desired ? plan.reenable : plan.disable).push(route.id);
        break;
    }
  }
  return plan;
}

export interface RelayStreamResumeHost {
  /** Delivers the node's grant bundle and resolves once the daemon applied it. */
  syncNodeGrants(nodeId: string): Promise<void>;
}

interface RouteEnds {
  id: string;
  sourceKind: string;
  sourceId: string;
  targetNodeId: string | null;
}

export class RelayStreamResumeService {
  private cachedSecret: Buffer | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: Pick<CryptoService, 'encryptPrivateKey' | 'decryptPrivateKey'>,
    private readonly host: RelayStreamResumeHost
  ) {}

  /** Creates the instance secret once. Never replaced: route keys rotate through their key_version. */
  async ensureInitialized(): Promise<void> {
    const generated = randomBytes(KEY_LEN);
    const encrypted = this.cryptoService.encryptPrivateKey(generated.toString('hex'));
    await this.db
      .update(relayPolicyState)
      .set({ resumeSecretEncrypted: encrypted.encryptedPrivateKey, resumeSecretDek: encrypted.encryptedDek })
      .where(and(eq(relayPolicyState.id, 'current'), isNull(relayPolicyState.resumeSecretEncrypted)));
    this.cachedSecret = null;
    await this.secret();
  }

  /** The instance secret, or null before it exists (no route is resumable then). */
  async secret(): Promise<Buffer | null> {
    if (this.cachedSecret) return this.cachedSecret;
    const [state] = await this.db
      .select({ encrypted: relayPolicyState.resumeSecretEncrypted, dek: relayPolicyState.resumeSecretDek })
      .from(relayPolicyState)
      .where(eq(relayPolicyState.id, 'current'))
      .limit(1);
    if (!state?.encrypted || !state.dek) return null;
    const secret = Buffer.from(
      this.cryptoService.decryptPrivateKey({
        encryptedPrivateKey: state.encrypted,
        encryptedDek: state.dek,
        dekIv: '',
      }),
      'hex'
    );
    if (secret.length !== KEY_LEN) throw new Error('Stored relay stream resume secret is malformed');
    this.cachedSecret = secret;
    return secret;
  }

  /** One pass at a time; a request during a pass runs one more pass after it. */
  reconcile(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.reconcileOnce();
        } while (this.rerun);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Turns on, targets first, the routes a source is about to get its grants for, while both their ends support
   * resumable streams: a route created now is resumable in the very bundle that brings it to its source, so no stream
   * on it ever opens raw. Only routes that are off or half-enabled are touched; the targets get their bundles here and
   * the caller delivers the source's. A target that does not take its bundle leaves the route raw for now; the minute
   * reconcile retries it.
   */
  async enableBeforeSourceSync(filter: { sourceNodeId: string } | { routeIds: string[] }): Promise<void> {
    if ('routeIds' in filter && filter.routeIds.length === 0) return;
    if (!(await this.secret())) return;
    const { states, ends } = await this.loadRouteStates(
      and(
        'sourceNodeId' in filter
          ? and(eq(relayRoutes.sourceKind, 'daemon'), eq(relayRoutes.sourceId, filter.sourceNodeId))
          : inArray(relayRoutes.id, filter.routeIds),
        inArray(relayRoutes.resumeState, ['off', 'enabling'])
      )
    );
    const enable = states.filter(({ desired }) => desired).map(({ id }) => id);
    if (!enable.length) return;
    await this.setState(enable, ['off', 'enabling'], 'enabling');
    const confirmed = await this.syncSides(
      enable.map((id) => ends.get(id)!),
      'target'
    );
    if (confirmed.length) await this.setState(confirmed, ['enabling'], 'on');
  }

  private async loadRouteStates(where?: SQL) {
    const query = this.db
      .select({
        id: relayRoutes.id,
        sourceKind: relayRoutes.sourceKind,
        sourceId: relayRoutes.sourceId,
        resumeState: relayRoutes.resumeState,
        keyRotatedAt: relayRoutes.keyRotatedAt,
        endpointStatus: relayEndpoints.status,
        endpointSubjectKind: relayEndpoints.subjectKind,
        targetNodeId: relayEndpoints.subjectId,
      })
      .from(relayRoutes)
      .innerJoin(relayEndpoints, eq(relayRoutes.targetEndpointId, relayEndpoints.id));
    const routes = await (where ? query.where(where) : query);
    const ends = new Map<string, RouteEnds>();
    if (!routes.length) return { states: [] as ResumeRouteState[], ends };
    const nodeIds = [
      ...new Set(
        routes.flatMap((route) => [
          ...(route.endpointSubjectKind === 'daemon' ? [route.targetNodeId] : []),
          ...(route.sourceKind === 'daemon' ? [route.sourceId] : []),
        ])
      ),
    ];
    const capable = new Set(
      nodeIds.length
        ? (
            await this.db
              .select({ id: nodes.id, capabilities: nodes.capabilities })
              .from(nodes)
              .where(inArray(nodes.id, nodeIds))
          )
            .filter(
              ({ capabilities }) =>
                Array.isArray(capabilities?.capabilities) &&
                capabilities.capabilities.includes(RELAY_STREAM_RESUME_CAPABILITY)
            )
            .map(({ id }) => id)
        : []
    );
    const states: ResumeRouteState[] = routes.map((route) => {
      const targetNodeId = route.endpointSubjectKind === 'daemon' ? route.targetNodeId : null;
      ends.set(route.id, { id: route.id, sourceKind: route.sourceKind, sourceId: route.sourceId, targetNodeId });
      const sourceCapable =
        route.sourceKind === 'gateway'
          ? OPFIELD_STREAM_RESUME_CAPABLE
          : route.sourceKind === 'daemon' && capable.has(route.sourceId);
      return {
        id: route.id,
        resumeState: route.resumeState,
        keyRotatedAt: route.keyRotatedAt,
        desired:
          route.endpointStatus === 'active' && targetNodeId !== null && capable.has(targetNodeId) && sourceCapable,
      };
    });
    return { states, ends };
  }

  private async reconcileOnce(now = Date.now()): Promise<void> {
    if (!(await this.secret())) return;
    const { states, ends } = await this.loadRouteStates();
    if (!states.length) return;
    const plan = planResumeTransitions(states, now);
    if (!Object.values(plan).some((ids) => ids.length)) return;
    logger.info('Changing which relay routes carry resumable streams', {
      enable: plan.enable.length,
      rotate: plan.rotate.length,
      cancel: plan.cancel.length,
      disable: plan.disable.length,
      reenable: plan.reenable.length,
    });
    const pick = (ids: string[]) => ids.map((id) => ends.get(id)!);

    // Sources first when routes stop being resumable.
    if (plan.disable.length) {
      await this.setState(plan.disable, ['on', 'rotating', 'disabling'], 'disabling');
      const confirmed = await this.syncSides(pick(plan.disable), 'source');
      if (confirmed.length) {
        await this.setState(confirmed, ['disabling'], 'off');
        await this.syncSides(pick(confirmed), 'target');
      }
    }
    if (plan.reenable.length) {
      await this.setState(plan.reenable, ['disabling'], 'on');
      await this.syncSides(pick(plan.reenable), 'source');
    }
    if (plan.cancel.length) {
      await this.setState(plan.cancel, ['enabling'], 'off');
      await this.syncSides(pick(plan.cancel), 'target');
    }
    // Targets first when routes become resumable or change keys.
    if (plan.enable.length) await this.setState(plan.enable, ['off', 'enabling'], 'enabling');
    if (plan.rotate.length) await this.beginRotation(plan.rotate, new Date(now));
    const targetFirst = [...plan.enable, ...plan.rotate];
    if (targetFirst.length) {
      const confirmed = await this.syncSides(pick(targetFirst), 'target');
      if (confirmed.length) {
        await this.setState(confirmed, ['enabling', 'rotating'], 'on');
        await this.syncSides(pick(confirmed), 'source');
      }
    }
  }

  private async setState(ids: string[], from: RelayRouteResumeState[], to: RelayRouteResumeState): Promise<void> {
    if (!ids.length) return;
    await this.db
      .update(relayRoutes)
      .set({
        resumeState: to,
        ...(to === 'off' ? { prevKeyVersion: null } : {}),
        // The key an enabled route starts with is due for rotation a full period later. A route turned on from off
        // gets a key it never had: a source that latched it to raw streams while its target could not resume them
        // (an older daemon) sees a new key id and tries resumable streams again at once, not after its latch.
        ...(to === 'enabling'
          ? {
              keyRotatedAt: new Date(),
              keyVersion: sql`case when ${relayRoutes.resumeState} = 'off' then ${relayRoutes.keyVersion} + 1 else ${relayRoutes.keyVersion} end`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(inArray(relayRoutes.id, ids), inArray(relayRoutes.resumeState, from)));
  }

  /** on → rotating with a new key version; a route already rotating keeps its new key. */
  private async beginRotation(ids: string[], now: Date): Promise<void> {
    await this.db
      .update(relayRoutes)
      .set({
        resumeState: 'rotating',
        prevKeyVersion: sql`${relayRoutes.keyVersion}`,
        keyVersion: sql`${relayRoutes.keyVersion} + 1`,
        keyRotatedAt: now,
        updatedAt: now,
      })
      .where(and(inArray(relayRoutes.id, ids), eq(relayRoutes.resumeState, 'on')));
  }

  /**
   * Delivers the bundles of one side of these routes. Returns the routes whose every node on that side applied its
   * bundle. Opfield, as a source, reads its route at every open and needs no delivery.
   */
  private async syncSides(routes: RouteEnds[], side: 'source' | 'target'): Promise<string[]> {
    const nodeOf = (route: RouteEnds) =>
      side === 'target' ? route.targetNodeId : route.sourceKind === 'daemon' ? route.sourceId : null;
    const nodeIds = [...new Set(routes.map(nodeOf).filter((id): id is string => Boolean(id)))];
    const results = await Promise.allSettled(nodeIds.map((nodeId) => this.host.syncNodeGrants(nodeId)));
    const failed = new Set<string>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      failed.add(nodeIds[index]!);
      logger.debug('Resumable stream change waits for a daemon to take its grants', {
        nodeId: nodeIds[index],
        side,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
    return routes.filter((route) => !failed.has(nodeOf(route) ?? '')).map(({ id }) => id);
  }
}
