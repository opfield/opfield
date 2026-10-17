import { randomUUID } from 'node:crypto';
import type { DrizzleClient } from '@/db/client.js';
import {
  normalizeRegistryRootDirectory,
  type RegistryS3Settings,
  type RegistryS3SettingsView,
  type RegistryStorageBackend,
  registryStorageFromContainerEnv,
} from '@/foundation/registry-storage.js';
import { LEGACY_INTERNAL_REGISTRY_ID } from '@/lib/legacy-compat.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { isFileProtocolConfig } from '@/modules/object-storage/object-storage-connection-view.js';
import type { DockerService } from '@/services/docker.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  createDockerRegistryMaintenanceStore,
  DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS,
  type DockerRegistryMaintenanceStore,
  type RegistryState,
} from '../docker-registry-maintenance.js';
import type { DockerRegistryTokenService } from '../docker-registry-token.service.js';
import type { RegistryStorageInput } from './registry-storage.schemas.js';
import { probeRegistryBucket } from './registry-storage-copy.js';
import { RegistryStorageHost, type RegistryStorageHostContext } from './registry-storage-host.js';
import {
  type RegistryStorageCopyPlan,
  type RegistryStorageSwitchRecord,
  type RegistryStorageSwitchView,
  readSwitchRecord,
  switchView,
  writeSwitchRecord,
} from './registry-storage-record.js';
import { decideRegistryStorageRecovery } from './registry-storage-recovery.js';
import {
  type RegistryStorageObserved,
  type RegistryStorageRepairStatus,
  RegistryStorageRunner,
} from './registry-storage-runner.js';
import { RegistryS3Client } from './s3-client.js';

const logger = createChildLogger('DockerRegistryStorageService');
const REGISTRY_ID = LEGACY_INTERNAL_REGISTRY_ID;
const RECOVERY_RETRY_MS = 60_000;
/** Helpers a stopped Opfield left behind are looked for this often. */
const LEFTOVER_SWEEP_MS = 30 * 60_000;

export interface RegistryStorageView {
  backend: RegistryStorageBackend;
  /** The bucket settings without the secret key; null on the registry volume. */
  s3: RegistryS3SettingsView | null;
  /** The last storage switch; `failed` with the reason when it did not finish. */
  lastSwitch: RegistryStorageSwitchView | null;
  /**
   * False while a repair is pending: the registry container may run on another storage than .env and
   * docker-compose.yml select (`repair.observed`). Builds and pushes wait meanwhile.
   */
  consistent: boolean;
  /** The repair Opfield retries until the registry and the files agree; null when nothing needs repairing. */
  repair: RegistryStorageRepairStatus | null;
}

export interface DockerRegistryStorageDeps {
  db: DrizzleClient;
  docker: DockerService;
  tokenService: DockerRegistryTokenService;
  audit: AuditService;
  eventBus?: EventBusService;
  objectStorage?: () => ObjectStorageService;
  composeProjectDir?: string;
  registryUrl?: string;
}

function sameLocation(left: RegistryS3Settings, right: RegistryS3Settings): boolean {
  return (
    (left.endpoint ?? '') === (right.endpoint ?? '') &&
    left.bucket === right.bucket &&
    left.rootDirectory === right.rootDirectory
  );
}

function sameSettings(left: RegistryS3Settings | null, right: RegistryS3Settings | null): boolean {
  if (!left || !right) return left === right;
  return (
    sameLocation(left, right) &&
    left.region === right.region &&
    left.forcePathStyle === right.forcePathStyle &&
    left.accessKeyId === right.accessKeyId &&
    left.secretAccessKey === right.secretAccessKey
  );
}

/**
 * Managed storage cannot hold the registry: Opfield reaches it through a private tunnel that only the Opfield process
 * has (its endpoint is a loopback placeholder, a fresh port every start), and a published S3 endpoint is a node
 * address served with Opfield's internal certificate authority that moves when the storage fails over. The registry
 * container needs a fixed S3 endpoint it can reach and trust.
 */
function managedStorageRefused(): AppError {
  return new AppError(
    400,
    'REGISTRY_STORAGE_MANAGED_UNSUPPORTED',
    'Managed storage cannot hold the internal registry: Opfield reaches it through a private tunnel the registry container cannot use, and its published endpoint moves with failover. Choose an S3 connection to an external service (AWS S3, Cloudflare R2, a MinIO or SeaweedFS you run) or enter its endpoint and keys, or keep the registry on local disk'
  );
}

function view(settingsValue: RegistryS3Settings | null): RegistryS3SettingsView | null {
  if (!settingsValue) return null;
  const { secretAccessKey: _secret, ...rest } = settingsValue;
  return rest;
}

/**
 * Moves the internal registry between its local volume and an S3 bucket. The bucket is probed first (a refused
 * switch changes nothing); the switch then copies the registry's data to the new storage while the registry keeps
 * serving pulls with pushes paused, rewrites .env and docker-compose.yml so updates keep the choice, recreates the
 * registry and checks that every image in use is readable. Any failure puts the files and the registry back, and a
 * switch a restart interrupted is finished or rolled back at the next start (recoverAfterRestart).
 */
export class DockerRegistryStorageService {
  private readonly store: DockerRegistryMaintenanceStore;
  private readonly host: RegistryStorageHost;
  private readonly runner: RegistryStorageRunner;
  private readonly registryUrl: string;
  /** Who started each running switch, for its audit entry. */
  private readonly userIds = new Map<string, string>();
  private repair: RegistryStorageRepairStatus | null = null;
  private leftoverTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DockerRegistryStorageDeps) {
    this.store = createDockerRegistryMaintenanceStore(deps.db);
    this.host = new RegistryStorageHost(deps.docker, deps.composeProjectDir);
    this.registryUrl = deps.registryUrl ?? (process.env.OPFIELD_INTERNAL_REGISTRY_URL || 'http://registry:5000');
    this.runner = new RegistryStorageRunner({
      db: deps.db,
      store: this.store,
      host: this.host,
      docker: deps.docker,
      tokenService: deps.tokenService,
      registryUrl: this.registryUrl,
      emit: (action, state) => this.emit(action, state),
      audit: (record, outcome, target) => this.audit(record, outcome, target),
      repairStatus: (status) => {
        this.repair = status;
      },
    });
  }

  async getView(): Promise<RegistryStorageView> {
    const [current, lastSwitch, state] = await Promise.all([
      this.currentStorage().catch(() => null),
      readSwitchRecord(this.deps.db),
      this.store.getState().catch(() => null),
    ]);
    const backend = current ? current.backend : state?.storageBackend === 's3' ? 's3' : 'filesystem';
    // Only while no recovery could take it over (the host is not installer-managed).
    const interrupted =
      lastSwitch?.status === 'running' && state !== null && state.maintenancePhase !== 'switching_storage';
    return {
      backend,
      s3: view(current?.s3 ?? null),
      consistent: this.repair === null,
      repair: this.repair,
      lastSwitch: lastSwitch
        ? switchView(
            interrupted
              ? { ...lastSwitch, status: 'failed', error: 'Opfield restarted before the switch finished' }
              : lastSwitch
          )
        : null,
    };
  }

  /** Validates and starts a switch; it runs on in the background and reports through the registry state. */
  async update(input: RegistryStorageInput, actor: { userId: string; scopes: string[] }): Promise<RegistryStorageView> {
    if (this.repair) {
      throw new AppError(
        409,
        'REGISTRY_STORAGE_REPAIRING',
        `The registry storage is being repaired (attempt ${this.repair.attempts} failed: ${this.repair.lastError}). Opfield tries again at ${this.repair.nextAttemptAt}; change the storage once storage.consistent is true again.`
      );
    }
    const current = (
      await this.currentStorage().catch((error: Error) => {
        throw new AppError(
          409,
          'REGISTRY_STORAGE_UNMANAGED',
          `The registry container cannot be read: ${error.message}`
        );
      })
    ).s3;
    const target = input.backend === 'filesystem' ? null : await this.resolveTarget(input, current, actor.scopes);
    if (sameSettings(current, target)) return this.getView();
    let copy: RegistryStorageCopyPlan;
    if (!current && target) copy = 'to-bucket';
    else if (current && !target) copy = 'to-volume';
    else if (current && target && sameLocation(current, target)) copy = 'none';
    else {
      throw new AppError(
        409,
        'REGISTRY_STORAGE_MOVE_UNSUPPORTED',
        'Moving the registry to another bucket or folder is not supported directly: switch to Local disk first, then to the new bucket'
      );
    }
    const context = await this.host.context();
    if (target) {
      const client = new RegistryS3Client(target);
      const probe = await probeRegistryBucket(client, target.rootDirectory).catch((error: Error) => {
        throw new AppError(400, 'REGISTRY_STORAGE_PROBE_FAILED', `The bucket check failed: ${error.message}`);
      });
      if (copy === 'to-bucket' && probe.hasRegistryData && !probe.copiedByOpfield) {
        throw new AppError(
          409,
          'REGISTRY_STORAGE_NOT_EMPTY',
          `${client.describe()}${target.rootDirectory ? `/${target.rootDirectory}` : ''} already holds registry data Opfield did not copy. Choose an empty folder or empty it first.`
        );
      }
    }
    const owner = `registry-storage:${randomUUID()}`;
    const now = new Date();
    await this.store.acquireLease(owner, new Date(now.getTime() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS), now);
    const record: RegistryStorageSwitchRecord = {
      status: 'running',
      phase: 'draining',
      from: current ? 's3' : 'filesystem',
      target: target ? 's3' : 'filesystem',
      copy,
      owner,
      backup: null,
      inUse: [],
      startedAt: now.toISOString(),
      finishedAt: null,
      copiedFiles: null,
      copiedBytes: null,
      error: null,
    };
    try {
      await writeSwitchRecord(this.deps.db, record);
      this.emit(
        'maintenance',
        await this.store.updateState({ status: 'maintenance', writable: false, maintenancePhase: 'switching_storage' })
      );
    } catch (error) {
      await this.store
        .updateState({ maintenancePhase: 'idle', maintenanceLeaseOwner: null, maintenanceLeaseExpiresAt: null })
        .catch(() => undefined);
      throw error;
    }
    logger.info('Internal registry storage switch starts', { from: record.from, target: record.target, copy });
    this.userIds.set(owner, actor.userId);
    void this.runner
      .runSwitch(context, record, current, target)
      .then(async (needsRepair) => {
        if (needsRepair) await this.repairUntilConsistent(context, owner);
      })
      .catch((error: Error) => logger.error('Internal registry storage switch stopped', { error: error.message }))
      .finally(() => this.userIds.delete(owner));
    return this.getView();
  }

  /**
   * At start-up: compares the switch record, the host files and the running registry, and finishes or rolls back a
   * switch a restart interrupted (or makes the registry follow the .env). Returns whether it took the registry over;
   * when it did, the usual interrupted-maintenance recovery must not run. The repair, and a check that failed, are
   * tried again until the registry and the files agree. Also starts the removal of helper containers an earlier
   * process left behind.
   */
  async recoverAfterRestart(attempt = 1): Promise<boolean> {
    this.startLeftoverSweep();
    try {
      return await this.recoverOnce();
    } catch (error) {
      const delay = Math.min(RECOVERY_RETRY_MS * attempt, 10 * RECOVERY_RETRY_MS);
      logger.warn('Internal registry storage could not be checked after the start; checking again', {
        attempt,
        retryInMs: delay,
        error: (error as Error).message,
      });
      setTimeout(() => void this.recoverAfterRestart(attempt + 1), delay).unref?.();
      // A switch or repair the previous process ran keeps the registry in maintenance until the check succeeds.
      return this.store
        .getState()
        .then((state) => state.maintenanceLeaseOwner?.startsWith('registry-storage:') === true)
        .catch(() => false);
    }
  }

  /** What the registry, the host files and the switch record show now, and what to do about it. */
  private async observe(context: RegistryStorageHostContext): Promise<RegistryStorageObserved> {
    const record = await readSwitchRecord(this.deps.db);
    const [hostFiles, current] = await Promise.all([this.host.hostStorage(context), this.currentStorage()]);
    const observation = { record, hostEnv: hostFiles.env, hostCompose: hostFiles.compose, container: current.backend };
    return { ...observation, action: decideRegistryStorageRecovery(observation) };
  }

  private async recoverOnce(): Promise<boolean> {
    const context = await this.host.context().catch(() => null);
    // Not an installer-managed host (development): nothing on the host to compare.
    if (!context) return false;
    const observed = await this.observe(context);
    const { record, action } = observed;
    if (record?.status === 'completed' && record.target !== observed.hostEnv) {
      logger.warn('The .env names another registry storage than the last switch; the registry follows the .env', {
        lastSwitch: record.target,
        env: observed.hostEnv,
      });
    }
    if (action.kind === 'none') return false;
    logger.warn('Internal registry storage is repaired after a restart', {
      action,
      switchStatus: record?.status ?? null,
      switchPhase: record?.phase ?? null,
      env: observed.hostEnv,
      compose: observed.hostCompose,
      container: observed.container,
    });
    // The lease of a switch, or of a repair the previous process ran, is taken over rather than waited out.
    const leased = (await this.store.getState().catch(() => null))?.maintenanceLeaseOwner;
    const owner =
      record?.status === 'running'
        ? record.owner
        : leased?.startsWith('registry-storage:')
          ? leased
          : `registry-storage:${randomUUID()}`;
    await this.takeOver(owner);
    void this.runner
      .runRecovery(context, owner, observed, () => this.observe(context))
      .catch((error: Error) => logger.error('Internal registry storage repair stopped', { error: error.message }));
    return true;
  }

  /** A switch that could not roll back: repaired like an interrupted one, until the registry and the files agree. */
  private async repairUntilConsistent(context: RegistryStorageHostContext, owner: string): Promise<void> {
    await this.takeOver(owner);
    await this.runner.runRecovery(context, owner, null, () => this.observe(context));
  }

  /** The registry goes into maintenance under `owner`'s lease while it is repaired. */
  private async takeOver(owner: string): Promise<void> {
    const now = new Date();
    await this.store.acquireLease(owner, new Date(now.getTime() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS), now);
    this.emit(
      'maintenance',
      await this.store.updateState({ status: 'maintenance', writable: false, maintenancePhase: 'switching_storage' })
    );
  }

  /** Helper containers of a storage switch an earlier process left behind go now and every LEFTOVER_SWEEP_MS. */
  private startLeftoverSweep(): void {
    if (this.leftoverTimer || typeof this.deps.docker.removeLeftoverOneShots !== 'function') return;
    const sweep = () =>
      void this.deps.docker.removeLeftoverOneShots().catch((error: Error) => {
        logger.debug('Leftover helper containers could not be removed', { error: error.message });
      });
    sweep();
    this.leftoverTimer = setInterval(sweep, LEFTOVER_SWEEP_MS);
    this.leftoverTimer.unref?.();
  }

  private async resolveTarget(
    input: Extract<RegistryStorageInput, { backend: 's3' }>,
    current: RegistryS3Settings | null,
    scopes: string[]
  ): Promise<RegistryS3Settings> {
    let base: Partial<RegistryS3Settings> = {};
    if (input.connectionId) {
      if (!hasScopeForResource(scopes, 'storage:credentials:use', input.connectionId)) {
        throw new AppError(403, 'FORBIDDEN', 'Using this storage connection needs storage:credentials:use on it');
      }
      const objectStorage = this.deps.objectStorage?.();
      if (!objectStorage) throw new AppError(404, 'NOT_FOUND', 'Storage connections are unavailable');
      if ((await objectStorage.get(input.connectionId)).origin === 'managed') throw managedStorageRefused();
      const config = await objectStorage.getDecryptedConfig(input.connectionId);
      if (isFileProtocolConfig(config)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'The registry needs an S3 connection, not a file transfer one');
      }
      if (config.sessionToken) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Connections with temporary (session) keys cannot hold the registry'
        );
      }
      base = {
        endpoint: config.endpoint || null,
        region: config.region,
        bucket: config.defaultBucket ?? undefined,
        forcePathStyle: config.forcePathStyle,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }
    const accessKeyId = input.accessKeyId ?? base.accessKeyId;
    const secretAccessKey =
      input.secretAccessKey ??
      base.secretAccessKey ??
      (current && current.accessKeyId === accessKeyId ? current.secretAccessKey : undefined);
    const bucket = input.bucket ?? base.bucket;
    if (!accessKeyId || !secretAccessKey || !bucket) {
      throw new AppError(400, 'VALIDATION_ERROR', 'S3 storage needs a bucket, an access key and a secret key');
    }
    const resolved: RegistryS3Settings = {
      endpoint: (input.endpoint === undefined ? base.endpoint : input.endpoint || null) ?? null,
      region: input.region || base.region || 'us-east-1',
      bucket,
      rootDirectory: normalizeRegistryRootDirectory(input.rootDirectory ?? ''),
      forcePathStyle: input.forcePathStyle ?? base.forcePathStyle ?? false,
      accessKeyId,
      secretAccessKey,
    };
    for (const value of Object.values(resolved)) {
      if (typeof value === 'string' && /['\r\n\0]/.test(value)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'S3 settings must not contain quotes or line breaks');
      }
    }
    return resolved;
  }

  private async currentStorage() {
    const registry = await this.host.registry();
    return registryStorageFromContainerEnv(registry.Config.Env ?? []);
  }

  private async audit(
    record: RegistryStorageSwitchRecord,
    outcome: string,
    target: RegistryS3Settings | null
  ): Promise<void> {
    await this.deps.audit.log({
      action: 'docker.internal-registry.storage.update',
      userId: this.userIds.get(record.owner) ?? null,
      resourceType: 'docker-registry',
      resourceId: REGISTRY_ID,
      details: {
        outcome,
        from: record.from,
        target: record.target,
        ...(target
          ? {
              endpoint: target.endpoint,
              bucket: target.bucket,
              rootDirectory: target.rootDirectory,
              accessKeyId: target.accessKeyId,
            }
          : {}),
        copiedFiles: record.copiedFiles,
        error: record.error,
      },
    });
  }

  private emit(action: string, state: RegistryState): void {
    this.deps.eventBus?.publish('docker.registry.changed', {
      id: REGISTRY_ID,
      action,
      status: state.status,
      writable: state.writable,
      externalAccessEnabled: state.externalAccessEnabled,
    });
  }
}
