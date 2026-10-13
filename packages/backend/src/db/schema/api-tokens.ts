import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Internal registry access of the token (`docker login`): pull and push each `all` or a list of repository names;
 * an absent action is not granted. See modules/tokens/token-registry-access.ts.
 */
export type ApiTokenRegistryAccess = Partial<Record<'pull' | 'push', 'all' | string[]>>;

/**
 * Granular API token scopes:
 *   ca:read                    — view all CAs
 *   ca:create:root             — create root CAs
 *   ca:create:intermediate     — create intermediates under any CA
 *   ca:create:intermediate:<id>— create intermediates under specific CA only
 *   ca:revoke                  — revoke any CA
 *   cert:read                  — view all certificates
 *   cert:issue                 — issue certs from any CA
 *   cert:issue:<id>            — issue certs only from specific CA
 *   cert:revoke                — revoke any certificate
 *   cert:export                — export certs (PEM/DER/PKCS12/JKS)
 *   template:read              — view templates
 *   template:manage            — create/edit/delete templates
 *   admin:users                — manage user roles
 *   admin:audit                — view audit log
 */

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 20 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    registryAccess: jsonb('registry_access').$type<ApiTokenRegistryAccess>().notNull().default({}),
    /** Null: the token never expires. An expired token is refused like a revoked one; housekeeping removes it. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** IPv4/IPv6 addresses or CIDR ranges the token works from; empty allows any address (lib/token-limits.ts). */
    allowedIps: jsonb('allowed_ips').$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('api_tokens_user_idx').on(table.userId),
    tokenHashIdx: index('api_tokens_token_hash_idx').on(table.tokenHash),
  })
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
