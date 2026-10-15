import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { RegistryStorageBackend } from '@/foundation/registry-storage.js';
import type { RegistryImageRef } from './registry-storage-verify.js';

/**
 * The persisted progress of a registry storage switch (a `settings` row, no secrets). Every step is recorded before it
 * starts, so after a restart Opfield knows how far the switch got and finishes or rolls it back.
 */

const SWITCH_SETTING_KEY = 'internal_registry_storage_switch';

export type RegistryStorageCopyPlan = 'to-bucket' | 'to-volume' | 'none';

export type RegistryStorageSwitchPhase =
  | 'draining'
  | 'copying'
  | 'applying'
  | 'recreating'
  | 'verifying'
  | 'clearing'
  | 'rolling_back';

export interface RegistryStorageSwitchRecord {
  status: 'running' | 'completed' | 'failed';
  /** The step in progress while running; null once it ended. */
  phase: RegistryStorageSwitchPhase | null;
  from: RegistryStorageBackend;
  target: RegistryStorageBackend;
  copy: RegistryStorageCopyPlan;
  /** Maintenance lease owner of the switch; a recovery takes the lease over with it. */
  owner: string;
  /** Backup folder of .env and docker-compose.yml, named before the files are written. */
  backup: string | null;
  /** Images in use the previous storage served; the new storage must serve them too. */
  inUse: RegistryImageRef[];
  startedAt: string;
  finishedAt: string | null;
  copiedFiles: number | null;
  copiedBytes: number | null;
  /** Why it failed; on success a note (finished after a restart, volume not cleared). */
  error: string | null;
}

/** What the API shows of a switch. */
export type RegistryStorageSwitchView = Omit<RegistryStorageSwitchRecord, 'owner' | 'backup' | 'inUse'>;

export function switchView(record: RegistryStorageSwitchRecord): RegistryStorageSwitchView {
  const { owner: _owner, backup: _backup, inUse: _inUse, ...rest } = record;
  return { ...rest, phase: rest.phase ?? null, copy: rest.copy ?? 'none' };
}

export async function readSwitchRecord(db: DrizzleClient): Promise<RegistryStorageSwitchRecord | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SWITCH_SETTING_KEY)).limit(1);
  return (row?.value as RegistryStorageSwitchRecord | undefined) ?? null;
}

export async function writeSwitchRecord(db: DrizzleClient, record: RegistryStorageSwitchRecord): Promise<void> {
  await db
    .insert(settings)
    .values({ key: SWITCH_SETTING_KEY, value: record, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: record, updatedAt: new Date() } });
}
