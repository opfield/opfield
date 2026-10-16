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
import { readableImagesInUse, verifyImagesReadable } from './registry-storage-verify.js';

const logger = createChildLogger('DockerRegistryStorageService');
/** A repair that failed is tried again after this long, doubling up to REPAIR_RETRY_MAX_MS, until it succeeds. */
export const REPAIR_RETRY_FIRST_MS = 30_000;
export const REPAIR_RETRY_MAX_MS = 5 * 60_000;

/** What the start-up check (or a repair attempt) found: the switch record, the host files and the running registry. */
export interface RegistryStorageObserved {
  record: RegistryStorageSwitchRecord | null;
  hostEnv: RegistryStorageBackend;
  hostCompose: RegistryStorageBackend;
  container: RegistryStorageBackend;
  action: RegistryStorageRecoveryAction;
}

/** A repair that has not succeeded yet: the registry may run on another storage than .env and docker-compose.yml say. */
export interface RegistryStorageRepairStatus {
  attempts: number;
  lastError: string;
  nextAttemptAt: string;
  /** What the last check found; null when even the check failed. */
  observed: { env: RegistryStorageBackend; compose: RegistryStorageBackend; container: RegistryStorageBackend } | null;
}

/** A switch whose images failed the check on the new storage and that is back on the previous one: done, failed. */
class SwitchRolledBack extends Error {}

export function repairRetryDelay(attempt: number): number {
  return Math.min(REPAIR_RETRY_MAX_MS, REPAIR_RETRY_FIRST_MS * 2 ** Math.max(0, attempt - 1));
}

export interface RegistryStorageRunnerDeps {
  db: DrizzleClient;
  store: DockerRegistryMaintenanceStore;
  host: RegistryStorageHost;
  docker: Pick<DockerService, 'managedRegistryStorageUsedBytes'>;
  tokenService: DockerRegistryTokenService;
  registryUrl: string;
  emit: (action: string, state: RegistryState) => void;
  audit: (record: RegistryStorageSwitchRecord, outcome: string, target: RegistryS3Settings | null) => Promise<void>;
  /** The repair state the API shows; null once the registry, .env and docker-compose.yml agree again. */
  repairStatus?: (status: RegistryStorageRepairStatus | null) => void;
  sleep?: (milliseconds: number) => Promise<void>;
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

  /**
   * Runs a switch. Returns true when a failure could not even put the previous storage back: the record stays
   * `running` (phase rolling_back) and the caller hands the registry to the repair (runRecovery), which retries until
   * the registry, .env and docker-compose.yml agree.
   */
  async runSwitch(
    context: RegistryStorageHostContext,
    record: RegistryStorageSwitchRecord,
    current: RegistryS3Settings | null,
    target: RegistryS3Settings | null
  ): Promise<boolean> {
    let needsRepair = false;
    await this.withLease(record.owner, async () => {
      try {
        // Write tokens are refused from now on; pushes that hold one finish before the copy starts.
        await new Promise((resolve) => setTimeout(resolve, REGISTRY_WRITE_DRAIN_GRACE_MS));
        // Images in use that the registry serves now must be served by the new storage as well.
        record.inUse = await readableImagesInUse(this.deps.store, this.deps.tokenService, this.deps.registryUrl);
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
          try {
            await this.rollBack(context, record, { restoreBackup: true, syncCompose: true, recreate: true });
            reason = `${reason}. The registry runs on the previous storage again.`;
          } catch (rollbackError) {
            // The registry may now run on one storage while the files name another: the repair takes over.
            record.error = `${reason}. Putting the previous storage back failed as well: ${message(rollbackError)}`;
            await writeSwitchRecord(this.deps.db, record).catch(() => undefined);
            logger.error('Internal registry storage switch failed and could not be rolled back; repairing', {
              target: record.target,
              error: record.error,
            });
            needsRepair = true;
            return;
          }
        } else {
          reason = `${reason}. The registry keeps its current storage.`;
        }
        logger.warn('Internal registry storage switch failed', { target: record.target, error: reason });
        await this.fail(record, reason);
        await this.deps.audit(record, 'failed', target).catch(() => undefined);
      }
    });
    return needsRepair;
  }

  /**
   * Repairs what a restart (or a switch that could not roll back) left, starting from `first` (checked first when
   * null), and tries again after every failure (REPAIR_RETRY_FIRST_MS, doubling up to REPAIR_RETRY_MAX_MS), checking
   * the host files and the registry afresh each time with `observe`, until they agree. Meanwhile the registry stays in maintenance: pulls
   * keep working, builds and pushes wait, and the state names the split and the next attempt.
   */
  async runRecovery(
    context: RegistryStorageHostContext,
    owner: string,
    first: RegistryStorageObserved | null,
    observe: () => Promise<RegistryStorageObserved>
  ): Promise<void> {
    const sleep = this.deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds).unref?.();
    }));
    await this.withLease(owner, async () => {
      let observed: RegistryStorageObserved | null = first;
      for (let attempt = 1; ; attempt += 1) {
        let checked: RegistryStorageObserved | null = observed;
        try {
          checked ??= await observe();
          await this.recoverOnce(context, checked);
          this.deps.repairStatus?.(null);
          return;
        } catch (error) {
          const reason = message(error);
          const delay = repairRetryDelay(attempt);
          const status: RegistryStorageRepairStatus = {
            attempts: attempt,
            lastError: reason,
            nextAttemptAt: new Date(Date.now() + delay).toISOString(),
            observed: checked ? { env: checked.hostEnv, compose: checked.hostCompose, container: checked.container } : null,
          };
          this.deps.repairStatus?.(status);
          logger.error('Internal registry storage repair failed; it is tried again', {
            attempt,
            retryInMs: delay,
            action: checked?.action.kind ?? null,
            error: reason,
          });
          await this.holdForRepair(status);
          await sleep(delay);
          observed = null;
        }
      }
    });
  }

  /** One repair attempt for what was observed; throws when it did not leave the registry and the files in agreement. */
  private async recoverOnce(context: RegistryStorageHostContext, observed: RegistryStorageObserved): Promise<void> {
    const { action, hostEnv } = observed;
    const record = observed.record?.status === 'running' ? observed.record : null;
    if (action.kind === 'none') {
      await this.ready(hostEnv);
      return;
    }
    if (action.kind === 'sync' || !record) {
      if (action.kind === 'sync' && action.syncCompose) await this.deps.host.syncCompose(context);
      if (action.kind === 'sync' && action.recreate) await this.deps.host.recreateRegistry(context, this.deps.registryUrl);
      await this.ready(hostEnv);
      logger.warn('Internal registry storage repaired: the registry follows the storage .env selects', {
        storage: hostEnv,
        ...action,
      });
      return;
    }
    try {
      if (action.kind === 'abandon') {
        if (action.cleanImport) await this.deps.host.cleanImport(context);
        await this.fail(record, 'Opfield restarted while the switch copied the images; the registry kept its storage');
      } else if (action.kind === 'rollback') {
        await this.rollBack(context, record, action);
        await this.fail(record, 'Opfield restarted during the switch; the registry runs on the previous storage again');
      } else {
        if (action.syncCompose) await this.deps.host.syncCompose(context);
        if (action.recreate) await this.deps.host.recreateRegistry(context, this.deps.registryUrl);
        if (action.verify) {
          await this.phase(record, 'verifying');
          const unreadable = await verifyImagesReadable(
            record.inUse ?? [],
            this.deps.tokenService,
            this.deps.registryUrl
          ).then(
            () => null,
            (error: unknown) => message(error)
          );
          if (unreadable) {
            await this.rollBack(context, record, { restoreBackup: true, syncCompose: true, recreate: true });
            throw new SwitchRolledBack(`${unreadable}. The registry runs on the previous storage again`);
          }
        }
        if (action.clearVolume) await this.clearVolumeIfMoved(context, record);
        await this.complete(record, 'Finished after an Opfield restart');
      }
    } catch (error) {
      if (!(error instanceof SwitchRolledBack)) throw error;
      await this.fail(record, `The switch could not be finished after a restart: ${error.message}`);
    }
    logger.warn('Internal registry storage switch repaired after a restart', {
      action: action.kind,
      outcome: record.status,
      target: record.target,
      error: record.error,
    });
    await this.deps.audit(record, `recovered:${action.kind}`, null).catch(() => undefined);
  }

  /** Between repair attempts: maintenance (builds and pushes wait, pulls go on) with the split and the next attempt. */
  private async holdForRepair(status: RegistryStorageRepairStatus): Promise<void> {
    const split = status.observed
      ? `the registry runs on ${status.observed.container}, while .env selects ${status.observed.env} and docker-compose.yml ${status.observed.compose}`
      : 'the registry storage could not be checked';
    const state = await this.deps.store
      .updateState({
        status: 'maintenance',
        writable: false,
        maintenancePhase: 'switching_storage',
        lastError: `Registry storage repair failed (attempt ${status.attempts}): ${split}. ${status.lastError}. Opfield tries again at ${status.nextAttemptAt}; builds and image pushes wait until then.`,
      })
      .catch(() => null);
    if (state) this.deps.emit('storage', state);
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
