import 'reflect-metadata';
import '@/db/schema/index.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const caller = vi.hoisted(() => ({ impersonating: false }));

// An administrator acting as user-1 through an impersonation session.
vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: ['feat:ai:use'] });
    c.set('effectiveScopes', ['feat:ai:use']);
    c.set('authType', 'session');
    if (caller.impersonating) c.set('impersonation', { actorUserId: 'admin-1', originalSessionId: 'session-0' });
    await next();
  },
}));

const { oauthRoutes } = await import('./oauth.routes.js');
const { OAuthService } = await import('./oauth.service.js');
const { authRoutes } = await import('@/modules/auth/auth.routes.js');
const { AuthService } = await import('@/modules/auth/auth.service.js');

function setup() {
  const oauth = {
    listUserAuthorizations: vi.fn().mockResolvedValue([]),
    revokeUserAuthorization: vi.fn().mockResolvedValue(undefined),
    updateUserAuthorization: vi.fn().mockResolvedValue({ id: 'grant-1' }),
  };
  const auth = { updateUserPreferences: vi.fn().mockResolvedValue({ aiApprovalMode: 'normal' }) };
  container.registerInstance(OAuthService, oauth as never);
  container.registerInstance(AuthService, auth as never);
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/oauth', oauthRoutes);
  app.route('/auth', authRoutes);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { oauth, auth, send };
}

afterEach(() => {
  container.reset();
  caller.impersonating = false;
});

describe('changes that outlive an impersonation session', () => {
  it("refuses changing or revoking the subject's OAuth authorizations", async () => {
    caller.impersonating = true;
    const { oauth, send } = setup();
    const patched = await send('PATCH', '/api/oauth/authorizations/grant-1', { scopes: ['feat:ai:use'] });
    expect(patched.status).toBe(403);
    expect(await patched.json()).toMatchObject({ code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN' });
    expect((await send('DELETE', '/api/oauth/authorizations/grant-1')).status).toBe(403);
    expect(oauth.updateUserAuthorization).not.toHaveBeenCalled();
    expect(oauth.revokeUserAuthorization).not.toHaveBeenCalled();
    // Reading them stays available.
    expect((await send('GET', '/api/oauth/authorizations')).status).toBe(200);
  });

  it("refuses changing the subject's AI approval mode, not their interface choice", async () => {
    caller.impersonating = true;
    const { auth, send } = setup();
    expect((await send('PATCH', '/auth/me/preferences', { aiApprovalMode: 'bypass-everything' })).status).toBe(403);
    expect(auth.updateUserPreferences).not.toHaveBeenCalled();
    expect((await send('PATCH', '/auth/me/preferences', { preferredInterface: 'operations_console' })).status).toBe(
      200
    );
  });

  it('lets the user change both themselves', async () => {
    const { oauth, auth, send } = setup();
    expect((await send('DELETE', '/api/oauth/authorizations/grant-1')).status).toBe(200);
    expect((await send('PATCH', '/auth/me/preferences', { aiApprovalMode: 'normal' })).status).toBe(200);
    expect(oauth.revokeUserAuthorization).toHaveBeenCalledWith('user-1', 'grant-1');
    expect(auth.updateUserPreferences).toHaveBeenCalledWith('user-1', { aiApprovalMode: 'normal' });
  });
});
