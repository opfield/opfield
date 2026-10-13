import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const notificationAlertRules = pgTable(
  'notification_alert_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    type: varchar('type', { length: 20 }).notNull(), // 'threshold' | 'event'
    severity: varchar('severity', { length: 20 }).notNull().default('warning'), // 'info' | 'warning' | 'critical'

    // Category — determines available resources and metrics
    category: varchar('category', { length: 20 }).notNull(), // 'node' | 'container' | 'proxy' | 'certificate'

    // Threshold fields (null for event rules)
    metric: varchar('metric', { length: 100 }), // 'cpu', 'memory', 'disk', 'days_until_expiry'
    metricTarget: varchar('metric_target', { length: 255 }),
    operator: varchar('operator', { length: 5 }), // '>' | '>=' | '<' | '<='
    thresholdValue: doublePrecision('threshold_value'),
    durationSeconds: integer('duration_seconds').default(0),
    fireThresholdPercent: integer('fire_threshold_percent').notNull().default(100),
    resolveAfterSeconds: integer('resolve_after_seconds').default(60),
    resolveThresholdPercent: integer('resolve_threshold_percent').notNull().default(100),

    // Event fields (null for threshold rules)
    eventPattern: varchar('event_pattern', { length: 255 }), // 'offline', 'stopped', 'oom_killed', etc.

    // Scope — specific resources this alert applies to (empty = all of this category)
    resourceIds: jsonb('resource_ids').$type<string[]>().default([]),

    // Message template — rendered with event-specific variables, injected into webhook's body as {{message}}
    messageTemplate: text('message_template'),
    // Resolve message template — the message sent when the alert resolves; empty uses Opfield's text for the rule
    resolveMessageTemplate: text('resolve_message_template'),

    // Webhooks — which webhooks to deliver to
    webhookIds: jsonb('webhook_ids').$type<string[]>().notNull().default([]),

    // Cooldown
    cooldownSeconds: integer('cooldown_seconds').notNull().default(900),

    isBuiltin: boolean('is_builtin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    enabledIdx: index('notif_alert_rules_enabled_idx').on(table.enabled),
    typeIdx: index('notif_alert_rules_type_idx').on(table.type),
    categoryIdx: index('notif_alert_rules_category_idx').on(table.category),
    builtinIdx: index('notif_alert_rules_builtin_idx').on(table.isBuiltin),
  })
);
