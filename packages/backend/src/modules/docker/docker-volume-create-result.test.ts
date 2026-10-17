import { describe, expect, it, vi } from 'vitest';
import { createVolume } from './docker-volume-network-operations.js';

// rc.3 GO-8: manage_docker_volume create answered null although the volume was created.
describe('creating a Docker volume', () => {
  it('answers with the volume it created, though the daemon answers without a body', async () => {
    const context = {
      parseResult: (result: { detail?: string }) => (result.detail ? JSON.parse(result.detail) : null),
      nodeDispatch: {
        sendDockerVolumeCommand: vi.fn(async (_nodeId: string, action: string) =>
          action === 'list' ? { success: true, detail: '[]' } : { success: true, detail: '' }
        ),
      },
      db: { insert: () => ({ values: async () => undefined }) },
      auditService: { log: vi.fn(async () => true) },
      eventBus: { publish: vi.fn() },
    };
    await expect(createVolume(context as never, 'node-1', { name: 'rc3g-vol' }, 'user-1')).resolves.toEqual({
      name: 'rc3g-vol',
      nodeId: 'node-1',
      storageKind: 'regular',
      capacityBytes: null,
      managed: true,
    });
  });
});
