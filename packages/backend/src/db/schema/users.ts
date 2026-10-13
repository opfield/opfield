import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { adminUserFolders } from './admin-user-folders.js';
import { permissionGroups } from './permission-groups.js';

export const USER_AUTH_METHODS = ['oidc', 'password', 'email_otp', 'demo_email_otp'] as const;
export type UserAuthMethod = (typeof USER_AUTH_METHODS)[number];
/** Who blocked an account: an administrator, or the Opfield account (sso-revoke; lifted by the next sign-in with it). */
export const USER_BLOCKED_BY = ['admin', 'opfield_account'] as const;
export type UserBlockedBy = (typeof USER_BLOCKED_BY)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    oidcSubject: varchar('oidc_subject', { length: 255 }),
    // Issuer that asserted oidcSubject. Null for pre-created/local accounts and
    // for OIDC accounts that have not signed in since issuers were recorded.
    oidcIssuer: varchar('oidc_issuer', { length: 2048 }),
    authMethod: varchar('auth_method', { length: 32 }).$type<UserAuthMethod>().notNull().default('oidc'),
    email: varchar('email', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    avatarUrl: text('avatar_url'),
    groupId: uuid('group_id')
      .notNull()
      .references((): AnyPgColumn => permissionGroups.id),
    additionalScopes: jsonb('additional_scopes').$type<string[]>().notNull().default([]),
    additionalGroupIds: uuid('additional_group_ids').array().notNull().default([]),
    isBlocked: boolean('is_blocked').notNull().default(false),
    // Set while is_blocked: 'admin' (only an admin unblocks) or 'opfield_account' (lifted by the next sign-in through
    // the same Opfield account issuer). Null while not blocked.
    blockedBy: varchar('blocked_by', { length: 32 }).$type<UserBlockedBy>(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    // Deliberately not a foreign key: the original group may be deleted while the user is archived.
    deletedFromGroupId: uuid('deleted_from_group_id'),
    deletedFromAdditionalGroupIds: uuid('deleted_from_additional_group_ids').array().notNull().default([]),
    aiApprovalMode: varchar('ai_approval_mode', { length: 32 })
      .$type<'always-ask' | 'normal' | 'bypass-non-destructive' | 'bypass-everything'>()
      .notNull()
      .default('normal'),
    preferredInterface: varchar('preferred_interface', { length: 32 }).$type<'ai_workspace' | 'operations_console'>(),
    preferredInterfaceSelectedAt: timestamp('preferred_interface_selected_at', { withTimezone: true }),
    folderId: uuid('folder_id').references((): AnyPgColumn => adminUserFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    // Set once when the account invitation email is sent; stays null if sending failed.
    invitationSentAt: timestamp('invitation_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oidcSubjectIdx: uniqueIndex('users_oidc_subject_idx').on(table.oidcSubject),
    emailIdx: uniqueIndex('users_email_idx').on(table.email),
    groupIdx: index('users_group_id_idx').on(table.groupId),
    additionalGroupsIdx: index('users_additional_group_ids_idx').using('gin', table.additionalGroupIds),
    folderIdx: index('users_folder_idx').on(table.folderId),
    deletedIdx: index('users_deleted_at_idx').on(table.deletedAt),
  })
);
