import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import {
  normalizeRegistryRootDirectory,
  type RegistryS3Settings,
  type RegistryS3SettingsView,
  type RegistryStorageBackend,
  registryStorageFromContainerEnv,
} from '@/foundation/registry-storage.js';
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
  REGISTRY_WRITE_DRAIN_GRACE_MS,
} from '../docker-registry-maintenance.js';
import type { DockerRegistryTokenService } from '../docker-registry-token.service.js';
import type { RegistryStorageInput } from './registry-storage.schemas.js';
import { probeRegistryBucket } from './registry-storage-copy.js';
import { RegistryStorageHost, type RegistryStorageHostContext } from './registry-storage-host.js';
import { readablePinnedImages, verifyImagesReadable } from './registry-storage-verify.js';
import { RegistryS3Client } from './s3-client.js';

const logger = createChildLogger('DockerRegistryStorageService');
const SWITCH_SETTING_KEY = 'internal_registry_storage_switch';
const REGISTRY_ID = 'gateway-internal-registry';

export interface RegistryStorageSwitchRecord {
  status: 'running' | 'completed' | 'failed';
  from: RegistryStorageBackend;
  target: RegistryStorageBackend;
  startedAt: string;
  finishedAt: string | null;
  copiedFiles: number | null;
  copiedBytes: number | null;
  error: string | null;
}

export interface RegistryStorageView {
  backend: RegistryStorageBackend;
  /** The bucket settings without the secret key; null on the registry volume. */
  s3: RegistryS3SettingsView | null;
  /** The last storage switch; `failed` with the reason when it did not finish. */
  lastSwitch: RegistryStorageSwitchRecord | null;
}

type CopyPlan = 'to-bucket' | 'to-volume' | 'none';

interface SwitchPlan {
  owner: string;
  context: RegistryStorageHostContext;
  current: RegistryS3Settings | null;
  target: RegistryS3Settings | null;
  copy: CopyPlan;
  record: RegistryStorageSwitchRecord;
  userId: string;
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

function view(settingsValue: RegistryS3Settings | null): RegistryS3SettingsView | null {
  if (!settingsValue) return null;
  const { secretAccessKey: _secret, ...rest } = settingsValue;
  return rest;
}

/**
 * Moves the internal registry between its local volume and an S3 bucket. The bucket is probed first (a refused
 * switch changes nothing); the switch then copies the registry's data to the new storage while the registry keeps
 * serving pulls with pushes paused, rewrites .env and docker-compose.yml so updates keep the choice, recreates the
 * registry and checks that every image in use is readable. Any failure puts the files and the registry back.
 */
export class DockerRegistryStorageService {
  private readonly store: DockerRegistryMaintenanceStore;
  private readonly host: RegistryStorageHost;
  private readonly registryUrl: string;

  constructor(private readonly deps: DockerRegistryStorageDeps) {
    this.store = createDockerRegistryMaintenanceStore(deps.db);
    this.host = new RegistryStorageHost(deps.docker, deps.composeProjectDir);
    this.registryUrl = deps.registryUrl ?? (process.env.OPFIELD_INTERNAL_REGISTRY_URL || 'http://registry:5000');
  }

  async getView(): Promise<RegistryStorageView> {
    const [current, lastSwitch, state] = await Promise.all([
      this.currentStorage().catch(() => null),
      this.readRecord(),
      this.store.getState().catch(() => null),
    ]);
    const backend = current ? (current.s3 ? 's3' : 'filesystem') : state?.storageBackend === 's3' ? 's3' : 'filesystem';
    const interrupted =
      lastSwitch?.status === 'running' && state !== null && state.maintenancePhase !== 'switching_storage';
    return {
      backend,
      s3: view(current?.s3 ?? null),
      lastSwitch:
        lastSwitch && interrupted
          ? { ...lastSwitch, status: 'failed', error: 'Opfield restarted before the switch finished' }
          : lastSwitch,
    };
  }

  /** Validates and starts a switch; it runs on in the background and reports through the registry state. */
  async update(input: RegistryStorageInput, actor: { userId: string; scopes: string[] }): Promise<RegistryStorageView> {
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
    let copy: CopyPlan;
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
      from: current ? 's3' : 'filesystem',
      target: target ? 's3' : 'filesystem',
      startedAt: now.toISOString(),
      finishedAt: null,
      copiedFiles: null,
      copiedBytes: null,
      error: null,
    };
    try {
      await this.writeRecord(record);
      this.emit(
        'maintenance',
        await this.store.updateState({ status: 'maintenance', writable: false, maintenancePhase: 'switching_storage' })
      );
    } catch (error) {
      await this.releaseLease(error instanceof Error ? error.message : String(error));
      throw error;
    }
    logger.info('Internal registry storage switch starts', { from: record.from, target: record.target, copy });
    void this.runSwitch({ owner, context, current, target, copy, record, userId: actor.userId });
    return this.getView();
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

  private async runSwitch(plan: SwitchPlan): Promise<void> {
    const { context, record } = plan;
    const renew = setInterval(() => {
      void this.store
        .renewLease(plan.owner, new Date(Date.now() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS))
        .catch(() => undefined);
    }, 60_000);
    renew.unref?.();
    let backup: string | null = null;
    try {
      // Write tokens are refused from now on; pushes that hold one finish before the copy starts.
      await new Promise((resolve) => setTimeout(resolve, REGISTRY_WRITE_DRAIN_GRACE_MS));
      // Images in use that the registry serves now must be served by the new storage as well.
      const inUse = await readablePinnedImages(this.store, this.deps.tokenService, this.registryUrl);
      if (plan.copy !== 'none') {
        const copied =
          plan.copy === 'to-bucket'
            ? await this.host.copyToBucket(context, plan.target!)
            : await this.host.copyToVolume(context, plan.current!);
        record.copiedFiles = copied.files;
        record.copiedBytes = copied.bytes;
        await this.writeRecord(record);
      }
      backup = await this.host.applyHostFiles(context, plan.target);
      await this.host.recreateRegistry(context, this.registryUrl);
      await verifyImagesReadable(inUse, this.deps.tokenService, this.registryUrl);
      if (plan.copy === 'to-bucket') {
        // The point of the bucket is the local disk: the volume's copy goes once the registry serves from S3.
        await this.host.clearVolume(context).catch((error: Error) => {
          record.error = `The registry runs on S3, but its old data could not be removed from the volume: ${error.message}`;
          logger.warn('Internal registry volume was not cleared after the switch to S3', { error: error.message });
        });
      }
      record.status = 'completed';
      record.finishedAt = new Date().toISOString();
      await this.writeRecord(record);
      this.emit(
        'storage',
        await this.store.updateState({
          status: 'ready',
          writable: true,
          storageBackend: record.target,
          ...(record.target === 's3' ? { storageUsedBytes: 0 } : {}),
          maintenancePhase: 'idle',
          maintenanceLeaseOwner: null,
          maintenanceLeaseExpiresAt: null,
          lastError: null,
        })
      );
      logger.info('Internal registry storage switch finished', { target: record.target });
      await this.audit(plan, 'completed');
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (backup) {
        try {
          await this.host.restoreHostFiles(context, backup);
          await this.host.recreateRegistry(context, this.registryUrl);
          message = `${message}. The registry runs on the previous storage again.`;
        } catch (rollbackError) {
          message = `${message}. Putting the previous storage back failed as well: ${(rollbackError as Error).message}`;
        }
      } else {
        message = `${message}. The registry keeps its current storage.`;
      }
      logger.warn('Internal registry storage switch failed', { target: record.target, error: message });
      record.status = 'failed';
      record.error = message;
      record.finishedAt = new Date().toISOString();
      await this.writeRecord(record).catch(() => undefined);
      await this.releaseLease(message);
      await this.audit(plan, 'failed').catch(() => undefined);
    } finally {
      clearInterval(renew);
    }
  }

  private async releaseLease(error: string): Promise<void> {
    const state = await this.store
      .updateState({
        status: 'degraded',
        writable: true,
        maintenancePhase: 'idle',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastError: `Registry storage switch failed: ${error}`,
      })
      .catch(() => null);
    if (state) this.emit('storage', state);
  }

  private async currentStorage() {
    const registry = await this.host.registry();
    return registryStorageFromContainerEnv(registry.Config.Env ?? []);
  }

  private async readRecord(): Promise<RegistryStorageSwitchRecord | null> {
    const [row] = await this.deps.db.select().from(settings).where(eq(settings.key, SWITCH_SETTING_KEY)).limit(1);
    return (row?.value as RegistryStorageSwitchRecord | undefined) ?? null;
  }

  private async writeRecord(record: RegistryStorageSwitchRecord): Promise<void> {
    await this.deps.db
      .insert(settings)
      .values({ key: SWITCH_SETTING_KEY, value: record, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: record, updatedAt: new Date() } });
  }

  private async audit(plan: SwitchPlan, outcome: 'completed' | 'failed'): Promise<void> {
    await this.deps.audit.log({
      action: 'docker.internal-registry.storage.update',
      userId: plan.userId,
      resourceType: 'docker-registry',
      resourceId: REGISTRY_ID,
      details: {
        outcome,
        from: plan.record.from,
        target: plan.record.target,
        ...(plan.target
          ? {
              endpoint: plan.target.endpoint,
              bucket: plan.target.bucket,
              rootDirectory: plan.target.rootDirectory,
              accessKeyId: plan.target.accessKeyId,
            }
          : {}),
        copiedFiles: plan.record.copiedFiles,
        error: plan.record.error,
      },
    });
  }

  private emit(action: string, state: { status: string; writable: boolean; externalAccessEnabled: boolean }): void {
    this.deps.eventBus?.publish('docker.registry.changed', {
      id: REGISTRY_ID,
      action,
      status: state.status,
      writable: state.writable,
      externalAccessEnabled: state.externalAccessEnabled,
    });
  }
}
