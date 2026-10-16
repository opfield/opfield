import httpModule from 'node:http';
import { and, count, eq, inArray, lt, min, sql } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { aiConversations } from '@/db/schema/ai-conversations.js';
import { alerts } from '@/db/schema/alerts.js';
import { auditLog } from '@/db/schema/audit-log.js';
import { nodes } from '@/db/schema/nodes.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AISandboxArtifactService } from '@/modules/ai/ai.sandbox-artifact.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerImageCleanupService } from '@/modules/docker/docker-image-cleanup.service.js';
import {
  type OpfieldInternalImageCandidate,
  selectObsoleteOpfieldConnectorImages,
} from '@/modules/docker/docker-internal-images.js';
import { hasOpfieldLabel, loadDockerManagedRecords } from '@/modules/docker/docker-managed-records.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import { REGISTRY_BUILDS_KEPT_PER_CONTAINER } from '@/modules/docker/docker-registry-retention.js';
import type { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import type { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import type { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import type { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import type { RedisClient } from './cache.service.js';
import type { DockerService } from './docker.service.js';
import { opfieldKeptVolumeNames } from './docker-kept-volumes.js';
import type { EventBusService } from './event-bus.service.js';
import {
  countExpiredTokens,
  DEFAULT_EXPIRED_TOKEN_RETENTION_DAYS,
  purgeExpiredTokens,
} from './expired-token-retention.js';
import { sweepTempLeftovers } from './host-temp-sweep.js';
import {
  type HostImage,
  opfieldHostImageRepositories,
  selectOldOpfieldHostImages,
} from './housekeeping-host-images.js';
import {
  cleanInferenceUsage,
  countExpiredInferenceUsage,
  DEFAULT_INFERENCE_USAGE_RETENTION_DAYS,
  inferenceUsageCutoff,
  pruneInferencePricingSnapshots,
  pruneInferenceQuotaSnapshots,
} from './inference-usage-retention.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import {
  buildLogStats,
  cleanBuildLogs,
  cleanOperationHistory,
  countExpiredOAuthGrants,
  countOperationHistory,
  DEFAULT_BUILD_LOG_MAX_SIZE_BYTES,
  DEFAULT_BUILD_LOG_RETENTION_DAYS,
  purgeExpiredOAuthGrants,
} from './operation-history-retention.js';
import { type OpfieldDiskUsage, OpfieldDiskUsageReader } from './opfield-disk-usage.js';
import type { OpfieldHostDiskReader } from './opfield-host-disks.js';
import type { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('HousekeepingService');
const VOLUME_CLEANUP_PROTECTED_LABEL = 'opfield.housekeeping.protected';
// legacy-name: cleanup protection label set on volumes before 2.12.1 (Docker cannot relabel a volume in place) — remove
// once no protected volume carries it
const LEGACY_VOLUME_CLEANUP_PROTECTED_LABEL = 'gateway.housekeeping.protected';
const SYSTEM_CERTIFICATE_KEY_RETENTION_DAYS = 30;
/** Alerts nobody dismissed are removed after this long (a renewed failure raises a fresh one). */
const UNDISMISSED_ALERT_RETENTION_DAYS = 90;
/** One category may run this long; then the run moves on and reports it as failed. */
const CATEGORY_TIMEOUT_MS = 30 * 60_000;
/** A run that has not succeeded for this long is reported as stale (Housekeeping card and the job's failures). */
export const HOUSEKEEPING_STALE_MS = 48 * 60 * 60_000;
/** When an Opfield host disk is this full, housekeeping runs at once (at most once per cooldown). */
export const LOW_DISK_RUN_PERCENT = 90;
const LOW_DISK_RUN_COOLDOWN_MS = 60 * 60_000;
/**
 * Categories that keep Opfield's own data bounded. They run on schedule even when the Housekeeping switch is off
 * (each still honours its own switch): with them off Opfield's database, registry and host files grow without end.
 */
const SAFETY_CATEGORIES = new Set([
  'Internal Registry',
  'Operation History',
  'Build Logs',
  'Inference Usage',
  'Expired OAuth Grants',
  'Expired Tokens',
  'Opfield Host Files',
]);
const LOGGING_SETTINGS_KEY = 'logging:clickhouse';
const NGINX_LOG_BUDGET_CAPABILITY = 'nginx_log_budget_v1';

// ── Types ───────────────────────────────────────────────────────────

export interface HousekeepingConfig {
  enabled: boolean;
  cronExpression: string;
  nginxLogs: { enabled: boolean; retentionDays: number };
  auditLog: { enabled: boolean; retentionDays: number };
  dismissedAlerts: { enabled: boolean; retentionDays: number };
  deliveryLog: { enabled: boolean; retentionDays: number };
  structuredLogs: { enabled: boolean; maxRows: number; maxSizeBytes: number };
  clickHouseInternals: { enabled: boolean; maxSizeBytes: number };
  orphanedAIArtifacts: { enabled: boolean };
  internalRegistry: { enabled: true; retentionSuccessfulArtifacts: number };
  orphanedVolumes: { enabled: boolean; retentionDays: number };
  dockerPrune: { enabled: boolean };
  orphanedCerts: { enabled: boolean };
  acmeCleanup: { enabled: boolean };
  /** Finished Docker tasks, builds, compose/availability/hosting operations and webhook deliveries. */
  operationHistory: { enabled: boolean; retentionDays: number };
  /** Expired OAuth codes and tokens, and registered clients left without grants. */
  oauthCleanup: { enabled: boolean };
  /** Expired API and inference tokens, removed `retentionDays` after they expired (0: at once). */
  expiredTokens: { enabled: boolean; retentionDays: number };
  /** Settled inference requests with their attempts and usage records (35 days at least). */
  inferenceUsage: { enabled: boolean; retentionDays: number };
  /** Logs of finished builds, by age and by the total size of all build logs. */
  buildLogs: { enabled: boolean; retentionDays: number; maxSizeBytes: number };
  /** Leftovers of interrupted work on the Opfield host: temp files, archive transfer spools, export snapshots. */
  hostFiles: { enabled: boolean };
}

/** `low-disk`: started because an Opfield host disk passed LOW_DISK_RUN_PERCENT. */
export type HousekeepingTrigger = 'scheduled' | 'manual' | 'low-disk';

export interface CategoryResult {
  category: string;
  success: boolean;
  itemsCleaned: number;
  spaceFreedBytes?: number;
  error?: string;
  durationMs: number;
}

export interface HousekeepingRunResult {
  startedAt: string;
  completedAt: string;
  trigger: HousekeepingTrigger;
  triggeredBy?: string;
  totalDurationMs: number;
  categories: CategoryResult[];
  overallSuccess: boolean;
}

export interface HousekeepingStats {
  /**
   * The nginx logs of every nginx node as its daemon last reported them (nginx_log_budget_v1): route logs and the
   * default access/error logs, live and rotated. oldestFile is the modification time of the oldest one (ISO).
   * reportingNodeCount < nodeCount: some nginx daemons are too old to report (and to bound) their logs.
   */
  nginxLogs: {
    totalSizeBytes: number;
    fileCount: number;
    oldestFile: string | null;
    nodeCount: number;
    reportingNodeCount: number;
  };
  auditLog: { totalRows: number; oldestEntry: string | null };
  dismissedAlerts: { count: number; oldestAlert: string | null };
  deliveryLog: { total: number; success: number; failed: number; retrying: number };
  structuredLogs: { totalRows: number; totalSizeBytes: number; status: string };
  clickHouseInternals: { totalRows: number; totalSizeBytes: number; status: string; capBytes: number };
  orphanedAIArtifacts: {
    count: number;
    totalSizeBytes: number;
    allCount?: number;
    allSizeBytes?: number;
    capBytes?: number;
  };
  internalRegistry: {
    totalSizeBytes: number;
    capacityBytes: number | null;
    status: string;
    lastGcAt: string | null;
  };
  orphanedVolumes: {
    count: number;
    reclaimableBytes: number;
    /** Unused volumes Opfield did not create (or cannot tell): never removed automatically, only shown. */
    unownedCount: number;
    unownedBytes: number;
  };
  orphanedCerts: {
    count: number;
    certIds: string[];
    currentCount: number;
    supersededCount: number;
    unknownCount: number;
  };
  acmeChallenges: { fileCount: number; totalSizeBytes: number };
  dockerImages: { oldImageCount: number; reclaimableBytes: number };
  operationHistory: { count: number };
  oauthCleanup: { count: number };
  expiredTokens: { count: number };
  inferenceUsage: { count: number; totalSizeBytes: number };
  buildLogs: { totalSizeBytes: number; expiredBuilds: number; capBytes: number };
  hostFiles: { count: number; sizeBytes: number };
  /** Opfield's own data on the Opfield host: disks, database, Redis, container logs. */
  diskUsage: OpfieldDiskUsage | null;
  lastRun: HousekeepingRunResult | null;
  /** When a run last finished with every category successful. */
  lastSuccessAt: string | null;
  /** No successful run for HOUSEKEEPING_STALE_MS: retention is not working. */
  stale: boolean;
  isRunning: boolean;
}

// ── Settings Keys ───────────────────────────────────────────────────

const KEYS = {
  enabled: 'housekeeping:enabled',
  cron: 'housekeeping:cron',
  nginxLogsEnabled: 'housekeeping:nginx_logs:enabled',
  nginxLogsRetention: 'housekeeping:nginx_logs:retention_days',
  auditLogEnabled: 'housekeeping:audit_log:enabled',
  auditLogRetention: 'housekeeping:audit_log:retention_days',
  dismissedAlertsEnabled: 'housekeeping:dismissed_alerts:enabled',
  dismissedAlertsRetention: 'housekeeping:dismissed_alerts:retention_days',
  deliveryLogEnabled: 'housekeeping:delivery_log:enabled',
  deliveryLogRetention: 'housekeeping:delivery_log:retention_days',
  structuredLogsEnabled: 'housekeeping:structured_logs:enabled',
  structuredLogsMaxRows: 'housekeeping:structured_logs:max_rows',
  structuredLogsMaxSizeBytes: 'housekeeping:structured_logs:max_size_bytes',
  clickHouseInternalsEnabled: 'housekeeping:clickhouse_internals:enabled',
  clickHouseInternalsMaxSizeBytes: 'housekeeping:clickhouse_internals:max_size_bytes',
  orphanedAIArtifactsEnabled: 'housekeeping:orphaned_ai_artifacts:enabled',
  internalRegistryRetention: 'housekeeping:internal_registry:retention_successful_artifacts',
  orphanedVolumesEnabled: 'housekeeping:orphaned_volumes:enabled',
  orphanedVolumesRetention: 'housekeeping:orphaned_volumes:retention_days',
  /** { [nodeId]: { [volumeName]: ISO time the volume was first seen unused } } */
  orphanedVolumesUnusedSince: 'housekeeping:orphaned_volumes:unused_since',
  dockerPruneEnabled: 'housekeeping:docker_prune:enabled',
  orphanedCertsEnabled: 'housekeeping:orphaned_certs:enabled',
  acmeCleanupEnabled: 'housekeeping:acme_cleanup:enabled',
  operationHistoryEnabled: 'housekeeping:operation_history:enabled',
  operationHistoryRetention: 'housekeeping:operation_history:retention_days',
  oauthCleanupEnabled: 'housekeeping:oauth_cleanup:enabled',
  expiredTokensEnabled: 'housekeeping:expired_tokens:enabled',
  expiredTokensRetention: 'housekeeping:expired_tokens:retention_days',
  inferenceUsageEnabled: 'housekeeping:inference_usage:enabled',
  inferenceUsageRetention: 'housekeeping:inference_usage:retention_days',
  buildLogsEnabled: 'housekeeping:build_logs:enabled',
  buildLogsRetention: 'housekeeping:build_logs:retention_days',
  buildLogsMaxSizeBytes: 'housekeeping:build_logs:max_size_bytes',
  hostFilesEnabled: 'housekeeping:host_files:enabled',
  /** { [nodeId]: { [volumeName]: ISO time it was first seen used by a container Opfield created } } */
  orphanedVolumesOpfieldOwned: 'housekeeping:orphaned_volumes:opfield_owned',
  lastSuccessAt: 'housekeeping:last_success_at',
  /**
   * Since when Housekeeping is watched for a successful run when none is known: the update that introduced the check
   * (migration 0260) or the first look of a new install. Not a run: the stats never show it as one.
   */
  successBaselineAt: 'housekeeping:success_baseline_at',
  lastRunResult: 'housekeeping:last_run_result',
  runHistory: 'housekeeping:run_history',
} as const;

const DEFAULTS: Record<string, unknown> = {
  [KEYS.enabled]: true,
  [KEYS.cron]: '0 2 * * *',
  [KEYS.nginxLogsEnabled]: true,
  [KEYS.nginxLogsRetention]: 30,
  [KEYS.auditLogEnabled]: true,
  [KEYS.auditLogRetention]: 90,
  [KEYS.dismissedAlertsEnabled]: true,
  [KEYS.dismissedAlertsRetention]: 30,
  [KEYS.deliveryLogEnabled]: true,
  [KEYS.deliveryLogRetention]: 7,
  [KEYS.structuredLogsEnabled]: true,
  [KEYS.structuredLogsMaxRows]: 100_000,
  [KEYS.structuredLogsMaxSizeBytes]: 10 * 1024 * 1024 * 1024,
  [KEYS.clickHouseInternalsMaxSizeBytes]: 512 * 1024 * 1024,
  [KEYS.orphanedAIArtifactsEnabled]: true,
  [KEYS.internalRegistryRetention]: REGISTRY_BUILDS_KEPT_PER_CONTAINER,
  [KEYS.orphanedVolumesEnabled]: true,
  // An anonymous volume of a container Opfield removed: kept 3 days in case it is needed, then removed.
  [KEYS.orphanedVolumesRetention]: 3,
  [KEYS.dockerPruneEnabled]: true,
  [KEYS.orphanedCertsEnabled]: true,
  [KEYS.acmeCleanupEnabled]: true,
  [KEYS.operationHistoryEnabled]: true,
  [KEYS.operationHistoryRetention]: 90,
  [KEYS.oauthCleanupEnabled]: true,
  [KEYS.expiredTokensEnabled]: true,
  [KEYS.expiredTokensRetention]: DEFAULT_EXPIRED_TOKEN_RETENTION_DAYS,
  [KEYS.inferenceUsageEnabled]: true,
  [KEYS.inferenceUsageRetention]: DEFAULT_INFERENCE_USAGE_RETENTION_DAYS,
  [KEYS.buildLogsEnabled]: true,
  [KEYS.buildLogsRetention]: DEFAULT_BUILD_LOG_RETENTION_DAYS,
  [KEYS.buildLogsMaxSizeBytes]: DEFAULT_BUILD_LOG_MAX_SIZE_BYTES,
  [KEYS.hostFilesEnabled]: true,
};

const MAX_HISTORY = 20;

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

type UnusedVolumeState = Record<string, Record<string, string>>;
type OrphanedVolumeCandidate = { nodeId: string; name: string; sizeBytes?: number };

/** One nginx daemon's log pass (ConfigureNginxLogsCommand result detail); zeros for what it does not carry. */
function parseNginxLogPass(detail: string | undefined): {
  removedFiles: number;
  truncatedFiles: number;
  freedBytes: number;
} {
  const pass = { removedFiles: 0, truncatedFiles: 0, freedBytes: 0 };
  if (!detail) return pass;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    for (const key of Object.keys(pass) as Array<keyof typeof pass>) {
      const value = Number(parsed[key]);
      if (Number.isFinite(value) && value > 0) pass[key] = value;
    }
  } catch {
    // An unreadable detail counts nothing.
  }
  return pass;
}

// ── Service ─────────────────────────────────────────────────────────

export class HousekeepingService {
  private running = false;
  private pagesMaintenanceService?: {
    run(): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }>;
  };
  private internalRegistryMaintenanceService?: DockerInternalRegistryService;
  /** Serializes orphaned-volume scans so concurrent stats/run scans cannot lose each other's tracking updates. */
  private orphanedVolumeScanQueue: Promise<void> = Promise.resolve();
  /** Latest tracking state when persisting it failed; preferred over the stale stored copy until a write succeeds. */
  private unsavedUnusedVolumeState: UnusedVolumeState | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly dockerService: DockerService,
    readonly _nodeDispatch: NodeDispatchService,
    readonly _env: Env
  ) {}

  setPagesMaintenanceService(service: { run(): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> }): void {
    this.pagesMaintenanceService = service;
  }

  setInternalRegistryMaintenanceService(service: DockerInternalRegistryService): void {
    this.internalRegistryMaintenanceService = service;
  }

  // ── Config ──────────────────────────────────────────────────────

  async getConfig(): Promise<HousekeepingConfig> {
    const rows = await this.db
      .select()
      .from(settings)
      .where(sql`${settings.key} LIKE 'housekeeping:%' OR ${settings.key} = ${LOGGING_SETTINGS_KEY}`);

    const map = new Map(rows.map((r) => [r.key, r.value]));
    const loggingSettings = map.get(LOGGING_SETTINGS_KEY) as { mode?: unknown } | undefined;
    const clickHouseInternalsDefault = loggingSettings?.mode === 'local';
    const get = <T>(key: string, fallback: T): T => {
      const v = map.get(key);
      return v !== undefined && v !== null ? (v as T) : fallback;
    };

    return {
      enabled: get(KEYS.enabled, DEFAULTS[KEYS.enabled] as boolean),
      cronExpression: get(KEYS.cron, DEFAULTS[KEYS.cron] as string),
      nginxLogs: {
        enabled: get(KEYS.nginxLogsEnabled, DEFAULTS[KEYS.nginxLogsEnabled] as boolean),
        retentionDays: get(KEYS.nginxLogsRetention, DEFAULTS[KEYS.nginxLogsRetention] as number),
      },
      auditLog: {
        enabled: get(KEYS.auditLogEnabled, DEFAULTS[KEYS.auditLogEnabled] as boolean),
        retentionDays: get(KEYS.auditLogRetention, DEFAULTS[KEYS.auditLogRetention] as number),
      },
      dismissedAlerts: {
        enabled: get(KEYS.dismissedAlertsEnabled, DEFAULTS[KEYS.dismissedAlertsEnabled] as boolean),
        retentionDays: get(KEYS.dismissedAlertsRetention, DEFAULTS[KEYS.dismissedAlertsRetention] as number),
      },
      deliveryLog: {
        enabled: get(KEYS.deliveryLogEnabled, DEFAULTS[KEYS.deliveryLogEnabled] as boolean),
        retentionDays: get(KEYS.deliveryLogRetention, DEFAULTS[KEYS.deliveryLogRetention] as number),
      },
      structuredLogs: {
        enabled: get(KEYS.structuredLogsEnabled, DEFAULTS[KEYS.structuredLogsEnabled] as boolean),
        maxRows: get(KEYS.structuredLogsMaxRows, DEFAULTS[KEYS.structuredLogsMaxRows] as number),
        maxSizeBytes: get(KEYS.structuredLogsMaxSizeBytes, DEFAULTS[KEYS.structuredLogsMaxSizeBytes] as number),
      },
      clickHouseInternals: {
        enabled: get(KEYS.clickHouseInternalsEnabled, clickHouseInternalsDefault),
        maxSizeBytes: get(
          KEYS.clickHouseInternalsMaxSizeBytes,
          DEFAULTS[KEYS.clickHouseInternalsMaxSizeBytes] as number
        ),
      },
      orphanedAIArtifacts: {
        enabled: get(KEYS.orphanedAIArtifactsEnabled, DEFAULTS[KEYS.orphanedAIArtifactsEnabled] as boolean),
      },
      internalRegistry: {
        enabled: true,
        // Fixed: the running and the rollback build per container. Reported for released clients.
        retentionSuccessfulArtifacts: REGISTRY_BUILDS_KEPT_PER_CONTAINER,
      },
      orphanedVolumes: {
        enabled: get(KEYS.orphanedVolumesEnabled, DEFAULTS[KEYS.orphanedVolumesEnabled] as boolean),
        retentionDays: get(KEYS.orphanedVolumesRetention, DEFAULTS[KEYS.orphanedVolumesRetention] as number),
      },
      dockerPrune: {
        enabled: get(KEYS.dockerPruneEnabled, DEFAULTS[KEYS.dockerPruneEnabled] as boolean),
      },
      orphanedCerts: {
        enabled: get(KEYS.orphanedCertsEnabled, DEFAULTS[KEYS.orphanedCertsEnabled] as boolean),
      },
      acmeCleanup: {
        enabled: get(KEYS.acmeCleanupEnabled, DEFAULTS[KEYS.acmeCleanupEnabled] as boolean),
      },
      operationHistory: {
        enabled: get(KEYS.operationHistoryEnabled, DEFAULTS[KEYS.operationHistoryEnabled] as boolean),
        retentionDays: get(KEYS.operationHistoryRetention, DEFAULTS[KEYS.operationHistoryRetention] as number),
      },
      expiredTokens: {
        enabled: get(KEYS.expiredTokensEnabled, DEFAULTS[KEYS.expiredTokensEnabled] as boolean),
        retentionDays: get(KEYS.expiredTokensRetention, DEFAULTS[KEYS.expiredTokensRetention] as number),
      },
      oauthCleanup: {
        enabled: get(KEYS.oauthCleanupEnabled, DEFAULTS[KEYS.oauthCleanupEnabled] as boolean),
      },
      inferenceUsage: {
        enabled: get(KEYS.inferenceUsageEnabled, DEFAULTS[KEYS.inferenceUsageEnabled] as boolean),
        retentionDays: get(KEYS.inferenceUsageRetention, DEFAULTS[KEYS.inferenceUsageRetention] as number),
      },
      buildLogs: {
        enabled: get(KEYS.buildLogsEnabled, DEFAULTS[KEYS.buildLogsEnabled] as boolean),
        retentionDays: get(KEYS.buildLogsRetention, DEFAULTS[KEYS.buildLogsRetention] as number),
        maxSizeBytes: get(KEYS.buildLogsMaxSizeBytes, DEFAULTS[KEYS.buildLogsMaxSizeBytes] as number),
      },
      hostFiles: {
        enabled: get(KEYS.hostFilesEnabled, DEFAULTS[KEYS.hostFilesEnabled] as boolean),
      },
    };
  }

  async updateConfig(partial: DeepPartial<HousekeepingConfig>): Promise<HousekeepingConfig> {
    const updates: Array<[string, unknown]> = [];

    if (partial.enabled !== undefined) updates.push([KEYS.enabled, partial.enabled]);
    if (partial.cronExpression !== undefined) updates.push([KEYS.cron, partial.cronExpression]);
    if (partial.nginxLogs?.enabled !== undefined) updates.push([KEYS.nginxLogsEnabled, partial.nginxLogs.enabled]);
    if (partial.nginxLogs?.retentionDays !== undefined)
      updates.push([KEYS.nginxLogsRetention, partial.nginxLogs.retentionDays]);
    if (partial.auditLog?.enabled !== undefined) updates.push([KEYS.auditLogEnabled, partial.auditLog.enabled]);
    if (partial.auditLog?.retentionDays !== undefined)
      updates.push([KEYS.auditLogRetention, partial.auditLog.retentionDays]);
    if (partial.dismissedAlerts?.enabled !== undefined)
      updates.push([KEYS.dismissedAlertsEnabled, partial.dismissedAlerts.enabled]);
    if (partial.dismissedAlerts?.retentionDays !== undefined)
      updates.push([KEYS.dismissedAlertsRetention, partial.dismissedAlerts.retentionDays]);
    if (partial.deliveryLog?.enabled !== undefined)
      updates.push([KEYS.deliveryLogEnabled, partial.deliveryLog.enabled]);
    if (partial.deliveryLog?.retentionDays !== undefined)
      updates.push([KEYS.deliveryLogRetention, partial.deliveryLog.retentionDays]);
    if (partial.structuredLogs?.enabled !== undefined)
      updates.push([KEYS.structuredLogsEnabled, partial.structuredLogs.enabled]);
    if (partial.structuredLogs?.maxRows !== undefined)
      updates.push([KEYS.structuredLogsMaxRows, partial.structuredLogs.maxRows]);
    if (partial.structuredLogs?.maxSizeBytes !== undefined)
      updates.push([KEYS.structuredLogsMaxSizeBytes, partial.structuredLogs.maxSizeBytes]);
    if (partial.clickHouseInternals?.enabled !== undefined)
      updates.push([KEYS.clickHouseInternalsEnabled, partial.clickHouseInternals.enabled]);
    if (partial.clickHouseInternals?.maxSizeBytes !== undefined)
      updates.push([KEYS.clickHouseInternalsMaxSizeBytes, partial.clickHouseInternals.maxSizeBytes]);
    if (partial.orphanedAIArtifacts?.enabled !== undefined)
      updates.push([KEYS.orphanedAIArtifactsEnabled, partial.orphanedAIArtifacts.enabled]);
    // internalRegistry.retentionSuccessfulArtifacts is accepted from released clients and ignored: the count is fixed.
    if (partial.orphanedVolumes?.enabled !== undefined)
      updates.push([KEYS.orphanedVolumesEnabled, partial.orphanedVolumes.enabled]);
    if (partial.orphanedVolumes?.retentionDays !== undefined)
      updates.push([KEYS.orphanedVolumesRetention, partial.orphanedVolumes.retentionDays]);
    if (partial.dockerPrune?.enabled !== undefined)
      updates.push([KEYS.dockerPruneEnabled, partial.dockerPrune.enabled]);
    if (partial.orphanedCerts?.enabled !== undefined)
      updates.push([KEYS.orphanedCertsEnabled, partial.orphanedCerts.enabled]);
    if (partial.acmeCleanup?.enabled !== undefined)
      updates.push([KEYS.acmeCleanupEnabled, partial.acmeCleanup.enabled]);
    if (partial.operationHistory?.enabled !== undefined)
      updates.push([KEYS.operationHistoryEnabled, partial.operationHistory.enabled]);
    if (partial.operationHistory?.retentionDays !== undefined)
      updates.push([KEYS.operationHistoryRetention, partial.operationHistory.retentionDays]);
    if (partial.oauthCleanup?.enabled !== undefined)
      updates.push([KEYS.oauthCleanupEnabled, partial.oauthCleanup.enabled]);
    if (partial.expiredTokens?.enabled !== undefined)
      updates.push([KEYS.expiredTokensEnabled, partial.expiredTokens.enabled]);
    if (partial.expiredTokens?.retentionDays !== undefined)
      updates.push([KEYS.expiredTokensRetention, partial.expiredTokens.retentionDays]);
    if (partial.inferenceUsage?.enabled !== undefined)
      updates.push([KEYS.inferenceUsageEnabled, partial.inferenceUsage.enabled]);
    if (partial.inferenceUsage?.retentionDays !== undefined)
      updates.push([KEYS.inferenceUsageRetention, partial.inferenceUsage.retentionDays]);
    if (partial.buildLogs?.enabled !== undefined) updates.push([KEYS.buildLogsEnabled, partial.buildLogs.enabled]);
    if (partial.buildLogs?.retentionDays !== undefined)
      updates.push([KEYS.buildLogsRetention, partial.buildLogs.retentionDays]);
    if (partial.buildLogs?.maxSizeBytes !== undefined)
      updates.push([KEYS.buildLogsMaxSizeBytes, partial.buildLogs.maxSizeBytes]);
    if (partial.hostFiles?.enabled !== undefined) updates.push([KEYS.hostFilesEnabled, partial.hostFiles.enabled]);

    await this.db.transaction(async (tx) => {
      for (const [key, value] of updates) {
        await tx
          .insert(settings)
          .values({ key, value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });
      }
    });

    const config = await this.getConfig();
    if (partial.nginxLogs?.enabled !== undefined || partial.nginxLogs?.retentionDays !== undefined) {
      // Nodes apply a changed retention now, not at the next run.
      void this.rotateNginxLogs(config.nginxLogs.enabled ? config.nginxLogs.retentionDays : 0).catch((error) => {
        logger.warn('Failed to send the nginx log retention to nginx nodes', { error });
      });
    }
    return config;
  }

  // ── Stats ───────────────────────────────────────────────────────

  async getStats(): Promise<HousekeepingStats> {
    const [
      nginxLogs,
      auditLogStats,
      alertStats,
      deliveryLog,
      clickHouse,
      orphanedAIArtifacts,
      internalRegistry,
      orphanedVolumes,
      orphanedCerts,
      acme,
      docker,
      operationHistory,
      oauthCleanup,
      expiredTokens,
      inferenceUsage,
      buildLogs,
      hostFiles,
      diskUsage,
      lastRun,
      staleness,
    ] = await Promise.all([
      this.getNginxLogStats(),
      this.getAuditLogStats(),
      this.getDismissedAlertStats(),
      this.getDeliveryLogStats(),
      Promise.resolve(this.loggingMaintenanceService?.getSnapshot() ?? null),
      this.getOrphanedAIArtifactStats(),
      this.getInternalRegistryStats(),
      this.getOrphanedVolumeStats(),
      this.getOrphanedCertStats(),
      this.getAcmeChallengeStats(),
      this.getDockerImageStats(),
      this.getOperationHistoryStats(),
      this.getOAuthCleanupStats(),
      this.getExpiredTokenStats(),
      this.getInferenceUsageStats(),
      this.getBuildLogStats(),
      this.getHostFileStats(),
      this.getDiskUsage(),
      this.getLastRunResult(),
      this.getStalenessAnchor(),
    ]);

    return {
      nginxLogs,
      auditLog: auditLogStats,
      dismissedAlerts: alertStats,
      deliveryLog,
      structuredLogs: {
        totalRows: clickHouse?.structured.rows ?? 0,
        totalSizeBytes: clickHouse?.structured.bytes ?? 0,
        status: clickHouse?.status ?? 'disabled',
      },
      clickHouseInternals: {
        totalRows: clickHouse?.internal.rows ?? 0,
        totalSizeBytes: clickHouse?.internal.bytes ?? 0,
        status: clickHouse?.status ?? 'disabled',
        capBytes: clickHouse?.internal.capBytes ?? 0,
      },
      orphanedAIArtifacts,
      internalRegistry,
      orphanedVolumes,
      orphanedCerts,
      acmeChallenges: acme,
      dockerImages: docker,
      operationHistory,
      oauthCleanup,
      expiredTokens,
      inferenceUsage,
      buildLogs,
      hostFiles,
      diskUsage,
      lastRun,
      lastSuccessAt: staleness.lastSuccessAt,
      stale: isHousekeepingStale(staleness.since),
      isRunning: this.running,
    };
  }

  // ── Run All ─────────────────────────────────────────────────────

  /**
   * Runs every enabled category. `safetyOnly` (the scheduled run while the Housekeeping switch is off) runs only the
   * categories that keep Opfield's own data bounded (SAFETY_CATEGORIES). Every category gets CATEGORY_TIMEOUT_MS, so
   * one that hangs cannot stop the others or keep the next runs from starting.
   */
  async runAll(
    trigger: HousekeepingTrigger,
    userId?: string,
    options: { safetyOnly?: boolean } = {}
  ): Promise<HousekeepingRunResult> {
    if (this.running) {
      throw new Error('Housekeeping is already running');
    }

    this.running = true;
    const startedAt = new Date().toISOString();
    const categories: CategoryResult[] = [];

    try {
      const config = await this.getConfig();
      const plan: Array<{
        name: string;
        enabled: boolean;
        run: () => Promise<{ itemsCleaned: number; spaceFreedBytes?: number }>;
      }> = [
        {
          name: 'Pages',
          enabled: !!this.pagesMaintenanceService,
          run: () => this.pagesMaintenanceService!.run(),
        },
        {
          name: 'Internal Registry',
          enabled: !!this.internalRegistryMaintenanceService,
          run: async () => {
            const run = await this.internalRegistryMaintenanceService!.runGarbageCollection({
              requestedById: userId ?? null,
              reason:
                trigger === 'scheduled'
                  ? 'scheduled housekeeping'
                  : trigger === 'low-disk'
                    ? 'housekeeping for a full Opfield disk'
                    : 'housekeeping run by a user',
            });
            const candidateIds = Array.isArray(run.progress?.candidateArtifactIds)
              ? run.progress.candidateArtifactIds
              : [];
            return { itemsCleaned: candidateIds.length };
          },
        },
        {
          name: 'Nginx Logs',
          enabled: config.nginxLogs.enabled,
          run: () => this.rotateNginxLogs(config.nginxLogs.retentionDays),
        },
        {
          name: 'Audit Log',
          enabled: config.auditLog.enabled,
          run: () => this.cleanAuditLog(config.auditLog.retentionDays),
        },
        {
          name: 'Dismissed Alerts',
          enabled: config.dismissedAlerts.enabled,
          run: () => this.cleanDismissedAlerts(config.dismissedAlerts.retentionDays),
        },
        {
          name: 'Delivery Log',
          enabled: config.deliveryLog.enabled,
          run: () => this.cleanDeliveryLog(config.deliveryLog.retentionDays),
        },
        {
          name: 'Structured Logs',
          enabled: config.structuredLogs.enabled,
          run: () => this.cleanStructuredLogs(config.structuredLogs, config.clickHouseInternals),
        },
        {
          name: 'ClickHouse Internals',
          enabled: config.clickHouseInternals.enabled,
          run: () =>
            this.cleanClickHouseInternals(
              config.structuredLogs.enabled ? config.structuredLogs : undefined,
              config.clickHouseInternals
            ),
        },
        {
          name: 'Orphaned AI Artifacts',
          enabled: config.orphanedAIArtifacts.enabled,
          run: () => this.cleanOrphanedAIArtifacts(),
        },
        {
          name: 'Orphaned Volumes',
          enabled: config.orphanedVolumes.enabled,
          run: () => this.cleanOrphanedVolumes(config.orphanedVolumes.retentionDays, userId ?? null),
        },
        { name: 'Orphaned Certs', enabled: config.orphanedCerts.enabled, run: () => this.cleanOrphanedCerts() },
        { name: 'ACME Challenges', enabled: config.acmeCleanup.enabled, run: () => this.cleanAcmeChallenges() },
        { name: 'Docker Images', enabled: config.dockerPrune.enabled, run: () => this.pruneDockerImages() },
        {
          name: 'Operation History',
          enabled: !!config.operationHistory?.enabled,
          run: () => this.cleanOperationHistory(config.operationHistory.retentionDays),
        },
        {
          name: 'Build Logs',
          enabled: config.buildLogs.enabled,
          run: () => this.cleanBuildLogs(config.buildLogs),
        },
        {
          name: 'Inference Usage',
          enabled: config.inferenceUsage.enabled,
          run: () => this.cleanInferenceUsage(config.inferenceUsage.retentionDays),
        },
        {
          name: 'Expired OAuth Grants',
          enabled: !!config.oauthCleanup?.enabled,
          run: () => this.cleanExpiredOAuthGrants(),
        },
        {
          name: 'Expired Tokens',
          enabled: !!config.expiredTokens?.enabled,
          run: () => this.cleanExpiredTokens(config.expiredTokens.retentionDays),
        },
        { name: 'Opfield Host Files', enabled: config.hostFiles.enabled, run: () => this.cleanHostFiles() },
      ];

      if (!config.nginxLogs.enabled) {
        // Off: nodes keep rotated logs without an age limit (their size caps stay). Sent on every run so that nodes
        // added or offline when the setting changed follow it too.
        await this.rotateNginxLogs(0).catch((error) => {
          logger.warn('Failed to turn off the nginx log retention on nginx nodes', { error });
        });
      }

      for (const category of plan) {
        if (!category.enabled) continue;
        if (options.safetyOnly && !SAFETY_CATEGORIES.has(category.name)) continue;
        categories.push(await this.runCategory(category.name, category.run));
      }

      const completedAt = new Date().toISOString();
      const result: HousekeepingRunResult = {
        startedAt,
        completedAt,
        trigger,
        triggeredBy: userId,
        totalDurationMs: Date.now() - new Date(startedAt).getTime(),
        categories,
        overallSuccess: categories.every((c) => c.success),
      };

      await this.saveRunResult(result);
      logger.info('Housekeeping completed', {
        trigger,
        durationMs: result.totalDurationMs,
        categories: categories.length,
        success: result.overallSuccess,
      });

      return result;
    } finally {
      this.running = false;
    }
  }

  private lowDiskRunAt = 0;

  /**
   * Called with the fullest Opfield host disk every minute: at LOW_DISK_RUN_PERCENT or more, runs housekeeping at
   * once (every enabled category, whether or not the Housekeeping switch is on, at most once an hour) instead of
   * waiting for the nightly run.
   */
  async onHostDiskUsage(usedPercent: number | null, now = Date.now()): Promise<HousekeepingRunResult | null> {
    if (usedPercent === null || usedPercent < LOW_DISK_RUN_PERCENT) return null;
    if (this.running || now - this.lowDiskRunAt < LOW_DISK_RUN_COOLDOWN_MS) return null;
    this.lowDiskRunAt = now;
    logger.warn('An Opfield host disk is almost full; running housekeeping now', { usedPercent });
    return this.runAll('low-disk');
  }

  async getRunHistory(): Promise<HousekeepingRunResult[]> {
    const row = await this.db.select().from(settings).where(eq(settings.key, KEYS.runHistory)).limit(1);
    if (!row.length) return [];
    return ((row[0].value as HousekeepingRunResult[]) || []).slice(0, MAX_HISTORY);
  }

  // ── Category Implementations ────────────────────────────────────

  /**
   * Sends the retention to every online nginx daemon that bounds its logs (nginx_log_budget_v1); each keeps it, deletes
   * rotated logs past it and reports what it removed. The daemons cap log sizes and remove the logs of deleted routes
   * on their own every 5 minutes, whatever this sends. Older daemons are skipped: their logs stay with distro logrotate
   * until they are updated.
   */
  private async rotateNginxLogs(retentionDays: number): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    const rows = await this.db
      .select({ id: nodes.id, capabilities: nodes.capabilities })
      .from(nodes)
      .where(and(eq(nodes.type, 'nginx'), eq(nodes.status, 'online')));
    const targets = rows.filter((row) => {
      const reported = (row.capabilities as Record<string, unknown> | null)?.capabilities;
      return Array.isArray(reported) && reported.includes(NGINX_LOG_BUDGET_CAPABILITY);
    });
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;
    const failures: string[] = [];
    for (const target of targets) {
      try {
        const result = await this._nodeDispatch.configureNginxLogs(target.id, retentionDays);
        if (!result.success) {
          failures.push(`${target.id}: ${result.error || 'failed'}`);
          continue;
        }
        const pass = parseNginxLogPass(result.detail);
        itemsCleaned += pass.removedFiles + pass.truncatedFiles;
        spaceFreedBytes += pass.freedBytes;
      } catch (error) {
        failures.push(`${target.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      logger.warn('Nginx log retention failed on some nodes', { failures });
      if (failures.length === targets.length) throw new Error(`Nginx log retention failed: ${failures.join('; ')}`);
    }
    return { itemsCleaned, spaceFreedBytes };
  }

  private async cleanAuditLog(retentionDays: number): Promise<{ itemsCleaned: number }> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - retentionDays);

    const [result, siemItemsCleaned] = await Promise.all([
      this.db.delete(auditLog).where(lt(auditLog.createdAt, threshold)).returning({ id: auditLog.id }),
      this.siemDeliveryService?.cleanOldEntries(retentionDays) ?? Promise.resolve(0),
    ]);

    return { itemsCleaned: result.length + siemItemsCleaned };
  }

  private async cleanDismissedAlerts(retentionDays: number): Promise<{ itemsCleaned: number }> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - retentionDays);

    const result = await this.db
      .delete(alerts)
      .where(and(eq(alerts.dismissed, true), lt(alerts.createdAt, threshold)))
      .returning({ id: alerts.id });
    // A check that failed every day added an open alert a day: keep the newest of each resource and kind, and drop
    // open alerts nobody looked at for UNDISMISSED_ALERT_RETENTION_DAYS (a failure that continues raises a new one).
    const undismissedBefore = new Date(Date.now() - UNDISMISSED_ALERT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const duplicates = await this.db.execute(sql`DELETE FROM "alerts" WHERE "id" IN (
      SELECT "id" FROM (
        SELECT "id", row_number() OVER (PARTITION BY "type", "resource_type", "resource_id" ORDER BY "created_at" DESC, "id" DESC) AS "rn"
        FROM "alerts" WHERE "dismissed" = false
      ) "ranked" WHERE "ranked"."rn" > 1
    )`);
    const stale = await this.db
      .delete(alerts)
      .where(and(eq(alerts.dismissed, false), lt(alerts.createdAt, undismissedBefore)))
      .returning({ id: alerts.id });

    return {
      itemsCleaned: result.length + Number((duplicates as { rowCount?: number | null }).rowCount ?? 0) + stale.length,
    };
  }

  private notifDeliveryService?: NotificationDeliveryService;
  setNotifDeliveryService(svc: NotificationDeliveryService) {
    this.notifDeliveryService = svc;
  }

  private siemDeliveryService?: SiemDeliveryService;
  setSiemDeliveryService(svc: SiemDeliveryService) {
    this.siemDeliveryService = svc;
  }

  private loggingMaintenanceService?: LoggingMaintenanceService;
  private loggingFeature?: Pick<LoggingFeatureService, 'isEnabled'>;
  setLoggingMaintenanceService(
    svc: LoggingMaintenanceService,
    loggingFeature?: Pick<LoggingFeatureService, 'isEnabled'>
  ) {
    this.loggingMaintenanceService = svc;
    this.loggingFeature = loggingFeature;
  }

  /** None while structured logging is off (always so on Community): there is no ClickHouse to clean. */
  private activeLoggingMaintenance(): LoggingMaintenanceService | undefined {
    return this.loggingFeature?.isEnabled() === false ? undefined : this.loggingMaintenanceService;
  }

  private sandboxArtifactService?: AISandboxArtifactService;
  setSandboxArtifactService(svc: AISandboxArtifactService) {
    this.sandboxArtifactService = svc;
    // Files of deleted conversations (and of deleted users, whose conversations cascade) are orphans too.
    svc.setConversationLookup(async (conversationIds) => {
      const existing = new Set<string>();
      for (let index = 0; index < conversationIds.length; index += 1000) {
        const rows = await this.db
          .select({ id: aiConversations.id })
          .from(aiConversations)
          .where(inArray(aiConversations.id, conversationIds.slice(index, index + 1000)));
        for (const row of rows) existing.add(row.id);
      }
      return existing;
    });
  }

  private redis: RedisClient | null = null;
  private hostDisks: OpfieldHostDiskReader | null = null;
  private diskUsageReader: OpfieldDiskUsageReader | null = null;
  /** Redis and the Opfield host disks, for the disk usage at the top of Housekeeping. */
  setDiskUsageSources(redis: RedisClient | null, hostDisks: OpfieldHostDiskReader | null) {
    this.redis = redis;
    this.hostDisks = hostDisks;
    this.diskUsageReader = null;
  }

  private exportLeftovers?: { cleanLeftovers(): Promise<number> };
  private archiveSpool?: { sweepOrphanedSpools(): Promise<{ removed: number; bytes: number }> };
  /** What crashed configuration exports and MCP archive transfers left on the Opfield host (Opfield Host Files). */
  setHostFileSources(
    exportLeftovers: { cleanLeftovers(): Promise<number> } | undefined,
    archiveSpool: { sweepOrphanedSpools(): Promise<{ removed: number; bytes: number }> } | undefined
  ) {
    this.exportLeftovers = exportLeftovers;
    this.archiveSpool = archiveSpool;
  }

  private dockerManagementService?: DockerManagementService;
  setDockerManagementService(svc: DockerManagementService) {
    this.dockerManagementService = svc;
  }

  private imageCleanupService?: Pick<DockerImageCleanupService, 'enforceNode' | 'onlineDockerNodeIds'>;
  /** Applies the image cleanup settings to build images and removes dangling images on every Docker node. */
  setImageCleanupService(svc: Pick<DockerImageCleanupService, 'enforceNode' | 'onlineDockerNodeIds'>) {
    this.imageCleanupService = svc;
  }

  private systemCertificateLifecycle?: SystemCertificateLifecycleService;
  setSystemCertificateLifecycleService(svc: SystemCertificateLifecycleService) {
    this.systemCertificateLifecycle = svc;
  }

  private dockerTaskService?: Pick<DockerTaskService, 'cleanup'>;
  setDockerTaskService(svc: Pick<DockerTaskService, 'cleanup'>) {
    this.dockerTaskService = svc;
  }

  /** Finished tasks (24 h, fixed) and operation history older than the retention period. */
  private async cleanOperationHistory(retentionDays: number): Promise<{ itemsCleaned: number }> {
    const tasks = (await this.dockerTaskService?.cleanup()) ?? 0;
    const history = await cleanOperationHistory(this.db, retentionDays);
    if (history.total > 0) logger.info('Removed old operation history', { retentionDays, ...history.removed });
    return { itemsCleaned: tasks + history.total };
  }

  private async cleanBuildLogs(config: HousekeepingConfig['buildLogs']): Promise<{
    itemsCleaned: number;
    spaceFreedBytes: number;
  }> {
    const removed = await cleanBuildLogs(this.db, config);
    if (removed.builds > 0) logger.info('Removed old build logs', { ...config, ...removed });
    return { itemsCleaned: removed.builds, spaceFreedBytes: removed.bytes };
  }

  /** Settled inference requests past the retention period, old provider quota readings and unused price versions. */
  private async cleanInferenceUsage(retentionDays: number): Promise<{ itemsCleaned: number }> {
    const usage = await cleanInferenceUsage(this.db, retentionDays);
    const quota = await pruneInferenceQuotaSnapshots(this.db);
    const pricing = await pruneInferencePricingSnapshots(this.db, inferenceUsageCutoff(retentionDays));
    if (usage.requests + quota + pricing > 0) {
      logger.info('Removed old inference usage', {
        retentionDays,
        ...usage,
        quotaReadings: quota,
        priceVersions: pricing,
      });
    }
    return { itemsCleaned: usage.requests + quota + pricing };
  }

  /** The Opfield Host Files cleanup outside a run (shortly after start), when that category is on. */
  async cleanHostFilesNow(): Promise<void> {
    const config = await this.getConfig();
    if (!config.hostFiles.enabled) return;
    const result = await this.cleanHostFiles();
    if (result.itemsCleaned > 0) logger.info('Removed leftovers of interrupted work on the Opfield host', result);
  }

  /** Leftovers of interrupted work on the Opfield host. */
  private async cleanHostFiles(): Promise<{ itemsCleaned: number; spaceFreedBytes: number }> {
    const temp = await sweepTempLeftovers();
    const spool = (await this.archiveSpool?.sweepOrphanedSpools()) ?? { removed: 0, bytes: 0 };
    const exports =
      (await this.exportLeftovers?.cleanLeftovers().catch((error) => {
        logger.debug('Configuration export leftovers were not checked', { error });
        return 0;
      })) ?? 0;
    return { itemsCleaned: temp.removed + spool.removed + exports, spaceFreedBytes: temp.bytes + spool.bytes };
  }

  private auditService?: Pick<AuditService, 'log'>;
  private eventBus?: Pick<EventBusService, 'publish'>;
  /** Expired-token removals are audited and refresh their owners' token lists. */
  setTokenCleanupServices(auditService: Pick<AuditService, 'log'>, eventBus: Pick<EventBusService, 'publish'>) {
    this.auditService = auditService;
    this.eventBus = eventBus;
  }

  private async cleanExpiredTokens(retentionDays: number): Promise<{ itemsCleaned: number }> {
    const purged = await purgeExpiredTokens(this.db, retentionDays, {
      auditService: this.auditService,
      eventBus: this.eventBus,
    });
    if (purged.total > 0) logger.info('Removed expired tokens', { retentionDays, ...purged });
    return { itemsCleaned: purged.total };
  }

  private async getExpiredTokenStats(): Promise<{ count: number }> {
    try {
      const config = await this.getConfig();
      return { count: await countExpiredTokens(this.db, config.expiredTokens.retentionDays) };
    } catch {
      return { count: 0 };
    }
  }

  private async cleanExpiredOAuthGrants(): Promise<{ itemsCleaned: number }> {
    const purged = await purgeExpiredOAuthGrants(this.db);
    if (purged.total > 0) logger.info('Removed expired OAuth grants', purged.removed);
    return { itemsCleaned: purged.total };
  }

  private async cleanDeliveryLog(retentionDays: number): Promise<{ itemsCleaned: number }> {
    if (!this.notifDeliveryService) return { itemsCleaned: 0 };
    const count = await this.notifDeliveryService.cleanOldEntries(retentionDays);
    return { itemsCleaned: count };
  }

  private async cleanStructuredLogs(
    config: HousekeepingConfig['structuredLogs'],
    clickHouseInternals: HousekeepingConfig['clickHouseInternals']
  ) {
    const maintenance = this.activeLoggingMaintenance();
    if (!maintenance) return { itemsCleaned: 0, spaceFreedBytes: 0 };
    return maintenance.cleanupStructuredLogsAndRefresh(config, clickHouseInternals);
  }

  private async cleanClickHouseInternals(
    config: HousekeepingConfig['structuredLogs'] | undefined,
    clickHouseInternals: HousekeepingConfig['clickHouseInternals']
  ) {
    const maintenance = this.activeLoggingMaintenance();
    if (!maintenance) return { itemsCleaned: 0, spaceFreedBytes: 0 };
    return maintenance.cleanupInternalLogsAndRefresh(config, clickHouseInternals);
  }

  private async cleanOrphanedAIArtifacts(): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    if (!this.sandboxArtifactService) return { itemsCleaned: 0 };
    return this.sandboxArtifactService.cleanOrphanedArtifacts();
  }

  private async cleanOrphanedVolumes(
    retentionDays: number,
    userId: string | null
  ): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    if (!this.dockerManagementService) return { itemsCleaned: 0 };
    const { candidates } = await this.findOrphanedVolumes(retentionDays, 'cleanup');
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;

    for (const candidate of candidates) {
      try {
        await this.dockerManagementService.removeOrphanedAnonymousVolume(candidate.nodeId, candidate.name, userId);
        itemsCleaned += 1;
        spaceFreedBytes += candidate.sizeBytes ?? 0;
      } catch (error) {
        logger.warn('Failed to remove orphaned Docker volume', {
          nodeId: candidate.nodeId,
          name: candidate.name,
          error,
        });
      }
    }

    return { itemsCleaned, spaceFreedBytes };
  }

  private async cleanOrphanedCerts(): Promise<{ itemsCleaned: number }> {
    if (!this.systemCertificateLifecycle) return { itemsCleaned: 0 };
    return {
      itemsCleaned: await this.systemCertificateLifecycle.destroyRetiredPrivateKeys(
        SYSTEM_CERTIFICATE_KEY_RETENTION_DAYS
      ),
    };
  }

  private async cleanAcmeChallenges(): Promise<{ itemsCleaned: number }> {
    // ACME challenge files are managed by daemon nodes.
    logger.debug('ACME challenge cleanup is managed by daemon nodes');
    return { itemsCleaned: 0 };
  }

  private async pruneDockerImages(): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    let cleaned = 0;
    let freedBytes = 0;
    try {
      const selfInfo = await this.dockerService.inspectSelf();
      for (const image of await this.oldOpfieldHostImages(selfInfo)) {
        try {
          const delRes = await this.dockerRequest('DELETE', `/images/${encodeURIComponent(image.id)}`);
          if (delRes.statusCode === 200) {
            cleaned += 1;
            freedBytes += image.size;
          }
        } catch {
          // Keep cleaning other images.
        }
      }

      const labels = selfInfo.Config.Labels;
      const composeProject = labels['com.docker.compose.project'];
      if (composeProject) {
        const filters = JSON.stringify({
          status: ['exited'],
          label: [`com.docker.compose.project=${composeProject}`],
        });
        const containerRes = await this.dockerRequest(
          'GET',
          `/containers/json?all=true&filters=${encodeURIComponent(filters)}`
        );
        if (containerRes.statusCode === 200) {
          const containers = JSON.parse(containerRes.body) as Array<{ Id: string; Names: string[] }>;
          for (const c of containers) {
            try {
              await this.dockerService.removeContainer(c.Id);
              cleaned += 1;
            } catch {
              // Keep cleaning other sidecars.
            }
          }
        }
      }
    } catch (error) {
      logger.warn('Opfield host Docker pruning failed', { error });
    }

    for (const candidate of await this.getObsoleteConnectorImages()) {
      try {
        await this.dockerManagementService?.removeOpfieldInternalImage(candidate.nodeId, candidate.id);
        cleaned += 1;
        freedBytes += candidate.size;
      } catch (error) {
        logger.warn('Failed to remove obsolete Opfield connector image', {
          nodeId: candidate.nodeId,
          imageId: candidate.id,
          error,
        });
      }
    }
    const nodeImages = await this.applyNodeImageRetention(false);
    return { itemsCleaned: cleaned + nodeImages.count, spaceFreedBytes: freedBytes + nodeImages.bytes };
  }

  /**
   * On every online Docker node, the image cleanup rules (DockerImageCleanupService.enforceNode): each workload's
   * older images beyond its image cleanup setting, unused images nothing runs or names once old enough, and dangling
   * images. Catches what a missed or failed cleanup after a change left, and the leftovers of older releases.
   * `dryRun` counts them for the stats, those still within their minimum unused time included.
   */
  private async applyNodeImageRetention(dryRun: boolean): Promise<{ count: number; bytes: number }> {
    const cleanup = this.imageCleanupService;
    if (!cleanup) return { count: 0, bytes: 0 };
    let count = 0;
    let bytes = 0;
    let nodeIds: string[] = [];
    try {
      nodeIds = await cleanup.onlineDockerNodeIds();
    } catch (error) {
      logger.warn('Failed to list Docker nodes for image cleanup', { error });
    }
    for (const nodeId of nodeIds) {
      try {
        const result = await cleanup.enforceNode(nodeId, { dangling: true, dryRun });
        if (dryRun) {
          // Every old image the rules remove, also those still within their minimum unused time.
          const old = [...result.candidates, ...result.waiting];
          count += old.length;
          bytes += old.reduce((sum, candidate) => sum + candidate.size, 0);
        } else {
          count += result.removed.length;
          bytes += result.freedBytes;
        }
      } catch (error) {
        logger.warn('Node image cleanup failed', { nodeId, error });
      }
    }
    return { count, bytes };
  }

  // ── Stats Helpers ───────────────────────────────────────────────

  /** The nginx logs on the nginx nodes, from each daemon's last health report (nginx_log_budget_v1). */
  private async getNginxLogStats(): Promise<HousekeepingStats['nginxLogs']> {
    const rows = await this.db.select({ report: nodes.lastHealthReport }).from(nodes).where(eq(nodes.type, 'nginx'));
    let totalSizeBytes = 0;
    let fileCount = 0;
    let oldestUnix = 0;
    let reportingNodeCount = 0;
    for (const row of rows) {
      const usage = row.report?.nginxLogs;
      if (!usage) continue;
      reportingNodeCount += 1;
      totalSizeBytes += usage.bytes;
      fileCount += usage.files;
      if (usage.oldestUnix > 0 && (oldestUnix === 0 || usage.oldestUnix < oldestUnix)) oldestUnix = usage.oldestUnix;
    }
    return {
      totalSizeBytes,
      fileCount,
      oldestFile: oldestUnix > 0 ? new Date(oldestUnix * 1000).toISOString() : null,
      nodeCount: rows.length,
      reportingNodeCount,
    };
  }

  private async getAuditLogStats(): Promise<HousekeepingStats['auditLog']> {
    const [countResult] = await this.db.select({ total: count() }).from(auditLog);
    const [oldestResult] = await this.db.select({ oldest: min(auditLog.createdAt) }).from(auditLog);
    return {
      totalRows: countResult?.total ?? 0,
      oldestEntry: oldestResult?.oldest?.toISOString() ?? null,
    };
  }

  private async getDismissedAlertStats(): Promise<HousekeepingStats['dismissedAlerts']> {
    const [countResult] = await this.db.select({ total: count() }).from(alerts).where(eq(alerts.dismissed, true));
    const [oldestResult] = await this.db
      .select({ oldest: min(alerts.createdAt) })
      .from(alerts)
      .where(eq(alerts.dismissed, true));
    return {
      count: countResult?.total ?? 0,
      oldestAlert: oldestResult?.oldest?.toISOString() ?? null,
    };
  }

  private async getDeliveryLogStats(): Promise<HousekeepingStats['deliveryLog']> {
    if (!this.notifDeliveryService) return { total: 0, success: 0, failed: 0, retrying: 0 };
    return this.notifDeliveryService.getStats();
  }

  private async getOrphanedAIArtifactStats(): Promise<HousekeepingStats['orphanedAIArtifacts']> {
    if (!this.sandboxArtifactService) return { count: 0, totalSizeBytes: 0 };
    return this.sandboxArtifactService.getOrphanedStats();
  }

  private async getInternalRegistryStats(): Promise<HousekeepingStats['internalRegistry']> {
    if (!this.internalRegistryMaintenanceService) {
      return { totalSizeBytes: 0, capacityBytes: null, status: 'unavailable', lastGcAt: null };
    }
    const state = await this.internalRegistryMaintenanceService.getState();
    return {
      totalSizeBytes: state.storageUsedBytes,
      capacityBytes: state.storageCapacityBytes,
      status: state.status,
      lastGcAt: state.lastGcAt?.toISOString() ?? null,
    };
  }

  private async getOrphanedVolumeStats(): Promise<HousekeepingStats['orphanedVolumes']> {
    const config = await this.getConfig();
    const { candidates, unowned } = await this.findOrphanedVolumes(config.orphanedVolumes.retentionDays, 'preview');
    return {
      count: candidates.length,
      reclaimableBytes: candidates.reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0),
      unownedCount: unowned.length,
      unownedBytes: unowned.reduce((sum, volume) => sum + (volume.sizeBytes ?? 0), 0),
    };
  }

  private async getOrphanedCertStats(): Promise<HousekeepingStats['orphanedCerts']> {
    if (!this.systemCertificateLifecycle) {
      return { count: 0, certIds: [], currentCount: 0, supersededCount: 0, unknownCount: 0 };
    }
    return this.systemCertificateLifecycle.getPrivateKeyCleanupStats(SYSTEM_CERTIFICATE_KEY_RETENTION_DAYS);
  }

  private async getOperationHistoryStats(): Promise<HousekeepingStats['operationHistory']> {
    try {
      const config = await this.getConfig();
      return { count: await countOperationHistory(this.db, config.operationHistory.retentionDays) };
    } catch (error) {
      logger.debug('Failed to count old operation history', { error });
      return { count: 0 };
    }
  }

  private async getOAuthCleanupStats(): Promise<HousekeepingStats['oauthCleanup']> {
    try {
      return { count: await countExpiredOAuthGrants(this.db) };
    } catch (error) {
      logger.debug('Failed to count expired OAuth grants', { error });
      return { count: 0 };
    }
  }

  private async getInferenceUsageStats(): Promise<HousekeepingStats['inferenceUsage']> {
    try {
      const config = await this.getConfig();
      const [count, size] = await Promise.all([
        countExpiredInferenceUsage(this.db, config.inferenceUsage.retentionDays),
        this.db.execute(
          sql`SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0) AS "bytes" FROM pg_class c WHERE c.relname IN ('inference_requests', 'inference_request_attempts', 'inference_usage_ledger', 'inference_quota_snapshots')`
        ),
      ]);
      const bytes = Number(((size as unknown as { rows?: Array<{ bytes: unknown }> }).rows ?? [])[0]?.bytes ?? 0);
      return { count, totalSizeBytes: Number.isFinite(bytes) ? bytes : 0 };
    } catch (error) {
      logger.debug('Failed to measure inference usage records', { error });
      return { count: 0, totalSizeBytes: 0 };
    }
  }

  private async getBuildLogStats(): Promise<HousekeepingStats['buildLogs']> {
    const config = await this.getConfig();
    try {
      return { ...(await buildLogStats(this.db, config.buildLogs)), capBytes: config.buildLogs.maxSizeBytes };
    } catch (error) {
      logger.debug('Failed to measure build logs', { error });
      return { totalSizeBytes: 0, expiredBuilds: 0, capBytes: config.buildLogs.maxSizeBytes };
    }
  }

  private async getHostFileStats(): Promise<HousekeepingStats['hostFiles']> {
    const temp = await sweepTempLeftovers({ dryRun: true });
    return { count: temp.removed, sizeBytes: temp.bytes };
  }

  private async getDiskUsage(): Promise<OpfieldDiskUsage | null> {
    try {
      this.diskUsageReader ??= new OpfieldDiskUsageReader(this.db, this.dockerService, this.redis, this.hostDisks);
      return await this.diskUsageReader.read();
    } catch (error) {
      logger.debug('Failed to measure Opfield disk usage', { error });
      return null;
    }
  }

  /**
   * When a run last kept Opfield's data bounded (every safety category succeeded); null when no run did. Migration
   * 0260 stored the update time under this key as a starting point for the "not running" check, so the stats named a
   * success no run had (rc.2 X-O-17): a stored time no run in the history finished at moves to the baseline once, and
   * the last successful run of the history (if any) takes its place.
   */
  async getLastSuccessAt(): Promise<string | null> {
    await this.repairLastSuccess();
    return this.readStringSetting(KEYS.lastSuccessAt);
  }

  /**
   * Since when "no successful run" counts: the last success, else the baseline (the update that introduced the check,
   * or the first time this install looked). The stale check and its alert use it.
   */
  async getStalenessAnchor(): Promise<{ lastSuccessAt: string | null; since: string | null }> {
    const lastSuccessAt = await this.getLastSuccessAt();
    if (lastSuccessAt) return { lastSuccessAt, since: lastSuccessAt };
    let since = await this.readStringSetting(KEYS.successBaselineAt);
    if (!since) {
      since = new Date().toISOString();
      await this.upsertSetting(KEYS.successBaselineAt, since);
    }
    return { lastSuccessAt: null, since };
  }

  private lastSuccessRepaired = false;

  private async repairLastSuccess(): Promise<void> {
    if (this.lastSuccessRepaired) return;
    const stored = await this.readStringSetting(KEYS.lastSuccessAt);
    if (stored) {
      const history = await this.getRunHistory();
      const repaired = repairedLastSuccess(stored, history);
      if (repaired.changed) {
        if (!(await this.readStringSetting(KEYS.successBaselineAt)))
          await this.upsertSetting(KEYS.successBaselineAt, stored);
        if (repaired.lastSuccessAt) await this.upsertSetting(KEYS.lastSuccessAt, repaired.lastSuccessAt);
        else await this.db.delete(settings).where(eq(settings.key, KEYS.lastSuccessAt));
        logger.info('Housekeeping last success no run had moved to the baseline', {
          stored,
          lastSuccessAt: repaired.lastSuccessAt,
        });
      }
    }
    this.lastSuccessRepaired = true;
  }

  private async readStringSetting(key: string): Promise<string | null> {
    const row = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return typeof row[0]?.value === 'string' ? row[0].value : null;
  }

  private async getAcmeChallengeStats(): Promise<HousekeepingStats['acmeChallenges']> {
    // ACME challenge files are on daemon nodes, not accessible from Opfield
    return { fileCount: 0, totalSizeBytes: 0 };
  }

  private async getDockerImageStats(): Promise<HousekeepingStats['dockerImages']> {
    let oldCount = 0;
    let reclaimable = 0;
    try {
      const hostImages = await this.oldOpfieldHostImages(await this.dockerService.inspectSelf());
      oldCount = hostImages.length;
      reclaimable = hostImages.reduce((sum, image) => sum + image.size, 0);
    } catch {
      // Managed-node connector stats remain available without local Docker.
    }
    const connectorImages = await this.getObsoleteConnectorImages();
    const nodeImages = await this.applyNodeImageRetention(true);
    return {
      oldImageCount: oldCount + connectorImages.length + nodeImages.count,
      reclaimableBytes: reclaimable + connectorImages.reduce((sum, image) => sum + image.size, 0) + nodeImages.bytes,
    };
  }

  /**
   * Old app and relay images on the Opfield host (see selectOldOpfieldHostImages): they are pulled by digest, so
   * matching the running image's tag never found them.
   */
  private async oldOpfieldHostImages(selfInfo: { Image?: string; Config: { Image: string } }) {
    const [imagesRes, containersRes] = await Promise.all([
      this.dockerRequest('GET', '/images/json'),
      this.dockerRequest('GET', '/containers/json?all=true'),
    ]);
    if (imagesRes.statusCode !== 200 || containersRes.statusCode !== 200) return [];
    const images = JSON.parse(imagesRes.body) as HostImage[];
    const containers = JSON.parse(containersRes.body) as Array<{ ImageID?: string }>;
    return selectOldOpfieldHostImages({
      images,
      inUseImageIds: new Set(containers.flatMap((container) => (container.ImageID ? [container.ImageID] : []))),
      selfImageId: selfInfo.Image ?? null,
      appRepositories: opfieldHostImageRepositories(
        selfInfo.Config.Image,
        (this._env.OPFIELD_UPDATE_IMAGE_REPOSITORIES ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      ),
      keepReferences: [this._env.OPFIELD_RELAY_IMAGE_REF],
    });
  }

  private async getObsoleteConnectorImages(): Promise<Array<OpfieldInternalImageCandidate & { nodeId: string }>> {
    if (!this.dockerManagementService) return [];
    const dockerNodes = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.type, 'docker'), eq(nodes.status, 'online')));
    const candidates: Array<OpfieldInternalImageCandidate & { nodeId: string }> = [];
    for (const node of dockerNodes) {
      try {
        const images = await this.dockerManagementService.listAllImages(node.id);
        if (!Array.isArray(images)) continue;
        candidates.push(
          ...selectObsoleteOpfieldConnectorImages(images, this._env.SECURE_LINK_CONNECTOR_IMAGE).map((image) => ({
            ...image,
            nodeId: node.id,
          }))
        );
      } catch (error) {
        logger.warn('Failed to inspect Opfield connector images', { nodeId: node.id, error });
      }
    }
    return candidates;
  }

  /**
   * Anonymous volumes become eligible only after they have been observed unused for the full retention
   * period (tracked per node+volume since the first unused sighting), never based on their creation time,
   * and only when Opfield created them: a volume counts as Opfield's once a scan saw it attached to a container
   * Opfield created (its records or its labels). Unused volumes Opfield did not create, or cannot tell (their
   * container was gone before this tracking existed), are never removed; they are only reported (`unowned`).
   * `preview` scans (stats) record observations too, but never fail on a tracking write error.
   */
  private findOrphanedVolumes(
    retentionDays: number,
    mode: 'cleanup' | 'preview'
  ): Promise<{ candidates: OrphanedVolumeCandidate[]; unowned: OrphanedVolumeCandidate[] }> {
    const scan = this.orphanedVolumeScanQueue.then(() => this.scanOrphanedVolumes(retentionDays, mode));
    this.orphanedVolumeScanQueue = scan.then(
      () => undefined,
      () => undefined
    );
    return scan;
  }

  /** Tells which container names on a node are containers Opfield created. Replaceable in tests. */
  /** Volumes removal must keep on a node (docker-kept-volumes.ts); a field so tests can replace it. */
  private keptVolumeNames = (nodeId: string): Promise<Set<string>> => opfieldKeptVolumeNames(this.db, nodeId);

  private opfieldContainerTest = async (nodeId: string): Promise<(containerName: string) => boolean> => {
    const [containers, records] = await Promise.all([
      this.dockerManagementService!.listAllContainers(nodeId),
      loadDockerManagedRecords(this.db, nodeId),
    ]);
    const opfieldNames = new Set<string>();
    for (const container of Array.isArray(containers) ? (containers as Array<Record<string, unknown>>) : []) {
      const labels = (container.Labels ?? container.labels ?? {}) as Record<string, string>;
      const names = (Array.isArray(container.Names) ? container.Names : [container.name ?? container.Name]).filter(
        (name): name is string => typeof name === 'string'
      );
      const project = labels['com.docker.compose.project'];
      if (hasOpfieldLabel(labels) || (project && records.composeProjects.has(project))) {
        for (const name of names) opfieldNames.add(name.replace(/^\//, ''));
      }
    }
    return (name) => opfieldNames.has(name) || records.recordedNames.has(name) || records.reservedNames.has(name);
  };

  private async scanOrphanedVolumes(
    retentionDays: number,
    mode: 'cleanup' | 'preview'
  ): Promise<{ candidates: OrphanedVolumeCandidate[]; unowned: OrphanedVolumeCandidate[] }> {
    const candidates: OrphanedVolumeCandidate[] = [];
    const unowned: OrphanedVolumeCandidate[] = [];
    if (!this.dockerManagementService) return { candidates, unowned };
    const dockerNodes = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.type, 'docker'), eq(nodes.status, 'online')));
    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const previous = this.unsavedUnusedVolumeState ?? (await this.loadUnusedVolumeState());
    const previousOwned =
      this.unsavedOwnedVolumeState ?? (await this.loadVolumeState(KEYS.orphanedVolumesOpfieldOwned));
    // Nodes that are offline or fail to list keep their records untouched, so an outage never resets the clock.
    const next: UnusedVolumeState = { ...previous };
    const nextOwned: UnusedVolumeState = { ...previousOwned };

    for (const node of dockerNodes) {
      let volumes: unknown;
      try {
        // The user volume list hides unused unmanaged volumes, which are exactly the orphans.
        volumes = await this.dockerManagementService.listHousekeepingVolumes(node.id);
      } catch (error) {
        logger.debug('Failed to list Docker volumes for housekeeping', { nodeId: node.id, error });
        continue;
      }

      if (!Array.isArray(volumes)) continue;
      let kept: Set<string>;
      try {
        kept = await this.keptVolumeNames(node.id);
      } catch (error) {
        // Unknown which volumes the user manages or a config names: nothing on this node is touched this time.
        logger.debug('Failed to read the volumes to keep for housekeeping', { nodeId: node.id, error });
        continue;
      }
      let isOpfieldContainer: ((name: string) => boolean) | null = null;
      try {
        isOpfieldContainer = await this.opfieldContainerTest(node.id);
      } catch (error) {
        // Unknown this time: ownership is only kept, never newly recorded.
        logger.debug('Failed to list containers for orphaned volume ownership', { nodeId: node.id, error });
      }
      // Successful scan: rebuild this node's records, dropping volumes that are in use or gone.
      const previousForNode = previous[node.id] ?? {};
      const ownedForNode = previousOwned[node.id] ?? {};
      const unusedSince: Record<string, string> = {};
      const owned: Record<string, string> = {};
      for (const volume of volumes) {
        const candidate = normalizeHousekeepingVolume(volume);
        if (!candidate) continue;
        const anonymous = isAnonymousDockerVolumeName(candidate.name);
        const inUse = candidate.usedBy.length > 0 || candidate.usedByCount > 0;
        if (anonymous) {
          const seenWithOpfield =
            inUse &&
            isOpfieldContainer &&
            candidate.usedBy.some((name) => isOpfieldContainer!(name.replace(/^\//, '')));
          const ownedSince =
            ownedForNode[candidate.name] ?? (seenWithOpfield ? new Date(now).toISOString() : undefined);
          if (ownedSince) owned[candidate.name] = ownedSince;
        }
        if (inUse) continue;
        // Managed by the user (an adopted anonymous volume is a database row only) or named by an Opfield config.
        if (kept.has(candidate.name) || kept.has(candidate.name.toLowerCase())) continue;
        if (
          candidate.labels[VOLUME_CLEANUP_PROTECTED_LABEL] === 'true' ||
          candidate.labels[LEGACY_VOLUME_CLEANUP_PROTECTED_LABEL] === 'true'
        )
          continue;
        if (!anonymous || !owned[candidate.name]) {
          // Not created by Opfield (or it cannot tell): shown in Housekeeping, never removed automatically.
          unowned.push({ nodeId: node.id, name: candidate.name, sizeBytes: candidate.sizeBytes });
          continue;
        }
        // Placeholders for volumes missing on the node carry no creation time; never track or remove them.
        if (!candidate.createdAt || !Number.isFinite(Date.parse(candidate.createdAt))) continue;
        const since = previousForNode[candidate.name] ?? new Date(now).toISOString();
        unusedSince[candidate.name] = since;
        if (now - Date.parse(since) < retentionMs) continue;
        candidates.push({ nodeId: node.id, name: candidate.name, sizeBytes: candidate.sizeBytes });
      }
      if (Object.keys(unusedSince).length > 0) next[node.id] = unusedSince;
      else delete next[node.id];
      if (Object.keys(owned).length > 0) nextOwned[node.id] = owned;
      else delete nextOwned[node.id];
    }

    await this.saveOwnedVolumeState(previousOwned, nextOwned, mode);
    await this.saveUnusedVolumeState(previous, next, mode);
    return { candidates, unowned };
  }

  private unsavedOwnedVolumeState: UnusedVolumeState | null = null;

  private async loadVolumeState(key: string): Promise<UnusedVolumeState> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return parseUnusedVolumeState(rows.find((row) => row.key === key)?.value);
  }

  private async saveOwnedVolumeState(
    previous: UnusedVolumeState,
    next: UnusedVolumeState,
    mode: 'cleanup' | 'preview'
  ): Promise<void> {
    if (!this.unsavedOwnedVolumeState && sameUnusedVolumeState(previous, next)) return;
    try {
      await this.upsertSetting(KEYS.orphanedVolumesOpfieldOwned, next);
      this.unsavedOwnedVolumeState = null;
    } catch (error) {
      this.unsavedOwnedVolumeState = next;
      logger.warn('Failed to save orphaned Docker volume ownership', { error });
      if (mode === 'cleanup') {
        throw new Error('Failed to save orphaned volume tracking; no volumes were removed');
      }
    }
  }

  private loadUnusedVolumeState(): Promise<UnusedVolumeState> {
    return this.loadVolumeState(KEYS.orphanedVolumesUnusedSince);
  }

  private async saveUnusedVolumeState(
    previous: UnusedVolumeState,
    next: UnusedVolumeState,
    mode: 'cleanup' | 'preview'
  ): Promise<void> {
    if (!this.unsavedUnusedVolumeState && sameUnusedVolumeState(previous, next)) return;
    try {
      await this.upsertSetting(KEYS.orphanedVolumesUnusedSince, next);
      this.unsavedUnusedVolumeState = null;
    } catch (error) {
      // Keep the observations in memory so a lost write cannot resurrect an older unused-since time.
      this.unsavedUnusedVolumeState = next;
      logger.warn('Failed to save orphaned Docker volume tracking', { error });
      if (mode === 'cleanup') {
        throw new Error('Failed to save orphaned volume tracking; no volumes were removed');
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async runCategory(
    name: string,
    fn: () => Promise<{ itemsCleaned: number; spaceFreedBytes?: number }>
  ): Promise<CategoryResult> {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Did not finish within ${Math.round(CATEGORY_TIMEOUT_MS / 60_000)} minutes`)),
            CATEGORY_TIMEOUT_MS
          );
          timer.unref?.();
        }),
      ]);
      return {
        category: name,
        success: true,
        itemsCleaned: result.itemsCleaned,
        spaceFreedBytes: result.spaceFreedBytes,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      logger.warn(`Housekeeping category "${name}" failed`, { error });
      return {
        category: name,
        success: false,
        itemsCleaned: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async getLastRunResult(): Promise<HousekeepingRunResult | null> {
    const row = await this.db.select().from(settings).where(eq(settings.key, KEYS.lastRunResult)).limit(1);
    if (!row.length) return null;
    return (row[0].value as HousekeepingRunResult) || null;
  }

  private async saveRunResult(result: HousekeepingRunResult): Promise<void> {
    await this.upsertSetting(KEYS.lastRunResult, result);
    // A run counts as a success when everything that keeps Opfield's own data bounded worked.
    if (runKeptDataBounded(result)) {
      await this.upsertSetting(KEYS.lastSuccessAt, result.completedAt);
    }

    // Append to history (keep last N)
    const history = await this.getRunHistory();
    history.unshift(result);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await this.upsertSetting(KEYS.runHistory, history);
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

  /** Direct Docker API request (for image listing etc.) */
  private dockerRequest(method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;

      const req = httpModule.request(
        {
          socketPath: '/var/run/docker.sock',
          method,
          path: `/v1.46${path}`,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
          res.on('error', reject);
        }
      );

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

/**
 * The last success as the run history knows it: a stored time no run of the history completed at is not a run (the
 * update time migration 0260 stored); the newest run whose safety categories all succeeded takes its place, or none.
 * A history that lost older runs (it keeps the last few) keeps a stored time older than all of them.
 */
export function repairedLastSuccess(
  stored: string,
  history: readonly HousekeepingRunResult[]
): { changed: boolean; lastSuccessAt: string | null } {
  if (history.some((run) => run.completedAt === stored)) return { changed: false, lastSuccessAt: stored };
  const storedMs = Date.parse(stored);
  const oldestRunMs = Math.min(...history.map((run) => Date.parse(run.startedAt)).filter(Number.isFinite));
  if (Number.isFinite(storedMs) && Number.isFinite(oldestRunMs) && storedMs < oldestRunMs) {
    return { changed: false, lastSuccessAt: stored };
  }
  const success = history
    .filter((run) => runKeptDataBounded(run))
    .map((run) => run.completedAt)
    .sort()
    .at(-1);
  return { changed: true, lastSuccessAt: success ?? null };
}

/** Every safety category of the run (those it ran) succeeded. */
function runKeptDataBounded(run: HousekeepingRunResult): boolean {
  return run.categories
    .filter((category) => SAFETY_CATEGORIES.has(category.category))
    .every((category) => category.success);
}

/**
 * No run kept Opfield's data bounded for HOUSEKEEPING_STALE_MS since `since` (the last success, else the baseline the
 * check started from).
 */
export function isHousekeepingStale(lastSuccessAt: string | null, now = Date.now()): boolean {
  if (!lastSuccessAt) return false;
  const at = Date.parse(lastSuccessAt);
  return Number.isFinite(at) && now - at > HOUSEKEEPING_STALE_MS;
}

function isAnonymousDockerVolumeName(name: string): boolean {
  return /^[a-f0-9]{64}$/i.test(name);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Invalid entries are dropped, which only restarts their clock. */
function parseUnusedVolumeState(value: unknown): UnusedVolumeState {
  const state: UnusedVolumeState = {};
  if (!isPlainRecord(value)) return state;
  for (const [nodeId, volumes] of Object.entries(value)) {
    if (!isPlainRecord(volumes)) continue;
    const entries = Object.entries(volumes).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && Number.isFinite(Date.parse(entry[1]))
    );
    if (entries.length > 0) state[nodeId] = Object.fromEntries(entries);
  }
  return state;
}

function sameUnusedVolumeState(a: UnusedVolumeState, b: UnusedVolumeState): boolean {
  const nodeIds = Object.keys(a);
  if (nodeIds.length !== Object.keys(b).length) return false;
  return nodeIds.every((nodeId) => {
    const left = a[nodeId];
    const right = b[nodeId];
    if (!right) return false;
    const names = Object.keys(left);
    return names.length === Object.keys(right).length && names.every((name) => left[name] === right[name]);
  });
}

function normalizeHousekeepingVolume(volume: unknown): {
  name: string;
  labels: Record<string, string>;
  createdAt: string | null;
  usedBy: string[];
  usedByCount: number;
  sizeBytes?: number;
} | null {
  if (!volume || typeof volume !== 'object') return null;
  const record = volume as Record<string, unknown>;
  const name = record.name ?? record.Name;
  if (typeof name !== 'string' || !name) return null;

  const labels = (record.labels ?? record.Labels ?? {}) as Record<string, string>;
  const usedBy = record.usedBy ?? record.UsedBy;
  const usageData = record.usageData ?? record.UsageData;
  const usageRecord = usageData && typeof usageData === 'object' ? (usageData as Record<string, unknown>) : null;
  const size = usageRecord?.Size ?? usageRecord?.size;
  const createdAt = record.createdAt ?? record.CreatedAt;

  return {
    name,
    labels: labels && typeof labels === 'object' ? labels : {},
    createdAt: typeof createdAt === 'string' ? createdAt : null,
    usedBy: Array.isArray(usedBy) ? usedBy.filter((item): item is string => typeof item === 'string') : [],
    usedByCount:
      typeof record.usedByCount === 'number'
        ? record.usedByCount
        : typeof record.UsedByCount === 'number'
          ? record.UsedByCount
          : Array.isArray(usedBy)
            ? usedBy.length
            : 0,
    sizeBytes: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : undefined,
  };
}
