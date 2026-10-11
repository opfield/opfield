import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { appEnvironments, apps } from './apps.js';
import { users } from './users.js';

export type AppIncidentKind = 'shutdown' | 'isolation';
export type AppIncidentRowState = 'applying' | 'active' | 'releasing' | 'released' | 'failed';
export type AppIncidentItemStatus = 'pending' | 'applied' | 'failed' | 'restored' | 'restore_failed' | 'gone';

/**
 * A shutdown or a kill switch isolation of one app environment. "All environments" creates one row per environment
 * with the same batch id. At most one open incident of each kind per environment.
 */
export const appIncidents = pgTable(
  'app_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id').notNull(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => appEnvironments.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).$type<AppIncidentKind>().notNull(),
    state: varchar('state', { length: 16 }).$type<AppIncidentRowState>().notNull().default('applying'),
    startedById: uuid('started_by_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    releasedById: uuid('released_by_id').references(() => users.id, { onDelete: 'set null' }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('app_incidents_env_kind_open_unique')
      .on(table.environmentId, table.kind)
      .where(sql`${table.state} in ('applying', 'active', 'releasing')`),
    index('app_incidents_app_started_idx').on(table.appId, table.startedAt),
    index('app_incidents_state_idx').on(table.state),
  ]
);

/**
 * One thing an incident changed, with the state it had before. Release restores each item from `prior_state` (never
 * re-derived); `phase` orders apply (ascending) and restore (descending).
 */
export const appIncidentItems = pgTable(
  'app_incident_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => appIncidents.id, { onDelete: 'cascade' }),
    itemKind: varchar('item_kind', { length: 32 }).notNull(),
    /** Stable identity of the item inside its incident (dedupes enumeration). */
    itemKey: text('item_key').notNull(),
    phase: integer('phase').notNull().default(0),
    ref: jsonb('ref').$type<Record<string, unknown>>().notNull(),
    priorState: jsonb('prior_state').$type<Record<string, unknown> | null>(),
    status: varchar('status', { length: 16 }).$type<AppIncidentItemStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('app_incident_items_incident_key_unique').on(table.incidentId, table.itemKey),
    index('app_incident_items_kind_status_idx').on(table.itemKind, table.status),
  ]
);

export type AppIncident = typeof appIncidents.$inferSelect;
export type AppIncidentItem = typeof appIncidentItems.$inferSelect;
