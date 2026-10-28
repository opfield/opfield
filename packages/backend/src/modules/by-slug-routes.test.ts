import 'reflect-metadata';
// The schema barrel first: loading the route modules alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { dockerRoutes } from '@/modules/docker/docker.routes.js';
import { nodesRoutes } from '@/modules/nodes/nodes.routes.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { proxyRoutes } from '@/modules/proxy/proxy.routes.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';

const state = vi.hoisted(() => ({ scopes: [] as string[] }));

// Authentication is not what is tested: the request is made by a caller who holds exactly these scopes.
vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: state.scopes });
    c.set('effectiveScopes', state.scopes);
    await next();
  },
}));

vi.mock('@/modules/docker/docker-route-resolvers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/docker/docker-route-resolvers.js')>()),
  resolveDockerNodeBySlug: async (_db: unknown, slug: string) => {
    if (slug !== 'known') throw new AppError(404, 'NOT_FOUND', 'Docker node not found');
    return { id: '11111111-1111-4111-8111-111111111111', slug, type: 'docker' };
  },
}));

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

for (const routes of [nodesRoutes, proxyRoutes, dockerRoutes]) routes.onError(errorHandler);

afterEach(() => container.reset());

describe('REST by-slug routes answer a resource the caller may not see like a missing slug', () => {
  it('nodes', async () => {
    container.registerInstance(NodesService, {
      getBySlug: async (slug: string) => {
        if (slug !== 'known') throw new AppError(404, 'NOT_FOUND', 'Node not found');
        return { id: HOST, slug };
      },
    } as never);
    state.scopes = [`nodes:details:${OTHER}`];
    const forbidden = await nodesRoutes.request('/by-slug/known');
    const absent = await nodesRoutes.request('/by-slug/unknown');
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual(await absent.json());
    state.scopes = [`nodes:details:${HOST}`];
    expect((await nodesRoutes.request('/by-slug/known')).status).toBe(200);
  });

  it('routes', async () => {
    container.registerInstance(ProxyService, {
      getProxyHostBySlug: async (slug: string) => {
        if (slug !== 'known') throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
        return { id: HOST, slug };
      },
      withAppField: async (rows: unknown[]) => rows,
    } as never);
    state.scopes = [`proxy:view:${OTHER}`];
    const forbidden = await proxyRoutes.request('/by-slug/known');
    const absent = await proxyRoutes.request('/by-slug/unknown');
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual(await absent.json());
  });

  it('Docker nodes', async () => {
    container.registerInstance(TOKENS.DrizzleClient, {} as never);
    state.scopes = [`docker:containers:view:${OTHER}`];
    const forbidden = await dockerRoutes.request('/nodes/by-slug/known');
    expect(forbidden.status).toBe(404);
    const absent = await dockerRoutes.request('/nodes/by-slug/unknown');
    expect(await forbidden.json()).toEqual(await absent.json());
    state.scopes = [`docker:containers:view:${HOST}`];
    expect((await dockerRoutes.request('/nodes/by-slug/known')).status).toBe(200);
  });
});
