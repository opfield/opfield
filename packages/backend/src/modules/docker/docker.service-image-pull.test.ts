import { beforeEach, describe, expect, it, vi } from 'vitest';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { DockerManagementService } from './docker.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const digest = `sha256:${'2d9a'.repeat(16)}`;
const python = { Id: 'sha256:python', RepoTags: ['python:3.12'], RepoDigests: [] };

function createService(before: unknown[], after: unknown[]) {
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]);
  const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })) };
  let pulled = false;
  const dispatch = {
    sendDockerImageCommand: vi.fn(async (_node: string, action: string, options?: { imageRef?: string }) => {
      if (action === 'list') return { success: true, detail: JSON.stringify(pulled ? after : before) };
      pulled = true;
      return { success: true, detail: options?.imageRef ?? '' };
    }),
  };
  const service = new DockerManagementService(
    db as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  return { service, dispatch };
}

/** POST /images/pull-sync: the pull succeeded, so it answers success whenever the pulled image can be told. */
describe('DockerManagementService synchronous pull', () => {
  beforeEach(() => {
    vi.mocked(grantCreatedResourcePermissions).mockClear();
  });

  it('places an image pulled by tag and digest, which Docker lists only as repo@digest', async () => {
    const created = { Id: 'sha256:alpine', RepoTags: [], RepoDigests: [`python@${digest}`] };
    const { service } = createService([python], [python, created]);
    await expect(
      service.pullImageImmediate('node-1', `python:3.13-alpine@${digest}`, undefined, null, 'user-1')
    ).resolves.toBe(`python:3.13-alpine@${digest}`);
    expect(grantCreatedResourcePermissions).toHaveBeenCalledWith('user-1', 'docker:images', 'node-1/sha256:alpine', {
      folderId: null,
      nodeId: 'node-1',
    });
  });

  it('places a Docker Hub image named with docker.io/library/', async () => {
    const created = { Id: 'sha256:alpine', RepoTags: ['python:3.13-alpine'], RepoDigests: [`python@${digest}`] };
    const { service } = createService([python], [python, created]);
    await service.pullImageImmediate('node-1', 'docker.io/library/python:3.13-alpine', undefined, null, 'user-1');
    expect(grantCreatedResourcePermissions).toHaveBeenCalledWith(
      'user-1',
      'docker:images',
      'node-1/sha256:alpine',
      expect.anything()
    );
  });

  it('answers success without placing anything when the pull found an image the node already had', async () => {
    const { service } = createService([python], [python]);
    await expect(
      service.pullImageImmediate('node-1', 'mirror.example/team/tool:1', undefined, null, 'user-1')
    ).resolves.toBe('mirror.example/team/tool:1');
    expect(grantCreatedResourcePermissions).not.toHaveBeenCalled();
  });

  it('still refuses to guess between two new images it cannot tell apart', async () => {
    const first = { Id: 'sha256:first', RepoTags: [], RepoDigests: [] };
    const second = { Id: 'sha256:second', RepoTags: [], RepoDigests: [] };
    const { service } = createService([python], [python, first, second]);
    await expect(
      service.pullImageImmediate('node-1', 'mirror.example/team/tool:1', undefined, null, 'user-1')
    ).rejects.toMatchObject({ code: 'DOCKER_IMAGE_PULL_IDENTITY_UNRESOLVED' });
    expect(grantCreatedResourcePermissions).not.toHaveBeenCalled();
  });
});
