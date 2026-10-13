import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const inferenceTokens = pgTable(
  'inference_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 20 }).notNull(),
    /** Null: the token never expires. An expired token is refused like a revoked one; housekeeping removes it. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** IPv4/IPv6 addresses or CIDR ranges the token works from; empty allows any address (lib/token-limits.ts). */
    allowedIps: jsonb('allowed_ips').$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_tokens_token_hash_unique').on(table.tokenHash),
    index('inference_tokens_user_idx').on(table.userId, table.createdAt),
    index('inference_tokens_active_idx').on(table.userId, table.revokedAt),
  ]
);

export type InferenceToken = typeof inferenceTokens.$inferSelect;
export type NewInferenceToken = typeof inferenceTokens.$inferInsert;
