import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { RegistryRepositoryWorkloadService } from '@/modules/tokens/token-registry-workloads.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv } from '@/types.js';
import { __testOnly, dockerRegistryAuthRoutes } from './docker-registry-auth.routes.js';
import { DockerInternalRegistryService } from './docker-registry-internal.service.js';

const ORIGINAL_DEPLOYMENT_MODE = process.env.OPFIELD_DEPLOYMENT_MODE;
// The workloads using each repository: `tenant/app` is the image of container c1 on node-1.
const workloads = vi.fn(async (repository: string) =>
  repository === 'tenant/app' ? [{ kind: 'containers' as const, nodeId: 'node-1', resourceId: 'c1' }] : []
);

beforeEach(() => {
  workloads.mockClear();
  container.registerInstance(RegistryRepositoryWorkloadService, { workloads } as never);
});

afterEach(() => {
  container.reset();
  if (ORIGINAL_DEPLOYMENT_MODE === undefined) delete process.env.OPFIELD_DEPLOYMENT_MODE;
  else process.env.OPFIELD_DEPLOYMENT_MODE = ORIGINAL_DEPLOYMENT_MODE;
});

describe('docker registry external token request parsing', () => {
  it('disables external registry token issuance before service work in demo mode', async () => {
    process.env.OPFIELD_DEPLOYMENT_MODE = 'demo';
    const assertExternalAccessEntitled = vi.fn();
    container.registerInstance(DockerInternalRegistryService, { assertExternalAccessEntitled } as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request('/registry/token');

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DEMO_MODE_RESTRICTED' });
    expect(assertExternalAccessEntitled).not.toHaveBeenCalled();
  });

  it('accepts an Opfield API token only as the Basic password', () => {
    expect(__testOnly.basicPassword(`Basic ${Buffer.from('opfield:gw_secret').toString('base64')}`)).toBe('gw_secret');
    expect(__testOnly.basicPassword(`Basic ${Buffer.from('opfield:gwo_oauth').toString('base64')}`)).toBeNull();
    expect(__testOnly.basicPassword('Bearer gw_secret')).toBeNull();
  });

  it('parses exact repository pull/push grants and rejects delete or malformed repositories', () => {
    const valid = new URL(
      'https://opfield.example.com/api/docker/registry/token?scope=repository:tenant/app:pull,push'
    );
    expect(__testOnly.requestedRegistryGrants(valid)).toEqual([
      { repository: 'tenant/app', actions: ['pull', 'push'] },
    ]);

    const deletion = new URL(
      'https://opfield.example.com/api/docker/registry/token?scope=repository:tenant/app:delete'
    );
    expect(() => __testOnly.requestedRegistryGrants(deletion)).toThrow('Registry action scope is invalid');

    const malformed = new URL('https://opfield.example.com/api/docker/registry/token?scope=repository:Tenant/App:pull');
    expect(() => __testOnly.requestedRegistryGrants(malformed)).toThrow('Registry repository scope is invalid');
  });

  it("grants pull and push from the token's registry access, not its scopes", async () => {
    const token = {
      validateToken: vi.fn().mockResolvedValue({
        user: { id: 'user-1', scopes: ['docker:containers:manage:node-1'] },
        scopes: [],
        registryAccess: { pull: ['tenant/app'], push: ['tenant/app'] },
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    };
    const registry = {
      assertExternalAccessEntitled: vi.fn().mockResolvedValue({ externalAccessEnabled: true }),
      issueToken: vi.fn().mockReturnValue({
        token: 'jwt',
        accessToken: 'jwt',
        expiresIn: 300,
        issuedAt: '2026-08-24T00:00:00.000Z',
      }),
    };
    container.registerInstance(TokensService, token as never);
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request(
      '/registry/token?service=opfield-internal-registry&scope=repository:tenant/app:pull,push',
      {
        headers: { Authorization: `Basic ${Buffer.from('opfield:gw_secret').toString('base64')}` },
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'jwt', access_token: 'jwt', expires_in: 300 });
    expect(registry.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: [{ repository: 'tenant/app', actions: ['pull', 'push'] }],
        allowed: [{ repository: 'tenant/app', actions: ['pull', 'push'] }],
      })
    );
  });

  it('denies push when the API token is pull-only', async () => {
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: { id: 'user-1', scopes: ['docker:containers:manage'] },
        scopes: [],
        registryAccess: { pull: ['tenant/app'] },
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as never);
    const registry = {
      assertExternalAccessEntitled: vi.fn().mockResolvedValue({ externalAccessEnabled: true }),
      issueToken: vi.fn(),
    };
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request('/registry/token?scope=repository:tenant/app:push', {
      headers: { Authorization: `Basic ${Buffer.from('opfield:gw_secret').toString('base64')}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'REGISTRY_SCOPE_DENIED' });
    expect(registry.issueToken).not.toHaveBeenCalled();
  });

  it.each([
    [
      'another repository than the narrowed one',
      { pull: ['tenant/app'] },
      ['docker:containers:view'],
      'tenant/app-two',
    ],
    ['a prefix of the narrowed repository', { pull: ['tenant/app'] }, ['docker:containers:view'], 'tenant'],
    ['an owner who can no longer view any workload or image', { pull: 'all' }, ['proxy:view'], 'tenant/app'],
    ['a token without registry access', {}, ['docker:containers:manage'], 'tenant/app'],
  ])('denies pull for %s', async (_case, registryAccess, ownerScopes, repository) => {
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: { id: 'user-1', scopes: ownerScopes },
        scopes: ['docker:containers:view'],
        registryAccess,
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as never);
    const registry = {
      assertExternalAccessEntitled: vi.fn().mockResolvedValue({ externalAccessEnabled: true }),
      issueToken: vi.fn(),
    };
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request(`/registry/token?scope=repository:${repository}:pull`, {
      headers: { Authorization: `Basic ${Buffer.from('opfield:gw_secret').toString('base64')}` },
    });

    expect(response.status).toBe(403);
    expect(registry.issueToken).not.toHaveBeenCalled();
  });

  it('lets a legacy per-repository registry grant of the owner stand in for workload access', async () => {
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: { id: 'user-1', scopes: ['docker:registries:internal:pull:tenant/app'] },
        scopes: [],
        registryAccess: { pull: 'all' },
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as never);
    const registry = {
      assertExternalAccessEntitled: vi.fn().mockResolvedValue({ externalAccessEnabled: true }),
      issueToken: vi.fn().mockReturnValue({ token: 'jwt', accessToken: 'jwt', expiresIn: 300, issuedAt: 'now' }),
    };
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);
    const pull = (repository: string) =>
      app.request(`/registry/token?scope=repository:${repository}:pull`, {
        headers: { Authorization: `Basic ${Buffer.from('opfield:gw_secret').toString('base64')}` },
      });

    expect((await pull('tenant/app')).status).toBe(200);
    expect((await pull('tenant/other')).status).toBe(403);
    expect(registry.issueToken).toHaveBeenCalledTimes(1);
  });

  it("bounds an `all` token by the workloads its owner may see or change now, not by any grant's base", async () => {
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: { id: 'user-1', scopes: ['docker:containers:view:node-1/c1', 'docker:containers:edit:node-9/other'] },
        scopes: [],
        registryAccess: { pull: 'all', push: 'all' },
        tokenId: 'token-1',
        tokenPrefix: 'gw_test',
      }),
    } as never);
    const registry = {
      assertExternalAccessEntitled: vi.fn().mockResolvedValue({ externalAccessEnabled: true }),
      issueToken: vi.fn().mockReturnValue({ token: 'jwt', accessToken: 'jwt', expiresIn: 300, issuedAt: 'now' }),
    };
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);
    const request = (scope: string) =>
      app.request(`/registry/token?scope=${scope}`, {
        headers: { Authorization: `Basic ${Buffer.from('opfield:gw_secret').toString('base64')}` },
      });

    expect((await request('repository:tenant/app:pull')).status).toBe(200);
    // Push needs a change right on c1; another team's repository is no workload of the owner.
    expect((await request('repository:tenant/app:push')).status).toBe(403);
    expect((await request('repository:other-team/app:pull')).status).toBe(403);
    expect(registry.issueToken).toHaveBeenCalledTimes(1);
    expect(workloads).toHaveBeenCalledWith('tenant/app');
  });

  it('rejects external token issuance before API-token validation when Business is unavailable', async () => {
    const validateToken = vi.fn();
    container.registerInstance(TokensService, { validateToken } as never);
    const registry = {
      assertExternalAccessEntitled: vi
        .fn()
        .mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Business required')),
      issueToken: vi.fn(),
    };
    container.registerInstance(DockerInternalRegistryService, registry as never);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/registry', dockerRegistryAuthRoutes);

    const response = await app.request('/registry/token?scope=repository:tenant/app:pull', {
      headers: { Authorization: `Basic ${Buffer.from('opfield:gw_secret').toString('base64')}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    expect(validateToken).not.toHaveBeenCalled();
    expect(registry.issueToken).not.toHaveBeenCalled();
  });
});
