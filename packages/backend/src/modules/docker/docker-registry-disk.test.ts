import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { LEGACY_REGISTRY_NAMESPACE } from '@/lib/legacy-compat.js';
import { parseDfKilobytes } from '@/services/docker.service.js';
import { collectImageReferences } from './docker-image-retention-store.js';
import { DockerInternalRegistryService, registryFilesystemFill } from './docker-registry-internal.service.js';
import { selectOrphanedBuildRepositories } from './docker-registry-maintenance.js';

function registryWith(state: Record<string, unknown>) {
  let current: Record<string, unknown> = {
    status: 'ready',
    writable: true,
    maintenancePhase: 'idle',
    storageUsedBytes: 0,
    storageCapacityBytes: null,
    storageBackend: 'filesystem',
    lastError: null,
    ...state,
  };
  const store = {
    initialize: vi.fn(),
    getState: vi.fn(async () => current),
    updateState: vi.fn(async (values: Record<string, unknown>) => {
      current = { ...current, ...values };
      return current;
    }),
  };
  return new DockerInternalRegistryService({} as never, {} as never, { log: vi.fn() } as never, store as never);
}

describe('registry disk guard', () => {
  it('reads df -kP output', () => {
    const output = [
      'Filesystem     1024-blocks     Used Available Capacity Mounted on',
      'overlay           32000000 28000000   2500000      92% /var/lib/registry',
    ].join('\n');
    expect(parseDfKilobytes(output)).toEqual({
      totalBytes: 32000000 * 1024,
      usedBytes: 28000000 * 1024,
      availableBytes: 2500000 * 1024,
    });
    expect(parseDfKilobytes('df: /var/lib/registry: No such file')).toBeNull();
    expect(registryFilesystemFill({ usedBytes: 9, availableBytes: 1 })).toBe(0.9);
  });

  it('refuses builds and pushes once the disk under the registry is 90% full, whatever share the registry has', async () => {
    const registry = registryWith({});
    const state = await registry.reportHealth({
      healthy: true,
      writable: true,
      // The registry itself is small: the disk is full of other things.
      usedBytes: 1024,
      capacityBytes: 100_000,
      filesystem: { totalBytes: 100_000, usedBytes: 91_000, availableBytes: 9_000 },
    });
    expect(state).toMatchObject({ status: 'degraded', writable: false, storageCapacityBytes: 100_000 });
    expect(state.lastError).toContain('91% full');
    // R-O-4: 91.99 % used reads 92 %, as df shows it, not 91 %.
    const fuller = await registry.reportHealth({
      healthy: true,
      writable: true,
      usedBytes: 1024,
      filesystem: { totalBytes: 73_400_320, usedBytes: 67_528_294, availableBytes: 5_872_026 },
    });
    expect(fuller.lastError).toContain('92% full');
    await expect(registry.assertBuildAdmission()).rejects.toMatchObject({
      statusCode: 503,
      code: 'INTERNAL_REGISTRY_NOT_WRITABLE',
      message: expect.stringContaining('new builds and image pushes stop at 90%'),
    });

    const freed = await registry.reportHealth({
      healthy: true,
      writable: true,
      usedBytes: 1024,
      capacityBytes: 100_000,
      filesystem: { totalBytes: 100_000, usedBytes: 50_000, availableBytes: 50_000 },
    });
    expect(freed).toMatchObject({ status: 'ready', writable: true, lastError: null });
    await expect(registry.assertBuildAdmission()).resolves.toBeUndefined();
  });

  it('never blocks a registry on S3 for the host disk', async () => {
    const registry = registryWith({ storageBackend: 's3' });
    const state = await registry.reportHealth({
      healthy: true,
      writable: true,
      usedBytes: 50_000_000,
      capacityBytes: null,
      filesystem: null,
      storageBackend: 's3',
    });
    expect(state).toMatchObject({ status: 'ready', writable: true });
  });
});

describe('build repositories of removed sources', () => {
  it('selects only build repositories whose source is gone, untracked and unnamed', () => {
    const references = JSON.stringify([
      { config: { image: `127.0.0.1:5443/${LEGACY_REGISTRY_NAMESPACE}/builds/src-named@sha256:abc` } },
    ]);
    expect(
      selectOrphanedBuildRepositories({
        repositories: [
          `${LEGACY_REGISTRY_NAMESPACE}/builds/src-live`,
          `${LEGACY_REGISTRY_NAMESPACE}/builds/src-gone`,
          `${LEGACY_REGISTRY_NAMESPACE}/builds/src-gone/web`,
          `${LEGACY_REGISTRY_NAMESPACE}/builds/src-tracked`,
          `${LEGACY_REGISTRY_NAMESPACE}/builds/src-named`,
          `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1/1/2`,
          `${LEGACY_REGISTRY_NAMESPACE}/promotion/abc/1`,
        ],
        sourceBindingIds: new Set(['src-live']),
        trackedRepositories: new Set([`${LEGACY_REGISTRY_NAMESPACE}/builds/src-tracked`]),
        references,
      })
    ).toEqual([`${LEGACY_REGISTRY_NAMESPACE}/builds/src-gone`, `${LEGACY_REGISTRY_NAMESPACE}/builds/src-gone/web`]);
  });
});

describe('image references in records', () => {
  it('collects every image a record names, at any depth', () => {
    const references = collectImageReferences({
      deployments: [
        { config: { image: 'myorg/api:v2', env: { IMAGE_TAG: 'not-an-image-key' } }, routerImage: 'nginx:alpine' },
      ],
      tasks: [{ tracking: { kind: 'pull', imageRef: 'redis:7' } }],
      policies: [{ spec: { services: { web: { image: 'myorg/web:1' } } }, image: null }],
      revisions: [{ model: { services: { db: { image: 'postgres:16' } } } }],
    });
    expect([...references].sort()).toEqual(['myorg/api:v2', 'myorg/web:1', 'nginx:alpine', 'postgres:16', 'redis:7']);
  });
});
