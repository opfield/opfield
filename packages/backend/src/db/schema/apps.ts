import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';
import { users } from './users.js';

/**
 * An app groups resources of several types into environments. Members live in hidden folders of their own type
 * (`app_id` set on the folder row): one app-root folder per family, one environment folder per environment below it.
 */
export const apps = pgTable(
  'apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    maintenanceOverride: boolean('maintenance_override').notNull().default(false),
    maintenanceOverrideAt: timestamp('maintenance_override_at', { withTimezone: true }),
    maintenanceOverrideBy: uuid('maintenance_override_by').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('apps_slug_unique').on(table.slug),
    uniqueIndex('apps_name_lower_unique').on(sql`lower(${table.name})`),
  ]
);

export const appEnvironments = pgTable(
  'app_environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    isProduction: boolean('is_production').notNull().default(false),
    maintenanceEnabled: boolean('maintenance_enabled').notNull().default(false),
    maintenanceStartedAt: timestamp('maintenance_started_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('app_environments_name_lower_unique').on(table.appId, sql`lower(${table.name})`),
    uniqueIndex('app_environments_slug_unique').on(table.appId, table.slug),
    uniqueIndex('app_environments_one_production').on(table.appId).where(sql`${table.isProduction}`),
  ]
);

/** Nodes an environment may place workloads on. An environment without rows of a node type refuses creates there. */
export const appEnvironmentNodes = pgTable(
  'app_environment_nodes',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => appEnvironments.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.nodeId] }),
    index('app_environment_nodes_node_idx').on(table.nodeId),
  ]
);

/** Environment variables and secrets; both encrypted, secrets are never returned. A key is one or the other. */
export const appEnvironmentVariables = pgTable(
  'app_environment_variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => appEnvironments.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    secret: boolean('secret').notNull(),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('app_environment_variables_env_key_unique').on(table.environmentId, table.key)]
);

/**
 * What each workload last received from its environment layer: keys (to remove them when they leave the layer) and
 * the digest (to list workloads that still run older values). Owner keys: container `<nodeId>:<name>`, deployment
 * `<id>`, compose `<projectId>`.
 */
export const appEnvironmentLayerState = pgTable(
  'app_environment_layer_state',
  {
    ownerKind: varchar('owner_kind', { length: 16 }).notNull(),
    ownerKey: text('owner_key').notNull(),
    environmentId: uuid('environment_id').references(() => appEnvironments.id, { onDelete: 'set null' }),
    appliedKeys: text('applied_keys').array().notNull(),
    appliedDigest: text('applied_digest').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerKind, table.ownerKey] }),
    index('app_environment_layer_state_env_idx').on(table.environmentId),
  ]
);

export type App = typeof apps.$inferSelect;
export type AppEnvironment = typeof appEnvironments.$inferSelect;
export type AppEnvironmentVariable = typeof appEnvironmentVariables.$inferSelect;
export type AppEnvironmentLayerState = typeof appEnvironmentLayerState.$inferSelect;
