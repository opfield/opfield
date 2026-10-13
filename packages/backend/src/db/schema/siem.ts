import {
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

export type SiemAuthType = 'bearer' | 'hmac_sha256' | 'custom_header';

export type SiemDeliveryStatus = 'queued' | 'delivering' | 'retrying' | 'delivered' | 'failed' | 'paused' | 'discarded';

/**
 * The frozen, privacy-reduced record exported to a SIEM receiver. This is
 * deliberately separate from audit_log.details: audit readers can see more
 * than an external collector should ever receive.
 */
export interface SiemAuditEvent {
  id: string;
  source: string;
  type: 'dev.opfield.audit.v1';
  time: string;
  data: {
    action: string;
    actor: { id: string; email: string | null } | null;
    resource: { type: string; id: string | null };
    sourceIp: string | null;
  };
}

export const siemDestinations = pgTable(
  'siem_destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    url: text('url').notNull(),
    authType: varchar('auth_type', { length: 32 }).$type<SiemAuthType>().notNull(),
    customHeaderName: varchar('custom_header_name', { length: 255 }),
    encryptedSecret: text('encrypted_secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    enabledIdx: index('siem_destinations_enabled_idx').on(table.enabled),
    deletedIdx: index('siem_destinations_deleted_idx').on(table.deletedAt),
  })
);

export const siemDeliveries = pgTable(
  'siem_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => siemDestinations.id),
    // Intentionally no FK to audit_log: audit retention must not erase the
    // delivery history or a frozen event still waiting for export.
    auditLogId: uuid('audit_log_id').notNull(),
    payload: jsonb('payload').$type<SiemAuditEvent>().notNull(),
    status: varchar('status', { length: 20 }).$type<SiemDeliveryStatus>().notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    responseTimeMs: integer('response_time_ms'),
    error: text('error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    destinationAuditUnique: uniqueIndex('siem_deliveries_destination_audit_unique').on(
      table.destinationId,
      table.auditLogId
    ),
    destinationIdx: index('siem_deliveries_destination_idx').on(table.destinationId),
    statusRetryIdx: index('siem_deliveries_status_retry_idx').on(table.status, table.nextRetryAt),
    leaseIdx: index('siem_deliveries_lease_idx').on(table.leaseExpiresAt),
    createdIdx: index('siem_deliveries_created_idx').on(table.createdAt),
  })
);
