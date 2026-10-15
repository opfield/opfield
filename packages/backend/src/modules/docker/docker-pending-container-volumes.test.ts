import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { DockerManagementService } from './docker.service.js';
import { updatePendingContainerVolumes } from './docker-pending-container-volumes.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const actor = { id: 'user-1', scopes: ['docker:volumes:view'] };
const volumes = [{ name: 'rin-data', containerPath: '/data', readOnly: false }];

/** A Git source container "shop" its first build has not created yet; `saved` rows the creation settings update. */
function pendingShop(options: { pending?: boolean; saved?: number } = {}) {
  container.registerInstance(DockerSourceService, {
    getPendingContainer: vi.fn(async () =>
      options.pending === false
        ? null
        : { containerName: 'shop', scopeResourceId: 'reserved-shop', sourceBindingId: 'binding-1' }
    ),
  } as never);
  const docker = {
    assertBuildRolloutAllowed: vi.fn().mockResolvedValue(undefined),
    assertCreationMounts: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(DockerManagementService, docker as never);
  const set = vi.fn();
  const db = {
    update: vi.fn(() => ({
      set: (values: unknown) => {
        set(values);
        return {
          where: () => ({
            returning: async () => Array.from({ length: options.saved ?? 1 }, () => ({ id: 'binding-1' })),
          }),
        };
      },
    })),
  };
  container.registerInstance(TOKENS.DrizzleClient, db as never);
  const audit = { log: vi.fn() };
  container.registerInstance(AuditService, audit as never);
  return { docker, db, set, audit };
}

beforeEach(() => container.reset());
afterEach(() => container.reset());

describe('volumes of a Git source container before its first build created it', () => {
  it('checks them as the first build creates the container and saves the whole list', async () => {
    const { docker, set, audit } = pendingShop();

    const result = await updatePendingContainerVolumes(NODE, 'shop', { volumes }, actor);

    expect(result).toEqual({ pendingSourceBuild: true, name: 'shop', volumes });
    expect(docker.assertBuildRolloutAllowed).toHaveBeenCalledWith({
      kind: 'container',
      nodeId: NODE,
      containerName: 'shop',
    });
    expect(docker.assertCreationMounts).toHaveBeenCalledWith(NODE, { volumes }, actor.scopes);
    expect(set).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'docker.container.mounts.update' }));
  });

  it('clears them without a volume check', async () => {
    const { docker, set } = pendingShop();

    await updatePendingContainerVolumes(NODE, 'shop', { volumes: [] }, actor);

    expect(docker.assertCreationMounts).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('refuses a container that exists, and one the first build created meanwhile', async () => {
    pendingShop({ pending: false });
    await expect(updatePendingContainerVolumes(NODE, 'shop', { volumes }, actor)).rejects.toMatchObject({
      code: 'SOURCE_CONTAINER_BUILT',
    });

    container.reset();
    pendingShop({ saved: 0 });
    await expect(updatePendingContainerVolumes(NODE, 'shop', { volumes }, actor)).rejects.toMatchObject({
      code: 'SOURCE_CONTAINER_BUILT',
    });
  });
});
