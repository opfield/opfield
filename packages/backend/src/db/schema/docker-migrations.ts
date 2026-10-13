import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';
import { users } from './users.js';

export type DockerMigrationResourceType = 'container' | 'deployment';
export type DockerMigrationStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'cleanup_pending'
  | 'needs_attention';

export type DockerMigrationPhase =
  | 'queued'
  | 'locking'
  | 'preparing'
  | 'maintenance'
  | 'stopping_source'
  | 'preparing_volumes'
  | 'transferring'
  | 'creating_target'
  | 'verifying_target'
  | 'starting_target'
  | 'cutover'
  | 'proxy_cutover'
  | 'cleanup_source'
  | 'finalizing'
  | 'rollback'
  | 'done';

export interface DockerMigrationProgress {
  completedPhases: DockerMigrationPhase[];
  currentArtifactId?: string;
  transferredBytes?: number;
  totalBytes?: number;
  message?: string;
}

export const dockerMigrations = pgTable(
  'docker_migrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceType: text('resource_type').$type<DockerMigrationResourceType>().notNull(),
    resourceName: text('resource_name').notNull(),
    deploymentId: uuid('deployment_id'),
    // No foreign key (0251): the history keeps the ids of the nodes a migration ran between after one is deleted.
    sourceNodeId: uuid('source_node_id').notNull(),
    targetNodeId: uuid('target_node_id').notNull(),
    keepSource: boolean('keep_source').notNull().default(false),
    sourceState: text('source_state').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    status: text('status').$type<DockerMigrationStatus>().notNull().default('pending'),
    phase: text('phase').$type<DockerMigrationPhase>().notNull().default('queued'),
    preflight: jsonb('preflight').$type<Record<string, unknown>>().notNull(),
    plan: jsonb('plan').$type<Record<string, unknown>>().notNull(),
    verification: jsonb('verification').$type<Record<string, unknown>>().notNull().default({}),
    proxySnapshot: jsonb('proxy_snapshot').$type<Record<string, unknown>>().notNull().default({}),
    progress: jsonb('progress').$type<DockerMigrationProgress>().notNull().default({ completedPhases: [] }),
    cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
    cancellationRequestedById: uuid('cancellation_requested_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamp('lease_heartbeat_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    cutoverAt: timestamp('cutover_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('docker_migrations_status_idx').on(table.status),
    index('docker_migrations_source_node_idx').on(table.sourceNodeId),
    index('docker_migrations_target_node_idx').on(table.targetNodeId),
    index('docker_migrations_created_at_idx').on(table.createdAt),
  ]
);

export const dockerMigrationArtifacts = pgTable(
  'docker_migration_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    migrationId: uuid('migration_id')
      .notNull()
      .references(() => dockerMigrations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'image' | 'volume'>().notNull(),
    sourceIdentity: text('source_identity').notNull(),
    targetIdentity: text('target_identity').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    transferredBytes: bigint('transferred_bytes', { mode: 'number' }).notNull().default(0),
    compression: text('compression'),
    artifactDigest: text('artifact_digest'),
    sourceManifestRoot: text('source_manifest_root'),
    targetManifestRoot: text('target_manifest_root'),
    entryCount: integer('entry_count'),
    logicalBytes: bigint('logical_bytes', { mode: 'number' }),
    state: text('state').notNull().default('pending'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('docker_migration_artifacts_migration_idx').on(table.migrationId),
    index('docker_migration_artifacts_state_idx').on(table.state),
  ]
);

export const dockerMigrationNodeLocks = pgTable(
  'docker_migration_node_locks',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    migrationId: uuid('migration_id')
      .notNull()
      .references(() => dockerMigrations.id, { onDelete: 'cascade' }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId], name: 'docker_migration_node_locks_pkey' }),
    index('docker_migration_node_locks_migration_idx').on(table.migrationId),
  ]
);
