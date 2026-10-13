import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import type { SessionService } from '@/services/session.service.js';
import { GroupService } from './group.service.js';

function createService(groups: Array<{ id: string; parentId: string | null; name: string; scopes: string[] }>) {
  return new GroupService(
    {
      query: {
        permissionGroups: {
          findMany: vi.fn().mockResolvedValue(groups),
        },
      },
    } as unknown as DrizzleClient,
    {} as SessionService,
    {} as AuthSettingsService
  );
}

describe('GroupService delete authorization', () => {
  it('rejects changing inheritance for a child outside the parent editor resource grants', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'Parent', scopes: ['nodes:details'] },
      { id: 'child', parentId: 'parent', name: 'Child', scopes: [] },
    ]);
    vi.spyOn(service, 'getGroup').mockResolvedValue({
      id: 'parent',
      isBuiltin: false,
      scopes: ['nodes:details'],
    } as never);
    await expect(
      service.assertCanUpdateGroup('parent', { scopes: [] }, ['admin:groups:parent', 'nodes:details'])
    ).rejects.toMatchObject({ code: 'GROUP_ACCESS_DENIED' });
  });
  it('rejects deleting an accessible parent when a child is outside resource grants', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'Parent', scopes: ['nodes:details'] },
      { id: 'child', parentId: 'parent', name: 'Hidden child', scopes: [] },
    ]);
    await expect(
      service.assertCanDeleteGroup('parent', ['admin:groups:parent', 'nodes:details'])
    ).rejects.toMatchObject({ code: 'GROUP_ACCESS_DENIED' });
    await expect(
      service.assertCanDeleteGroup('parent', ['admin:groups:parent', 'admin:groups:child', 'nodes:details'])
    ).resolves.toBeUndefined();
  });
  it('rejects custom groups that would inherit admin:system from a parent', async () => {
    const service = createService([
      { id: 'system-admin', parentId: null, name: 'system-admin', scopes: ['admin:system', 'nodes:details'] },
    ]);

    await expect(
      service.assertCanCreateGroup(
        { name: 'custom-system-child', scopes: ['nodes:details'], parentId: 'system-admin' },
        ['admin:system', 'nodes:details']
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
  });

  it('rejects deleting a group whose scopes exceed the actor', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'parent', scopes: ['nodes:details', 'admin:users'] },
    ]);

    await expect(service.assertCanDeleteGroup('parent', ['admin:groups', 'nodes:details'])).rejects.toMatchObject({
      statusCode: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
  });

  it('checks child groups because deletion unparents and cascades permissions', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'parent', scopes: ['nodes:details'] },
      { id: 'child', parentId: 'parent', name: 'child', scopes: ['admin:users'] },
    ]);

    await expect(service.assertCanDeleteGroup('parent', ['admin:groups', 'nodes:details'])).rejects.toMatchObject({
      statusCode: 403,
      code: 'SCOPE_NOT_ALLOWED',
    });
  });

  it('allows deleting a group tree fully covered by actor scopes', async () => {
    const service = createService([
      { id: 'parent', parentId: null, name: 'parent', scopes: ['nodes:details'] },
      { id: 'child', parentId: 'parent', name: 'child', scopes: ['proxy:view:host-1'] },
    ]);

    await expect(
      service.assertCanDeleteGroup('parent', ['admin:groups', 'nodes:details', 'proxy:view:host-1'])
    ).resolves.toBeUndefined();
  });
});

describe('GroupService MFA enforcement events', () => {
  it('notifies every local user when MFA becomes required so active dashboards refresh', async () => {
    const group = {
      id: 'operators',
      name: 'Operators',
      description: null,
      isBuiltin: false,
      parentId: null,
      scopes: [],
      require2fa: false,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
      updatedAt: new Date('2026-08-05T00:00:00.000Z'),
    };
    const updated = { ...group, require2fa: true, updatedAt: new Date('2026-08-05T01:00:00.000Z') };
    const db = {
      query: { permissionGroups: { findFirst: vi.fn().mockResolvedValue(group) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })),
        })),
      })),
      select: vi.fn().mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { id: 'member-needs-mfa', authMethod: 'password' },
            { id: 'member-has-totp', authMethod: 'email_otp' },
            { id: 'member-has-passkey', authMethod: 'password' },
            { id: 'member-oidc', authMethod: 'oidc' },
          ]),
        })),
      })),
    };
    const setUserSessionsMfaGraceExpiresAt = vi.fn().mockResolvedValue(undefined);
    const clearUserSessionsMfaGraceExpiresAt = vi.fn().mockResolvedValue(undefined);
    const service = new GroupService(
      db as unknown as DrizzleClient,
      {
        setUserSessionsMfaGraceExpiresAt,
        clearUserSessionsMfaGraceExpiresAt,
      } as unknown as SessionService,
      {
        getConfig: vi.fn().mockResolvedValue({ mfaExistingSessionGracePeriodDays: 3 }),
      } as unknown as AuthSettingsService
    );
    const publish = vi.fn();
    service.setEventBus({ publish } as never);

    await service.updateGroup('operators', { require2fa: true });

    expect(setUserSessionsMfaGraceExpiresAt).toHaveBeenCalledWith('member-needs-mfa', expect.any(Number));
    expect(setUserSessionsMfaGraceExpiresAt).toHaveBeenCalledWith('member-has-totp', expect.any(Number));
    expect(setUserSessionsMfaGraceExpiresAt).toHaveBeenCalledWith('member-has-passkey', expect.any(Number));
    expect(setUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalledWith('member-oidc', expect.any(Number));
    expect(clearUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
    expect(setUserSessionsMfaGraceExpiresAt.mock.invocationCallOrder[0]).toBeLessThan(
      db.update.mock.invocationCallOrder[0]
    );

    expect(publish).toHaveBeenCalledWith('mfa.required.member-needs-mfa', {
      groupId: 'operators',
      groupName: 'Operators',
      require2fa: true,
    });
    expect(publish).toHaveBeenCalledWith('mfa.required.member-has-totp', {
      groupId: 'operators',
      groupName: 'Operators',
      require2fa: true,
    });
    expect(publish).toHaveBeenCalledWith('mfa.required.member-has-passkey', {
      groupId: 'operators',
      groupName: 'Operators',
      require2fa: true,
    });
    expect(publish).not.toHaveBeenCalledWith('mfa.required.member-oidc', expect.anything());
    expect(publish).toHaveBeenCalledWith('group.mfa.required', {
      groupId: 'operators',
      groupName: 'Operators',
      require2fa: true,
      memberCount: 4,
    });
  });

  it('clears local session grace deadlines before disabling group MFA', async () => {
    const group = {
      id: 'operators',
      name: 'Operators',
      description: null,
      isBuiltin: false,
      parentId: null,
      scopes: [],
      require2fa: true,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
      updatedAt: new Date('2026-08-05T00:00:00.000Z'),
    };
    const updated = { ...group, require2fa: false, updatedAt: new Date('2026-08-05T01:00:00.000Z') };
    const db = {
      query: { permissionGroups: { findFirst: vi.fn().mockResolvedValue(group) } },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })),
        })),
      })),
      select: vi.fn().mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { id: 'local-user', authMethod: 'password' },
            { id: 'oidc-user', authMethod: 'oidc' },
          ]),
        })),
      })),
    };
    const setUserSessionsMfaGraceExpiresAt = vi.fn().mockResolvedValue(undefined);
    const clearUserSessionsMfaGraceExpiresAt = vi.fn().mockResolvedValue(undefined);
    const service = new GroupService(
      db as unknown as DrizzleClient,
      {
        setUserSessionsMfaGraceExpiresAt,
        clearUserSessionsMfaGraceExpiresAt,
      } as unknown as SessionService,
      { getConfig: vi.fn() } as unknown as AuthSettingsService
    );

    await service.updateGroup('operators', { require2fa: false });

    expect(clearUserSessionsMfaGraceExpiresAt).toHaveBeenCalledWith('local-user');
    expect(clearUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalledWith('oidc-user');
    expect(setUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
    expect(clearUserSessionsMfaGraceExpiresAt.mock.invocationCallOrder[0]).toBeLessThan(
      db.update.mock.invocationCallOrder[0]
    );
  });

  it('does not alter session grace deadlines when group validation rejects the update', async () => {
    const group = {
      id: 'operators',
      name: 'Operators',
      description: null,
      isBuiltin: false,
      parentId: null,
      scopes: [],
      require2fa: false,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
      updatedAt: new Date('2026-08-05T00:00:00.000Z'),
    };
    const setUserSessionsMfaGraceExpiresAt = vi.fn().mockResolvedValue(undefined);
    const clearUserSessionsMfaGraceExpiresAt = vi.fn().mockResolvedValue(undefined);
    const service = new GroupService(
      { query: { permissionGroups: { findFirst: vi.fn().mockResolvedValue(group) } } } as unknown as DrizzleClient,
      {
        setUserSessionsMfaGraceExpiresAt,
        clearUserSessionsMfaGraceExpiresAt,
      } as unknown as SessionService,
      { getConfig: vi.fn() } as unknown as AuthSettingsService
    );

    await expect(service.updateGroup('operators', { parentId: 'operators', require2fa: true })).rejects.toMatchObject({
      code: 'CYCLE_DETECTED',
    });

    expect(setUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
    expect(clearUserSessionsMfaGraceExpiresAt).not.toHaveBeenCalled();
  });
});
