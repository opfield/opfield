import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import { registerWebhookConfigRoutes } from './docker-webhook.routes.js';
import { DockerWebhookService } from './docker-webhook.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const guardSeen: string[] = [];

// The scope guard resolves the container through Docker; here it only records the name it was asked about.
vi.mock('./docker-access.middleware.js', () => ({
  requireDockerContainerScope: (_scope: string, param: string) => async (c: any, next: () => Promise<void>) => {
    guardSeen.push(c.req.param(param));
    await next();
  },
}));

function app() {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes: [] } as never);
    await next();
  });
  registerWebhookConfigRoutes(router);
  return router;
}

afterEach(() => {
  container.reset();
  guardSeen.length = 0;
});

describe('container webhook config routes', () => {
  it('hands the service the same container name the scope guard checked (decoded once)', async () => {
    const getByContainer = vi.fn().mockResolvedValue(null);
    const getForContainer = vi.fn().mockResolvedValue(null);
    container.registerInstance(DockerWebhookService, { getByContainer } as never);
    container.registerInstance(DockerImageCleanupService, { getForContainer } as never);

    // %2561 is "%61" after one decode and "a" after two: the guard and the action must see the same string.
    await app().request(`/nodes/${NODE}/containers/web%2561/webhook`);
    await app().request(`/nodes/${NODE}/containers/web%2561/image-cleanup`);

    expect(guardSeen).toEqual(['web%61', 'web%61']);
    expect(getByContainer).toHaveBeenCalledExactlyOnceWith(NODE, 'web%61');
    expect(getForContainer).toHaveBeenCalledExactlyOnceWith(NODE, 'web%61');
  });
});
