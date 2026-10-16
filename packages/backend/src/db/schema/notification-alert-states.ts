import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { notificationAlertRules } from './notification-alert-rules.js';

export const notificationAlertStates = pgTable(
  'notification_alert_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => notificationAlertRules.id, { onDelete: 'cascade' }),
    resourceType: varchar('resource_type', { length: 50 }).notNull(),
    resourceId: varchar('resource_id', { length: 255 }).notNull(),
    /** The resource's name and the alert message as notified when it fired; null on rows written before 2.12.3. */
    resourceName: varchar('resource_name', { length: 255 }),
    message: text('message'),

    status: varchar('status', { length: 20 }).notNull().default('firing'), // 'firing' | 'resolved'
    severity: varchar('severity', { length: 20 }).notNull(),

    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }).notNull().defaultNow(),

    context: jsonb('context').$type<Record<string, unknown>>().default({}),
  },
  (table) => ({
    ruleIdx: index('notif_alert_states_rule_idx').on(table.ruleId),
    statusIdx: index('notif_alert_states_status_idx').on(table.status),
    resourceIdx: index('notif_alert_states_resource_idx').on(table.resourceType, table.resourceId),
    uniqueFiringIdx: uniqueIndex('notif_alert_states_unique_firing_idx')
      .on(table.ruleId, table.resourceType, table.resourceId)
      .where(sql`status = 'firing'`),
  })
);
