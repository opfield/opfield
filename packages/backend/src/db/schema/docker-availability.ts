import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { dockerComposeProjects, dockerComposeRevisions } from './docker-compose.js';
import { dockerDeployments } from './docker-deployments.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

export type DockerAvailabilityResourceKind = 'container' | 'deployment' | 'compose';
export type DockerAvailabilityMode = 'single' | 'replicated' | 'failover';
export type DockerAvailabilityNodeSelectionMode = 'all_compatible' | 'selected';
/**
 * What a lease-mode policy does when a partition hides the holder from the voter majority. strict never runs two
 * copies of a slot; available keeps serving on a reachable candidate and accepts that two copies can run.
 */
export type DockerAvailabilityPartitionMode = 'strict' | 'available';
export type DockerAvailabilityPolicyStatus =
  | 'single'
  | 'enabling'
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'scaling'
  | 'rolling_out'
  | 'disabling'
  | 'failed';
export type DockerAvailabilityPlacementDesiredState = 'serving' | 'standby' | 'draining' | 'stopped' | 'removed';
export type DockerAvailabilityPlacementActualState =
  | 'pending'
  | 'preparing_image'
  | 'preparing_dependencies'
  | 'starting'
  | 'checking_health'
  | 'ready'
  | 'serving'
  | 'draining'
  | 'stopped'
  | 'unreachable'
  | 'stale'
  | 'failed'
  | 'cleanup_pending'
  | 'removed';
export type DockerAvailabilityDependencyState = 'pending' | 'ready' | 'degraded' | 'failed';
export type DockerAvailabilityHealthState = 'unknown' | 'starting' | 'healthy' | 'unhealthy';
export type DockerAvailabilityOperationType =
  | 'enable'
  | 'scale'
  | 'rollout'
  | 'heal'
  | 'disable'
  | 'stale_cleanup'
  | 'failback'
  | 'start'
  | 'stop'
  | 'restart';
export type DockerAvailabilityOperationStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cleanup_pending'
  | 'cancelled';
export type DockerAvailabilityOperationPhase =
  | 'queued'
  | 'locking'
  | 'validating'
  | 'selecting_nodes'
  | 'preparing_images'
  | 'preparing_dependencies'
  | 'starting'
  | 'checking_health'
  | 'activating_routes'
  | 'draining'
  | 'stopping'
  | 'restarting'
  | 'cleaning_up'
  | 'finalizing'
  | 'done';

export interface DockerAvailabilityRolloutPolicy {
  maxUnavailable: number;
  maxSurge: number;
  drainSeconds: number;
}

export interface DockerAvailabilityOperationProgress {
  message?: string;
  completedPlacementIds?: string[];
  activePlacementId?: string;
  totalPlacements?: number;
  completedPlacements?: number;
}

export const dockerAvailabilityPolicies = pgTable(
  'docker_availability_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceKind: varchar('resource_kind', { length: 32 }).$type<DockerAvailabilityResourceKind>().notNull(),
    originNodeId: uuid('origin_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    sourceNodeId: uuid('source_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    containerName: text('container_name'),
    deploymentId: uuid('deployment_id').references(() => dockerDeployments.id, { onDelete: 'cascade' }),
    composeProjectId: uuid('compose_project_id').references(() => dockerComposeProjects.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull().default(''),
    specFingerprint: text('spec_fingerprint').notNull().default(''),
    portableSpec: jsonb('portable_spec').$type<Record<string, unknown>>().notNull().default({}),
    imageReference: text('image_reference'),
    composeRevisionId: uuid('compose_revision_id').references(() => dockerComposeRevisions.id, {
      onDelete: 'set null',
    }),
    shouldRun: boolean('should_run').notNull().default(true),
    mode: varchar('mode', { length: 32 }).$type<DockerAvailabilityMode>().notNull().default('single'),
    desiredReplicaCount: integer('desired_replica_count').notNull().default(1),
    nodeSelectionMode: varchar('node_selection_mode', { length: 32 })
      .$type<DockerAvailabilityNodeSelectionMode>()
      .notNull()
      .default('all_compatible'),
    selectedNodeIds: text('selected_node_ids').array().notNull().default([]),
    desiredGeneration: integer('desired_generation').notNull().default(1),
    rolloutPolicy: jsonb('rollout_policy')
      .$type<DockerAvailabilityRolloutPolicy>()
      .notNull()
      .default({ maxUnavailable: 0, maxSurge: 1, drainSeconds: 30 }),
    offlineReplacementGraceSeconds: integer('offline_replacement_grace_seconds').notNull().default(15),
    // Priority mode: serving placements go to the first available nodes of nodePriority (the first is the
    // primary), and the workload moves back to a higher-priority node once it has been healthy for
    // failbackDelaySeconds. selectedNodeIds still decides which nodes are eligible at all.
    priorityMode: boolean('priority_mode').notNull().default(false),
    nodePriority: text('node_priority').array().notNull().default([]),
    failbackDelaySeconds: integer('failback_delay_seconds').notNull().default(300),
    partitionMode: varchar('partition_mode', { length: 16 })
      .$type<DockerAvailabilityPartitionMode>()
      .notNull()
      .default('strict'),
    /**
     * A19: the lease witness, a relay instance id or a docker node id outside the candidates' hosts; null picks one
     * automatically (largest minimum round trip to the candidates).
     */
    witness: varchar('witness', { length: 64 }),
    status: varchar('status', { length: 32 }).$type<DockerAvailabilityPolicyStatus>().notNull().default('single'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'docker_availability_policies_resource_shape_check',
      sql`(${table.resourceKind} = 'container' AND ${table.sourceNodeId} IS NOT NULL AND ${table.containerName} IS NOT NULL AND ${table.deploymentId} IS NULL AND ${table.composeProjectId} IS NULL) OR (${table.resourceKind} = 'deployment' AND ${table.sourceNodeId} IS NULL AND ${table.containerName} IS NULL AND ${table.deploymentId} IS NOT NULL AND ${table.composeProjectId} IS NULL) OR (${table.resourceKind} = 'compose' AND ${table.sourceNodeId} IS NULL AND ${table.containerName} IS NULL AND ${table.deploymentId} IS NULL AND ${table.composeProjectId} IS NOT NULL)`
    ),
    check(
      'docker_availability_policies_replica_count_check',
      sql`(${table.mode} = 'replicated' AND ${table.desiredReplicaCount} BETWEEN 2 AND 32) OR (${table.mode} IN ('single', 'failover') AND ${table.desiredReplicaCount} = 1)`
    ),
    check(
      'docker_availability_policies_selected_nodes_check',
      sql`(${table.nodeSelectionMode} = 'all_compatible') OR (${table.nodeSelectionMode} = 'selected' AND cardinality(${table.selectedNodeIds}) > 0)`
    ),
    check(
      'docker_availability_policies_generation_check',
      sql`${table.desiredGeneration} >= 1 AND ${table.offlineReplacementGraceSeconds} BETWEEN 0 AND 3600`
    ),
    check(
      'docker_availability_policies_priority_check',
      sql`${table.failbackDelaySeconds} BETWEEN 0 AND 3600 AND (NOT ${table.priorityMode} OR cardinality(${table.nodePriority}) > 0)`
    ),
    check('docker_availability_policies_partition_mode_check', sql`${table.partitionMode} IN ('strict', 'available')`),
    uniqueIndex('docker_availability_policies_container_unique')
      .on(table.sourceNodeId, table.containerName)
      .where(sql`${table.resourceKind} = 'container'`),
    uniqueIndex('docker_availability_policies_deployment_unique')
      .on(table.deploymentId)
      .where(sql`${table.resourceKind} = 'deployment'`),
    uniqueIndex('docker_availability_policies_compose_unique')
      .on(table.composeProjectId)
      .where(sql`${table.resourceKind} = 'compose'`),
    index('docker_availability_policies_status_idx').on(table.status, table.updatedAt),
  ]
);

export const dockerAvailabilityPlacements = pgTable(
  'docker_availability_placements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => dockerAvailabilityPolicies.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    generation: integer('generation').notNull(),
    desiredState: varchar('desired_state', { length: 32 })
      .$type<DockerAvailabilityPlacementDesiredState>()
      .notNull()
      .default('stopped'),
    actualState: varchar('actual_state', { length: 32 })
      .$type<DockerAvailabilityPlacementActualState>()
      .notNull()
      .default('pending'),
    serving: boolean('serving').notNull().default(false),
    specFingerprint: text('spec_fingerprint').notNull(),
    imageReference: text('image_reference'),
    composeRevisionId: uuid('compose_revision_id').references(() => dockerComposeRevisions.id, {
      onDelete: 'set null',
    }),
    runtimeIdentity: jsonb('runtime_identity').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Prefix of the copy's runtime names on a node other than its workload's: `opfav`; placements created before
     * 2.12.1 keep `gwav`, the names their containers, networks and Compose projects already have (migration 0250).
     */
    runtimeNamePrefix: varchar('runtime_name_prefix', { length: 16 }).notNull().default('opfav'),
    dependencyState: varchar('dependency_state', { length: 32 })
      .$type<DockerAvailabilityDependencyState>()
      .notNull()
      .default('pending'),
    applicationHealth: varchar('application_health', { length: 32 })
      .$type<DockerAvailabilityHealthState>()
      .notNull()
      .default('unknown'),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
    unavailableSince: timestamp('unavailable_since', { withTimezone: true }),
    operationId: uuid('operation_id'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('docker_availability_placements_generation_check', sql`${table.generation} >= 1`),
    check(
      'docker_availability_placements_serving_state_check',
      sql`NOT ${table.serving} OR ${table.actualState} = 'serving'`
    ),
    uniqueIndex('docker_availability_placements_policy_node_unique').on(table.policyId, table.nodeId),
    index('docker_availability_placements_policy_state_idx').on(table.policyId, table.actualState),
    index('docker_availability_placements_node_state_idx').on(table.nodeId, table.actualState),
  ]
);

export const dockerAvailabilityOperations = pgTable(
  'docker_availability_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => dockerAvailabilityPolicies.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).$type<DockerAvailabilityOperationType>().notNull(),
    status: varchar('status', { length: 32 }).$type<DockerAvailabilityOperationStatus>().notNull().default('pending'),
    phase: varchar('phase', { length: 32 }).$type<DockerAvailabilityOperationPhase>().notNull().default('queued'),
    targetGeneration: integer('target_generation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedPolicy: jsonb('requested_policy').$type<Record<string, unknown>>().notNull().default({}),
    progress: jsonb('progress').$type<DockerAvailabilityOperationProgress>().notNull().default({}),
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamp('lease_heartbeat_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    retryAttempts: integer('retry_attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    retryOfOperationId: uuid('retry_of_operation_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check('docker_availability_operations_generation_check', sql`${table.targetGeneration} >= 1`),
    uniqueIndex('docker_availability_operations_idempotency_unique').on(table.idempotencyKey),
    index('docker_availability_operations_policy_created_idx').on(table.policyId, table.createdAt),
    index('docker_availability_operations_status_lease_idx').on(table.status, table.leaseExpiresAt),
  ]
);
