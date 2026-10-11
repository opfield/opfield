import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { certificates } from './certificates.js';
import { managedDatabaseInstances } from './databases.js';
import { managedStorageClusters } from './managed-storage.js';
import { nodes } from './nodes.js';
import { relayInstances } from './relay.js';

/**
 * Database and storage availability: an availability set per managed database or managed storage cluster. It has 2–5
 * members on storage-profile nodes (one per host). automatic: a stateful lease policy (lease v3) whose single slot is
 * the primary role; voters are the candidate member hosts plus witnesses. manual: exactly 2 members, no witness, the
 * primary is named by a Gateway-signed primary assignment (generation), never promoted automatically.
 */
export type ManagedAvailabilityOwnerKind = 'managed_database' | 'managed_storage';
export type ManagedAvailabilityEngine = 'postgres' | 'valkey' | 'clickhouse' | 'seaweedfs';
export type ManagedAvailabilityMode = 'automatic' | 'manual';
export type ManagedAvailabilityDurability = 'synchronous' | 'asynchronous';
/** auto: chosen by preflight from the measured member RTT; admin: set explicitly. */
export type ManagedAvailabilityDurabilitySource = 'auto' | 'admin';
export type ManagedAvailabilityState =
  | 'converting'
  | 'healthy'
  | 'degraded'
  | 'no_failover'
  | 'failing_over'
  | 'closing'
  | 'error';

export interface ManagedAvailabilityStateReason {
  code: string;
  message?: string;
  memberIds?: string[];
  nodeIds?: string[];
  relayIds?: string[];
  since?: string;
  /** Every current reason (the fields above repeat the most important one). */
  reasons?: Array<{
    code: string;
    message: string;
    memberIds?: string[];
    nodeIds?: string[];
    relayIds?: string[];
    since?: string;
  }>;
}

export type ManagedAvailabilityOperationKind =
  | 'create'
  | 'convert'
  | 'add_member'
  | 'remove_member'
  | 'switchover'
  | 'failback'
  | 'make_primary'
  | 'rebuild_member'
  | 'update_settings'
  | 'move_witness'
  | 'rolling_update'
  | 'disable';

/** The orchestrated operation a set runs, durable across Gateway restarts; the reconciler resumes it by step. */
export interface ManagedAvailabilityOperation {
  id: string;
  kind: ManagedAvailabilityOperationKind;
  step: string;
  startedAt: string;
  params: Record<string, unknown>;
  /** Who asked for it; null for operations the control plane starts itself (failback, witness re-placement). */
  userId?: string | null;
  stepStartedAt?: string;
  attempts?: number;
  lastError?: string | null;
  retryAt?: string | null;
  /** Bytes copied so far and expected, for seeding steps that report progress. */
  progress?: { doneBytes: number; totalBytes: number | null } | null;
}

export const managedAvailabilitySets = pgTable(
  'managed_availability_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerKind: varchar('owner_kind', { length: 24 }).$type<ManagedAvailabilityOwnerKind>().notNull(),
    ownerId: uuid('owner_id').notNull(),
    /**
     * The owner again as a foreign key of its own kind (the other one stays null), so deleting the managed database
     * or storage cluster deletes its set, members and witnesses.
     */
    managedDatabaseId: uuid('managed_database_id').references(() => managedDatabaseInstances.id, {
      onDelete: 'cascade',
    }),
    managedStorageClusterId: uuid('managed_storage_cluster_id').references(() => managedStorageClusters.id, {
      onDelete: 'cascade',
    }),
    engine: varchar('engine', { length: 16 }).$type<ManagedAvailabilityEngine>().notNull(),
    mode: varchar('mode', { length: 16 }).$type<ManagedAvailabilityMode>().notNull(),
    durability: varchar('durability', { length: 16 }).$type<ManagedAvailabilityDurability>().notNull(),
    durabilitySource: varchar('durability_source', { length: 8 })
      .$type<ManagedAvailabilityDurabilitySource>()
      .notNull()
      .default('auto'),
    syncDegradeAfterSeconds: integer('sync_degrade_after_seconds').notNull().default(10),
    maxLagBytes: bigint('max_lag_bytes', { mode: 'number' }).notNull().default(1048576),
    priorityMode: boolean('priority_mode').notNull().default(false),
    failbackDelaySeconds: integer('failback_delay_seconds').notNull().default(300),
    /** The lease policy of the current availability period (automatic mode); a fresh id on every enable (M10). */
    leasePolicyId: uuid('lease_policy_id'),
    primaryMemberId: uuid('primary_member_id'),
    primarySince: timestamp('primary_since', { withTimezone: true }),
    /** Manual mode: the generation of the Gateway-signed primary assignment; every switch increments it. */
    primaryGeneration: bigint('primary_generation', { mode: 'number' }).notNull().default(0),
    rttP50Ms: numeric('rtt_p50_ms', { precision: 8, scale: 2, mode: 'number' }),
    rttMeasuredAt: timestamp('rtt_measured_at', { withTimezone: true }),
    state: varchar('state', { length: 16 }).$type<ManagedAvailabilityState>().notNull().default('converting'),
    stateReason: jsonb('state_reason').$type<ManagedAvailabilityStateReason | null>(),
    operation: jsonb('operation').$type<ManagedAvailabilityOperation | null>(),
    /** Orders the member configuration: every change of members, settings or identities gets a higher revision. */
    configRevision: bigint('config_revision', { mode: 'number' }).notNull().default(0),
    /** Set-wide engine principals (for example the pg_rewind user), envelope-encrypted; one per availability period. */
    encryptedEngineCredentials: text('encrypted_engine_credentials'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('managed_availability_sets_owner_unique').on(table.ownerKind, table.ownerId),
    unique('managed_availability_sets_lease_policy_unique').on(table.leasePolicyId),
    check(
      'managed_availability_sets_owner_kind_check',
      sql`${table.ownerKind} IN ('managed_database', 'managed_storage')`
    ),
    check(
      'managed_availability_sets_owner_check',
      sql`(${table.ownerKind} = 'managed_database' AND ${table.managedDatabaseId} = ${table.ownerId} AND ${table.managedStorageClusterId} IS NULL) OR (${table.ownerKind} = 'managed_storage' AND ${table.managedStorageClusterId} = ${table.ownerId} AND ${table.managedDatabaseId} IS NULL)`
    ),
    check(
      'managed_availability_sets_engine_check',
      sql`${table.engine} IN ('postgres', 'valkey', 'clickhouse', 'seaweedfs')`
    ),
    check('managed_availability_sets_mode_check', sql`${table.mode} IN ('automatic', 'manual')`),
    check('managed_availability_sets_durability_check', sql`${table.durability} IN ('synchronous', 'asynchronous')`),
    check('managed_availability_sets_durability_source_check', sql`${table.durabilitySource} IN ('auto', 'admin')`),
    check(
      'managed_availability_sets_state_check',
      sql`${table.state} IN ('converting', 'healthy', 'degraded', 'no_failover', 'failing_over', 'closing', 'error')`
    ),
    check(
      'managed_availability_sets_settings_check',
      sql`${table.syncDegradeAfterSeconds} BETWEEN 1 AND 3600 AND ${table.maxLagBytes} >= 0 AND ${table.failbackDelaySeconds} >= 0 AND ${table.primaryGeneration} >= 0 AND ${table.configRevision} >= 0`
    ),
  ]
);

export type ManagedAvailabilityMemberDesiredState = 'member' | 'removing';
export type ManagedAvailabilityMemberRole = 'primary' | 'copy' | 'rebuilding' | 'fenced' | 'unknown';
export type ManagedAvailabilityMemberSyncState = 'sync' | 'async' | 'none';
export type ManagedAvailabilityMemberStatus = 'creating' | 'ready' | 'error' | 'removing';

/** Engine position as the member last reported it (lsn/timeline, offset/replid, zxid, volumes). */
export type ManagedAvailabilityEnginePosition = Record<string, string | number | boolean | null>;

/**
 * One copy of an availability set on a storage-profile node. Observed fields come from the member reports of the
 * node's daemon; the lease (automatic) or the primary assignment (manual) decides which member is primary, never this
 * table.
 */
export const managedAvailabilityMembers = pgTable(
  'managed_availability_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => managedAvailabilitySets.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    priority: integer('priority').notNull().default(0),
    /** Unique per set: the SeaweedFS snowflake id and the ClickHouse Keeper server id derive from it. */
    memberIndex: integer('member_index').notNull(),
    desiredState: varchar('desired_state', { length: 16 })
      .$type<ManagedAvailabilityMemberDesiredState>()
      .notNull()
      .default('member'),
    role: varchar('role', { length: 16 }).$type<ManagedAvailabilityMemberRole>().notNull().default('unknown'),
    eligible: boolean('eligible').notNull().default(false),
    eligibilityReason: varchar('eligibility_reason', { length: 64 }),
    lagBytes: bigint('lag_bytes', { mode: 'number' }),
    lagSeconds: numeric('lag_seconds', { precision: 12, scale: 3, mode: 'number' }),
    syncState: varchar('sync_state', { length: 16 })
      .$type<ManagedAvailabilityMemberSyncState>()
      .notNull()
      .default('none'),
    enginePosition: jsonb('engine_position').$type<ManagedAvailabilityEnginePosition | null>(),
    relayEndpointId: uuid('relay_endpoint_id'),
    certificateId: uuid('certificate_id').references(() => certificates.id, { onDelete: 'restrict' }),
    publishedPort: integer('published_port'),
    publishedNativePort: integer('published_native_port'),
    encryptedReplicationCredentials: text('encrypted_replication_credentials'),
    status: varchar('status', { length: 16 }).$type<ManagedAvailabilityMemberStatus>().notNull().default('creating'),
    lastError: text('last_error'),
    lastReportedAt: timestamp('last_reported_at', { withTimezone: true }),
    /** Data-plane time of the newest member event already ingested; replayed events repeat and are skipped. */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('managed_availability_members_set_node_unique').on(table.setId, table.nodeId),
    unique('managed_availability_members_set_index_unique').on(table.setId, table.memberIndex),
    index('managed_availability_members_node_idx').on(table.nodeId),
    check('managed_availability_members_desired_state_check', sql`${table.desiredState} IN ('member', 'removing')`),
    check(
      'managed_availability_members_role_check',
      sql`${table.role} IN ('primary', 'copy', 'rebuilding', 'fenced', 'unknown')`
    ),
    check('managed_availability_members_sync_state_check', sql`${table.syncState} IN ('sync', 'async', 'none')`),
    check(
      'managed_availability_members_status_check',
      sql`${table.status} IN ('creating', 'ready', 'error', 'removing')`
    ),
    check('managed_availability_members_index_check', sql`${table.memberIndex} BETWEEN 0 AND 1023`),
  ]
);

export type ManagedAvailabilityWitnessPurpose = 'lease' | 'keeper';
export type ManagedAvailabilityWitnessHostKind = 'relay' | 'node';
export type ManagedAvailabilityWitnessRole = 'active' | 'standby';
export type ManagedAvailabilityWitnessDesiredState = 'running' | 'standby' | 'removed';

/**
 * A witness of a set: a lease voter outside the member hosts (purpose lease), or a ClickHouse Keeper voter run by a
 * relay supervisor or as a container on a non-member docker node (purpose keeper).
 */
export const managedAvailabilityWitnesses = pgTable(
  'managed_availability_witnesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => managedAvailabilitySets.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 16 }).$type<ManagedAvailabilityWitnessPurpose>().notNull(),
    hostKind: varchar('host_kind', { length: 16 }).$type<ManagedAvailabilityWitnessHostKind>().notNull(),
    relayInstanceId: uuid('relay_instance_id').references(() => relayInstances.id, { onDelete: 'restrict' }),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    role: varchar('role', { length: 16 }).$type<ManagedAvailabilityWitnessRole>().notNull().default('active'),
    keeperServerId: integer('keeper_server_id'),
    /**
     * Keeper witnesses on a relay: the loopback port (39400-39499, unique per relay) the witness's Raft port listens on;
     * the relay serves the witness's relay-local endpoint there. Allocated with the witness's desired state.
     */
    relayLocalPort: integer('relay_local_port'),
    artifactVersion: varchar('artifact_version', { length: 64 }),
    artifactSha256: varchar('artifact_sha256', { length: 71 }),
    desiredState: varchar('desired_state', { length: 16 })
      .$type<ManagedAvailabilityWitnessDesiredState>()
      .notNull()
      .default('running'),
    observedState: varchar('observed_state', { length: 32 }),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('managed_availability_witnesses_set_idx').on(table.setId),
    index('managed_availability_witnesses_relay_idx').on(table.relayInstanceId),
    check('managed_availability_witnesses_purpose_check', sql`${table.purpose} IN ('lease', 'keeper')`),
    check(
      'managed_availability_witnesses_host_check',
      sql`(${table.hostKind} = 'relay' AND ${table.relayInstanceId} IS NOT NULL AND ${table.nodeId} IS NULL) OR (${table.hostKind} = 'node' AND ${table.nodeId} IS NOT NULL AND ${table.relayInstanceId} IS NULL)`
    ),
    check('managed_availability_witnesses_role_check', sql`${table.role} IN ('active', 'standby')`),
    check(
      'managed_availability_witnesses_desired_state_check',
      sql`${table.desiredState} IN ('running', 'standby', 'removed')`
    ),
    check(
      'managed_availability_witnesses_keeper_check',
      sql`(${table.purpose} = 'keeper') = (${table.keeperServerId} IS NOT NULL)`
    ),
  ]
);
