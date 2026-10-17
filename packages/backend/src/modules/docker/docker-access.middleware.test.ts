import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import {
  assertDockerNodeScope,
  assertDockerResourceScope,
  dockerNodeListAccess,
  requireDockerNetworkScope,
  resolveDockerContainerScopeResourceId,
} from './docker-access.middleware.js';
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';

afterEach(() => {
  container.reset();
});

describe('Docker permission diagnostics', () => {
  it('names the canonical child identity, not only the base scope', () => {
    expect(() => assertDockerResourceScope([], 'docker:containers:edit', 'node-1', 'resource-1')).toThrow(
      'Missing required scope: docker:containers:edit:node-1/resource-1'
    );
  });
  it('names the node when checking node access', () => {
    expect(() => assertDockerNodeScope([], 'docker:containers:view', 'node-1')).toThrow(
      'Missing required scope: docker:containers:view:node-1'
    );
  });
  it.each([
    'docker:containers:edit',
    'docker:containers:edit:node-1',
    'docker:containers:edit:node-1/resource-1',
  ])('preserves allowed grant %s', (scope) => {
    expect(() => assertDockerResourceScope([scope], 'docker:containers:edit', 'node-1', 'resource-1')).not.toThrow();
  });
  it('continues allowing a node through its child grant', () => {
    expect(() =>
      assertDockerNodeScope(['docker:containers:view:node-1/resource-1'], 'docker:containers:view', 'node-1')
    ).not.toThrow();
  });
});

describe('per-node Docker list access', () => {
  it('lists the node for node and child grants', () => {
    expect(dockerNodeListAccess(['docker:containers:view:node-1'], 'docker:containers:view', 'node-1')).toBe('node');
    expect(dockerNodeListAccess(['docker:containers:view:node-1/resource-1'], 'docker:containers:view', 'node-1')).toBe(
      'node'
    );
  });

  it('answers an empty list for an empty granted folder, a create-only grant or grants on other nodes', () => {
    for (const scopes of [
      ['docker:containers:view:folder/folder-1'],
      ['docker:containers:create:folder/folder-1'],
      ['docker:containers:view:node-2/resource-1'],
    ]) {
      expect(dockerNodeListAccess(scopes, 'docker:containers:view', 'node-1', 'docker:containers:create')).toBe(
        'empty'
      );
    }
  });

  it('refuses callers without the view or creation scope anywhere', () => {
    expect(() =>
      dockerNodeListAccess(['docker:images:view'], 'docker:containers:view', 'node-1', 'docker:containers:create')
    ).toThrow('Missing required scope: docker:containers:view:node-1');
    // Without a creation scope to fall back on, a create-only grant does not open the list.
    expect(() =>
      dockerNodeListAccess(['docker:containers:create:folder/folder-1'], 'docker:containers:view', 'node-1')
    ).toThrow('Missing required scope: docker:containers:view:node-1');
  });
});

describe('Docker container emergency scope identity', () => {
  it('uses persisted identity only while the stable name has an active transition', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('container temporarily absent'));
    const resolvePersisted = vi.fn().mockResolvedValue('resource-1');

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => true,
        resolvePersisted,
      })
    ).resolves.toBe('resource-1');
    expect(resolvePersisted).toHaveBeenCalledOnce();
  });

  it('does not trust persisted identity when no transition is active', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('container absent'));
    const resolvePersisted = vi.fn();

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => false,
        resolvePersisted,
      })
    ).rejects.toThrow('container absent');
    expect(resolvePersisted).not.toHaveBeenCalled();
  });

  it('never falls back to persisted identity for a Gateway-owned internal container', async () => {
    const inspect = vi.fn().mockRejectedValue(new AppError(404, 'OPFIELD_INTERNAL_CONTAINER', 'Container not found'));
    const resolvePersisted = vi.fn().mockResolvedValue('resource-1');

    await expect(
      resolveDockerContainerScopeResourceId(inspect, {
        active: () => true,
        resolvePersisted,
      })
    ).rejects.toMatchObject({ code: 'OPFIELD_INTERNAL_CONTAINER' });
    expect(resolvePersisted).not.toHaveBeenCalled();
  });
});

describe('Docker network scoped middleware', () => {
  it('allows only the persisted network resource identity and never a raw daemon ID grant', async () => {
    const resources = { resolveNetwork: vi.fn().mockResolvedValue('network-resource-1') };
    container.registerInstance(DockerNetworkAccessResourceService, resources as never);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('effectiveScopes', ['docker:networks:delete:node-1/network-resource-1']);
      await next();
    });
    app.delete('/nodes/:nodeId/networks/:networkId', requireDockerNetworkScope('docker:networks:delete'), (c) =>
      c.json({ success: true })
    );

    const response = await app.request('/nodes/node-1/networks/raw-daemon-network-id', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(resources.resolveNetwork).toHaveBeenCalledWith('node-1', 'raw-daemon-network-id');
  });

  it('denies an unrelated persisted network resource before the action handler runs', async () => {
    const resources = { resolveNetwork: vi.fn().mockResolvedValue('network-resource-2') };
    container.registerInstance(DockerNetworkAccessResourceService, resources as never);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('effectiveScopes', ['docker:networks:delete:node-1/network-resource-1']);
      await next();
    });
    const handler = vi.fn((c: any) => c.json({ success: true }));
    app.delete('/nodes/:nodeId/networks/:networkId', requireDockerNetworkScope('docker:networks:delete'), handler);

    const response = await app.request('/nodes/node-1/networks/raw-daemon-network-id', { method: 'DELETE' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PERMISSION_DENIED',
      // The caller holds the scope on another network only, so the denial points at its grants.
      message:
        'Missing required scope: docker:networks:delete:node-1/network-resource-2. Your docker:networks:delete access is limited to specific resources: call get_my_access to see which ones and use one of them.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not invent a child permission when its identity cannot be resolved', async () => {
    container.registerInstance(DockerNetworkAccessResourceService, {
      resolveNetwork: vi.fn().mockResolvedValue(null),
    } as never);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('effectiveScopes', []);
      await next();
    });
    const handler = vi.fn((c: any) => c.json({ success: true }));
    app.delete('/nodes/:nodeId/networks/:networkId', requireDockerNetworkScope('docker:networks:delete'), handler);
    const response = await app.request('/nodes/node-1/networks/unknown', { method: 'DELETE' });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Docker resource identity could not be resolved for access verification',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
