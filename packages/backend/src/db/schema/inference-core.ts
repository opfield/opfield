import { sql } from 'drizzle-orm';
import {
  check,
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
import type {
  InferenceCoreOperationKind,
  InferenceCoreOperationPhase,
  InferenceCoreOperationProgress,
  InferenceCoreOperationStatus,
  InferenceCoreState,
} from '@/modules/inference/core/inference-core.contract.js';

/** The managed OpenCodex core is a singleton per Opfield installation. */
export const INFERENCE_CORE_STATE_ID = 'default';

export type InferenceCoreHealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export const inferenceCoreState = pgTable(
  'inference_core_state',
  {
    id: text('id').primaryKey(),
    state: varchar('state', { length: 24 }).$type<InferenceCoreState>().notNull().default('not_installed'),
    installedVersion: varchar('installed_version', { length: 80 }),
    installedDigest: text('installed_digest'),
    installedImageRef: text('installed_image_ref'),
    targetVersion: varchar('target_version', { length: 80 }),
    targetDigest: text('target_digest'),
    containerId: varchar('container_id', { length: 128 }),
    containerName: varchar('container_name', { length: 255 }),
    stateVolumeName: varchar('state_volume_name', { length: 255 }),
    secretVolumeName: varchar('secret_volume_name', { length: 255 }),
    networkName: varchar('network_name', { length: 255 }),
    coreProtocolMajor: integer('core_protocol_major'),
    coreStateSchemaVersion: integer('core_state_schema_version'),
    healthStatus: varchar('health_status', { length: 16 }).$type<InferenceCoreHealthStatus>(),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    lastReadyAt: timestamp('last_ready_at', { withTimezone: true }),
    lastError: text('last_error'),
    // Credentials are sealed through the inference credential vault as one
    // blob { dataCredential, managementCredential, callbackCredential }; raw
    // credentials are never stored here or exposed to Docker env.
    credentialsPayload: text('credentials_payload'),
    credentialsDek: text('credentials_dek'),
    credentialKeyVersion: integer('credential_key_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('inference_core_state_singleton', sql`${table.id} = 'default'`)]
);

export const inferenceCoreOperations = pgTable(
  'inference_core_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: varchar('kind', { length: 16 }).$type<InferenceCoreOperationKind>().notNull(),
    phase: varchar('phase', { length: 24 }).$type<InferenceCoreOperationPhase>().notNull(),
    status: varchar('status', { length: 16 }).$type<InferenceCoreOperationStatus>().notNull().default('running'),
    progress: jsonb('progress').$type<InferenceCoreOperationProgress>(),
    fromVersion: varchar('from_version', { length: 80 }),
    toVersion: varchar('to_version', { length: 80 }),
    fromDigest: text('from_digest'),
    toDigest: text('to_digest'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inference_core_operations_created_idx').on(table.createdAt),
    // At most one lifecycle operation may run against the single core.
    uniqueIndex('inference_core_operations_running_unique').on(table.status).where(sql`${table.status} = 'running'`),
  ]
);

export type InferenceCoreStateRow = typeof inferenceCoreState.$inferSelect;
export type InferenceCoreOperationRow = typeof inferenceCoreOperations.$inferSelect;
