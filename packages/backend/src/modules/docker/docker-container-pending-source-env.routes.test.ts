import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import type { AppEnv } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { DockerEnvironmentService } from './docker-environment.service.js';
import { DockerSecretService } from './docker-secret.service.js';
import { DockerSourceService } from './docker-source.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';

function app(scopes: string[]) {
  const router = new OpenAPIHono<AppEnv>();
  router.onError(errorHandler);
  router.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', scopes } as never);
    c.set('effectiveScopes', scopes);
    await next();
  });
  registerContainerRoutes(router);
  return router;
}

/** A Git source container "shop" its first build has not created yet: nothing on the node to inspect. */
function pendingShop(stored: Record<string, string> = {}) {
  container.registerInstance(DockerSourceService, {
    getPendingContainer: vi.fn(async (_nodeId: string, name: string) =>
      name === 'shop' ? { containerName: 'shop', scopeResourceId: 'reserved-shop' } : null
    ),
  } as never);
  const docker = {
    inspectContainer: vi.fn().mockRejectedValue(new Error('No such container: shop')),
    getContainerEnv: vi.fn(),
    updateContainerEnv: vi.fn(),
    assertBuildRolloutAllowed: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(DockerManagementService, docker as never);
  let env = { ...stored };
  const environment = {
    getDecryptedMap: vi.fn(async () => ({ ...env })),
    replace: vi.fn(async (_nodeId: string, _name: string, next: Record<string, string>) => {
      env = { ...next };
    }),
  };
  container.registerInstance(DockerEnvironmentService, environment as never);
  const secrets = {
    getSecretKeys: vi.fn().mockResolvedValue(new Set(['TOKEN'])),
    list: vi.fn().mockResolvedValue([{ id: 'secret-1', key: 'TOKEN', value: '••••••••' }]),
    create: vi.fn().mockResolvedValue({ id: 'secret-2', key: 'API_KEY', value: '••••••••' }),
  };
  container.registerInstance(DockerSecretService, secrets as never);
  container.registerInstance(AuditService, { log: vi.fn() } as never);
  container.registerInstance(TOKENS.DrizzleClient, {} as never);
  return { docker, environment, secrets };
}

beforeEach(() => container.reset());
afterEach(() => container.reset());

describe('env and secrets of a Git source container before its first build created it', () => {
  it('reads the env saved for its reserved name, scoped like the container', async () => {
    const { docker } = pendingShop({ MODE: 'prod' });

    const response = await app([`docker:containers:environment:${NODE}/reserved-shop`]).request(
      `/nodes/${NODE}/containers/shop/env`
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: ['MODE=prod'] });
    expect(docker.getContainerEnv).not.toHaveBeenCalled();
  });

  it('saves env for the first build without recreating anything; a secret name stays a secret', async () => {
    const { docker, environment } = pendingShop({ MODE: 'prod', OLD: '1' });

    const response = await app([`docker:containers:environment:${NODE}/reserved-shop`]).request(
      `/nodes/${NODE}/containers/shop/env`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env: { MODE: 'staging', TOKEN: 'plain' }, removeEnv: ['OLD'] }),
      }
    );

    expect(response.status).toBe(200);
    expect(environment.replace).toHaveBeenCalledWith(NODE, 'shop', { MODE: 'staging' });
    expect(docker.assertBuildRolloutAllowed).toHaveBeenCalledWith({
      kind: 'container',
      nodeId: NODE,
      containerName: 'shop',
    });
    expect(docker.updateContainerEnv).not.toHaveBeenCalled();
  });

  it('stores secrets under the reserved name', async () => {
    const { secrets } = pendingShop();

    const response = await app([`docker:containers:secrets:${NODE}/reserved-shop`]).request(
      `/nodes/${NODE}/containers/shop/secrets`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'API_KEY', value: 'value' }),
      }
    );

    expect(response.status).toBe(201);
    expect(secrets.create).toHaveBeenCalledWith(NODE, 'shop', 'API_KEY', 'value', 'user-1');
  });

  it('refuses a caller without the environment scope of the reserved container', async () => {
    const { environment } = pendingShop();

    const response = await app([`docker:containers:view:${NODE}/reserved-shop`]).request(
      `/nodes/${NODE}/containers/shop/env`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env: { MODE: 'x' } }),
      }
    );

    expect(response.status).toBe(403);
    expect(environment.replace).not.toHaveBeenCalled();
  });
});
