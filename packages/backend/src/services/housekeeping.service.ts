import { readdir, stat } from 'node:fs/promises';
import httpModule from 'node:http';
import { join } from 'node:path';
import { and, count, eq, lt, min, sql } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { alerts } from '@/db/schema/alerts.js';
import { auditLog } from '@/db/schema/audit-log.js';
import { nodes } from '@/db/schema/nodes.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AISandboxArtifactService } from '@/modules/ai/ai.sandbox-artifact.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import {
  type OpfieldInternalImageCandidate,
  selectObsoleteOpfieldConnectorImages,
} from '@/modules/docker/docker-internal-images.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import type { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import type { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import type { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import type { DockerService } from './docker.service.js';
import type { EventBusService } from './event-bus.service.js';
import {
  countExpiredTokens,
  DEFAULT_EXPIRED_TOKEN_RETENTION_DAYS,
  purgeExpiredTokens,
} from './expired-token-retention.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import {
  cleanOperationHistory,
  countExpiredOAuthGrants,
  countOperationHistory,
  purgeExpiredOAuthGrants,
} from './operation-history-retention.js';
import type { SystemCertificateLifecycleService } from './system-certificate-lifecycle.service.js';

const logger = createChildLogger('HousekeepingService');
const VOLUME_CLEANUP_PROTECTED_LABEL = 'opfield.housekeeping.protected';
// legacy-name: cleanup protection label set on volumes before 2.12.1 (Docker cannot relabel a volume in place) — remove
// once no protected volume carries it
const LEGACY_VOLUME_CLEANUP_PROTECTED_LABEL = 'gateway.housekeeping.protected';
const SYSTEM_CERTIFICATE_KEY_RETENTION_DAYS = 30;
const LOGGING_SETTINGS_KEY = 'logging:clickhouse';
const DEFAULT_INTERNAL_REGISTRY_RETENTION_COUNT = 1;

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
}

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
  trigger: 'scheduled' | 'manual';
  triggeredBy?: string;
  totalDurationMs: number;
  categories: CategoryResult[];
  overallSuccess: boolean;
}

export interface HousekeepingStats {
  nginxLogs: { totalSizeBytes: number; fileCount: number; oldestFile: string | null };
  auditLog: { totalRows: number; oldestEntry: string | null };
  dismissedAlerts: { count: number; oldestAlert: string | null };
  deliveryLog: { total: number; success: number; failed: number; retrying: number };
  structuredLogs: { totalRows: number; totalSizeBytes: number; status: string };
  clickHouseInternals: { totalRows: number; totalSizeBytes: number; status: string; capBytes: number };
  orphanedAIArtifacts: { count: number; totalSizeBytes: number };
  internalRegistry: {
    totalSizeBytes: number;
    capacityBytes: number | null;
    status: string;
    lastGcAt: string | null;
  };
  orphanedVolumes: { count: number; reclaimableBytes: number };
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
  lastRun: HousekeepingRunResult | null;
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
  [KEYS.internalRegistryRetention]: DEFAULT_INTERNAL_REGISTRY_RETENTION_COUNT,
  [KEYS.orphanedVolumesEnabled]: true,
  [KEYS.orphanedVolumesRetention]: 30,
  [KEYS.dockerPruneEnabled]: true,
  [KEYS.orphanedCertsEnabled]: true,
  [KEYS.acmeCleanupEnabled]: true,
  [KEYS.operationHistoryEnabled]: true,
  [KEYS.operationHistoryRetention]: 90,
  [KEYS.oauthCleanupEnabled]: true,
  [KEYS.expiredTokensEnabled]: true,
  [KEYS.expiredTokensRetention]: DEFAULT_EXPIRED_TOKEN_RETENTION_DAYS,
};

const MAX_HISTORY = 20;

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

type UnusedVolumeState = Record<string, Record<string, string>>;
type OrphanedVolumeCandidate = { nodeId: string; name: string; sizeBytes?: number };

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
        retentionSuccessfulArtifacts: DEFAULT_INTERNAL_REGISTRY_RETENTION_COUNT,
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
    if (partial.internalRegistry?.retentionSuccessfulArtifacts !== undefined)
      updates.push([KEYS.internalRegistryRetention, DEFAULT_INTERNAL_REGISTRY_RETENTION_COUNT]);
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

    return this.getConfig();
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
      lastRun,
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
      this.getLastRunResult(),
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
      lastRun,
      isRunning: this.running,
    };
  }

  // ── Run All ─────────────────────────────────────────────────────

  async runAll(trigger: 'scheduled' | 'manual', userId?: string): Promise<HousekeepingRunResult> {
    if (this.running) {
      throw new Error('Housekeeping is already running');
    }

    this.running = true;
    const startedAt = new Date().toISOString();
    const categories: CategoryResult[] = [];

    try {
      const config = await this.getConfig();

      if (this.pagesMaintenanceService) {
        categories.push(await this.runCategory('Pages', () => this.pagesMaintenanceService!.run()));
      }
      if (this.internalRegistryMaintenanceService) {
        categories.push(
          await this.runCategory('Internal Registry', async () => {
            const run = await this.internalRegistryMaintenanceService!.runGarbageCollection({
              requestedById: userId ?? null,
              retentionCount: config.internalRegistry.retentionSuccessfulArtifacts,
              reason: trigger === 'scheduled' ? 'scheduled housekeeping' : 'housekeeping run by a user',
            });
            const candidateIds = Array.isArray(run.progress?.candidateArtifactIds)
              ? run.progress.candidateArtifactIds
              : [];
            return { itemsCleaned: candidateIds.length };
          })
        );
      }

      if (config.nginxLogs.enabled) {
        categories.push(
          await this.runCategory('Nginx Logs', () => this.rotateNginxLogs(config.nginxLogs.retentionDays))
        );
      }
      if (config.auditLog.enabled) {
        categories.push(await this.runCategory('Audit Log', () => this.cleanAuditLog(config.auditLog.retentionDays)));
      }
      if (config.dismissedAlerts.enabled) {
        categories.push(
          await this.runCategory('Dismissed Alerts', () =>
            this.cleanDismissedAlerts(config.dismissedAlerts.retentionDays)
          )
        );
      }
      if (config.deliveryLog.enabled) {
        categories.push(
          await this.runCategory('Delivery Log', () => this.cleanDeliveryLog(config.deliveryLog.retentionDays))
        );
      }
      if (config.structuredLogs.enabled) {
        categories.push(
          await this.runCategory('Structured Logs', () =>
            this.cleanStructuredLogs(config.structuredLogs, config.clickHouseInternals)
          )
        );
      }
      if (config.clickHouseInternals.enabled) {
        categories.push(
          await this.runCategory('ClickHouse Internals', () =>
            this.cleanClickHouseInternals(
              config.structuredLogs.enabled ? config.structuredLogs : undefined,
              config.clickHouseInternals
            )
          )
        );
      }
      if (config.orphanedAIArtifacts.enabled) {
        categories.push(await this.runCategory('Orphaned AI Artifacts', () => this.cleanOrphanedAIArtifacts()));
      }
      if (config.orphanedVolumes.enabled) {
        categories.push(
          await this.runCategory('Orphaned Volumes', () =>
            this.cleanOrphanedVolumes(config.orphanedVolumes.retentionDays, userId ?? null)
          )
        );
      }
      if (config.orphanedCerts.enabled) {
        categories.push(await this.runCategory('Orphaned Certs', () => this.cleanOrphanedCerts()));
      }
      if (config.acmeCleanup.enabled) {
        categories.push(await this.runCategory('ACME Challenges', () => this.cleanAcmeChallenges()));
      }
      if (config.dockerPrune.enabled) {
        categories.push(await this.runCategory('Docker Images', () => this.pruneDockerImages()));
      }
      if (config.operationHistory?.enabled) {
        categories.push(
          await this.runCategory('Operation History', () =>
            this.cleanOperationHistory(config.operationHistory.retentionDays)
          )
        );
      }
      if (config.oauthCleanup?.enabled) {
        categories.push(await this.runCategory('Expired OAuth Grants', () => this.cleanExpiredOAuthGrants()));
      }
      if (config.expiredTokens?.enabled) {
        categories.push(
          await this.runCategory('Expired Tokens', () => this.cleanExpiredTokens(config.expiredTokens.retentionDays))
        );
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

  async getRunHistory(): Promise<HousekeepingRunResult[]> {
    const row = await this.db.select().from(settings).where(eq(settings.key, KEYS.runHistory)).limit(1);
    if (!row.length) return [];
    return ((row[0].value as HousekeepingRunResult[]) || []).slice(0, MAX_HISTORY);
  }

  // ── Category Implementations ────────────────────────────────────

  private async rotateNginxLogs(_retentionDays: number): Promise<{ itemsCleaned: number; spaceFreedBytes?: number }> {
    // Log rotation is handled by each daemon node locally (7-day retention).
    // Logs streamed to Opfield are stored in the database / log aggregation.
    logger.debug('Nginx log rotation is managed by daemon nodes');
    return { itemsCleaned: 0 };
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

    return { itemsCleaned: result.length };
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
  }

  private dockerManagementService?: DockerManagementService;
  setDockerManagementService(svc: DockerManagementService) {
    this.dockerManagementService = svc;
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
    const candidates = await this.findOrphanedVolumes(retentionDays, 'cleanup');
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
      const currentImage = selfInfo.Config.Image;
      const imageBase = currentImage.includes(':')
        ? currentImage.substring(0, currentImage.lastIndexOf(':'))
        : currentImage;
      const listRes = await this.dockerRequest('GET', `/images/json`);
      if (listRes.statusCode === 200) {
        const images = JSON.parse(listRes.body) as Array<{
          Id: string;
          RepoTags: string[] | null;
          Size: number;
        }>;
        for (const img of images) {
          const tags = img.RepoTags || [];
          if (!tags.some((tag) => tag.startsWith(`${imageBase}:`))) continue;
          if (tags.some((tag) => tag === currentImage)) continue;
          try {
            const delRes = await this.dockerRequest('DELETE', `/images/${encodeURIComponent(img.Id)}`);
            if (delRes.statusCode === 200) {
              cleaned += 1;
              freedBytes += img.Size;
            }
          } catch {
            // Keep cleaning other images.
          }
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
    return { itemsCleaned: cleaned, spaceFreedBytes: freedBytes };
  }

  // ── Stats Helpers ───────────────────────────────────────────────

  private async getNginxLogStats(): Promise<HousekeepingStats['nginxLogs']> {
    // Logs are managed by daemon nodes (7-day local retention) and streamed to Opfield
    const logsPath = '/var/log/opfield-logs'; // Opfield-side log storage (future)
    try {
      const entries = await readdir(logsPath);
      let totalSize = 0;
      let fileCount = 0;
      let oldestMtime: Date | null = null;
      let oldestName: string | null = null;

      for (const entry of entries) {
        try {
          const s = await stat(join(logsPath, entry));
          if (!s.isFile()) continue;
          fileCount++;
          totalSize += s.size;
          if (!oldestMtime || s.mtime < oldestMtime) {
            oldestMtime = s.mtime;
            oldestName = entry;
          }
        } catch {
          // skip unreadable files
        }
      }

      return { totalSizeBytes: totalSize, fileCount, oldestFile: oldestName };
    } catch {
      return { totalSizeBytes: 0, fileCount: 0, oldestFile: null };
    }
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
    const candidates = await this.findOrphanedVolumes(config.orphanedVolumes.retentionDays, 'preview');
    return {
      count: candidates.length,
      reclaimableBytes: candidates.reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0),
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

  private async getAcmeChallengeStats(): Promise<HousekeepingStats['acmeChallenges']> {
    // ACME challenge files are on daemon nodes, not accessible from Opfield
    return { fileCount: 0, totalSizeBytes: 0 };
  }

  private async getDockerImageStats(): Promise<HousekeepingStats['dockerImages']> {
    let oldCount = 0;
    let reclaimable = 0;
    try {
      const selfInfo = await this.dockerService.inspectSelf();
      const currentImage = selfInfo.Config.Image;
      const imageBase = currentImage.includes(':')
        ? currentImage.substring(0, currentImage.lastIndexOf(':'))
        : currentImage;

      const res = await this.dockerRequest('GET', '/images/json');
      if (res.statusCode === 200) {
        const images = JSON.parse(res.body) as Array<{
          Id: string;
          RepoTags: string[] | null;
          Size: number;
        }>;
        for (const img of images) {
          const tags = img.RepoTags || [];
          if (!tags.some((tag) => tag.startsWith(`${imageBase}:`))) continue;
          if (tags.some((tag) => tag === currentImage)) continue;
          oldCount += 1;
          reclaimable += img.Size;
        }
      }
    } catch {
      // Managed-node connector stats remain available without local Docker.
    }
    const connectorImages = await this.getObsoleteConnectorImages();
    return {
      oldImageCount: oldCount + connectorImages.length,
      reclaimableBytes: reclaimable + connectorImages.reduce((sum, image) => sum + image.size, 0),
    };
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
   * period (tracked per node+volume since the first unused sighting), never based on their creation time.
   * `preview` scans (stats) record observations too, but never fail on a tracking write error.
   */
  private findOrphanedVolumes(retentionDays: number, mode: 'cleanup' | 'preview'): Promise<OrphanedVolumeCandidate[]> {
    const scan = this.orphanedVolumeScanQueue.then(() => this.scanOrphanedVolumes(retentionDays, mode));
    this.orphanedVolumeScanQueue = scan.then(
      () => undefined,
      () => undefined
    );
    return scan;
  }

  private async scanOrphanedVolumes(
    retentionDays: number,
    mode: 'cleanup' | 'preview'
  ): Promise<OrphanedVolumeCandidate[]> {
    const candidates: OrphanedVolumeCandidate[] = [];
    if (!this.dockerManagementService) return candidates;
    const dockerNodes = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.type, 'docker'), eq(nodes.status, 'online')));
    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const previous = this.unsavedUnusedVolumeState ?? (await this.loadUnusedVolumeState());
    // Nodes that are offline or fail to list keep their records untouched, so an outage never resets the clock.
    const next: UnusedVolumeState = { ...previous };

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
      // Successful scan: rebuild this node's records, dropping volumes that are in use or gone.
      const previousForNode = previous[node.id] ?? {};
      const unusedSince: Record<string, string> = {};
      for (const volume of volumes) {
        const candidate = normalizeHousekeepingVolume(volume);
        if (!candidate) continue;
        if (!isAnonymousDockerVolumeName(candidate.name)) continue;
        if (candidate.usedBy.length > 0 || candidate.usedByCount > 0) continue;
        if (
          candidate.labels[VOLUME_CLEANUP_PROTECTED_LABEL] === 'true' ||
          candidate.labels[LEGACY_VOLUME_CLEANUP_PROTECTED_LABEL] === 'true'
        )
          continue;
        // Placeholders for volumes missing on the node carry no creation time; never track or remove them.
        if (!candidate.createdAt || !Number.isFinite(Date.parse(candidate.createdAt))) continue;
        const since = previousForNode[candidate.name] ?? new Date(now).toISOString();
        unusedSince[candidate.name] = since;
        if (now - Date.parse(since) < retentionMs) continue;
        candidates.push({ nodeId: node.id, name: candidate.name, sizeBytes: candidate.sizeBytes });
      }
      if (Object.keys(unusedSince).length > 0) next[node.id] = unusedSince;
      else delete next[node.id];
    }

    await this.saveUnusedVolumeState(previous, next, mode);
    return candidates;
  }

  private async loadUnusedVolumeState(): Promise<UnusedVolumeState> {
    const row = await this.db.select().from(settings).where(eq(settings.key, KEYS.orphanedVolumesUnusedSince)).limit(1);
    return parseUnusedVolumeState(row[0]?.value);
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
    try {
      const result = await fn();
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
    }
  }

  private async getLastRunResult(): Promise<HousekeepingRunResult | null> {
    const row = await this.db.select().from(settings).where(eq(settings.key, KEYS.lastRunResult)).limit(1);
    if (!row.length) return null;
    return (row[0].value as HousekeepingRunResult) || null;
  }

  private async saveRunResult(result: HousekeepingRunResult): Promise<void> {
    await this.upsertSetting(KEYS.lastRunResult, result);

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
