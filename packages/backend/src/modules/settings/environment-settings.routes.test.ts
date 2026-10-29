import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv, User } from '@/types.js';
import { environmentSettingsRoutes } from './environment-settings.routes.js';
import { DEFAULT_ENVIRONMENT_SETTINGS, EnvironmentSettingsService } from './environment-settings.service.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

const USER = { id: '11111111-1111-4111-8111-111111111111', isBlocked: false } as User;

function settingsApp(scopes: string[]) {
  container.registerInstance(TokensService, {
    validateToken: vi.fn().mockResolvedValue({ user: { ...USER, scopes }, scopes, tokenId: 't1', tokenPrefix: 'gw_t' }),
  } as unknown as TokensService);
  container.registerInstance(TOKENS.DrizzleClient, {} as never);
  const update = vi.fn(async () => DEFAULT_ENVIRONMENT_SETTINGS);
  container.registerInstance(EnvironmentSettingsService, {
    getSnapshot: () => structuredClone(DEFAULT_ENVIRONMENT_SETTINGS),
    update,
  } as unknown as EnvironmentSettingsService);
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/settings/environment', environmentSettingsRoutes);
  return { app, update };
}

const patch = (app: Hono<AppEnv>, sessions: Record<string, unknown>) =>
  app.request('/api/settings/environment', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer gw_test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
  });

afterEach(() => {
  container.reset();
});

describe('absolute session lifetime setting (AUTH-5)', () => {
  it('needs admin:system to change, since lowering it ends older sessions at once', async () => {
    const editor = settingsApp(['settings:opfield:edit']);
    const refused = await patch(editor.app, { absoluteLifetimeSeconds: 86_400 });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ code: 'ADMIN_SYSTEM_REQUIRED' });
    expect(editor.update).not.toHaveBeenCalled();

    // The session lifetime and an unchanged absolute lifetime stay with settings:opfield:edit.
    const unchanged = await patch(editor.app, { expirySeconds: 86_400, absoluteLifetimeSeconds: null });
    expect(unchanged.status).toBe(200);

    const system = settingsApp(['settings:opfield:edit', 'admin:system']);
    expect((await patch(system.app, { absoluteLifetimeSeconds: 86_400 })).status).toBe(200);
    expect(system.update).toHaveBeenCalledWith({ sessions: { absoluteLifetimeSeconds: 86_400 } });
  });
});
