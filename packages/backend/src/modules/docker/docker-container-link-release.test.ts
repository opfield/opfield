import { describe, expect, it, vi } from 'vitest';
import {
  createContainer,
  type DockerContainerMutationContext,
  removeContainer,
} from './docker-container-mutation-operations.js';

/** A database that finds an unlocked Docker node and nothing else. */
function database() {
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => [{ id: 'node-1', type: 'docker', serviceCreationLocked: false }],
  };
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  };
}

function context(dispatch: ReturnType<typeof vi.fn>) {
  const releaseContainerLinks = vi.fn().mockResolvedValue(undefined);
  const deleteSecrets = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    db: database(),
    auditService: { log: vi.fn().mockResolvedValue(undefined) },
    nodeDispatch: { sendDockerContainerCommand: dispatch },
    // A Git source's first activation reads the env and secrets saved for its reserved name: none here.
    secretService: { deleteImported: deleteSecrets, getDecryptedMap: vi.fn().mockResolvedValue({}) },
    releaseContainerLinks,
    validateDockerNode: vi.fn().mockResolvedValue({}),
    assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
    assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
    assertNameAvailable: vi.fn().mockResolvedValue(undefined),
    resolveContainerName: vi.fn().mockResolvedValue('api'),
    inspectContainer: vi.fn().mockResolvedValue({ State: { Status: 'exited' } }),
    requireNoTransition: vi.fn(),
    waitWhileTransition: vi.fn().mockResolvedValue(undefined),
    lifecycleWatchTimeoutMs: vi.fn().mockReturnValue(60000),
    setTransition: vi.fn(),
    clearTransition: vi.fn(),
    translateNameConflict: vi.fn((error: unknown) => {
      throw error;
    }),
    parseResult: vi.fn((result: { success: boolean; error?: string }) => {
      if (!result.success) throw new Error(result.error);
      return {};
    }),
    emitContainer: vi.fn(),
  } as unknown as DockerContainerMutationContext;
  return { ctx, releaseContainerLinks, deleteSecrets };
}

describe('managed links of a container name', () => {
  it('are released when Opfield removes the container, after its own secrets', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const { ctx, releaseContainerLinks, deleteSecrets } = context(dispatch);

    await removeContainer(ctx, 'node-1', 'container-1', false, 'user-1');

    expect(releaseContainerLinks).toHaveBeenCalledWith('node-1', 'api', 'user-1');
    expect(releaseContainerLinks.mock.invocationCallOrder[0]).toBeGreaterThan(
      deleteSecrets.mock.invocationCallOrder[0]!
    );
    expect(ctx.emitContainer).toHaveBeenCalledWith('node-1', 'api', 'container-1', 'removed', {});
  });

  it('do not fail a removal that already happened', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const { ctx, releaseContainerLinks } = context(dispatch);
    releaseContainerLinks.mockRejectedValue(new Error('database unavailable'));

    await expect(removeContainer(ctx, 'node-1', 'container-1', false, 'user-1')).resolves.toEqual({
      taskId: undefined,
      containerId: 'container-1',
      name: 'api',
    });
    expect(ctx.emitContainer).toHaveBeenCalled();
  });

  it('left for a free name are released before a new container takes it', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: false, error: 'create refused' });
    const { ctx, releaseContainerLinks } = context(dispatch);

    await expect(createContainer(ctx, 'node-1', { name: 'api', image: 'app:1' }, 'user-1')).rejects.toThrow(
      'create refused'
    );

    expect(releaseContainerLinks).toHaveBeenCalledWith('node-1', 'api', 'user-1');
    expect(releaseContainerLinks.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]!);
  });

  it("saved for a Git source's reserved name stay for its first activation", async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: false, error: 'create refused' });
    const { ctx, releaseContainerLinks } = context(dispatch);

    await expect(
      createContainer(ctx, 'node-1', { name: 'api', image: 'app:1' }, 'user-1', [], { sourceBindingId: 'source-1' })
    ).rejects.toThrow('create refused');

    expect(releaseContainerLinks).not.toHaveBeenCalled();
  });
});
