import { describe, expect, it, vi } from 'vitest';
import { DockerImageCleanupService, REPLACED_IMAGE_GRACE_MS } from './docker-image-cleanup.service.js';

function emptyStore() {
  return {
    context: async () => ({
      settings: [],
      protectedKeys: new Set<string>(),
      sourceBindings: new Map(),
      availabilityOwners: new Map(),
    }),
    unusedSince: async () => ({}),
    saveUnusedSince: async () => {},
  };
}

describe('DockerImageCleanupService', () => {
  it.each([
    'container',
    'deployment',
  ] as const)('enables cleanup by default for %s without overwriting explicit opt-out', async (type) => {
    const limit = vi.fn().mockResolvedValue([]);
    const returning = vi.fn().mockResolvedValue([{ enabled: true }]);
    const values = vi.fn().mockReturnValue({ returning });
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      insert: () => ({ values }),
    };
    const service = new DockerImageCleanupService(db as never, {} as never);
    const get = () =>
      type === 'container' ? service.getForContainer('n1', 'app') : service.getForDeployment('n1', 'd1');
    const upsert = (input: { enabled?: boolean }) =>
      type === 'container'
        ? service.upsertForContainer('n1', 'app', input)
        : service.upsertForDeployment('n1', 'd1', input);
    expect(await get()).toMatchObject({ enabled: true, retentionCount: 2 });
    await upsert({});
    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    await upsert({ enabled: false });
    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    limit.mockResolvedValue([{ id: 'saved', enabled: false, retentionCount: 3 }]);
    expect(await get()).toMatchObject({ enabled: false, retentionCount: 3 });
  });
  it.each([
    'container',
    'deployment',
  ] as const)('uses the enabled default to clean %s images while retaining in-use images', async (type) => {
    vi.useFakeTimers();
    try {
      const docker = {
        listAllImages: vi.fn().mockResolvedValue([
          {
            Id: 'sha-new',
            RepoTags: ['registry.example.com/team/app:new'],
            Created: 300,
          },
          {
            Id: 'sha-previous',
            RepoTags: ['registry.example.com/team/app:previous'],
            Created: 200,
          },
          {
            Id: 'sha-old',
            RepoTags: ['registry.example.com/team/app:old'],
            Created: 100,
          },
          { Id: 'sha-in-use', RepoTags: ['registry.example.com/team/app:old-running'], Created: 50 },
        ]),
        listAllContainers: vi.fn().mockResolvedValue([{ ImageID: 'sha-new' }, { ImageID: 'sha-in-use' }]),
        removeUnusedImage: vi.fn().mockResolvedValue(undefined),
      };
      const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) };
      let tracking = {};
      const store = {
        ...emptyStore(),
        unusedSince: async () => tracking,
        saveUnusedSince: async (_nodeId: string, state: object) => {
          tracking = state;
        },
      };
      const service = new DockerImageCleanupService(db as never, docker as never, store as never);
      const cleanup =
        type === 'container'
          ? service.scheduleCleanupForContainer('node-1', 'app', 'registry.example.com/team/app:new')
          : service.scheduleCleanupForDeployment('node-1', 'd1', 'registry.example.com/team/app:new');
      await vi.advanceTimersByTimeAsync(5000);
      await cleanup;
      // An older image goes once the grace passed (a rollout that pulled it again would be using it by then).
      expect(docker.removeUnusedImage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(REPLACED_IMAGE_GRACE_MS + 2000);

      expect(docker.removeUnusedImage).toHaveBeenCalledWith('node-1', 'sha-old', null);
      expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha-previous', null);
      expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha-new', null);
      expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha-in-use', null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a removed container's setting and moves it with a rename", async () => {
    const where = vi.fn();
    const set = vi.fn(() => ({ where }));
    const db = { delete: vi.fn(() => ({ where })), update: vi.fn(() => ({ set })) };
    const service = new DockerImageCleanupService(db as never, {} as never, emptyStore() as never);

    await service.forgetContainer('n1', 'app');
    expect(db.delete).toHaveBeenCalledTimes(1);
    await service.renameContainer('n1', 'app', 'web');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ containerName: 'web' }));
  });

  it('cleans a node shortly after a change there, at most once per interval', async () => {
    vi.useFakeTimers();
    try {
      const docker = {
        listAllImages: vi.fn().mockResolvedValue([]),
        listAllContainers: vi.fn().mockResolvedValue([]),
        removeUnusedImage: vi.fn(),
      };
      const handlers = new Map<string, (payload: unknown) => void>();
      const bus = {
        subscribe: (channel: string, handler: (payload: unknown) => void) => {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
        publish: vi.fn(),
      };
      const service = new DockerImageCleanupService({} as never, docker as never, emptyStore() as never);
      service.setEventBus(bus as never);

      handlers.get('docker.compose.changed')!({ nodeId: 'node-1', action: 'applied' });
      handlers.get('docker.container.changed')!({ nodeId: 'node-1', action: 'removed' });
      handlers.get('docker.container.changed')!({ nodeId: 'node-2', action: 'started' });
      await vi.advanceTimersByTimeAsync(6000);
      expect(docker.listAllImages).toHaveBeenCalledTimes(1);
      expect(docker.listAllImages).toHaveBeenCalledWith('node-1');

      handlers.get('docker.migration.changed')!({ sourceNodeId: 'node-1', targetNodeId: 'node-2' });
      await vi.advanceTimersByTimeAsync(6000);
      // node-2 at once; node-1 only once the interval since its last cleanup passed.
      expect(docker.listAllImages).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(docker.listAllImages).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
