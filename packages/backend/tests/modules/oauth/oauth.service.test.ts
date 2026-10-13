import { createHash } from 'node:crypto';
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { oauthAccessTokens, oauthAuthorizationCodes, oauthClients, oauthRefreshTokens } from '@/db/schema/index.js';
import type { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import type { User } from '@/types.js';
import { isLoopbackRedirectUri, OAuthService } from '@/modules/oauth/oauth.service.js';

vi.mock('@/config/env.js', () => ({
  getEnv: () => ({
    APP_URL: 'https://gateway.example.com',
  }),
}));

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['mcp:use', 'nodes:details', 'nodes:details:node-1'],
  isBlocked: false,
};

function createService(options?: {
  refreshToken?: any;
  refreshTokens?: any[];
  accessToken?: any;
  accessTokens?: any[];
  revokedRefreshRows?: any[];
  groupScopes?: string[];
  authorizationCode?: any;
  pendingConsent?: any;
  oauthExtendedCallbackCompatibility?: boolean;
  client?: any;
  select?: (fields: Record<string, unknown>) => unknown;
}) {
  const cacheSet = vi.fn().mockResolvedValue(undefined);
  const cacheGet = vi.fn().mockResolvedValue(options?.pendingConsent ?? null);
  let pendingConsent = options?.pendingConsent ?? null;
  const cacheTake = vi.fn(async () => {
    const claimed = pendingConsent;
    pendingConsent = null;
    return claimed;
  });
  const cacheDelete = vi.fn().mockResolvedValue(undefined);
  const client = options?.client ?? {
    clientId: 'goc_client',
    clientName: 'Gateway OAuth CLI Test',
    clientUri: null,
    logoUri: null,
    redirectUris: ['http://127.0.0.1:8765/callback'],
  };
  const refreshTokens = options?.refreshTokens ?? [];
  const accessTokens = options?.accessTokens ?? [];
  const updateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const db = {
    query: {
      oauthClients: {
        findFirst: vi.fn().mockResolvedValue(client),
        findMany: vi.fn().mockResolvedValue([client]),
      },
      oauthRefreshTokens: {
        findFirst: vi.fn().mockResolvedValue(options?.refreshToken ?? null),
        findMany: vi.fn().mockResolvedValue(refreshTokens),
      },
      oauthAuthorizationCodes: {
        findFirst: vi.fn().mockResolvedValue(options?.authorizationCode ?? null),
      },
      oauthAccessTokens: {
        findFirst: vi.fn().mockResolvedValue(options?.accessToken?.revokedAt ? null : (options?.accessToken ?? null)),
        findMany: vi.fn().mockResolvedValue(accessTokens),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          isBlocked: USER.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: USER.groupId,
            name: USER.groupName,
            parentId: null,
            scopes: options?.groupScopes ?? USER.scopes,
          },
        ]),
      },
    },
    transaction: vi.fn(async (callback) => callback(db)),
    ...(options?.select ? { select: vi.fn(options.select) } : {}),
    insert: vi.fn((table) => ({
      values: vi.fn((values) => {
        insertCalls.push({ table, values });
        const returning = vi.fn().mockResolvedValue(
          table === oauthClients
            ? [
                {
                  ...values,
                  id: 'client-row-1',
                  createdAt: new Date('2026-04-29T10:00:00Z'),
                },
              ]
            : [{ id: 'refresh-new' }]
        );
        return { returning };
      }),
    })),
    update: vi.fn((table) => ({
      set: vi.fn((values) => ({
        where: vi.fn().mockImplementation(() => {
          updateCalls.push({ table, values });
          if (Array.isArray(values.scopes)) {
            const tokens =
              table === oauthRefreshTokens ? refreshTokens : table === oauthAccessTokens ? accessTokens : [];
            for (const token of tokens) token.scopes = values.scopes;
          }
          return Object.assign(Promise.resolve(), {
            execute: vi.fn().mockResolvedValue(undefined),
            returning: vi
              .fn()
              .mockResolvedValue(
                table === oauthRefreshTokens
                  ? values.replacedByTokenId !== undefined
                    ? [{ id: 'refresh-1' }]
                    : (options?.revokedRefreshRows ?? [])
                  : table === oauthAuthorizationCodes
                    ? [{ id: options?.authorizationCode?.id ?? 'code-1' }]
                    : []
              ),
          });
        }),
      })),
    })),
  };

  const auditLog = vi.fn().mockResolvedValue(undefined);
  const authSettingsService = {
    getConfig: vi.fn().mockResolvedValue({
      oidcAutoCreateUsers: true,
      oidcDefaultGroupId: 'viewer-group',
      oidcRequireVerifiedEmail: false,
      oauthExtendedCallbackCompatibility: options?.oauthExtendedCallbackCompatibility ?? false,
    }),
    getOAuthExtendedCallbackCompatibility: vi
      .fn()
      .mockResolvedValue(options?.oauthExtendedCallbackCompatibility ?? false),
  } as unknown as AuthSettingsService;
  const service = new OAuthService(
    db as any,
    { set: cacheSet, get: cacheGet, take: cacheTake, delete: cacheDelete } as any,
    { log: auditLog } as any,
    authSettingsService
  );
  return { service, cacheSet, cacheGet, cacheTake, cacheDelete, auditLog, db, updateCalls, insertCalls };
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('OAuthService.registerClient', () => {
  it('allows anonymous dynamic registration for loopback callbacks by default', async () => {
    const { service } = createService({ oauthExtendedCallbackCompatibility: false });

    await expect(
      service.registerClient({
        redirect_uris: ['http://127.0.0.1:39231/callback', 'http://localhost:39232/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'Local CLI',
      })
    ).resolves.toMatchObject({
      redirect_uris: ['http://127.0.0.1:39231/callback', 'http://localhost:39232/callback'],
    });
  });

  it('allows IPv6 loopback callback URLs by default', () => {
    expect(isLoopbackRedirectUri('http://[::1]:39231/callback')).toBe(true);
  });

  it('rejects external HTTPS callbacks by default during dynamic registration', async () => {
    const { service } = createService({ oauthExtendedCallbackCompatibility: false });

    await expect(
      service.registerClient({
        redirect_uris: ['https://client.example.com/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'External App',
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REDIRECT_URI',
    });
  });

  it('allows external HTTPS callbacks when extended compatibility is enabled', async () => {
    const { service } = createService({ oauthExtendedCallbackCompatibility: true });

    await expect(
      service.registerClient({
        redirect_uris: ['https://client.example.com/callback'],
        token_endpoint_auth_method: 'none',
        client_name: 'External App',
      })
    ).resolves.toMatchObject({
      redirect_uris: ['https://client.example.com/callback'],
    });
  });

  it('rejects unsafe redirect URI schemes before storing the client', async () => {
    const { service, db } = createService();

    for (const redirectUri of ['javascript:alert(1)', 'file:///tmp/callback', 'http://client.example.com/callback']) {
      await expect(
        service.registerClient({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          client_name: 'Unsafe Client',
        })
      ).rejects.toMatchObject({ code: 'INVALID_REDIRECT_URI' });
    }

    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('OAuthService.createConsentRequest', () => {
  it('blocks existing external callback clients when extended compatibility is disabled', async () => {
    const { service } = createService({
      oauthExtendedCallbackCompatibility: false,
      client: {
        clientId: 'goc_client',
        clientName: 'External App',
        clientUri: null,
        logoUri: null,
        redirectUris: ['https://client.example.com/callback'],
      },
    });

    await expect(
      service.createConsentRequest(USER, {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'https://client.example.com/callback',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        scope: 'nodes:details',
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REDIRECT_URI',
    });
  });

  it('marks pending consent for external callbacks when compatibility is enabled', async () => {
    const { service } = createService({
      oauthExtendedCallbackCompatibility: true,
      client: {
        clientId: 'goc_client',
        clientName: 'External App',
        clientUri: null,
        logoUri: null,
        redirectUris: ['https://client.example.com/callback'],
      },
    });

    await expect(
      service.createConsentRequest(USER, {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'https://client.example.com/callback',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        scope: 'nodes:details',
      })
    ).resolves.toMatchObject({
      redirectUri: 'https://client.example.com/callback',
      redirectUriIsExternal: true,
    });
  });

  it('infers the MCP resource when an OAuth client requests mcp:use without a resource parameter', async () => {
    const { service, cacheSet } = createService();

    const pending = await service.createConsentRequest(USER, {
      response_type: 'code',
      client_id: 'goc_client',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      scope: 'mcp:use nodes:details',
    });

    expect(pending.resource).toBe('https://gateway.example.com/api/mcp');
    expect(pending.requestedScopes).toEqual(['nodes:details']);
    expect(pending.grantableScopes).toEqual(['nodes:details']);
    expect(pending.unavailableScopes).toEqual([]);
    expect(cacheSet).toHaveBeenCalledWith(expect.stringContaining('oauth:consent:'), pending, 600);
  });

  it('grants every delegable scope the user holds to Gateway MCP, including connector operations', async () => {
    const { service } = createService();
    const connectorScopes = [
      'integrations:gitlab:repo:read',
      'integrations:gitlab:repo:write',
      'integrations:github:manage',
      'integrations:git:manage',
      'integrations:ssh:use',
    ];
    const userOnlyScopes = ['admin:users:impersonate', 'integrations:gitlab:sandbox:clone'];

    const pending = await service.createConsentRequest(
      { ...USER, scopes: [...USER.scopes, ...connectorScopes, ...userOnlyScopes] },
      {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: `mcp:use nodes:details admin:system ${[...connectorScopes, ...userOnlyScopes].join(' ')}`,
      }
    );

    expect(pending.grantableScopes).toEqual([...connectorScopes, 'nodes:details'].sort());
    expect(pending.unavailableScopes).toEqual(['admin:system', ...userOnlyScopes].sort());
    expect(pending.manualApprovalScopes).toEqual(['integrations:gitlab:repo:write', 'integrations:ssh:use']);
  });

  it('rewrites retired scope names from older clients before computing the grant', async () => {
    const { service } = createService();

    const pending = await service.createConsentRequest(
      {
        ...USER,
        scopes: [...USER.scopes, 'nodes:manage', 'notifications:alerts:view', 'notifications:webhooks:view'],
      },
      {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: 'nodes:config:edit:node-1 notifications:view ssl:cert:revoke',
      }
    );

    expect(pending.requestedScopes).toEqual([
      'nodes:manage:node-1',
      'notifications:alerts:view',
      'notifications:webhooks:view',
    ]);
    expect(pending.grantableScopes).toEqual(pending.requestedScopes);
    expect(pending.manualApprovalScopes).toEqual(['nodes:manage:node-1']);
  });

  it('rejects requests whose scopes were all removed from the catalog', async () => {
    const { service } = createService();

    await expect(
      service.createConsentRequest(USER, {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: 'ssl:cert:revoke ssl:cert:export',
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCOPE' });
  });

  it('rejects restrictions a scope cannot resolve', async () => {
    const { service } = createService();

    await expect(
      service.createConsentRequest(USER, {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: 'nodes:details:folder/not-a-uuid',
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCOPE' });
  });

  it('rejects MCP OAuth requests when the user cannot use MCP', async () => {
    const { service } = createService();

    await expect(
      service.createConsentRequest(
        { ...USER, scopes: ['nodes:details'] },
        {
          response_type: 'code',
          client_id: 'goc_client',
          redirect_uri: 'http://127.0.0.1:8765/callback',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          scope: 'mcp:use nodes:details',
        }
      )
    ).rejects.toThrow('Your account is not allowed to use MCP');
  });

  it('rejects the removed inference companion setup resource and its scope', async () => {
    const { service } = createService();
    const request = {
      response_type: 'code' as const,
      client_id: 'goc_client',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      code_challenge: 'challenge',
      code_challenge_method: 'S256' as const,
    };

    await expect(
      service.createConsentRequest(
        { ...USER, scopes: ['feat:ai:use', 'nodes:details'] },
        { ...request, scope: 'nodes:details', resource: 'https://gateway.example.com/api/inference/setup' }
      )
    ).rejects.toThrow('OAuth authorization is not available for this resource');
    await expect(
      service.createConsentRequest(
        { ...USER, scopes: ['feat:ai:use'] },
        { ...request, scope: 'inference:setup', resource: 'https://gateway.example.com/api' }
      )
    ).rejects.toThrow('Scopes are not recognized: inference:setup');
  });

  it('marks high-risk OAuth scopes for manual approval', async () => {
    const { service } = createService();

    const pending = await service.createConsentRequest(
      {
        ...USER,
        scopes: [
          ...USER.scopes,
          'docker:containers:environment',
          'docker:containers:files:read',
          'docker:containers:files:write',
          'docker:containers:secrets',
          'pki:cert:export',
          'admin:update',
        ],
      },
      {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope:
          'nodes:details docker:containers:environment docker:containers:files:read:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f docker:containers:files:write:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f docker:containers:secrets pki:cert:export admin:update',
      }
    );

    expect(pending.grantableScopes).toEqual([
      'admin:update',
      'docker:containers:environment',
      'docker:containers:files:read:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      'docker:containers:files:write:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      'docker:containers:secrets',
      'nodes:details',
      'pki:cert:export',
    ]);
    expect(pending.manualApprovalScopes).toEqual([
      'admin:update',
      'docker:containers:files:read:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      'docker:containers:files:write:9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      'docker:containers:secrets',
      'pki:cert:export',
    ]);
  });
});

describe('OAuthService.getConsentRequest', () => {
  it('blocks cached external callback consent after compatibility is disabled', async () => {
    const { service } = createService({
      oauthExtendedCallbackCompatibility: false,
      pendingConsent: {
        id: 'request-1',
        userId: USER.id,
        clientId: 'goc_client',
        clientName: 'External App',
        clientUri: null,
        logoUri: null,
        redirectUri: 'https://client.example.com/callback',
        redirectUriIsExternal: true,
        requestedScopes: ['nodes:details'],
        grantableScopes: ['nodes:details'],
        unavailableScopes: [],
        manualApprovalScopes: [],
        codeChallenge: 'challenge',
        resource: 'https://gateway.example.com/api',
        expiresAt: Date.now() + 60_000,
      },
    });

    await expect(service.getConsentRequest('request-1', USER)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REDIRECT_URI',
    });
  });
});

describe('OAuthService.approveConsent', () => {
  function pendingConsent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'request-1',
      userId: USER.id,
      clientId: 'goc_client',
      clientName: 'Gateway OAuth CLI Test',
      clientUri: null,
      logoUri: null,
      redirectUri: 'http://127.0.0.1:8765/callback',
      requestedScopes: ['nodes:details', 'docker:containers:secrets'],
      grantableScopes: ['docker:containers:secrets', 'nodes:details'],
      unavailableScopes: [],
      manualApprovalScopes: ['docker:containers:secrets'],
      codeChallenge: 'challenge',
      resource: 'https://gateway.example.com/api',
      expiresAt: Date.now() + 60_000,
      ...overrides,
    };
  }

  it('defaults omitted approval scopes to non-dangerous grantable scopes', async () => {
    const { service, insertCalls } = createService({
      pendingConsent: pendingConsent(),
    });

    await service.approveConsent(
      'request-1',
      { ...USER, scopes: [...USER.scopes, 'docker:containers:secrets'] },
      undefined
    );

    const authorizationCodeInsert = insertCalls.find((call) => call.table === oauthAuthorizationCodes);
    expect(authorizationCodeInsert?.values.scopes).toEqual(['nodes:details']);
  });

  it('rejects an explicit empty approval scope list', async () => {
    const { service, db } = createService({
      pendingConsent: pendingConsent(),
    });

    await expect(
      service.approveConsent('request-1', { ...USER, scopes: [...USER.scopes, 'docker:containers:secrets'] }, [])
    ).rejects.toThrow('At least one scope must be selected');

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('accepts a folder-restricted selection of a broad grantable scope', async () => {
    const folderScope = 'docker:containers:manage:folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const { service, insertCalls } = createService({
      pendingConsent: pendingConsent({
        requestedScopes: ['docker:containers:manage', 'nodes:details'],
        grantableScopes: ['docker:containers:manage', 'nodes:details'],
        manualApprovalScopes: [],
      }),
    });

    await service.approveConsent('request-1', { ...USER, scopes: [...USER.scopes, 'docker:containers:manage'] }, [
      folderScope,
      'nodes:details:node-1',
    ]);

    const authorizationCodeInsert = insertCalls.find((call) => call.table === oauthAuthorizationCodes);
    expect(authorizationCodeInsert?.values.scopes).toEqual([folderScope, 'nodes:details:node-1']);
  });

  it('rejects a folder restriction of a scope the user cannot grant', async () => {
    const { service, db } = createService({ pendingConsent: pendingConsent() });

    await expect(
      service.approveConsent('request-1', USER, [
        'docker:containers:manage:folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e',
      ])
    ).rejects.toMatchObject({ statusCode: 403, code: 'SCOPE_NOT_ALLOWED' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('mints at most one authorization code from concurrent approvals', async () => {
    const { service, db, cacheTake } = createService({
      pendingConsent: pendingConsent(),
    });
    const user = { ...USER, scopes: [...USER.scopes, 'docker:containers:secrets'] };

    const results = await Promise.allSettled([
      service.approveConsent('request-1', user),
      service.approveConsent('request-1', user),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(cacheTake).toHaveBeenCalledTimes(2);
  });
});

describe('OAuthService.updateUserAuthorizationScopes', () => {
  it('updates MCP access-only authorizations bounded by the current user scopes', async () => {
    const accessToken = {
      id: 'token-1',

      clientId: 'goc_client',
      userId: USER.id,
      scopes: ['nodes:details'],
      resource: 'https://gateway.example.com/api/mcp',
      expiresAt: null,
      createdAt: new Date('2026-04-29T10:00:00Z'),
      revokedAt: null,
    };
    const { service, auditLog, updateCalls } = createService({
      accessTokens: [accessToken],
    });

    const authorization = await service.updateUserAuthorizationScopes(
      { ...USER, scopes: ['mcp:use', 'nodes:details', 'nodes:details:node-1'] },
      'token-1',
      ['nodes:details']
    );

    expect(updateCalls.some((call) => call.table === oauthAccessTokens)).toBe(true);
    expect(accessToken.scopes).toEqual(['nodes:details']);
    expect(authorization?.scopes).toEqual(['nodes:details']);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'oauth.authorization_update',
        resourceId: 'goc_client',
      })
    );
  });

  it('rejects MCP authorization updates when the user can no longer use MCP', async () => {
    const { service } = createService({
      refreshTokens: [
        {
          id: 'token-2',

          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details'],
          resource: 'https://gateway.example.com/api/mcp',
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date('2026-04-29T10:00:00Z'),
          revokedAt: null,
        },
      ],
    });

    await expect(
      service.updateUserAuthorizationScopes(
        { ...USER, scopes: ['nodes:details'] },
        'token-2',
        ['nodes:details']
      )
    ).rejects.toThrow('Your account is not allowed to use MCP');
  });
});

describe('OAuthService.listUserAuthorizations', () => {
  it('returns separate rows for the same client on different resources', async () => {
    const { service } = createService({
      refreshTokens: [
        {
          id: 'token-3',

          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details'],
          resource: 'https://gateway.example.com/api',
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date('2026-04-29T10:00:00Z'),
          revokedAt: null,
        },
        {
          id: 'token-4',

          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details'],
          resource: 'https://gateway.example.com/api/mcp',
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date('2026-04-29T11:00:00Z'),
          revokedAt: null,
        },
      ],
      accessTokens: [
        {
          id: 'token-5',
          refreshTokenId: 'token-4',

          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details'],
          resource: 'https://gateway.example.com/api/mcp',
          expiresAt: null,
          createdAt: new Date('2026-04-29T11:00:00Z'),
          revokedAt: null,
          lastUsedAt: new Date('2026-04-29T11:30:00Z'),
        },
      ],
    });

    const authorizations = await service.listUserAuthorizations(USER.id);

    expect(authorizations).toHaveLength(2);
    expect(authorizations.map((authorization) => authorization.resource).sort()).toEqual([
      'https://gateway.example.com/api',
      'https://gateway.example.com/api/mcp',
    ]);
  });

  it('lists each consent of the same client as its own authorization with its own scopes', async () => {
    const { service } = createService({
      accessTokens: [
        {
          id: 'consent-old',
          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details', 'docker:containers:secrets'],
          resource: 'https://gateway.example.com/api/mcp',
          expiresAt: null,
          createdAt: new Date('2026-10-02T10:00:00Z'),
          revokedAt: null,
        },
        {
          id: 'consent-new',
          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details'],
          resource: 'https://gateway.example.com/api/mcp',
          expiresAt: null,
          createdAt: new Date('2026-10-12T07:00:00Z'),
          revokedAt: null,
        },
      ],
      groupScopes: ['nodes:details', 'docker:containers:secrets', 'mcp:use'],
    });

    const authorizations = await service.listUserAuthorizations(USER.id);

    expect(authorizations.map((authorization) => [authorization.id, authorization.scopes]).sort()).toEqual([
      ['consent-new', ['nodes:details']],
      ['consent-old', ['docker:containers:secrets', 'nodes:details']],
    ]);
  });

  it('bounds listed authorization scopes by the owner current scopes', async () => {
    const { service } = createService({
      groupScopes: ['nodes:details:node-1'],
      refreshTokens: [
        {
          id: 'token-6',

          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details', 'nodes:details'],
          resource: 'https://gateway.example.com/api',
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date('2026-04-29T10:00:00Z'),
          revokedAt: null,
        },
      ],
    });

    const [authorization] = await service.listUserAuthorizations(USER.id);

    expect(authorization.scopes).toEqual(['nodes:details:node-1']);
  });

  it('keeps MCP access-only authorizations visible with no expiry', async () => {
    const { service } = createService({
      accessTokens: [
        {
          id: 'token-7',

          clientId: 'goc_client',
          userId: USER.id,
          scopes: ['nodes:details'],
          resource: 'https://gateway.example.com/api/mcp',
          expiresAt: null,
          createdAt: new Date('2026-04-29T10:00:00Z'),
          revokedAt: null,
          lastUsedAt: new Date('2026-04-29T11:00:00Z'),
        },
      ],
    });

    const [authorization] = await service.listUserAuthorizations(USER.id);

    expect(authorization.resource).toBe('https://gateway.example.com/api/mcp');
    expect(authorization.activeAccessTokens).toBe(1);
    expect(authorization.activeRefreshTokens).toBe(0);
    expect(authorization.expiresAt).toBeNull();
  });
});

describe('OAuthService.exchangeToken authorization code flow', () => {
  it('exchanges an authorization code when the PKCE verifier matches the stored S256 challenge', async () => {
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const { service, insertCalls, updateCalls } = createService({
      authorizationCode: {
        id: 'code-1',
        clientId: 'goc_client',
        userId: USER.id,
        redirectUri: 'http://127.0.0.1:8765/callback',
        codeChallenge: s256(verifier),
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await service.exchangeToken({
      grant_type: 'authorization_code',
      client_id: 'goc_client',
      code: 'gwo_code',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      code_verifier: verifier,
    });

    expect(result.token_type).toBe('Bearer');
    expect(result.scope).toBe('nodes:details');
    expect(result.expires_in).toBe(900);
    expect(result.refresh_token).toMatch(/^opfr_/);
    expect(updateCalls.some((call) => call.table === oauthAuthorizationCodes)).toBe(true);
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: oauthRefreshTokens,
          values: expect.objectContaining({
            resource: 'https://gateway.example.com/api',
            expiresAt: expect.any(Date),
          }),
        }),
        expect.objectContaining({
          table: oauthAccessTokens,
          values: expect.objectContaining({
            resource: 'https://gateway.example.com/api',
            refreshTokenId: 'refresh-new',
            expiresAt: expect.any(Date),
          }),
        }),
      ])
    );
  });

  it('issues an MCP access token without refresh metadata', async () => {
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const { service, insertCalls } = createService({
      authorizationCode: {
        id: 'code-1',
        clientId: 'goc_client',
        userId: USER.id,
        redirectUri: 'http://127.0.0.1:8765/callback',
        codeChallenge: s256(verifier),
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api/mcp',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await service.exchangeToken({
      grant_type: 'authorization_code',
      client_id: 'goc_client',
      code: 'gwo_code',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      code_verifier: verifier,
    });

    expect(result.token_type).toBe('Bearer');
    expect(result.scope).toBe('nodes:details');
    expect(result.expires_in).toBeUndefined();
    expect(result.refresh_token).toBeUndefined();
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toEqual(
      expect.objectContaining({
        table: oauthAccessTokens,
        values: expect.objectContaining({
          resource: 'https://gateway.example.com/api/mcp',
          refreshTokenId: null,
          expiresAt: null,
        }),
      })
    );
  });

  it('rejects an authorization code when the PKCE verifier does not match the stored S256 challenge', async () => {
    const { service, updateCalls } = createService({
      authorizationCode: {
        id: 'code-1',
        clientId: 'goc_client',
        userId: USER.id,
        redirectUri: 'http://127.0.0.1:8765/callback',
        codeChallenge: 'stored-challenge',
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      service.exchangeToken({
        grant_type: 'authorization_code',
        client_id: 'goc_client',
        code: 'gwo_code',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      })
    ).rejects.toThrow('Invalid PKCE verifier');

    expect(updateCalls).toEqual([]);
  });
});

describe('OAuthService.validateAccessToken', () => {
  it('expands a folder-restricted grant to the resources currently in the folder', async () => {
    const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const { service } = createService({
      groupScopes: ['proxy:view'],
      accessToken: {
        id: 'access-folder',
        tokenHash: 'hash',
        tokenPrefix: 'gwo_folder1',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: [`proxy:view:folder/${folderId}`],
        resource: 'https://gateway.example.com/api',
        refreshTokenId: null,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      select: (fields) => ({
        from: () =>
          'parentId' in fields
            ? Promise.resolve([{ id: folderId, parentId: null }])
            : { where: async () => [{ id: 'host-1', folderId }] },
      }),
    });

    const validated = await service.validateAccessToken('gwo_folder', { resource: 'https://gateway.example.com/api' });

    expect(validated?.scopes).toEqual([`proxy:view:folder/${folderId}`, 'proxy:view:host-1']);
    expect(validated?.scopes).not.toContain('proxy:view');
  });

  it('never lets a destination-only creation grant reach existing resources through OAuth', async () => {
    // Reviewer repro: the owner can only create containers on n1.
    const { service } = createService({
      groupScopes: ['mcp:use', 'docker:containers:create:node/n1'],
      accessToken: {
        id: 'access-creator',
        tokenHash: 'hash',
        tokenPrefix: 'gwo_create1',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: ['docker:containers:view', 'docker:containers:view:node/n1'],
        resource: 'https://gateway.example.com/api/mcp',
        refreshTokenId: null,
        expiresAt: null,
        revokedAt: null,
      },
    });

    await expect(
      service.validateAccessToken('gwo_creator', { resource: 'https://gateway.example.com/api/mcp' })
    ).resolves.toBeNull();

    const pending = await service.createConsentRequest(
      { ...USER, scopes: ['mcp:use', 'docker:containers:create:node/n1'] },
      {
        response_type: 'code',
        client_id: 'goc_client',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        scope: 'mcp:use docker:containers:view',
      }
    );
    expect(pending.grantableScopes).toEqual([]);
  });

  it('accepts long-lived MCP access-only tokens without refresh metadata', async () => {
    const { service } = createService({
      accessToken: {
        id: 'access-1',
        tokenHash: 'hash',
        tokenPrefix: 'gwo_valid123',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api/mcp',
        refreshTokenId: null,
        expiresAt: null,
        revokedAt: null,
      },
    });

    await expect(
      service.validateAccessToken('gwo_valid', { resource: 'https://gateway.example.com/api/mcp' })
    ).resolves.toMatchObject({
      tokenId: 'access-1',
      tokenPrefix: 'gwo_valid123',
      clientId: 'goc_client',
      scopes: ['nodes:details'],
    });
  });

  it('does not accept a revoked MCP access token', async () => {
    const { service } = createService({
      accessToken: {
        id: 'access-1',
        tokenHash: 'hash',
        tokenPrefix: 'gwo_valid123',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api/mcp',
        refreshTokenId: null,
        expiresAt: null,
        revokedAt: new Date('2026-04-29T10:00:00Z'),
      },
    });

    await expect(
      service.validateAccessToken('gwo_valid', { resource: 'https://gateway.example.com/api/mcp' })
    ).resolves.toBeNull();
  });
});

describe('OAuthService.revokeToken', () => {
  it('rotates a valid refresh token by revoking and linking the old token to the new token', async () => {
    const { service, updateCalls, insertCalls, auditLog } = createService({
      refreshToken: {
        id: 'refresh-1',
        tokenHash: 'hash',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api',
        revokedAt: null,
        replacedByTokenId: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      revokedRefreshRows: [{ id: 'refresh-1', clientId: 'goc_client', userId: USER.id, resource: null }],
    });

    const result = await service.exchangeToken({
      grant_type: 'refresh_token',
      client_id: 'goc_client',
      refresh_token: 'gwr_valid',
    });

    expect(result.token_type).toBe('Bearer');
    expect(result.refresh_token).toMatch(/^opfr_/);
    expect(insertCalls).toHaveLength(2);
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: oauthRefreshTokens,
          values: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
        expect.objectContaining({
          table: oauthRefreshTokens,
          values: { replacedByTokenId: 'refresh-new' },
        }),
      ])
    );
    expect(auditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'oauth.token_refresh',
        resourceId: 'goc_client',
      })
    );
  });

  it('converts a legacy MCP refresh token into a long-lived access token', async () => {
    const { service, insertCalls, updateCalls } = createService({
      refreshToken: {
        id: 'refresh-1',
        tokenHash: 'hash',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api/mcp',
        revokedAt: null,
        replacedByTokenId: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      revokedRefreshRows: [{ id: 'refresh-1', clientId: 'goc_client', userId: USER.id, resource: null }],
    });

    const result = await service.exchangeToken({
      grant_type: 'refresh_token',
      client_id: 'goc_client',
      refresh_token: 'gwr_mcp',
    });

    expect(result.token_type).toBe('Bearer');
    expect(result.scope).toBe('nodes:details');
    expect(result.expires_in).toBeUndefined();
    expect(result.refresh_token).toBeUndefined();
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toEqual(
      expect.objectContaining({
        table: oauthAccessTokens,
        values: expect.objectContaining({
          resource: 'https://gateway.example.com/api/mcp',
          refreshTokenId: null,
          expiresAt: null,
        }),
      })
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: oauthRefreshTokens,
          values: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
        expect.objectContaining({
          table: oauthRefreshTokens,
          values: { replacedByTokenId: null },
        }),
      ])
    );
  });

  it('revokes a long-lived MCP access token directly', async () => {
    const { service, updateCalls } = createService();

    await service.revokeToken('gwo_mcp_access_token', 'goc_client');

    const accessRevocations = updateCalls.filter((call) => call.table === oauthAccessTokens);
    expect(accessRevocations).toEqual([
      expect.objectContaining({
        values: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    ]);
  });

  it('revokes access tokens issued from a revoked refresh token', async () => {
    const { service, updateCalls } = createService({
      revokedRefreshRows: [{ id: 'refresh-1', clientId: 'goc_client', userId: USER.id, resource: null }],
    });

    await service.revokeToken('gwr_refresh_token', 'goc_client');

    const accessRevocations = updateCalls.filter((call) => call.table === oauthAccessTokens);
    expect(updateCalls.some((call) => call.table === oauthRefreshTokens)).toBe(true);
    expect(accessRevocations).toHaveLength(2);
    expect(accessRevocations.every((call) => call.values.revokedAt instanceof Date)).toBe(true);
  });

  it('revokes the refresh token family when a rotated refresh token is replayed', async () => {
    const { service, updateCalls } = createService({
      refreshToken: {
        id: 'refresh-1',
        tokenHash: 'hash',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api',
        revokedAt: new Date('2026-04-29T10:00:00Z'),
        replacedByTokenId: 'refresh-2',
        expiresAt: new Date(Date.now() + 60_000),
      },
      refreshTokens: [
        {
          id: 'refresh-1',
          clientId: 'goc_client',
          userId: USER.id,
          resource: 'https://gateway.example.com/api',
          replacedByTokenId: 'refresh-2',
        },
        {
          id: 'refresh-2',
          clientId: 'goc_client',
          userId: USER.id,
          resource: 'https://gateway.example.com/api',
          replacedByTokenId: null,
        },
      ],
    });

    await expect(
      service.exchangeToken({
        grant_type: 'refresh_token',
        client_id: 'goc_client',
        refresh_token: 'gwr_replayed',
      })
    ).rejects.toThrow('Invalid refresh token');

    const refreshRevocations = updateCalls.filter((call) => call.table === oauthRefreshTokens);
    const accessRevocations = updateCalls.filter((call) => call.table === oauthAccessTokens);
    expect(refreshRevocations.some((call) => call.values.revokedAt instanceof Date)).toBe(true);
    expect(accessRevocations.some((call) => call.values.revokedAt instanceof Date)).toBe(true);
  });

  it('revokes the refresh token family when concurrent refresh rotation loses the update race', async () => {
    const { service, updateCalls } = createService({
      refreshToken: {
        id: 'refresh-1',
        tokenHash: 'hash',
        clientId: 'goc_client',
        userId: USER.id,
        scopes: ['nodes:details'],
        resource: 'https://gateway.example.com/api',
        revokedAt: null,
        replacedByTokenId: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      refreshTokens: [
        {
          id: 'refresh-1',
          clientId: 'goc_client',
          userId: USER.id,
          resource: 'https://gateway.example.com/api',
          replacedByTokenId: 'refresh-2',
        },
        {
          id: 'refresh-2',
          clientId: 'goc_client',
          userId: USER.id,
          resource: 'https://gateway.example.com/api',
          replacedByTokenId: null,
        },
      ],
    });

    await expect(
      service.exchangeToken({
        grant_type: 'refresh_token',
        client_id: 'goc_client',
        refresh_token: 'gwr_racing',
      })
    ).rejects.toThrow('Refresh token already used');

    const refreshRevocations = updateCalls.filter((call) => call.table === oauthRefreshTokens);
    const accessRevocations = updateCalls.filter((call) => call.table === oauthAccessTokens);
    expect(refreshRevocations.some((call) => call.values.revokedAt instanceof Date)).toBe(true);
    expect(accessRevocations.some((call) => call.values.revokedAt instanceof Date)).toBe(true);
  });
});
