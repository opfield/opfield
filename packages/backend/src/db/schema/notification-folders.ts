import { type AnyPgColumn, index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Folders of the alert rule list (Notifications → Alerts). Built-in rules stay in the read-only built-in group. */
export const notificationAlertRuleFolders = pgTable(
  'notification_alert_rule_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => notificationAlertRuleFolders.id, {
      onDelete: 'cascade',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentIdx: index('notification_alert_rule_folder_parent_idx').on(table.parentId),
    sortIdx: index('notification_alert_rule_folder_sort_idx').on(table.parentId, table.sortOrder),
  })
);

/** Folders of the notification webhook list (Notifications → Webhooks). */
export const notificationWebhookFolders = pgTable(
  'notification_webhook_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => notificationWebhookFolders.id, {
      onDelete: 'cascade',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentIdx: index('notification_webhook_folder_parent_idx').on(table.parentId),
    sortIdx: index('notification_webhook_folder_sort_idx').on(table.parentId, table.sortOrder),
  })
);
