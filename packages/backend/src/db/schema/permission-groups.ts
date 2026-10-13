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
import { permissionGroupFolders } from './permission-group-folders.js';

export const permissionGroups = pgTable(
  'permission_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    parentId: uuid('parent_id'),
    folderId: uuid('folder_id').references((): AnyPgColumn => permissionGroupFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    require2fa: boolean('require_2fa').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex('permission_groups_name_idx').on(table.name),
    parentIdx: index('permission_groups_parent_id_idx').on(table.parentId),
    folderIdx: index('permission_groups_folder_idx').on(table.folderId),
  })
);
