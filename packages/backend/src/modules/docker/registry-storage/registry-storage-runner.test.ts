import { describe, expect, it, vi } from 'vitest';
import type { RegistryStorageSwitchRecord } from './registry-storage-record.js';
import { decideRegistryStorageRecovery } from './registry-storage-recovery.js';
import {
  REPAIR_RETRY_FIRST_MS,
  REPAIR_RETRY_MAX_MS,
  type RegistryStorageObserved,
  RegistryStorageRunner,
  repairRetryDelay,
} from './registry-storage-runner.js';

/** The switch record writes go to a settings upsert. */
function database() {
  const written: RegistryStorageSwitchRecord[] = [];
  return {
    written,
    db: {
      insert: () => ({
        values: (row: { value: RegistryStorageSwitchRecord }) => ({
          onConflictDoUpdate: async () => {
            written.push(structuredClone(row.value));
          },
        }),
      }),
    },
  };
}

function runner(host: Record<string, unknown>) {
  const { db, written } = database();
  const states: Array<Record<string, unknown>> = [];
  const store = {
    updateState: vi.fn(async (values: Record<string, unknown>) => {
      states.push(values);
      return { status: values.status, writable: values.writable, externalAccessEnabled: false };
    }),
    renewLease: vi.fn(async () => undefined),
  };
  const repairStatus = vi.fn();
  const service = new RegistryStorageRunner({
    db: db as never,
    store: store as never,
    host: host as never,
    docker: { managedRegistryStorageUsedBytes: async () => 1024 },
    tokenService: {} as never,
    registryUrl: 'http://registry:5000',
    emit: () => undefined,
    audit: async () => undefined,
    repairStatus,
    sleep: async () => undefined,
  });
  return { service, written, states, repairStatus };
}

/** Killed while the switch from S3 back to the volume wrote the files: .env and compose say filesystem, the registry S3. */
function killedMidApply(): RegistryStorageObserved {
  const record: RegistryStorageSwitchRecord = {
    status: 'running',
    phase: 'applying',
    from: 's3',
    target: 'filesystem',
    copy: 'to-volume',
    owner: 'registry-storage:switch',
    backup: 'registry-storage-backup',
    inUse: [],
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    copiedFiles: 3,
    copiedBytes: 30,
    error: null,
  };
  const observation = { record, hostEnv: 'filesystem', hostCompose: 'filesystem', container: 's3' } as const;
  return { ...observation, action: decideRegistryStorageRecovery(observation) };
}

describe('registry storage repair after a restart (F-3)', () => {
  it('retries a failed repair until the registry runs on the storage the files select, waiting in maintenance', async () => {
    const recreateRegistry = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('docker compose config failed: can not get logs from container which is dead or marked for removal')
      )
      .mockResolvedValueOnce(undefined);
    const host = { recreateRegistry, syncCompose: vi.fn(), restoreHostFiles: vi.fn(), clearVolume: vi.fn() };
    const { service, written, states, repairStatus } = runner(host);
    const first = killedMidApply();
    expect(first.action).toMatchObject({ kind: 'finish', recreate: true, verify: true });
    const observe = vi.fn(async () => killedMidApply());

    await service.runRecovery({} as never, 'registry-storage:switch', first, observe);

    expect(recreateRegistry).toHaveBeenCalledTimes(2);
    // Checked afresh before the second attempt.
    expect(observe).toHaveBeenCalledTimes(1);
    // Between the attempts the registry waits in maintenance and says why, never ready on the wrong storage.
    expect(repairStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attempts: 1,
        observed: { env: 'filesystem', compose: 'filesystem', container: 's3' },
      })
    );
    const held = states.find((state) => state.status === 'maintenance');
    expect(held).toMatchObject({ writable: false, maintenancePhase: 'switching_storage' });
    expect(String(held?.lastError)).toContain('the registry runs on s3, while .env selects filesystem');
    expect(states.findIndex((state) => state.status === 'ready')).toBeGreaterThan(states.indexOf(held!));
    // Finished on the new storage once consistent.
    expect(repairStatus).toHaveBeenLastCalledWith(null);
    expect(written.at(-1)).toMatchObject({
      status: 'completed',
      phase: null,
      error: 'Finished after an Opfield restart',
    });
  });

  it('keeps retrying while even the check of the host files fails', async () => {
    const host = { recreateRegistry: vi.fn(async () => undefined), syncCompose: vi.fn() };
    const { service, repairStatus } = runner(host);
    const observe = vi
      .fn()
      .mockRejectedValueOnce(new Error('Registry storage step status failed: exit code 1'))
      .mockRejectedValueOnce(new Error('Registry storage step status failed: exit code 1'))
      .mockResolvedValueOnce(killedMidApply());

    await service.runRecovery({} as never, 'registry-storage:switch', null, observe);

    expect(observe).toHaveBeenCalledTimes(3);
    expect(repairStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempts: 2, observed: null }));
    expect(repairStatus).toHaveBeenLastCalledWith(null);
  });

  it('waits longer after each failed attempt, up to five minutes', () => {
    expect(repairRetryDelay(1)).toBe(REPAIR_RETRY_FIRST_MS);
    expect(repairRetryDelay(2)).toBe(2 * REPAIR_RETRY_FIRST_MS);
    expect(repairRetryDelay(30)).toBe(REPAIR_RETRY_MAX_MS);
  });
});
