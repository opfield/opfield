import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger.js')>()),
  createChildLogger: () => log,
}));

const { DockerInternalRegistryService } = await import('./docker-registry-internal.service.js');

function service() {
  const run = { id: 'run-1', status: 'running', dryRun: false, progress: {} };
  const store = {
    initialize: vi.fn(),
    getState: vi.fn(async () => ({ status: 'ready', maintenancePhase: 'idle' })),
    updateState: vi.fn(async (values: object) => ({ status: 'ready', ...values })),
    acquireLease: vi.fn(async () => ({})),
    renewLease: vi.fn(async () => {}),
    createRun: vi.fn(async () => run),
    getRun: vi.fn(async () => run),
    updateRun: vi.fn(async (_id: string, values: object) => Object.assign(run, values)),
    listRetentionArtifacts: vi.fn(async () => []),
    markArtifactDeleted: vi.fn(async () => {}),
  };
  const registry = new DockerInternalRegistryService(
    {} as never,
    {} as never,
    { log: vi.fn(async () => {}) } as never,
    store as never
  );
  registry.setExecutor({
    hasRepositories: async () => false,
    storageUsedBytes: async () => 0,
    pauseAdmissions: async () => {},
    drainUploads: async () => {},
    deleteManifest: async () => {},
    enterReadOnly: async () => {},
    collectGarbage: async () => {},
    verifyIntegrity: async () => {},
    restoreWrites: async () => {},
  });
  return registry;
}

describe('internal registry garbage collection', () => {
  it('logs why it restarts the registry, at the start and at the end', async () => {
    await service().runGarbageCollection({ retentionCount: 1, reason: 'Availability no longer uses some images' });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('the registry restarts'), {
      reason: 'Availability no longer uses some images',
    });
    expect(log.info).toHaveBeenCalledWith(
      'Internal registry garbage collection ended',
      expect.objectContaining({ reason: 'Availability no longer uses some images', status: 'completed' })
    );
  });

  it('names housekeeping or the user when the caller gives no reason, and logs nothing for a dry run', async () => {
    log.info.mockClear();
    await service().runGarbageCollection({});
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('starts'), { reason: 'housekeeping' });

    log.info.mockClear();
    await service().runGarbageCollection({ requestedById: 'user-1' });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('starts'), { reason: 'requested by a user' });

    log.info.mockClear();
    await service().runGarbageCollection({ dryRun: true });
    expect(log.info).not.toHaveBeenCalled();
  });
});
