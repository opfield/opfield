import { describe, expect, it } from 'vitest';
import { DockerMigrationGuard } from './docker-migration-guard.js';

function guardWith(rows: Array<Record<string, unknown>>) {
  const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
  return new DockerMigrationGuard(db as never);
}

const migration = {
  id: 'm-1',
  resourceType: 'container',
  resourceName: 'web',
  deploymentId: null,
  plan: null,
  sourceNodeId: 'node-a',
  targetNodeId: 'node-b',
  keepSource: true,
};

describe('docker migration guard', () => {
  it('locks the resource of a migration that still runs', async () => {
    const guard = guardWith([{ ...migration, status: 'running' }]);
    await expect(guard.assertContainerAllowed('node-a', 'web')).rejects.toMatchObject({
      code: 'DOCKER_RESOURCE_MIGRATING',
    });
    await expect(guard.assertContainerNameAvailable('node-a', 'web')).rejects.toMatchObject({
      code: 'DOCKER_RESOURCE_MIGRATING',
    });
  });

  it('frees the copy a completed migration kept on the source node', async () => {
    const guard = guardWith([{ ...migration, status: 'completed' }]);
    await expect(guard.assertContainerAllowed('node-a', 'web')).resolves.toBeUndefined();
    await expect(guard.assertContainerNameAvailable('node-a', 'web')).resolves.toBeUndefined();
  });
});
