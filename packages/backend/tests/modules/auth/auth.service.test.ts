import 'reflect-metadata';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAdvisoryLockDb } from '@/db/advisory-lock.test-helpers.js';
import {
  inferenceProviderConnections,
  userPasskeys,
  userRecoveryCodes,
  users,
  userTotpFactors,
} from '@/db/schema/index.js';
import {
  AuthService,
  type NormalizedOidcClaims,
  normalizeOidcClaims,
  type OidcSessionMetadata,
} from '@/modules/auth/auth.service.js';
import {
  computeEffectiveGroupAccess,
  computeEffectiveUserAccess,
  fetchGroupScopeMap,
} from '@/modules/auth/live-session-user.js';
import { LEGACY_SYSTEM_ADMINS_GROUP } from '@/lib/legacy-compat.js';

const authorizationCodeGrantMock = vi.hoisted(() => vi.fn());

vi.mock('openid-client', () => ({
  authorizationCodeGrant: authorizationCodeGrantMock,
}));

vi.mock('@/modules/auth/live-session-user.js', async () => ({
  ...await vi.importActual<typeof import('@/modules/auth/live-session-user.js')>('@/modules/auth/live-session-user.js'),
  resolveEffectiveGroupAccess: vi.fn().mockResolvedValue({
    groupName: 'admin',
    scopes: ['nodes:details'],
  }),
  resolveEffectiveUserAccess: vi.fn().mockImplementation((_db, _groupId, additionalScopes = []) =>
    Promise.resolve({
      groupName: 'admin',
      groupScopes: ['nodes:details'],
      additionalScopes,
      scopes: ['nodes:details', ...additionalScopes],
    })
  ),
  computeEffectiveGroupAccess: vi.fn(),
  computeEffectiveUserAccess: vi.fn(),
  fetchGroupScopeMap: vi.fn(),
}));

/** `tx.select(...).from(users).innerJoin(...).where(...)` for the remaining-admin check. */
function activeAdminsQuery(rows: Array<{ id: string; adminGroupId: string }> = []) {
  return { innerJoin: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })) };
}

describe('AuthService.blockUser', () => {
  it('keeps sessions available so blocked users can reach status and logout endpoints', async () => {
    const dbUser = {
      id: '11111111-1111-4111-8111-111111111111',
      oidcSubject: 'oidc-user',
      email: 'user@example.com',
      name: 'User',
      avatarUrl: null,
      groupId: 'group-1',
      isBlocked: true,
    };
    const db: Record<string, unknown> = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([dbUser]),
          })),
        })),
      })),
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({ from: vi.fn(() => activeAdminsQuery()) })),
    };
    db.transaction = async (run: (tx: unknown) => Promise<unknown>) => run(db);
    const sessionService = {
      destroyAllUserSessions: vi.fn(),
    };
    const eventBus = {
      publish: vi.fn(),
    };
    const cacheService = { incr: vi.fn().mockResolvedValue(1) };
    const service = new AuthService(db as any, sessionService as any, cacheService as any, {} as any, {} as any);
    service.setEventBus(eventBus as any);

    const user = await service.blockUser(dbUser.id);

    expect(user.isBlocked).toBe(true);
    expect(sessionService.destroyAllUserSessions).not.toHaveBeenCalled();
    // Known-device cookies of the account stop counting (AUTH-3).
    expect(cacheService.incr).toHaveBeenCalledWith(`auth:known-device-epoch:${dbUser.id}`);
    expect(eventBus.publish).toHaveBeenCalledWith('user.changed', { id: dbUser.id, action: 'updated' });
    expect(eventBus.publish).toHaveBeenCalledWith(`permissions.changed.${dbUser.id}`, {
      scopes: [],
      groupId: null,
      reason: 'user_blocked',
    });
  });
});

describe('AuthService remaining system administrator', () => {
  const ADMIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ADMIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  /** Two active system admins; every statement yields, so unserialized checks interleave. */
  function twoAdmins() {
    const dialect = new PgDialect();
    const rows = new Map(
      [ADMIN_A, ADMIN_B].map((id) => [
        id,
        {
          id,
          oidcSubject: `oidc-${id}`,
          email: `${id}@example.com`,
          name: id,
          avatarUrl: null,
          groupId: 'group-system-admin',
          additionalGroupIds: [],
          additionalScopes: [],
          isBlocked: false,
          deletedAt: null,
        },
      ])
    );
    const makeTx = () => ({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: async () => {
              await Promise.resolve();
              return [...rows.values()]
                .filter((row) => !row.isBlocked && !row.deletedAt)
                .map((row) => ({ id: row.id, adminGroupId: 'group-system-admin' }));
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: SQL) => ({
            returning: async () => {
              await Promise.resolve();
              const params = dialect.sqlToQuery(condition).params;
              const row = [...rows.values()].find((candidate) => params.includes(candidate.id));
              if (!row) return [];
              Object.assign(row, values);
              return [{ ...row }];
            },
          }),
        }),
      }),
    });
    const locks = createFakeAdvisoryLockDb(makeTx);
    const service = new AuthService(
      { transaction: locks.transaction } as any,
      {} as any,
      { incr: async () => 1 } as any,
      {} as any,
      {} as any
    );
    return { service, rows, locks };
  }

  // Regression (rc10 audit F11): two admins blocking each other at once both
  // still counted the other as remaining, leaving no active administrator.
  it('lets only one of two admins blocking each other at once succeed', async () => {
    const { service, rows, locks } = twoAdmins();

    const results = await Promise.allSettled([service.blockUser(ADMIN_B), service.blockUser(ADMIN_A)]);

    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 409, code: 'LAST_SYSTEM_ADMIN' } });
    expect(rows.get(ADMIN_A)!.isBlocked).toBe(false);
    expect(rows.get(ADMIN_B)!.isBlocked).toBe(true);
    expect(locks.acquired).toEqual([LEGACY_SYSTEM_ADMINS_GROUP, LEGACY_SYSTEM_ADMINS_GROUP]);
  });

  it('refuses to demote the last active admin but allows keeping the admin group', async () => {
    const { service, rows } = twoAdmins();
    rows.get(ADMIN_B)!.isBlocked = true;
    const tx = (service as any).db;
    const assertRemains = (service as any).assertSystemAdminRemains.bind(service);

    await expect(
      tx.transaction((t: unknown) => assertRemains(t, ADMIN_A, 'demote', ['group-operators']))
    ).rejects.toMatchObject({ code: 'LAST_SYSTEM_ADMIN' });
    await expect(
      tx.transaction((t: unknown) => assertRemains(t, ADMIN_A, 'demote', ['group-operators', 'group-system-admin']))
    ).resolves.toBeUndefined();
    await expect(tx.transaction((t: unknown) => assertRemains(t, ADMIN_B, 'delete'))).resolves.toBeUndefined();
  });
});

describe('AuthService.deleteUser', () => {
  it('soft-deletes, revokes user-owned credentials, and preserves shared inference connections', async () => {
    const target = {
      id: '22222222-2222-4222-8222-222222222222',
      oidcSubject: 'target-subject',
      email: 'target@example.com',
      name: 'Target',
      avatarUrl: null,
      groupId: 'group-original',
      additionalScopes: [],
      isBlocked: false,
      deletedAt: null,
    };
    const updatedValues: unknown[] = [];
    const deleteQuery = vi.fn((_table: unknown) => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const updateQuery = vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => {
        updatedValues.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue(table === users ? [{ id: target.id }] : []),
          })),
        };
      }),
    }));
    const db: Record<string, unknown> = {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(target) },
        permissionGroups: { findFirst: vi.fn().mockResolvedValue({ id: 'group-system-admin', name: 'system-admin' }) },
      },
      update: updateQuery,
      delete: deleteQuery,
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({ from: vi.fn(() => activeAdminsQuery()) })),
    };
    db.transaction = async (run: (tx: unknown) => Promise<unknown>) => run(db);
    const sessionService = { destroyAllUserSessions: vi.fn().mockResolvedValue(undefined) };
    const eventBus = { publish: vi.fn() };
    const service = new AuthService(db as any, sessionService as any, {} as any, {} as any, {} as any);
    service.setEventBus(eventBus as any);

    await service.deleteUser(target.id, '11111111-1111-4111-8111-111111111111');

    expect(updatedValues[0]).toEqual(
      expect.objectContaining({
        groupId: 'group-system-admin',
        deletedFromGroupId: 'group-original',
        deletedByUserId: '11111111-1111-4111-8111-111111111111',
        isBlocked: true,
        deletedAt: expect.any(Date),
      })
    );
    expect(sessionService.destroyAllUserSessions).toHaveBeenCalledWith(target.id);
    expect(deleteQuery.mock.calls.map(([table]) => table)).not.toContain(inferenceProviderConnections);
    expect(eventBus.publish).toHaveBeenCalledWith(`permissions.changed.${target.id}`, {
      scopes: [],
      groupId: null,
      reason: 'user_deleted',
    });
  });
});

describe('AuthService.restoreUser', () => {
  function restoreHarness() {
    const deletedUser = {
      id: '33333333-3333-4333-8333-333333333333',
      groupId: 'group-system-admin',
      deletedAt: new Date(),
      deletedFromGroupId: 'group-admins',
      deletedFromAdditionalGroupIds: [],
    };
    vi.mocked(fetchGroupScopeMap).mockResolvedValue(new Map([['group-admins', { id: 'group-admins' }]]) as any);
    vi.mocked(computeEffectiveGroupAccess).mockReturnValue({ groupName: 'admins', scopes: ['admin:system', 'proxy:edit'] });
    const update = vi.fn();
    const db = {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(deletedUser) },
        permissionGroups: { findFirst: vi.fn().mockResolvedValue({ id: 'group-admins', name: 'admins' }) },
      },
      update,
    };
    const service = new AuthService(db as any, {} as any, {} as any, {} as any, {} as any);
    service.setLicenseQuotaService({ run: (_kind: string, _count: unknown, fn: (tx: unknown) => unknown) => fn(db) } as any);
    return { service, deletedUser, update };
  }

  it('refuses to restore a user into groups with permissions the caller cannot grant', async () => {
    const { service, deletedUser, update } = restoreHarness();

    await expect(service.restoreUser(deletedUser.id, undefined, ['admin:system'])).rejects.toMatchObject({
      statusCode: 403,
      code: 'PRIVILEGE_BOUNDARY',
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('AuthService user preferences', () => {
  it('reads the current AI approval mode', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      aiApprovalMode: 'bypass-non-destructive',
      preferredInterface: null,
      preferredInterfaceSelectedAt: null,
    });
    const service = new AuthService(
      { query: { users: { findFirst } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.getUserPreferences('user-1')).resolves.toEqual({
      aiApprovalMode: 'bypass-non-destructive',
      preferredInterface: null,
      preferredInterfaceSelectedAt: null,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: {
          aiApprovalMode: true,
          preferredInterface: true,
          preferredInterfaceSelectedAt: true,
        },
      })
    );
  });

  it('updates the current AI approval mode and emits a user update', async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        aiApprovalMode: 'always-ask',
        preferredInterface: null,
        preferredInterfaceSelectedAt: null,
      },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const eventBus = { publish: vi.fn() };
    const service = new AuthService(
      { update: vi.fn(() => ({ set })) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    service.setEventBus(eventBus as any);

    await expect(service.updateUserPreferences('user-1', { aiApprovalMode: 'always-ask' })).resolves.toEqual({
      aiApprovalMode: 'always-ask',
      preferredInterface: null,
      preferredInterfaceSelectedAt: null,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        aiApprovalMode: 'always-ask',
        updatedAt: expect.any(Date),
      })
    );
    expect(eventBus.publish).toHaveBeenCalledWith('user.changed', {
      id: 'user-1',
      action: 'updated',
    });
  });

  it('persists the selected interface with a server timestamp', async () => {
    const selectedAt = new Date('2026-08-11T00:00:00.000Z');
    const returning = vi.fn().mockResolvedValue([
      {
        aiApprovalMode: 'normal',
        preferredInterface: 'ai_workspace',
        preferredInterfaceSelectedAt: selectedAt,
      },
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const service = new AuthService(
      { update: vi.fn(() => ({ set })) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.updateUserPreferences('user-1', { preferredInterface: 'ai_workspace' })).resolves.toEqual({
      aiApprovalMode: 'normal',
      preferredInterface: 'ai_workspace',
      preferredInterfaceSelectedAt: selectedAt.toISOString(),
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredInterface: 'ai_workspace',
        preferredInterfaceSelectedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
  });
});

describe('AuthService user avatars', () => {
  it('updates the avatar and emits a user change', async () => {
    const updatedUser = dbUser({ avatarUrl: 'data:image/png;base64,cG5n' });
    const returning = vi.fn().mockResolvedValue([updatedUser]);
    const set = vi.fn(() => ({ where: vi.fn(() => ({ returning })) }));
    const eventBus = { publish: vi.fn() };
    const service = new AuthService(
      { update: vi.fn(() => ({ set })) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    service.setEventBus(eventBus as any);

    await expect(service.updateUserAvatar(updatedUser.id, updatedUser.avatarUrl)).resolves.toMatchObject({
      id: updatedUser.id,
      avatarUrl: updatedUser.avatarUrl,
    });
    expect(set).toHaveBeenCalledWith({ avatarUrl: updatedUser.avatarUrl, updatedAt: expect.any(Date) });
    expect(eventBus.publish).toHaveBeenCalledWith('user.changed', {
      id: updatedUser.id,
      action: 'updated',
    });
  });
});

describe('AuthService.listUsers', () => {
  it('returns the persisted sign-in method for an admin reload', async () => {
    vi.mocked(fetchGroupScopeMap).mockResolvedValue(new Map());
    vi.mocked(computeEffectiveUserAccess).mockReturnValue({
      groupName: 'viewer',
      groupScopes: ['nodes:details'],
      additionalScopes: [],
      scopes: ['nodes:details'],
    });
    const service = new AuthService(
      {
        query: {
          users: {
            findMany: vi.fn().mockResolvedValue([
              {
                ...dbUser({ authMethod: 'password' }),
                additionalScopes: [],
                aiApprovalMode: 'normal',
                folderId: null,
                sortOrder: 0,
              },
            ]),
          },
        },
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.listUsers()).resolves.toEqual([
      expect.objectContaining({ email: 'user@example.com', authMethod: 'password' }),
    ]);
  });
});

describe('AuthService additional permissions', () => {
  const targetUser = {
    id: '22222222-2222-4222-8222-222222222222',
    oidcSubject: 'target-user',
    authMethod: 'password' as const,
    email: 'target@example.com',
    name: 'Target',
    avatarUrl: null,
    groupId: 'group-1',
    groupName: 'viewer',
    groupScopes: ['nodes:details:node-1'],
    additionalScopes: [],
    scopes: ['nodes:details:node-1'],
    isBlocked: false,
  };

  function createGroupMoveContext({
    sourceRequiresMfa,
    destinationRequiresMfa,
    authMethod = 'password',
  }: {
    sourceRequiresMfa: boolean;
    destinationRequiresMfa: boolean;
    authMethod?: 'oidc' | 'password' | 'email_otp';
  }) {
    const currentDbUser = {
      ...targetUser,
      groupId: 'group-1',
      authMethod,
      additionalScopes: ['nodes:console:node-1'],
    };
    const updatedDbUser = {
      ...currentDbUser,
      groupId: 'group-2',
      aiApprovalMode: 'normal',
      folderId: null,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const returning = vi.fn().mockResolvedValue([updatedDbUser]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const findGroup = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'group-2',
        name: 'MFA destination',
        require2fa: destinationRequiresMfa,
      })
      .mockResolvedValueOnce({
        id: 'group-1',
        name: 'Source',
        require2fa: sourceRequiresMfa,
      });
    const sessionService = {
      setUserSessionsMfaGraceExpiresAt: vi.fn().mockResolvedValue(undefined),
      clearUserSessionsMfaGraceExpiresAt: vi.fn().mockResolvedValue(undefined),
    };
    const authSettingsService = {
      getConfig: vi.fn().mockResolvedValue({ mfaExistingSessionGracePeriodDays: 3 }),
    };
    const eventBus = { publish: vi.fn() };
    vi.mocked(fetchGroupScopeMap).mockResolvedValue(new Map([
      ['group-1', { id: 'group-1', name: 'Source', parentId: null, scopes: [], require2fa: sourceRequiresMfa }],
      ['group-2', { id: 'group-2', name: 'MFA destination', parentId: null, scopes: [], require2fa: destinationRequiresMfa }],
    ]));
    const db = {
      query: {
        permissionGroups: { findFirst: findGroup },
        users: { findFirst: vi.fn().mockResolvedValue(currentDbUser) },
      },
      update,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          ...activeAdminsQuery(),
          where: vi.fn(() => ({ orderBy: vi.fn(() => ({ for: vi.fn().mockResolvedValue([{ id: 'group-2' }]) })) })),
        })),
      })),
      execute: vi.fn().mockResolvedValue(undefined),
      transaction: async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(db),
    };
    const service = new AuthService(
      db as any,
      sessionService as any,
      {} as any,
      authSettingsService as any,
      {} as any
    );
    service.setEventBus(eventBus as any);

    return { service, sessionService, authSettingsService, eventBus, update };
  }

  function serviceWithTarget() {
    const service = new AuthService({} as any, {} as any, {} as any, {} as any, {} as any);
    vi.spyOn(service, 'getUserById').mockResolvedValue(targetUser);
    return service;
  }

  it('allows only valid additional scopes possessed by the actor', async () => {
    const service = serviceWithTarget();

    await expect(
      service.assertCanUpdateUserAdditionalScopes(
        'actor-1',
        ['nodes:details:node-1', 'nodes:console:node-1'],
        targetUser.id,
        ['nodes:console:node-1']
      )
    ).resolves.toEqual({ targetUser, additionalScopes: ['nodes:console:node-1'] });
  });

  it('rejects self-assignment and protected system scope grants', async () => {
    const service = serviceWithTarget();

    await expect(
      service.assertCanUpdateUserAdditionalScopes(targetUser.id, ['admin:system'], targetUser.id, [])
    ).rejects.toMatchObject({ code: 'SELF_PERMISSION_CHANGE' });
    await expect(
      service.assertCanUpdateUserAdditionalScopes('actor-1', ['admin:system', 'nodes:details:node-1'], targetUser.id, [
        'admin:system',
      ])
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
  });

  it('rejects invalid or unowned additional scopes', async () => {
    const service = serviceWithTarget();

    await expect(
      service.assertCanUpdateUserAdditionalScopes('actor-1', ['nodes:details:node-1'], targetUser.id, [
        'not:a:real:scope',
      ])
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    await expect(
      service.assertCanUpdateUserAdditionalScopes('actor-1', ['nodes:details:node-1'], targetUser.id, [
        'nodes:console:node-1',
      ])
    ).rejects.toMatchObject({ code: 'PRIVILEGE_BOUNDARY' });
  });

  it('persists additional permissions across a group change and emits effective scopes', async () => {
    const { service, eventBus } = createGroupMoveContext({
      sourceRequiresMfa: false,
      destinationRequiresMfa: false,
    });

    const updated = await service.updateUserGroup(targetUser.id, 'group-2');

    expect(updated.additionalScopes).toEqual(['nodes:console:node-1']);
    expect(updated.scopes).toEqual(['nodes:console:node-1', 'nodes:details']);
    expect(eventBus.publish).toHaveBeenCalledWith(`permissions.changed.${targetUser.id}`, {
      scopes: ['nodes:console:node-1', 'nodes:details'],
      groupId: 'group-2',
      reason: 'permissions_changed',
    });
  });

  it('starts the configured grace period and notifies a local user when group MFA becomes required', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T12:00:00.000Z'));
    try {
      const { service, sessionService, eventBus, update } = createGroupMoveContext({
        sourceRequiresMfa: false,
        destinationRequiresMfa: true,
      });

      await service.updateUserGroup(targetUser.id, 'group-2');

      expect(sessionService.setUserSessionsMfaGraceExpiresAt).toHaveBeenCalledWith(
        targetUser.id,
        Date.now() + 3 * 24 * 60 * 60 * 1000
      );
      expect(sessionService.setUserSessionsMfaGraceExpiresAt.mock.invocationCallOrder[0]).toBeLessThan(
        update.mock.invocationCallOrder[0]
      );
      expect(eventBus.publish).toHaveBeenCalledWith(`mfa.required.${targetUser.id}`, {
        groupId: 'group-2',
        groupName: 'MFA destination',
        require2fa: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the grace period and notifies a local user when group MFA is removed', async () => {
    const { service, sessionService, authSettingsService, eventBus, update } = createGroupMoveContext({
      sourceRequiresMfa: true,
      destinationRequiresMfa: false,
    });

    await service.updateUserGroup(targetUser.id, 'group-2');

    expect(sessionService.clearUserSessionsMfaGraceExpiresAt).toHaveBeenCalledWith(targetUser.id);
    expect(sessionService.clearUserSessionsMfaGraceExpiresAt.mock.invocationCallOrder[0]).toBeGreaterThan(
      update.mock.invocationCallOrder[0]
    );
    expect(authSettingsService.getConfig).not.toHaveBeenCalled();
    expect(eventBus.publish).toHaveBeenCalledWith(`mfa.required.${targetUser.id}`, {
      groupId: 'group-2',
      groupName: 'MFA destination',
      require2fa: false,
    });
  });

  it('does not extend an existing grace period when moving between MFA-required groups', async () => {
    const { service, sessionService, authSettingsService, eventBus } = createGroupMoveContext({
      sourceRequiresMfa: true,
      destinationRequiresMfa: true,
    });

    await service.updateUserGroup(targetUser.id, 'group-2');

    expect(sessionService.setUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
    expect(sessionService.clearUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
    expect(authSettingsService.getConfig).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalledWith(`mfa.required.${targetUser.id}`, expect.anything());
  });

  it('leaves OIDC group moves outside Opfield MFA grace handling', async () => {
    const { service, sessionService, authSettingsService, eventBus } = createGroupMoveContext({
      sourceRequiresMfa: false,
      destinationRequiresMfa: true,
      authMethod: 'oidc',
    });

    await service.updateUserGroup(targetUser.id, 'group-2');

    expect(sessionService.setUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
    expect(sessionService.clearUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
    expect(authSettingsService.getConfig).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalledWith(`mfa.required.${targetUser.id}`, expect.anything());
  });
});

describe('normalizeOidcClaims', () => {
  it('requires a subject claim', () => {
    expect(() => normalizeOidcClaims({ email: 'user@example.com' })).toThrow('No subject claim in ID token');
  });

  it('allows missing email so existing subject-bound users can still be resolved', () => {
    expect(normalizeOidcClaims({ sub: 'oidc-sub' })).toMatchObject({
      oidcSubject: 'oidc-sub',
      email: null,
    });
    expect(normalizeOidcClaims({ sub: 'oidc-sub', email: '   ' })).toMatchObject({
      oidcSubject: 'oidc-sub',
      email: null,
    });
  });

  it('preserves the OIDC subject as an opaque identifier', () => {
    expect(normalizeOidcClaims({ sub: ' oidc-sub ', email: 'user@example.com' })).toMatchObject({
      oidcSubject: ' oidc-sub ',
      email: 'user@example.com',
    });
  });

  it('rejects subjects in the reserved Opfield system namespace', () => {
    expect(() => normalizeOidcClaims({ sub: 'system:external-user', email: 'user@example.com' })).toThrow(
      'OIDC subject uses a reserved Opfield namespace'
    );
  });

  it('rejects subjects that collide with pre-created Opfield placeholders', () => {
    for (const sub of ['manual:victim@example.com', 'MANUAL:victim@example.com', 'System:opfield-setup']) {
      expect(() => normalizeOidcClaims({ sub, email: 'victim@example.com', email_verified: true })).toThrow(
        'OIDC subject uses a reserved Opfield namespace'
      );
    }
  });

  it('records the issuer that asserted the subject', () => {
    expect(normalizeOidcClaims({ sub: 'oidc-sub', iss: 'https://idp.example.com/realms/main/' }).oidcIssuer).toBe(
      'https://idp.example.com/realms/main'
    );
    expect(normalizeOidcClaims({ sub: 'oidc-sub' }, 'https://idp.example.com/').oidcIssuer).toBe(
      'https://idp.example.com'
    );
  });

  it('normalizes email and treats only boolean true as verified', () => {
    expect(
      normalizeOidcClaims({
        sub: 'oidc-sub',
        email: ' User@Example.COM ',
        email_verified: true,
        name: 'User',
        picture: 'https://example.com/avatar.png',
      })
    ).toEqual({
      oidcSubject: 'oidc-sub',
      oidcIssuer: null,
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: 'https://example.com/avatar.png',
    });

    expect(
      normalizeOidcClaims({
        sub: 'oidc-sub',
        email: 'user@example.com',
        email_verified: 'true',
      }).emailVerified
    ).toBe(false);
  });
});

describe('AuthService OIDC identity binding', () => {
  it('rejects a deleted subject before creating a session', async () => {
    const sessionService = { createSession: vi.fn() };
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: false,
      },
      existingBySubject: dbUser({ deletedAt: new Date() }),
      sessionService,
    });

    await expect(
      harness.loginWithClaims({
        oidcSubject: 'real-sub',
        email: 'user@example.com',
        emailVerified: true,
        name: 'User',
        avatarUrl: null,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_DELETED' });
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('rejects an OIDC callback when OIDC was disabled after the redirect began', async () => {
    authorizationCodeGrantMock.mockClear();
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
        methods: { oidc: false },
      },
    });

    await expect(harness.service.getAuthorizationUrl()).rejects.toMatchObject({
      statusCode: 409,
      code: 'AUTH_METHOD_DISABLED',
    });
    await expect(
      harness.service.handleCallback('https://opfield.example.com/callback?code=code&state=state', 'state')
    ).rejects.toMatchObject({ statusCode: 409, code: 'AUTH_METHOD_DISABLED' });
    expect(authorizationCodeGrantMock).not.toHaveBeenCalled();
  });

  it('allows an existing subject-bound user when the provider omits email', async () => {
    const existingUser = dbUser({
      oidcSubject: 'real-sub',
      email: 'old@example.com',
      name: 'Old Name',
      avatarUrl: null,
    });
    const updatedUser = { ...existingUser, name: 'New Name' };
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingBySubject: existingUser,
      updateReturning: updatedUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: null,
      emailVerified: false,
      name: 'New Name',
      avatarUrl: null,
    });

    expect(result.user.email).toBe('old@example.com');
    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'old@example.com',
        name: 'New Name',
      })
    );
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_profile_sync',
        details: expect.objectContaining({
          oidcSubject: 'real-sub',
          emailClaimMissing: true,
          emailVerified: false,
        }),
      })
    );
  });

  it('stores client metadata on OIDC sessions', async () => {
    const existingUser = dbUser({ oidcSubject: 'real-sub' });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: false,
      },
      existingBySubject: existingUser,
    });

    await harness.loginWithClaims(
      {
        oidcSubject: 'real-sub',
        email: existingUser.email,
        emailVerified: true,
        name: existingUser.name,
        avatarUrl: null,
      },
      {
        ipAddress: '203.0.113.10',
        userAgent: 'Mozilla/5.0 Opfield test browser',
      }
    );

    expect(harness.sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: existingUser.id }),
      {
        authMethod: 'oidc',
        ipAddress: '203.0.113.10',
        userAgent: 'Mozilla/5.0 Opfield test browser',
      }
    );
  });

  it('preserves a custom avatar when OIDC profile claims are synchronized', async () => {
    const existingUser = dbUser({
      oidcSubject: 'real-sub',
      name: 'User',
      avatarUrl: '/auth/avatars/11111111-1111-4111-8111-111111111111.webp',
    });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: false,
      },
      existingBySubject: existingUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: existingUser.email,
      emailVerified: true,
      name: 'User',
      avatarUrl: 'https://identity.example.com/provider-avatar.png',
    });

    expect(result.user.avatarUrl).toBe(existingUser.avatarUrl);
    expect(harness.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: 'https://identity.example.com/provider-avatar.png' })
    );
  });

  it('normalizes a missing OIDC name to the account email', async () => {
    const existingUser = dbUser({ oidcSubject: 'real-sub', name: null });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: false,
      },
      existingBySubject: existingUser,
      updateReturning: { ...existingUser, name: existingUser.email },
    });

    await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: existingUser.email,
      emailVerified: true,
      name: null,
      avatarUrl: null,
    });

    expect(harness.updateSet).toHaveBeenCalledWith(expect.objectContaining({ name: existingUser.email }));
  });

  it('allows an existing subject-bound user with unverified email and does not sync a changed email', async () => {
    const existingUser = dbUser({
      oidcSubject: 'real-sub',
      email: 'old@example.com',
      name: 'Old Name',
      avatarUrl: null,
    });
    const updatedUser = { ...existingUser, name: 'New Name', avatarUrl: 'https://example.com/avatar.png' };
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingBySubject: existingUser,
      updateReturning: updatedUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: 'new@example.com',
      emailVerified: false,
      name: 'New Name',
      avatarUrl: 'https://example.com/avatar.png',
    });

    expect(result.user.email).toBe('old@example.com');
    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'old@example.com',
        name: 'New Name',
        avatarUrl: 'https://example.com/avatar.png',
      })
    );
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_profile_sync',
        details: expect.objectContaining({
          oidcSubject: 'real-sub',
          emailChanged: false,
          emailClaimIgnored: true,
          emailVerified: false,
        }),
      })
    );
  });

  it('rejects pre-created user claim when verified-email mode is enabled and email is unverified', async () => {
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingByEmail: dbUser({
        id: 'user-1',
        oidcSubject: 'manual:user@example.com',
        email: 'user@example.com',
        groupId: 'admin-group',
      }),
    });

    await expect(
      harness.loginWithClaims({
        oidcSubject: 'real-sub',
        email: 'user@example.com',
        emailVerified: false,
        name: 'User',
        avatarUrl: null,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'OIDC_EMAIL_NOT_VERIFIED',
    });
  });

  it('claims a pre-created user when verified-email mode is enabled and email is verified', async () => {
    const claimedUser = dbUser({
      id: 'user-1',
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      name: 'User',
    });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      existingByEmail: dbUser({
        id: 'user-1',
        oidcSubject: 'manual:user@example.com',
        email: 'user@example.com',
        groupId: 'admin-group',
      }),
      updateReturning: claimedUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });

    expect(result.user.oidcSubject).toBe('real-sub');
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_claimed',
        details: expect.objectContaining({
          previousOidcSubject: 'manual:user@example.com',
          oidcSubject: 'real-sub',
          emailVerified: true,
        }),
      })
    );
  });

  it('rejects post-bootstrap auto-create when verified-email mode is enabled and email is unverified', async () => {
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      userCount: 1,
      provisioningGroup: { id: 'viewer-group', name: 'viewer' },
    });

    await expect(
      harness.loginWithClaims({
        oidcSubject: 'real-sub',
        email: 'user@example.com',
        emailVerified: false,
        name: 'User',
        avatarUrl: null,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'OIDC_EMAIL_NOT_VERIFIED',
    });
  });

  it('binds a legacy subject to the issuer on its next login', async () => {
    const existingUser = dbUser({ oidcSubject: 'real-sub', oidcIssuer: null, name: 'User' });
    const harness = createAuthServiceHarness({
      authSettings: { oidcAutoCreateUsers: false, oidcDefaultGroupId: 'viewer-group', oidcRequireVerifiedEmail: true },
      existingBySubject: existingUser,
      updateReturning: { ...existingUser, oidcIssuer: 'https://idp.example.com' },
    });

    await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      oidcIssuer: 'https://idp.example.com/',
      email: existingUser.email,
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });

    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ oidcIssuer: 'https://idp.example.com' })
    );
  });

  it('rejects the same subject asserted by a different issuer', async () => {
    const sessionService = { createSession: vi.fn() };
    const harness = createAuthServiceHarness({
      authSettings: { oidcAutoCreateUsers: true, oidcDefaultGroupId: 'viewer-group', oidcRequireVerifiedEmail: false },
      existingBySubject: dbUser({ oidcSubject: 'shared-sub', oidcIssuer: 'https://old-idp.example.com' }),
      sessionService,
    });

    await expect(
      harness.loginWithClaims({
        oidcSubject: 'shared-sub',
        oidcIssuer: 'https://new-idp.example.com',
        email: 'someone-else@example.com',
        emailVerified: true,
        name: 'Someone Else',
        avatarUrl: null,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'OIDC_ISSUER_MISMATCH' });
    expect(harness.updateSet).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('stores the issuer when claiming a pre-created account', async () => {
    const precreated = dbUser({ oidcSubject: 'manual:user@example.com', email: 'user@example.com' });
    const harness = createAuthServiceHarness({
      authSettings: { oidcAutoCreateUsers: false, oidcDefaultGroupId: 'viewer-group', oidcRequireVerifiedEmail: true },
      existingBySubject: null,
      existingByEmail: precreated,
      updateReturning: { ...precreated, oidcSubject: 'real-sub', oidcIssuer: 'https://idp.example.com' },
    });

    await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      oidcIssuer: 'https://idp.example.com',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });

    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ oidcSubject: 'real-sub', oidcIssuer: 'https://idp.example.com' })
    );
  });

  it('never grants the first arbitrary OIDC user the system-admin group', async () => {
    const createdUser = dbUser({
      id: 'user-1',
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      name: 'User',
      groupId: 'viewer-group',
    });
    const harness = createAuthServiceHarness({
      authSettings: {
        oidcAutoCreateUsers: true,
        oidcDefaultGroupId: 'viewer-group',
        oidcRequireVerifiedEmail: true,
      },
      userCount: 0,
      provisioningGroup: { id: 'viewer-group', name: 'viewer' },
      insertReturning: createdUser,
    });

    const result = await harness.loginWithClaims({
      oidcSubject: 'real-sub',
      email: 'user@example.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });

    expect(result.user.id).toBe('user-1');
    expect(harness.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.user_provisioned',
        details: expect.objectContaining({
          oidcSubject: 'real-sub',
          emailVerified: true,
          bootstrap: false,
        }),
      })
    );
  });
});

describe('AuthService.logout', () => {
  it('ends a local session without OIDC configured', async () => {
    const sessionService = {
      getSession: vi.fn().mockResolvedValue({ authMethod: 'password' }),
      destroySession: vi.fn().mockResolvedValue(undefined),
    };
    const oidcSettingsService = { getRuntimeConfig: vi.fn().mockResolvedValue(null) };
    const service = new AuthService(
      {} as never,
      sessionService as never,
      {} as never,
      {} as never,
      {} as never,
      oidcSettingsService as never
    );

    await expect(service.logout('session-1')).resolves.toBeNull();
    expect(sessionService.destroySession).toHaveBeenCalledWith('session-1');
  });

  it('ends an OIDC-method session when OIDC is no longer configured', async () => {
    const sessionService = {
      getSession: vi.fn().mockResolvedValue({ authMethod: 'oidc' }),
      destroySession: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AuthService(
      {} as never,
      sessionService as never,
      {} as never,
      {} as never,
      {} as never,
      { getRuntimeConfig: vi.fn().mockResolvedValue(null) } as never
    );

    await expect(service.logout('session-1')).resolves.toBeNull();
    expect(sessionService.destroySession).toHaveBeenCalledWith('session-1');
  });
});

function dbUser(overrides: Partial<DbUser> = {}): DbUser {
  return {
    id: 'user-1',
    oidcSubject: 'real-sub',
    authMethod: 'oidc',
    email: 'user@example.com',
    name: null,
    avatarUrl: null,
    groupId: 'group-1',
    isBlocked: false,
    ...overrides,
  };
}

interface DbUser {
  id: string;
  oidcSubject: string;
  oidcIssuer?: string | null;
  authMethod: 'oidc' | 'password' | 'email_otp';
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  isBlocked: boolean;
  deletedAt?: Date | null;
}

function createAuthServiceHarness(options: {
  authSettings: {
    oidcAutoCreateUsers: boolean;
    oidcDefaultGroupId: string;
    oidcRequireVerifiedEmail: boolean;
    methods?: { oidc?: boolean };
  };
  existingBySubject?: DbUser | null;
  existingByEmail?: DbUser | null;
  userCount?: number;
  provisioningGroup?: { id: string; name: string } | null;
  updateReturning?: DbUser;
  insertReturning?: DbUser;
  sessionService?: { createSession: ReturnType<typeof vi.fn> };
}) {
  const updateSet = vi.fn((_: unknown) => ({
    where: vi.fn(() => ({
      returning: vi
        .fn()
        .mockResolvedValue([options.updateReturning ?? options.existingBySubject ?? options.existingByEmail]),
    })),
  }));
  const insertValues = vi.fn((_: unknown) => ({
    returning: vi.fn().mockResolvedValue([options.insertReturning]),
  }));

  const db = {
    query: {
      users: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(options.existingBySubject ?? null)
          .mockResolvedValueOnce(options.existingByEmail ?? null),
      },
      permissionGroups: {
        findFirst: vi.fn().mockResolvedValue(options.provisioningGroup ?? { id: 'viewer-group', name: 'viewer' }),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: options.userCount ?? 1 }]),
      })),
    })),
    update: vi.fn(() => ({
      set: updateSet,
    })),
    insert: vi.fn(() => ({
      values: insertValues,
    })),
  };
  const sessionService = options.sessionService ?? {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
  };
  const cacheService = {
    get: vi.fn().mockResolvedValue({ codeVerifier: 'verifier', state: 'state' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const authSettingsService = {
    getConfig: vi.fn().mockResolvedValue(options.authSettings),
  };
  const auditService = {
    log: vi.fn().mockResolvedValue(undefined),
  };
  const service = new AuthService(
    db as any,
    sessionService as any,
    cacheService as any,
    authSettingsService as any,
    auditService as any
  );
  service.setLicenseQuotaService({
    run: vi.fn((_resource, _countCurrent, write) => write(db)),
  } as never);
  (service as any).oidcConfig = {};

  return {
    auditService,
    sessionService,
    service,
    updateSet,
    async loginWithClaims(claims: NormalizedOidcClaims, sessionMetadata?: OidcSessionMetadata) {
      authorizationCodeGrantMock.mockResolvedValueOnce({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        claims: () => ({
          sub: claims.oidcSubject,
          ...(claims.oidcIssuer ? { iss: claims.oidcIssuer } : {}),
          email: claims.email,
          email_verified: claims.emailVerified,
          name: claims.name,
          picture: claims.avatarUrl,
        }),
      });

      return service.handleCallback(
        'https://opfield.example.com/callback?code=code&state=state',
        'state',
        sessionMetadata
      );
    },
  };
}

describe('AuthService.updateUserAuthMethod second factors', () => {
  function setup(existing: { totp: number; recoveryCodes: number; passkeys: number }) {
    const target = {
      id: '22222222-2222-4222-8222-222222222222',
      email: 'user@example.com',
      authMethod: 'password',
      oidcSubject: null,
      deletedAt: null,
      groupId: 'group-1',
    };
    const deleted: unknown[] = [];
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));
    const db = {
      query: { users: { findFirst: vi.fn().mockResolvedValue(target) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...target, ...values }]) })),
        })),
      })),
      delete: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          deleted.push(table);
          const returning = vi
            .fn()
            .mockResolvedValue(
              table === userTotpFactors
                ? rows(existing.totp)
                : table === userRecoveryCodes
                  ? rows(existing.recoveryCodes)
                  : table === userPasskeys
                    ? rows(existing.passkeys)
                    : []
            );
          return Object.assign(Promise.resolve(), { returning });
        }),
      })),
    };
    const sessionService = { destroyAllUserSessions: vi.fn() };
    const cacheService = { delete: vi.fn().mockResolvedValue(undefined) };
    const authSettings = { getConfig: vi.fn().mockResolvedValue({ methods: { oidc: true, password: true, emailOtp: true } }) };
    const auditService = { log: vi.fn().mockResolvedValue(true) };
    const service = new AuthService(
      db as any,
      sessionService as any,
      cacheService as any,
      authSettings as any,
      auditService as any
    );
    vi.spyOn(service as any, 'mapDbUserToUser').mockImplementation(async (row: any) => ({ ...row, scopes: [] }));
    return { service, target, deleted, sessionService, cacheService, auditService };
  }

  it('keeps the TOTP factor, recovery codes and passkeys when the sign-in method changes (2.12.8 behaviour)', async () => {
    const { service, target, deleted, sessionService, auditService } = setup({
      totp: 1,
      recoveryCodes: 8,
      passkeys: 2,
    });

    await service.updateUserAuthMethod(target.id, 'email_otp');

    expect(deleted).not.toContain(userTotpFactors);
    expect(deleted).not.toContain(userRecoveryCodes);
    expect(deleted).not.toContain(userPasskeys);
    expect(sessionService.destroyAllUserSessions).toHaveBeenCalledWith(target.id);
    expect(auditService.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'user.mfa_reset' }));
  });
});
