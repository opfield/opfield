import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const oauthClients = pgTable(
  'oauth_clients',
  {
    clientId: varchar('client_id', { length: 80 }).primaryKey(),
    clientName: varchar('client_name', { length: 255 }).notNull(),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    rawMetadata: jsonb('raw_metadata').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Last time this client was granted an authorization code or token. A
     * client that was ever granted is never purged; only registrations that
     * never completed authorization are removed by housekeeping.
     */
    lastGrantAt: timestamp('last_grant_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index('oauth_clients_name_idx').on(table.clientName),
  })
);

export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull(),
    clientId: varchar('client_id', { length: 80 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: varchar('code_challenge', { length: 128 }).notNull(),
    requestedScopes: jsonb('requested_scopes').$type<string[]>().notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    resource: text('resource'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeHashIdx: index('oauth_authorization_codes_code_hash_idx').on(table.codeHash),
    clientIdx: index('oauth_authorization_codes_client_idx').on(table.clientId),
    userIdx: index('oauth_authorization_codes_user_idx').on(table.userId),
  })
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 20 }).notNull(),
    clientId: varchar('client_id', { length: 80 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    resource: text('resource'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The expiry the owner set on the grant: no token of its chain outlives it. Null: no limit. */
    grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }),
    /** Addresses or CIDR ranges every token of the grant works from; empty allows any address. */
    allowedIps: jsonb('allowed_ips').$type<string[]>().notNull().default([]),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByTokenId: uuid('replaced_by_token_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashIdx: index('oauth_refresh_tokens_token_hash_idx').on(table.tokenHash),
    clientIdx: index('oauth_refresh_tokens_client_idx').on(table.clientId),
    userIdx: index('oauth_refresh_tokens_user_idx').on(table.userId),
  })
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 20 }).notNull(),
    clientId: varchar('client_id', { length: 80 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenId: uuid('refresh_token_id').references(() => oauthRefreshTokens.id, { onDelete: 'set null' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    resource: text('resource'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** The expiry the owner set on the grant (see oauthRefreshTokens.grantExpiresAt). Null: no limit. */
    grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }),
    /** Addresses or CIDR ranges every token of the grant works from; empty allows any address. */
    allowedIps: jsonb('allowed_ips').$type<string[]>().notNull().default([]),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashIdx: index('oauth_access_tokens_token_hash_idx').on(table.tokenHash),
    clientIdx: index('oauth_access_tokens_client_idx').on(table.clientId),
    userIdx: index('oauth_access_tokens_user_idx').on(table.userId),
  })
);

export type OAuthClient = typeof oauthClients.$inferSelect;
