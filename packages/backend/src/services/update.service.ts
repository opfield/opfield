import { and, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { DOCKER_COMPOSE_CLI_IMAGE_REF } from '@/config/docker-compose-cli-image.js';
import type { Env } from '@/config/env.js';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { nodes, relayInstances, relayPoolUpdateRuns, relayPoolUpdateSteps } from '@/db/schema/index.js';
import { settings } from '@/db/schema/settings.js';
import {
  DEFAULT_SANDBOX_WORKSPACE_DIR,
  dockerLogDefaultsEnv,
  hostDockerLogDefaults,
} from '@/foundation/foundation-migrator.js';
import { HOST_MOVE_CONTAINER_NAME } from '@/foundation/host-move.js';
import {
  DATABASE_SNAPSHOT_FILE,
  databaseIdentity,
  FOUNDATION_BACKUPS_DIR,
  isSafeDatabaseIdentifier,
  LEGACY_DATABASE,
  LEGACY_DATABASE_ROLE,
  LEGACY_DATABASE_SNAPSHOT_FILE,
  LEGACY_FOUNDATION_BACKUPS_DIR,
} from '@/foundation/opfield-names.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  type ReleaseFileSource,
  type ReleaseRecord,
  releaseFileSource,
  releaseNotes,
  releaseUrl,
} from '@/lib/release-artifacts.js';
import { compareSemver, isNewerVersion, isReleaseCandidateVersion, parseSemver } from '@/lib/semver.js';
import type { TrustedDaemonUpdateArtifact } from '@/lib/update-artifact-trust.js';
import {
  type TrustedOpfieldUpdateArtifact,
  type TrustedRelayUpdateArtifact,
  verifyOpfieldImageManifest,
  verifyRelayImageManifest,
} from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { GeneralSettingsService, UpdateChannel } from '@/modules/settings/general-settings.service.js';
import type { DockerService } from './docker.service.js';
import { HOST_MOVE_ROLE, HostMoveLauncher, hasLegacyLayout } from './host-move-launcher.js';
import {
  type OrchestrationActivitySource,
  type PendingOrchestrationOperation,
  waitForOrchestrationIdle,
} from './orchestration-activity.js';
import { saveInstalledRelayArtifact } from './relay-installed-artifact.js';
import {
  drainingTunnels,
  LOCAL_RELAY_DRAIN_UNSUPPORTED,
  localServiceEndpointIds,
  waitForLocalRelayEvacuation,
} from './relay-local-takeover.js';
import {
  drainOutcomeNote,
  localRelayPauseNote,
  RELAY_UPDATE_DRAIN_GRACE_MS,
  RESUMABLE_DRAIN_GRACE_MS,
  type RelayStreamCounters,
  type RelayStreamReports,
  relayDrainGraceMs,
  relayDrainOutcome,
  relaySessionSplit,
  relayStreamCounters,
  relayStreamOutcome,
} from './relay-stream-resume.js';

const logger = createChildLogger('UpdateService');

export { DOCKER_COMPOSE_CLI_IMAGE_REF };

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  lastCheckedAt: string | null;
  relay: RelayUpdateStatus;
  opfieldOperation: OpfieldUpdateOperation | null;
}

/**
 * A Gateway self-update this process accepted and has not handed off yet, or
 * (`failed`) a handed-off update that did not replace this version.
 */
export interface OpfieldUpdateOperation {
  /** `waiting_for_operations` until running orchestration work finishes. */
  status: 'waiting_for_operations' | 'updating' | 'failed';
  targetVersion: string;
  startedAt: string;
  /** When the update proceeds even if operations still run. */
  waitDeadline: string | null;
  operations: PendingOrchestrationOperation[];
  /** Why the update did not complete; set only when `failed`. */
  error?: string | null;
}

export interface UpdateEvents {
  publish(channel: string, payload: unknown): void;
}

export interface UpdateAuditLog {
  log(entry: {
    userId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * A handed-off update replaces this process within minutes. If it is still
 * alive after this, the handoff failed: accept orchestration work again.
 */
const UPDATE_HANDOFF_SETTLE_MS = 20 * 60_000;

/**
 * Written before anything on the host changes. The process that starts next
 * reads it: the target version marks it started and clears it once the update
 * settles, any other version reports a failure.
 */
const OPFIELD_UPDATE_ATTEMPT_KEY = 'update:gateway:attempt';
/**
 * The sidecar keeps checking a started target for about 5 minutes and rolls it
 * back if it never becomes healthy. The target keeps the attempt record this
 * long, so the version it rolls back to still finds the record and reports it.
 */
const OPFIELD_UPDATE_TARGET_GRACE_MS = 10 * 60_000;
/** Marks the container that runs a Gateway self-update, so it is removed once it has finished. */
const UPDATE_SIDECAR_LABEL = 'net.opfield.role';
const UPDATE_SIDECAR_ROLE = 'opfield-update-sidecar';
// legacy-name: gateway-update-sidecar — sidecars started by releases before 2.12.1; only cleaned up — remove once no
// supported update starts from a version before 2.12.1.
const LEGACY_UPDATE_SIDECAR_ROLE = 'gateway-update-sidecar';
/** Exited update and host move containers this process cleans up. */
const FINISHED_CONTAINER_ROLES: readonly string[] = [UPDATE_SIDECAR_ROLE, LEGACY_UPDATE_SIDECAR_ROLE];
/** The Docker CLI image of update sidecars started before they were labelled (any pinned version). */
const UNLABELLED_SIDECAR_IMAGE = /^docker\.io\/library\/docker:\d+-cli@sha256:[0-9a-f]{64}$/;
/** A failed update stays reported this long unless an admin acknowledges it. */
const FAILED_OPFIELD_UPDATE_REPORT_MS = 24 * 60 * 60_000;

interface OpfieldUpdateAttempt {
  targetVersion: string;
  fromVersion: string;
  startedAt: string;
  userId: string | null;
  sidecarId: string | null;
  failedAt: string | null;
  error: string | null;
  /** Set by the target version when it starts; the sidecar may still roll it back. */
  targetStartedAt?: string | null;
}

/** States in which a Relay Pool update run is being driven by a Gateway process. */
const ACTIVE_RELAY_POOL_RUN_STATES = ['preflight', 'draining', 'updating', 'verifying', 'rolling_back'] as const;
/** How soon a Relay Pool run that failed is checked for an outcome that could not be recorded. */
const ORPHANED_RELAY_POOL_RUN_CHECK_MS = 30_000;
/** Active runs plus paused ones, which wait for an operator to retry or abandon them. */
const UNFINISHED_RELAY_POOL_RUN_STATES = [...ACTIVE_RELAY_POOL_RUN_STATES, 'paused'] as const;
/** Step states in which the update may hold the relay drained. */
const IN_FLIGHT_RELAY_POOL_STEP_STATES = ['draining', 'updating', 'verifying', 'rolling_back'] as const;
const RELAY_DRAIN_RELEASE_RETRY_MS = 30_000;
/** After the forced disconnect: time for the relay to report its streams closed. The update goes on either way. */
const RELAY_UPDATE_FORCED_DRAIN_SETTLE_MS = 30_000;
/** How long a drained local relay's workloads get to move to other relays before the update resumes it instead. */
const LOCAL_RELAY_EVACUATION_TIMEOUT_MS = 5 * 60_000;
const RELAY_DRAIN_RELEASE_ATTEMPTS = 20;
/** How often a worker update that left the previous worker running is dispatched again. */
const RELAY_WORKER_STALE_VERSION_RETRIES = 2;
const RELAY_UPDATE_BLOCKS_OPFIELD_MESSAGE =
  'A Relay Pool update is in progress. Update Opfield after it finishes, or abandon the Relay Pool update first.';

class RelayPoolUpdateAbandonedError extends Error {
  constructor() {
    super('The Relay Pool update was abandoned');
  }
}

export interface RelayUpdateOperation {
  status: 'updating' | 'failed';
  targetVersion: string;
  startedAt: string;
  error: string | null;
  /** The run has not finished (it runs, or it is paused waiting for an operator) and can be abandoned. */
  abandonable?: boolean;
  /** The durable Relay Pool run state, when the operation is a pool run. */
  runState?: string;
  /** When the run or one of its steps last moved; a run that stops moving is stuck. */
  lastProgressAt?: string;
}

export interface RelayUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  operation: RelayUpdateOperation | null;
}

interface FoundationMigrationOutput {
  ok: true;
  changedFiles: string[];
  backupDir: string | null;
  sandboxWorkspaceDir: string;
}

export interface RelayUpdateRuntime {
  setMaintenance(enabled: boolean): Promise<void>;
  setExpectedArtifact(imageRef: string, buildVersion: string, protocolMajor: number): void;
  updateSecureLinkConnectorImage(imageRef: string): Promise<void>;
  probeNow(): Promise<void>;
}

export interface RelayPoolUpdateRuntime {
  drainInstance(instanceId: string, userId: string | null, enabled: boolean): Promise<void>;
  /** Closes the streams a drained relay still carries (audited as a forced disconnect). */
  forceDisconnectInstance(instanceId: string, userId: string | null): Promise<void>;
  /** Why no other relay can carry the local relay's workloads while it is recreated; null when one can. */
  localRelayTakeoverBlocker?(localInstanceId: string): Promise<string | null>;
  /**
   * Resolves once no other voter or candidate of the relay's availability lease policies is updating or still
   * settling after a restart (daemon updates included), so two members of one policy never restart together.
   */
  awaitLeasePeers?(relayInstanceId: string, signal: AbortSignal): Promise<void>;
  /**
   * Before the run drains its next relay and after its last step: waits (bounded) until the placement that includes
   * the relays it updated so far is active (RelayPoolService.settleForUpdate).
   */
  settlePlacement?(signal: AbortSignal): Promise<void>;
  /** After the relay restarted at `since`: waits (bounded) until it reports a lease acceptor that votes again. */
  awaitLeaseSettled?(relayInstanceId: string, since: number, signal: AbortSignal): Promise<void>;
  /** Whether the remote relay of this node is connected now; an offline member is skipped, not waited for. */
  isRelayConnected?(nodeId: string): boolean;
  /** The relay stream sessions (RSv1) daemons reported recently: the drain grace and the step notes use them. */
  relayStreamReports?(): RelayStreamReports;
  prepareWorkerUpdate(version: string, arch: string): Promise<TrustedDaemonUpdateArtifact>;
  dispatchWorkerUpdate(nodeId: string, artifact: TrustedDaemonUpdateArtifact): Promise<void>;
  prepareSupervisorUpdate(version: string, arch: string): Promise<TrustedDaemonUpdateArtifact>;
  /** Resolves once the node accepted the update command; `failed` tells when the command then answers failure. */
  dispatchSupervisorUpdate(
    nodeId: string,
    artifact: TrustedDaemonUpdateArtifact
  ): Promise<DispatchedUpdate | undefined>;
}

/** An update command the node accepted. */
export interface DispatchedUpdate {
  /** Resolves with the daemon's reason when the command answers failure; never on success. */
  failed: Promise<string>;
}

/**
 * The reason a dispatched update command failed with, once its result says so: a protected relay refuses an older
 * release at once. Never resolves on success, nor on an uncertain answer (the node disconnected or the command timed
 * out while it restarted), which the wait for the node's reconnect settles.
 */
export function updateCommandFailure(result: Promise<{ success: boolean; error?: string; detail?: string }>) {
  return new Promise<string>((resolve) => {
    result.then(
      (answer) => {
        if (!answer.success) resolve(answer.error || answer.detail || 'The daemon rejected the update');
      },
      () => undefined
    );
  });
}

/** The note of a member a Relay Pool update skipped. */
export const RELAY_UPDATE_SKIPPED_OFFLINE = 'Skipped: the relay is not connected; it is updated when it reconnects';

/** First relay release whose shutdown drains for at most 5 s while it keeps serving its tunnels. */
const RELAY_BOUNDED_DRAIN_VERSION = 'v2.11.0-rc.7';
/** Docker's stop timeout, which relays with a bounded drain stay well inside. */
const RELAY_DEFAULT_STOP_TIMEOUT_SECONDS = 10;
/** Enough for an older relay to close its tunnels; it serves no new request once it got SIGTERM. */
const RELAY_UNBOUNDED_DRAIN_STOP_TIMEOUT_SECONDS = 2;

/**
 * Stop timeout for recreating the local relay. A relay older than v2.11.0-rc.7 answers SIGTERM with an unbounded
 * graceful gRPC stop: it refuses every new stream at once but never exits on its own while daemons keep their
 * endpoint registrations open, so Docker killed it only after its 10 s stop timeout and every Secure Link route was
 * down for that long before the new relay could even start (2.10.1 upgrade: 11-14 s). Such a relay is stopped after
 * 2 s. Newer relays keep serving their tunnels through a drain of at most 5 s and exit themselves.
 */
export function relayRecreateStopTimeoutSeconds(runningRelayVersion: string | undefined | null): number {
  if (!runningRelayVersion || !parseSemver(runningRelayVersion)) return RELAY_DEFAULT_STOP_TIMEOUT_SECONDS;
  return compareSemver(runningRelayVersion, RELAY_BOUNDED_DRAIN_VERSION) < 0
    ? RELAY_UNBOUNDED_DRAIN_STOP_TIMEOUT_SECONDS
    : RELAY_DEFAULT_STOP_TIMEOUT_SECONDS;
}

export function isOpfieldReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

export function selectLatestOpfieldRelease(releases: ReleaseRecord[]): ReleaseRecord | null {
  const matching = releases
    .filter((release) => isOpfieldReleaseTag(release.tag_name))
    .sort((a, b) => compareSemver(b.tag_name, a.tag_name));

  return matching[0] ?? null;
}

export function isRelayReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+-relay$/.test(tag);
}

export function selectLatestRelayRelease(releases: ReleaseRecord[]): ReleaseRecord | null {
  return (
    releases
      .filter((release) => isRelayReleaseTag(release.tag_name))
      .sort((a, b) => compareSemver(b.tag_name.replace(/-relay$/, ''), a.tag_name.replace(/-relay$/, '')))[0] ?? null
  );
}

export function isRelayTooOldForOpfieldUpdate(relayVersion: string, targetVersion: string): boolean {
  const current = parseSemver(relayVersion);
  const target = parseSemver(targetVersion);
  if (!current || !target) return false;
  if (current.major < target.major) return true;
  if (current.major > target.major) return false;
  return target.minor - current.minor >= 2;
}

/**
 * True for a relay worker update that installed the target but found the previous worker still running: the
 * supervisor reports "worker reported version X, expected Y". A supervisor before v2.11.1 could restart the
 * previous binary while the new one downloaded; dispatching the update again replaces that worker.
 */
export function isStaleRelayWorkerVersionError(error: unknown, targetVersion: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = /worker reported version (\S+), expected (\S+)/.exec(message);
  return (
    match !== null &&
    normalizeVersionTag(match[2]) === normalizeVersionTag(targetVersion) &&
    normalizeVersionTag(match[1]) !== normalizeVersionTag(targetVersion)
  );
}

export function isOpfieldCompatibleWithRelayUpdate(currentVersion: string, minGatewayVersion: string): boolean {
  const current = parseSemver(currentVersion);
  const minimum = parseSemver(minGatewayVersion);
  if (!current || !minimum) return currentVersion === 'dev';
  return compareSemver(currentVersion, minGatewayVersion) >= 0;
}

const SETTINGS_KEYS = {
  latestVersion: 'update:latest_version',
  lastCheckedAt: 'update:last_checked_at',
  releaseNotes: 'update:release_notes',
  releaseUrl: 'update:release_url',
  relayLatestVersion: 'update:relay:latest_version',
  relayReleaseNotes: 'update:relay:release_notes',
  relayReleaseUrl: 'update:relay:release_url',
  relayMinOpfieldVersion: 'update:relay:min_gateway_version',
} as const;

export class UpdateService {
  private opfieldUpdateInProgress = false;
  private opfieldUpdateOperation: OpfieldUpdateOperation | null = null;
  private orchestration?: OrchestrationActivitySource;
  private events?: UpdateEvents;
  private audit?: UpdateAuditLog;
  private operationWaitOverride: AbortController | null = null;
  private handoffSettleTimer?: ReturnType<typeof setTimeout>;
  private failedReportTimer?: ReturnType<typeof setTimeout>;
  private targetGraceTimer?: ReturnType<typeof setTimeout>;
  private readonly releasesUrl: string;
  private relayUpdateOperation: RelayUpdateOperation | null = null;
  private relayPoolRuntime?: RelayPoolUpdateRuntime;
  /** Set while this process drives a Relay Pool run; aborting it abandons the run. */
  private relayPoolRun: AbortController | null = null;
  /**
   * Set once the local relay update rewrote the installation and recreates the relay: the last step of a run, which
   * finishes or rolls back on its own and cannot be abandoned, until the update ends.
   */
  private localRelayUpdateCommitted = false;
  /** Starts the move to the Opfield layout once an update to this release has settled. */
  private hostMoveLauncher: HostMoveLauncher | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dockerService: DockerService,
    private readonly env: Env,
    private readonly relayRuntime?: RelayUpdateRuntime,
    private readonly generalSettings?: GeneralSettingsService
  ) {
    this.releasesUrl = this.env.RELEASES_API_URL;
  }

  private async getUpdateChannel(): Promise<UpdateChannel> {
    return (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';
  }

  private async fetchReleases(): Promise<ReleaseRecord[]> {
    const channel = await this.getUpdateChannel();
    const url = new URL(this.releasesUrl);
    url.searchParams.set('channel', channel);
    logger.debug('Checking release provider for updates', { url: url.toString(), channel });
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Release API returned ${response.status}`);
    return (await response.json()) as ReleaseRecord[];
  }

  private async fetchNextRelease(
    component: 'gateway' | 'relay',
    currentVersion: string,
    channel: UpdateChannel
  ): Promise<ReleaseRecord | null> {
    const url = new URL(this.releasesUrl);
    url.searchParams.set('component', component);
    url.searchParams.set('current', currentVersion);
    url.searchParams.set('channel', channel);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Release resolver returned ${response.status}`);
    const payload = (await response.json()) as { target?: ReleaseRecord };
    if (!payload.target) throw new Error('Release resolver returned no target');
    return payload.target;
  }

  private opfieldImageRepositories(currentImage: string): string[] {
    const configured = (this.env.OPFIELD_UPDATE_IMAGE_REPOSITORIES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return [...new Set([currentImage, ...configured])];
  }

  private getManifestSource(packageName: string, tag: string, fileName: string): ReleaseFileSource {
    return releaseFileSource(this.env.ARTIFACT_BASE_URL, packageName, tag, fileName);
  }

  private async fetchSignedManifest(source: ReleaseFileSource, label: string): Promise<string> {
    const response = await fetch(source.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return response.text();
    throw new AppError(
      502,
      'UNTRUSTED_UPDATE_ARTIFACT',
      `Failed to fetch ${label} update manifest: ${response.status}`
    );
  }

  setRelayPoolUpdateRuntime(runtime: RelayPoolUpdateRuntime): void {
    this.relayPoolRuntime = runtime;
  }

  /** The update waits for (and holds new) orchestration work reported by this source. */
  setOrchestrationGate(source: OrchestrationActivitySource, events?: UpdateEvents): void {
    this.orchestration = source;
    this.events = events;
  }

  setAuditLog(audit: UpdateAuditLog): void {
    this.audit = audit;
  }

  isOpfieldUpdateInProgress(): boolean {
    return this.opfieldUpdateInProgress;
  }

  /** Refuses a Gateway update (or paid-feature activation) that would interrupt another update. */
  async assertOpfieldUpdateAllowed(): Promise<void> {
    if (this.opfieldUpdateInProgress) {
      throw new AppError(409, 'UPDATE_IN_PROGRESS', 'An Opfield update is already in progress');
    }
    if (await this.isRelayUpdateRunning()) {
      throw new AppError(409, 'RELAY_UPDATE_IN_PROGRESS', RELAY_UPDATE_BLOCKS_OPFIELD_MESSAGE);
    }
  }

  /** True while a Gateway update or a running Relay update is in flight. */
  async isAnyUpdateRunning(): Promise<boolean> {
    return this.opfieldUpdateInProgress || (await this.isRelayUpdateRunning());
  }

  /** A Relay update that runs now; a paused Relay Pool run waits for the operator and does not count. */
  private async isRelayUpdateRunning(): Promise<boolean> {
    if (this.relayUpdateOperation?.status === 'updating' || this.relayPoolRun) return true;
    if (!this.relayPoolRuntime) return false;
    const [run] = await this.db
      .select({ id: relayPoolUpdateRuns.id })
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [...ACTIVE_RELAY_POOL_RUN_STATES])
        )
      )
      .limit(1);
    return Boolean(run);
  }

  /** The operator's "update now": stop waiting for running orchestration work. */
  proceedWithoutWaiting(): boolean {
    if (this.opfieldUpdateOperation?.status !== 'waiting_for_operations' || !this.operationWaitOverride) return false;
    this.operationWaitOverride.abort();
    return true;
  }

  getCurrentVersion(): string {
    return this.env.APP_VERSION;
  }

  startRelayUpdate(targetVersion: string): void {
    if (this.opfieldUpdateInProgress) {
      throw new AppError(
        409,
        'OPFIELD_UPDATE_IN_PROGRESS',
        'Opfield is updating. Update the Relay Pool after the Opfield update has finished.'
      );
    }
    if (this.relayUpdateOperation?.status === 'updating' || this.relayPoolRun) {
      throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A relay update is already in progress');
    }
    this.relayUpdateOperation = {
      status: 'updating',
      targetVersion: normalizeVersionTag(targetVersion),
      startedAt: new Date().toISOString(),
      error: null,
    };
  }

  completeRelayUpdate(): void {
    this.relayUpdateOperation = null;
  }

  failRelayUpdate(error: unknown): void {
    const operation = this.relayUpdateOperation;
    if (!operation) return;
    this.relayUpdateOperation = {
      ...operation,
      status: 'failed',
      error: formatError(error),
    };
  }

  async getCachedStatus(): Promise<UpdateStatus> {
    const currentVersion = this.getCurrentVersion();
    const updateChannel = await this.getUpdateChannel();

    const allRows = await this.db
      .select()
      .from(settings)
      .where(inArray(settings.key, Object.values(SETTINGS_KEYS)));

    const map = new Map(allRows.map((r) => [r.key, r.value as string]));

    const cachedLatestVersion = map.get(SETTINGS_KEYS.latestVersion) ?? null;
    const latestVersion =
      updateChannel === 'stable' && cachedLatestVersion && isReleaseCandidateVersion(cachedLatestVersion)
        ? null
        : cachedLatestVersion;
    const opfieldUpdateAvailable =
      currentVersion !== 'dev' && latestVersion != null ? isNewerVersion(latestVersion, currentVersion) : false;
    const currentRelayVersion = this.env.OPFIELD_RELAY_BUILD_VERSION ?? 'unknown';
    const cachedLatestRelayVersion = map.get(SETTINGS_KEYS.relayLatestVersion) ?? null;
    const latestRelayVersion =
      updateChannel === 'stable' && cachedLatestRelayVersion && isReleaseCandidateVersion(cachedLatestRelayVersion)
        ? null
        : cachedLatestRelayVersion;
    const relayMinOpfieldVersion = map.get(SETTINGS_KEYS.relayMinOpfieldVersion) ?? null;
    const relayUpdateAvailable =
      currentRelayVersion !== 'dev' &&
      currentRelayVersion !== 'unknown' &&
      latestRelayVersion != null &&
      relayMinOpfieldVersion != null &&
      isOpfieldCompatibleWithRelayUpdate(currentVersion, relayMinOpfieldVersion) &&
      (isNewerVersion(latestRelayVersion, currentRelayVersion) || (await this.remoteRelayBehind(latestRelayVersion)));
    const updateAvailable =
      opfieldUpdateAvailable &&
      latestVersion != null &&
      !isRelayTooOldForOpfieldUpdate(currentRelayVersion, latestVersion);

    const durableOperation = await this.getDurableRelayOperation();
    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseNotes: latestVersion ? (map.get(SETTINGS_KEYS.releaseNotes) ?? null) : null,
      releaseUrl: latestVersion ? (map.get(SETTINGS_KEYS.releaseUrl) ?? null) : null,
      lastCheckedAt: map.get(SETTINGS_KEYS.lastCheckedAt) ?? null,
      relay: {
        currentVersion: currentRelayVersion,
        latestVersion: latestRelayVersion,
        updateAvailable: relayUpdateAvailable,
        releaseNotes: latestRelayVersion ? (map.get(SETTINGS_KEYS.relayReleaseNotes) ?? null) : null,
        releaseUrl: latestRelayVersion ? (map.get(SETTINGS_KEYS.relayReleaseUrl) ?? null) : null,
        operation: durableOperation ?? this.relayUpdateOperation,
      },
      opfieldOperation: this.opfieldUpdateOperation,
    };
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    const currentVersion = this.getCurrentVersion();

    // Always persist the check timestamp
    const lastCheckedAt = new Date().toISOString();
    await this.upsertSetting(SETTINGS_KEYS.lastCheckedAt, lastCheckedAt);

    if (currentVersion === 'dev') {
      logger.debug('Skipping update check in dev mode');
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseNotes: null,
        releaseUrl: null,
        lastCheckedAt,
        relay: {
          currentVersion: this.env.OPFIELD_RELAY_BUILD_VERSION ?? 'dev',
          latestVersion: null,
          updateAvailable: false,
          releaseNotes: null,
          releaseUrl: null,
          operation: this.relayUpdateOperation,
        },
        opfieldOperation: this.opfieldUpdateOperation,
      };
    }

    try {
      const currentRelayVersion = this.env.OPFIELD_RELAY_BUILD_VERSION ?? currentVersion;
      const updateChannel = await this.getUpdateChannel();
      const [latest, latestRelay] = await Promise.all([
        this.fetchNextRelease('gateway', currentVersion, updateChannel),
        this.fetchNextRelease('relay', currentRelayVersion, updateChannel),
      ]);
      if (latest) {
        await this.upsertSetting(SETTINGS_KEYS.latestVersion, latest.tag_name);
        await this.upsertSetting(SETTINGS_KEYS.releaseNotes, releaseNotes(latest));
        await this.upsertSetting(SETTINGS_KEYS.releaseUrl, releaseUrl(latest));
      } else {
        await this.deleteSettings([SETTINGS_KEYS.latestVersion, SETTINGS_KEYS.releaseNotes, SETTINGS_KEYS.releaseUrl]);
      }
      if (latestRelay) {
        const relayVersion = latestRelay.tag_name.replace(/-relay$/, '');
        const relayArtifact = await this.prepareRelayUpdate(relayVersion, true);
        await this.upsertSetting(SETTINGS_KEYS.relayLatestVersion, relayVersion);
        await this.upsertSetting(SETTINGS_KEYS.relayReleaseNotes, releaseNotes(latestRelay));
        await this.upsertSetting(SETTINGS_KEYS.relayReleaseUrl, releaseUrl(latestRelay));
        await this.upsertSetting(SETTINGS_KEYS.relayMinOpfieldVersion, relayArtifact.minGatewayVersion);
      } else {
        await this.deleteSettings([
          SETTINGS_KEYS.relayLatestVersion,
          SETTINGS_KEYS.relayReleaseNotes,
          SETTINGS_KEYS.relayReleaseUrl,
          SETTINGS_KEYS.relayMinOpfieldVersion,
        ]);
      }
      if (!latest && !latestRelay) logger.debug('No Opfield or relay releases found');
      return this.getCachedStatus();
    } catch (error) {
      logger.warn('Update check failed', { error });
      // Return cached status on failure
      return this.getCachedStatus();
    }
  }

  async getReleaseNotes(version: string): Promise<string> {
    const releases = await this.fetchReleases();
    const release = releases.find((candidate) => candidate.tag_name === version);
    if (!release) throw new Error(`Release ${version} was not found`);
    return releaseNotes(release);
  }

  /**
   * Fetch release notes for all versions between `after` (exclusive) and `upTo` (inclusive).
   * Returns newest first.
   */
  async getReleaseNotesSince(after: string, upTo: string): Promise<{ version: string; notes: string }[]> {
    const releases = await this.fetchReleases();

    // Filter releases: newer than `after` and up to `upTo` (inclusive)
    return releases
      .filter((r) => {
        const tag = r.tag_name;
        return isOpfieldReleaseTag(tag) && compareSemver(tag, after) > 0 && compareSemver(tag, upTo) <= 0;
      })
      .sort((a, b) => compareSemver(b.tag_name, a.tag_name))
      .map((r) => ({ version: r.tag_name, notes: releaseNotes(r) }));
  }

  async prepareOpfieldUpdate(targetVersion: string): Promise<TrustedOpfieldUpdateArtifact> {
    const tag = normalizeVersionTag(targetVersion);
    const selfInfo = await this.dockerService.inspectSelf();
    const currentImage = imageRepositoryFromRef(selfInfo.Config.Image);
    const signedManifest = await this.fetchSignedManifest(
      this.getManifestSource('gateway', tag, 'gateway-image.update.json'),
      'gateway'
    );
    let artifact: TrustedOpfieldUpdateArtifact | null = null;
    let verificationError: unknown;
    for (const image of this.opfieldImageRepositories(currentImage)) {
      try {
        artifact = verifyOpfieldImageManifest(signedManifest, { version: tag, tag, image });
        break;
      } catch (error) {
        verificationError = error;
      }
    }
    if (!artifact) {
      logger.warn('Opfield update manifest verification failed', {
        targetVersion,
        currentImage,
        error: verificationError instanceof Error ? verificationError.message : String(verificationError),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Opfield update artifact is not trusted');
    }

    return artifact;
  }

  async prepareRelayUpdate(
    targetVersion: string,
    allowIncompatibleOpfield = false
  ): Promise<TrustedRelayUpdateArtifact> {
    const version = normalizeVersionTag(targetVersion);
    const tag = `${version}-relay`;
    const selfInfo = await this.dockerService.inspectSelf();
    const currentImage = imageRepositoryFromRef(selfInfo.Config.Image);
    const signedManifest = await this.fetchSignedManifest(
      this.getManifestSource('relay', tag, 'relay-image.update.json'),
      'relay'
    );
    let artifact: TrustedRelayUpdateArtifact | null = null;
    let verificationError: unknown;
    for (const opfieldImage of this.opfieldImageRepositories(currentImage)) {
      try {
        artifact = verifyRelayImageManifest(signedManifest, {
          version,
          tag,
          image: `${opfieldImage}/relay`,
          protocolMajor: 1,
        });
        break;
      } catch (error) {
        verificationError = error;
      }
    }
    if (!artifact) {
      logger.warn('Relay update manifest verification failed', {
        targetVersion,
        currentImage,
        error: verificationError instanceof Error ? verificationError.message : String(verificationError),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Relay update artifact is not trusted');
    }
    if (
      !allowIncompatibleOpfield &&
      !isOpfieldCompatibleWithRelayUpdate(this.getCurrentVersion(), artifact.minGatewayVersion)
    ) {
      throw new AppError(
        409,
        'OPFIELD_UPDATE_REQUIRED',
        `Relay ${version} requires Opfield ${artifact.minGatewayVersion} or newer`
      );
    }
    return artifact;
  }

  async performUpdate(
    targetVersion: string,
    artifact: TrustedOpfieldUpdateArtifact,
    userId: string | null = null
  ): Promise<void> {
    if (this.opfieldUpdateInProgress)
      throw new AppError(409, 'UPDATE_IN_PROGRESS', 'An Opfield update is already in progress');
    this.opfieldUpdateInProgress = true;
    this.setOpfieldUpdateOperation({
      status: 'updating',
      targetVersion: normalizeVersionTag(targetVersion),
      startedAt: new Date().toISOString(),
      waitDeadline: null,
      operations: [],
    });
    try {
      // Checked after the flag is set: a Relay update cannot start from here on.
      if (await this.isRelayUpdateRunning()) {
        throw new AppError(409, 'RELAY_UPDATE_IN_PROGRESS', RELAY_UPDATE_BLOCKS_OPFIELD_MESSAGE);
      }
      await this.performOpfieldUpdate(targetVersion, artifact, userId);
    } catch (error) {
      this.opfieldUpdateInProgress = false;
      this.setOpfieldUpdateOperation(null);
      this.orchestration?.setOrchestrationAdmissionHold(null);
      // This process reports the failure itself; the next start must not.
      await this.deleteSettings([OPFIELD_UPDATE_ATTEMPT_KEY]).catch((clearError) =>
        logger.warn('Could not clear the Opfield update attempt record', { error: formatError(clearError) })
      );
      throw error;
    }
    this.handoffSettleTimer = setTimeout(() => {
      logger.error('Opfield update handoff did not replace this process; accepting orchestration work again', {
        targetVersion,
      });
      this.opfieldUpdateInProgress = false;
      this.orchestration?.setOrchestrationAdmissionHold(null);
      void this.reportFailedOpfieldUpdate(
        `The update to ${normalizeVersionTag(targetVersion)} did not replace Opfield ${this.getCurrentVersion()}, which keeps running. Check the update container logs on the Opfield host.`
      ).catch((error) => logger.error('Could not report the failed Opfield update', { error: formatError(error) }));
    }, UPDATE_HANDOFF_SETTLE_MS);
    this.handoffSettleTimer.unref?.();
  }

  /**
   * Runs once at startup. No update runs in a process that just started, so an
   * unfinished Gateway attempt or Relay Pool run in the database was
   * interrupted: report it and release what it holds.
   */
  async recoverInterruptedUpdates(): Promise<void> {
    await this.recoverOpfieldUpdateAttempt().catch((error) =>
      logger.error('Could not recover the Opfield update attempt', { error: formatError(error) })
    );
    await this.recoverInterruptedRelayPoolUpdates().catch((error) =>
      logger.error('Could not recover interrupted Relay Pool updates', { error: formatError(error) })
    );
    this.startHostMoveLauncher();
  }

  /**
   * An installation from before 2.12.1 moves to the Opfield layout (foundation/host-move.ts) after the update to this
   * release has settled: the earlier release's sidecar can no longer roll it back by then.
   */
  private startHostMoveLauncher(): void {
    if (this.hostMoveLauncher || this.env.NODE_ENV !== 'production') return;
    this.hostMoveLauncher = new HostMoveLauncher({
      db: this.db,
      docker: this.dockerService,
      env: this.env,
      updateBusy: async () =>
        this.opfieldUpdateInProgress ||
        (await this.isRelayUpdateRunning()) ||
        (await this.readOpfieldUpdateAttempt()) !== null,
      sidecarRunning: () => this.updateSidecarRunning(),
      quiesce: async () => {
        const source = this.orchestration;
        if (!source) return;
        source.setOrchestrationAdmissionHold(
          'Opfield is moving to its new directory and restarts in a minute. Start this operation again afterwards.'
        );
        await waitForOrchestrationIdle(source, { scope: 'all', deadline: 'auto' });
      },
      release: () => this.orchestration?.setOrchestrationAdmissionHold(null),
    });
    void this.hostMoveLauncher.check();
    this.hostMoveLauncher.start();
  }

  /** Whether a host move runs now (started by this process, by another one or by install.sh). */
  private async hostMoveRunning(): Promise<boolean> {
    if (this.hostMoveLauncher?.isMoving()) return true;
    try {
      const container = await this.dockerService.inspectContainerDetails(HOST_MOVE_CONTAINER_NAME);
      return container?.State.Running === true;
    } catch {
      return false;
    }
  }

  /** Whether this installation still has the layout of the releases before 2.12.1. */
  private async hostMoveNeeded(): Promise<boolean> {
    const self = await this.dockerService.inspectSelf();
    const labels = self.Config.Labels ?? {};
    const composeDir = this.env.COMPOSE_PROJECT_DIR || labels['com.docker.compose.project.working_dir'];
    const composeProject = labels['com.docker.compose.project'];
    if (!composeDir || !composeProject) return false;
    return hasLegacyLayout({ composeDir, composeProject, databaseUrl: this.env.DATABASE_URL });
  }

  /** Whether an update sidecar (of this release or an earlier one) still runs. */
  private async updateSidecarRunning(): Promise<boolean> {
    const containers = await this.dockerService.listLocalContainers();
    for (const item of containers) {
      if (item.State !== 'running') continue;
      const role = item.Labels?.[UPDATE_SIDECAR_LABEL];
      if (role !== undefined && FINISHED_CONTAINER_ROLES.includes(role)) return true;
      if (role === undefined && UNLABELLED_SIDECAR_IMAGE.test(item.Image)) return true;
    }
    return false;
  }

  private async readOpfieldUpdateAttempt(): Promise<OpfieldUpdateAttempt | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, OPFIELD_UPDATE_ATTEMPT_KEY)).limit(1);
    return parseOpfieldUpdateAttempt(row?.value);
  }

  private async recoverOpfieldUpdateAttempt(): Promise<void> {
    const attempt = await this.readOpfieldUpdateAttempt();
    // Keep the sidecar of the attempt still on record: its logs explain a rollback.
    void this.removeFinishedUpdateSidecars(attempt?.sidecarId ?? null);
    if (!attempt) {
      await this.deleteSettings([OPFIELD_UPDATE_ATTEMPT_KEY]);
      return;
    }
    const runningVersion = this.getCurrentVersion();
    if (normalizeVersionTag(runningVersion) === normalizeVersionTag(attempt.targetVersion)) {
      await this.markOpfieldUpdateTargetStarted(attempt);
      return;
    }
    if (!attempt.failedAt) {
      const container = attempt.sidecarId ? ` (docker logs ${attempt.sidecarId.slice(0, 12)})` : '';
      if (attempt.targetStartedAt) {
        if (normalizeVersionTag(runningVersion) !== normalizeVersionTag(attempt.fromVersion)) {
          // The target started and something other than the rollback replaced it since.
          await this.deleteSettings([OPFIELD_UPDATE_ATTEMPT_KEY]);
          return;
        }
        await this.reportFailedOpfieldUpdate(
          `Opfield ${attempt.targetVersion} started but did not become healthy, so the update was rolled back and Opfield ${runningVersion} is running again. Check the update container logs on the Opfield host${container}.`,
          attempt
        );
        return;
      }
      await this.reportFailedOpfieldUpdate(
        `Opfield ${attempt.targetVersion} did not start, so the update was rolled back and Opfield ${runningVersion} is running again. Check the update container logs on the Opfield host${container}.`,
        attempt
      );
      return;
    }
    this.restoreFailedOpfieldUpdateReport(attempt);
  }

  /**
   * The target version is running, but the sidecar can still roll it back until
   * it passes the health checks. Keep the record, marked as started, so the
   * version it rolls back to reports the rollback; clear it once the update had
   * time to settle.
   */
  private async markOpfieldUpdateTargetStarted(attempt: OpfieldUpdateAttempt): Promise<void> {
    const started: OpfieldUpdateAttempt = {
      ...attempt,
      failedAt: null,
      error: null,
      targetStartedAt: attempt.targetStartedAt ?? new Date().toISOString(),
    };
    await this.upsertSetting(OPFIELD_UPDATE_ATTEMPT_KEY, started);
    logger.info('Opfield update target started', { from: attempt.fromVersion, to: attempt.targetVersion });
    clearTimeout(this.targetGraceTimer);
    this.targetGraceTimer = setTimeout(() => {
      void this.db
        .delete(settings)
        .where(
          and(
            eq(settings.key, OPFIELD_UPDATE_ATTEMPT_KEY),
            // A newer attempt started from this process replaced the record: keep it.
            sql`${settings.value}->>'startedAt' = ${started.startedAt}`,
            sql`${settings.value}->>'targetVersion' = ${started.targetVersion}`
          )
        )
        .then(() => {
          logger.info('Opfield update completed', { from: started.fromVersion, to: started.targetVersion });
          return this.removeFinishedUpdateSidecars(null);
        })
        .catch((error) =>
          logger.warn('Could not clear the Opfield update attempt record', { error: formatError(error) })
        );
    }, OPFIELD_UPDATE_TARGET_GRACE_MS);
    this.targetGraceTimer.unref?.();
  }

  /** Persists, audits and reports a Gateway update that did not replace this version. */
  private async reportFailedOpfieldUpdate(error: string, known?: OpfieldUpdateAttempt): Promise<void> {
    const attempt = known ?? (await this.readOpfieldUpdateAttempt());
    const targetVersion = attempt?.targetVersion ?? this.opfieldUpdateOperation?.targetVersion;
    if (!targetVersion) return;
    const failed: OpfieldUpdateAttempt = {
      targetVersion,
      fromVersion: attempt?.fromVersion ?? this.getCurrentVersion(),
      startedAt: attempt?.startedAt ?? this.opfieldUpdateOperation?.startedAt ?? new Date().toISOString(),
      userId: attempt?.userId ?? null,
      sidecarId: attempt?.sidecarId ?? null,
      failedAt: new Date().toISOString(),
      error,
    };
    await this.upsertSetting(OPFIELD_UPDATE_ATTEMPT_KEY, failed);
    logger.error('Opfield update failed', {
      targetVersion,
      runningVersion: this.getCurrentVersion(),
      error,
    });
    await this.audit
      ?.log({
        userId: failed.userId,
        action: 'system.update.failed',
        resourceType: 'system-update',
        details: {
          targetVersion,
          fromVersion: failed.fromVersion,
          runningVersion: this.getCurrentVersion(),
          startedAt: failed.startedAt,
          sidecarId: failed.sidecarId,
          error,
        },
      })
      .catch(() => undefined);
    this.restoreFailedOpfieldUpdateReport(failed);
  }

  private restoreFailedOpfieldUpdateReport(attempt: OpfieldUpdateAttempt): void {
    const remaining = Date.parse(attempt.failedAt ?? '') + FAILED_OPFIELD_UPDATE_REPORT_MS - Date.now();
    if (!(remaining > 0)) {
      void this.deleteSettings([OPFIELD_UPDATE_ATTEMPT_KEY]).catch(() => undefined);
      return;
    }
    const operation: OpfieldUpdateOperation = {
      status: 'failed',
      targetVersion: attempt.targetVersion,
      startedAt: attempt.startedAt,
      waitDeadline: null,
      operations: [],
      error: attempt.error,
    };
    this.opfieldUpdateOperation = operation;
    clearTimeout(this.failedReportTimer);
    this.failedReportTimer = setTimeout(() => {
      if (this.opfieldUpdateOperation === operation) void this.acknowledgeOpfieldUpdateFailure();
    }, remaining);
    this.failedReportTimer.unref?.();
    // Sessions that still show the update screen leave it with this error.
    this.events?.publish('system.update.changed', {
      updating: false,
      component: 'opfield',
      targetVersion: attempt.targetVersion,
      error: attempt.error,
      rolledBack: true,
      statusChanged: true,
    });
  }

  /** An admin saw the failed update, or starts a new one: stop reporting it. */
  async acknowledgeOpfieldUpdateFailure(): Promise<boolean> {
    if (this.opfieldUpdateOperation?.status !== 'failed') return false;
    clearTimeout(this.failedReportTimer);
    this.opfieldUpdateOperation = null;
    await this.deleteSettings([OPFIELD_UPDATE_ATTEMPT_KEY]);
    void this.removeFinishedUpdateSidecars(null);
    // No `updating` flag: this must not end the update screen of a new attempt.
    this.events?.publish('system.update.changed', { component: 'opfield', statusChanged: true });
    return true;
  }

  /**
   * Removes update sidecars that have exited, except `keepId`. A sidecar is kept after it exits so a failed
   * update can point at its logs; once the update completed or its failure was acknowledged it is clutter (and
   * shows up in the container list when the Opfield host is also a Docker node). Sidecars started before they
   * were labelled are recognized by the pinned Docker CLI image plus the Docker socket and the Compose
   * directory mounted at the same path, so a user's own docker:cli containers are left alone.
   */
  private async removeFinishedUpdateSidecars(keepId: string | null): Promise<void> {
    try {
      const self = await this.dockerService.inspectSelf();
      const composeDir =
        this.env.COMPOSE_PROJECT_DIR || self.Config.Labels['com.docker.compose.project.working_dir'] || null;
      const containers = await this.dockerService.listLocalContainers();
      for (const item of containers) {
        if (item.State === 'running' || item.State === 'restarting' || item.Id === keepId) continue;
        const role = item.Labels?.[UPDATE_SIDECAR_LABEL];
        // The host move container stays until the move it ran is done: its logs explain a move that went back.
        if (role === HOST_MOVE_ROLE) {
          if (await this.hostMoveNeeded()) continue;
          await this.dockerService.removeContainer(item.Id).catch(() => undefined);
          continue;
        }
        const labelled = role !== undefined && FINISHED_CONTAINER_ROLES.includes(role);
        if (!labelled) {
          if (!composeDir) continue;
          const details = await this.dockerService.inspectContainerDetails(item.Id);
          if (!details || !UNLABELLED_SIDECAR_IMAGE.test(details.Config.Image)) continue;
          const mounts = details.Mounts ?? [];
          const socket = mounts.some(
            (mount) => mount.Source === '/var/run/docker.sock' && mount.Destination === '/var/run/docker.sock'
          );
          const compose = mounts.some((mount) => mount.Source === composeDir && mount.Destination === composeDir);
          if (!socket || !compose || mounts.length !== 2) continue;
        }
        await this.dockerService
          .removeContainer(item.Id)
          .then(() => logger.info('Removed a finished update container', { id: item.Id.slice(0, 12) }))
          .catch((error) =>
            logger.warn('Could not remove a finished update container', {
              id: item.Id.slice(0, 12),
              error: formatError(error),
            })
          );
      }
    } catch (error) {
      logger.warn('Could not clean up finished update containers', { error: formatError(error) });
    }
  }

  private setOpfieldUpdateOperation(operation: OpfieldUpdateOperation | null): void {
    if (operation) clearTimeout(this.failedReportTimer);
    this.opfieldUpdateOperation = operation;
    if (operation) {
      this.events?.publish('system.update.changed', {
        updating: true,
        component: 'opfield',
        targetVersion: operation.targetVersion,
        statusChanged: true,
      });
    }
  }

  /**
   * A restart interrupts blue/green deployments, drains, Availability and
   * Compose operations, build rollouts and Docker migrations. Hold new ones
   * and wait for those running, up to the longest announced operation deadline
   * (15 minutes by default) or until the operator chooses to update now.
   * Durable recovery resumes whatever still runs at the handoff.
   */
  private async waitForOrchestrationOperations(targetVersion: string): Promise<void> {
    const source = this.orchestration;
    if (!source) return;
    const held = source.setOrchestrationAdmissionHold(
      `Opfield is updating to ${targetVersion}. Start this operation again once the update has finished.`
    );
    const override = new AbortController();
    this.operationWaitOverride = override;
    const startedAt = this.opfieldUpdateOperation?.startedAt ?? new Date().toISOString();
    try {
      const result = await waitForOrchestrationIdle(source, {
        scope: 'all',
        deadline: 'auto',
        signal: override.signal,
        onProgress: (operations, deadline) =>
          this.setOpfieldUpdateOperation({
            status: 'waiting_for_operations',
            targetVersion,
            startedAt,
            waitDeadline: new Date(deadline).toISOString(),
            operations,
          }),
      });
      if (result.outcome === 'deadline' || result.outcome === 'override') {
        logger.warn('Opfield update proceeds while orchestration operations still run; recovery resumes them', {
          targetVersion,
          reason: result.outcome,
          operations: result.operations,
        });
      } else if (result.outcome === 'unsupported' || !held) {
        logger.info('Installed private core cannot report orchestration operations; the update does not wait', {
          targetVersion,
        });
      }
    } finally {
      this.operationWaitOverride = null;
      this.setOpfieldUpdateOperation({
        status: 'updating',
        targetVersion,
        startedAt,
        waitDeadline: null,
        operations: [],
      });
    }
  }

  private async performOpfieldUpdate(
    targetVersion: string,
    artifact: TrustedOpfieldUpdateArtifact,
    userId: string | null
  ): Promise<void> {
    logger.info('Starting self-update', { targetVersion });

    const selfInfo = await this.dockerService.inspectSelf();
    const labels = selfInfo.Config.Labels;

    const composeDir = this.env.COMPOSE_PROJECT_DIR || labels['com.docker.compose.project.working_dir'];
    const composeProject = labels['com.docker.compose.project'];

    if (!composeDir) throw new Error('Cannot determine compose project directory');
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(composeDir)) throw new Error(`Invalid compose directory path: ${composeDir}`);
    if (!composeProject) throw new Error('Cannot determine compose project name from container labels');
    if (!/^[a-zA-Z0-9_-]+$/.test(composeProject)) throw new Error(`Invalid compose project name: ${composeProject}`);

    const currentImage = selfInfo.Config.Image;
    const imageBase = imageRepositoryFromRef(currentImage);
    // The sidecar snapshots and restores the database the app uses: `gateway` before the host move, `opfield` after.
    const database = databaseIdentity(this.env.DATABASE_URL) ?? {
      role: LEGACY_DATABASE_ROLE,
      database: LEGACY_DATABASE,
    };
    if (!isSafeDatabaseIdentifier(database.role) || !isSafeDatabaseIdentifier(database.database)) {
      throw new Error(`Unsupported database role or name: ${database.role}/${database.database}`);
    }
    if (await this.hostMoveRunning()) {
      throw new AppError(
        409,
        'HOST_MOVE_IN_PROGRESS',
        'Opfield is moving to its new directory. Update once it has finished.'
      );
    }

    logger.info('Update context', {
      composeDir,
      composeProject,
      imageBase,
      targetVersion,
      imageRef: artifact.imageRef,
    });

    if (!parseSemver(targetVersion)) throw new Error(`Invalid version format: ${targetVersion}`);

    const tag = normalizeVersionTag(targetVersion);
    if (!this.opfieldImageRepositories(imageBase).includes(artifact.payload.image)) {
      throw new Error(`Signed update image ${artifact.payload.image} is not an allowed Opfield image repository`);
    }
    if (artifact.payload.version !== tag) {
      throw new Error(`Signed update version ${artifact.payload.version} does not match requested ${tag}`);
    }

    await this.dockerService.pullImageRef(artifact.imageRef);

    await this.dockerService.pullImageRef(DOCKER_COMPOSE_CLI_IMAGE_REF);

    // Before anything on the host changes: a restart during the wait keeps the current version.
    await this.waitForOrchestrationOperations(tag);

    // From here on a restart can leave the previous version running. The next
    // process reads this record and reports the attempt instead of hiding it.
    const attempt: OpfieldUpdateAttempt = {
      targetVersion: tag,
      fromVersion: this.getCurrentVersion(),
      startedAt: this.opfieldUpdateOperation?.startedAt ?? new Date().toISOString(),
      userId,
      sidecarId: null,
      failedAt: null,
      error: null,
    };
    await this.upsertSetting(OPFIELD_UPDATE_ATTEMPT_KEY, attempt);

    // The legacy settings migration below rewrites .env. Keep the untouched
    // files, so every rollback (here and in the sidecar) restores them.
    const backupDir = await this.backupFoundationFiles(composeDir);

    logger.info('Migrating legacy environment-owned settings');
    const settingsMigration = await this.dockerService.runOneShot({
      Image: artifact.imageRef,
      Cmd: ['node', 'dist/cli/migrate-legacy-settings.js', '/host'],
      Env: legacySettingsMigrationEnv(this.env),
      HostConfig: {
        Binds: [`${composeDir}:/host`],
        ...(selfInfo.HostConfig?.NetworkMode ? { NetworkMode: selfInfo.HostConfig.NetworkMode } : {}),
      },
    });
    if (settingsMigration.exitCode !== 0) {
      await this.restoreAfterFailedMigration(artifact.imageRef, composeDir, backupDir);
      throw new Error(`Legacy settings migration failed: ${settingsMigration.output}`);
    }

    logger.info('Running foundation migrations from target image', {
      composeDir,
      envTag: tag,
      imageRef: artifact.imageRef,
    });
    const foundationCommand = [
      'node',
      'dist/foundation-migrator.js',
      '--host-dir',
      '/host',
      '--target-version',
      tag,
      '--image-ref',
      artifact.imageRef,
      ...(artifact.secureLinkConnectorImage
        ? ['--secure-link-connector-image', artifact.secureLinkConnectorImage]
        : []),
    ];
    // Bounded Compose logging is added only when the host keeps Docker's json-file default.
    const dockerLogEnv = await this.foundationDockerLogEnv(selfInfo);
    const migrationResult = await this.dockerService.runOneShot({
      Image: artifact.imageRef,
      Cmd: foundationCommand,
      ...(dockerLogEnv.length > 0 ? { Env: dockerLogEnv } : {}),
      HostConfig: {
        Binds: [`${composeDir}:/host`, `${DEFAULT_SANDBOX_WORKSPACE_DIR}:${DEFAULT_SANDBOX_WORKSPACE_DIR}`],
      },
    });

    if (migrationResult.exitCode !== 0) {
      await this.restoreAfterFailedMigration(artifact.imageRef, composeDir, backupDir);
      throw new Error(`Foundation migration failed: ${migrationResult.output}`);
    }
    const migrationOutput = parseFoundationMigrationOutput(migrationResult.output);

    const workspaceResult = await this.prepareSandboxWorkspaceDir(
      artifact.imageRef,
      composeDir,
      backupDir,
      migrationOutput.sandboxWorkspaceDir
    );
    if (workspaceResult) throw workspaceResult;

    logger.info('Validating migrated docker-compose.yml');
    const composeConfigResult = await this.dockerService.runOneShot({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'docker',
        'compose',
        '--project-name',
        composeProject,
        '-f',
        '/project/docker-compose.yml',
        'config',
        '--quiet',
      ],
      HostConfig: { Binds: [`${composeDir}:/project`, '/var/run/docker.sock:/var/run/docker.sock'] },
    });

    if (composeConfigResult.exitCode !== 0) {
      const rollbackError = await this.rollbackFoundationMigration(artifact.imageRef, composeDir, backupDir).catch(
        (error) => error as Error
      );
      if (rollbackError) {
        throw new Error(
          `Migrated docker-compose.yml failed validation and rollback failed: ${composeConfigResult.output}; rollback: ${formatError(rollbackError)}`
        );
      }
      throw new Error(`Migrated docker-compose.yml failed validation: ${composeConfigResult.output}`);
    }

    logger.info('Foundation files migrated, launching compose sidecar');

    // The pre-update backup holds .env and docker-compose.yml as they were
    // before any migration, including the legacy settings removal.
    const sidecarBackupDir = backupDir.replace(/^\/host(?=\/)/, composeDir);
    const expectedBackupPrefix = `${composeDir}/${FOUNDATION_BACKUPS_DIR}/`;
    if (
      !sidecarBackupDir.startsWith(expectedBackupPrefix) ||
      !/^[a-zA-Z0-9_.-]+$/.test(sidecarBackupDir.slice(expectedBackupPrefix.length))
    ) {
      throw new Error(`Refusing to launch update with unexpected foundation backup path: ${sidecarBackupDir}`);
    }

    const sidecarId = await this.dockerService.runDetached({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'sh',
        '-c',
        `set -eu
compose() { docker compose --project-name ${composeProject} --project-directory ${composeDir} -f ${composeDir}/docker-compose.yml "$@"; }
service_exists() { compose config --services | grep -qx "$1"; }
ensure_foundation_services() {
  for service in $(compose config --services); do
    [ "$service" = app ] && continue
    compose up -d --no-recreate "$service"
  done
}
registry_ready() {
  if ! service_exists registry; then return 0; fi
  registry_id="$(compose ps -q registry)"
  [ -n "$registry_id" ] || return 1
  registry_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$registry_id")"
  [ "$registry_health" = healthy ]
}
relay_reachable() {
  compose exec -T app node -e 'const net=require("node:net");const socket=net.connect(9443,"relay",()=>{socket.end();process.exit(0)});socket.setTimeout(3000,()=>{socket.destroy();process.exit(1)});socket.on("error",()=>process.exit(1));'
}
${databaseSnapshotShell(composeDir, database)}
rollback() {
  if [ -n "$FOUNDATION_BACKUP_DIR" ]; then
    if [ -f "$FOUNDATION_BACKUP_DIR/.env" ]; then
      cp -p "$FOUNDATION_BACKUP_DIR/.env" ${composeDir}/.env
    fi
    if [ -f "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ]; then
      cp -p "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ${composeDir}/docker-compose.yml
    fi
  fi
  rollback_has_relay=0
  if service_exists relay; then rollback_has_relay=1; fi
  compose stop app
  compose up -d postgres
  attempt=0
  until compose exec -T postgres pg_isready -U ${database.role} -d ${database.database}; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 60 ]
    sleep 2
  done
  if [ "$db_snapshot_ready" -eq 1 ]; then
    # The target app may have migrated the schema: the previous app must not run on it.
    db_restore_status=0
    restore_database_snapshot || db_restore_status=$?
    if [ "$db_restore_status" -eq 0 ]; then
      rm -f "$OPFIELD_DB_DUMP" || true
      echo "Restored the Opfield database from the pre-update snapshot"
    elif [ "$db_restore_status" -eq 1 ]; then
      echo "The Opfield database was NOT restored and keeps the changes of the failed update. The pre-update snapshot is kept at $OPFIELD_DB_DUMP" >&2
    else
      echo "Restoring the Opfield database failed after the migrated database was dropped, so Opfield is left stopped. The pre-update snapshot is kept at $OPFIELD_DB_DUMP. Restore it by hand (see Updates in the operations guide), then run docker compose up -d" >&2
      return 1
    fi
  fi
  attempt=0
  until compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ${database.role} -d ${database.database} -c 'BEGIN; CREATE OR REPLACE VIEW "public"."gateway_relay_node_identities_v1" WITH (security_barrier = true) AS SELECT "id" AS "node_id", "type"::text AS "node_type", "status"::text AS "node_status", "certificate_serial" FROM "public"."nodes"; CREATE OR REPLACE VIEW "public"."gateway_relay_managed_databases_v1" WITH (security_barrier = true) AS SELECT "id" AS "managed_database_id", "node_id" AS "database_node_id", "status"::text AS "database_status" FROM "public"."managed_database_instances"; CREATE OR REPLACE VIEW "public"."gateway_relay_bindings_v1" WITH (security_barrier = true) AS SELECT binding."id" AS "binding_id", binding."managed_database_id", binding."target_node_id" AS "source_node_id", binding."status"::text AS "binding_status", managed."node_id" AS "database_node_id", managed."status"::text AS "database_status" FROM "public"."managed_database_bindings" binding INNER JOIN "public"."managed_database_instances" managed ON managed."id" = binding."managed_database_id"; COMMIT;'; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 10 ]
    sleep 2
  done
  ensure_foundation_services
  if [ "$rollback_has_relay" -eq 1 ]; then
    compose up -d --no-deps app
  else
    compose up -d app
  fi
  attempt=0
  while [ "$attempt" -lt 150 ]; do
    app_id="$(compose ps -q app)"
    if [ -n "$app_id" ]; then
      app_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id")"
      if [ "$rollback_has_relay" -eq 0 ] && [ "$app_health" = healthy ] && registry_ready; then return 0; fi
      if [ "$rollback_has_relay" -eq 1 ]; then
        relay_id="$(compose ps -q relay)"
        if [ -n "$relay_id" ]; then
          relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_id")"
          if [ "$app_health" = healthy ] && [ "$relay_health" = healthy ] && relay_reachable && registry_ready; then return 0; fi
        fi
      fi
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}
on_exit() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then rollback; fi
  # The update settled: the snapshot is not needed any more.
  if [ "$code" -eq 0 ]; then rm -f "$OPFIELD_DB_DUMP" || true; fi
  exit "$code"
}
trap on_exit EXIT
sleep 2
ensure_foundation_services
# Before the target app can apply its migrations. Nothing migrated yet if this fails.
snapshot_database || exit 1
if service_exists relay; then
  compose up -d --no-deps --force-recreate app
else
  compose up -d --force-recreate app
fi
attempt=0
while [ "$attempt" -lt 150 ]; do
  app_id="$(compose ps -q app)"
  relay_id="$(compose ps -q relay)"
  if [ -n "$app_id" ] && [ -n "$relay_id" ]; then
    app_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id")"
    relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_id")"
    if [ "$app_health" = healthy ] && [ "$relay_health" = healthy ]; then
      app_working_dir="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$app_id")"
      relay_working_dir="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$relay_id")"
      relay_networks="$(docker inspect --format '{{len .NetworkSettings.Networks}}' "$relay_id")"
      relay_public_port="$(docker port "$relay_id" 9443/tcp)"
      # Health states alone do not prove that Compose preserved ownership,
      # attached the relay network, published 9443, or connected app -> relay.
      if [ "$app_working_dir" = ${composeDir} ] && [ "$relay_working_dir" = ${composeDir} ] && [ "$relay_networks" -gt 0 ] && [ -n "$relay_public_port" ] && relay_reachable && registry_ready; then
        exit 0
      fi
    fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done
exit 1`,
      ],
      Env: [`FOUNDATION_BACKUP_DIR=${sidecarBackupDir}`],
      Labels: { [UPDATE_SIDECAR_LABEL]: UPDATE_SIDECAR_ROLE },
      HostConfig: { Binds: [`${composeDir}:${composeDir}`, '/var/run/docker.sock:/var/run/docker.sock'] },
    });

    logger.info('Update sidecar launched — container will be replaced shortly');
    // Lets a failure report point at the sidecar logs; the attempt is already recorded.
    await this.upsertSetting(OPFIELD_UPDATE_ATTEMPT_KEY, { ...attempt, sidecarId }).catch(() => undefined);
  }

  /** Host Docker logging defaults for the foundation migrator; empty when they cannot be read. */
  private async foundationDockerLogEnv(selfInfo: {
    HostConfig?: { LogConfig?: { Type?: string; Config?: Record<string, string> | null } };
  }): Promise<string[]> {
    try {
      const info = await this.dockerService.getDaemonInfo();
      return dockerLogDefaultsEnv(hostDockerLogDefaults(info.LoggingDriver, selfInfo.HostConfig?.LogConfig));
    } catch (error) {
      logger.warn('Docker logging defaults unknown; the update leaves Compose logging as it is', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Copies .env and docker-compose.yml into a new backup directory; returns it as seen under /host. */
  private async backupFoundationFiles(composeDir: string): Promise<string> {
    const name = `pre-update-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const backupDir = `/host/${FOUNDATION_BACKUPS_DIR}/${name}`;
    const result = await this.dockerService.runOneShot({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'sh',
        '-c',
        `set -eu
backup="$FOUNDATION_BACKUP_DIR"
mkdir -p "$backup"
chmod 700 "$backup"
[ ! -f /host/.env ] || cp -p /host/.env "$backup/.env"
[ ! -f /host/docker-compose.yml ] || cp -p /host/docker-compose.yml "$backup/docker-compose.yml"`,
      ],
      Env: [`FOUNDATION_BACKUP_DIR=${backupDir}`],
      HostConfig: { Binds: [`${composeDir}:/host`] },
    });
    if (result.exitCode !== 0) throw new Error(`Pre-update backup failed: ${result.output}`);
    return backupDir;
  }

  /** A failed migration may have rewritten .env already. Restore it, keep the original error. */
  private async restoreAfterFailedMigration(imageRef: string, composeDir: string, backupDir: string): Promise<void> {
    await this.rollbackFoundationMigration(imageRef, composeDir, backupDir).catch((error) =>
      logger.error('Could not restore the foundation files after a failed migration', {
        backupDir,
        error: formatError(error),
      })
    );
  }

  async performRelayUpdate(
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact,
    // An update Opfield starts on its own is a system action: audited without a user (N-26).
    userId: string | null = null
  ): Promise<void> {
    if (await this.hostMoveRunning()) {
      throw new AppError(
        409,
        'HOST_MOVE_IN_PROGRESS',
        'Opfield is moving to its new directory. Update once it has finished.'
      );
    }
    if (!this.relayPoolRuntime) {
      try {
        await this.performLocalRelayUpdate(targetVersion, artifact, true);
      } finally {
        this.localRelayUpdateCommitted = false;
      }
      return;
    }
    if (this.relayPoolRun) throw new AppError(409, 'UPDATE_IN_PROGRESS', 'A Relay Pool update is already in progress');
    const control = new AbortController();
    this.relayPoolRun = control;
    try {
      await this.performRelayPoolUpdate(this.relayPoolRuntime, targetVersion, artifact, userId, control.signal);
    } catch (error) {
      // A run that failed records it on its row; when that write failed as well (Postgres stopped meanwhile), the row
      // stays active and holds every other update until a restart. It is failed once the database answers.
      this.settleOrphanedRelayPoolRunsLater();
      throw error;
    } finally {
      if (this.relayPoolRun === control) this.relayPoolRun = null;
      this.localRelayUpdateCommitted = false;
    }
  }

  private settleOrphanedRelayPoolRunsLater(): void {
    const timer = setTimeout(() => {
      if (this.relayPoolRun) return;
      void this.failUnfinishedRelayPoolRuns(
        'The Relay Pool update stopped without recording its outcome because the database was unavailable. Start it again.'
      ).catch(() => this.settleOrphanedRelayPoolRunsLater());
    }, ORPHANED_RELAY_POOL_RUN_CHECK_MS);
    timer.unref?.();
  }

  private async performRelayPoolUpdate(
    runtime: RelayPoolUpdateRuntime,
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact,
    userId: string | null,
    signal: AbortSignal
  ): Promise<void> {
    const run = await this.ensureRelayPoolUpdateRun(targetVersion, artifact);
    let currentStepId: string | null = null;
    // Drained by this call and not resumed yet; released if the run is abandoned.
    let drainedInstanceId: string | null = null;
    const throwIfAbandoned = () => {
      if (signal.aborted) throw new RelayPoolUpdateAbandonedError();
    };
    try {
      await this.db
        .update(relayPoolUpdateRuns)
        .set({ state: 'updating', terminalError: null, updatedAt: new Date() })
        .where(eq(relayPoolUpdateRuns.id, run.id));
      const steps = await this.db
        .select()
        .from(relayPoolUpdateSteps)
        .where(eq(relayPoolUpdateSteps.runId, run.id))
        .orderBy(relayPoolUpdateSteps.sequence);
      for (const step of steps.filter(({ state }) => !['ready', 'rolled_back'].includes(state))) {
        throwIfAbandoned();
        currentStepId = step.id;
        const [instance] = await this.db
          .select()
          .from(relayInstances)
          .where(eq(relayInstances.id, step.relayInstanceId))
          .limit(1);
        if (!instance) throw new Error(`Relay instance ${step.relayInstanceId} is unavailable`);
        // What the daemons' streams did while this relay drained, for the step note: only the streams through it count.
        const streamCounters = this.streamCounters(runtime);
        const carriedStreams = relaySessionSplit(runtime.relayStreamReports?.() ?? [], instance.id).resumable;
        let legacyCut = 0;
        let drainGraceMs = RELAY_UPDATE_DRAIN_GRACE_MS;
        if (instance.kind === 'local') {
          // A retried run finds the local relay already on the target image.
          let interruption: string | null = null;
          let pausesStreams = false;
          let pausedMs = 0;
          if (!artifact.imageRef || this.env.OPFIELD_RELAY_IMAGE_REF !== artifact.imageRef) {
            await runtime.awaitLeasePeers?.(instance.id, signal);
            throwIfAbandoned();
            // While another relay can carry its workloads, the local relay is drained like a remote one, so its
            // sessions move instead of dropping when its container is recreated. Otherwise they drop once.
            interruption = await this.localRelayTakeoverBlocker(runtime, instance.id);
            if (!interruption) {
              // The relay updated before it must carry the local relay's workloads, not the one left over.
              await runtime.settlePlacement?.(signal);
              throwIfAbandoned();
              drainGraceMs = await this.updateDrainGraceMs(runtime, instance.id);
              await this.updatePoolStep(step.id, 'draining', false, new Date(Date.now() + drainGraceMs));
              drainedInstanceId = instance.id;
              interruption = await this.drainLocalRelay(runtime, instance.id, userId, signal);
              if (interruption) drainedInstanceId = null;
              else {
                // The internal registry stays on the local relay, which keeps serving it through the drain.
                const kept = await localServiceEndpointIds(this.db);
                legacyCut = await this.waitForUpdateDrain(runtime, instance, userId, signal, drainGraceMs, kept);
              }
              throwIfAbandoned();
            }
            // Without another relay, resumable streams pause while the relay is recreated and resume on it.
            pausesStreams =
              Boolean(interruption) &&
              Boolean(runtime.relayStreamReports) &&
              (await this.updateDrainGraceMs(runtime, instance.id)) === RESUMABLE_DRAIN_GRACE_MS;
            await this.updatePoolStep(step.id, 'updating');
            const restartedAt = Date.now();
            // From the point the local relay update commits, abandoning is refused: the pool ends on the target (or the
            // relay rolls back), and the run records that outcome rather than a failure (abandonRelayUpdate).
            await this.performLocalRelayUpdate(targetVersion, artifact, false, signal);
            pausedMs = Date.now() - restartedAt;
            if (drainedInstanceId) {
              await this.updatePoolStep(step.id, 'verifying');
              await this.waitForRelayInstanceVersion(instance.id, artifact.buildVersion, signal);
            }
            await runtime.awaitLeaseSettled?.(instance.id, restartedAt, signal);
            if (drainedInstanceId) {
              await runtime.drainInstance(instance.id, userId, false);
              drainedInstanceId = null;
            }
            if (interruption) {
              // Expected with the local relay as the only relay, and on the first update of a local relay that cannot
              // drain: the step's note tells it. A pool whose other relays could not take over is worth a warning.
              const expected = steps.length === 1 || interruption === LOCAL_RELAY_DRAIN_UNSUPPORTED;
              if (expected)
                logger.info('Sessions through the local relay were interrupted by its update', { interruption });
              else logger.warn('Sessions through the local relay were interrupted by its update', { interruption });
            }
          }
          // Recorded on the step: no other relay could carry the local relay's sessions, so they dropped once (or, all
          // of them resumable, paused). Otherwise what moved and what was cut.
          const outcome = this.streamOutcomeSince(runtime, streamCounters, carriedStreams);
          const note = interruption
            ? pausesStreams
              ? localRelayPauseNote(pausedMs, outcome ?? { moved: 0, cut: 0 }, interruption)
              : `Sessions through the local relay were interrupted once while it was recreated: ${interruption}.`
            : outcome
              ? drainOutcomeNote(outcome, legacyCut)
              : null;
          await this.updatePoolStep(step.id, 'ready', true, undefined, note);
          currentStepId = null;
          continue;
        }
        if (!instance.nodeId) throw new Error(`Relay instance ${instance.id} is not enrolled`);
        // A retried run must not drain again a relay whose worker and supervisor already run the
        // target: that only takes it out of service for the drain window.
        if (await this.isRemoteRelayAt(instance, normalizeVersionTag(targetVersion))) {
          await this.updatePoolStep(step.id, 'ready', true);
          currentStepId = null;
          continue;
        }
        // A member that is not connected (its host is down) does not hold the pool's update: it is skipped and
        // updated by the next run once it reconnects. Nothing of it can be drained or verified meanwhile.
        if (runtime.isRelayConnected && !runtime.isRelayConnected(instance.nodeId)) {
          await this.skipPoolStep(step.id);
          currentStepId = null;
          continue;
        }
        // A voter or candidate of the relay's lease policies that is restarting or settling goes first.
        await runtime.awaitLeasePeers?.(instance.id, signal);
        throwIfAbandoned();
        // Placement including the relay updated before goes first (settlePlacement).
        await runtime.settlePlacement?.(signal);
        throwIfAbandoned();
        drainGraceMs = await this.updateDrainGraceMs(runtime, instance.id);
        await this.updatePoolStep(step.id, 'draining', false, new Date(Date.now() + drainGraceMs));
        drainedInstanceId = instance.id;
        try {
          await runtime.drainInstance(instance.id, userId, true);
        } catch (error) {
          // Disconnected since the check: the drain was refused before it took the relay out of service.
          if (!(error instanceof AppError && error.code === 'RELAY_NOT_CONNECTED')) throw error;
          drainedInstanceId = null;
          await this.skipPoolStep(step.id);
          currentStepId = null;
          continue;
        }
        legacyCut = await this.waitForUpdateDrain(runtime, instance, userId, signal, drainGraceMs);
        throwIfAbandoned();
        await this.updatePoolStep(step.id, 'updating');
        const architecture = this.relayInstanceArchitecture(instance);
        const normalizedVersion = normalizeVersionTag(targetVersion);
        const restartedAt = Date.now();
        // The supervisor goes first, so the worker update runs on the target supervisor: one before v2.11.1 could
        // restart the previous worker binary while it downloaded the new one. A retried run whose supervisor
        // already runs the target goes straight on to the worker.
        // A failed update command (a protected relay refuses an older release) ends the wait at once: the step and
        // the run fail with the daemon's reason and the relay is resumed, instead of waiting for a reconnect.
        let supervisorFailed: Promise<string> | undefined;
        if (!(await this.isRelaySupervisorAt(instance.nodeId, normalizedVersion))) {
          const supervisorArtifact = await runtime.prepareSupervisorUpdate(normalizedVersion, architecture);
          supervisorFailed = (await runtime.dispatchSupervisorUpdate(instance.nodeId, supervisorArtifact))?.failed;
          await this.waitForRelaySupervisorVersion(instance.nodeId, normalizedVersion, signal, supervisorFailed);
          throwIfAbandoned();
        }
        const workerArtifact = await runtime.prepareWorkerUpdate(normalizedVersion, architecture);
        await this.dispatchRelayWorkerUpdate(runtime, instance.nodeId, workerArtifact, normalizedVersion, signal);
        await this.updatePoolStep(step.id, 'verifying');
        await Promise.all([
          this.waitForRelayInstanceVersion(instance.id, normalizedVersion, signal),
          this.waitForRelaySupervisorVersion(instance.nodeId, normalizedVersion, signal, supervisorFailed),
        ]);
        // The step stays active (so daemon updates of the relay's lease peers wait) until the relay votes again.
        await runtime.awaitLeaseSettled?.(instance.id, restartedAt, signal);
        await runtime.drainInstance(instance.id, userId, false);
        drainedInstanceId = null;
        const outcome = this.streamOutcomeSince(runtime, streamCounters, carriedStreams);
        const note = outcome ? drainOutcomeNote(outcome, legacyCut) : null;
        if (note) await this.updatePoolStep(step.id, 'ready', true, undefined, note);
        else await this.updatePoolStep(step.id, 'ready', true);
        currentStepId = null;
      }
      throwIfAbandoned();
      // The last relay updated (usually the local one) takes its workloads back now, not after automatic placement.
      await runtime.settlePlacement?.(signal);
      await this.promoteRelayConnectorImages(artifact);
      // An abandoned or recovered run stays failed.
      await this.db
        .update(relayPoolUpdateRuns)
        .set({ state: 'complete', completedAt: new Date(), terminalError: null, updatedAt: new Date() })
        .where(and(eq(relayPoolUpdateRuns.id, run.id), eq(relayPoolUpdateRuns.state, 'updating')));
    } catch (error) {
      const message = formatError(error);
      let currentState: string | undefined;
      try {
        const [current] = await this.db
          .select({ state: relayPoolUpdateRuns.state })
          .from(relayPoolUpdateRuns)
          .where(eq(relayPoolUpdateRuns.id, run.id))
          .limit(1);
        currentState = current?.state;
        if (currentState !== 'paused' && currentState !== 'failed') {
          if (currentStepId) {
            await this.db
              .update(relayPoolUpdateSteps)
              .set({ state: 'failed', error: message, completedAt: new Date(), updatedAt: new Date() })
              .where(eq(relayPoolUpdateSteps.id, currentStepId));
          }
          await this.db
            .update(relayPoolUpdateRuns)
            .set({ state: 'failed', terminalError: message, updatedAt: new Date() })
            .where(eq(relayPoolUpdateRuns.id, run.id));
        }
      } finally {
        // A failed run (verify timeout, dispatch error, abandon) gives back the drain it took, as
        // restart recovery does; operator drains stay. A paused run keeps draining toward a resume.
        // Abandoning released the drains it knew about; an aborted run's drain may have begun
        // meanwhile. The release runs even when recording the failure did not.
        if (drainedInstanceId && (signal.aborted || currentState !== 'paused')) {
          this.scheduleRelayDrainRelease([drainedInstanceId], userId);
        }
      }
      throw error;
    }
  }

  /**
   * Long-lived streams (a database pool, a WebSocket) may never end on their own. After the grace they are
   * disconnected, as a manual drain does after its own, and the update goes on: the restart would end them anyway,
   * and a run that waited for an operator kept the relay out of the pool meanwhile. `kept`: endpoints whose tunnels
   * the relay keeps admitting through the drain, which need not end.
   */
  private async waitForUpdateDrain(
    runtime: RelayPoolUpdateRuntime,
    instance: typeof relayInstances.$inferSelect,
    userId: string | null,
    signal: AbortSignal,
    graceMs: number,
    kept?: ReadonlySet<string>
  ): Promise<number> {
    if (await this.waitForRelayInstanceDrain(instance.id, graceMs, signal, kept)) return 0;
    logger.warn('Relay drain grace ended with active streams; disconnecting them to continue the update', {
      relayInstanceId: instance.id,
      relay: instance.displayName,
    });
    // Raw streams still on the relay are cut by the disconnect; resumable ones move to another relay.
    const legacyCut = this.legacyStreams(runtime, instance.id);
    await runtime.forceDisconnectInstance(instance.id, userId);
    const settled = await this.waitForRelayInstanceDrain(
      instance.id,
      RELAY_UPDATE_FORCED_DRAIN_SETTLE_MS,
      signal,
      kept
    );
    if (!settled) {
      logger.warn('Relay still reports streams after the forced disconnect; its update ends them', {
        relayInstanceId: instance.id,
      });
    }
    return legacyCut;
  }

  /** How long an update gives this relay's streams to leave: short when every one of them can move by itself. */
  private updateDrainGraceMs(runtime: RelayPoolUpdateRuntime, instanceId: string): Promise<number> {
    return relayDrainGraceMs(this.db, instanceId, 'update', this.legacyStreams(runtime, instanceId));
  }

  /** Raw streams the daemons report through this relay. */
  private legacyStreams(runtime: RelayPoolUpdateRuntime, instanceId: string): number {
    return relaySessionSplit(runtime.relayStreamReports?.() ?? [], instanceId).legacy;
  }

  /** Null when no daemon reports relay streams: the step then gets no note, as before. */
  private streamCounters(runtime: RelayPoolUpdateRuntime): RelayStreamCounters | null {
    const reports = runtime.relayStreamReports?.() ?? [];
    return reports.length ? relayStreamCounters(reports) : null;
  }

  /** What the streams through a relay (`carried` resumable ones when its drain began) did since `before`. */
  private streamOutcomeSince(
    runtime: RelayPoolUpdateRuntime,
    before: RelayStreamCounters | null,
    carried: number
  ): { moved: number; cut: number } | null {
    if (!before) return null;
    return relayDrainOutcome(
      relayStreamOutcome(before, relayStreamCounters(runtime.relayStreamReports?.() ?? [])),
      carried
    );
  }

  private async localRelayTakeoverBlocker(runtime: RelayPoolUpdateRuntime, instanceId: string): Promise<string | null> {
    if (!runtime.localRelayTakeoverBlocker) return 'no other relay was available to take its workloads over';
    try {
      return await runtime.localRelayTakeoverBlocker(instanceId);
    } catch (error) {
      return `whether another relay could take its workloads over was not known (${formatError(error)})`;
    }
  }

  /**
   * Drains the local relay and waits until its workloads moved to other relays. Returns why its sessions are
   * interrupted instead: it refused the drain, or a workload could not move (it is resumed then, so that workload's
   * new sessions are not refused through the whole drain).
   */
  private async drainLocalRelay(
    runtime: RelayPoolUpdateRuntime,
    instanceId: string,
    userId: string | null,
    signal: AbortSignal
  ): Promise<string | null> {
    try {
      await runtime.drainInstance(instanceId, userId, true);
    } catch (error) {
      return `the local relay did not accept the drain (${formatError(error)})`;
    }
    const abandoned = () => {
      if (signal.aborted) throw new RelayPoolUpdateAbandonedError();
    };
    if (await waitForLocalRelayEvacuation(this.db, instanceId, LOCAL_RELAY_EVACUATION_TIMEOUT_MS, abandoned)) {
      return null;
    }
    await runtime.drainInstance(instanceId, userId, false);
    return 'its workloads could not be moved to another relay in time';
  }

  private async performLocalRelayUpdate(
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact,
    promoteConnectors: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    const version = normalizeVersionTag(targetVersion);
    const selfInfo = await this.dockerService.inspectSelf();
    const labels = selfInfo.Config.Labels;
    const composeDir = this.env.COMPOSE_PROJECT_DIR || labels['com.docker.compose.project.working_dir'];
    const composeProject = labels['com.docker.compose.project'];
    if (!composeDir || !/^\/[a-zA-Z0-9/_.-]+$/.test(composeDir)) throw new Error('Invalid Compose directory');
    if (!composeProject || !/^[a-zA-Z0-9_-]+$/.test(composeProject)) throw new Error('Invalid Compose project');
    const relayImageRepositories = this.opfieldImageRepositories(imageRepositoryFromRef(selfInfo.Config.Image)).map(
      (opfieldImage) => `${opfieldImage}/relay`
    );
    if (artifact.payload.version !== version || !relayImageRepositories.includes(artifact.payload.image)) {
      throw new Error('Signed relay artifact does not match the requested release');
    }

    await this.dockerService.pullImageRef(artifact.imageRef);
    await this.dockerService.pullImageRef(DOCKER_COMPOSE_CLI_IMAGE_REF);
    // The migration rewrites the installation and the relay is recreated on it: from here the update finishes or
    // rolls back, and abandoning it is refused. Checked and set together, so an abandon either came first or is refused.
    if (signal?.aborted) throw new RelayPoolUpdateAbandonedError();
    this.localRelayUpdateCommitted = true;
    const migrationResult = await this.dockerService.runOneShot({
      Image: selfInfo.Config.Image,
      Cmd: [
        'node',
        'dist/foundation-migrator.js',
        '--host-dir',
        '/host',
        '--relay-build-version',
        artifact.buildVersion,
        '--relay-protocol-major',
        String(artifact.protocolMajor),
        '--relay-image-ref',
        artifact.imageRef,
        '--secure-link-connector-image',
        artifact.secureLinkConnectorImage,
      ],
      HostConfig: { Binds: [`${composeDir}:/host`] },
    });
    if (migrationResult.exitCode !== 0) throw new Error(`Relay foundation migration failed: ${migrationResult.output}`);
    const migrationOutput = parseFoundationMigrationOutput(migrationResult.output);

    const configResult = await this.dockerService.runOneShot({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'docker',
        'compose',
        '--project-name',
        composeProject,
        '-f',
        '/project/docker-compose.yml',
        'config',
        '--quiet',
      ],
      HostConfig: { Binds: [`${composeDir}:/project`, '/var/run/docker.sock:/var/run/docker.sock'] },
    });
    if (configResult.exitCode !== 0) {
      await this.rollbackFoundationMigration(selfInfo.Config.Image, composeDir, migrationOutput.backupDir);
      throw new Error(`Migrated docker-compose.yml failed validation: ${configResult.output}`);
    }

    if (migrationOutput.backupDir && !migrationOutput.backupDir.startsWith(`/host/${FOUNDATION_BACKUPS_DIR}/`)) {
      throw new Error(`Refusing to use unexpected relay foundation backup path: ${migrationOutput.backupDir}`);
    }
    const backupDir = migrationOutput.backupDir?.replace(/^\/host(?=\/)/, composeDir) ?? '';
    const stopTimeoutSeconds = relayRecreateStopTimeoutSeconds(this.env.OPFIELD_RELAY_BUILD_VERSION);
    await this.relayRuntime?.setMaintenance(true);
    try {
      const result = await this.dockerService.runOneShot({
        Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
        Cmd: [
          'sh',
          '-c',
          `set -eu
compose() { docker compose --project-name ${composeProject} --project-directory ${composeDir} -f ${composeDir}/docker-compose.yml "$@"; }
relay_reachable() {
  compose exec -T app node -e 'const net=require("node:net");const socket=net.connect(9443,"relay",()=>{socket.end();process.exit(0)});socket.setTimeout(3000,()=>{socket.destroy();process.exit(1)});socket.on("error",()=>process.exit(1));'
}
rollback() {
  if [ -n "$FOUNDATION_BACKUP_DIR" ]; then
    [ ! -f "$FOUNDATION_BACKUP_DIR/.env" ] || cp -p "$FOUNDATION_BACKUP_DIR/.env" ${composeDir}/.env
    [ ! -f "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ] || cp -p "$FOUNDATION_BACKUP_DIR/docker-compose.yml" ${composeDir}/docker-compose.yml
  fi
  compose up -d --no-deps --force-recreate relay
}
on_exit() { code=$?; trap - EXIT; if [ "$code" -ne 0 ]; then rollback; fi; exit "$code"; }
trap on_exit EXIT
compose up -d --no-deps --force-recreate --timeout ${stopTimeoutSeconds} relay
attempt=0
while [ "$attempt" -lt 90 ]; do
  relay_id="$(compose ps -q relay)"
  if [ -n "$relay_id" ]; then
    relay_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_id")"
    if [ "$relay_health" = healthy ] && relay_reachable; then exit 0; fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done
exit 1`,
        ],
        Env: [`FOUNDATION_BACKUP_DIR=${backupDir}`],
        HostConfig: { Binds: [`${composeDir}:${composeDir}`, '/var/run/docker.sock:/var/run/docker.sock'] },
      });
      if (result.exitCode !== 0) throw new Error(`Relay update failed and was rolled back: ${result.output}`);

      Object.assign(this.env, {
        OPFIELD_RELAY_IMAGE_REF: artifact.imageRef,
        OPFIELD_RELAY_BUILD_VERSION: artifact.buildVersion,
        OPFIELD_RELAY_PROTOCOL_MAJOR: artifact.protocolMajor,
      });
      this.relayRuntime?.setExpectedArtifact(artifact.imageRef, artifact.buildVersion, artifact.protocolMajor);
      await saveInstalledRelayArtifact(this.db, {
        imageRef: artifact.imageRef,
        buildVersion: artifact.buildVersion,
        protocolMajor: artifact.protocolMajor,
        secureLinkConnectorImage: artifact.secureLinkConnectorImage,
      }).catch((error) => {
        logger.error('Failed to persist the installed Relay artifact after a successful update', { error });
      });
      if (promoteConnectors) await this.promoteRelayConnectorImages(artifact);
    } finally {
      await this.relayRuntime?.setMaintenance(false);
    }
    await this.relayRuntime?.probeNow();
  }

  private async promoteRelayConnectorImages(artifact: TrustedRelayUpdateArtifact): Promise<void> {
    Object.assign(this.env, {
      SECURE_LINK_CONNECTOR_IMAGE: artifact.secureLinkConnectorImage,
    });
    await this.relayRuntime?.updateSecureLinkConnectorImage(artifact.secureLinkConnectorImage);
  }

  private async ensureRelayPoolUpdateRun(targetVersion: string, artifact: TrustedRelayUpdateArtifact) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-pool-rebalance'))`);
      return this.ensureRelayPoolUpdateRunLocked(tx, targetVersion, artifact);
    });
  }

  private async ensureRelayPoolUpdateRunLocked(
    tx: DrizzleTransaction,
    targetVersion: string,
    artifact: TrustedRelayUpdateArtifact
  ) {
    const [existing] = await tx
      .select()
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [
            'preflight',
            'draining',
            'updating',
            'verifying',
            'paused',
            'rolling_back',
          ])
        )
      )
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    if (existing) {
      if (existing.targetArtifact.version !== normalizeVersionTag(targetVersion)) {
        throw new AppError(
          409,
          'UPDATE_IN_PROGRESS',
          `The Relay Pool update to ${existing.targetArtifact.version} has not finished. Retry or abandon it before updating to ${normalizeVersionTag(targetVersion)}.`
        );
      }
      return existing;
    }
    const instances = await tx
      .select()
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining', 'offline', 'error'])
        )
      );
    if (!instances.length) throw new Error('Relay Pool has no instances');
    const readyFaultDomains = new Set(
      instances.filter(({ state }) => state === 'ready').map(({ faultDomainId }) => faultDomainId)
    );
    // A member that is offline is skipped by the run, so it neither needs nor provides capacity for the others.
    const live = instances.filter(({ state }) => state !== 'offline');
    if (live.length > 1 && readyFaultDomains.size < 2) {
      throw new AppError(409, 'RELAY_UPDATE_CAPACITY_UNAVAILABLE', 'Two ready relay fault domains are required');
    }
    const [run] = await tx
      .insert(relayPoolUpdateRuns)
      .values({
        poolId: 'system',
        state: 'preflight',
        targetArtifact: {
          version: normalizeVersionTag(targetVersion),
          digest: artifact.digest,
          image: artifact.imageRef,
        },
        compatibility: { protocolMajor: artifact.protocolMajor, maxUnavailable: 1, parallelism: 1 },
      })
      .returning();
    const ordered = [...instances].sort(
      (left, right) => Number(left.kind === 'local') - Number(right.kind === 'local')
    );
    await tx.insert(relayPoolUpdateSteps).values(
      ordered.map((instance, sequence) => ({
        runId: run.id,
        relayInstanceId: instance.id,
        sequence,
        previousArtifact: instance.buildVersion
          ? { version: instance.buildVersion, digest: '', architecture: this.relayInstanceArchitecture(instance) }
          : null,
        targetArtifact: {
          version: normalizeVersionTag(targetVersion),
          digest: artifact.digest,
          image: artifact.imageRef,
          architecture: this.relayInstanceArchitecture(instance),
        },
      }))
    );
    return run;
  }

  /**
   * A connected remote relay runs an older release than the latest one: a member an earlier run skipped while it was
   * offline. The update is offered again for it (the local relay and members on the target are left as they are).
   */
  private async remoteRelayBehind(latestRelayVersion: string): Promise<boolean> {
    let rows: Array<{ state: string; buildVersion: string | null }>;
    try {
      rows = await this.db
        .select({ state: relayInstances.state, buildVersion: relayInstances.buildVersion })
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'remote')));
    } catch {
      return false;
    }
    return rows.some(
      ({ state, buildVersion }) =>
        state !== 'offline' && Boolean(buildVersion) && isNewerVersion(latestRelayVersion, buildVersion!)
    );
  }

  /** A member skipped because it is not connected; the run completes without it and a later run updates it. */
  private async skipPoolStep(stepId: string): Promise<void> {
    logger.warn('Relay Pool update skips a relay that is not connected', { stepId });
    await this.db
      .update(relayPoolUpdateSteps)
      .set({
        state: 'skipped',
        completedAt: new Date(),
        error: RELAY_UPDATE_SKIPPED_OFFLINE,
        updatedAt: new Date(),
      })
      .where(eq(relayPoolUpdateSteps.id, stepId));
  }

  /** `note`: what the step could not avoid, such as interrupted sessions, kept on a step that completed. */
  private async updatePoolStep(
    stepId: string,
    state: 'draining' | 'updating' | 'verifying' | 'ready',
    completed = false,
    drainDeadlineAt?: Date,
    note?: string | null
  ): Promise<void> {
    await this.db
      .update(relayPoolUpdateSteps)
      .set({
        state,
        startedAt: new Date(),
        ...(drainDeadlineAt ? { drainDeadlineAt } : {}),
        ...(completed ? { completedAt: new Date() } : {}),
        error: note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(relayPoolUpdateSteps.id, stepId));
  }

  private async isRemoteRelayAt(instance: typeof relayInstances.$inferSelect, version: string): Promise<boolean> {
    if (!instance.nodeId || instance.buildVersion !== version) return false;
    return this.isRelaySupervisorAt(instance.nodeId, version);
  }

  private async isRelaySupervisorAt(nodeId: string, version: string): Promise<boolean> {
    const [node] = await this.db
      .select({ status: nodes.status, daemonVersion: nodes.daemonVersion })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    return node?.status === 'online' && node.daemonVersion === version;
  }

  /** Dispatches a relay worker update, again (bounded) while it reports the previous worker still running. */
  private async dispatchRelayWorkerUpdate(
    runtime: RelayPoolUpdateRuntime,
    nodeId: string,
    artifact: TrustedDaemonUpdateArtifact,
    version: string,
    signal: AbortSignal
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await runtime.dispatchWorkerUpdate(nodeId, artifact);
        return;
      } catch (error) {
        if (attempt >= RELAY_WORKER_STALE_VERSION_RETRIES || !isStaleRelayWorkerVersionError(error, version)) {
          throw error;
        }
        if (signal.aborted) throw new RelayPoolUpdateAbandonedError();
        logger.warn('Relay worker still runs the previous version after its update; dispatching it again', {
          nodeId,
          targetVersion: version,
          attempt: attempt + 1,
          error: formatError(error),
        });
      }
    }
  }

  private relayInstanceArchitecture(instance: typeof relayInstances.$inferSelect): string {
    return instance.capabilities?.architecture || 'amd64';
  }

  /** `keptEndpointIds`: endpoints whose tunnels the draining relay keeps admitting, which do not have to end. */
  private async waitForRelayInstanceDrain(
    instanceId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    keptEndpointIds?: ReadonlySet<string>
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RelayPoolUpdateAbandonedError();
      const [instance] = await this.db
        .select({ health: relayInstances.health })
        .from(relayInstances)
        .where(eq(relayInstances.id, instanceId))
        .limit(1);
      if (!instance) throw new Error(`Relay instance ${instanceId} disappeared while draining`);
      if (drainingTunnels(instance.health, keptEndpointIds) === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
  }

  private async waitForRelayInstanceVersion(
    instanceId: string,
    targetVersion: string,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RelayPoolUpdateAbandonedError();
      const [instance] = await this.db
        .select({
          state: relayInstances.state,
          buildVersion: relayInstances.buildVersion,
          lastSeenAt: relayInstances.lastSeenAt,
        })
        .from(relayInstances)
        .where(eq(relayInstances.id, instanceId))
        .limit(1);
      if (instance?.state === 'ready' && instance.buildVersion === targetVersion && instance.lastSeenAt) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Relay instance ${instanceId} did not become ready after update`);
  }

  /** `failed`: the dispatched update command's failure (DispatchedUpdate), which ends the wait with its reason. */
  private async waitForRelaySupervisorVersion(
    nodeId: string,
    targetVersion: string,
    signal?: AbortSignal,
    failed?: Promise<string>
  ): Promise<void> {
    const outcome: { refusal: string | null } = { refusal: null };
    void failed?.then((reason) => {
      outcome.refusal = reason;
    });
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RelayPoolUpdateAbandonedError();
      if (outcome.refusal !== null) throw new Error(outcome.refusal);
      const [node] = await this.db
        .select({ status: nodes.status, daemonVersion: nodes.daemonVersion, lastSeenAt: nodes.lastSeenAt })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      if (node?.status === 'online' && node.daemonVersion === targetVersion && node.lastSeenAt) return;
      if (outcome.refusal !== null) throw new Error(outcome.refusal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2_000);
        }),
        ...(failed ? [failed] : []),
      ]);
      clearTimeout(timer);
    }
    if (outcome.refusal !== null) throw new Error(outcome.refusal);
    throw new Error(`Relay supervisor node ${nodeId} did not reconnect after update`);
  }

  /**
   * The operator's way out of a stuck or paused Relay Pool update: fail the
   * run, stop the rollout this process drives, and put drained relays back
   * into service. Relays drained by an operator stay drained.
   */
  async abandonRelayUpdate(userId: string): Promise<{ targetVersion: string | null }> {
    const [run] = await this.db
      .select()
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [...UNFINISHED_RELAY_POOL_RUN_STATES])
        )
      )
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    const operation = this.relayUpdateOperation;
    if (!run && operation?.status !== 'updating' && !this.relayPoolRun) {
      throw new AppError(409, 'RELAY_UPDATE_NOT_ACTIVE', 'No Relay Pool update is in progress');
    }
    // A remote relay's step can be left: a later run picks up where the relays are. The local relay goes last and its
    // update cannot be stopped once it began; abandoning then would record a failure for a pool that ends updated.
    if (this.localRelayUpdateCommitted) {
      throw new AppError(
        409,
        'RELAY_UPDATE_COMMITTED',
        'The local relay is being updated, which is the last step and cannot be stopped. The update finishes, or rolls back if it fails, within a few minutes.'
      );
    }
    const message = 'Abandoned by an administrator';
    this.relayPoolRun?.abort();
    const drained = run ? await this.failRelayPoolRun(run.id, message, UNFINISHED_RELAY_POOL_RUN_STATES) : [];
    if (operation?.status === 'updating')
      this.relayUpdateOperation = { ...operation, status: 'failed', error: message };
    if (drained.length) this.scheduleRelayDrainRelease(drained, userId);
    logger.warn('Relay Pool update abandoned', { runId: run?.id, userId, drainedInstances: drained });
    return { targetVersion: run?.targetArtifact.version ?? operation?.targetVersion ?? null };
  }

  private async recoverInterruptedRelayPoolUpdates(): Promise<void> {
    await this.failUnfinishedRelayPoolRuns('Interrupted by an Opfield restart. Start the Relay Pool update again.');
  }

  /** Fails the active runs no update of this process runs, and releases the relays they drained. */
  private async failUnfinishedRelayPoolRuns(message: string): Promise<void> {
    const interrupted = await this.db
      .select({ id: relayPoolUpdateRuns.id, targetArtifact: relayPoolUpdateRuns.targetArtifact })
      .from(relayPoolUpdateRuns)
      .where(
        and(
          eq(relayPoolUpdateRuns.poolId, 'system'),
          inArray(relayPoolUpdateRuns.state, [...ACTIVE_RELAY_POOL_RUN_STATES])
        )
      );
    const drained = new Set<string>();
    for (const run of interrupted) {
      // A run started meanwhile is this process's own.
      if (this.relayPoolRun) break;
      for (const instanceId of await this.failRelayPoolRun(run.id, message, ACTIVE_RELAY_POOL_RUN_STATES)) {
        drained.add(instanceId);
      }
      logger.warn('Failed an unfinished Relay Pool update', {
        runId: run.id,
        targetVersion: run.targetArtifact.version,
      });
      await this.audit
        ?.log({
          userId: null,
          action: 'system.relay_update.failed',
          resourceType: 'relay-update',
          resourceId: run.id,
          details: { targetVersion: run.targetArtifact.version, error: message },
        })
        .catch(() => undefined);
    }
    // Remote relays reconnect after this process starts; the release retries until they do.
    if (drained.size) this.scheduleRelayDrainRelease([...drained], null);
  }

  /** Fails the run and its in-flight steps. Returns the relays whose drain the update owned. */
  private async failRelayPoolRun(
    runId: string,
    message: string,
    fromStates: readonly (typeof UNFINISHED_RELAY_POOL_RUN_STATES)[number][]
  ): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      // The fence that serializes run creation and rebalance placement.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-pool-rebalance'))`);
      const failed = await tx
        .update(relayPoolUpdateRuns)
        .set({ state: 'failed', terminalError: message, updatedAt: new Date() })
        .where(and(eq(relayPoolUpdateRuns.id, runId), inArray(relayPoolUpdateRuns.state, [...fromStates])))
        .returning({ id: relayPoolUpdateRuns.id });
      if (!failed.length) return [];
      const steps = await tx
        .update(relayPoolUpdateSteps)
        .set({ state: 'failed', error: message, completedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(relayPoolUpdateSteps.runId, runId),
            inArray(relayPoolUpdateSteps.state, [...IN_FLIGHT_RELAY_POOL_STEP_STATES])
          )
        )
        .returning({
          relayInstanceId: relayPoolUpdateSteps.relayInstanceId,
          drainDeadlineAt: relayPoolUpdateSteps.drainDeadlineAt,
        });
      // Steps record a drain deadline when they drain their relay.
      return steps.filter(({ drainDeadlineAt }) => drainDeadlineAt).map(({ relayInstanceId }) => relayInstanceId);
    });
  }

  private scheduleRelayDrainRelease(instanceIds: string[], userId: string | null, attempt = 1): void {
    void this.releaseRelayUpdateDrains(instanceIds, userId).then((pending) => {
      if (!pending.length) return;
      if (attempt >= RELAY_DRAIN_RELEASE_ATTEMPTS) {
        logger.error('Relays drained by a failed Relay Pool update are still drained; resume them on the Relay page', {
          instanceIds: pending,
        });
        return;
      }
      const timer = setTimeout(
        () => this.scheduleRelayDrainRelease(pending, userId, attempt + 1),
        RELAY_DRAIN_RELEASE_RETRY_MS
      );
      timer.unref?.();
    });
  }

  /** Resumes relays a failed update left drained. Returns those to retry. */
  private async releaseRelayUpdateDrains(instanceIds: string[], userId: string | null): Promise<string[]> {
    const runtime = this.relayPoolRuntime;
    if (!runtime) return [];
    const pending: string[] = [];
    for (const instanceId of instanceIds) {
      try {
        const [instance] = await this.db
          .select()
          .from(relayInstances)
          .where(eq(relayInstances.id, instanceId))
          .limit(1);
        // Operator drains are not the update's to release.
        if (!instance || (instance.kind === 'remote' && !instance.nodeId) || instance.manualDrainStartedAt) continue;
        if (instance.state === 'ready' && instance.health?.admissionState !== 'draining') continue;
        if (await this.isRelayInstanceHeldByUnfinishedRun(instanceId)) continue;
        await runtime.drainInstance(instanceId, userId, false);
        logger.info('Resumed a relay drained by a failed Relay Pool update', { instanceId });
      } catch (error) {
        logger.warn('Could not resume a relay drained by a failed Relay Pool update yet', {
          instanceId,
          error: formatError(error),
        });
        pending.push(instanceId);
      }
    }
    return pending;
  }

  /** A newer run that drains the relay owns it now. */
  private async isRelayInstanceHeldByUnfinishedRun(instanceId: string): Promise<boolean> {
    const [held] = await this.db
      .select({ id: relayPoolUpdateSteps.id })
      .from(relayPoolUpdateSteps)
      .innerJoin(relayPoolUpdateRuns, eq(relayPoolUpdateSteps.runId, relayPoolUpdateRuns.id))
      .where(
        and(
          eq(relayPoolUpdateSteps.relayInstanceId, instanceId),
          inArray(relayPoolUpdateSteps.state, [...IN_FLIGHT_RELAY_POOL_STEP_STATES]),
          inArray(relayPoolUpdateRuns.state, [...UNFINISHED_RELAY_POOL_RUN_STATES])
        )
      )
      .limit(1);
    return Boolean(held);
  }

  private async getDurableRelayOperation(): Promise<RelayUpdateOperation | null> {
    if (!this.relayPoolRuntime) return null;
    const [latestRun] = await this.db
      .select()
      .from(relayPoolUpdateRuns)
      .where(eq(relayPoolUpdateRuns.poolId, 'system'))
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    const run = latestRun?.state === 'complete' ? undefined : latestRun;
    if (!run) return null;
    const [lastStep] = await this.db
      .select({ updatedAt: max(relayPoolUpdateSteps.updatedAt) })
      .from(relayPoolUpdateSteps)
      .where(eq(relayPoolUpdateSteps.runId, run.id));
    const lastProgressAt = new Date(
      Math.max(
        ...[run.startedAt, run.updatedAt, lastStep?.updatedAt]
          .filter((value): value is Date => value instanceof Date)
          .map((value) => value.getTime())
      )
    );
    return {
      status: run.state === 'failed' || run.state === 'paused' ? 'failed' : 'updating',
      targetVersion: run.targetArtifact.version,
      startedAt: run.startedAt.toISOString(),
      error: run.terminalError,
      abandonable:
        (UNFINISHED_RELAY_POOL_RUN_STATES as readonly string[]).includes(run.state) && !this.localRelayUpdateCommitted,
      runState: run.state,
      lastProgressAt: lastProgressAt.toISOString(),
    };
  }

  private async rollbackFoundationMigration(
    imageRef: string,
    composeDir: string,
    backupDir: string | null
  ): Promise<void> {
    if (!backupDir) return;
    if (!backupDir.startsWith(`/host/${FOUNDATION_BACKUPS_DIR}/`)) {
      throw new Error(`Refusing to rollback unexpected foundation backup path: ${backupDir}`);
    }
    const result = await this.dockerService.runOneShot({
      Image: imageRef,
      Cmd: [
        'sh',
        '-c',
        `set -eu
backup="$FOUNDATION_BACKUP_DIR"
[ -f "$backup/.env" ] && cp -p "$backup/.env" /host/.env || true
[ -f "$backup/docker-compose.yml" ] && cp -p "$backup/docker-compose.yml" /host/docker-compose.yml || true`,
      ],
      Env: [`FOUNDATION_BACKUP_DIR=${backupDir}`],
      HostConfig: { Binds: [`${composeDir}:/host`] },
    });
    if (result.exitCode !== 0) throw new Error(`Foundation rollback failed: ${result.output}`);
  }

  private async prepareSandboxWorkspaceDir(
    imageRef: string,
    composeDir: string,
    backupDir: string | null,
    sandboxWorkspaceDir: string
  ): Promise<Error | null> {
    if (!sandboxWorkspaceDir.startsWith('/')) return null;
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(sandboxWorkspaceDir)) {
      const error = new Error(`Invalid sandbox workspace directory path: ${sandboxWorkspaceDir}`);
      const rollbackError = await this.rollbackFoundationMigration(imageRef, composeDir, backupDir).catch(
        (innerError) => innerError as Error
      );
      if (rollbackError) {
        return new Error(`${error.message}; rollback failed: ${formatError(rollbackError)}`);
      }
      return error;
    }

    const result = await this.dockerService.runOneShot({
      Image: imageRef,
      Cmd: ['sh', '-c', 'set -eu\nmkdir -p "$SANDBOX_WORKSPACE_DIR"\nchmod 700 "$SANDBOX_WORKSPACE_DIR"'],
      Env: [`SANDBOX_WORKSPACE_DIR=${sandboxWorkspaceDir}`],
      HostConfig: { Binds: [`${sandboxWorkspaceDir}:${sandboxWorkspaceDir}`] },
    });
    if (result.exitCode === 0) return null;

    const error = new Error(`Failed to prepare sandbox workspace directory: ${result.output}`);
    const rollbackError = await this.rollbackFoundationMigration(imageRef, composeDir, backupDir).catch(
      (innerError) => innerError as Error
    );
    if (rollbackError) return new Error(`${error.message}; rollback failed: ${formatError(rollbackError)}`);
    return error;
  }

  getOpfieldManifestUrl(version: string): string {
    const tag = normalizeVersionTag(version);
    return this.getManifestSource('gateway', tag, 'gateway-image.update.json').url;
  }

  getRelayManifestUrl(version: string): string {
    const tag = `${normalizeVersionTag(version)}-relay`;
    return this.getManifestSource('relay', tag, 'relay-image.update.json').url;
  }

  private async upsertSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  private async deleteSettings(keys: string[]): Promise<void> {
    await this.db.delete(settings).where(inArray(settings.key, keys));
  }
}

function legacySettingsMigrationEnv(env: Env): string[] {
  const values: Record<string, string | number | boolean | undefined> = {
    NODE_ENV: env.NODE_ENV,
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    PKI_MASTER_KEY: env.PKI_MASTER_KEY,
  };
  return Object.entries(values)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
}

/**
 * Update sidecar shell functions. The target app applies its migrations when it
 * starts, so the sidecar snapshots the Opfield database before recreating it and
 * a rollback restores the snapshot before the previous app starts again: the
 * previous app never runs on a schema it does not know.
 *
 * `restore_database_snapshot` returns 0 when the snapshot is back, 1 when the
 * database was left as the update changed it, 2 when it was dropped and could
 * not be restored (the previous app must not start then).
 */
function databaseSnapshotShell(composeDir: string, database: { role: string; database: string }): string {
  const { role, database: name } = database;
  return `OPFIELD_DB_DUMP="$FOUNDATION_BACKUP_DIR/${DATABASE_SNAPSHOT_FILE}"
db_snapshot_ready=0
prune_database_snapshots() {
  # Left by an update whose sidecar was killed, or kept after a failed restore (also those of updates before 2.12.1).
  for old_dump in ${composeDir}/${FOUNDATION_BACKUPS_DIR}/pre-update-*/${DATABASE_SNAPSHOT_FILE} ${composeDir}/${LEGACY_FOUNDATION_BACKUPS_DIR}/pre-update-*/${LEGACY_DATABASE_SNAPSHOT_FILE}; do
    [ -f "$old_dump" ] || continue
    [ "$old_dump" != "$OPFIELD_DB_DUMP" ] || continue
    [ -n "$(find "$old_dump" -mtime +7)" ] || continue
    if rm -f "$old_dump"; then echo "Removed the database snapshot of an earlier update: $old_dump"; fi
  done
}
snapshot_database() {
  prune_database_snapshots
  db_bytes="$(compose exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U ${role} -d ${name} -c "SELECT pg_database_size('${name}')")" || db_bytes=
  case "$db_bytes" in
    ''|*[!0-9]*)
      echo "Opfield update stopped before replacing the app: could not read the size of the Opfield database" >&2
      return 1
      ;;
  esac
  free_kb="$(df -Pk "$FOUNDATION_BACKUP_DIR" | awk 'NR == 2 { print $4 }')" || free_kb=
  case "$free_kb" in
    ''|*[!0-9]*)
      echo "Opfield update stopped before replacing the app: could not read the free space in $FOUNDATION_BACKUP_DIR" >&2
      return 1
      ;;
  esac
  # The compressed dump stays below the database size; keep a margin for the rest of the host.
  need_kb=$((db_bytes / 1024 + db_bytes / 10240 + 262144))
  if [ "$free_kb" -lt "$need_kb" ]; then
    echo "Opfield update stopped before replacing the app: the pre-update database snapshot needs $((need_kb / 1024)) MiB free in $FOUNDATION_BACKUP_DIR, but only $((free_kb / 1024)) MiB are free. Free up disk space and start the update again." >&2
    return 1
  fi
  rm -f "$OPFIELD_DB_DUMP"
  if ! (umask 077 && compose exec -T postgres pg_dump --format=custom --create --no-password -U ${role} -d ${name} > "$OPFIELD_DB_DUMP"); then
    rm -f "$OPFIELD_DB_DUMP"
    echo "Opfield update stopped before replacing the app: the pre-update database snapshot failed" >&2
    return 1
  fi
  if [ ! -s "$OPFIELD_DB_DUMP" ] || ! chmod 600 "$OPFIELD_DB_DUMP" || ! compose exec -T postgres pg_restore --list < "$OPFIELD_DB_DUMP" > /dev/null; then
    rm -f "$OPFIELD_DB_DUMP"
    echo "Opfield update stopped before replacing the app: the pre-update database snapshot is empty or unreadable" >&2
    return 1
  fi
  db_snapshot_ready=1
  echo "Saved the pre-update database snapshot to $OPFIELD_DB_DUMP"
}
restore_database_snapshot() {
  echo "Restoring the Opfield database from the pre-update snapshot $OPFIELD_DB_DUMP"
  if [ ! -s "$OPFIELD_DB_DUMP" ] || ! compose exec -T postgres pg_restore --list < "$OPFIELD_DB_DUMP" > /dev/null; then
    echo "The pre-update database snapshot $OPFIELD_DB_DUMP is missing or unreadable" >&2
    return 1
  fi
  # Nothing may hold or reopen a connection while the database is replaced.
  for service in $(compose config --services); do
    [ "$service" = postgres ] && continue
    if ! compose stop "$service"; then
      echo "Could not stop $service before restoring the Opfield database" >&2
      return 1
    fi
  done
  if ! compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U ${role} -d postgres -c 'DROP DATABASE IF EXISTS ${name} WITH (FORCE)'; then
    echo "Could not drop the migrated Opfield database" >&2
    return 1
  fi
  if ! compose exec -T postgres pg_restore --create --exit-on-error --no-password -U ${role} -d postgres < "$OPFIELD_DB_DUMP"; then
    echo "pg_restore of $OPFIELD_DB_DUMP failed" >&2
    return 2
  fi
}`;
}

function parseOpfieldUpdateAttempt(value: unknown): OpfieldUpdateAttempt | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null);
  const targetVersion = text('targetVersion');
  const startedAt = text('startedAt');
  if (!targetVersion || !startedAt) return null;
  return {
    targetVersion,
    fromVersion: text('fromVersion') ?? 'unknown',
    startedAt,
    userId: text('userId'),
    sidecarId: text('sidecarId'),
    failedAt: text('failedAt'),
    error: text('error'),
    targetStartedAt: text('targetStartedAt'),
  };
}

function parseFoundationMigrationOutput(output: string): FoundationMigrationOutput {
  const line = output
    .trim()
    .split('\n')
    .reverse()
    .find((entry) => entry.trim().startsWith('{'));
  if (!line) throw new Error(`Foundation migration returned invalid output: ${output}`);
  const parsed = JSON.parse(line) as Partial<FoundationMigrationOutput>;
  if (
    parsed.ok !== true ||
    !Array.isArray(parsed.changedFiles) ||
    !('backupDir' in parsed) ||
    typeof parsed.sandboxWorkspaceDir !== 'string'
  ) {
    throw new Error(`Foundation migration returned invalid output: ${output}`);
  }
  return parsed as FoundationMigrationOutput;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function imageRepositoryFromRef(imageRef: string): string {
  const digestIndex = imageRef.indexOf('@');
  const withoutDigest = digestIndex >= 0 ? imageRef.slice(0, digestIndex) : imageRef;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  if (lastColon > lastSlash) return withoutDigest.slice(0, lastColon);
  return withoutDigest;
}

function normalizeVersionTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
