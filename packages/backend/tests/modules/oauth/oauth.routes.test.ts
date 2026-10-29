import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { API_TOKEN_SCOPES } from '@/lib/scopes.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { oauthMetadataRoutes, oauthRoutes } from '@/modules/oauth/oauth.routes.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';

type JsonRecord = Record<string, any>;

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: '22222222-2222-4222-8222-222222222222',
  groupName: 'admin',
  scopes: ['nodes:details', 'mcp:use'],
  isBlocked: false,
};

const SESSION: SessionData = {
  userId: USER.id,
  user: USER,
  accessToken: 'oidc-access-token',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

const IMPERSONATION_ACTOR: User = {
  ...USER,
  id: '33333333-3333-4333-8333-333333333333',
  oidcSubject: 'oidc-actor',
  email: 'operator@example.com',
  name: 'Operator',
  groupId: '44444444-4444-4444-8444-444444444444',
  groupName: 'operator',
  scopes: ['admin:users:impersonate', ...USER.scopes],
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/oauth', oauthRoutes);
  app.route('/.well-known', oauthMetadataRoutes);
  return app;
}

function registerOAuthService(overrides: Partial<OAuthService> = {}) {
  container.registerInstance(OAuthService, {
    getIssuerUrl: vi.fn().mockReturnValue('https://opfield.example.com'),
    getApiResourceUrl: vi.fn().mockReturnValue('https://opfield.example.com/api'),
    getMcpResourceUrl: vi.fn().mockReturnValue('https://opfield.example.com/api/mcp'),
    registerClient: vi.fn().mockResolvedValue({
      client_id: 'goc_client',
      client_id_issued_at: 1777413600,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: ['http://127.0.0.1:39231/callback'],
      client_name: 'Example API Client',
    }),
    createConsentRequest: vi.fn().mockResolvedValue({
      id: 'request-1',
    }),
    getConsentRequest: vi.fn().mockResolvedValue({
      id: 'request-1',
      clientId: 'goc_client',
      clientName: 'External App',
      clientUri: null,
      logoUri: null,
      redirectUri: 'https://client.example.com/callback',
      redirectUriIsExternal: true,
      userId: USER.id,
      requestedScopes: ['nodes:details'],
      grantableScopes: ['nodes:details'],
      unavailableScopes: [],
      manualApprovalScopes: [],
      resource: 'https://opfield.example.com/api',
      expiresAt: Date.now() + 60_000,
    }),
    exchangeToken: vi.fn().mockResolvedValue({
      access_token: 'gwo_access',
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'nodes:details docker:containers:view',
      refresh_token: 'gwr_refresh',
    }),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OAuthService);
}

function registerSession(user: User = USER) {
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue({ ...SESSION, user, userId: user.id }),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: user.id,
          oidcSubject: user.oidcSubject,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          groupId: user.groupId,
          isBlocked: user.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: user.groupId,
            parentId: null,
            name: user.groupName,
            scopes: user.scopes,
          },
        ]),
      },
    },
  } as unknown as DrizzleClient);
}

function registerImpersonationSession() {
  const session: SessionData = {
    ...SESSION,
    purpose: 'impersonation',
    impersonation: {
      actorUserId: IMPERSONATION_ACTOR.id,
      originalSessionId: 'original-session',
    },
  };
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(session),
    getOriginalSessionForImpersonation: vi.fn().mockResolvedValue({
      sessionId: 'original-session',
      session: {
        ...SESSION,
        userId: IMPERSONATION_ACTOR.id,
        user: IMPERSONATION_ACTOR,
        purpose: 'user',
      },
    }),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValueOnce(USER).mockResolvedValueOnce(IMPERSONATION_ACTOR),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: USER.groupId,
            parentId: null,
            name: USER.groupName,
            scopes: USER.scopes,
          },
          {
            id: IMPERSONATION_ACTOR.groupId,
            parentId: null,
            name: IMPERSONATION_ACTOR.groupName,
            scopes: IMPERSONATION_ACTOR.scopes,
          },
        ]),
      },
    },
  } as unknown as DrizzleClient);
}

beforeEach(() => {
  registerOAuthService();
});

afterEach(() => {
  container.reset();
});

describe('OAuth metadata routes', () => {
  it('advertises authorization server metadata for public PKCE clients', async () => {
    const response = await createApp().request('/.well-known/oauth-authorization-server');
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.authorization_endpoint).toBe('https://opfield.example.com/api/oauth/authorize');
    expect(body.token_endpoint).toBe('https://opfield.example.com/api/oauth/token');
    expect(body.registration_endpoint).toBe('https://opfield.example.com/api/oauth/register');
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('advertises authorization server metadata at MCP discovery aliases', async () => {
    const app = createApp();
    for (const path of [
      '/.well-known/oauth-authorization-server/api/mcp',
      '/.well-known/openid-configuration/api/mcp',
    ]) {
      const response = await app.request(path);
      const body = (await response.json()) as JsonRecord;

      expect(response.status).toBe(200);
      expect(body.authorization_endpoint).toBe('https://opfield.example.com/api/oauth/authorize/api/mcp');
      expect(body.token_endpoint).toBe('https://opfield.example.com/api/oauth/token');
      expect(body.grant_types_supported).toEqual(['authorization_code']);
      expect(body.scopes_supported).toContain('nodes:details');
      expect(body.scopes_supported).toContain('integrations:cloudflare:view');
      expect(body.scopes_supported).not.toContain('integrations:cloudflare:dns:view');
      expect(body.scopes_supported).toContain('integrations:gitlab:repo:read');
      expect(body.scopes_supported).toContain('integrations:github:view');
      expect(body.scopes_supported).toContain('integrations:git:view');
      expect(body.scopes_supported).toContain('integrations:ssh:view');
      expect(body.scopes_supported).toContain('integrations:gitlab:repo:write');
      expect(body.scopes_supported).toContain('integrations:github:manage');
      expect(body.scopes_supported).toContain('integrations:git:manage');
      expect(body.scopes_supported).toContain('integrations:ssh:use');
      expect(body.scopes_supported).toContain('admin:users');
      expect(body.scopes_supported).not.toContain('mcp:use');
      expect(body.scopes_supported).not.toContain('admin:users:impersonate');
      expect(body.scopes_supported).not.toContain('integrations:gitlab:sandbox:clone');
    }
  });

  it('no longer serves OAuth metadata for the removed inference companion setup resource', async () => {
    const app = createApp();
    const authorization = await app.request('/.well-known/oauth-authorization-server/api/inference/setup');
    const protectedResource = await app.request('/.well-known/oauth-protected-resource/api/inference/setup');

    expect(authorization.status).toBe(404);
    expect(protectedResource.status).toBe(404);
  });

  it('advertises authorization server metadata below the MCP endpoint path', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/api/mcp/.well-known', oauthMetadataRoutes);

    const response = await app.request('/api/mcp/.well-known/oauth-authorization-server');
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.authorization_endpoint).toBe('https://opfield.example.com/api/oauth/authorize/api/mcp');
    expect(body.grant_types_supported).toEqual(['authorization_code']);
  });

  it('advertises the API protected resource metadata', async () => {
    const response = await createApp().request('/.well-known/oauth-protected-resource');
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.resource).toBe('https://opfield.example.com/api');
    expect(body.authorization_servers).toEqual(['https://opfield.example.com']);
    expect(body.scopes_supported).toContain('nodes:details');
    expect(body.scopes_supported).not.toContain('mcp:use');
    expect(body.scopes_supported).not.toContain('ai:workspace:use');
    expect(body.scopes_supported).not.toContain('admin:users:impersonate');
    expect(body.scopes_supported).toContain('admin:system');
    expect(body.scopes_supported).toContain('admin:users');
    expect(body.scopes_supported).toContain('settings:opfield:edit');
  });
});

describe('OAuth authorization route', () => {
  const authorizePath =
    '/api/oauth/authorize?response_type=code&client_id=goc_client&redirect_uri=http%3A%2F%2F127.0.0.1%3A39231%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256&state=state-1';

  it('redirects missing scope errors to the registered OAuth client callback', async () => {
    registerSession();
    registerOAuthService({
      createConsentRequest: vi
        .fn()
        .mockRejectedValue(new AppError(400, 'INVALID_SCOPE', 'At least one OAuth scope is required')),
    });

    const response = await createApp().request(authorizePath, {
      headers: { Cookie: 'session_id=session-1' },
    });
    const location = response.headers.get('location');

    expect(response.status).toBe(302);
    expect(location).toBeTruthy();
    const redirect = new URL(location!);
    expect(`${redirect.origin}${redirect.pathname}`).toBe('http://127.0.0.1:39231/callback');
    expect(redirect.searchParams.get('error')).toBe('invalid_scope');
    expect(redirect.searchParams.get('error_description')).toBe('At least one OAuth scope is required');
    expect(redirect.searchParams.get('state')).toBe('state-1');
  });

  it('uses the MCP resource for MCP authorize alias requests that omit resource', async () => {
    registerSession();
    const createConsentRequest = vi.fn().mockResolvedValue({ id: 'request-1' });
    registerOAuthService({ createConsentRequest });
    const mcpAuthorizePath = `${authorizePath}&scope=nodes%3Adetails`.replace('/authorize?', '/authorize/api/mcp?');

    const response = await createApp().request(mcpAuthorizePath, {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://opfield.example.com/oauth/consent?request=request-1');
    expect(createConsentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER.id }),
      expect.objectContaining({ resource: 'https://opfield.example.com/api/mcp' })
    );
  });

  it('has no authorize alias for the removed inference companion setup resource', async () => {
    registerSession();
    const createConsentRequest = vi.fn().mockResolvedValue({ id: 'request-1' });
    registerOAuthService({ createConsentRequest });
    const setupPath = authorizePath.replace('/authorize?', '/authorize/api/inference/setup?');

    const response = await createApp().request(setupPath, {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(404);
    expect(createConsentRequest).not.toHaveBeenCalled();
  });

  it('redirects invalid target errors to the Opfield OAuth error UI', async () => {
    registerSession();
    registerOAuthService({
      createConsentRequest: vi
        .fn()
        .mockRejectedValue(
          new AppError(400, 'INVALID_TARGET', 'OAuth authorization is not available for this resource')
        ),
    });

    const response = await createApp().request(`${authorizePath}&scope=nodes%3Alist&resource=https%3A%2F%2Fevil.test`, {
      headers: { Cookie: 'session_id=session-1' },
    });
    const location = response.headers.get('location');

    expect(response.status).toBe(302);
    expect(location).toBeTruthy();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/oauth/error');
    expect(redirect.searchParams.get('code')).toBe('INVALID_TARGET');
    expect(redirect.searchParams.get('message')).toBe('OAuth authorization is not available for this resource');
  });

  it('redirects malformed authorization requests to the Opfield OAuth error UI', async () => {
    const response = await createApp().request('/api/oauth/authorize?response_type=code&client_id=goc_client');
    const location = response.headers.get('location');

    expect(response.status).toBe(302);
    expect(location).toBeTruthy();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/oauth/error');
    expect(redirect.searchParams.get('code')).toBe('INVALID_REQUEST');
  });

  it('does not issue OAuth credentials from an impersonation session', async () => {
    registerImpersonationSession();
    const createConsentRequest = vi.fn();
    registerOAuthService({ createConsentRequest });

    const response = await createApp().request(`${authorizePath}&scope=nodes%3Adetails`, {
      headers: { Cookie: 'session_id=impersonation-session' },
    });
    const location = response.headers.get('location');

    expect(response.status).toBe(302);
    expect(location).toBeTruthy();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/oauth/error');
    expect(redirect.searchParams.get('code')).toBe('IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN');
    expect(createConsentRequest).not.toHaveBeenCalled();
  });
});

describe('OAuth client and token routes', () => {
  it('registers public OAuth clients without a client secret', async () => {
    const response = await createApp().request('/api/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Example API Client',
        redirect_uris: ['http://127.0.0.1:39231/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(201);
    expect(body.client_id).toBe('goc_client');
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('registers clients that request the full advertised scope catalog', async () => {
    const scope = API_TOKEN_SCOPES.join(' ');
    expect(scope.length).toBeGreaterThan(4096);

    const response = await createApp().request('/api/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:39231/callback'],
        token_endpoint_auth_method: 'none',
        scope,
      }),
    });

    expect(response.status).toBe(201);
  });

  it('rejects unsafe OAuth client metadata URL schemes', async () => {
    const response = await createApp().request('/api/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Unsafe Client',
        redirect_uris: ['http://127.0.0.1:39231/callback'],
        token_endpoint_auth_method: 'none',
        client_uri: 'javascript:alert(1)',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('exchanges authorization codes using form-encoded OAuth token requests', async () => {
    const response = await createApp().request('/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'goc_client',
        code: 'gwo_code',
        redirect_uri: 'http://127.0.0.1:39231/callback',
        code_verifier: 'a'.repeat(43),
      }).toString(),
    });
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.access_token).toBe('gwo_access');
    expect(body.refresh_token).toBe('gwr_refresh');
    expect(body.scope).toBe('nodes:details docker:containers:view');
    // Token responses are never cached (RFC 6749 section 5.1, R1-13).
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });

  it('returns MCP token responses without refresh metadata', async () => {
    registerOAuthService({
      exchangeToken: vi.fn().mockResolvedValue({
        access_token: 'gwo_mcp_access',
        token_type: 'Bearer',
        scope: 'nodes:details',
      }),
    });

    const response = await createApp().request('/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'goc_client',
        code: 'gwo_code',
        redirect_uri: 'http://127.0.0.1:39231/callback',
        code_verifier: 'a'.repeat(43),
      }).toString(),
    });
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.access_token).toBe('gwo_mcp_access');
    expect(body.refresh_token).toBeUndefined();
    expect(body.expires_in).toBeUndefined();
  });

  it('revokes tokens without exposing whether the token existed', async () => {
    const response = await createApp().request('/api/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: 'gwr_refresh',
        client_id: 'goc_client',
      }).toString(),
    });

    expect(response.status).toBe(200);
  });
});

describe('OAuth consent routes', () => {
  it('returns redirect callback information in the consent preview', async () => {
    registerSession();

    const response = await createApp().request('/api/oauth/consent/request-1', {
      headers: { Cookie: 'session_id=session-1' },
    });
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.redirect).toEqual({
      uri: 'https://client.example.com/callback',
      isExternal: true,
    });
  });

  it('approves a folder-restricted scope selection', async () => {
    registerSession({ ...USER, scopes: [...USER.scopes, 'docker:containers:manage'] });
    const approveConsent = vi.fn().mockResolvedValue('http://127.0.0.1:8765/callback?code=abc');
    registerOAuthService({ approveConsent });
    const folderScope = 'docker:containers:manage:folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';

    const response = await createApp().request('/api/oauth/consent/request-1/approve', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=session-1',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-token',
      },
      body: JSON.stringify({ scopes: [folderScope, 'docker:containers:view:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f/7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928'] }),
    });

    expect(response.status).toBe(200);
    expect(approveConsent).toHaveBeenCalledWith('request-1', expect.objectContaining({ id: USER.id }), [
      folderScope,
      'docker:containers:view:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f/7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928',
    ]);
  });

  it('rejects a folder restriction on a scope that cannot target folders', async () => {
    registerSession();
    const approveConsent = vi.fn();
    registerOAuthService({ approveConsent });

    const response = await createApp().request('/api/oauth/consent/request-1/approve', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=session-1',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-token',
      },
      body: JSON.stringify({ scopes: ['pki:cert:issue:folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e'] }),
    });

    expect(response.status).toBe(400);
    expect(approveConsent).not.toHaveBeenCalled();
  });

  it('does not approve consent from an impersonation session', async () => {
    registerImpersonationSession();
    const approveConsent = vi.fn();
    registerOAuthService({ approveConsent });

    const response = await createApp().request('/api/oauth/consent/request-1/approve', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=impersonation-session',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-token',
      },
      body: JSON.stringify({ scopes: ['nodes:details'] }),
    });
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(403);
    expect(body.code).toBe('IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN');
    expect(approveConsent).not.toHaveBeenCalled();
  });
});
