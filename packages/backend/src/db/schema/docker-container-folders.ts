import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
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
import { nodes } from './nodes.js';
import { users } from './users.js';

export const dockerContainerFolders = pgTable(
  'docker_container_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    resourceType: varchar('resource_type', { length: 32 }).notNull().default('container'),
    parentId: uuid('parent_id').references((): AnyPgColumn => dockerContainerFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    isSystem: boolean('is_system').notNull().default(false),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'cascade' }),
    composeProject: varchar('compose_project', { length: 255 }),
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
    parentIdx: index('docker_container_folder_parent_idx').on(table.resourceType, table.parentId),
    sortIdx: index('docker_container_folder_sort_idx').on(table.resourceType, table.parentId, table.sortOrder),
    systemComposeIdx: uniqueIndex('docker_container_folder_compose_unique_idx').on(
      table.nodeId,
      table.resourceType,
      table.composeProject
    ),
    appIdx: index('docker_container_folders_app_idx').on(table.appId),
    appEnvCheck: check(
      'docker_container_folders_app_env_check',
      sql`${table.appEnvironmentId} IS NULL OR ${table.appId} IS NOT NULL`
    ),
    appRootUnique: uniqueIndex('docker_container_folders_app_root_unique')
      .on(table.appId, table.resourceType)
      .where(sql`${table.appId} IS NOT NULL AND ${table.appEnvironmentId} IS NULL`),
    appEnvUnique: uniqueIndex('docker_container_folders_app_env_unique')
      .on(table.appEnvironmentId, table.resourceType)
      .where(sql`${table.appEnvironmentId} IS NOT NULL`),
  })
);
