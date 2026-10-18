import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accessListFolders } from './access-list-folders.js';
import { users } from './users.js';

export interface IPRule {
  type: 'allow' | 'deny';
  value: string; // IP or CIDR
}

export interface BasicAuthUser {
  username: string;
  passwordHash: string;
}

export const accessLists = pgTable(
  'access_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    // IP rules
    ipRules: jsonb('ip_rules').$type<IPRule[]>().notNull().default([]),

    // Basic auth
    basicAuthEnabled: boolean('basic_auth_enabled').notNull().default(false),
    basicAuthUsers: jsonb('basic_auth_users').$type<BasicAuthUser[]>().notNull().default([]),

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
