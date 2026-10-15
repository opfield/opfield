import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { noteNodeLoss } from './docker-node-loss.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const CONTAINER = 'a'.repeat(64);

function chain<T>(result: T) {
  return Object.assign(Promise.resolve(result), { limit: async () => result, returning: async () => result });
}

/**
 * A connected Docker node whose container reads go through the real node registry: each read is a command waiting for
 * the node's answer, so dropping the node's control stream (deregister, as when its TCP connection to Opfield is cut)
 * rejects it with the registry's own "Node disconnected" (stand rc.8, F-4).
 */
async function connectedNode(options: { answering?: boolean } = {}) {
  const db = {
    select: () => ({ from: () => ({ where: () => chain([{ metadata: {}, healthHistory: [] }]) }) }),
    update: () => ({ set: () => ({ where: () => chain([{ metadata: {} }]) }) }),
  };
  const registry = new NodeRegistryService(db as never, { offlineDebounceMs: 5_000 });
  registry.startAcceptingConnections(Date.now() - 60_000);
  const stream = { write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as never;
  await registry.register(NODE, 'docker', 'app-node-2', 'hash', stream);
  const reads = vi.fn(async () => {
    if (!options.answering)
      await registry.sendCommand(NODE, { dockerContainer: { action: 'inspect', containerId: CONTAINER } } as never);
    return { Id: CONTAINER, Name: '/web', Config: { Labels: {} }, scopeResourceId: 'web' };
  });
  const docker = {
    inspectContainer: reads,
    getContainerTransition: () => undefined,
    updateContainer: vi.fn(),
    updateContainerEnv: vi.fn(),
    recreateWithConfig: vi.fn(),
    recordNodeLostTask: vi.fn(async () => 'task-lost'),
  };
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerSnapshotService, {} as never);
  // The env routes look for a Git source container its first build has not created yet: this one exists.
  container.registerInstance(DockerSourceService, { getPendingContainer: vi.fn(async () => null) } as never);
  container.registerInstance(DockerAvailabilityService, {
    resolveRuntimeAccessIdentity: vi.fn(async () => null),
    isContainerManaged: vi.fn(async () => false),
  } as never);
  /** The node's TCP connection to Opfield is cut once a read is waiting for the node. */
  const dropWhenReading = async () => {
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await registry.deregister(NODE, stream);
  };
  return { docker, dropWhenReading };
}

function app() {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    // Scoped to the container, so the scope check reads it from the node.
    const scopes = [
      `docker:containers:view:${NODE}/web`,
      `docker:containers:manage:${NODE}/web`,
      `docker:containers:edit:${NODE}/web`,
      `docker:containers:environment:${NODE}/web`,
    ];
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerContainerRoutes(router);
  return router;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

afterEach(() => container.reset());

describe('a container operation whose node is lost right before or during the request', () => {
  it.each([
    ['update', 'POST', 'update', { tag: '1.29', env: { API_KEY: 'new3' } }, 'update'],
    ['env update', 'PUT', 'env', { env: { API_KEY: 'new3' } }, 'update'],
    ['recreate', 'POST', 'recreate', { env: { API_KEY: 'new3' } }, 'recreate'],
  ])('answers 503 NODE_UNAVAILABLE and records a failed task for the %s', async (operation, method, path, body, type) => {
    const t = await connectedNode();
    const response = app().request(`/nodes/${NODE}/containers/${CONTAINER}/${path}`, json(method, body));
    await t.dropWhenReading();
    const answer = await response;

    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({
      code: 'NODE_UNAVAILABLE',
      message: `The node lost its connection before the ${operation} was sent; the container was not changed. Try again once the node is online.`,
      details: { taskId: 'task-lost' },
    });
    expect(t.docker.recordNodeLostTask).toHaveBeenCalledWith(
      NODE,
      CONTAINER,
      type,
      `The node lost its connection before the ${operation} was sent; the container was not changed`
    );
  });

  it('answers 504 NODE_ANSWER_LOST with the task when the update was sent and its answer lost', async () => {
    const t = await connectedNode({ answering: true });
    t.docker.updateContainer.mockRejectedValue(
      noteNodeLoss(new Error('Node disconnected'), { kind: 'answer-lost', taskId: 'task-sent' })
    );
    const answer = await app().request(
      `/nodes/${NODE}/containers/${CONTAINER}/update`,
      json('POST', { env: { API_KEY: 'new3' } })
    );
    expect(answer.status).toBe(504);
    expect(await answer.json()).toMatchObject({ code: 'NODE_ANSWER_LOST', details: { taskId: 'task-sent' } });
    expect(t.docker.recordNodeLostTask).not.toHaveBeenCalled();
  });

  it('answers a read the node was lost during with 503, not 500', async () => {
    const t = await connectedNode();
    const response = app().request(`/nodes/${NODE}/containers/${CONTAINER}`);
    await t.dropWhenReading();
    const answer = await response;
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(t.docker.recordNodeLostTask).not.toHaveBeenCalled();
  });
});
