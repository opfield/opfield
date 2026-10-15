import { describe, expect, it } from 'vitest';
import { decideRegistryStorageRecovery, type RegistryStorageObservation } from './registry-storage-recovery.js';

const toS3 = (phase: string) =>
  ({ status: 'running', phase, from: 'filesystem', target: 's3' }) as RegistryStorageObservation['record'];

describe('registry storage recovery after a restart', () => {
  it('finishes, rolls back or abandons an interrupted switch from what the host and the registry show', () => {
    const decide = (observation: Partial<RegistryStorageObservation>) =>
      decideRegistryStorageRecovery({
        record: null,
        hostEnv: 'filesystem',
        hostCompose: 'filesystem',
        container: 'filesystem',
        ...observation,
      });
    // Nothing ran and everything agrees.
    expect(decide({})).toEqual({ kind: 'none' });
    expect(decide({ record: { ...toS3('copying')!, status: 'completed', phase: null } })).toEqual({ kind: 'none' });
    // Copying: no host file changed yet, so the registry kept its storage.
    expect(decide({ record: toS3('copying') })).toEqual({ kind: 'abandon', cleanImport: false });
    expect(
      decide({
        record: { status: 'running', phase: 'copying', from: 's3', target: 'filesystem' },
        hostEnv: 's3',
        hostCompose: 's3',
        container: 's3',
      })
    ).toEqual({ kind: 'abandon', cleanImport: true });
    // The .env was written, the registry not recreated yet: finish on the new storage and check the images.
    expect(decide({ record: toS3('applying'), hostEnv: 's3' })).toEqual({
      kind: 'finish',
      syncCompose: true,
      recreate: true,
      verify: true,
      clearVolume: true,
    });
    // The files were not written (or already put back): only make sure the registry runs on the previous storage.
    expect(decide({ record: toS3('recreating'), container: 's3' })).toEqual({
      kind: 'rollback',
      restoreBackup: false,
      syncCompose: false,
      recreate: true,
    });
    // A rollback in progress goes on; a checked switch only clears the volume.
    expect(decide({ record: toS3('rolling_back'), hostEnv: 's3', hostCompose: 's3', container: 's3' })).toMatchObject({
      kind: 'rollback',
      restoreBackup: true,
    });
    expect(decide({ record: toS3('clearing'), hostEnv: 's3', hostCompose: 's3', container: 's3' })).toEqual({
      kind: 'finish',
      syncCompose: false,
      recreate: false,
      verify: false,
      clearVolume: true,
    });
    // No switch, but the registry does not run on the storage the .env selects.
    expect(decide({ hostEnv: 's3' })).toEqual({ kind: 'sync', syncCompose: true, recreate: true });
  });
});
