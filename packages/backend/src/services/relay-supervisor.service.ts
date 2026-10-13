import * as grpc from '@grpc/grpc-js';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayInstances } from '@/db/schema/index.js';
import type { RelayControlClient, RelayHealthResponse } from '@/grpc/relay-control.client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from './cache.service.js';
import type { EventBusService } from './event-bus.service.js';
import { type LocalRelayOutage, type LocalRelayOutageSignal, localRelayOutagePhase } from './local-relay-outage.js';
import {
  type RelayContainerObservation,
  type RelayDockerRecoveryService,
  type RelayRecoveryAction,
  RelayRecoverySafetyError,
} from './relay-docker-recovery.service.js';
import { type RelayExternalActivity, relayRecoveryWait } from './relay-recovery-decision.js';

const logger = createChildLogger('RelaySupervisor');
const CONTROL_STATE_KEY = 'relay:control-state';
const MAX_ATTEMPTS = 3;
/** The legacy policy lease; a gap past this is long enough that the relay served stale policy. */
const RELAY_STALE_POLICY_GAP_MS = 15 * 60 * 1000;
/**
 * How far back recovery reads Docker's lifecycle events of the relay: far enough to see the stop
 * request of the slowest `docker stop`/`restart` still in progress (Compose stop_grace_period).
 */
const RELAY_EVENT_LOOKBACK_MS = 2 * 60_000;
/** The longest recovery leaves the relay to other actors in one go, however they keep changing it. */
const RELAY_EXTERNAL_WAIT_CAP_MS = 3 * 60_000;
/** A container that keeps changing under recovery's hands is acted on after this many rounds. */
const MAX_SUPERSEDED_ROUNDS = 3;

export const RELAY_HEALTH_REASONS = [
  'unreachable',
  'tls_unavailable',
  'listener_unavailable',
  'policy_snapshot_required',
  'contract_mismatch',
  'unexpected_image',
  'docker_unavailable',
  'ownership_unverified',
] as const;
export type RelayHealthReason = (typeof RELAY_HEALTH_REASONS)[number];
export type RelayLifecycleState =
  | 'migration_pending'
  | 'maintenance'
  | 'healthy'
  | 'suspect'
  | 'degraded'
  | 'recovering'
  | 'critical';

export interface RelayAttemptRecord {
  attempt: number;
  startedAt: string;
  action?: RelayRecoveryAction;
  result: 'running' | 'failed' | 'healthy';
}

export interface RelaySupervisorState {
  state: RelayLifecycleState;
  reason: RelayHealthReason | null;
  /**
   * Automatic recovery spent its attempt budget, or stopped at a Docker safety error. Until the
   * relay is healthy again or an administrator retries, no probe restarts it: otherwise a relay
   * whose failure reason keeps changing would be restarted without bound.
   */
  recoveryBlocked?: 'budget' | 'safety' | null;
  attempt: number;
  maxAttempts: 3;
  attemptHistory: RelayAttemptRecord[];
  lastHealthyAt: string | null;
  lastProbeAt: string | null;
  relayBuildVersion: string | null;
  protocolMajor: number | null;
  registeredEndpoints: number;
  activeTunnels: number;
  activeProxyTunnels: number;
  activeDatabaseTunnels: number;
  throttledProxyTotal: number;
  throttledDatabaseTotal: number;
  pressurePercent: number;
  cpuPressurePercent: number;
  memoryPressurePercent: number;
  fdPressurePercent: number;
  admissionState: string;
  memoryRssBytes: number;
  heapInUseBytes: number;
  memoryLimitBytes: number;
  openFileDescriptors: number;
  fileDescriptorLimit: number;
  /** The last time the local relay stopped serving (see local-relay-outage); kept after it ended. */
  outage?: { since: string; servingAgainAt: string | null; planned: boolean } | null;
}

export interface RelaySupervisorOptions {
  required: boolean;
  managed: boolean;
  expectedImage: string | null;
  expectedService: string;
  expectedVersion?: string;
  expectedProtocolMajor?: number;
  probeIntervalMs?: number;
  /** While the local relay does not serve, how often it is checked for its return (O-2). */
  returnProbeIntervalMs?: number;
  recoveryDelaysMs?: readonly [number, number, number];
  readinessWaitMs?: number;
  readinessPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type ProbeResult =
  | { healthy: true; response: RelayHealthResponse }
  | { healthy: false; reason: RelayHealthReason; response?: RelayHealthResponse };

/** A relay that cannot be reached serves nothing; one that answers but is not ready admits nothing. */
const OFFLINE_REASONS: readonly RelayHealthReason[] = ['unreachable', 'listener_unavailable'];

function isRelayHealthReason(value: string): value is RelayHealthReason {
  return (RELAY_HEALTH_REASONS as readonly string[]).includes(value);
}

function defaultState(): RelaySupervisorState {
  return {
    state: 'migration_pending',
    reason: null,
    attempt: 0,
    maxAttempts: MAX_ATTEMPTS,
    attemptHistory: [],
    lastHealthyAt: null,
    lastProbeAt: null,
    relayBuildVersion: null,
    protocolMajor: null,
    registeredEndpoints: 0,
    activeTunnels: 0,
    activeProxyTunnels: 0,
    activeDatabaseTunnels: 0,
    throttledProxyTotal: 0,
    throttledDatabaseTotal: 0,
    pressurePercent: 0,
    cpuPressurePercent: 0,
    memoryPressurePercent: 0,
    fdPressurePercent: 0,
    admissionState: 'unknown',
    memoryRssBytes: 0,
    heapInUseBytes: 0,
    memoryLimitBytes: 0,
    openFileDescriptors: 0,
    fileDescriptorLimit: 0,
    outage: null,
  };
}

export class RelaySupervisorService implements LocalRelayOutageSignal {
  private state = defaultState();
  private failureCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private returnTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  /** The return check of watchReturn in flight. */
  private returnChecking = false;
  private recoveryCycle: Promise<void> | null = null;
  private manualRetryStarting = false;
  /** The persisted state was loaded (restore). */
  private restored = false;
  /**
   * Checks of the relay are numbered as they start. An outage is closed only by a check that started after it was
   * opened, and opened again only by one that started after it was closed: a check that was under way while the
   * relay went down (its answer, or the write after it, was still pending) said nothing about the relay since (stand
   * rc.7, O-1: a probe's healthy answer, persisted 30 ms after a hard stop was recorded, logged "serves again").
   */
  private checksStarted = 0;
  private outageOpenedAfterCheck = 0;
  private outageClosedAfterCheck = 0;
  /** The on-demand check of confirmLocalRelay in flight. */
  private confirming: Promise<void> | null = null;
  private stopping = false;
  /** Resolves when stop() is called, so recovery waits end at once instead of holding a stopping Opfield. */
  private stopped: Promise<void>;
  private signalStopped: () => void = () => undefined;
  private readonly probeIntervalMs: number;
  private readonly returnProbeIntervalMs: number;
  private readonly recoveryDelaysMs: readonly [number, number, number];
  private readonly readinessWaitMs: number;
  private readonly readinessPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** When the supervisor's own last start/restart of the relay returned; its run is not someone else's. */
  private lastOwnActionAt: number | null = null;
  private availabilityLease?: {
    ingestRelayReport(
      relayInstanceId: string,
      report: NonNullable<RelayHealthResponse['availabilityLease']>
    ): Promise<void>;
  };

  constructor(
    private readonly db: DrizzleClient,
    private readonly cache: Pick<CacheService, 'get' | 'set'>,
    private readonly relayClient:
      | (Pick<RelayControlClient, 'getHealth'> & Partial<Pick<RelayControlClient, 'reconnectIfDown'>>)
      | null,
    private readonly recovery: RelayDockerRecoveryService | null,
    private readonly settings: GeneralSettingsService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly options: RelaySupervisorOptions
  ) {
    this.probeIntervalMs = options.probeIntervalMs ?? 5_000;
    this.returnProbeIntervalMs = options.returnProbeIntervalMs ?? 1_000;
    this.recoveryDelaysMs = options.recoveryDelaysMs ?? [0, 10_000, 30_000];
    this.readinessWaitMs = options.readinessWaitMs ?? 20_000;
    this.readinessPollMs = options.readinessPollMs ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.stopped = this.armStopSignal();
  }

  /** The local relay's acceptor and gate view goes to the availability lease service with every health probe. */
  setAvailabilityLeaseSink(sink: NonNullable<RelaySupervisorService['availabilityLease']>): void {
    this.availabilityLease = sink;
  }

  /**
   * Loads the state the previous process persisted, once. Called before the API answers and before nodes connect: a
   * Opfield started during a local relay outage shows and handles that outage from its first answer, rather than
   * reading as a relay never seen (unavailable, migration pending, no outage) until its relay startup ended (O-5).
   */
  async restore(): Promise<void> {
    if (this.restored || !this.options.required || !this.relayClient) return;
    this.restored = true;
    const persisted = await this.cache.get<RelaySupervisorState>(CONTROL_STATE_KEY).catch(() => null);
    if (persisted?.maxAttempts === MAX_ATTEMPTS) {
      // Maintenance belongs to the process that opened it (a relay update). Restored after a
      // restart it would switch supervision off for good, since nothing else ends it.
      this.state = persisted.state === 'maintenance' ? { ...persisted, state: 'migration_pending' } : persisted;
    }
  }

  async start(): Promise<void> {
    if (!this.options.required || !this.relayClient) return;
    this.stopping = false;
    this.stopped = this.armStopSignal();
    await this.restore();
    const resumeRecovery = this.state.state === 'recovering';
    await this.probeNow();
    // The state is published on changes only, and a relay found as it was persisted changed nothing: the alert
    // evaluator still gets the current state once, so an alert left firing by the previous process can resolve.
    this.publish();
    if (resumeRecovery && this.state.state === 'recovering') this.startRecoveryCycle(false);
    this.timer = setInterval(() => void this.probeNow(), this.probeIntervalMs);
    this.timer.unref();
    this.returnTimer = setInterval(() => void this.watchReturn(), this.returnProbeIntervalMs);
    this.returnTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.signalStopped();
    if (this.timer) clearInterval(this.timer);
    if (this.returnTimer) clearInterval(this.returnTimer);
    this.timer = null;
    this.returnTimer = null;
    await this.recoveryCycle;
    while (this.probing || this.returnChecking) await this.sleep(25);
  }

  getSnapshot(admin: boolean) {
    if (!this.options.required) return null;
    const generic = {
      state: this.state.state,
      impact:
        this.state.state === 'critical'
          ? 'Managed nodes and secure database connections are disconnected.'
          : this.state.state === 'degraded'
            ? 'Relay runtime ownership could not be verified; automatic recovery is unavailable.'
            : this.state.state === 'recovering'
              ? 'Secure database connections are temporarily unavailable.'
              : null,
      attempt: this.state.attempt,
      maxAttempts: this.state.maxAttempts,
      lastHealthyAt: this.state.lastHealthyAt,
      outage: this.describeOutage(),
    };
    if (!admin) return generic;
    return {
      ...generic,
      reason: this.state.reason,
      lastProbeAt: this.state.lastProbeAt,
      attemptHistory: this.state.attemptHistory,
      relayBuildVersion: this.state.relayBuildVersion,
      protocolMajor: this.state.protocolMajor,
      registeredEndpoints: this.state.registeredEndpoints,
      activeTunnels: this.state.activeTunnels,
      activeProxyTunnels: this.state.activeProxyTunnels,
      activeDatabaseTunnels: this.state.activeDatabaseTunnels,
      throttledProxyTotal: this.state.throttledProxyTotal,
      throttledDatabaseTotal: this.state.throttledDatabaseTotal,
      pressurePercent: this.state.pressurePercent,
      cpuPressurePercent: this.state.cpuPressurePercent,
      memoryPressurePercent: this.state.memoryPressurePercent,
      fdPressurePercent: this.state.fdPressurePercent,
      admissionState: this.state.admissionState,
      memoryRssBytes: this.state.memoryRssBytes,
      heapInUseBytes: this.state.heapInUseBytes,
      memoryLimitBytes: this.state.memoryLimitBytes,
      openFileDescriptors: this.state.openFileDescriptors,
      fileDescriptorLimit: this.state.fileDescriptorLimit,
      expectedService: this.options.expectedService,
      expectedVersion: this.options.expectedVersion ?? null,
      expectedImage: this.options.expectedImage,
      canRetry:
        this.state.state === 'critical' &&
        this.state.reason !== null &&
        (this.isRecoverable(this.state.reason) || this.state.recoveryBlocked === 'safety') &&
        !this.recoveryCycle &&
        !this.manualRetryStarting,
    };
  }

  async probeNow(): Promise<void> {
    if (
      this.stopping ||
      !this.options.required ||
      !this.relayClient ||
      this.probing ||
      this.state.state === 'maintenance'
    )
      return;
    this.probing = true;
    try {
      const result = await this.checkRelay();
      this.state.lastProbeAt = new Date(this.now()).toISOString();
      if (result.healthy) {
        this.failureCount = 0;
        const healthyUpdate = {
          lastHealthyAt: new Date(this.now()).toISOString(),
          relayBuildVersion: result.response.buildVersion,
          protocolMajor: Number(result.response.protocolMajor),
          registeredEndpoints: Number(result.response.registeredEndpoints),
          activeTunnels: Number(result.response.activeTunnels),
          activeProxyTunnels: Number(result.response.activeProxyTunnels) || 0,
          activeDatabaseTunnels: Number(result.response.activeDatabaseTunnels) || 0,
          throttledProxyTotal: Number(result.response.throttledProxyTotal) || 0,
          throttledDatabaseTotal: Number(result.response.throttledDatabaseTotal) || 0,
          pressurePercent: Number(result.response.pressurePercent) || 0,
          cpuPressurePercent: Number(result.response.cpuPressurePercent) || 0,
          memoryPressurePercent: Number(result.response.memoryPressurePercent) || 0,
          fdPressurePercent: Number(result.response.fdPressurePercent) || 0,
          admissionState: result.response.admissionState || 'unknown',
          memoryRssBytes: Number(result.response.memoryRssBytes) || 0,
          heapInUseBytes: Number(result.response.heapInUseBytes) || 0,
          memoryLimitBytes: Number(result.response.memoryLimitBytes) || 0,
          openFileDescriptors: Number(result.response.openFileDescriptors) || 0,
          fileDescriptorLimit: Number(result.response.fileDescriptorLimit) || 0,
        };
        await this.recordLocalInstance(result.response).catch((error) => {
          logger.warn('Failed to persist local Relay Pool health', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        if (this.state.state === 'healthy') {
          this.state = { ...this.state, ...healthyUpdate };
          // A relay found down by an on-demand check while this probe saw it healthy throughout.
          await this.recordServing(true, result.check);
          return;
        }
        await this.transition(
          {
            state: 'healthy',
            reason: null,
            recoveryBlocked: null,
            attempt: 0,
            attemptHistory: [],
            ...healthyUpdate,
          },
          result.check
        );
        return;
      }
      this.failureCount += 1;
      // From the first failed probe: the nodes' control streams end with the relay, whatever recovery does.
      if (OFFLINE_REASONS.includes(result.reason)) await this.recordServing(false, result.check);
      if (this.failureCount === 1) {
        if (this.state.state !== 'critical' && this.state.state !== 'recovering') {
          await this.transition({ state: 'suspect', reason: result.reason });
        }
        return;
      }
      await this.recordUnavailableLocalInstance(result).catch((error) => {
        logger.warn('Failed to persist local Relay Pool health', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (this.state.state === 'recovering' || this.recoveryCycle) return;
      if (this.state.recoveryBlocked) {
        // Keep the current cause visible; only a healthy probe or a manual retry lifts the block.
        if (this.state.reason !== result.reason) await this.transition({ reason: result.reason });
        return;
      }
      // Critical without a spent budget means automatic recovery was never tried for this cause
      // (it was not recoverable, or automatic recovery is off). A recoverable cause gets one budget.
      if (this.state.state === 'critical' && this.state.reason === result.reason) return;
      const autoRecovery = (await this.settings.getConfig()).relayAutoRecovery;
      if (this.isRecoverable(result.reason) && autoRecovery && this.options.managed && this.recovery) {
        await this.transition({ state: 'recovering', reason: result.reason, attempt: 0, attemptHistory: [] });
        this.startRecoveryCycle(false);
        return;
      }
      await this.transition({ state: 'critical', reason: result.reason });
    } catch (error) {
      logger.error('Opfield relay supervisor probe failed internally', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.transition({ state: 'degraded', reason: 'ownership_unverified' }).catch(() => {});
    } finally {
      this.probing = false;
    }
  }

  async retryRecovery(userId: string): Promise<ReturnType<RelaySupervisorService['getSnapshot']>> {
    if (!this.options.required || !this.relayClient) throw new Error('Opfield relay is not enabled');
    // Offered exactly when canRetry is: the stored reason is kept current by every probe, and a
    // relay stopped by a Docker safety error may be retried once Docker is back. The fresh probe
    // below then decides.
    if (
      this.recoveryCycle ||
      this.manualRetryStarting ||
      this.state.state !== 'critical' ||
      !this.state.reason ||
      !(this.isRecoverable(this.state.reason) || this.state.recoveryBlocked === 'safety')
    ) {
      return this.getSnapshot(true);
    }
    // Never race a periodic health check with a mutating recovery request. A
    // caller can retry after that check publishes its result.
    if (this.probing) return this.getSnapshot(true);
    this.manualRetryStarting = true;
    this.probing = true;
    try {
      // A critical snapshot can be stale when the relay recovered outside the
      // supervisor. Re-probe before any mutating Docker action so the manual
      // endpoint cannot restart an already healthy relay.
      const current = await this.checkRelay();
      this.state.lastProbeAt = new Date(this.now()).toISOString();
      if (current.healthy) {
        this.failureCount = 0;
        await this.transition({
          state: 'healthy',
          reason: null,
          recoveryBlocked: null,
          attempt: 0,
          attemptHistory: [],
          lastHealthyAt: new Date(this.now()).toISOString(),
          relayBuildVersion: current.response.buildVersion,
          protocolMajor: Number(current.response.protocolMajor),
          registeredEndpoints: Number(current.response.registeredEndpoints),
          activeTunnels: Number(current.response.activeTunnels),
          activeProxyTunnels: Number(current.response.activeProxyTunnels) || 0,
          activeDatabaseTunnels: Number(current.response.activeDatabaseTunnels) || 0,
          throttledProxyTotal: Number(current.response.throttledProxyTotal) || 0,
          throttledDatabaseTotal: Number(current.response.throttledDatabaseTotal) || 0,
          pressurePercent: Number(current.response.pressurePercent) || 0,
          cpuPressurePercent: Number(current.response.cpuPressurePercent) || 0,
          memoryPressurePercent: Number(current.response.memoryPressurePercent) || 0,
          fdPressurePercent: Number(current.response.fdPressurePercent) || 0,
          admissionState: current.response.admissionState || 'unknown',
          memoryRssBytes: Number(current.response.memoryRssBytes) || 0,
          heapInUseBytes: Number(current.response.heapInUseBytes) || 0,
          memoryLimitBytes: Number(current.response.memoryLimitBytes) || 0,
          openFileDescriptors: Number(current.response.openFileDescriptors) || 0,
          fileDescriptorLimit: Number(current.response.fileDescriptorLimit) || 0,
        });
        return this.getSnapshot(true);
      }
      await this.transition({ state: 'critical', reason: current.reason });
      if (!this.isRecoverable(current.reason)) return this.getSnapshot(true);
      await this.transition({ state: 'recovering', recoveryBlocked: null, attempt: 0, attemptHistory: [] });
      await this.audit.log({
        userId,
        action: 'relay.recovery.retry',
        resourceType: 'system',
        resourceId: 'opfield-relay',
        details: { maxAttempts: MAX_ATTEMPTS },
      });
      this.startRecoveryCycle(true);
      return this.getSnapshot(true);
    } finally {
      this.probing = false;
      this.manualRetryStarting = false;
    }
  }

  async setMaintenance(enabled: boolean): Promise<void> {
    if (!this.options.required) return;
    // The update recreates the relay: every control stream through it ends now. The probe after it ends the outage.
    await this.transition({
      state: enabled ? 'maintenance' : 'migration_pending',
      reason: null,
      ...(enabled ? this.outageChange(false, true) : {}),
    });
  }

  latestOutage(): LocalRelayOutage | null {
    const outage = this.state.outage;
    if (!this.options.required || !outage) return null;
    const since = Date.parse(outage.since);
    if (!Number.isFinite(since)) return null;
    const servingAgainAt = outage.servingAgainAt === null ? null : Date.parse(outage.servingAgainAt);
    return {
      since,
      servingAgainAt: servingAgainAt === null || Number.isFinite(servingAgainAt) ? servingAgainAt : since,
      planned: outage.planned,
    };
  }

  /**
   * Checks the local relay at once, between probes: a node whose control stream just ended asks, so an outage is
   * known before the node's offline grace ends. Records only whether the relay serves; supervision and recovery keep
   * their own probes.
   */
  confirmLocalRelay(): Promise<void> {
    if (!this.options.required || !this.relayClient || this.stopping || this.inMaintenance()) return Promise.resolve();
    const confirming =
      this.confirming ??
      this.checkRelay()
        .then(async (result) => {
          if (this.stopping || this.inMaintenance()) return;
          if (result.healthy) await this.recordServing(true, result.check);
          else if (OFFLINE_REASONS.includes(result.reason)) await this.recordServing(false, result.check);
        })
        .catch((error) => {
          logger.debug('Local relay check failed', { error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          this.confirming = null;
        });
    this.confirming = confirming;
    return confirming;
  }

  /**
   * While the local relay does not serve, checks every second whether it is back, on a fresh connection: the regular
   * probe runs every 5 s, and the channel it uses waits out its reconnect backoff and keeps the address it resolved,
   * so a relay that came back (with a new address, as Docker may give it) was seen 9-18 s late (O-2). A relay found
   * back gets a full probe at once, which ends the outage.
   */
  async watchReturn(): Promise<void> {
    const outage = this.state.outage;
    if (!outage || outage.servingAgainAt !== null || !this.relayClient) return;
    if (this.stopping || this.inMaintenance() || this.probing || this.returnChecking) return;
    this.returnChecking = true;
    try {
      this.relayClient.reconnectIfDown?.();
      // Recovery polls the relay every second itself and records how it ended; it only gets fresh channels here.
      if (this.recoveryCycle) return;
      const result = await this.checkRelay();
      if (result.healthy && !this.stopping && !this.inMaintenance()) await this.probeNow();
    } catch (error) {
      logger.debug('Local relay return check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.returnChecking = false;
    }
  }

  private describeOutage() {
    const outage = this.latestOutage();
    const phase = localRelayOutagePhase(outage, this.now());
    if (!outage || !phase) return null;
    return {
      phase,
      since: new Date(outage.since).toISOString(),
      servingAgainAt: outage.servingAgainAt === null ? null : new Date(outage.servingAgainAt).toISOString(),
      planned: outage.planned,
    };
  }

  /**
   * The outage record after the relay was seen serving or not: a relay that stops serving opens an outage unless one
   * is open already (a new one starts when the last one had ended), and the first time it serves again closes it.
   */
  private outageChange(
    serving: boolean,
    planned = false,
    check = Number.POSITIVE_INFINITY
  ): Partial<Pick<RelaySupervisorState, 'outage'>> {
    const outage = this.state.outage ?? null;
    const now = new Date(this.now()).toISOString();
    if (serving) {
      if (!outage || outage.servingAgainAt !== null || check <= this.outageOpenedAfterCheck) return {};
      this.outageClosedAfterCheck = this.checksStarted;
      return { outage: { ...outage, servingAgainAt: now } };
    }
    if ((outage && outage.servingAgainAt === null) || check <= this.outageClosedAfterCheck) return {};
    this.outageOpenedAfterCheck = this.checksStarted;
    return { outage: { since: now, servingAgainAt: null, planned } };
  }

  /** `check`: the number of the check that saw it (checksStarted); omitted, the observation is current. */
  private async recordServing(serving: boolean, check?: number): Promise<void> {
    const change = this.outageChange(serving, false, check);
    if (change.outage === undefined) return;
    this.state = { ...this.state, ...change };
    if (serving) this.reconnectChannels();
    await this.persistAndPublish();
    if (serving) logger.info('Opfield relay serves again; nodes and relays get a reconnect grace');
    else logger.warn('Opfield relay does not serve; node and relay control streams through it are reconnecting');
  }

  /**
   * The relay serves again: Opfield's other channels to it (tunnels, policy, link reconciliation) reconnect now
   * rather than after their reconnect backoff, during which they failed with UNAVAILABLE for up to 24 s while the
   * nodes were already back (F-2). Logged every time, also when the return watch had already replaced the channels
   * during the outage, so each recovery shows in the log.
   */
  private reconnectChannels(): void {
    if (!this.relayClient?.reconnectIfDown) return;
    try {
      const replacedNow = this.relayClient.reconnectIfDown();
      logger.info('Opfield reconnected its channels to the local relay', {
        replacedNow,
        ...(replacedNow ? {} : { detail: 'reconnected while the relay was down' }),
      });
    } catch (error) {
      logger.warn('Opfield channels to the local relay were not reconnected', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  setExpectedArtifact(imageRef: string, buildVersion: string, protocolMajor: number): void {
    this.options.expectedImage = imageRef;
    this.options.expectedVersion = buildVersion;
    this.options.expectedProtocolMajor = protocolMajor;
  }

  /**
   * Runs a recovery cycle in the background. Its promise is kept only for stop(), so a failure
   * (a cache or database error) must be handled here: unhandled, it would end the process.
   */
  private startRecoveryCycle(manual: boolean): void {
    this.recoveryCycle = this.runRecoveryCycle(manual)
      .catch(async (error) => {
        logger.error('Opfield relay recovery cycle failed internally', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.transition({
          state: 'critical',
          reason: this.state.reason ?? 'unreachable',
          recoveryBlocked: 'budget',
        }).catch(() => {});
      })
      .finally(() => {
        this.recoveryCycle = null;
      });
  }

  private async runRecoveryCycle(manual: boolean): Promise<void> {
    if (!this.recovery) {
      await this.transition({ state: 'degraded', reason: 'ownership_unverified' });
      return;
    }
    const startAttempt = Math.max(1, this.state.attempt + 1);
    let supersededRounds = 0;
    let rejudge = false;
    for (let attempt = startAttempt; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (this.stopping) return;
      // A round whose action was superseded judges the relay again at once, on the same attempt.
      const delay = rejudge ? 0 : (this.recoveryDelaysMs[attempt - 1] ?? 0);
      rejudge = false;
      if (delay > 0) await this.pause(delay);
      if (this.stopping || this.inMaintenance()) return;
      // The relay may have recovered on its own meanwhile, or an update may have taken it over.
      // Restarting it then would only drop its tunnels.
      if (attempt > startAttempt || delay > 0) {
        const current = await this.checkRelay();
        if (this.inMaintenance()) return;
        if (current.healthy) {
          await this.markRecovered();
          return;
        }
      }
      const external = await this.awaitExternalActivity();
      if (external.healthy) {
        if (this.inMaintenance()) return;
        await this.markRecovered();
        return;
      }
      if (this.stopping || this.inMaintenance()) return;
      const startedAt = new Date(this.now()).toISOString();
      await this.allocateAttempt(attempt, startedAt);
      let action: RelayRecoveryAction;
      try {
        // Acts only if the container is still what it was when the decision was made.
        const outcome = await this.recovery.recover(
          external.observationKnown && supersededRounds < MAX_SUPERSEDED_ROUNDS ? external.observed : undefined
        );
        if (outcome === 'superseded') {
          supersededRounds += 1;
          logger.info('Opfield relay changed while recovery was about to act; judging it again', {
            attempt,
            round: supersededRounds,
          });
          this.state.attemptHistory = this.state.attemptHistory.filter((record) => record.attempt !== attempt);
          this.state.attempt = attempt - 1;
          await this.persistAndPublish();
          rejudge = true;
          attempt -= 1;
          continue;
        }
        this.lastOwnActionAt = this.now();
        action = outcome;
        this.updateAttempt(attempt, { action });
        await this.persistAndPublish();
      } catch (error) {
        this.lastOwnActionAt = this.now();
        this.updateAttempt(attempt, { result: 'failed' });
        logger.warn('Opfield relay recovery action failed', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
        });
        // Docker may carry an action out although its call failed (a restart that outlived the
        // request). Judge the relay, not the call: a relay that came back is healthy, not critical.
        if (error instanceof RelayRecoverySafetyError && error.reason === 'docker_unavailable') {
          const recovered = await this.waitForReadiness();
          if (!recovered && this.stopping) return;
          if (recovered) {
            await this.markRecovered();
            return;
          }
        }
        if (error instanceof RelayRecoverySafetyError) {
          await this.transition({
            state: error.reason === 'ownership_unverified' ? 'degraded' : 'critical',
            reason: error.reason,
            recoveryBlocked: 'safety',
          });
          return;
        }
        await this.persistAndPublish();
        continue;
      }
      const healthy = await this.waitForReadiness();
      // A stopping Opfield ends the wait; the next start judges the relay again.
      if (!healthy && this.stopping) return;
      if (healthy) {
        this.updateAttempt(attempt, { result: 'healthy' });
        await this.transition({
          state: 'healthy',
          reason: null,
          recoveryBlocked: null,
          attempt: 0,
          attemptHistory: [],
        });
        await this.audit.log({
          userId: null,
          action: 'relay.recovery.succeeded',
          resourceType: 'system',
          resourceId: 'opfield-relay',
          details: { attempt, action, manual },
        });
        return;
      }
      this.updateAttempt(attempt, { result: 'failed' });
      await this.persistAndPublish();
    }
    await this.transition({ state: 'critical', reason: this.state.reason ?? 'unreachable', recoveryBlocked: 'budget' });
    await this.audit.log({
      userId: null,
      action: 'relay.recovery.failed',
      resourceType: 'system',
      resourceId: 'opfield-relay',
      details: { attempts: MAX_ATTEMPTS, manual },
    });
  }

  private async allocateAttempt(attempt: number, startedAt: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-recovery'))`);
      this.state = {
        ...this.state,
        state: 'recovering',
        attempt,
        attemptHistory: [
          ...this.state.attemptHistory.filter((record) => record.attempt !== attempt),
          { attempt, startedAt, result: 'running' },
        ],
      };
      await this.cache.set(CONTROL_STATE_KEY, this.state);
    });
    this.publish();
  }

  private updateAttempt(attempt: number, update: Partial<RelayAttemptRecord>): void {
    this.state.attemptHistory = this.state.attemptHistory.map((record) =>
      record.attempt === attempt ? { ...record, ...update } : record
    );
  }

  private async markRecovered(): Promise<void> {
    this.failureCount = 0;
    await this.transition({ state: 'healthy', reason: null, recoveryBlocked: null, attempt: 0, attemptHistory: [] });
  }

  /**
   * Leaves the relay to whoever else is acting on it: a run started after the supervisor last saw
   * the relay (an operator's `docker restart`, Docker's restart policy, an update) gets its own
   * readiness window, a stop someone requested runs to its end, and a relay that just exited gets
   * a moment for a restart's start to follow. Only then may recovery act, and only on the state it
   * observed last (`observed`). Returns healthy when the relay came back meanwhile.
   */
  private async awaitExternalActivity(): Promise<
    { healthy: true } | { healthy: false; observationKnown: boolean; observed: RelayContainerObservation | null }
  > {
    if (!this.recovery) return { healthy: false, observationKnown: false, observed: null };
    const cap = this.now() + RELAY_EXTERNAL_WAIT_CAP_MS;
    let announced: RelayExternalActivity | null = null;
    for (;;) {
      if (this.stopping || this.inMaintenance()) return { healthy: false, observationKnown: false, observed: null };
      const now = this.now();
      let observed: RelayContainerObservation | null;
      try {
        observed = await this.recovery.inspectRelay(now - RELAY_EVENT_LOOKBACK_MS);
      } catch {
        // Docker did not answer: recovery's own action reports that (docker_unavailable).
        return { healthy: false, observationKnown: false, observed: null };
      }
      const wait = relayRecoveryWait(observed, this.observationBaseline(), this.readinessWaitMs, this.now());
      if (!wait || this.now() >= cap) return { healthy: false, observationKnown: true, observed };
      if (announced !== wait.activity) {
        announced = wait.activity;
        // `since` is when this activity began (the exit a moment ago for `settling`), not the start of the run
        // before it, which can be hours old.
        logger.info('Opfield relay is being handled outside the supervisor; waiting instead of restarting it', {
          activity: wait.activity,
          since: wait.sinceMs === null ? null : new Date(wait.sinceMs).toISOString(),
          waitMs: wait.waitMs,
        });
      }
      if ((await this.checkRelay()).healthy) return { healthy: true };
      // Look at the container again every poll: a stop that ended turns into a fresh run or a
      // stopped relay, each judged on its own at once.
      await this.pause(Math.max(1, Math.min(this.readinessPollMs, wait.waitMs, cap - this.now())));
    }
  }

  /** The supervisor's last own sight of the relay: its last healthy probe or its own last action. */
  private observationBaseline(): number | null {
    const lastHealthy = this.state.lastHealthyAt ? Date.parse(this.state.lastHealthyAt) : Number.NaN;
    const candidates = [Number.isFinite(lastHealthy) ? lastHealthy : null, this.lastOwnActionAt].filter(
      (value): value is number => value !== null
    );
    return candidates.length > 0 ? Math.max(...candidates) : null;
  }

  private async waitForReadiness(waitMs = this.readinessWaitMs): Promise<boolean> {
    const deadline = this.now() + waitMs;
    while (!this.stopping && this.now() < deadline) {
      const result = await this.checkRelay();
      if (result.healthy) return true;
      await this.pause(Math.max(1, Math.min(this.readinessPollMs, deadline - this.now())));
    }
    return false;
  }

  /** Sleeps, but wakes as soon as the supervisor stops. */
  private pause(ms: number): Promise<void> {
    return Promise.race([this.sleep(ms), this.stopped]);
  }

  private armStopSignal(): Promise<void> {
    return new Promise((resolve) => {
      this.signalStopped = resolve;
    });
  }

  /** One check of the relay, numbered as it starts (see checksStarted). */
  private async checkRelay(): Promise<ProbeResult & { check: number }> {
    const check = ++this.checksStarted;
    return { ...(await this.checkRelayOnce()), check };
  }

  private async checkRelayOnce(): Promise<ProbeResult> {
    if (!this.relayClient) return { healthy: false, reason: 'unreachable' };
    try {
      const response = await this.relayClient.getHealth(2_000);
      if (!response.liveness) return { healthy: false, reason: 'listener_unavailable', response };
      if (!response.readiness) {
        return {
          healthy: false,
          reason: isRelayHealthReason(response.reason) ? response.reason : 'policy_snapshot_required',
          response,
        };
      }
      if (this.options.expectedVersion && response.buildVersion !== this.options.expectedVersion) {
        return { healthy: false, reason: 'contract_mismatch' };
      }
      if (
        this.options.expectedProtocolMajor !== undefined &&
        response.protocolMajor !== this.options.expectedProtocolMajor
      ) {
        return { healthy: false, reason: 'contract_mismatch' };
      }
      return { healthy: true, response };
    } catch (error) {
      const grpcError = error as { code?: number; message?: string };
      if (
        grpcError.code === grpc.status.PERMISSION_DENIED ||
        grpcError.code === grpc.status.UNAUTHENTICATED ||
        /(?:tls|ssl|certificate|handshake)/i.test(grpcError.message ?? '')
      ) {
        return { healthy: false, reason: 'tls_unavailable' };
      }
      return { healthy: false, reason: 'unreachable' };
    }
  }

  /**
   * Records a local relay that stays unavailable, so placement and the pool status stop treating
   * it as ready. It is written only after the second failed probe, never during maintenance
   * (probes are off then), and cleared by the next healthy probe. A relay that answers but is
   * not ready also reports the keys it trusts, which policy key rotation relies on.
   */
  private async recordUnavailableLocalInstance(result: Extract<ProbeResult, { healthy: false }>): Promise<void> {
    if (result.response?.liveness) {
      await this.recordLocalInstance(result.response, 'synchronizing');
      return;
    }
    if (!OFFLINE_REASONS.includes(result.reason)) return;
    await this.db
      .update(relayInstances)
      .set({ state: 'offline', updatedAt: new Date() })
      .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')));
  }

  private async recordLocalInstance(response: RelayHealthResponse, unavailableState?: 'synchronizing'): Promise<void> {
    if (!response.relayInstanceId || response.poolId !== 'system') return;
    const expiresAtUnix = Number(response.policyExpiresAtUnix || 0);
    const reportedAt = new Date();
    const [previous] = await this.db
      .select({ lastSeenAt: relayInstances.lastSeenAt })
      .from(relayInstances)
      .where(eq(relayInstances.id, response.relayInstanceId))
      .limit(1);
    await this.db
      .update(relayInstances)
      .set({
        state: unavailableState ?? (response.draining ? 'draining' : 'ready'),
        buildVersion: response.buildVersion,
        protocolMajor: response.protocolMajor,
        capabilities: {
          protocolMajor: response.protocolMajor,
          features: response.capabilities ?? [],
        },
        appliedPolicyRevision: Number(response.appliedRevision || 0),
        policyExpiresAt: expiresAtUnix > 0 ? new Date(expiresAtUnix * 1000) : null,
        lastSeenAt: reportedAt,
        health: {
          activeTunnels: Number(response.activeTunnels || 0),
          registeredEndpoints: Number(response.registeredEndpoints || 0),
          pressurePercent: Number(response.pressurePercent || 0),
          cpuPressurePercent: Number(response.cpuPressurePercent || 0),
          memoryPressurePercent: Number(response.memoryPressurePercent || 0),
          fdPressurePercent: Number(response.fdPressurePercent || 0),
          admissionState: response.admissionState,
          policySigningKeyIds: response.policyKeyIds ?? [],
          assignmentTunnels: (response.assignmentTunnels ?? []).map((count) => ({
            endpointId: count.endpointId,
            assignmentGeneration: Number(count.assignmentGeneration),
            activeTunnels: Number(count.activeTunnels),
          })),
        },
        updatedAt: new Date(),
      })
      .where(eq(relayInstances.id, response.relayInstanceId));
    // A gap this long means the relay ran unreachable on whatever policy it last held; the audit
    // trail records what it served through, not just that it reconnected.
    if (previous?.lastSeenAt && reportedAt.getTime() - previous.lastSeenAt.getTime() > RELAY_STALE_POLICY_GAP_MS) {
      await this.audit.log({
        userId: null,
        action: 'relay.instance.policy.stale_period',
        resourceType: 'relay_instance',
        resourceId: response.relayInstanceId,
        details: { from: previous.lastSeenAt.toISOString(), to: reportedAt.toISOString() },
      });
    }
    if (response.availabilityLease && this.availabilityLease) {
      await this.availabilityLease
        .ingestRelayReport(response.relayInstanceId, response.availabilityLease)
        .catch((error) => logger.warn('Local relay availability lease report was not recorded', { error }));
    }
  }

  /** Read through a method: a relay update can switch maintenance on while a cycle awaits. */
  private inMaintenance(): boolean {
    return this.state.state === 'maintenance';
  }

  private isRecoverable(reason: RelayHealthReason): boolean {
    return reason === 'unreachable' || reason === 'listener_unavailable';
  }

  /** `check`: the check that saw the relay healthy, when a probe's (see checksStarted). */
  private async transition(update: Partial<RelaySupervisorState>, check?: number): Promise<void> {
    if (update.state === 'healthy') {
      const change = this.outageChange(true, false, check);
      update = { ...update, ...change };
      if (change.outage) this.reconnectChannels();
    }
    const changed = Object.entries(update).some(
      ([key, value]) => this.state[key as keyof RelaySupervisorState] !== value
    );
    this.state = { ...this.state, ...update };
    if (!changed) return;
    await this.persistAndPublish();
    logger.info('Opfield relay supervisor state changed', {
      state: this.state.state,
      reason: this.state.reason,
      attempt: this.state.attempt,
    });
  }

  private async persistAndPublish(): Promise<void> {
    await this.cache.set(CONTROL_STATE_KEY, this.state);
    this.publish();
  }

  private publish(): void {
    const outage = this.state.outage;
    this.events.publish('system.relay.health.changed', {
      state: this.state.state,
      reason: this.state.reason,
      attempt: this.state.attempt,
      // When the relay stopped serving, for the alert's duration (its first failed probe, before the alert fires).
      outageSince: outage && outage.servingAgainAt === null ? outage.since : null,
    });
  }
}
