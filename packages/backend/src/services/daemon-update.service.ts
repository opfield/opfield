import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { type NodeUpdateConnectionResult, nodes } from '@/db/schema/nodes.js';
import { settings } from '@/db/schema/settings.js';
import type { CommandResult } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  type ReleaseArtifactSource,
  type ReleaseRecord,
  releaseArtifactSource,
  releaseNotes,
} from '@/lib/release-artifacts.js';
import {
  compareSemver,
  isNewerVersion,
  isReleaseCandidateVersion,
  parseSemver,
  RELEASE_VERSION_PATTERN,
} from '@/lib/semver.js';
import { type TrustedDaemonUpdateArtifact, verifyDaemonUpdateManifest } from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { GeneralSettingsService, UpdateChannel } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeLongTask } from '@/services/node-long-tasks.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';

const logger = createChildLogger('DaemonUpdateService');
/**
 * The longest a node's launcher keeps an updated daemon on trial before it restores the previous one: local readiness
 * within 30 s, then Opfield control readiness within 3 min (the daemon launcher's launcherLocalReadyLimit and
 * launcherControlReadyLimit).
 */
export const LAUNCHER_CANDIDATE_TRIAL_LIMIT_MS = 30_000 + 3 * 60_000;
/**
 * How long Opfield waits for the daemon after it took the update: the launcher's whole trial, plus a whole-service
 * restart (up to 25 s) and the restored daemon's reconnect. A rollback then reports itself ("came back on …") instead
 * of the node being declared gone and offline while its launcher still waits for the new daemon.
 */
export const NODE_UPDATE_RECONNECT_TIMEOUT_MS = LAUNCHER_CANDIDATE_TRIAL_LIMIT_MS + 60_000;
const NODE_UPDATE_EXECUTION_TIMEOUT_MS = 6 * 60 * 1000;
/** A queued update of a lease member waits at most this long for its lease peers (rollout timeout + margin). */
const NODE_UPDATE_QUEUE_TIMEOUT_MS = 31 * 60 * 1000;
/** Node creation waits this long at most for the daemon release a new node installs. */
const INSTALL_VERSION_TIMEOUT_MS = 5_000;
const INSTALL_VERSION_TTL_MS = 10 * 60 * 1000;
/** Update phase of a lease member whose update waits for other members of its availability policies. */
export const NODE_UPDATE_WAITING_PHASE = 'waiting_for_lease_peers';
/** Update phase of an update that waits for the long tasks of its node (backups, builds, migrations, transfers). */
export const NODE_UPDATE_TASK_WAIT_PHASE = 'waiting_for_tasks';
/** An update waits this long at most for the long tasks of its node, then it is sent anyway with a warning. */
export const NODE_UPDATE_TASK_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
/** The task wait ends the wait itself; its metadata deadline only ends an update that nothing waits for any more. */
const NODE_UPDATE_TASK_WAIT_DEADLINE_MARGIN_MS = 2 * 60 * 1000;
const NODE_UPDATE_METADATA_KEYS = [
  'updateInProgress',
  'updateTargetVersion',
  'updateStartedAt',
  'updateOperationId',
  'updatePhase',
  'updateDeadlineAt',
  'updateReconnectStartedAt',
  'updateWaitingFor',
  'updateWaitingForTasks',
  'updateTaskWaitStartedAt',
  'updateNow',
  'updateWarnings',
  'updateServiceRestart',
  'updateFromVersion',
  'updateFromHandover',
] as const;

/** The capability of a daemon that hands its connections over to the next process when it is updated. */
export const DAEMON_STREAM_HANDOVER_CAPABILITY = 'daemon_stream_handover_v1';

/** The cut class of an update that cut every connection of the node and whose daemons did not count them. */
export const UNCOUNTED_CUT_CLASS = 'uncounted';

/** What the node keeps of its last completed daemon update (metadata.lastUpdate). */
export interface NodeLastUpdate {
  targetVersion: string;
  /**
   * The update was rolled back: the launcher put this previous daemon back (it came back on it instead of the target).
   * completedAt is when Opfield saw it come back, and the connections are what the rollback did to them.
   */
  rolledBackTo?: string;
  completedAt: string;
  /** The update went ahead while long tasks of the node ran (wait timed out, or "update now"). */
  warnings: string[];
  /**
   * The daemon's note when its launcher predated launcher self-update: the update restarted the whole service once
   * (its connections are then cut as service_restart), or why it ran under that launcher instead.
   */
  serviceRestart?: string;
  /** The daemon's own counts of the connections the update kept and cut, once it reports them final. */
  connections?: NodeLastUpdateConnections;
}

export interface NodeLastUpdateConnections {
  fromVersion: string;
  /** The daemon that took the connections over and reported them (the previous one after a rollback). */
  toVersion?: string;
  /** Identifies the daemon's report. */
  finishedAtUnixMs: number;
  handover: boolean;
  handedOver: number;
  kept: number;
  cut: Record<string, number>;
  pauseP50Ms: number;
  pauseP99Ms: number;
  pauseMaxMs: number;
}

/**
 * The first daemon release that counts a handed over connection whose local side closed during the update as cut
 * (local_closed). An older daemon that takes connections over counts every stream that resumed as kept, even when
 * its own start cut the local connection (stand rc.7 F-1), so its kept count says nothing.
 */
export const DAEMON_ACCOUNTS_LOCAL_CONNECTIONS_VERSION = 'v2.11.4-rc.8';

/** The cut class of connections a daemon that cannot account for them handed over reports as kept. */
export const UNVERIFIED_KEPT_CUT_CLASS = 'unverified';

/**
 * The cut class of the sessions a replaced Secure Link connector still carried when it was removed (up to an hour after
 * its replacement, e.g. by a Relay Pool update). The daemon adds it to its last update's report; it is no part of that
 * update and is kept apart (metadata.lastConnectorReplacement), so a past update's record never changes (stand rc.9,
 * O-4: it was booked on the 05:57 update record and moved its finish to 07:19).
 */
export const CONNECTOR_RETIRED_CUT_CLASS = 'connector_retired';

/** The node's last replacement of its Secure Link connector that cut connections (metadata.lastConnectorReplacement). */
export interface NodeLastConnectorReplacement {
  /** When the replaced connector was removed with the sessions it carried. */
  at: string;
  connectionsCut: number;
  daemonVersion: string;
}

/** The connector replacement a report carries, to keep apart from the update; 'skip' when none or already kept. */
export function connectorReplacementToRecord(
  metadata: Record<string, unknown>,
  report: NodeUpdateConnectionResult
): NodeLastConnectorReplacement | 'skip' {
  const cut = report.cut?.[CONNECTOR_RETIRED_CUT_CLASS] ?? 0;
  if (!(cut > 0)) return 'skip';
  const at = new Date(report.finishedAtUnixMs).toISOString();
  const last = metadata.lastConnectorReplacement as Partial<NodeLastConnectorReplacement> | undefined;
  if (last?.at === at && last.connectionsCut === cut) return 'skip';
  return { at, connectionsCut: cut, daemonVersion: report.toVersion };
}

function withoutConnectorRetired(cut: Record<string, number>): Record<string, number> {
  const { [CONNECTOR_RETIRED_CUT_CLASS]: _retired, ...rest } = cut ?? {};
  return rest;
}

/**
 * The connections of an update whose daemon could not hand them over (it predates daemon_stream_handover_v1, or the
 * one a rollback put back does): it cut every connection of the node, and no daemon reports it, since the stopping
 * one wrote no report (2.11.3 and earlier) or the one taking over cannot read it. Opfield records it as all connections
 * cut (class uncounted), so the update never shows without its cut. Null when the daemon it updated from hands over,
 * or when that is unknown (an update started before Opfield recorded it).
 */
export function preHandoverUpdateConnections(
  metadata: Record<string, unknown>,
  fromVersion: string,
  toVersion: string,
  at: Date
): NodeLastUpdateConnections | null {
  if (metadata.updateFromHandover !== false) return null;
  return {
    fromVersion,
    toVersion,
    finishedAtUnixMs: at.getTime(),
    handover: false,
    handedOver: 0,
    kept: 0,
    cut: { [UNCOUNTED_CUT_CLASS]: 1 },
    pauseP50Ms: 0,
    pauseP99Ms: 0,
    pauseMaxMs: 0,
  };
}

function hasHandoverCapability(capabilities: unknown): boolean {
  const advertised = (capabilities as { capabilities?: unknown } | null | undefined)?.capabilities;
  return Array.isArray(advertised) && advertised.includes(DAEMON_STREAM_HANDOVER_CAPABILITY);
}

/** A report may start this much after Opfield completed its update (clocks of node and Opfield differ). */
const UPDATE_REPORT_CLOCK_SLACK_MS = 2 * 60 * 1000;

function sameVersion(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.replace(/^v/, '') === b.replace(/^v/, '');
}

function updateWarnings(metadata: Record<string, unknown>): string[] {
  return Array.isArray(metadata.updateWarnings)
    ? metadata.updateWarnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

/** The cut class of the connections a daemon cut when it restarted its whole service for a newer launcher. */
export const SERVICE_RESTART_CUT_CLASS = 'service_restart';

/**
 * How long after Opfield completed an update from a daemon without live handover the new daemon may restart its whole
 * service for it: it waits for its update to commit (up to 5 min) and a launcher trial in progress (up to 3 min).
 */
const AFTER_UPDATE_RESTART_WINDOW_MS = 15 * 60 * 1000;

/**
 * An update from a daemon that cannot hand connections over (Opfield's `uncounted` record, see
 * preHandoverUpdateConnections) is followed by one restart of the whole service: the new daemon starts its own launcher
 * at once (lifecycle launcher_after_update.go, 2.11.3 to 2.11.4), and reports that restart's cut as the same update's.
 * The record then tells both: every connection cut by the previous daemon, then the restart's cut. Null for any other
 * report.
 */
function afterUpdateRestartConnections(
  lastUpdate: Partial<NodeLastUpdate>,
  completedAt: number,
  reported: NodeUpdateConnectionResult
): NodeLastUpdateConnections | null {
  const recorded = lastUpdate.connections;
  if (!recorded || recorded.handover !== false || (recorded.cut?.[UNCOUNTED_CUT_CLASS] ?? 0) <= 0) return null;
  if ((recorded.cut[SERVICE_RESTART_CUT_CLASS] ?? 0) > 0) return null;
  if ((reported.cut?.[SERVICE_RESTART_CUT_CLASS] ?? 0) <= 0) return null;
  if (!sameVersion(recorded.fromVersion, reported.fromVersion)) return null;
  if (!sameVersion(recorded.toVersion ?? reported.toVersion, reported.toVersion)) return null;
  if (reported.finishedAtUnixMs <= recorded.finishedAtUnixMs) return null;
  if (Number.isFinite(completedAt) && reported.startedAtUnixMs > completedAt + AFTER_UPDATE_RESTART_WINDOW_MS)
    return null;
  const cut = { ...recorded.cut };
  for (const [connectionClass, count] of Object.entries(withoutConnectorRetired(reported.cut))) {
    cut[connectionClass] = (cut[connectionClass] ?? 0) + count;
  }
  return {
    ...recorded,
    finishedAtUnixMs: reported.finishedAtUnixMs,
    kept: reported.kept,
    cut,
    pauseP50Ms: reported.pauseP50Ms,
    pauseP99Ms: reported.pauseP99Ms,
    pauseMaxMs: reported.pauseMaxMs,
  };
}

/**
 * The connections of a daemon's last update to keep in the node's update result (metadata.lastUpdate.connections).
 * 'pending' while the update the report belongs to has not completed on Opfield's side yet; 'skip' when the result
 * already holds this report or belongs to another update.
 */
export function lastUpdateConnectionsToRecord(
  metadata: Record<string, unknown>,
  reported: NodeUpdateConnectionResult
): NodeLastUpdateConnections | 'pending' | 'skip' {
  // While an update runs, a report may belong to it, also one from the daemon a rollback puts back: try again once
  // the update ended.
  if (metadata.updateInProgress === true) return 'pending';
  const lastUpdate =
    metadata.lastUpdate && typeof metadata.lastUpdate === 'object'
      ? (metadata.lastUpdate as Partial<NodeLastUpdate>)
      : null;
  if (!lastUpdate) return 'skip';
  // The daemon the result left running reports it: the target, or the previous one after a rollback.
  const resultVersion =
    typeof lastUpdate.rolledBackTo === 'string' ? lastUpdate.rolledBackTo : lastUpdate.targetVersion;
  if (!sameVersion(resultVersion, reported.toVersion)) return 'skip';
  // A report of something later on the same version (a rollback to the version of an older result) is not this
  // result's (stand rc.8 O-2: a rollback's report was kept with an update completed ten hours before).
  const completedAt = typeof lastUpdate.completedAt === 'string' ? Date.parse(lastUpdate.completedAt) : Number.NaN;
  const afterUpdateRestart = afterUpdateRestartConnections(lastUpdate, completedAt, reported);
  if (afterUpdateRestart) return afterUpdateRestart;
  if (Number.isFinite(completedAt) && reported.startedAtUnixMs > completedAt + UPDATE_REPORT_CLOCK_SLACK_MS)
    return 'skip';
  if (lastUpdate.connections?.finishedAtUnixMs === reported.finishedAtUnixMs) return 'skip';
  // A report that finished before the recorded one is older than this result (a report a daemon kept from an earlier
  // update, after Opfield recorded an update that cut everything).
  if (lastUpdate.connections && reported.finishedAtUnixMs < lastUpdate.connections.finishedAtUnixMs) return 'skip';
  // A result that holds this update's counts already is final: a later report of it (a connector replacement added to
  // its cut, see CONNECTOR_RETIRED_CUT_CLASS) does not change it.
  const recorded = lastUpdate.connections;
  if (
    recorded &&
    sameVersion(recorded.fromVersion, reported.fromVersion) &&
    sameVersion(recorded.toVersion ?? reported.toVersion, reported.toVersion)
  )
    return 'skip';
  const report = { ...reported, cut: withoutConnectorRetired(reported.cut) };
  const accounts =
    parseSemver(report.toVersion) === null ||
    compareSemver(report.toVersion, DAEMON_ACCOUNTS_LOCAL_CONNECTIONS_VERSION) >= 0;
  if (!accounts && report.kept > 0) {
    // What it calls kept may have been cut by its own start: never shown as kept.
    return {
      fromVersion: report.fromVersion,
      toVersion: report.toVersion,
      finishedAtUnixMs: report.finishedAtUnixMs,
      handover: report.handover,
      handedOver: report.handedOver,
      kept: 0,
      cut: { ...report.cut, [UNVERIFIED_KEPT_CUT_CLASS]: (report.cut[UNVERIFIED_KEPT_CUT_CLASS] ?? 0) + report.kept },
      pauseP50Ms: 0,
      pauseP99Ms: 0,
      pauseMaxMs: 0,
    };
  }
  return {
    fromVersion: report.fromVersion,
    toVersion: report.toVersion,
    finishedAtUnixMs: report.finishedAtUnixMs,
    handover: report.handover,
    handedOver: report.handedOver,
    kept: report.kept,
    cut: report.cut,
    pauseP50Ms: report.pauseP50Ms,
    pauseP99Ms: report.pauseP99Ms,
    pauseMaxMs: report.pauseMaxMs,
  };
}

export type DaemonType = 'nginx' | 'docker' | 'monitoring' | 'relay' | 'relay-worker';

const DAEMON_TYPES: DaemonType[] = ['nginx', 'docker', 'monitoring', 'relay'];

const TAG_SUFFIX_MAP: Record<DaemonType, string> = {
  nginx: '-nginx',
  docker: '-docker',
  monitoring: '-monitoring',
  relay: '-relay',
  'relay-worker': '-relay',
};

const DAEMON_PACKAGE_MAP: Record<DaemonType, string> = {
  nginx: 'nginx-daemon',
  docker: 'docker-daemon',
  monitoring: 'monitoring-daemon',
  relay: 'relay-supervisor',
  'relay-worker': 'relay-supervisor',
};

const DAEMON_BINARY_MAP: Record<DaemonType, string> = {
  nginx: 'nginx-daemon',
  docker: 'docker-daemon',
  monitoring: 'monitoring-daemon',
  relay: 'relay-supervisor',
  'relay-worker': 'relay-worker',
};

/** Maps node.type values to daemon types */
export const NODE_TYPE_MAP: Record<string, DaemonType> = {
  nginx: 'nginx',
  docker: 'docker',
  // Builder nodes run the same docker-daemon binary in its builder-only profile.
  builder: 'docker',
  // Legacy database identities use the same unified Storage profile and binary.
  databases: 'docker',
  // Storage nodes use docker-daemon's restricted stateful profile.
  storage: 'docker',
  monitoring: 'monitoring',
  relay: 'relay',
};

export function daemonTypeForNodeType(nodeType: string): DaemonType | null {
  return NODE_TYPE_MAP[nodeType] ?? null;
}

export interface DaemonRelease {
  daemonType: DaemonType;
  tagName: string;
  version: string;
  releaseNotes: string | null;
  releaseUrl: string | null;
}

export interface DaemonNodeUpdateStatus {
  nodeId: string;
  hostname: string;
  currentVersion: string;
  updateAvailable: boolean;
  arch?: string;
}

export interface DaemonUpdateStatus {
  daemonType: DaemonType;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  nodes: DaemonNodeUpdateStatus[];
}

export class DaemonUpdateService {
  private readonly releasesUrl: string;
  private readonly installVersions = new Map<string, { version: string | null; expiresAt: number }>();
  /** The last update report of each node already settled (`toVersion@finishedAtUnixMs`); spares a read per report. */
  private readonly settledUpdateReports = new Map<string, string>();
  private eventBus?: EventBusService;
  private nodeRegistry?: NodeRegistryService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly env: Env,
    private readonly generalSettings?: GeneralSettingsService
  ) {
    this.releasesUrl = this.env.RELEASES_API_URL;
  }

  private async fetchNextRelease(
    packageName: string,
    currentVersion: string,
    channel: UpdateChannel,
    timeoutMs = 15_000
  ): Promise<ReleaseRecord | null> {
    const url = new URL(this.releasesUrl);
    url.searchParams.set('component', packageName);
    url.searchParams.set('current', currentVersion);
    url.searchParams.set('channel', channel);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Release resolver returned ${response.status}`);
    const payload = (await response.json()) as { target?: ReleaseRecord };
    if (!payload.target) throw new Error('Release resolver returned no target');
    return payload.target;
  }

  private getArtifactSource(daemonType: DaemonType, tag: string, arch: string): ReleaseArtifactSource {
    const daemonName = DAEMON_PACKAGE_MAP[daemonType];
    return releaseArtifactSource(this.env.ARTIFACT_BASE_URL, daemonName, tag, this.getBinaryName(daemonType, arch));
  }

  setEventBus(eventBus: EventBusService) {
    this.eventBus = eventBus;
  }

  setNodeRegistry(nodeRegistry: NodeRegistryService) {
    this.nodeRegistry = nodeRegistry;
  }

  private emitNodeUpdated(nodeId: string) {
    this.eventBus?.publish('node.changed', { id: nodeId, action: 'updated' });
  }

  async checkForUpdates(): Promise<DaemonUpdateStatus[]> {
    const lastCheckedAt = new Date().toISOString();

    try {
      const allNodes = await this.db.select().from(nodes);
      const updateChannel = (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';

      // Resolve one staged target for the oldest compatible cohort of each type.
      for (const type of DAEMON_TYPES) {
        const suffix = TAG_SUFFIX_MAP[type];
        const currentVersion = allNodes
          .filter((node) => NODE_TYPE_MAP[node.type] === type)
          .map((node) => node.daemonVersion ?? '')
          .filter((version) => version !== 'dev' && version !== 'unknown' && parseSemver(version) !== null)
          .sort(compareSemver)[0];
        const release = currentVersion
          ? await this.fetchNextRelease(DAEMON_PACKAGE_MAP[type], currentVersion, updateChannel)
          : null;
        const latest = release ? { ...release, version: release.tag_name.replace(suffix, '') } : null;
        if (latest) {
          await this.upsertSetting(`daemon-update:${type}:latest_version`, latest.version);
          await this.upsertSetting(`daemon-update:${type}:latest_tag`, latest.tag_name);
          await this.upsertSetting(`daemon-update:${type}:release_notes`, releaseNotes(latest));
        } else {
          await this.deleteSettings([
            `daemon-update:${type}:latest_version`,
            `daemon-update:${type}:latest_tag`,
            `daemon-update:${type}:release_notes`,
          ]);
        }
        await this.upsertSetting(`daemon-update:${type}:last_checked_at`, lastCheckedAt);
      }
    } catch (error) {
      logger.warn('Daemon update check failed', { error });
    }

    return this.getCachedStatus();
  }

  async getCachedStatus(): Promise<DaemonUpdateStatus[]> {
    const result: DaemonUpdateStatus[] = [];
    const updateChannel = (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';

    // Fetch all nodes
    const allNodes = await this.db.select().from(nodes);

    for (const type of DAEMON_TYPES) {
      const cachedLatestVersion = await this.getSetting(`daemon-update:${type}:latest_version`);
      const latestVersion =
        updateChannel === 'stable' && cachedLatestVersion && isReleaseCandidateVersion(cachedLatestVersion)
          ? null
          : cachedLatestVersion;
      const lastCheckedAt = await this.getSetting(`daemon-update:${type}:last_checked_at`);

      const typeNodes = allNodes
        .filter((n) => NODE_TYPE_MAP[n.type] === type)
        .map((n) => {
          const currentVersion = n.daemonVersion ?? 'unknown';
          const updateAvailable =
            latestVersion != null && currentVersion !== 'unknown' && currentVersion !== 'dev'
              ? isNewerVersion(latestVersion, currentVersion)
              : false;
          const caps = (n.capabilities ?? {}) as Record<string, unknown>;
          return {
            nodeId: n.id,
            hostname: n.displayName ?? n.hostname,
            currentVersion,
            updateAvailable,
            arch: (caps.architecture as string) ?? undefined,
          };
        });

      result.push({ daemonType: type, latestVersion, lastCheckedAt, nodes: typeNodes });
    }

    return result;
  }

  async getLatestRelease(daemonType: DaemonType): Promise<DaemonRelease | null> {
    const version = await this.getSetting(`daemon-update:${daemonType}:latest_version`);
    const tag = await this.getSetting(`daemon-update:${daemonType}:latest_tag`);
    const notes = await this.getSetting(`daemon-update:${daemonType}:release_notes`);
    if (!version || !tag) return null;
    const updateChannel = (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';
    if (updateChannel === 'stable' && isReleaseCandidateVersion(version)) return null;
    return {
      daemonType,
      tagName: tag,
      version,
      releaseNotes: notes || null,
      releaseUrl: null,
    };
  }

  /**
   * The daemon release a new node of this type installs: the newest one on Opfield's own minor line and update
   * channel, so a node set up from an older Opfield never gets a later line's daemon. Daemons are released only when
   * they change, so Opfield's own version usually has no daemon release of that name. Null for an unreleased
   * Opfield, a line without a daemon release yet, or an unreachable release resolver: the installer then picks the
   * latest stable daemon itself.
   */
  async installVersion(daemonType: DaemonType): Promise<string | null> {
    const gateway = RELEASE_VERSION_PATTERN.test(this.env.APP_VERSION) ? parseSemver(this.env.APP_VERSION) : null;
    if (!gateway) return null;
    const channel = (await this.generalSettings?.getConfig())?.updateChannel ?? 'stable';
    const key = `${daemonType}:${channel}:${gateway.major}.${gateway.minor}`;
    const cached = this.installVersions.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.version;
    let version: string | null = null;
    try {
      // rc.0 orders before every release of the line, so the resolver answers with the line's newest release.
      const release = await this.fetchNextRelease(
        DAEMON_PACKAGE_MAP[daemonType],
        `v${gateway.major}.${gateway.minor}.0-rc.0`,
        channel,
        INSTALL_VERSION_TIMEOUT_MS
      );
      const candidate = release?.tag_name.replace(TAG_SUFFIX_MAP[daemonType], '') ?? '';
      const parsed = RELEASE_VERSION_PATTERN.test(candidate) ? parseSemver(candidate) : null;
      if (parsed?.major === gateway.major && parsed.minor === gateway.minor) version = candidate;
    } catch (error) {
      logger.warn('Could not resolve the daemon release for new nodes', { daemonType, error });
      return null;
    }
    this.installVersions.set(key, { version, expiresAt: Date.now() + INSTALL_VERSION_TTL_MS });
    return version;
  }

  async isNodeUpdateInProgress(nodeId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
    const metadata = (node.metadata ?? {}) as Record<string, unknown>;
    if (await this.expireNodeUpdateIfDue(nodeId, metadata)) {
      return false;
    }
    // An update that waits for the long tasks of the node has restarted nothing: the node takes commands as usual,
    // which those tasks need.
    return metadata.updateInProgress === true && metadata.updatePhase !== NODE_UPDATE_TASK_WAIT_PHASE;
  }

  async markNodeUpdateInProgress(
    nodeId: string,
    targetVersion: string,
    options: {
      waitForLeasePeers?: boolean;
      /** Long tasks of the node the update waits for first (phase waiting_for_tasks), before its lease peers. */
      waitForTasks?: NodeLongTask[];
      /** When the task wait began, kept across an Opfield restart so the wait stays bounded. */
      taskWaitStartedAt?: number;
      /** Warnings the update carries into its result, kept across an Opfield restart. */
      warnings?: string[];
    } = {}
  ): Promise<string> {
    const selectNode = () =>
      this.db
        .select({
          metadata: nodes.metadata,
          type: nodes.type,
          daemonVersion: nodes.daemonVersion,
          capabilities: nodes.capabilities,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
    let [node] = await selectNode();
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');

    let metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress === true) {
      if (!(await this.expireNodeUpdateIfDue(nodeId, metadata))) {
        throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is already in progress');
      }
      [node] = await selectNode();
      if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
      metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    }

    const now = Date.now();
    const operationId = randomUUID();
    const waitForTasks = options.waitForTasks ?? [];
    const taskWaitStartedAt = Math.min(options.taskWaitStartedAt ?? now, now);
    const phase =
      waitForTasks.length > 0
        ? NODE_UPDATE_TASK_WAIT_PHASE
        : options.waitForLeasePeers
          ? NODE_UPDATE_WAITING_PHASE
          : 'executing';
    const deadlineMs =
      phase === NODE_UPDATE_TASK_WAIT_PHASE
        ? Math.max(taskWaitStartedAt + NODE_UPDATE_TASK_WAIT_TIMEOUT_MS - now, 0) +
          NODE_UPDATE_TASK_WAIT_DEADLINE_MARGIN_MS
        : phase === NODE_UPDATE_WAITING_PHASE
          ? NODE_UPDATE_QUEUE_TIMEOUT_MS
          : NODE_UPDATE_EXECUTION_TIMEOUT_MS;
    delete metadata.updateLastError;
    delete metadata.updateLastErrorAt;
    for (const key of NODE_UPDATE_METADATA_KEYS) delete metadata[key];
    metadata.updateInProgress = true;
    metadata.updateTargetVersion = targetVersion;
    metadata.updateStartedAt = new Date(now).toISOString();
    metadata.updateOperationId = operationId;
    metadata.updatePhase = phase;
    metadata.updateDeadlineAt = new Date(now + deadlineMs).toISOString();
    if (phase === NODE_UPDATE_TASK_WAIT_PHASE) {
      metadata.updateWaitingForTasks = waitForTasks;
      metadata.updateTaskWaitStartedAt = new Date(taskWaitStartedAt).toISOString();
    }
    if (options.warnings?.length) metadata.updateWarnings = options.warnings;
    // Whether the daemon updated from hands its connections over: when it does not, the update cuts them all and only
    // Opfield can report it (see preHandoverUpdateConnections). Monitoring and relay daemons carry none.
    if (node.type === 'docker' || node.type === 'nginx') {
      if (node.daemonVersion) metadata.updateFromVersion = node.daemonVersion;
      metadata.updateFromHandover = hasHandoverCapability(node.capabilities);
    }

    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`COALESCE(${nodes.metadata}->>'updateInProgress', 'false') <> 'true'`))
      .returning({ id: nodes.id });
    if (updated.length === 0) {
      throw new AppError(409, 'NODE_UPDATING', 'Node daemon update is already in progress');
    }

    // A queued update has not restarted anything yet; the node counts as updating once it is sent.
    if (phase === 'executing') this.nodeRegistry?.setNodeUpdateInProgress(nodeId, true);
    this.emitNodeUpdated(nodeId);
    this.scheduleNodeUpdateExpiry(nodeId, operationId, deadlineMs);
    return operationId;
  }

  /**
   * Moves a queued update to execution once its lease peers settled. False when it is no longer the queued update of
   * the node (expired, cleared, or replaced).
   */
  async beginQueuedNodeUpdate(nodeId: string, operationId: string): Promise<boolean> {
    const metadata = await this.readQueuedUpdate(nodeId, operationId);
    if (!metadata) return false;
    const now = Date.now();
    delete metadata.updateWaitingFor;
    metadata.updatePhase = 'executing';
    metadata.updateDeadlineAt = new Date(now + NODE_UPDATE_EXECUTION_TIMEOUT_MS).toISOString();
    if (!(await this.writeUpdateMetadata(nodeId, operationId, metadata))) return false;
    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, true);
    this.emitNodeUpdated(nodeId);
    this.scheduleNodeUpdateExpiry(nodeId, operationId, NODE_UPDATE_EXECUTION_TIMEOUT_MS);
    return true;
  }

  /** Shows which lease peers a queued update waits for. */
  async recordNodeUpdateWait(
    nodeId: string,
    operationId: string,
    waitingFor: Array<{ memberId: string; policyId: string; reason: string }>
  ): Promise<void> {
    const metadata = await this.readQueuedUpdate(nodeId, operationId);
    if (!metadata) return;
    metadata.updateWaitingFor = waitingFor;
    if (await this.writeUpdateMetadata(nodeId, operationId, metadata)) this.emitNodeUpdated(nodeId);
  }

  /** Shows which long tasks of its node an update waits for. False when the update no longer waits for them. */
  async recordNodeUpdateTaskWait(nodeId: string, operationId: string, tasks: NodeLongTask[]): Promise<boolean> {
    const metadata = await this.readQueuedUpdate(nodeId, operationId, NODE_UPDATE_TASK_WAIT_PHASE);
    if (!metadata) return false;
    metadata.updateWaitingForTasks = tasks;
    if (!(await this.writeUpdateMetadata(nodeId, operationId, metadata))) return false;
    this.emitNodeUpdated(nodeId);
    return true;
  }

  /**
   * Ends the task wait of an update: it goes on to its lease peers or is sent. A warning (the wait ran out, or the
   * operator updated now while tasks ran) stays with the update and lands in its result. False when the update no
   * longer waits for tasks (expired, failed, or replaced).
   */
  async endNodeUpdateTaskWait(
    nodeId: string,
    operationId: string,
    options: { waitForLeasePeers: boolean; warning?: string | string[] }
  ): Promise<boolean> {
    const metadata = await this.readQueuedUpdate(nodeId, operationId, NODE_UPDATE_TASK_WAIT_PHASE);
    if (!metadata) return false;
    const deadlineMs = options.waitForLeasePeers ? NODE_UPDATE_QUEUE_TIMEOUT_MS : NODE_UPDATE_EXECUTION_TIMEOUT_MS;
    delete metadata.updateWaitingForTasks;
    delete metadata.updateTaskWaitStartedAt;
    delete metadata.updateNow;
    const added = typeof options.warning === 'string' ? [options.warning] : (options.warning ?? []);
    if (added.length > 0) metadata.updateWarnings = [...updateWarnings(metadata), ...added];
    metadata.updatePhase = options.waitForLeasePeers ? NODE_UPDATE_WAITING_PHASE : 'executing';
    metadata.updateDeadlineAt = new Date(Date.now() + deadlineMs).toISOString();
    if (!(await this.writeUpdateMetadata(nodeId, operationId, metadata))) return false;
    if (!options.waitForLeasePeers) this.nodeRegistry?.setNodeUpdateInProgress(nodeId, true);
    this.emitNodeUpdated(nodeId);
    this.scheduleNodeUpdateExpiry(nodeId, operationId, deadlineMs);
    return true;
  }

  /**
   * The operator's "update now" for an update that waits for the long tasks of its node or for its lease peers: marks
   * it so that it stops waiting (for both), also when it is taken up again after an Opfield restart. Null when no update
   * of the node waits.
   */
  async requestNodeUpdateNow(
    nodeId: string
  ): Promise<{ operationId: string; targetVersion: string; phase: string } | null> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return null;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    const operationId = metadata.updateOperationId;
    const phase = metadata.updatePhase;
    if (
      metadata.updateInProgress !== true ||
      (phase !== NODE_UPDATE_TASK_WAIT_PHASE && phase !== NODE_UPDATE_WAITING_PHASE) ||
      typeof operationId !== 'string'
    ) {
      return null;
    }
    metadata.updateNow = true;
    if (phase === NODE_UPDATE_WAITING_PHASE) {
      const waitingFor = Array.isArray(metadata.updateWaitingFor)
        ? (metadata.updateWaitingFor as Array<{ memberId?: unknown; reason?: unknown }>)
            .map((blocker) => `${String(blocker.memberId)} ${String(blocker.reason)}`)
            .join(', ')
        : '';
      metadata.updateWarnings = [
        ...updateWarnings(metadata),
        `Updated on request without waiting for its lease peers${waitingFor ? ` (${waitingFor})` : ''}`,
      ];
    }
    if (!(await this.writeUpdateMetadata(nodeId, operationId, metadata))) return null;
    this.emitNodeUpdated(nodeId);
    return {
      operationId,
      targetVersion: typeof metadata.updateTargetVersion === 'string' ? metadata.updateTargetVersion : '',
      phase,
    };
  }

  /** Ends a queued or running update that could not complete and keeps the reason on the node. */
  async failNodeUpdate(
    nodeId: string,
    operationId: string,
    error: string,
    rollback?: { to: string; observedAt: Date }
  ): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;
    if (rollback && typeof metadata.updateTargetVersion === 'string' && metadata.updateTargetVersion) {
      // The node's result is the rollback now: what it ran, since when, and (once the daemon reports them final) what
      // it did to the connections. A result of an earlier update must not take this update's report.
      const lastUpdate: NodeLastUpdate = {
        targetVersion: metadata.updateTargetVersion,
        rolledBackTo: rollback.to,
        completedAt: rollback.observedAt.toISOString(),
        warnings: updateWarnings(metadata),
        ...(typeof metadata.updateServiceRestart === 'string' && metadata.updateServiceRestart
          ? { serviceRestart: metadata.updateServiceRestart }
          : {}),
      };
      // The daemon put back is the one updated from: one that cannot take connections over cut them all.
      const connections = preHandoverUpdateConnections(
        metadata,
        metadata.updateTargetVersion,
        rollback.to,
        rollback.observedAt
      );
      if (connections) lastUpdate.connections = connections;
      metadata.lastUpdate = lastUpdate;
    }
    for (const key of NODE_UPDATE_METADATA_KEYS) delete metadata[key];
    metadata.updateLastError = error;
    metadata.updateLastErrorAt = new Date().toISOString();
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;
    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, false);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  /**
   * Updates that wait (for the long tasks of their node or for lease peers), for an Opfield restart to take up again
   * with what they carry: an operator's "update now", when their task wait began, their warnings.
   */
  async listQueuedNodeUpdates(): Promise<
    Array<{
      nodeId: string;
      operationId: string;
      startedAt: Date | null;
      phase: typeof NODE_UPDATE_WAITING_PHASE | typeof NODE_UPDATE_TASK_WAIT_PHASE;
      now: boolean;
      taskWaitStartedAt: number | null;
      warnings: string[];
    }>
  > {
    const rows = await this.db.select({ id: nodes.id, metadata: nodes.metadata }).from(nodes);
    return rows.flatMap((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const startedAt = typeof metadata.updateStartedAt === 'string' ? new Date(metadata.updateStartedAt) : null;
      const taskWaitStartedAt =
        typeof metadata.updateTaskWaitStartedAt === 'string'
          ? Date.parse(metadata.updateTaskWaitStartedAt)
          : Number.NaN;
      const phase = metadata.updatePhase;
      return metadata.updateInProgress === true &&
        (phase === NODE_UPDATE_WAITING_PHASE || phase === NODE_UPDATE_TASK_WAIT_PHASE) &&
        typeof metadata.updateOperationId === 'string'
        ? [
            {
              nodeId: row.id,
              operationId: metadata.updateOperationId,
              startedAt: startedAt && Number.isFinite(startedAt.getTime()) ? startedAt : null,
              phase,
              now: metadata.updateNow === true,
              taskWaitStartedAt: Number.isFinite(taskWaitStartedAt) ? taskWaitStartedAt : null,
              warnings: updateWarnings(metadata),
            },
          ]
        : [];
    });
  }

  private async readQueuedUpdate(
    nodeId: string,
    operationId: string,
    phase: string = NODE_UPDATE_WAITING_PHASE
  ): Promise<Record<string, unknown> | null> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return null;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (
      metadata.updateInProgress !== true ||
      metadata.updateOperationId !== operationId ||
      metadata.updatePhase !== phase
    ) {
      return null;
    }
    return metadata;
  }

  private async writeUpdateMetadata(
    nodeId: string,
    operationId: string,
    metadata: Record<string, unknown>
  ): Promise<boolean> {
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    return updated.length > 0;
  }

  private scheduleNodeUpdateExpiry(nodeId: string, operationId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      void this.expireNodeUpdate(nodeId, operationId).catch((error) => {
        logger.error('Failed to expire daemon update deadline', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    timer.unref?.();
  }

  private async expireNodeUpdateIfDue(nodeId: string, metadata: Record<string, unknown>): Promise<boolean> {
    if (metadata.updateInProgress !== true || typeof metadata.updateOperationId !== 'string') return false;
    const deadlineAt =
      typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
    if (!Number.isFinite(deadlineAt) || Date.now() < deadlineAt) return false;
    return this.expireNodeUpdate(nodeId, metadata.updateOperationId);
  }

  private async expireNodeUpdate(nodeId: string, operationId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;
    const metadata = (node.metadata ?? {}) as Record<string, unknown>;
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;
    const deadlineAt =
      typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
    if (!Number.isFinite(deadlineAt) || Date.now() < deadlineAt) return false;

    const target = typeof metadata.updateTargetVersion === 'string' ? metadata.updateTargetVersion : 'the new version';
    const reason =
      metadata.updatePhase === NODE_UPDATE_WAITING_PHASE
        ? 'The update waited too long for the other members of its availability lease'
        : metadata.updatePhase === NODE_UPDATE_TASK_WAIT_PHASE
          ? 'The update waited too long for the running tasks of the node'
          : metadata.updatePhase === 'reconnecting'
            ? `The daemon did not come back on ${target} in time`
            : `The update to ${target} did not finish in time`;
    if (!(await this.failNodeUpdate(nodeId, operationId, reason))) return false;
    // A node that is still away is offline now that its update no longer covers it.
    await this.nodeRegistry?.markOfflineAfterUpdate(nodeId);
    logger.error('Daemon update did not complete before its deadline', { nodeId, operationId, reason });
    return true;
  }

  /** Adds a warning to the result of a node update in progress (an operator's "update now" that overrode a check). */
  async appendNodeUpdateWarning(nodeId: string, operationId: string, warning: string): Promise<void> {
    await this.db
      .update(nodes)
      .set({
        metadata: sql`jsonb_set(COALESCE(${nodes.metadata}, '{}'::jsonb), '{updateWarnings}', COALESCE(${nodes.metadata}->'updateWarnings', '[]'::jsonb) || to_jsonb(ARRAY[${warning}::text]))`,
        updatedAt: new Date(),
      })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`));
  }

  async clearNodeUpdateInProgress(nodeId: string, operationId: string): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;

    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;

    for (const key of NODE_UPDATE_METADATA_KEYS) delete metadata[key];

    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;

    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, false);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  private async beginNodeUpdateReconnectDeadline(
    nodeId: string,
    operationId: string,
    serviceRestart?: string
  ): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true || metadata.updateOperationId !== operationId) return false;

    // Kept for the update's result (lastUpdate.serviceRestart).
    if (serviceRestart) metadata.updateServiceRestart = serviceRestart;
    metadata.updatePhase = 'reconnecting';
    metadata.updateReconnectStartedAt = new Date().toISOString();
    metadata.updateDeadlineAt = new Date(Date.now() + NODE_UPDATE_RECONNECT_TIMEOUT_MS).toISOString();
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;
    this.scheduleNodeUpdateExpiry(nodeId, operationId, NODE_UPDATE_RECONNECT_TIMEOUT_MS);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  trackNodeUpdateCompletion(nodeId: string, operationId: string, completion: Promise<CommandResult>): void {
    void completion.then(
      async (result) => {
        if (result.success) {
          // How the daemon restarts for the update, when that differs from a restart under its launcher.
          if (result.detail) logger.info('Daemon update staged', { nodeId, detail: result.detail });
          await this.beginNodeUpdateReconnectDeadline(nodeId, operationId, result.detail || undefined).catch(
            (error) => {
              logger.error('Failed to start daemon reconnect deadline after update success', {
                nodeId,
                operationId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          );
          return;
        }
        const reason = result.error || result.detail || 'The daemon rejected the update';
        logger.error('Daemon update failed after dispatch', { nodeId, error: reason });
        await this.failNodeUpdate(nodeId, operationId, reason).catch((error) => {
          logger.error('Failed to record the rejected daemon update', {
            nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Node disconnected' || message.includes('timed out after')) {
          logger.info('Daemon update is awaiting reconnect after an uncertain command result', { nodeId, operationId });
          await this.beginNodeUpdateReconnectDeadline(nodeId, operationId).catch((reconnectError) => {
            logger.error('Failed to start daemon reconnect deadline after uncertain update result', {
              nodeId,
              operationId,
              error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
            });
          });
          return;
        }
        logger.error('Daemon update did not complete', { nodeId, error: message });
        await this.failNodeUpdate(nodeId, operationId, message).catch((failError) => {
          logger.error('Failed to record the incomplete daemon update', {
            nodeId,
            error: failError instanceof Error ? failError.message : String(failError),
          });
        });
      }
    );
  }

  /**
   * Reconciles a running update with a daemon registration. A registration on the target version (or later) after the
   * update started ends it, whether or not its result arrived. A registration below the target after the daemon was
   * told to restart means the update was rolled back or never installed, and fails it with that reason.
   */
  async clearNodeUpdateInProgressOnReconnect(
    nodeId: string,
    reportedVersion: string,
    registrationObservedAt = new Date()
  ): Promise<boolean> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;

    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress !== true) return false;
    const operationId = metadata.updateOperationId;
    if (typeof operationId !== 'string') return false;
    if (metadata.updatePhase !== 'executing' && metadata.updatePhase !== 'reconnecting') return false;

    const observedAt = registrationObservedAt.getTime();
    const startedAt = typeof metadata.updateStartedAt === 'string' ? Date.parse(metadata.updateStartedAt) : Number.NaN;
    const reconnectStartedAt =
      typeof metadata.updateReconnectStartedAt === 'string'
        ? Date.parse(metadata.updateReconnectStartedAt)
        : Number.NaN;
    const targetVersion = typeof metadata.updateTargetVersion === 'string' ? metadata.updateTargetVersion : '';
    const onTarget =
      !targetVersion ||
      (parseSemver(reportedVersion) !== null &&
        parseSemver(targetVersion) !== null &&
        compareSemver(reportedVersion, targetVersion) >= 0);

    if (!onTarget) {
      if (
        metadata.updatePhase !== 'reconnecting' ||
        !Number.isFinite(reconnectStartedAt) ||
        observedAt < reconnectStartedAt
      ) {
        return false;
      }
      return this.failNodeUpdate(
        nodeId,
        operationId,
        `The daemon came back on ${reportedVersion} instead of ${targetVersion}: the update was rolled back or not installed`,
        { to: reportedVersion, observedAt: registrationObservedAt }
      );
    }
    if (Number.isFinite(startedAt) && observedAt < startedAt) return false;

    // The update's result: its target and warnings now, the daemon's connection counts once it reports them final.
    // An update from a daemon that cannot hand connections over cut them all, which no daemon reports.
    const connections = preHandoverUpdateConnections(
      metadata,
      typeof metadata.updateFromVersion === 'string' ? metadata.updateFromVersion : '',
      reportedVersion,
      registrationObservedAt
    );
    const lastUpdate: NodeLastUpdate = {
      targetVersion: targetVersion || reportedVersion,
      completedAt: registrationObservedAt.toISOString(),
      warnings: updateWarnings(metadata),
      ...(typeof metadata.updateServiceRestart === 'string' && metadata.updateServiceRestart
        ? { serviceRestart: metadata.updateServiceRestart }
        : {}),
      ...(connections ? { connections } : {}),
    };
    for (const key of NODE_UPDATE_METADATA_KEYS) delete metadata[key];
    metadata.lastUpdate = lastUpdate;
    const updated = await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`${nodes.metadata}->>'updateOperationId' = ${operationId}`))
      .returning({ id: nodes.id });
    if (updated.length === 0) return false;

    this.nodeRegistry?.setNodeUpdateInProgress(nodeId, false);
    this.emitNodeUpdated(nodeId);
    return true;
  }

  /**
   * Expiry timers live in memory, so an Opfield restart loses them and no command result can arrive any more. Updates
   * that were sent before the restart wait for the daemon to register again: they move to `reconnecting` (a
   * registration from now on decides them) and get their timers back; the ones already past their deadline expire.
   */
  async resumeNodeUpdateDeadlines(processStartedAt: Date): Promise<number> {
    const rows = await this.db.select({ id: nodes.id, metadata: nodes.metadata }).from(nodes);
    let resumed = 0;
    for (const row of rows) {
      const metadata = { ...((row.metadata ?? {}) as Record<string, unknown>) };
      const operationId = metadata.updateOperationId;
      if (metadata.updateInProgress !== true || typeof operationId !== 'string') continue;
      if (metadata.updatePhase !== 'executing' && metadata.updatePhase !== 'reconnecting') continue;
      const deadlineAt =
        typeof metadata.updateDeadlineAt === 'string' ? Date.parse(metadata.updateDeadlineAt) : Number.NaN;
      if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) {
        if (await this.expireNodeUpdate(row.id, operationId)) resumed += 1;
        continue;
      }
      const remainingMs = Math.max(deadlineAt - Date.now(), NODE_UPDATE_RECONNECT_TIMEOUT_MS);
      metadata.updatePhase = 'reconnecting';
      metadata.updateReconnectStartedAt = processStartedAt.toISOString();
      metadata.updateDeadlineAt = new Date(Date.now() + remainingMs).toISOString();
      if (!(await this.writeUpdateMetadata(row.id, operationId, metadata))) continue;
      this.nodeRegistry?.setNodeUpdateInProgress(row.id, true);
      this.scheduleNodeUpdateExpiry(row.id, operationId, remainingMs);
      resumed += 1;
    }
    return resumed;
  }

  /**
   * Keeps the daemon's counts of the connections its last update kept and cut in the node's update result, once per
   * report (metadata.lastUpdate.connections). Most health reports repeat a report already settled and cost no read.
   */
  async recordLastUpdateConnections(nodeId: string, report: NodeUpdateConnectionResult): Promise<boolean> {
    const reportKey = `${report.toVersion}@${report.finishedAtUnixMs}`;
    if (this.settledUpdateReports.get(nodeId) === reportKey) return false;
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return false;
    const metadata = (node.metadata ?? {}) as Record<string, unknown>;
    const connections = lastUpdateConnectionsToRecord(metadata, report);
    // The update completes on Opfield's side when the daemon registers on its target; the next report tries again.
    if (connections === 'pending') return false;
    this.settledUpdateReports.set(nodeId, reportKey);
    const replaced = await this.recordConnectorReplacement(nodeId, metadata, report);
    if (connections === 'skip') {
      if (replaced) this.emitNodeUpdated(nodeId);
      return replaced;
    }
    const { targetVersion, completedAt } = metadata.lastUpdate as NodeLastUpdate;
    // Only the result's own key changes, and only on that result: an update that starts or ends meanwhile keeps its
    // metadata.
    const updated = await this.db
      .update(nodes)
      .set({
        metadata: sql`jsonb_set(
          coalesce(${nodes.metadata}, '{}'::jsonb),
          '{lastUpdate,connections}',
          ${JSON.stringify(connections)}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nodes.id, nodeId),
          sql`${nodes.metadata}->'lastUpdate'->>'targetVersion' = ${targetVersion}`,
          typeof completedAt === 'string'
            ? sql`${nodes.metadata}->'lastUpdate'->>'completedAt' = ${completedAt}`
            : undefined
        )
      )
      .returning({ id: nodes.id });
    if (updated.length === 0) {
      if (replaced) this.emitNodeUpdated(nodeId);
      return replaced;
    }
    this.emitNodeUpdated(nodeId);
    return true;
  }

  /** Keeps a connector replacement a report carries as its own entry (metadata.lastConnectorReplacement). */
  private async recordConnectorReplacement(
    nodeId: string,
    metadata: Record<string, unknown>,
    report: NodeUpdateConnectionResult
  ): Promise<boolean> {
    const replacement = connectorReplacementToRecord(metadata, report);
    if (replacement === 'skip') return false;
    const updated = await this.db
      .update(nodes)
      .set({
        metadata: sql`jsonb_set(
          coalesce(${nodes.metadata}, '{}'::jsonb),
          '{lastConnectorReplacement}',
          ${JSON.stringify(replacement)}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, nodeId))
      .returning({ id: nodes.id });
    return updated.length > 0;
  }

  /** Keeps why an update that is no longer running could not start again (for example after an Opfield restart). */
  async recordNodeUpdateError(nodeId: string, error: string): Promise<void> {
    const [node] = await this.db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node) return;
    const metadata = { ...((node.metadata ?? {}) as Record<string, unknown>) };
    if (metadata.updateInProgress === true) return;
    metadata.updateLastError = error;
    metadata.updateLastErrorAt = new Date().toISOString();
    await this.db
      .update(nodes)
      .set({ metadata, updatedAt: new Date() })
      .where(and(eq(nodes.id, nodeId), sql`COALESCE(${nodes.metadata}->>'updateInProgress', 'false') <> 'true'`));
    this.emitNodeUpdated(nodeId);
  }

  getDownloadUrl(daemonType: DaemonType, tag: string, arch: string): string {
    return this.getArtifactSource(daemonType, tag, arch).artifactUrl;
  }

  async prepareTrustedDaemonUpdate(
    daemonType: DaemonType,
    tag: string,
    version: string,
    arch: string
  ): Promise<TrustedDaemonUpdateArtifact> {
    const normalizedArch = this.normalizePackageArch(arch);
    const artifactName = this.getBinaryName(daemonType, normalizedArch);
    const source = this.getArtifactSource(daemonType, tag, normalizedArch);
    const response = await fetch(source.manifestUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new AppError(
        502,
        'UNTRUSTED_UPDATE_ARTIFACT',
        `Failed to fetch daemon update manifest: ${response.status}`
      );
    }
    const signedManifest = await response.text();
    try {
      return verifyDaemonUpdateManifest(signedManifest, {
        daemonType,
        version,
        tag,
        arch: normalizedArch,
        artifactName,
        downloadUrl: source.artifactUrl,
        trustedPackagePrefix: source.trustedPrefix,
        acceptedDownloadUrls: source.acceptedArtifactUrls,
      });
    } catch (error) {
      logger.warn('Daemon update manifest verification failed', {
        daemonType,
        tag,
        arch: normalizedArch,
        source: source.manifestUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(502, 'UNTRUSTED_UPDATE_ARTIFACT', 'Daemon update artifact is not trusted');
    }
  }

  getManifestUrl(daemonType: DaemonType, tag: string, arch: string): string {
    return this.getArtifactSource(daemonType, tag, arch).manifestUrl;
  }

  getBinaryName(daemonType: DaemonType, arch: string): string {
    const daemonName = DAEMON_BINARY_MAP[daemonType];
    return `${daemonName}-linux-${this.normalizePackageArch(arch)}`;
  }

  normalizePackageArch(arch: string): string {
    const normalized = arch.trim().toLowerCase();
    switch (normalized) {
      case 'x86_64':
      case 'x64':
      case 'amd64':
        return 'amd64';
      case 'aarch64':
      case 'arm64':
        return 'arm64';
      default:
        return normalized || 'amd64';
    }
  }

  private async getSetting(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return (row?.value as string) ?? null;
  }

  private async upsertSetting(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  private async deleteSettings(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.db.delete(settings).where(eq(settings.key, key))));
  }
}
