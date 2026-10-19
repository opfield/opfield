import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
// Keep the schema load order safe when this module imports databases.ts directly.
import './certificate-templates.js';
import { databaseConnections } from './databases.js';
import { nodes } from './nodes.js';
import { objectStorageConnections } from './object-storage.js';
import { users } from './users.js';

export type BackupEngine = 'postgres' | 'redis' | 'clickhouse';
export type BackupRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type BackupDirection = 'backup' | 'restore';

/** Safe, replayable metadata only. Runtime credentials never belong in these rows. */
export interface BackupManifest {
  engine: BackupEngine;
  version: 1;
  engineVersion: string;
  sourceIdentity: string;
  sourceDatabase?: string;
  artifactKeys: string[];
  sizes: Record<string, number>;
  fileChecksums: Record<string, string>;
  manifestSha256: string;
  ownedPrefix: string;
  nativeStagePrefix?: string;
}

export const backupPolicies = pgTable(
  'backup_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    databaseConnectionId: uuid('database_connection_id')
      .notNull()
      .references(() => databaseConnections.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => objectStorageConnections.id, { onDelete: 'restrict' }),
    bucket: text('bucket').notNull(),
    prefix: text('prefix').notNull(),
    stagingStorageConnectionId: uuid('staging_storage_connection_id').references(() => objectStorageConnections.id, {
      onDelete: 'restrict',
    }),
    stagingBucket: text('staging_bucket'),
    executorNodeId: uuid('executor_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    schedule: text('schedule'),
    timezone: text('timezone').notNull().default('UTC'),
    lastScheduledAt: timestamp('last_scheduled_at', { withTimezone: true }),
    // Last schedule or retention problem (skipped slot, revoked owner,
    // retention failure). Cleared by the next successful scheduled dispatch.
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    retentionCount: integer('retention_count').notNull().default(7),
    limits: jsonb('limits')
      .$type<{ workspaceBytes: number; timeoutSeconds: number; cpuCores: number; memoryMb: number }>()
      .notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('backup_policies_database_idx').on(table.databaseConnectionId),
    index('backup_policies_executor_idx').on(table.executorNodeId),
  ]
);

export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id').references(() => backupPolicies.id, { onDelete: 'set null' }),
    // Backup history (and its artifacts) outlives a deleted connection; the
    // denormalized name keeps the history readable afterwards.
    databaseConnectionId: uuid('database_connection_id').references(() => databaseConnections.id, {
      onDelete: 'set null',
    }),
    databaseConnectionName: text('database_connection_name'),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => objectStorageConnections.id, { onDelete: 'restrict' }),
    destinationBucket: text('destination_bucket').notNull(),
    destinationPrefix: text('destination_prefix').notNull(),
    stagingStorageConnectionId: uuid('staging_storage_connection_id').references(() => objectStorageConnections.id, {
      onDelete: 'restrict',
    }),
    stagingBucket: text('staging_bucket'),
    timezone: text('timezone').notNull(),
    // Finished history outlives its executor node: the reference is cleared when the node is deleted.
    executorNodeId: uuid('executor_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    direction: text('direction').$type<BackupDirection>().notNull(),
    engine: text('engine').$type<BackupEngine>().notNull(),
    status: text('status').$type<BackupRunStatus>().notNull().default('queued'),
    phase: text('phase').notNull().default('queued'),
    requestFingerprint: text('request_fingerprint').notNull(),
    restoreTarget: jsonb('restore_target').$type<Record<string, unknown> | null>(),
    manifest: jsonb('manifest').$type<BackupManifest | null>(),
    bytes: text('bytes').notNull().default('0'),
    sanitizedError: text('sanitized_error'),
    encryptedRuntimePayload: text('encrypted_runtime_payload'),
    /**
     * Which member of a database availability set a backup read (P3-T06): an eligible copy, else the primary. Null for
     * databases on one server. `source_role` 'primary' set at admission forces the primary (the retry of a dump a
     * recovery conflict cancelled on the copy).
     */
    sourceMemberId: uuid('source_member_id'),
    sourceNodeId: uuid('source_node_id'),
    sourceRole: varchar('source_role', { length: 16 }).$type<'copy' | 'primary'>(),
    runtimeCleanupPending: boolean('runtime_cleanup_pending').notNull().default(false),
    artifactsDeletedAt: timestamp('artifacts_deleted_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    // Absolute deadline fixed when the run claims its executor. The daemon
    // receives it (when supported) and the control plane fails runs that are
    // still active well past it, even when the executor is unreachable.
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('backup_runs_policy_idx').on(table.policyId),
    index('backup_runs_database_idx').on(table.databaseConnectionId),
    index('backup_runs_executor_status_idx').on(table.executorNodeId, table.status),
    index('backup_runs_created_at_idx').on(table.createdAt),
    // At most one queued or running backup per policy (409 BACKUP_ALREADY_RUNNING).
    uniqueIndex('backup_runs_policy_active_unique')
      .on(table.policyId)
      .where(sql`${table.direction} = 'backup' AND ${table.status} IN ('queued', 'running')`),
    // At most one queued or running restore into one new managed database name
    // (409 BACKUP_RESTORE_ALREADY_RUNNING).
    uniqueIndex('backup_runs_restore_new_database_active_unique')
      .on(sql`(${table.restoreTarget} ->> 'newManagedDatabaseName')`)
      .where(
        sql`${table.direction} = 'restore' AND ${table.status} IN ('queued', 'running') AND (${table.restoreTarget} ->> 'newManagedDatabaseName') IS NOT NULL`
      ),
  ]
);

/** One active run per executor node. It is released only after terminal reconciliation. */
export const backupRunNodeLeases = pgTable(
  'backup_run_node_leases',
  {
    executorNodeId: uuid('executor_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => backupRuns.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.executorNodeId], name: 'backup_run_node_leases_pkey' }),
    index('backup_run_node_leases_run_idx').on(table.runId),
  ]
);
