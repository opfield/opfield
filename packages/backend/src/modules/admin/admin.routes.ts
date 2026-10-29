import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { canManageUser, getResourceScopedIds, hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { getClientIpForContext, getRemoteAddress, resolveClientIp } from '@/lib/request-ip.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateUserSchema,
  RestoreUserSchema,
  UpdateAuthProvisioningSettingsSchema,
  UpdateBlockSchema,
  UpdateUserAdditionalPermissionsSchema,
  UpdateUserAuthMethodSchema,
  UpdateUserGroupSchema,
  UpdateUserNameSchema,
} from '@/modules/admin/admin.schemas.js';
import {
  type AdminUserActor,
  createAdminUser,
  deleteAdminUser,
  listAdminUserSessions,
  listAdminUsers,
  listDeletedAdminUsers,
  renameAdminUser,
  resetAdminUserAvatar,
  resetAdminUserMfa,
  restoreAdminUser,
  revokeAdminUserSession,
  revokeAllAdminUserSessions,
  sendAdminUserInvitation,
  sendAdminUserPasswordLink,
  setAdminUserBlocked,
  updateAdminUserAdditionalPermissions,
  updateAdminUserAuthMethod,
  updateAdminUserGroups,
} from '@/modules/admin/admin-user-actions.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { readOpfieldSettings, updateOpfieldSettings } from '@/modules/admin/opfield-settings.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import {
  authMiddleware,
  requireScope,
  requireScopeBase,
  requireScopeForResource,
  sessionOnly,
} from '@/modules/auth/auth.middleware.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { setSessionCookie } from '@/modules/auth/session-cookie.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  assertFolderManage,
  assertFolderManageForFolder,
  assertFolderManageForFolders,
  assertFolderManageForResources,
} from '@/modules/resource-folders/resource-folder-access.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv } from '@/types.js';
import {
  createAdminUserFolderRoute,
  createAdminUserRoute,
  deleteAdminUserFolderRoute,
  deleteAdminUserRoute,
  getAuthSettingsRoute,
  impersonateAdminUserRoute,
  listAdminUserFoldersRoute,
  listAdminUserSessionsRoute,
  listAdminUsersRoute,
  listDeletedAdminUsersRoute,
  moveAdminUserFolderRoute,
  moveAdminUsersToFolderRoute,
  reorderAdminUserFoldersRoute,
  reorderAdminUsersRoute,
  resetAdminUserMfaRoute,
  resetUserAvatarRoute,
  restoreAdminUserRoute,
  revokeAdminUserSessionRoute,
  revokeAllAdminUserSessionsRoute,
  sendAdminUserInvitationRoute,
  sendAdminUserPasswordSetupRoute,
  updateAdminUserFolderRoute,
  updateAuthSettingsRoute,
  updateUserAdditionalPermissionsRoute,
  updateUserAuthMethodRoute,
  updateUserBlockRoute,
  updateUserGroupRoute,
  updateUserNameRoute,
} from './admin.docs.js';

export const adminRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

adminRoutes.use('*', authMiddleware);
// Impersonation replaces the caller's browser session, so starting it stays session-only.
adminRoutes.use('/users/:id/impersonate', sessionOnly);

function requireAnyAdminScope(...requiredScopes: string[]) {
  return async (c: any, next: () => Promise<void>) => {
    const scopes = c.get('effectiveScopes') || [];
    if (!requiredScopes.some((scope) => hasScopeBase(scopes, scope))) {
      return c.json({ code: 'FORBIDDEN', message: `Missing required scope: ${requiredScopes.join(' or ')}` }, 403);
    }
    await next();
  };
}

function adminUserActor(c: any): AdminUserActor {
  return {
    user: c.get('user')!,
    scopes: c.get('effectiveScopes') || [],
    accountScopes: c.get('isTokenAuth') ? c.get('user')!.scopes : undefined,
    // Anything but a browser session counts as programmatic, so an unknown auth type fails closed.
    programmatic: Boolean(c.get('isTokenAuth')) || c.get('authType') !== 'session',
    userAgent: c.req.header('user-agent'),
  };
}

// List all users
adminRoutes.openapi({ ...listAdminUsersRoute, middleware: requireScopeBase('admin:users') }, async (c) => {
  return c.json(await listAdminUsers(adminUserActor(c)));
});

// Deleted accounts are operationally invisible; only system administrators can inspect them.
adminRoutes.openapi({ ...listDeletedAdminUsersRoute, middleware: requireScope('admin:system') }, async (c) => {
  return c.json(await listDeletedAdminUsers(adminUserActor(c)));
});

adminRoutes.openapi(
  { ...listAdminUserFoldersRoute, middleware: requireAnyAdminScope('admin:users', 'admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const scopes = c.get('effectiveScopes') || [];
    const data = await service.getFolderTree(
      hasScope(scopes, 'admin:users') || hasScope(scopes, 'admin:users:folders:manage')
        ? { includeAllFolders: true }
        : {
            allowedResourceIds: getResourceScopedIds(scopes, 'admin:users'),
            allowedFolderIds: getFolderScopedIds(scopes, ['admin:users', 'admin:users:folders:manage']),
          }
    );
    return c.json({ data });
  }
);

adminRoutes.openapi(
  { ...createAdminUserFolderRoute, middleware: requireScopeBase('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = CreateResourceFolderSchema.parse(await c.req.json());
    assertFolderManage(c.get('effectiveScopes') || [], 'admin:users:folders:manage', input.parentId ?? null);
    const data = await service.createFolder(input, user.id);
    return c.json({ data }, 201);
  }
);

adminRoutes.openapi(
  { ...reorderAdminUserFoldersRoute, middleware: requireScopeBase('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const input = ReorderResourceFoldersSchema.parse(await c.req.json());
    await assertFolderManageForFolders(
      service,
      c.get('effectiveScopes') || [],
      'admin:users:folders:manage',
      input.items.map((item) => item.id)
    );
    await service.reorderFolders(input);
    return c.json({ success: true });
  }
);

adminRoutes.openapi(
  { ...moveAdminUsersToFolderRoute, middleware: requireScopeBase('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = MoveResourcesToFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') || [];
    await assertFolderManageForResources(service, scopes, 'admin:users:folders:manage', input.ids, input.folderId);
    for (const id of input.ids)
      if (!hasScope(scopes, `admin:users:${id}`))
        throw new AppError(403, 'FORBIDDEN', 'User is outside your permissions', {
          requiredScope: `admin:users:${id}`,
        });
    if (!hasScopeForCreation(scopes, 'admin:users', input.folderId))
      throw new AppError(403, 'FORBIDDEN', 'Destination folder is outside your permissions', {
        requiredScope: input.folderId ? `admin:users:folder/${input.folderId}` : 'admin:users',
      });
    await service.moveResourcesToFolder(input, user.id);
    return c.json({ success: true });
  }
);

adminRoutes.openapi(
  { ...reorderAdminUsersRoute, middleware: requireScopeBase('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const input = ReorderResourcesSchema.parse(await c.req.json());
    await assertFolderManageForResources(
      service,
      c.get('effectiveScopes') || [],
      'admin:users:folders:manage',
      input.items.map((item) => item.id),
      undefined
    );
    for (const item of input.items)
      if (!hasScope(c.get('effectiveScopes') || [], `admin:users:${item.id}`))
        throw new AppError(403, 'FORBIDDEN', 'User is outside your permissions', {
          requiredScope: `admin:users:${item.id}`,
        });
    await service.reorderResources(input);
    return c.json({ success: true });
  }
);

adminRoutes.openapi(
  { ...updateAdminUserFolderRoute, middleware: requireScopeBase('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = UpdateResourceFolderSchema.parse(await c.req.json());
    await assertFolderManageForFolder(
      service,
      c.get('effectiveScopes') || [],
      'admin:users:folders:manage',
      c.req.param('id')!
    );
    const data = await service.updateFolder(c.req.param('id')!, input, user.id);
    return c.json({ data });
  }
);

adminRoutes.openapi(
  { ...moveAdminUserFolderRoute, middleware: requireScopeBase('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    const input = MoveResourceFolderSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') || [];
    const data = await service.moveFolder(
      c.req.param('id')!,
      input,
      user.id,
      { scopes, editScope: 'admin:users' },
      { scopes, manageScope: 'admin:users:folders:manage' }
    );
    return c.json({ data });
  }
);

adminRoutes.openapi(
  { ...deleteAdminUserFolderRoute, middleware: requireScopeBase('admin:users:folders:manage') },
  async (c) => {
    const service = container.resolve(AdminUserFolderService);
    const user = c.get('user')!;
    await assertFolderManageForFolder(
      service,
      c.get('effectiveScopes') || [],
      'admin:users:folders:manage',
      c.req.param('id')!
    );
    await service.deleteFolder(c.req.param('id')!, user.id);
    return c.json({ success: true });
  }
);

adminRoutes.openapi({ ...getAuthSettingsRoute, middleware: requireScope('settings:opfield:view') }, async (c) =>
  c.json(
    await readOpfieldSettings(
      { user: c.get('user')!, scopes: c.get('effectiveScopes') || [] },
      {
        currentRequestIp: (networkSecurity) => resolveClientIp(c.req.raw.headers, getRemoteAddress(c), networkSecurity),
      }
    )
  )
);

adminRoutes.openapi({ ...updateAuthSettingsRoute, middleware: requireScope('settings:opfield:edit') }, async (c) => {
  const input = UpdateAuthProvisioningSettingsSchema.parse(await c.req.json());
  return c.json(
    await updateOpfieldSettings(adminUserActor(c), input, {
      host: c.req.header('host'),
      forwardedHost: c.req.header('x-forwarded-host'),
      currentRequestIp: (networkSecurity) => resolveClientIp(c.req.raw.headers, getRemoteAddress(c), networkSecurity),
    })
  );
});

export { generalSettingsRollbackFields, generalSettingsRollbackPatch } from './opfield-settings.js';

// Create user before first login
adminRoutes.openapi({ ...createAdminUserRoute, middleware: requireScopeBase('admin:users') }, async (c) => {
  const input = CreateUserSchema.parse(await c.req.json());
  return c.json(await createAdminUser(adminUserActor(c), input), 201);
});

adminRoutes.openapi(
  { ...updateUserAuthMethodRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => {
    const { authMethod } = UpdateUserAuthMethodSchema.parse(await c.req.json());
    return c.json(await updateAdminUserAuthMethod(adminUserActor(c), c.req.param('id')!, authMethod));
  }
);

adminRoutes.openapi({ ...updateUserNameRoute, middleware: requireScopeForResource('admin:users', 'id') }, async (c) => {
  const { name } = UpdateUserNameSchema.parse(await c.req.json());
  return c.json(await renameAdminUser(adminUserActor(c), c.req.param('id')!, name));
});

adminRoutes.openapi({ ...resetUserAvatarRoute, middleware: requireScopeForResource('admin:users', 'id') }, async (c) =>
  c.json(await resetAdminUserAvatar(adminUserActor(c), c.req.param('id')!))
);

adminRoutes.openapi(
  { ...sendAdminUserPasswordSetupRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => c.json(await sendAdminUserPasswordLink(adminUserActor(c), c.req.param('id')!))
);

adminRoutes.openapi(
  { ...sendAdminUserInvitationRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => c.json(await sendAdminUserInvitation(adminUserActor(c), c.req.param('id')!))
);

adminRoutes.openapi({ ...resetAdminUserMfaRoute, middleware: requireScope('admin:system') }, async (c) =>
  c.json(await resetAdminUserMfa(adminUserActor(c), c.req.param('id')!))
);

// Update user group
adminRoutes.openapi(
  { ...updateUserGroupRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => {
    const { groupIds } = UpdateUserGroupSchema.parse(await c.req.json());
    return c.json(await updateAdminUserGroups(adminUserActor(c), c.req.param('id')!, groupIds));
  }
);

// Replace user-specific additive permissions.
adminRoutes.openapi(
  { ...updateUserAdditionalPermissionsRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => {
    const { additionalScopes } = UpdateUserAdditionalPermissionsSchema.parse(await c.req.json());
    return c.json(await updateAdminUserAdditionalPermissions(adminUserActor(c), c.req.param('id')!, additionalScopes));
  }
);

// Block / unblock user
adminRoutes.openapi(
  { ...updateUserBlockRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => {
    const { blocked } = UpdateBlockSchema.parse(await c.req.json());
    await setAdminUserBlocked(adminUserActor(c), c.req.param('id')!, blocked);
    return c.json({ message: blocked ? 'User blocked' : 'User unblocked' });
  }
);

// Delete user
adminRoutes.openapi(
  { ...deleteAdminUserRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => {
    await deleteAdminUser(adminUserActor(c), c.req.param('id')!);
    return c.json({ message: 'User deleted and access revoked' });
  }
);

// Restoring deliberately leaves the account blocked. A separate unblock action is required to grant access.
adminRoutes.openapi({ ...restoreAdminUserRoute, middleware: requireScope('admin:system') }, async (c) => {
  const groups = RestoreUserSchema.parse(await c.req.json());
  return c.json(await restoreAdminUser(adminUserActor(c), c.req.param('id')!, groups));
});

adminRoutes.openapi(
  { ...listAdminUserSessionsRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => c.json(await listAdminUserSessions(adminUserActor(c), c.req.param('id')!, c.get('sessionId') ?? ''))
);

adminRoutes.openapi(
  { ...impersonateAdminUserRoute, middleware: requireScopeForResource('admin:users:impersonate', 'id') },
  async (c) => {
    const authService = container.resolve(AuthService);
    const sessionService = container.resolve(SessionService);
    const auditService = container.resolve(AuditService);
    const actor = c.get('user')!;
    const actorScopes = c.get('effectiveScopes') || [];
    const originalSessionId = c.get('sessionId')!;
    const originalSession = await sessionService.getSession(originalSessionId);

    if (!originalSession || originalSession.purpose === 'impersonation') {
      throw new AppError(409, 'IMPERSONATION_NESTED', 'Nested impersonation is not allowed');
    }

    const targetUserId = c.req.param('id')!;
    if (targetUserId === actor.id) {
      throw new AppError(400, 'IMPERSONATION_SELF', 'Cannot impersonate your own account');
    }

    const target = await authService.getUserById(targetUserId);
    if (!target) throw new AppError(404, 'NOT_FOUND', 'User not found');
    if (target.isDeleted) {
      throw new AppError(409, 'USER_DELETED', 'Deleted users cannot be impersonated');
    }
    if (target.isBlocked) {
      throw new AppError(409, 'USER_BLOCKED', 'Blocked users cannot be impersonated');
    }
    if (target.oidcSubject?.startsWith('system:')) {
      throw new AppError(403, 'SYSTEM_USER', 'System users cannot be impersonated');
    }

    const denyReason = canManageUser(actorScopes, target.scopes);
    if (denyReason) throw new AppError(403, 'PRIVILEGE_BOUNDARY', denyReason);

    const impersonation = await sessionService.createImpersonationSession(actor, target, originalSessionId, {
      ipAddress: await getClientIpForContext(c),
      userAgent: c.req.header('user-agent'),
    });
    setSessionCookie(c, impersonation.sessionId, (impersonation.expiresAt - Date.now()) / 1000);

    await auditService.log({
      userId: actor.id,
      action: 'auth.impersonation.start',
      resourceType: 'session',
      resourceId: target.id,
      details: {
        impersonatedUserId: target.id,
        impersonatedUserEmail: target.email,
        impersonatedUserName: target.name,
      },
      userAgent: c.req.header('user-agent'),
    });

    return c.json({ message: 'Impersonation started' });
  }
);

adminRoutes.openapi(
  { ...revokeAdminUserSessionRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => {
    await revokeAdminUserSession(adminUserActor(c), c.req.param('id')!, c.req.param('sessionId')!);
    return c.json({ message: 'Session revoked' });
  }
);

adminRoutes.openapi(
  { ...revokeAllAdminUserSessionsRoute, middleware: requireScopeForResource('admin:users', 'id') },
  async (c) => {
    await revokeAllAdminUserSessions(adminUserActor(c), c.req.param('id')!);
    return c.json({ message: 'All sessions revoked' });
  }
);
