import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { principalHasGitRepositoryScope } from '@/lib/git-scopes.js';
import { hasScope } from '@/lib/permissions.js';
import { runWithAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { resolveRequestedTokenScopes, TokensService } from './tokens.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_HASH = 'token-hash';

function createDb({
  userGroupId,
  tokenScopes,
  groups,
}: {
  userGroupId: string;
  tokenScopes: string[];
  groups: Array<{ id: string; name: string; parentId: string | null; scopes: string[] }>;
}) {
  const updateExecute = vi.fn().mockResolvedValue(undefined);

  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: updateExecute,
        }),
      }),
    }),
    query: {
      apiTokens: {
        findFirst: vi.fn().mockResolvedValue({
          id: '22222222-2222-4222-8222-222222222222',
          userId: USER_ID,
          tokenHash: TOKEN_HASH,
          scopes: tokenScopes,
        }),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER_ID,
          oidcSubject: 'oidc-user',
          email: 'admin@example.com',
          name: 'Admin',
          avatarUrl: null,
          groupId: userGroupId,
          isBlocked: false,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue(groups),
      },
    },
  };
}

function createService(db: any) {
  return new TokensService(db, { log: vi.fn().mockResolvedValue(undefined) } as any);
}

describe('TokensService.validateToken limits', () => {
  function limitedDb(limits: { expiresAt?: Date | null; allowedIps?: string[] }) {
    const db = createDb({
      userGroupId: 'viewer-group',
      tokenScopes: ['nodes:details'],
      groups: [{ id: 'viewer-group', name: 'viewer', parentId: null, scopes: ['nodes:details'] }],
    });
    db.query.apiTokens.findFirst.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      scopes: ['nodes:details'],
      expiresAt: null,
      allowedIps: [],
      ...limits,
    });
    return db;
  }

  it('refuses an expired token like a revoked one and does not mark it used', async () => {
    const db = limitedDb({ expiresAt: new Date(Date.now() - 1000) });
    await expect(createService(db).validateToken('gw_test_token')).resolves.toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('accepts a token before its expiry', async () => {
    const db = limitedDb({ expiresAt: new Date(Date.now() + 60_000) });
    await expect(createService(db).validateToken('gw_test_token')).resolves.not.toBeNull();
  });

  it('accepts a limited token only from an allowed address or range', async () => {
    const db = limitedDb({ allowedIps: ['203.0.113.10', '10.20.0.0/16', '2001:db8::/32'] });
    const service = createService(db);
    await expect(service.validateToken('gw_test_token', { clientIp: '203.0.113.10' })).resolves.not.toBeNull();
    await expect(service.validateToken('gw_test_token', { clientIp: '10.20.4.17' })).resolves.not.toBeNull();
    await expect(service.validateToken('gw_test_token', { clientIp: '2001:db8:40::1' })).resolves.not.toBeNull();
    await expect(service.validateToken('gw_test_token', { clientIp: '198.51.100.7' })).resolves.toBeNull();
    // An unknown client address never passes a list.
    await expect(service.validateToken('gw_test_token')).resolves.toBeNull();
  });

  it('accepts a token without a list from any address', async () => {
    const db = limitedDb({});
    await expect(
      createService(db).validateToken('gw_test_token', { clientIp: '198.51.100.7' })
    ).resolves.not.toBeNull();
    await expect(createService(db).validateToken('gw_test_token')).resolves.not.toBeNull();
  });
});

describe('TokensService.validateToken', () => {
  it('keeps a project-limited Git scope inside the owner group grant and checks both at request time', async () => {
    const connector = '33333333-3333-4333-8333-333333333333';
    const db = createDb({
      userGroupId: 'developers',
      tokenScopes: [
        `integrations:gitlab:repo:read:${connector}/project/42`,
        `integrations:gitlab:repo:read:${connector}/project/43`,
      ],
      groups: [
        {
          id: 'developers',
          name: 'developers',
          parentId: null,
          scopes: [`integrations:gitlab:repo:read:${connector}/group/7`],
        },
      ],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.user.accountScopes).toEqual([`integrations:gitlab:repo:read:${connector}/group/7`]);
    const caller = { scopes: result?.scopes ?? [], accountScopes: result?.user.accountScopes };
    // Project 42 lies in group 7, project 43 in group 8.
    expect(
      principalHasGitRepositoryScope(caller, 'integrations:gitlab:repo:read', {
        connectorId: connector,
        repositoryId: '42',
        containerIds: ['7'],
      })
    ).toBe(true);
    expect(
      principalHasGitRepositoryScope(caller, 'integrations:gitlab:repo:read', {
        connectorId: connector,
        repositoryId: '43',
        containerIds: ['8'],
      })
    ).toBe(false);
  });

  it('never lets a destination-only creation grant reach existing resources through a token', async () => {
    // Reviewer repro: the owner can create containers on n1 but cannot view the ones already there.
    const db = createDb({
      userGroupId: 'creator-group',
      tokenScopes: ['docker:containers:view', 'docker:containers:view:node/n1'],
      groups: [{ id: 'creator-group', name: 'creators', parentId: null, scopes: ['docker:containers:create:node/n1'] }],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual([]);
    expect(hasScope(result?.scopes ?? [], 'docker:containers:view:n1/c1')).toBe(false);
  });

  it('never lets a folder creation grant reach the folder contents through a token', async () => {
    const folder = 'folder/0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const db = {
      ...createDb({
        userGroupId: 'creator-group',
        tokenScopes: ['proxy:view', `proxy:view:${folder}`],
        groups: [{ id: 'creator-group', name: 'creators', parentId: null, scopes: [`proxy:create:${folder}`] }],
      }),
      // Folder expansion: the folder holds route host-1.
      select: vi.fn((fields: Record<string, unknown>) => ({
        from: () =>
          'parentId' in fields
            ? Promise.resolve([{ id: folder.slice('folder/'.length), parentId: null }])
            : { where: async () => [{ id: 'host-1', folderId: folder.slice('folder/'.length) }] },
      })),
    };

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual([]);
    expect(hasScope(result?.scopes ?? [], 'proxy:view:host-1')).toBe(false);
  });

  it('keeps a token folder grant bounded by an owner who can view that folder', async () => {
    const folderId = '0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e';
    const db = {
      ...createDb({
        userGroupId: 'viewer-group',
        tokenScopes: [`proxy:view:folder/${folderId}`],
        groups: [{ id: 'viewer-group', name: 'viewers', parentId: null, scopes: ['proxy:view'] }],
      }),
      select: vi.fn((fields: Record<string, unknown>) => ({
        from: () =>
          'parentId' in fields
            ? Promise.resolve([{ id: folderId, parentId: null }])
            : { where: async () => [{ id: 'host-1', folderId }] },
      })),
    };

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual([`proxy:view:folder/${folderId}`, 'proxy:view:host-1']);
  });

  it('bounds token scopes by the token owner current group after demotion', async () => {
    const db = createDb({
      userGroupId: 'viewer-group',
      tokenScopes: ['admin:users', 'nodes:details'],
      groups: [
        { id: 'admin-group', name: 'admin', parentId: null, scopes: ['admin:users', 'nodes:details'] },
        { id: 'viewer-group', name: 'viewer', parentId: null, scopes: ['nodes:details'] },
      ],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.user.groupName).toBe('viewer');
    expect(result?.user.scopes).toEqual(['nodes:details']);
    expect(result?.scopes).toEqual(['nodes:details']);
  });

  it('allows only the currently granted resource when a broad token owner is narrowed', async () => {
    const db = createDb({
      userGroupId: 'limited-group',
      tokenScopes: ['nodes:details'],
      groups: [{ id: 'limited-group', name: 'limited', parentId: null, scopes: ['nodes:details:node-1'] }],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual(['nodes:details:node-1']);
  });

  it('uses inherited current group scopes when bounding a token', async () => {
    const db = createDb({
      userGroupId: 'child-group',
      tokenScopes: ['status-page:manage', 'admin:users'],
      groups: [
        { id: 'parent-group', name: 'parent', parentId: null, scopes: ['status-page:manage'] },
        { id: 'child-group', name: 'child', parentId: 'parent-group', scopes: ['nodes:details'] },
      ],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.user.scopes).toEqual(['nodes:details', 'status-page:manage']);
    expect(result?.scopes).toEqual(['status-page:manage']);
  });

  it('filters user-only AI scopes from existing tokens but keeps delegable inference access', async () => {
    const db = createDb({
      userGroupId: 'admin-group',
      tokenScopes: ['feat:ai:use', 'feat:ai:configure', 'ai:workspace:use', 'nodes:details'],
      groups: [
        {
          id: 'admin-group',
          name: 'admin',
          parentId: null,
          scopes: ['feat:ai:use', 'feat:ai:configure', 'ai:workspace:use', 'nodes:details'],
        },
      ],
    });

    const result = await createService(db).validateToken('gw_test_token');

    expect(result?.scopes).toEqual(['feat:ai:use', 'nodes:details']);
  });
});

describe('TokensService.updateToken', () => {
  it('stores canonical API token scopes', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const db = {
      update: vi.fn().mockReturnValue({ set }),
      query: {
        apiTokens: {
          findFirst: vi.fn().mockResolvedValue({
            id: '22222222-2222-4222-8222-222222222222',
            userId: USER_ID,
            name: 'CI',
            scopes: ['nodes:details'],
          }),
        },
      },
    };

    await createService(db).updateToken(USER_ID, '22222222-2222-4222-8222-222222222222', {
      scopes: ['proxy:view:host-1', 'proxy:view'],
    });

    expect(set).toHaveBeenCalledWith({ scopes: ['proxy:view'] });
  });
});

describe('TokensService impersonation guard', () => {
  it('refuses to mint or widen API tokens inside an impersonated request', async () => {
    const db = { insert: vi.fn(), update: vi.fn(), query: { apiTokens: { findFirst: vi.fn() } } };
    const service = createService(db);
    const impersonation = {
      actorUserId: 'actor-1',
      subjectUserId: USER_ID,
      subjectEmail: 'subject@example.com',
      subjectName: 'Subject',
    };

    await runWithAuditRequestContext({ impersonation }, async () => {
      await expect(service.createToken(USER_ID, { name: 'CI', scopes: ['nodes:details'] })).rejects.toMatchObject({
        statusCode: 403,
        code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN',
      });
      await expect(
        service.updateToken(USER_ID, '22222222-2222-4222-8222-222222222222', { scopes: ['nodes:details'] })
      ).rejects.toMatchObject({ code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN' });
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('resolveRequestedTokenScopes', () => {
  it('rejects a list that only held removed scopes', () => {
    expect(() => resolveRequestedTokenScopes(['ssl:cert:revoke'], ['ssl:cert:view'], 'create')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'INVALID_SCOPE' })
    );
  });

  it('adds the migration 0200 grants a new token owner can delegate, and only on creation', () => {
    const owner = [
      'integrations:github:manage',
      'integrations:github:repo:read',
      'integrations:github:repo:write',
      'docker:volumes:create',
      'pki:ca:create:root',
      'pki:ca:edit',
      'pki:ca:export',
    ];
    // Repository writes need manual approval, so they are never added implicitly.
    expect(resolveRequestedTokenScopes(['integrations:github:manage'], owner, 'create')).toEqual([
      'integrations:github:manage',
      'integrations:github:repo:read',
    ]);
    // Neither is CA key export.
    expect(resolveRequestedTokenScopes(['pki:ca:create:root'], owner, 'create')).toEqual([
      'pki:ca:create:root',
      'pki:ca:edit',
    ]);
    // docker:volumes:edit is not held by the owner, so it is not added.
    expect(resolveRequestedTokenScopes(['docker:volumes:create'], owner, 'create')).toEqual(['docker:volumes:create']);
    expect(resolveRequestedTokenScopes(['integrations:github:manage'], owner, 'update')).toEqual([
      'integrations:github:manage',
    ]);
  });

  it('adds nothing to a new token that asks for exactly its scopes', () => {
    const owner = ['integrations:github:view', 'integrations:github:use', 'integrations:github:repo:read'];
    const use = ['integrations:github:use', 'integrations:github:view'];
    expect(resolveRequestedTokenScopes(use, owner, 'create', { exact: true })).toEqual(use);
    expect(resolveRequestedTokenScopes(use, owner, 'create')).toEqual(['integrations:github:repo:read', ...use]);
  });
});

describe('TokensService registry access', () => {
  const TOKEN_ID = '22222222-2222-4222-8222-222222222222';

  it('stores the legacy registry scopes of a new token as its registry access', async () => {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: TOKEN_ID,
          name: 'CI',
          tokenPrefix: 'gw_0123456',
          scopes: ['nodes:details'],
          registryAccess: { pull: ['team/app'] },
          lastUsedAt: null,
          createdAt: new Date('2026-10-07T00:00:00.000Z'),
        },
      ]),
    });
    const db = { insert: vi.fn().mockReturnValue({ values }) };

    const result = await createService(db).createToken(USER_ID, {
      name: 'CI',
      scopes: ['nodes:details', 'docker:registries:internal:pull:team/app'],
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['nodes:details'], registryAccess: { pull: ['team/app'] } })
    );
    expect(result.registryAccess).toEqual({ pull: ['team/app'] });
  });

  it('keeps the stored legacy registry scopes as registry access when the scopes change', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const db = {
      update: vi.fn().mockReturnValue({ set }),
      query: {
        apiTokens: {
          findFirst: vi.fn().mockResolvedValue({
            id: TOKEN_ID,
            userId: USER_ID,
            name: 'CI',
            scopes: ['nodes:details', 'docker:registries:internal:push'],
            registryAccess: {},
          }),
        },
      },
    };

    await createService(db).updateToken(USER_ID, TOKEN_ID, { scopes: ['proxy:view'] });

    expect(set).toHaveBeenCalledWith({ scopes: ['proxy:view'], registryAccess: { push: 'all' } });
  });

  it('refuses to leave a token with neither scopes nor registry access', async () => {
    const db = {
      update: vi.fn(),
      query: {
        apiTokens: {
          findFirst: vi.fn().mockResolvedValue({
            id: TOKEN_ID,
            userId: USER_ID,
            name: 'CI',
            scopes: [],
            registryAccess: { pull: 'all' },
          }),
        },
      },
    };

    await expect(createService(db).updateToken(USER_ID, TOKEN_ID, { registryAccess: {} })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_SCOPE',
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});
