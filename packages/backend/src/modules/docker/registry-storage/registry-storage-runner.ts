import type { DrizzleClient } from '@/db/client.js';
import type { RegistryS3Settings, RegistryStorageBackend } from '@/foundation/registry-storage.js';
import { createChildLogger } from '@/lib/logger.js';
import type { DockerService } from '@/services/docker.service.js';
import {
  DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS,
  type DockerRegistryMaintenanceStore,
  REGISTRY_WRITE_DRAIN_GRACE_MS,
  type RegistryState,
} from '../docker-registry-maintenance.js';
import type { DockerRegistryTokenService } from '../docker-registry-token.service.js';
import type { RegistryStorageHost, RegistryStorageHostContext } from './registry-storage-host.js';
import {
  type RegistryStorageSwitchPhase,
  type RegistryStorageSwitchRecord,
  writeSwitchRecord,
} from './registry-storage-record.js';
import type { RegistryStorageRecoveryAction } from './registry-storage-recovery.js';
import { readablePinnedImages, verifyImagesReadable } from './registry-storage-verify.js';

const logger = createChildLogger('DockerRegistryStorageService');

export interface RegistryStorageRunnerDeps {
  db: DrizzleClient;
  store: DockerRegistryMaintenanceStore;
  host: RegistryStorageHost;
  docker: Pick<DockerService, 'managedRegistryStorageUsedBytes'>;
  tokenService: DockerRegistryTokenService;
  registryUrl: string;
  emit: (action: string, state: RegistryState) => void;
  audit: (record: RegistryStorageSwitchRecord, outcome: string, target: RegistryS3Settings | null) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carries out a storage switch, or what a restart left of one, step by step. Each step is recorded before it starts
 * (see registry-storage-record.ts); the registry stays in maintenance (pushes paused) until the run ends.
 */
export class RegistryStorageRunner {
  constructor(private readonly deps: RegistryStorageRunnerDeps) {}

  async runSwitch(
    context: RegistryStorageHostContext,
    record: RegistryStorageSwitchRecord,
    current: RegistryS3Settings | null,
    target: RegistryS3Settings | null
  ): Promise<void> {
    await this.withLease(record.owner, async () => {
      try {
        // Write tokens are refused from now on; pushes that hold one finish before the copy starts.
        await new Promise((resolve) => setTimeout(resolve, REGISTRY_WRITE_DRAIN_GRACE_MS));
        // Images in use that the registry serves now must be served by the new storage as well.
        record.inUse = await readablePinnedImages(this.deps.store, this.deps.tokenService, this.deps.registryUrl);
        if (record.copy !== 'none') {
          await this.phase(record, 'copying');
          const copied =
            record.copy === 'to-bucket'
              ? await this.deps.host.copyToBucket(context, target!)
              : await this.deps.host.copyToVolume(context, current!);
          record.copiedFiles = copied.files;
          record.copiedBytes = copied.bytes;
        }
        record.backup = `registry-storage-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await this.phase(record, 'applying');
        await this.deps.host.applyHostFiles(context, target, record.backup);
        await this.phase(record, 'recreating');
        await this.deps.host.recreateRegistry(context, this.deps.registryUrl);
        await this.phase(record, 'verifying');
        await verifyImagesReadable(record.inUse, this.deps.tokenService, this.deps.registryUrl);
        await this.clearVolumeIfMoved(context, record);
        await this.complete(record, null);
        logger.info('Internal registry storage switch finished', { target: record.target });
        await this.deps.audit(record, 'completed', target);
      } catch (error) {
        let reason = message(error);
        if (record.backup) {
          reason = await this.rollBack(context, record, { restoreBackup: true, syncCompose: true, recreate: true })
            .then(() => `${reason}. The registry runs on the previous storage again.`)
            .catch(
              (rollbackError) =>
                `${reason}. Putting the previous storage back failed as well: ${message(rollbackError)}`
            );
        } else {
          reason = `${reason}. The registry keeps its current storage.`;
        }
        logger.warn('Internal registry storage switch failed', { target: record.target, error: reason });
        await this.fail(record, reason);
        await this.deps.audit(record, 'failed', target).catch(() => undefined);
      }
    });
  }

  /** Repairs what a restart left; logs what it did. `hostEnv` is the storage the .env selects. */
  async runRecovery(
    context: RegistryStorageHostContext,
    record: RegistryStorageSwitchRecord | null,
    action: Exclude<RegistryStorageRecoveryAction, { kind: 'none' }>,
    owner: string,
    hostEnv: RegistryStorageBackend
  ): Promise<void> {
    await this.withLease(owner, async () => {
      try {
        if (action.kind === 'sync' || !record) {
          if (action.kind === 'sync' && action.syncCompose) await this.deps.host.syncCompose(context);
          if (action.kind === 'sync' && action.recreate)
            await this.deps.host.recreateRegistry(context, this.deps.registryUrl);
          await this.ready(hostEnv);
          logger.warn('Internal registry storage repaired: the registry follows the storage .env selects', {
            storage: hostEnv,
            ...action,
          });
          return;
        }
        if (action.kind === 'abandon') {
          if (action.cleanImport) await this.deps.host.cleanImport(context);
          await this.fail(
            record,
            'Opfield restarted while the switch copied the images; the registry kept its storage'
          );
        } else if (action.kind === 'rollback') {
          await this.rollBack(context, record, action);
          await this.fail(
            record,
            'Opfield restarted during the switch; the registry runs on the previous storage again'
          );
        } else {
          if (action.syncCompose) await this.deps.host.syncCompose(context);
          if (action.recreate) await this.deps.host.recreateRegistry(context, this.deps.registryUrl);
          if (action.verify) {
            await this.phase(record, 'verifying');
            await verifyImagesReadable(record.inUse ?? [], this.deps.tokenService, this.deps.registryUrl).catch(
              async (error) => {
                await this.rollBack(context, record, { restoreBackup: true, syncCompose: true, recreate: true });
                throw new Error(`${message(error)}. The registry runs on the previous storage again`);
              }
            );
          }
          if (action.clearVolume) await this.clearVolumeIfMoved(context, record);
          await this.complete(record, 'Finished after an Opfield restart');
        }
        logger.warn('Internal registry storage switch repaired after a restart', {
          action: action.kind,
          outcome: record.status,
          target: record.target,
          error: record.error,
        });
        await this.deps.audit(record, `recovered:${action.kind}`, null).catch(() => undefined);
      } catch (error) {
        const reason = `The switch could not be repaired after a restart: ${message(error)}`;
        logger.error('Internal registry storage repair failed', { action: action.kind, error: reason });
        if (record) await this.fail(record, reason);
        else await this.ready(hostEnv, reason);
      }
    });
  }

  private async rollBack(
    context: RegistryStorageHostContext,
    record: RegistryStorageSwitchRecord,
    steps: { restoreBackup: boolean; syncCompose: boolean; recreate: boolean }
  ): Promise<void> {
    await this.phase(record, 'rolling_back');
    if (steps.restoreBackup && record.backup) await this.deps.host.restoreHostFiles(context, record.backup);
    if (steps.syncCompose) await this.deps.host.syncCompose(context);
    if (steps.recreate) await this.deps.host.recreateRegistry(context, this.deps.registryUrl);
  }

  /** After a move to S3 the volume's copy goes: freeing the local disk is the point of the bucket. */
  private async clearVolumeIfMoved(context: RegistryStorageHostContext, record: RegistryStorageSwitchRecord) {
    if (record.copy !== 'to-bucket') return;
    await this.phase(record, 'clearing');
    await this.deps.host.clearVolume(context).catch((error: Error) => {
      record.error = `The registry runs on S3, but its old data could not be removed from the volume: ${error.message}`;
      logger.warn('Internal registry volume was not cleared after the switch to S3', { error: error.message });
    });
  }

  private async phase(record: RegistryStorageSwitchRecord, phase: RegistryStorageSwitchPhase): Promise<void> {
    record.phase = phase;
    await writeSwitchRecord(this.deps.db, record);
  }

  private async complete(record: RegistryStorageSwitchRecord, note: string | null): Promise<void> {
    record.status = 'completed';
    record.phase = null;
    record.finishedAt = new Date().toISOString();
    if (note) record.error = record.error ? `${note}. ${record.error}` : note;
    await writeSwitchRecord(this.deps.db, record);
    await this.ready(record.target);
  }

  private async fail(record: RegistryStorageSwitchRecord, reason: string): Promise<void> {
    record.status = 'failed';
    record.phase = null;
    record.error = reason;
    record.finishedAt = new Date().toISOString();
    await writeSwitchRecord(this.deps.db, record).catch(() => undefined);
    await this.ready(null, `Registry storage switch failed: ${reason}`);
  }

  /** Leaves maintenance; the health probe settles the status within seconds. */
  private async ready(backend: RegistryStorageBackend | null, lastError: string | null = null): Promise<void> {
    const usedBytes = backend ? await this.deps.docker.managedRegistryStorageUsedBytes().catch(() => null) : null;
    const state = await this.deps.store
      .updateState({
        status: lastError ? 'degraded' : 'ready',
        writable: true,
        ...(backend ? { storageBackend: backend } : {}),
        ...(usedBytes !== null ? { storageUsedBytes: usedBytes } : {}),
        maintenancePhase: 'idle',
        maintenanceLeaseOwner: null,
        maintenanceLeaseExpiresAt: null,
        lastError,
      })
      .catch(() => null);
    if (state) this.deps.emit('storage', state);
  }

  private async withLease(owner: string, work: () => Promise<void>): Promise<void> {
    const renew = setInterval(() => {
      void this.deps.store
        .renewLease(owner, new Date(Date.now() + DEFAULT_REGISTRY_MAINTENANCE_LEASE_MS))
        .catch(() => undefined);
    }, 60_000);
    renew.unref?.();
    try {
      await work();
    } finally {
      clearInterval(renew);
    }
  }
}
