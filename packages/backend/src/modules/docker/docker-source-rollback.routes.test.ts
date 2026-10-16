import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerSourceService } from './docker-source.service.js';
import { registerDockerSourceRollbackRoute } from './docker-source-rollback.routes.js';

vi.mock('./docker-source-build-state.js', () => ({
  withDockerSourceBuildState: async (source: object) => ({ ...source, state: 'Commit aaaaaaaaaa is deployed.' }),
}));

/** Rolling back deploys a kept build, so it needs the build scope on the container, never only edit. */

const NODE = '11111111-1111-4111-8111-111111111111';
const RESOURCE = 'access-app';
const BUILD = '55555555-5555-4555-8555-555555555555';

function setup(scopes: string[]) {
  const rollback = vi.fn(async () => ({
    source: { id: 'source' },
    build: { id: BUILD, commitSha: 'a'.repeat(40) },
    previousBuild: null,
    note: 'The container runs commit aaaaaaaaaa again.',
  }));
  // The pending-source lookup resolves the container's access identity without a Docker node.
  container.registerInstance(DockerSourceService, {
    rollback,
    getPendingContainer: vi.fn(async () => ({ scopeResourceId: RESOURCE })),
  } as never);
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'operator', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerDockerSourceRollbackRoute(router);
  const request = (body?: unknown) =>
    router.request(`/nodes/${NODE}/containers/app/source/rollback`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
  return { rollback, request };
}

afterEach(() => {
  container.reset();
});

describe('POST …/containers/{containerName}/source/rollback', () => {
  it('refuses a caller with only view and edit on the container before rolling back', async () => {
    const { rollback, request } = setup([
      `docker:containers:view:${NODE}/${RESOURCE}`,
      `docker:containers:edit:${NODE}/${RESOURCE}`,
    ]);
    expect((await request()).status).toBe(403);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not let a build grant on another container roll this one back', async () => {
    const { rollback, request } = setup([`docker:containers:manage:${NODE}/access-other`]);
    expect((await request()).status).toBe(403);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back to the previous kept build without a body and answers with the source state', async () => {
    const { rollback, request } = setup([`docker:containers:manage:${NODE}/${RESOURCE}`]);
    const response = await request();
    expect(response.status).toBe(200);
    expect(rollback).toHaveBeenCalledWith(
      { kind: 'container', nodeId: NODE, containerName: 'app' },
      {},
      expect.objectContaining({ id: 'operator' })
    );
    const body = (await response.json()) as { data: { source: { state: string }; build: { id: string } } };
    expect(body.data.build.id).toBe(BUILD);
    expect(body.data.source.state).toBe('Commit aaaaaaaaaa is deployed.');
  });

  it('passes the named build and refuses a build id that is not a UUID', async () => {
    const { rollback, request } = setup([`docker:containers:manage:${NODE}/${RESOURCE}`]);
    expect((await request({ buildId: BUILD })).status).toBe(200);
    expect(rollback).toHaveBeenCalledWith(expect.anything(), { buildId: BUILD }, expect.anything());
    expect((await request({ buildId: 'previous' })).status).toBe(400);
  });
});
