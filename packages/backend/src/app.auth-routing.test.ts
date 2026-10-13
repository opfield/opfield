import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { DockerWebhookService } from '@/modules/docker/docker-webhook.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { LoggingTokenService } from '@/modules/logging/logging-token.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { PageDeployTokenService } from '@/modules/pages/tokens/page-deploy-token.service.js';
import { OpfieldLifecycleService } from '@/services/opfield-lifecycle.service.js';
import { createApp } from './app.js';

const validateOAuth = vi.fn(async (_token: string, options: { resource?: string }) =>
  options.resource === 'http://gateway.test/api/mcp'
    ? {
        user: { id: 'user', scopes: ['mcp:use'] },
        scopes: ['nodes:details'],
        tokenId: 'token',
        tokenPrefix: 'gwo_fixture',
        clientId: 'client',
      }
    : null
);
const loggingToken = vi.fn(async () => null);
const pageToken = vi.fn(async () => null);
const webhookToken = vi.fn(async () => null);
const sourceWebhook = vi.fn(async () => ({ duplicate: false }));

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_URL', 'http://gateway.test');
  vi.stubEnv('DATABASE_URL', 'http://localhost/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('PKI_MASTER_KEY', '0'.repeat(64));
  vi.clearAllMocks();
  container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);
  const pipeline = {
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
    zadd: vi.fn(),
    expire: vi.fn(),
    exec: async () => [
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 1],
    ],
  };
  container.registerInstance(TOKENS.RedisClient, { pipeline: () => pipeline });
  container.registerInstance(OpfieldLifecycleService, { getState: () => 'running' } as OpfieldLifecycleService);
  container.registerInstance(OAuthService, {
    getApiResourceUrl: () => 'http://gateway.test/api',
    getMcpResourceUrl: () => 'http://gateway.test/api/mcp',
    getProtectedResourceMetadataUrl: () => 'http://gateway.test/.well-known/oauth-protected-resource/api/mcp',
    validateAccessToken: validateOAuth,
  } as unknown as OAuthService);
  container.registerInstance(McpSettingsService, {
    getConfig: async () => ({ serverEnabled: true, extendedCompatibility: false }),
  } as unknown as McpSettingsService);
  container.registerInstance(LicensePolicyService, {
    requireFeature: async () => {},
    requireFeatureForExistingRuntime: async () => {},
  } as unknown as LicensePolicyService);
  container.registerInstance(LoggingFeatureService, { requireEnabled: () => {} } as unknown as LoggingFeatureService);
  container.registerInstance(LoggingTokenService, { validate: loggingToken } as unknown as LoggingTokenService);
  container.registerInstance(PageDeployTokenService, { validate: pageToken } as unknown as PageDeployTokenService);
  container.registerInstance(DockerWebhookService, { getByToken: webhookToken } as unknown as DockerWebhookService);
  container.registerInstance(DockerSourceService, { handleWebhook: sourceWebhook } as unknown as DockerSourceService);
});
afterEach(() => {
  container.reset();
  vi.unstubAllEnvs();
});

describe('authentication boundaries in the complete application route graph', () => {
  it('validates MCP tokens only against the MCP resource', async () => {
    const response = await createApp().app.request('/api/mcp', {
      headers: { host: 'gateway.test', Authorization: 'Bearer gwo_fixture' },
    });
    expect(response.status).toBe(405);
    expect(validateOAuth).toHaveBeenCalledExactlyOnceWith('gwo_fixture', { resource: 'http://gateway.test/api/mcp' });
  });

  it('initializes MCP through the real application with an MCP-resource token', async () => {
    const response = await createApp().app.request('/api/mcp', {
      method: 'POST',
      headers: {
        host: 'gateway.test',
        Authorization: 'Bearer gwo_fixture',
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'routing-test', version: '1' },
        },
      }),
    });
    expect(response.status).toBe(200);
    const messages = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    expect(messages).toContainEqual(
      expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: '2025-11-25' }) })
    );
    expect(validateOAuth).toHaveBeenCalledExactlyOnceWith('gwo_fixture', { resource: 'http://gateway.test/api/mcp' });
  });

  it('lets Docker webhooks validate their URL token without a REST bearer', async () => {
    const response = await createApp().app.request('/api/webhooks/docker/fixture-token', {
      method: 'POST',
      headers: { host: 'gateway.test' },
    });
    expect(response.status).toBe(404);
    expect(webhookToken).toHaveBeenCalledExactlyOnceWith('fixture-token');
    expect(validateOAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/logging/ingest', 'gwl_fixture', 'Invalid or expired logging ingest token'],
    ['/api/logging/ingest/batch', 'gwl_fixture', 'Invalid or expired logging ingest token'],
    ['/api/pages-deploy/deployments', 'gwp_fixture', 'Invalid or expired Page deploy token'],
  ])('does not register %s without the private module', async (path, token) => {
    const response = await createApp().app.request(path, {
      method: 'POST',
      headers: { host: 'gateway.test', Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    expect(loggingToken).not.toHaveBeenCalled();
    expect(pageToken).not.toHaveBeenCalled();
    expect(validateOAuth).not.toHaveBeenCalled();
  });

  it('answers private-module Console routes with COMMERCIAL_MODULE_UNAVAILABLE, to signed-in callers only', async () => {
    const anonymous = await createApp().app.request('/api/status-page/settings', {
      headers: { host: 'gateway.test' },
    });
    expect(anonymous.status).toBe(401);
    validateOAuth.mockResolvedValueOnce({
      user: { id: 'user', scopes: ['status-page:view'] },
      scopes: ['status-page:view'],
      tokenId: 'token',
      tokenPrefix: 'gwo_fixture',
      clientId: 'client',
    });
    const signedIn = await createApp().app.request('/api/status-page/settings', {
      headers: { host: 'gateway.test', Authorization: 'Bearer gwo_fixture' },
    });
    expect(signedIn.status).toBe(503);
    expect(await signedIn.json()).toMatchObject({ code: 'COMMERCIAL_MODULE_UNAVAILABLE' });
  });

  it('allows a source webhook to reach signature verification without a REST bearer', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const response = await createApp().app.request(`/api/webhooks/docker-source/${id}`, {
      method: 'POST',
      headers: { host: 'gateway.test' },
      body: '{}',
    });
    expect(response.status).toBe(202);
    expect(sourceWebhook).toHaveBeenCalledExactlyOnceWith(id, expect.any(Headers), Buffer.from('{}'));
  });
});

describe('unknown API paths', () => {
  it.each([
    // A module router authenticates before it routes: the caller is signed in.
    ['GET', '/api/system/diagnostics', true],
    ['DELETE', '/api/not-a-module/1', false],
    ['POST', '/auth/not-a-route', false],
  ])('answers %s %s with a JSON 404, not the Console page', async (method, path, signedIn) => {
    if (signedIn) {
      validateOAuth.mockResolvedValueOnce({
        user: { id: 'user', scopes: ['diagnostics:view'] },
        scopes: ['diagnostics:view'],
        tokenId: 'token',
        tokenPrefix: 'gwo_fixture',
        clientId: 'client',
      });
    }
    const response = await createApp().app.request(path, {
      method,
      headers: { host: 'gateway.test', ...(signedIn ? { Authorization: 'Bearer gwo_fixture' } : {}) },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: `No API endpoint at ${method} ${path}` });
  });
});
