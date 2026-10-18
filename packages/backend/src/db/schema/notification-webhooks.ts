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
import { notificationWebhookFolders } from './notification-folders.js';

export const notificationWebhooks = pgTable(
  'notification_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    url: text('url').notNull(),
    method: varchar('method', { length: 10 }).notNull().default('POST'), // GET, POST, PUT, PATCH
    enabled: boolean('enabled').notNull().default(true),

    // Authentication
    signingSecret: text('signing_secret'), // HMAC-SHA256 secret (encrypted)
    signingHeader: varchar('signing_header', { length: 100 }).default('X-Signature-256'),

    // Template — wraps the alert's {{message}} into the service-specific format
    templatePreset: varchar('template_preset', { length: 50 }), // 'discord' | 'slack' | 'telegram' | 'json' | 'plain' | null
    bodyTemplate: text('body_template'),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),

    // Delivery queue. While the target cannot be reached the whole webhook pauses (deliveryPausedUntil) and resumes in
    // order; deliveryFailures counts the unreachable sends in a row (the backoff step). One sender at a time holds the
    // lease, so deliveries go out in order also with several Opfield instances.
    deliveryPausedUntil: timestamp('delivery_paused_until', { withTimezone: true }),
    deliveryFailures: integer('delivery_failures').notNull().default(0),
    deliveryLeaseUntil: timestamp('delivery_lease_until', { withTimezone: true }),
    deliveryLeaseToken: uuid('delivery_lease_token'),

    // Null: ungrouped.
    folderId: uuid('folder_id').references((): AnyPgColumn => notificationWebhookFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    enabledIdx: index('notif_webhooks_enabled_idx').on(table.enabled),
    folderIdx: index('notif_webhooks_folder_idx').on(table.folderId),
  })
);
