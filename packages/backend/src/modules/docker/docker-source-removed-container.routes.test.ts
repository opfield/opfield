import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const removed = vi.hoisted(() => ({
  find: vi.fn(async (_nodeId: string, name: string) =>
    name === 'shop' ? { sourceBindingId: 'source-1', scopeResourceId: 'shop-identity' } : null
  ),
}));

vi.mock('./docker-source-removed-container.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./docker-source-removed-container.js')>()),
  findRemovedContainerSource: removed.find,
}));
vi.mock('./docker-source-build-state.js', () => ({
  getDockerSourceWithBuildState: vi.fn(async (target: unknown) => ({ id: 'source-1', target })),
  withDockerSourceBuildState: vi.fn(async (source: unknown) => source),
  withPendingDockerSourceBuildState: vi.fn(async (pending: unknown) => pending),
}));

const { registerDockerSourceRoutes } = await import('./docker-source.routes.js');

function app(scopes: string[]) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerDockerSourceRoutes(router);
  return router;
}

let sources: {
  getPendingContainer: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  createBuild: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  sources = {
    getPendingContainer: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(true),
    createBuild: vi.fn(),
  };
  container.registerInstance(DockerSourceService, sources as never);
  container.registerInstance(DockerAvailabilityService, {
    resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
  } as never);
  container.registerInstance(DockerManagementService, {
    inspectContainer: vi.fn().mockRejectedValue(new AppError(404, 'CONTAINER_NOT_FOUND', 'Container not found')),
  } as never);
});

afterEach(() => {
  container.reset();
  removed.find.mockClear();
});

describe('the Git source of a container removed outside Opfield', () => {
  it('is read and removed by the container name, which frees the name', async () => {
    const scopes = [`docker:containers:view:${NODE}/shop-identity`, `docker:containers:edit:${NODE}/shop-identity`];

    const read = await app(scopes).request(`/nodes/${NODE}/containers/shop/source`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { id: 'source-1' } });

    const detached = await app(scopes).request(`/nodes/${NODE}/containers/shop/source`, { method: 'DELETE' });
    expect(detached.status).toBe(200);
    expect(await detached.json()).toEqual({ success: true, removed: true, keptImage: null });
    expect(sources.remove).toHaveBeenCalledWith({ kind: 'container', nodeId: NODE, containerName: 'shop' }, 'user-1');
  });

  it('refuses a build with SOURCE_CONTAINER_REMOVED, saying how to free the name', async () => {
    const response = await app([`docker:containers:manage:${NODE}/shop-identity`]).request(
      `/nodes/${NODE}/containers/shop/source/builds`,
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('SOURCE_CONTAINER_REMOVED');
    expect(body.message).toContain('Remove the Git source');
    expect(sources.createBuild).not.toHaveBeenCalled();
  });

  it('keeps the permissions of the removed container', async () => {
    const response = await app([`docker:containers:edit:${NODE}/other-identity`]).request(
      `/nodes/${NODE}/containers/shop/source`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(403);
    expect(sources.remove).not.toHaveBeenCalled();
  });

  it('answers CONTAINER_NOT_FOUND for a missing container without a source', async () => {
    const response = await app([`docker:containers:view:${NODE}`]).request(`/nodes/${NODE}/containers/gone/source`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'CONTAINER_NOT_FOUND' });
  });
});
