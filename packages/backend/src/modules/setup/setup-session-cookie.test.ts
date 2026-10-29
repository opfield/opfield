import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { getSessionCookieName } from '@/modules/auth/session-cookie.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv } from '@/types.js';
import { SETUP_CSRF_HEADER, SETUP_SESSION_COOKIE, setupRoutes } from './setup.routes.js';
import { SetupAccessService } from './setup-access.service.js';
import { SetupTokenPolicyService } from './setup-token-policy.js';
import { SetupWizardService } from './setup-wizard.service.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

function setupApp() {
  container.registerInstance(SetupTokenPolicyService, {
    isSetupApiEnabled: vi.fn().mockResolvedValue(true),
  } as unknown as SetupTokenPolicyService);
  container.registerInstance(SetupAccessService, {
    validateSession: vi.fn().mockResolvedValue(true),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    getSessionExpiresAt: vi.fn().mockResolvedValue(new Date(Date.now() + 3_600_000).toISOString()),
  } as unknown as SetupAccessService);
  container.registerInstance(SetupWizardService, {
    getPhase: vi.fn().mockResolvedValue('ai_workspace'),
  } as unknown as SetupWizardService);
  container.registerInstance(AuthService, {
    getUserById: vi.fn().mockResolvedValue({ id: 'system-user' }),
  } as unknown as AuthService);
  container.registerInstance(SessionService, {
    destroySetupSessions: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'setup-browser-session', expiresAt: Date.now() + 3_600_000 }),
  } as unknown as SessionService);
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/setup', setupRoutes);
  return app;
}

const startSession = (app: Hono<AppEnv>, url: string, headers: Record<string, string> = {}) =>
  app.request(url, {
    method: 'POST',
    headers: { Cookie: `${SETUP_SESSION_COOKIE}=setup-1`, [SETUP_CSRF_HEADER]: 'csrf', ...headers },
  });

afterEach(() => {
  container.reset();
});

describe('setup wizard browser session cookie', () => {
  it('is the Secure __Host- cookie behind a TLS proxy that is not a trusted proxy (X-Forwarded-Proto: https)', async () => {
    const response = await startSession(setupApp(), 'http://opfield.example.com/api/setup/wizard/session', {
      'X-Forwarded-Proto': 'https',
    });

    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(getSessionCookieName('https')));
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; Path=\//);
  });

  it('is the plain HTTP cookie for a wizard over http://<ip>:3000', async () => {
    const response = await startSession(setupApp(), 'http://203.0.113.5:3000/api/setup/wizard/session');

    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(getSessionCookieName('http')));
    expect(cookie).toBeDefined();
    expect(cookie).not.toMatch(/; Secure/);
  });
});
