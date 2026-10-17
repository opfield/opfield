import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { User } from '@/types.js';

const mocks = vi.hoisted(() => ({
  findRemoved: vi.fn(),
  readGitSource: vi.fn(),
}));

vi.mock('@/modules/docker/docker-source-removed-container.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/docker/docker-source-removed-container.js')>()),
  findRemovedContainerSource: mocks.findRemoved,
}));
vi.mock('@/modules/docker/docker-source-build-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/docker/docker-source-build-state.js')>()),
  getDockerSourceWithBuildState: vi.fn(async (target: unknown) => ({ id: 'source-1', target })),
  readContainerGitSource: mocks.readGitSource,
}));

const { executeDockerTool } = await import('./ai.docker-tools.js');

const NODE = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const CONNECTOR = '66666666-6666-4666-8666-666666666666';
const REPOSITORY = '77777777-7777-4777-8777-777777777777';

function userWith(scopes: string[]): User {
  return { id: 'user-1', isBlocked: false, scopes } as User;
}

function toolContext(docker: Record<string, unknown>) {
  return { dockerService: docker, ensureToolScope: vi.fn(), ensureToolScopeForResource: vi.fn() } as never;
}

afterEach(() => {
  container.reset();
  vi.clearAllMocks();
});

describe('manage_docker_source on a container removed outside Opfield', () => {
  const missing = { inspectContainer: vi.fn().mockRejectedValue(new AppError(404, 'CONTAINER_NOT_FOUND', 'gone')) };
  const scopes = [`docker:containers:view:${NODE}/shop-identity`, `docker:containers:edit:${NODE}/shop-identity`];

  function sources() {
    const service = { getPendingContainer: vi.fn().mockResolvedValue(null), remove: vi.fn().mockResolvedValue(true) };
    container.registerInstance(DockerSourceService, service as never);
    mocks.findRemoved.mockResolvedValue({ sourceBindingId: 'source-1', scopeResourceId: 'shop-identity' });
    return service;
  }

  it('reads and removes the source by the container name, freeing the name', async () => {
    const service = sources();
    const run = (operation: string) =>
      executeDockerTool(toolContext(missing), userWith(scopes), 'manage_docker_source', {
        operation,
        nodeId: NODE,
        containerName: 'shop',
      });

    await expect(run('get')).resolves.toMatchObject({ id: 'source-1' });
    await expect(run('remove')).resolves.toEqual({ success: true, removed: true, keptImage: null });
    expect(service.remove).toHaveBeenCalledWith({ kind: 'container', nodeId: NODE, containerName: 'shop' }, 'user-1');
  });

  it('refuses a build with SOURCE_CONTAINER_REMOVED', async () => {
    sources();
    await expect(
      executeDockerTool(
        toolContext(missing),
        userWith([`docker:containers:manage:${NODE}/shop-identity`]),
        'manage_docker_source',
        {
          operation: 'build',
          nodeId: NODE,
          containerName: 'shop',
        }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'SOURCE_CONTAINER_REMOVED' });
  });
});

describe('manage_docker_compose operation_start', () => {
  it('starts without an idempotencyKey and keeps a given one', async () => {
    const startOperation = vi.fn().mockResolvedValue({ id: 'operation-1' });
    container.registerInstance(DockerComposeService, { startOperation } as never);
    container.registerInstance(LicensePolicyService, {
      requireFeatureForExistingRuntime: vi.fn().mockResolvedValue(undefined),
    } as never);
    const start = (extra: Record<string, unknown>) =>
      executeDockerTool(toolContext({}), userWith([]), 'manage_docker_compose', {
        operation: 'operation_start',
        nodeId: NODE,
        projectId: PROJECT,
        action: 'start',
        ...extra,
      });

    await start({});
    await start({ idempotencyKey: 'retry-key-1' });

    expect(startOperation.mock.calls[0][3].idempotencyKey).toMatch(/^mcp-[0-9a-f-]{36}$/);
    expect(startOperation.mock.calls[1][3].idempotencyKey).toBe('retry-key-1');
  });
});

describe('manage_docker_source upsert with the repository owner/name', () => {
  it('resolves it to the connector project id, or names the repositories operation', async () => {
    const upsert = vi.fn(async (input: Record<string, unknown>) => ({ id: 'source-1', ...input }));
    container.registerInstance(DockerSourceService, {
      getPendingContainer: vi.fn().mockResolvedValue({ containerName: 'shop', scopeResourceId: 'shop-identity' }),
      get: vi.fn().mockResolvedValue(null),
      upsert,
    } as never);
    container.registerInstance(IntegrationsService, {
      findDockerBuildSourceRepositories: vi.fn(async (_user: unknown, _connector: string, search: string) => ({
        repositories:
          search === 'acme/shop'
            ? [
                { projectId: REPOSITORY, fullPath: 'acme/shop' },
                { projectId: 'other', fullPath: 'acme/shop-admin' },
              ]
            : [],
      })),
    } as never);
    const run = (projectId: string) =>
      executeDockerTool(
        toolContext({ inspectContainer: vi.fn().mockResolvedValue(null) }),
        userWith([`docker:containers:edit:${NODE}/shop-identity`]),
        'manage_docker_source',
        { operation: 'upsert', nodeId: NODE, containerName: 'shop', connectorId: CONNECTOR, projectId, branch: 'main' }
      );

    await run('https://github.com/Acme/shop.git').catch(() => undefined);
    expect(upsert.mock.calls[0][0]).toMatchObject({ projectId: REPOSITORY });

    await expect(run('acme/nope')).rejects.toMatchObject({
      code: 'SOURCE_REPOSITORY_NOT_FOUND',
      message: expect.stringContaining('manage_docker_source repositories'),
    });
  });
});

describe('get_docker_container', () => {
  it('names the Git source bound to the container', async () => {
    const gitSource = { id: 'source-1', repositoryFullPath: 'acme/shop', branch: 'main' };
    mocks.readGitSource.mockResolvedValue(gitSource);
    const docker = {
      inspectContainer: vi
        .fn()
        .mockResolvedValue({ Id: 'c1', Name: '/shop', scopeResourceId: 'shop-identity', Config: {} }),
    };

    const result = await executeDockerTool(
      toolContext(docker),
      userWith([`docker:containers:view:${NODE}/shop-identity`]),
      'get_docker_container',
      { nodeId: NODE, containerId: 'shop' }
    );

    expect(result).toMatchObject({ Id: 'c1', gitSource });
    expect(mocks.readGitSource).toHaveBeenCalledWith(NODE, 'shop');
  });
});
