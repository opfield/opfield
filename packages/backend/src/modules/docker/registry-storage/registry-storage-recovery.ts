import type { RegistryStorageBackend } from '@/foundation/registry-storage.js';
import type { RegistryStorageSwitchRecord } from './registry-storage-record.js';

/**
 * What Opfield does at start-up about the registry storage, from three observations: the persisted switch record,
 * the host files (.env holds the choice, docker-compose.yml the registry block made from it) and the storage the
 * running registry container uses. Pure: the service carries the action out and logs it.
 */

export interface RegistryStorageObservation {
  record: Pick<RegistryStorageSwitchRecord, 'status' | 'phase' | 'from' | 'target'> | null;
  hostEnv: RegistryStorageBackend;
  hostCompose: RegistryStorageBackend;
  container: RegistryStorageBackend;
}

export type RegistryStorageRecoveryAction =
  | { kind: 'none' }
  /** No switch ran: the registry block and the container follow the .env choice. */
  | { kind: 'sync'; syncCompose: boolean; recreate: boolean }
  /** Stopped before any host file changed: the registry kept its storage; only leftovers go. */
  | { kind: 'abandon'; cleanImport: boolean }
  /** The new storage was written and the data is there: recreate on it, check the images, finish. */
  | { kind: 'finish'; syncCompose: boolean; recreate: boolean; verify: boolean; clearVolume: boolean }
  /** Back to the previous storage (the files say so already, or the backup puts them back). */
  | { kind: 'rollback'; restoreBackup: boolean; syncCompose: boolean; recreate: boolean };

export function decideRegistryStorageRecovery(observed: RegistryStorageObservation): RegistryStorageRecoveryAction {
  const { record, hostEnv, hostCompose, container } = observed;
  if (!record || record.status !== 'running' || !record.phase) {
    if (hostCompose === hostEnv && container === hostEnv) return { kind: 'none' };
    return { kind: 'sync', syncCompose: hostCompose !== hostEnv, recreate: container !== hostEnv };
  }
  const { phase, from, target } = record;
  const sameBackend = from === target;
  const untouched = hostEnv === from && hostCompose === from && container === from;
  if ((phase === 'draining' || phase === 'copying') && (sameBackend || untouched)) {
    return { kind: 'abandon', cleanImport: phase === 'copying' && target === 'filesystem' };
  }
  if (phase === 'rolling_back') {
    return { kind: 'rollback', restoreBackup: true, syncCompose: true, recreate: true };
  }
  const clearVolume = target === 's3' && from === 'filesystem';
  if (phase === 'clearing') {
    // The images were checked on the new storage already.
    return {
      kind: 'finish',
      syncCompose: hostCompose !== hostEnv,
      recreate: hostEnv !== target || hostCompose !== target || container !== target,
      verify: false,
      clearVolume,
    };
  }
  if (sameBackend || hostEnv === target) {
    return { kind: 'finish', syncCompose: hostCompose !== hostEnv, recreate: true, verify: true, clearVolume };
  }
  return {
    kind: 'rollback',
    restoreBackup: false,
    syncCompose: hostCompose !== from,
    recreate: container !== from || hostCompose !== from,
  };
}
