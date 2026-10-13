import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appEnvironments, apps } from './apps.js';
import { users } from './users.js';

export const sslCertificateFolders = pgTable(
  'ssl_certificate_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => sslCertificateFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    // Hidden app folders (decision: app members live in folders of their own type): set only by the apps module.
    appId: uuid('app_id').references(() => apps.id, { onDelete: 'restrict' }),
    appEnvironmentId: uuid('app_environment_id').references(() => appEnvironments.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentIdx: index('ssl_certificate_folder_parent_idx').on(table.parentId),
    sortIdx: index('ssl_certificate_folder_sort_idx').on(table.parentId, table.sortOrder),
    appIdx: index('ssl_certificate_folders_app_idx').on(table.appId),
    appEnvCheck: check(
      'ssl_certificate_folders_app_env_check',
      sql`${table.appEnvironmentId} IS NULL OR ${table.appId} IS NOT NULL`
    ),
    appRootUnique: uniqueIndex('ssl_certificate_folders_app_root_unique')
      .on(table.appId)
      .where(sql`${table.appId} IS NOT NULL AND ${table.appEnvironmentId} IS NULL`),
    appEnvUnique: uniqueIndex('ssl_certificate_folders_app_env_unique')
      .on(table.appEnvironmentId)
      .where(sql`${table.appEnvironmentId} IS NOT NULL`),
  })
);
