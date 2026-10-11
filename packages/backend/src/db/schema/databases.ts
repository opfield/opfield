import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { certificates } from './certificates.js';
import { databaseConnectionFolders } from './database-connection-folders.js';
import { dockerAvailabilityPlacements } from './docker-availability.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

export const databaseTypeEnum = pgEnum('database_type', ['postgres', 'redis', 'clickhouse']);
export const databaseHealthStatusEnum = pgEnum('database_health_status', ['online', 'offline', 'degraded', 'unknown']);
export const managedDatabaseStatusEnum = pgEnum('managed_database_status', [
  'creating',
  'updating',
  'ready',
  'paused',
  'stopped',
  'error',
  'deleting',
]);
export const databaseBindingTargetTypeEnum = pgEnum('database_binding_target_type', [
  'container',
  'deployment',
  'compose_service',
]);
export const databaseBindingStatusEnum = pgEnum('database_binding_status', ['creating', 'ready', 'error', 'deleting']);

export interface DatabaseHealthEntry {
  ts: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  responseMs?: number;
  slow?: boolean;
}

export const databaseConnections = pgTable(
  'database_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    type: databaseTypeEnum('type').notNull(),
    description: text('description'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    host: varchar('host', { length: 255 }).notNull(),
    port: integer('port').notNull(),
    databaseName: varchar('database_name', { length: 255 }),
    username: varchar('username', { length: 255 }),
    tlsEnabled: boolean('tls_enabled').notNull().default(false),
    // Verify the server certificate chain and hostname whenever the connection
    // uses TLS. False is an explicit, insecure opt-out: external rows that used
    // TLS before this setting existed are backfilled to false so upgrades keep
    // connecting. Managed connections verify against the Gateway Database CA
    // independently of this column.
    tlsVerifyCertificate: boolean('tls_verify_certificate').notNull().default(true),
    // Optional PEM bundle trusted instead of the public CA bundle for this
    // connection (private CAs). A CA certificate is public material.
    tlsCaCertificate: text('tls_ca_certificate'),
    manualSizeLimitMb: integer('manual_size_limit_mb'),
    interactiveQueryBudgetSeconds: integer('interactive_query_budget_seconds').notNull().default(300),
    encryptedConfig: text('encrypted_config').notNull(),
    healthStatus: databaseHealthStatusEnum('health_status').notNull().default('unknown'),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastError: text('last_error'),
    healthHistory: jsonb('health_history').$type<DatabaseHealthEntry[]>().notNull().default([]),
    folderId: uuid('folder_id').references(() => databaseConnectionFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeIdx: index('database_connections_type_idx').on(table.type),
    healthIdx: index('database_connections_health_idx').on(table.healthStatus),
    folderIdx: index('database_connections_folder_idx').on(table.folderId),
    createdByIdx: index('database_connections_created_by_idx').on(table.createdById),
    updatedByIdx: index('database_connections_updated_by_idx').on(table.updatedById),
    slugUnique: unique('database_connections_slug_unique').on(table.slug),
  })
);

export interface ManagedDatabaseEngineConfig {
  databaseName?: string;
  ownerUsername: string;
  publishTcp?: boolean;
  publishNativeTcp?: boolean;
  clickhouseConfigXml?: string;
  redisConfig?: ManagedRedisConfig;
  postgresConfig?: ManagedPostgresConfig;
}

/** PostgreSQL server settings; absent means the engine defaults. */
export interface ManagedPostgresConfig {
  maxConnections: number;
}

export interface ManagedRedisConfig {
  maxmemoryPercent: number;
  maxmemoryPolicy:
    | 'noeviction'
    | 'allkeys-lru'
    | 'allkeys-lfu'
    | 'allkeys-random'
    | 'volatile-lru'
    | 'volatile-lfu'
    | 'volatile-random'
    | 'volatile-ttl';
  appendOnly: boolean;
  appendFsync: 'always' | 'everysec' | 'no';
  rdbSnapshotsEnabled: boolean;
  rdbSaveSeconds: number;
  rdbSaveChanges: number;
  autoAofRewritePercentage: number;
  autoAofRewriteMinSizeMb: number;
  maxclients: number;
  timeoutSeconds: number;
  tcpKeepaliveSeconds: number;
  slowlogThresholdMicroseconds: number;
  slowlogMaxLen: number;
  activeDefrag: boolean;
}

export interface ManagedDatabaseRuntimeConfig {
  nanoCPUs?: number;
  cpuShares?: number;
  memoryLimitBytes?: number;
  memorySwapBytes?: number;
  pidsLimit?: number;
}

export interface ManagedDatabasePendingOperation {
  id: string;
  action: 'create' | 'update' | 'restart' | 'pause' | 'unpause' | 'delete';
  /**
   * An update that moves the published ports: the ports before it. They stay
   * reserved (held) until the daemon confirms the move, and are restored when
   * the update fails.
   */
  previousPorts?: { publishedPort: number | null; publishedNativePort: number | null };
  /**
   * An update: the disk size and resources before it. A failed update puts
   * them back, so the database shows what its node applied and a retry is
   * checked against that.
   */
  previousSettings?: { storageSizeBytes: number; runtimeConfig: ManagedDatabaseRuntimeConfig };
  /**
   * An update: the status before it. An update the node refused before it
   * changed anything (too little disk, a size below the applied one) puts it
   * back, so a serving database stays ready and keeps its links.
   */
  previousStatus?: string;
}

export type ManagedDatabaseOwnerSeparationState = 'legacy' | 'preparing' | 'active' | 'error';
export type ManagedDatabaseBindingDesiredState = 'active' | 'suspended' | 'deleted';
export type ManagedDatabaseBindingObservedState =
  | 'legacy'
  | 'preparing'
  | 'principal_ready'
  | 'target_applied'
  | 'active'
  | 'disabled'
  | 'absent'
  | 'error';

/**
 * How a link's workloads reach the database on their node. `listener`: the daemon's host listener on the link
 * network's gateway IP, named through ExtraHosts (daemons without `secure_link_egress_v1`). `migrating`: the shared
 * connector serves the alias too while the workloads are recreated one at a time without ExtraHosts; the listener
 * keeps serving the ones not recreated yet. `connector`: only the connector serves it. `reverting`: the node lost
 * the capability (a daemon rollback); the listener is back and the workloads are recreated with ExtraHosts again.
 */
export type ManagedDatabaseLinkTransport = 'listener' | 'migrating' | 'connector' | 'reverting';

export interface DatabaseBindingEnvironment {
  connectionUri?: string;
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
}

/**
 * Deployment and storage state for a managed database. The linked
 * database_connections row is the canonical user-facing resource; this table
 * only owns the database-node lifecycle.
 */
export const managedDatabaseInstances = pgTable(
  'managed_database_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    databaseConnectionId: uuid('database_connection_id').references(() => databaseConnections.id, {
      onDelete: 'restrict',
    }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    type: databaseTypeEnum('type').notNull(),
    version: varchar('version', { length: 128 }).notNull(),
    imageRef: varchar('image_ref', { length: 512 }).notNull(),
    engineConfig: jsonb('engine_config').$type<ManagedDatabaseEngineConfig>().notNull(),
    encryptedOwnerCredentials: text('encrypted_owner_credentials').notNull(),
    // Direct TCP access uses its own least-privileged database principal.
    // The internal owner is never returned to clients.
    encryptedDirectCredentials: text('encrypted_direct_credentials'),
    // Managed ClickHouse Explorer/Console reads use a separate internal
    // principal. It is never included in a connection view or reveal flow.
    encryptedQueryCredentials: text('encrypted_query_credentials'),
    // Set only after the database daemon has converged the versioned
    // ClickHouse reader and writer principals. Non-admin access fails closed
    // until this marker is present.
    clickhouseQueryPrincipalVersion: integer('clickhouse_query_principal_version'),
    // Managed PostgreSQL stores its non-superuser read-only query principal in
    // encryptedQueryCredentials. Set only after the daemon has applied and
    // probed that role; until then reads fall back to a read-only transaction
    // with a server-function denylist on the owner connection.
    postgresQueryPrincipalVersion: integer('postgres_query_principal_version'),
    // Managed PostgreSQL non-superuser writer for write-scoped queries: a
    // member of the application role, never of the control owner. Set only
    // after the daemon has applied and probed it; until then write-scoped
    // queries run as the owner behind the server-function denylist.
    encryptedQueryWriterCredentials: text('encrypted_query_writer_credentials'),
    postgresQueryWriterVersion: integer('postgres_query_writer_version'),
    // Identity v2 separates the Gateway control account from the stable
    // application role used by direct-access and binding principals.
    bindingIdentityVersion: integer('binding_identity_version').notNull().default(0),
    applicationPrincipalName: varchar('application_principal_name', { length: 128 }),
    ownerSeparationState: varchar('owner_separation_state', { length: 32 })
      .$type<ManagedDatabaseOwnerSeparationState>()
      .notNull()
      .default('legacy'),
    ownerSeparationOperationId: uuid('owner_separation_operation_id'),
    encryptedPendingOwnerCredentials: text('encrypted_pending_owner_credentials'),
    directPrincipalVersion: integer('direct_principal_version').notNull().default(0),
    storageSizeBytes: bigint('storage_size_bytes', { mode: 'number' }).notNull(),
    runtimeConfig: jsonb('runtime_config').$type<ManagedDatabaseRuntimeConfig>().notNull().default({}),
    // Database TLS material exists independently from the direct-publication
    // toggle. The certificate's key is held only by Gateway and the daemon.
    certificateId: uuid('certificate_id').references(() => certificates.id, { onDelete: 'restrict' }),
    tlsEnabled: boolean('tls_enabled').notNull().default(true),
    publishedPort: integer('published_port'),
    // ClickHouse uses a second published endpoint for secure native TCP while
    // publishedPort remains the primary HTTPS endpoint for compatibility.
    publishedNativePort: integer('published_native_port'),
    status: managedDatabaseStatusEnum('status').notNull().default('creating'),
    pendingOperation: jsonb('pending_operation').$type<ManagedDatabasePendingOperation>(),
    lastError: text('last_error'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    databaseConnectionUnique: unique('managed_database_instances_database_connection_unique').on(
      table.databaseConnectionId
    ),
    nodeIdx: index('managed_database_instances_node_idx').on(table.nodeId),
    statusIdx: index('managed_database_instances_status_idx').on(table.status),
    slugUnique: unique('managed_database_instances_slug_unique').on(table.slug),
  })
);

/**
 * A scoped secure application path to a managed database. The encrypted
 * credential belongs to this binding, never to the target node or sidecar.
 */
export const managedDatabaseBindings = pgTable(
  'managed_database_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    managedDatabaseId: uuid('managed_database_id')
      .notNull()
      .references(() => managedDatabaseInstances.id, { onDelete: 'restrict' }),
    targetNodeId: uuid('target_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    targetType: databaseBindingTargetTypeEnum('target_type').notNull(),
    targetResourceId: varchar('target_resource_id', { length: 255 }).notNull(),
    networkName: varchar('network_name', { length: 128 }).notNull(),
    connectorName: varchar('connector_name', { length: 128 }).notNull(),
    connectorAlias: varchar('connector_alias', { length: 128 }).notNull(),
    // Stable endpoint identity for the connector on its dedicated binding
    // network. Target containers resolve connectorAlias through ExtraHosts,
    // so connector recreation must reclaim this exact address.
    connectorAddress: varchar('connector_address', { length: 45 }),
    environment: jsonb('environment').$type<DatabaseBindingEnvironment>().notNull(),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    pendingEncryptedCredentials: text('pending_encrypted_credentials'),
    principalName: varchar('principal_name', { length: 128 }),
    principalModelVersion: integer('principal_model_version').notNull().default(0),
    credentialGeneration: integer('credential_generation').notNull().default(0),
    principalOperationId: uuid('principal_operation_id'),
    desiredState: varchar('desired_state', { length: 32 })
      .$type<ManagedDatabaseBindingDesiredState>()
      .notNull()
      .default('active'),
    observedState: varchar('observed_state', { length: 32 })
      .$type<ManagedDatabaseBindingObservedState>()
      .notNull()
      .default('legacy'),
    // How the workload reaches the database (see ManagedDatabaseLinkTransport); durable migration state.
    linkTransport: varchar('link_transport', { length: 16 })
      .$type<ManagedDatabaseLinkTransport>()
      .notNull()
      .default('listener'),
    status: databaseBindingStatusEnum('status').notNull().default('creating'),
    lastError: text('last_error'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    managedDatabaseIdx: index('managed_database_bindings_database_idx').on(table.managedDatabaseId),
    targetNodeIdx: index('managed_database_bindings_target_node_idx').on(table.targetNodeId),
    targetUnique: unique('managed_database_bindings_target_unique').on(
      table.managedDatabaseId,
      table.targetNodeId,
      table.targetType,
      table.targetResourceId
    ),
  })
);

/**
 * Node-local materialization of one logical managed database binding. The
 * parent binding remains the only owner of credentials and environment names.
 */
export const managedDatabaseBindingPlacements = pgTable(
  'managed_database_binding_placements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => managedDatabaseBindings.id, { onDelete: 'cascade' }),
    availabilityPlacementId: uuid('availability_placement_id').references(() => dockerAvailabilityPlacements.id, {
      onDelete: 'cascade',
    }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    generation: integer('generation').notNull().default(1),
    networkName: varchar('network_name', { length: 128 }).notNull(),
    connectorName: varchar('connector_name', { length: 128 }).notNull(),
    connectorAlias: varchar('connector_alias', { length: 128 }).notNull(),
    connectorAddress: varchar('connector_address', { length: 45 }),
    relayEndpointId: uuid('relay_endpoint_id'),
    desiredState: varchar('desired_state', { length: 32 })
      .$type<ManagedDatabaseBindingDesiredState>()
      .notNull()
      .default('active'),
    observedState: varchar('observed_state', { length: 32 })
      .$type<ManagedDatabaseBindingObservedState>()
      .notNull()
      .default('legacy'),
    linkTransport: varchar('link_transport', { length: 16 })
      .$type<ManagedDatabaseLinkTransport>()
      .notNull()
      .default('listener'),
    status: databaseBindingStatusEnum('status').notNull().default('creating'),
    lastError: text('last_error'),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bindingNodeUnique: unique('managed_database_binding_placements_binding_node_unique').on(
      table.bindingId,
      table.nodeId
    ),
    availabilityPlacementUnique: unique('managed_database_binding_placements_availability_unique').on(
      table.bindingId,
      table.availabilityPlacementId
    ),
    bindingIdx: index('managed_database_binding_placements_binding_idx').on(table.bindingId),
    nodeStatusIdx: index('managed_database_binding_placements_node_status_idx').on(table.nodeId, table.status),
  })
);
