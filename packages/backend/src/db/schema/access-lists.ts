import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accessListFolders } from './access-list-folders.js';
import { users } from './users.js';

/**
 * A sign-in method an access list offers: `opfield` (an account of this Opfield), `password` (the sign-in
 * form for the list's users), `basic` (HTTP basic authentication with the list's users), `shared` (one
 * password for every visitor), or `idp:<access_identity_providers.id>` (Google or an OIDC provider).
 */
export type AccessSignInMethod = 'opfield' | 'password' | 'basic' | 'shared' | `idp:${string}`;

/**
 * What an access rule matches. `ip`: the client address is in one of the values (IP or CIDR). Identity
 * selectors match the signed-in visitor: `everyone` (any identity), `email`, `email_domain`, `opfield_user`
 * (Opfield user ids), `opfield_group` (permission group ids), `sso_group` (group names from the provider's
 * groups claim), `method` (AccessSignInMethod values), `service_token` (access_service_tokens ids).
 */
export type AccessRuleSelector =
  | 'everyone'
  | 'ip'
  | 'email'
  | 'email_domain'
  | 'opfield_user'
  | 'opfield_group'
  | 'sso_group'
  | 'method'
  | 'service_token';

/** One rule: it matches when its selector matches any of `values` (`everyone` has none). */
export interface AccessRule {
  selector: AccessRuleSelector;
  values: string[];
}

/** A user of the list's sign-in form and basic authentication. */
export interface AccessListUser {
  username: string;
  passwordHash: string;
}

export const accessLists = pgTable(
  'access_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    // Who gets in. Exclude turns a visitor away first; an address in skipIpRanges gets in without signing
    // in; everyone else signs in with one of signInMethods and must match one Include rule and every
    // Require rule.
    signInMethods: text('sign_in_methods').array().$type<AccessSignInMethod[]>().notNull().default([]),
    users: jsonb('users').$type<AccessListUser[]>().notNull().default([]),
    sharedPasswordHash: text('shared_password_hash'),
    skipIpRanges: text('skip_ip_ranges').array().notNull().default([]),
    includeRules: jsonb('include_rules').$type<AccessRule[]>().notNull().default([]),
    requireRules: jsonb('require_rules').$type<AccessRule[]>().notNull().default([]),
    excludeRules: jsonb('exclude_rules').$type<AccessRule[]>().notNull().default([]),
    // Null: the default session length of the sign-in settings.
    sessionTtlSeconds: integer('session_ttl_seconds'),

    // Metadata
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Null: ungrouped.
    folderId: uuid('folder_id').references((): AnyPgColumn => accessListFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => ({
    folderIdx: index('access_list_folder_idx').on(table.folderId),
  })
);

export const accessIdentityProviderKindEnum = pgEnum('access_identity_provider_kind', ['google', 'oidc']);

/** Google or OIDC providers access lists can offer as sign-in methods (`idp:<id>`). */
export const accessIdentityProviders = pgTable('access_identity_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: accessIdentityProviderKindEnum('kind').notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  // OIDC issuer; Google uses https://accounts.google.com.
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  encryptedClientSecret: text('encrypted_client_secret').notNull(),
  scopes: text('scopes').notNull().default('openid email profile'),
  // Claim the sso_group rules read; null: no groups.
  groupsClaim: varchar('groups_claim', { length: 128 }),
  // Trust the provider's email address: a missing email_verified claim counts as verified; email_verified false never.
  trustEmail: boolean('trust_email').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Credentials scripts send instead of signing in (Opfield-Access-Client-Id / -Secret headers). */
export const accessServiceTokens = pgTable(
  'access_service_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    clientId: varchar('client_id', { length: 64 }).notNull(),
    // Hex SHA-256 of the secret; the secret is shown once.
    secretSha256: varchar('secret_sha256', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    clientIdUnique: uniqueIndex('access_service_tokens_client_id_unique').on(table.clientId),
  })
);

export const accessSigningKeyStatusEnum = pgEnum('access_signing_key_status', [
  'active',
  'verification_only',
  'retired',
]);

/**
 * Ed25519 keys that sign access tokens. One active key signs; a replaced key stays verification_only until
 * every token it signed expired (verifyUntil), then its private key is destroyed and it retires.
 */
export const accessSigningKeys = pgTable(
  'access_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: varchar('key_id', { length: 64 }).notNull(),
    // Raw 32-byte public key, base64.
    publicKey: text('public_key').notNull(),
    encryptedPrivateKey: text('encrypted_private_key'),
    encryptedDek: text('encrypted_dek'),
    status: accessSigningKeyStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    verifyUntil: timestamp('verify_until', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => ({
    keyIdUnique: uniqueIndex('access_signing_keys_key_id_unique').on(table.keyId),
    singleActiveIdx: uniqueIndex('access_signing_keys_single_active_idx')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
  })
);

/**
 * A visitor signed in on a protected route's sign-in page. Host tokens carry its id (sid); revoking it turns every
 * token of the session away on every ingress node.
 */
export const accessSessions = pgTable(
  'access_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // AccessSignInMethod the visitor used.
    method: varchar('method', { length: 80 }).notNull(),
    // Provider subject, Opfield user id, or the list username.
    subject: text('subject').notNull(),
    email: text('email'),
    name: text('name'),
    groups: text('groups').array().notNull().default([]),
    // Set for password, basic and shared identities: valid only for this list.
    accessListId: uuid('access_list_id').references(() => accessLists.id, { onDelete: 'cascade' }),
    clientIp: varchar('client_ip', { length: 64 }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    expiresIdx: index('access_sessions_expires_idx').on(table.expiresAt),
  })
);
