import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id),
    action: varchar('action', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 50 }).notNull(),
    resourceId: text('resource_id'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    // App tagging at write time (container audit ids change on recreate, so read-time matching is unreliable).
    appId: uuid('app_id'),
    appEnvironmentId: uuid('app_environment_id'),
    appMemberType: varchar('app_member_type', { length: 32 }),
    appMemberId: text('app_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('audit_user_idx').on(table.userId),
    actionIdx: index('audit_action_idx').on(table.action),
    resourceIdx: index('audit_resource_idx').on(table.resourceType, table.resourceId),
    createdIdx: index('audit_created_idx').on(table.createdAt),
    appIdx: index('audit_app_idx').on(table.appId, table.createdAt.desc()).where(sql`${table.appId} IS NOT NULL`),
  })
);
