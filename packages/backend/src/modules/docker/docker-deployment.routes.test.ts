import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { registerDockerDeploymentRoutes } from './docker-deployment.routes.js';
import { DockerDeploymentService } from './docker-deployment.service.js';
import { DockerWebhookService } from './docker-webhook.service.js';
import { hashWebhookToken } from './docker-webhook-token.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const SAVED = { image: 'registry.example.com/app:1.0', command: undefined, env: { MODE: 'prod' } };

function app(scopes: string[], impersonating = false) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    if (impersonating) c.set('impersonation', { actorUserId: 'admin-1' } as never);
    await next();
  });
  registerDockerDeploymentRoutes(router);
  return router;
}

function registerService() {
  const deployment = { id: DEPLOYMENT, desiredConfig: SAVED, webhook: { token: 'webhook-token' } };
  const service = {
    get: vi.fn().mockResolvedValue(deployment),
    deploy: vi.fn().mockResolvedValue(deployment),
    update: vi.fn().mockResolvedValue(deployment),
    getWebhook: vi.fn().mockResolvedValue({ id: 'webhook-1', token: 'webhook-token' }),
    regenerateWebhook: vi.fn().mockResolvedValue({ id: 'webhook-1', token: 'new-token' }),
  };
  container.registerInstance(DockerDeploymentService, service as never);
  container.registerInstance(TOKENS.DrizzleClient, {} as never);
  return service;
}

const send = (router: OpenAPIHono<AppEnv>, method: string, path: string, body?: unknown) =>
  router.request(`/nodes/${NODE}/deployments/${DEPLOYMENT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => container.reset());

describe('deployment changes that expose env and secrets', () => {
  it('lets an operator with manage roll out the saved configuration, but not another image or env', async () => {
    const service = registerService();
    const router = app([`docker:containers:manage:${NODE}/${DEPLOYMENT}`]);

    expect((await send(router, 'POST', '/deploy', {})).status).toBe(200);
    expect((await send(router, 'POST', '/deploy', { image: 'attacker/app:latest' })).status).toBe(403);
    expect((await send(router, 'POST', '/deploy', { tag: 'other' })).status).toBe(403);
    expect((await send(router, 'POST', '/deploy', { env: { MODE: 'debug' } })).status).toBe(403);
    expect(service.deploy).toHaveBeenCalledOnce();
  });

  it('lets an editor save unchanged execution fields, but not change the image or command', async () => {
    const service = registerService();
    const router = app([`docker:containers:edit:${NODE}/${DEPLOYMENT}`]);

    const unchanged = { desiredConfig: { image: SAVED.image, command: [], user: '', labels: { team: 'a' } } };
    expect((await send(router, 'PUT', '', unchanged)).status).toBe(200);
    expect((await send(router, 'PUT', '', { desiredConfig: { image: 'attacker/app:latest' } })).status).toBe(403);
    expect((await send(router, 'PUT', '', { desiredConfig: { command: ['sh', '-c', 'env'] } })).status).toBe(403);
    expect(service.update).toHaveBeenCalledOnce();
  });

  it('accepts an image change with environment and secrets on the deployment, without docker:images:pull', async () => {
    const service = registerService();
    const router = app([
      `docker:containers:manage:${NODE}/${DEPLOYMENT}`,
      `docker:containers:edit:${NODE}/${DEPLOYMENT}`,
      `docker:containers:environment:${NODE}/${DEPLOYMENT}`,
      `docker:containers:secrets:${NODE}/${DEPLOYMENT}`,
    ]);

    expect((await send(router, 'POST', '/deploy', { image: 'registry.example.com/app:2.0' })).status).toBe(200);
    expect(service.deploy).toHaveBeenCalledOnce();
  });
});

describe('deployment webhook token under impersonation', () => {
  it('hides the token and refuses to mint a new one', async () => {
    const service = registerService();
    const router = app([`docker:containers:webhooks:${NODE}/${DEPLOYMENT}`], true);

    const get = await send(router, 'GET', '/webhook');
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ data: { id: 'webhook-1', token: null } });
    expect((await send(router, 'POST', '/webhook/regenerate')).status).toBe(403);
    expect(service.regenerateWebhook).not.toHaveBeenCalled();
  });
});

describe('deployment webhook token storage', () => {
  it('shows the token only in the response that issued it, and keeps only its hash', async () => {
    const service = registerService();
    service.getWebhook.mockResolvedValue({ id: 'webhook-1', token: null, tokenHash: hashWebhookToken('old-token') });
    const patches: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          patches.push(patch);
          return { where: async () => undefined };
        },
      }),
    };
    container.registerInstance(
      DockerWebhookService,
      new (DockerWebhookService as unknown as new (...args: unknown[]) => DockerWebhookService)(
        db,
        ...Array(6).fill({})
      )
    );
    const router = app([`docker:containers:webhooks:${NODE}/${DEPLOYMENT}`]);

    const read = (await (await send(router, 'GET', '/webhook')).json()) as { data: unknown };
    expect(read.data).toEqual({ id: 'webhook-1', token: null });

    const rotated = (await (await send(router, 'POST', '/webhook/regenerate')).json()) as { data: unknown };
    expect(rotated.data).toEqual({ id: 'webhook-1', token: 'new-token' });
    expect(patches).toEqual([{ tokenHash: hashWebhookToken('new-token'), token: null }]);
  });
});
