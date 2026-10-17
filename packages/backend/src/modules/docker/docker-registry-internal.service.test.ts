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

// rc.3 stand R-F-1: a build claimed just as an automatic collection began failed against the restarting registry
// ("failed to fetch anonymous token ... opfield.invalid") and was never retried.
describe('builds during a registry collection', () => {
  it('waits for builds already using the registry before it restarts it, and no build is claimed meanwhile', async () => {
    const order: string[] = [];
    let busy = 2;
    const state = { status: 'ready', maintenancePhase: 'idle', writable: true } as Record<string, unknown>;
    const run = { id: 'run-1', status: 'running', dryRun: false, progress: {} };
    const store = {
      initialize: vi.fn(),
      getState: vi.fn(async () => ({ ...state })),
      updateState: vi.fn(async (values: object) => Object.assign(state, values)),
      acquireLease: vi.fn(async () => ({})),
      renewLease: vi.fn(async () => {}),
      createRun: vi.fn(async () => run),
      getRun: vi.fn(async () => run),
      updateRun: vi.fn(async (_id: string, values: object) => Object.assign(run, values)),
      listRetentionArtifacts: vi.fn(async () => []),
      markArtifactDeleted: vi.fn(async () => {}),
      hasActiveRegistryUsers: vi.fn(async () => {
        order.push(`busy:${busy}`);
        return busy-- > 0;
      }),
    };
    const registry = new DockerInternalRegistryService({} as never, {} as never, { log: vi.fn(async () => {}) } as never, store as never);
    registry.activeUsersPollMs = 1;
    let claimable: boolean | null = null;
    registry.setExecutor({
      hasRepositories: async () => true,
      storageUsedBytes: async () => 0,
      pauseAdmissions: async () => {
        claimable = await registry.canClaimBuilds();
      },
      drainUploads: async () => {
        order.push('restart');
      },
      deleteManifest: async () => {},
      enterReadOnly: async () => {},
      collectGarbage: async () => {},
      verifyIntegrity: async () => {},
      restoreWrites: async () => {},
    });

    await registry.runGarbageCollection({ reason: 'builds finished' });

    expect(order).toEqual(['busy:2', 'busy:1', 'busy:0', 'restart']);
    expect(claimable).toBe(false);
    await expect(registry.canClaimBuilds()).resolves.toBe(true);
  });
});
