import { describe, expect, it, vi } from 'vitest';
import { DockerRegistryStorageService } from './registry-storage.service.js';

function service(origin: 'user' | 'managed') {
  const getDecryptedConfig = vi.fn(async () => ({
    endpoint: 'https://127.0.0.1',
    region: 'us-east-1',
    defaultBucket: 'registry',
    forcePathStyle: true,
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  }));
  const storage = new DockerRegistryStorageService({
    db: {} as never,
    docker: { inspectManagedRegistry: async () => ({ Config: { Env: [] } }) } as never,
    tokenService: {} as never,
    audit: {} as never,
    objectStorage: () => ({ get: async () => ({ origin }), getDecryptedConfig }) as never,
  });
  return { storage, getDecryptedConfig };
}

describe('the registry storage connection picker (F-6)', () => {
  it('refuses a managed storage connection, which the registry container cannot reach, before using its keys', async () => {
    const { storage, getDecryptedConfig } = service('managed');
    await expect(
      storage.update(
        { backend: 's3', connectionId: '00000000-0000-4000-8000-000000000001' },
        { userId: 'user-1', scopes: ['storage:credentials:use'] }
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'REGISTRY_STORAGE_MANAGED_UNSUPPORTED' });
    expect(getDecryptedConfig).not.toHaveBeenCalled();
  });
});
