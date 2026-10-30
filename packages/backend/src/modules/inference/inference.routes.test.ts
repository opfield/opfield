import 'reflect-metadata';
import '@/db/schema/index.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const caller = vi.hoisted(() => ({ authType: 'session', impersonation: null as unknown }));

vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: ['feat:ai:use'] });
    c.set('effectiveScopes', ['feat:ai:use']);
    c.set('authType', caller.authType);
    c.set('impersonation', caller.impersonation);
    await next();
  },
}));

const { inferenceManagementRoutes } = await import('./inference.routes.js');
const { InferenceTokenService } = await import('./inference-token.service.js');

function setup() {
  const service = {
    listTokens: vi.fn().mockResolvedValue([]),
    createToken: vi.fn().mockResolvedValue({ id: 'key-1' }),
    updateToken: vi.fn().mockResolvedValue({ id: 'key-1' }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(InferenceTokenService, service as never);
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/inference', inferenceManagementRoutes);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/inference${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { service, send };
}

afterEach(() => {
  container.reset();
  caller.authType = 'session';
  caller.impersonation = null;
});

describe('inference key routes', () => {
  it.each(['session', 'api-token', 'oauth-token'])('mints and changes a key with a %s', async (authType) => {
    caller.authType = authType;
    const { service, send } = setup();
    expect((await send('POST', '/tokens', { name: 'ci' })).status).toBe(201);
    expect(service.createToken).toHaveBeenCalledWith('user-1', expect.objectContaining({ name: 'ci' }));
    expect((await send('PATCH', '/tokens/key-1', { name: 'ci' })).status).toBe(200);
    expect(service.updateToken).toHaveBeenCalled();
  });

  it('refuses minting or changing a key while impersonating', async () => {
    caller.impersonation = { adminUserId: 'admin-1' };
    const { service, send } = setup();
    expect((await send('POST', '/tokens', { name: 'ci' })).status).toBe(403);
    expect((await send('PATCH', '/tokens/key-1', { name: 'ci' })).status).toBe(403);
    expect(service.createToken).not.toHaveBeenCalled();
    expect(service.updateToken).not.toHaveBeenCalled();
    // Listing and revoking stay open.
    expect((await send('GET', '/tokens')).status).toBe(200);
    expect((await send('DELETE', '/tokens/key-1')).status).toBe(204);
  });
});
