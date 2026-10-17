import { describe, expect, it, vi } from 'vitest';
import { LEGACY_REGISTRY_AUTH_DIR } from '@/lib/legacy-compat.js';
import { DockerService } from './docker.service.js';

describe('managed registry garbage collection', () => {
  it('mounts the same named volumes and bind mounts in the offline collector', async () => {
    const mounts = [
      { Type: 'volume', Source: 'registry-data', Target: '/var/lib/registry' },
      { Type: 'volume', Source: 'registry-auth', Target: LEGACY_REGISTRY_AUTH_DIR, ReadOnly: true },
    ];
    const binds = ['/config/registry.yml:/etc/distribution/config.yml:ro'];
    const docker = new DockerService('/unused.sock', '') as any;
    docker.managedRegistryContainerId = vi.fn().mockResolvedValue('registry');
    docker.request = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/json'))
        return {
          statusCode: 200,
          body: JSON.stringify({ Config: { Image: 'registry:3' }, HostConfig: { Binds: binds, Mounts: mounts } }),
        };
      if (path.includes('/create?')) return { statusCode: 201, body: JSON.stringify({ Id: 'collector' }) };
      if (path.includes('/wait?')) return { statusCode: 200, body: JSON.stringify({ StatusCode: 0 }) };
      return { statusCode: 204, body: '' };
    });
    await docker.runManagedRegistryGarbageCollection(false);
    expect(docker.request).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/containers/create?'),
      expect.objectContaining({
        HostConfig: { Binds: binds, Mounts: mounts, NetworkMode: 'none' },
      })
    );
    expect(docker.request).toHaveBeenCalledWith('POST', expect.stringContaining('/containers/registry/start'));
  });
});
