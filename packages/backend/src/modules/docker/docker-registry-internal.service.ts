import { randomUUID } from 'node:crypto';
import type { DrizzleClient } from '@/db/client.js';
import type { DockerRegistryMaintenancePhase } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerInternalRegistrySettingsInput } from './docker-build.schemas.js';
import { DockerRegistryBuildRetention } from './docker-registry-build-retention.js';
import {
  createDockerRegistryMaintenanceStore,
  DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS,
  type DockerRegistryMaintenanceExecutor,
  type DockerRegistryMaintenanceStore,
  MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS,
  type MaintenanceRun,
  REGISTRY_BUILDS_KEPT_PER_CONTAINER,
  type RegistryState,
  selectRegistryRetentionCandidates,
  unavailableDockerRegistryMaintenanceExecutor,
} from './docker-registry-maintenance.js';
import type { DockerRegistryGrant, DockerRegistryTokenService } from './docker-registry-token.service.js';

export {
  createDockerRegistryMaintenanceExecutor,
  type DockerRegistryMaintenanceExecutor,
  type DockerRegistryMaintenanceStore,
  type RegistryRetentionArtifact,
  selectRegistryRetentionCandidates,
} from './docker-registry-maintenance.js';

export const INTERNAL_DOCKER_REGISTRY_ID = 'gateway-internal-registry';
const logger = createChildLogger('DockerInternalRegistryService');
const DEFAULT_DISK_PRESSURE_RATIO = 0.9;
const STORAGE_MEASURE_INTERVAL_MS = 5 * 60_000;
/** How soon a failed maintenance run is checked for a failure that could not be recorded. */
const UNFINISHED_MAINTENANCE_CHECK_MS = 30_000;

export interface DockerRegistryExternalAccessConfig {
  externalAccessEnabled: boolean;
  externalHostname: string | null;
  externalNginxNodeId: string | null;
  externalCertificateId: string | null;
}

export type DockerRegistryExternalAccessReconciler = (
  next: DockerRegistryExternalAccessConfig,
  previous: DockerRegistryExternalAccessConfig,
  userId: string | null
) => Promise<void>;

export class DockerInternalRegistryService {
  private executor: DockerRegistryMaintenanceExecutor = unavailableDockerRegistryMaintenanceExecutor;
  private externalAccessReconciler?: DockerRegistryExternalAccessReconciler;
  private eventBus?: EventBusService;
  private readonly store: DockerRegistryMaintenanceStore;
  private storageMeasuredAt = 0;
  /** Maintenance runs of this process in flight. */
  private maintenanceRuns = 0;
  private readonly buildRetention: DockerRegistryBuildRetention;

  constructor(
    db: DrizzleClient,
    private readonly tokenService: DockerRegistryTokenService,
    private readonly auditService: AuditService,
    store?: DockerRegistryMaintenanceStore
  ) {
    this.store = store ?? createDockerRegistryMaintenanceStore(db);
    this.buildRetention = new DockerRegistryBuildRetention({
      store: this.store,
      executor: () => this.executor,
      getState: () => this.getState(),
      maintenanceRunning: () => this.maintenanceRuns > 0,
      collectGarbage: (reason) => this.runGarbageCollection({ reason }),
    });
  }

  /** A build reached a final state: its source keeps only the running and the rollback build (see the retention rule). */
  buildFinished(buildId: string): void {
    this.buildRetention.buildFinished(buildId);
  }

  setExecutor(executor: DockerRegistryMaintenanceExecutor): void {
    this.executor = executor;
  }

  setExternalAccessReconciler(reconciler: DockerRegistryExternalAccessReconciler): void {
    this.externalAccessReconciler = reconciler;
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setLicensePolicyService(_service: LicensePolicyService): void {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async recoverInterruptedMaintenance(cause = 'Opfield restarted'): Promise<void> {
    const state = await this.getState();
    if (state.maintenancePhase === 'idle' && state.status !== 'maintenance') return;
    const now = new Date();
    try {
      await this.executor.restoreWrites();
      await this.store.markInterruptedRunsFailed?.(
        now,
        `Registry maintenance stopped in phase ${state.maintenancePhase}: ${cause}`
      );
      const recovered = await this.store.updateState({
        status: 'ready',
        writable: true,
        maintenancePhase: 'idle',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastError: null,
      });
      this.emitChanged('maintenance', recovered);
    } catch (error) {
      await this.store.updateState({
        status: 'unhealthy',
        writable: false,
        maintenancePhase: 'failed',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastError: `Automatic registry maintenance recovery failed: ${(error as Error).message}`,
      });
      throw error;
    }
  }

  async getState(): Promise<RegistryState> {
    await this.store.initialize();
    return this.store.getState();
  }

  async probeHealth(registryUrl = process.env.OPFIELD_INTERNAL_REGISTRY_URL || 'http://registry:5000') {
    let healthy = false;
    try {
      const response = await fetch(new URL('/v2/', registryUrl), {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      healthy = response.ok || response.status === 401;
    } catch {
      healthy = false;
    }
    return this.reportHealth({
      healthy,
      writable: healthy,
      usedBytes: await this.storageUsedBytes(healthy),
      capacityBytes: null,
    });
  }

  /**
   * The health probe runs every few seconds and walking the registry volume is not free, so usage is re-measured at most
   * once per STORAGE_MEASURE_INTERVAL_MS. Between measurements, and whenever measuring fails, the stored value stands.
   */
  private async storageUsedBytes(healthy: boolean): Promise<number> {
    const known = (await this.getState()).storageUsedBytes;
    if (!healthy || Date.now() - this.storageMeasuredAt < STORAGE_MEASURE_INTERVAL_MS) return known;
    try {
      const measured = await this.executor.storageUsedBytes();
      this.storageMeasuredAt = Date.now();
      return measured;
    } catch (error) {
      logger.debug('Managed registry storage usage could not be measured', { error });
      return known;
    }
  }

  async reportHealth(input: { healthy: boolean; writable: boolean; usedBytes: number; capacityBytes?: number | null }) {
    const current = await this.getState();
    const maintenance = current.maintenancePhase !== 'idle' && current.maintenancePhase !== 'failed';
    const usedBytes = Math.max(0, input.usedBytes);
    const capacityBytes = input.capacityBytes == null ? null : Math.max(0, input.capacityBytes);
    const diskPressure =
      capacityBytes !== null && capacityBytes > 0 && usedBytes / capacityBytes >= DEFAULT_DISK_PRESSURE_RATIO;
    const writable = input.healthy && input.writable && !maintenance && !diskPressure;
    // A maintenance run stops and restarts the registry itself and records how it ended: a probe that finds it down
    // meanwhile does not turn it unhealthy.
    const status = maintenance
      ? 'maintenance'
      : !input.healthy
        ? 'unhealthy'
        : diskPressure
          ? 'degraded'
          : writable
            ? 'ready'
            : 'read_only';
    const lastError = maintenance
      ? current.lastError
      : !input.healthy
        ? 'Registry health report marked the service unhealthy'
        : diskPressure
          ? 'Registry storage is at or above the write-admission threshold'
          : null;
    if (
      current.status === status &&
      current.writable === writable &&
      current.storageUsedBytes === usedBytes &&
      current.storageCapacityBytes === capacityBytes &&
      current.lastError === lastError
    ) {
      return current;
    }
    const state = await this.store.updateState({
      status,
      writable,
      storageUsedBytes: usedBytes,
      storageCapacityBytes: capacityBytes,
      lastError,
    });
    this.emitChanged('health', state);
    return state;
  }

  protected externalRegistryContext() {
    return {
      store: this.store,
      audit: this.auditService,
      reconcile: this.externalAccessReconciler,
      emitChanged: (action: string, state: RegistryState) => this.emitChanged(action, state),
    };
  }

  async updateSettings(input: DockerInternalRegistrySettingsInput, userId: string): Promise<RegistryState> {
    if (input.externalAccessEnabled) return commercialModuleUnavailable();
    const current = await this.getState();
    if (!this.externalAccessReconciler && current.externalAccessEnabled) {
      throw new AppError(503, 'REGISTRY_INGRESS_UNAVAILABLE', 'Registry ingress reconciliation is unavailable');
    }
    const next: DockerRegistryExternalAccessConfig = {
      externalAccessEnabled: false,
      externalHostname: null,
      externalNginxNodeId: null,
      externalCertificateId: null,
    };
    const state = await this.store.updateState(next);
    await this.externalAccessReconciler?.(next, current, userId);
    await this.auditService.log({
      action: 'docker.internal-registry.settings.update',
      userId,
      resourceType: 'docker-registry',
      resourceId: INTERNAL_DOCKER_REGISTRY_ID,
      details: { ...next },
    });
    this.emitChanged('settings', state);
    return state;
  }

  async disableExternalAccessForEntitlementLoss(): Promise<boolean> {
    const current = await this.getState();
    if (!current.externalAccessEnabled) return false;
    const previous: DockerRegistryExternalAccessConfig = {
      externalAccessEnabled: true,
      externalHostname: current.externalHostname,
      externalNginxNodeId: current.externalNginxNodeId,
      externalCertificateId: current.externalCertificateId,
    };
    const next: DockerRegistryExternalAccessConfig = {
      externalAccessEnabled: false,
      externalHostname: null,
      externalNginxNodeId: null,
      externalCertificateId: null,
    };
    const state = await this.store.updateState(next);
    await this.externalAccessReconciler?.(next, previous, null);
    await this.auditService.log({
      action: 'docker.internal-registry.external-access.disabled-by-license',
      userId: null,
      resourceType: 'docker-registry',
      resourceId: INTERNAL_DOCKER_REGISTRY_ID,
      details: { previousHostname: previous.externalHostname },
    });
    this.emitChanged('license_reconciled', state);
    return true;
  }

  async assertExternalAccessEntitled(): Promise<RegistryState> {
    return commercialModuleUnavailable();
  }

  private emitChanged(action: string, state: RegistryState): void {
    this.eventBus?.publish('docker.registry.changed', {
      id: INTERNAL_DOCKER_REGISTRY_ID,
      action,
      status: state.status,
      writable: state.writable,
      externalAccessEnabled: state.externalAccessEnabled,
    });
  }

  async assertBuildAdmission(): Promise<void> {
    const state = await this.getState();
    if (state.status !== 'ready' || !state.writable || state.maintenancePhase !== 'idle') {
      // Retryable: the registry is back within seconds after an Opfield update or restart, and an Availability heal
      // that failed here for good would leave the workload unavailable until someone retried it by hand.
      throw new AppError(
        503,
        'INTERNAL_REGISTRY_NOT_WRITABLE',
        'Build admission is paused because the internal registry is not writable',
        { retryable: true }
      );
    }
  }

  async issueToken(input: {
    subject: string;
    service?: string;
    requested: DockerRegistryGrant[];
    allowed: DockerRegistryGrant[];
    context?: { nodeId?: string; buildId?: string; containerId?: string; deploymentId?: string };
    ttlSeconds?: number;
    externalAccess?: boolean;
  }) {
    if (input.externalAccess) await this.assertExternalAccessEntitled();
    const writeRequested = input.requested.some(
      (grant) => grant.actions.includes('push') || grant.actions.includes('delete')
    );
    if (writeRequested) {
      await this.assertBuildAdmission();
    }
    const { externalAccess: _externalAccess, ...tokenInput } = input;
    return this.tokenService.issueToken({
      ...tokenInput,
      ttlSeconds: writeRequested
        ? Math.min(input.ttlSeconds ?? MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS, MAX_REGISTRY_WRITE_TOKEN_TTL_SECONDS)
        : input.ttlSeconds,
    });
  }

  async runGarbageCollection(input: {
    dryRun?: boolean;
    requestedById?: string | null;
    leaseOwner?: string;
    /** Ignored: the registry keeps REGISTRY_BUILDS_KEPT_PER_CONTAINER builds per container. Accepted from older callers. */
    retentionCount?: number;
    /** Why the collection runs, for the log: it restarts the registry and stops it while it collects. */
    reason?: string;
  }) {
    const owner = input.leaseOwner ?? `registry-gc:${randomUUID()}`;
    const reason = input.reason ?? (input.requestedById ? 'requested by a user' : 'housekeeping');
    if (input.dryRun !== true) {
      logger.info('Internal registry garbage collection starts: the registry restarts and stops while it collects', {
        reason,
      });
    }
    let result: MaintenanceRun;
    try {
      result = await this.executeMaintenance({ owner, dryRun: input.dryRun === true });
    } catch (error) {
      logger.warn('Internal registry garbage collection failed', { reason, error: (error as Error).message });
      throw error;
    }
    if (input.dryRun !== true) {
      logger.info('Internal registry garbage collection ended', { reason, status: result.status, runId: result.id });
    }
    await this.auditService.log({
      action: 'docker.internal-registry.gc',
      userId: input.requestedById ?? null,
      resourceType: 'docker-registry',
      resourceId: INTERNAL_DOCKER_REGISTRY_ID,
      details: {
        runId: result.id,
        dryRun: result.dryRun,
        status: result.status,
        retentionCount: result.progress?.retentionCount,
      },
    });
    return result;
  }

  async resumeMaintenance(runId: string, leaseOwner = `registry-gc:${randomUUID()}`): Promise<MaintenanceRun> {
    const run = await this.store.getRun(runId);
    if (run.status === 'completed') return run;
    return this.executeMaintenance({ owner: leaseOwner, dryRun: run.dryRun, run });
  }

  private async executeMaintenance(input: {
    owner: string;
    dryRun: boolean;
    run?: MaintenanceRun;
  }): Promise<MaintenanceRun> {
    this.maintenanceRuns += 1;
    try {
      return await this.runMaintenance(input);
    } catch (error) {
      // A failed run restores writes and records it; when that write failed as well (Postgres stopped meanwhile) the
      // registry would stay read-only, refusing builds and Availability until a restart.
      this.recoverUnfinishedMaintenanceLater();
      throw error;
    } finally {
      this.maintenanceRuns -= 1;
    }
  }

  private recoverUnfinishedMaintenanceLater(): void {
    const timer = setTimeout(() => {
      if (this.maintenanceRuns > 0) return;
      void (async () => {
        // Only a run whose failure was never recorded leaves the registry in maintenance.
        if ((await this.getState()).status !== 'maintenance' || this.maintenanceRuns > 0) return;
        await this.recoverInterruptedMaintenance('the database was unavailable when it stopped');
      })().catch(() => this.recoverUnfinishedMaintenanceLater());
    }, UNFINISHED_MAINTENANCE_CHECK_MS);
    timer.unref?.();
  }

  private async runMaintenance(input: {
    owner: string;
    dryRun: boolean;
    run?: MaintenanceRun;
  }): Promise<MaintenanceRun> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS);
    await this.store.acquireLease(input.owner, leaseExpiresAt, now);
    let run = input.run
      ? await this.store.updateRun(input.run.id, {
          status: 'running',
          leaseOwner: input.owner,
          leaseExpiresAt,
          error: null,
          completedAt: null,
        })
      : await this.store.createRun(input.owner, leaseExpiresAt, input.dryRun);
    let progress = (run.progress ?? {}) as Record<string, unknown>;
    progress = { ...progress, retentionCount: REGISTRY_BUILDS_KEPT_PER_CONTAINER };
    run = await this.store.updateRun(run.id, { progress });
    let currentPhase: DockerRegistryMaintenancePhase = 'acquiring_lease';
    let writesRestored = input.dryRun;

    const phase = async (next: DockerRegistryMaintenancePhase) => {
      currentPhase = next;
      const renewedUntil = new Date(Date.now() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS);
      await this.store.renewLease(input.owner, renewedUntil);
      run = await this.store.updateRun(run.id, { phase: next, progress, leaseExpiresAt: renewedUntil });
      await this.store.updateState({ maintenancePhase: next, status: 'maintenance', writable: false });
    };

    try {
      if (!input.dryRun) {
        const trackedArtifacts = await this.store.listRetentionArtifacts(now);
        if (trackedArtifacts.length === 0 && !(await this.executor.hasRepositories())) {
          progress = {
            ...progress,
            retainedArtifactIds: [],
            candidateArtifactIds: [],
            skippedEmptyRegistry: true,
          };
          run = await this.store.updateRun(run.id, {
            phase: 'idle',
            status: 'completed',
            progress,
            error: null,
            completedAt: new Date(),
          });
          this.emitChanged(
            'maintenance',
            await this.store.updateState({
              status: 'ready',
              writable: true,
              maintenancePhase: 'idle',
              maintenanceLeaseOwner: null,
              maintenanceLeaseExpiresAt: null,
              lastGcAt: new Date(),
              lastError: null,
            })
          );
          return run;
        }
      }

      if (!input.dryRun) {
        await phase('pausing_admission');
        await this.executor.pauseAdmissions();
        await phase('draining_uploads');
        await this.executor.drainUploads();
      }

      await phase('computing_pins');
      const artifacts = await this.store.listRetentionArtifacts(now);
      const retention = selectRegistryRetentionCandidates(artifacts);
      progress = {
        ...progress,
        retainedArtifactIds: retention.retained.map((artifact) => artifact.id),
        candidateArtifactIds: retention.candidates.map((artifact) => artifact.id),
      };
      run = await this.store.updateRun(run.id, { progress });

      if (!input.dryRun) {
        await phase('deleting_manifests');
        for (const artifact of retention.candidates) {
          await this.store.renewLease(input.owner, new Date(Date.now() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS));
          await this.executor.deleteManifest(artifact.repository, artifact.digest);
          await this.store.markArtifactDeleted(artifact.id, new Date());
        }
        await phase('entering_read_only');
        await this.executor.enterReadOnly();
        await phase('collecting_blobs');
        await this.executor.collectGarbage();
        await phase('verifying');
        await this.executor.verifyIntegrity(
          retention.retained.map((artifact) => ({ repository: artifact.repository, digest: artifact.digest }))
        );
        await phase('restoring_writes');
        await this.executor.restoreWrites();
        writesRestored = true;
        // Garbage collection just changed the volume; do not keep showing the pre-collection size.
        this.storageMeasuredAt = 0;
      }

      run = await this.store.updateRun(run.id, {
        phase: 'idle',
        status: 'completed',
        progress,
        error: null,
        completedAt: new Date(),
      });
      // Changes waiting for writes (an Availability rollout mirroring images) go on now, not at their next retry.
      this.emitChanged(
        'maintenance',
        await this.store.updateState({
          status: 'ready',
          writable: true,
          maintenancePhase: 'idle',
          maintenanceLeaseOwner: null,
          maintenanceLeaseExpiresAt: null,
          lastGcAt: new Date(),
          lastError: null,
        })
      );
      return run;
    } catch (error) {
      let restoreError: unknown;
      if (!writesRestored) {
        try {
          await this.executor.restoreWrites();
          writesRestored = true;
        } catch (caught) {
          restoreError = caught;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const restoreMessage =
        restoreError instanceof Error ? restoreError.message : restoreError ? String(restoreError) : null;
      progress = { ...progress, failedPhase: currentPhase, restoredAfterFailure: writesRestored };
      await this.store.updateRun(run.id, {
        phase: 'failed',
        status: 'failed',
        progress,
        error: restoreMessage ? `${message}; write restoration failed: ${restoreMessage}` : message,
      });
      this.emitChanged(
        'maintenance',
        await this.store.updateState({
          status: writesRestored ? 'degraded' : 'unhealthy',
          writable: writesRestored,
          maintenancePhase: 'failed',
          maintenanceLeaseOwner: null,
          maintenanceLeaseExpiresAt: null,
          lastError: restoreMessage ? `${message}; write restoration failed: ${restoreMessage}` : message,
        })
      );
      throw error;
    }
  }
}
