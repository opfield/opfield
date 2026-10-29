import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockerService } from '@/services/docker.service.js';
import { createDockerRegistryMaintenanceExecutor, type RegistryDefinition } from './docker-registry-maintenance.js';
import type { DockerRegistryTokenService } from './docker-registry-token.service.js';

function drainWith(registryDefinition: RegistryDefinition) {
  const docker = { restartManagedRegistry: vi.fn().mockResolvedValue(undefined) };
  const executor = createDockerRegistryMaintenanceExecutor(
    docker as unknown as DockerService,
    {} as DockerRegistryTokenService,
    {
      registryUrl: 'http://registry.test:5000',
      // The drain ends a little later than an immediate check, as the grace does in production.
      wait: () => new Promise((resolve) => setTimeout(resolve, 20)),
      registryDefinition,
    }
  );
  return { docker, drain: () => executor.drainUploads() };
}

describe('registry maintenance drain and the registry definition', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('recreates a registry that runs an older definition instead of restarting it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const recreate = vi.fn().mockResolvedValue(undefined);
    const { docker, drain } = drainWith({ pendingRecreate: async () => recreate });
    await drain();
    expect(recreate).toHaveBeenCalledOnce();
    expect(docker.restartManagedRegistry).not.toHaveBeenCalled();
  });

  it('restarts the registry as before when the recreate is refused, the check fails, or it outlasts the drain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const refused = drainWith({ pendingRecreate: async () => () => Promise.reject(new Error('an update started')) });
    await refused.drain();
    expect(refused.docker.restartManagedRegistry).toHaveBeenCalledOnce();

    const failed = drainWith({ pendingRecreate: () => Promise.reject(new Error('compose failed')) });
    await failed.drain();
    expect(failed.docker.restartManagedRegistry).toHaveBeenCalledOnce();

    const recreate = vi.fn();
    const slow = drainWith({
      pendingRecreate: () => new Promise((resolve) => setTimeout(() => resolve(recreate), 1_000)),
    });
    await slow.drain();
    expect(slow.docker.restartManagedRegistry).toHaveBeenCalledOnce();
    expect(recreate).not.toHaveBeenCalled();
  });
});
