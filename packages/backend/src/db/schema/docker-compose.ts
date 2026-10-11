import { type AnyPgColumn, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { dockerTasks } from './docker-tasks.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

export type DockerComposeManagementState = 'external' | 'managed';
export type DockerComposeDesiredState = 'running' | 'stopped';
export type DockerComposeProjectStatus =
  | 'discovered'
  | 'validating'
  | 'applying'
  | 'deleting'
  | 'running'
  | 'stopped'
  | 'degraded'
  | 'failed'
  | 'missing';
export type DockerComposeAvailability = 'available' | 'unavailable';

export type DockerComposeOperationAction =
  | 'apply'
  | 'pull_apply'
  | 'start'
  | 'stop'
  | 'restart'
  | 'down'
  | 'delete_volumes'
  | 'cancel';
/**
 * `reconciling`: the node connection was lost after the operation was sent, so
 * its outcome is unknown until the node reports its actual Compose state.
 */
export type DockerComposeOperationStatus =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface DockerComposeNormalizedPort {
  target: number;
  published?: number;
  protocol?: 'tcp' | 'udp';
  hostIp?: string;
}

export interface DockerComposeNormalizedVolume {
  source: string;
  target: string;
  readOnly?: boolean;
  external?: boolean;
}

export interface DockerComposeNormalizedService {
  image: string;
  cpus?: number;
  cpuShares?: number;
  memoryLimit?: string;
  memoryReservation?: string;
  memorySwapLimit?: string;
  pidsLimit?: number;
  environment?: Record<string, string>;
  command?: string | string[];
  entrypoint?: string | string[];
  workingDir?: string;
  user?: string;
  hostname?: string;
  extraHosts?: Record<string, string>;
  ports?: DockerComposeNormalizedPort[];
  healthcheck?: Record<string, unknown>;
  dependsOn?: Record<string, { condition?: string }>;
  restart?: 'no' | 'always' | 'on-failure' | 'unless-stopped';
  volumes?: DockerComposeNormalizedVolume[];
  networks?: string[];
  labels?: Record<string, string>;
  logging?: DockerComposeNormalizedLogging;
}

/** A service's own log rotation; services without it get the node default (json-file, 50m x 3). */
export interface DockerComposeNormalizedLogging {
  driver: 'json-file' | 'local' | 'none';
  options?: Record<string, string>;
}

export interface DockerComposeNormalizedResource {
  external?: boolean;
  externalName?: string;
  driver?: string;
  labels?: Record<string, string>;
}

export interface DockerComposeNormalizedModel {
  name: string;
  services: Record<string, DockerComposeNormalizedService>;
  volumes?: Record<string, DockerComposeNormalizedResource>;
  networks?: Record<string, DockerComposeNormalizedResource>;
}

export interface DockerComposeOperationOptions {
  removeOrphans?: boolean;
  volumeNames?: string[];
}

export const dockerComposeProjects = pgTable(
  'docker_compose_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    managementState: text('management_state').$type<DockerComposeManagementState>().notNull().default('external'),
    desiredState: text('desired_state').$type<DockerComposeDesiredState>().notNull().default('running'),
    status: text('status').$type<DockerComposeProjectStatus>().notNull().default('discovered'),
    availability: text('availability').$type<DockerComposeAvailability>().notNull().default('available'),
    activeRevisionId: uuid('active_revision_id').references((): AnyPgColumn => dockerComposeRevisions.id, {
      onDelete: 'set null',
    }),
    observedFingerprint: text('observed_fingerprint'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('docker_compose_projects_node_id_name_unique').on(table.nodeId, table.name),
    index('docker_compose_projects_node_id_idx').on(table.nodeId),
    index('docker_compose_projects_management_state_idx').on(table.managementState),
    index('docker_compose_projects_last_seen_at_idx').on(table.lastSeenAt),
  ]
);

export const dockerComposeRevisions = pgTable(
  'docker_compose_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => dockerComposeProjects.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    sourceYaml: text('source_yaml').notNull(),
    originalYaml: text('original_yaml').notNull(),
    normalizedModel: jsonb('normalized_model').$type<DockerComposeNormalizedModel>().notNull(),
    configDigest: text('config_digest').notNull(),
    variables: jsonb('variables').$type<Record<string, string>>().notNull().default({}),
    secretKeys: jsonb('secret_keys').$type<string[]>().notNull().default([]),
    sourceBindingId: uuid('source_binding_id'),
    buildBatchId: uuid('build_batch_id'),
    sourceCommitSha: text('source_commit_sha'),
    // A revision an app promotion created from another environment's revision (its images pinned by digest).
    promotedFromRevisionId: uuid('promoted_from_revision_id').references((): AnyPgColumn => dockerComposeRevisions.id, {
      onDelete: 'set null',
    }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('docker_compose_revisions_project_revision_unique').on(table.projectId, table.revisionNumber),
    unique('docker_compose_revisions_project_digest_unique').on(table.projectId, table.configDigest),
    index('docker_compose_revisions_project_id_idx').on(table.projectId),
  ]
);

export const dockerComposeOperations = pgTable(
  'docker_compose_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => dockerComposeProjects.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id').references(() => dockerComposeRevisions.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => dockerTasks.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull(),
    action: text('action').$type<DockerComposeOperationAction>().notNull(),
    status: text('status').$type<DockerComposeOperationStatus>().notNull().default('pending'),
    progress: text('progress'),
    error: text('error'),
    options: jsonb('options').$type<DockerComposeOperationOptions>().notNull().default({}),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('docker_compose_operations_project_idempotency_unique').on(table.projectId, table.idempotencyKey),
    index('docker_compose_operations_project_created_at_idx').on(table.projectId, table.createdAt),
    index('docker_compose_operations_task_id_idx').on(table.taskId),
  ]
);
