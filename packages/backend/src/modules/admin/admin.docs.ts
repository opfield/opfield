import { z } from '@hono/zod-openapi';
import {
  appRoute,
  commonErrorResponses,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  CreateUserSchema,
  RestoreUserSchema,
  UpdateAuthProvisioningSettingsSchema,
  UpdateBlockSchema,
  UpdateUserAdditionalPermissionsSchema,
  UpdateUserAuthMethodSchema,
  UpdateUserGroupSchema,
  UpdateUserNameSchema,
} from './admin.schemas.js';

const PublicSessionSchema = z.object({
  id: z.string(),
  authMethod: z.enum(['oidc', 'password', 'email_otp']),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  expiresAt: z.number().int(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  mfaSatisfiedAt: z.number().int().nullable(),
  isCurrent: z.boolean(),
});

const UserSessionParamSchema = IdParamSchema.extend({
  sessionId: z.string().min(1).max(64),
});

export const listAdminUsersRoute = appRoute({
  method: 'get',
  path: '/users',
  tags: ['Admin'],
  summary: 'List users',
  responses: okJson(UnknownDataResponseSchema),
});

export const listDeletedAdminUsersRoute = appRoute({
  method: 'get',
  path: '/users/deleted',
  tags: ['Admin'],
  summary: 'List deleted users',
  responses: okJson(UnknownDataResponseSchema),
});

export const listAdminUserFoldersRoute = appRoute({
  method: 'get',
  path: '/user-folders',
  tags: ['Admin Folders'],
  summary: 'List user folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createAdminUserFolderRoute = appRoute({
  method: 'post',
  path: '/user-folders',
  tags: ['Admin Folders'],
  summary: 'Create a user folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderAdminUserFoldersRoute = appRoute({
  method: 'put',
  path: '/user-folders/reorder',
  tags: ['Admin Folders'],
  summary: 'Reorder user folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const moveAdminUsersToFolderRoute = appRoute({
  method: 'post',
  path: '/user-folders/move-users',
  tags: ['Admin Folders'],
  summary: 'Move users to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderAdminUsersRoute = appRoute({
  method: 'put',
  path: '/user-folders/reorder-users',
  tags: ['Admin Folders'],
  summary: 'Reorder users',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAdminUserFolderRoute = appRoute({
  method: 'put',
  path: '/user-folders/{id}',
  tags: ['Admin Folders'],
  summary: 'Update a user folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveAdminUserFolderRoute = appRoute({
  method: 'put',
  path: '/user-folders/{id}/move',
  tags: ['Admin Folders'],
  summary: 'Move a user folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAdminUserFolderRoute = appRoute({
  method: 'delete',
  path: '/user-folders/{id}',
  tags: ['Admin Folders'],
  summary: 'Delete a user folder',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getAuthSettingsRoute = appRoute({
  method: 'get',
  path: '/auth-settings',
  tags: ['Admin'],
  summary: 'Get Opfield settings',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAuthSettingsRoute = appRoute({
  method: 'put',
  path: '/auth-settings',
  tags: ['Admin'],
  summary: 'Update Opfield settings',
  description:
    'Needs settings:opfield:edit. Changing SMTP or the email transport, the OIDC provider, the public URL, relaxing OIDC verified-email enforcement, OIDC user auto-creation or its default group, the sign-in methods, the MFA grace period, client IP trust (networkSecurity) or the outbound webhook policy also needs admin:system; resubmitting current values does not. networkSecurity: a new save of reverse_proxy without trustedProxyCidrs is refused (400 TRUSTED_PROXY_REQUIRED); one stored by an earlier release keeps working and may be saved again.',
  request: jsonBody(UpdateAuthProvisioningSettingsSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const createAdminUserRoute = appRoute({
  method: 'post',
  path: '/users',
  tags: ['Admin'],
  summary: 'Create a user',
  request: jsonBody(CreateUserSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateUserGroupRoute = appRoute({
  method: 'patch',
  path: '/users/{id}/group',
  tags: ['Admin'],
  summary: 'Update a user permission group',
  request: { params: IdParamSchema, ...jsonBody(UpdateUserGroupSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateUserAuthMethodRoute = appRoute({
  method: 'patch',
  path: '/users/{id}/auth-method',
  tags: ['Admin'],
  summary: "Change a user's primary sign-in method",
  description:
    "Needs admin:users. Ends the user's sessions and removes their password; their TOTP factor, recovery codes and passkeys stay.",
  request: { params: IdParamSchema, ...jsonBody(UpdateUserAuthMethodSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateUserNameRoute = appRoute({
  method: 'patch',
  path: '/users/{id}/name',
  tags: ['Admin'],
  summary: "Rename a local user's account",
  request: { params: IdParamSchema, ...jsonBody(UpdateUserNameSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const resetUserAvatarRoute = appRoute({
  method: 'delete',
  path: '/users/{id}/avatar',
  tags: ['Admin'],
  summary: "Reset a user's avatar",
  request: { params: IdParamSchema },
  responses: { ...okJson(UnknownDataResponseSchema), ...commonErrorResponses },
});

export const sendAdminUserPasswordSetupRoute = appRoute({
  method: 'post',
  path: '/users/{id}/password-setup',
  tags: ['Admin'],
  summary: 'Email a password setup or reset link to a local password user',
  request: { params: IdParamSchema },
  responses: okJson(
    z.object({
      message: z.string(),
      purpose: z.enum(['password_setup', 'password_reset']),
      delivery: z.enum(['sent', 'queued']),
    })
  ),
});

export const sendAdminUserInvitationRoute = appRoute({
  method: 'post',
  path: '/users/{id}/invitation',
  tags: ['Admin'],
  summary: 'Email the one-time account invitation to a user who has never signed in',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateUserAdditionalPermissionsRoute = appRoute({
  method: 'put',
  path: '/users/{id}/additional-permissions',
  tags: ['Admin'],
  summary: "Replace a user's additional permissions",
  request: { params: IdParamSchema, ...jsonBody(UpdateUserAdditionalPermissionsSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateUserBlockRoute = appRoute({
  method: 'patch',
  path: '/users/{id}/block',
  tags: ['Admin'],
  summary: 'Block or unblock a user',
  request: { params: IdParamSchema, ...jsonBody(UpdateBlockSchema) },
  responses: okJson(z.object({ message: z.string() })),
});

export const deleteAdminUserRoute = appRoute({
  method: 'delete',
  path: '/users/{id}',
  tags: ['Admin'],
  summary: 'Delete a user',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ message: z.string() })),
});

export const restoreAdminUserRoute = appRoute({
  method: 'post',
  path: '/users/{id}/restore',
  tags: ['Admin'],
  summary: 'Restore a deleted user in blocked state',
  request: { params: IdParamSchema, ...jsonBody(RestoreUserSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listAdminUserSessionsRoute = appRoute({
  method: 'get',
  path: '/users/{id}/sessions',
  tags: ['Admin'],
  summary: "List a user's active browser sessions",
  request: { params: IdParamSchema },
  responses: okJson(z.array(PublicSessionSchema)),
});

export const impersonateAdminUserRoute = appRoute({
  method: 'post',
  path: '/users/{id}/impersonate',
  tags: ['Admin'],
  summary: 'Start a protected browser impersonation session',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ message: z.string() })),
});

export const revokeAdminUserSessionRoute = appRoute({
  method: 'delete',
  path: '/users/{id}/sessions/{sessionId}',
  tags: ['Admin'],
  summary: "Revoke a user's active browser session",
  request: { params: UserSessionParamSchema },
  responses: okJson(z.object({ message: z.string() })),
});

export const revokeAllAdminUserSessionsRoute = appRoute({
  method: 'delete',
  path: '/users/{id}/sessions',
  tags: ['Admin'],
  summary: "Revoke all of a user's active browser sessions",
  request: { params: IdParamSchema },
  responses: okJson(z.object({ message: z.string() })),
});

export const resetAdminUserMfaRoute = appRoute({
  method: 'post',
  path: '/users/{id}/mfa/reset',
  tags: ['Admin'],
  summary: "Reset a user's Opfield MFA factors",
  request: { params: IdParamSchema },
  responses: okJson(z.object({ message: z.string() })),
});
