import { describe, expect, it, vi } from 'vitest';
import { DockerImageCleanupService } from './docker-image-cleanup.service.js';

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
      const service = new DockerImageCleanupService(db as never, docker as never);
      const cleanup =
        type === 'container'
          ? service.scheduleCleanupForContainer('node-1', 'app', 'registry.example.com/team/app:new')
          : service.scheduleCleanupForDeployment('node-1', 'd1', 'registry.example.com/team/app:new');
      await vi.advanceTimersByTimeAsync(5000);
      await cleanup;

      expect(docker.removeUnusedImage).toHaveBeenCalledWith('node-1', 'sha-old', null);
      expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha-previous', null);
      expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha-new', null);
      expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha-in-use', null);
    } finally {
      vi.useRealTimers();
    }
  });
});
