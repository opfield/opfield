import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';

export const relaySigningKeyStatusEnum = pgEnum('relay_signing_key_status', [
  'pending',
  'active',
  'verification_only',
  'retired',
]);

export const relayInstanceKindEnum = pgEnum('relay_instance_kind', ['local', 'remote']);
export const relayInstanceStateEnum = pgEnum('relay_instance_state', [
  'joining',
  'synchronizing',
  'ready',
  'draining',
  'offline',
  'error',
]);
export const relayAssignmentGenerationStateEnum = pgEnum('relay_assignment_generation_state', [
  'staging',
  'active',
  'draining',
  'retired',
  'failed',
]);
export const relayAssignmentRoleEnum = pgEnum('relay_assignment_role', ['primary', 'fallback', 'active']);
export const relayProbeStateEnum = pgEnum('relay_probe_state', ['pending', 'ready', 'failed']);
export const relayPoolUpdateStateEnum = pgEnum('relay_pool_update_state', [
  'preflight',
  'draining',
  'updating',
  'verifying',
  'paused',
  'rolling_back',
  'complete',
  'failed',
]);
export const relayPoolUpdateStepStateEnum = pgEnum('relay_pool_update_step_state', [
  'pending',
  'draining',
  'updating',
  'verifying',
  'ready',
  'rolling_back',
  'rolled_back',
  'failed',
  // A member that was not connected; a later run updates it once it reconnects.
  'skipped',
]);

/** A relay supervisor's local witness hosting state (decision 9 of the database availability plan). */
export type RelayWitnessHostingLocal = 'allowed' | 'protected_needs_opt_in' | 'disabled';

export interface RelayInstanceCapabilities {
  protocolMajor: number;
  features: string[];
  architecture?: string;
}

export interface RelayInstanceHealth {
  activeTunnels?: number;
  registeredEndpoints?: number;
  pressurePercent?: number;
  cpuPressurePercent?: number;
  memoryPressurePercent?: number;
  fdPressurePercent?: number;
  admissionState?: string;
  assignmentTunnels?: Array<{ endpointId: string; assignmentGeneration: number; activeTunnels: number }>;
  policySigningKeyIds?: string[];
  /** The relay's last reported problem, such as why it is not ready. */
  lastError?: string;
}

/**
 * One route tuple a relay may admit, as the policy snapshots built for it carried it. A tuple
 * missing from a later snapshot stays until the relay acknowledges that snapshot. A tuple Opfield
 * no longer allows (route deleted, or its generation or target endpoint generation changed) is a
 * revocation; unacknowledged past the deadline, the relay is stale for that route.
 */
export interface RelayPolicyRouteEntry {
  routeId: string;
  endpointId: string;
  routeGeneration: number;
  endpointGeneration: number;
  /** First pool revision built without this tuple (or issued after it was revoked). */
  removedAtRevision?: number;
  /** When Opfield first saw the tuple revoked while the relay could still admit it. */
  revokedAt?: string;
  /** When the relay missed the acknowledgement deadline for the revocation. */
  staleAt?: string;
}

export interface RelayManagedDatabaseListenerConfig {
  networkName: string;
  listenAddress: string;
  listenPort: number;
  allowedSources: string[];
}

/**
 * A connector egress listener on the source node of a link route: the shared secure-link connector joins
 * `networkName` with `alias` and accepts the link's workloads on `listenPort` (C2). Storage links originate TLS.
 */
export interface RelaySecureLinkEgressConfig {
  networkName: string;
  alias: string;
  listenPort: number;
  /** 0 = unlimited. */
  maxSessions: number;
  tlsCaPem?: string;
  tlsServerName?: string;
  /**
   * Database links: the daemon recreates the link's consumers without the host listener's ExtraHosts entry, so they
   * reach the alias through the connector. Set only once the egress listens for the route's generation (and on the
   * connector); absent while the egress is not ready and while reverting. Changing it keeps the route's generation.
   */
  consumersUseAlias?: boolean;
  /**
   * Storage links leaving their legacy sidecar: the connector is on the network and listens, but does not answer the
   * alias yet (the sidecar still does). Changing it keeps the route's generation.
   */
  aliasDisabled?: boolean;
  /**
   * The fixed IPv4 the connector takes on the link network: a legacy sidecar's address, so clients that resolved the
   * alias once (an nginx static proxy_pass) keep reaching it after the cutover. Changing it keeps the generation.
   */
  connectorAddress?: string;
}

export interface RelayArtifactDescriptor {
  version: string;
  digest: string;
  architecture?: string;
  image?: string;
  url?: string;
}

export const relayGrantSigningKeys = pgTable(
  'relay_grant_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: varchar('key_id', { length: 64 }).notNull(),
    publicKey: text('public_key').notNull(),
    encryptedPrivateKey: text('encrypted_private_key'),
    encryptedDek: text('encrypted_dek'),
    status: relaySigningKeyStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    verifyUntil: timestamp('verify_until', { withTimezone: true }),
    privateKeyDestroyedAt: timestamp('private_key_destroyed_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    // The first pool snapshot revision whose policySigningKeys/grantPublicKeys list carries this
    // key (while pending). A relay whose applied revision is at least this holds a snapshot that
    // already named the key. Null on rows created before this column existed; treated as
    // revision 0 (always satisfied) so an in-flight rotation is not stuck.
    publishedAtRevision: bigint('published_at_revision', { mode: 'number' }),
  },
  (table) => ({
    keyIdUnique: unique('relay_grant_signing_keys_key_id_unique').on(table.keyId),
    statusIdx: index('relay_grant_signing_keys_status_idx').on(table.status),
  })
);

export const relayPolicySigningKeys = pgTable(
  'relay_policy_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: varchar('key_id', { length: 64 }).notNull(),
    publicKey: text('public_key').notNull(),
    publicKeyFingerprint: varchar('public_key_fingerprint', { length: 71 }).notNull(),
    encryptedPrivateKey: text('encrypted_private_key'),
    encryptedDek: text('encrypted_dek'),
    status: relaySigningKeyStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    verifyUntil: timestamp('verify_until', { withTimezone: true }),
    privateKeyDestroyedAt: timestamp('private_key_destroyed_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => ({
    keyIdUnique: unique('relay_policy_signing_keys_key_id_unique').on(table.keyId),
    statusIdx: index('relay_policy_signing_keys_status_idx').on(table.status),
    // Exactly one key signs relay policy. Two active rows would make the signer
    // depend on row order and could hand relays a key they have never pinned.
    singleActiveIdx: uniqueIndex('relay_policy_signing_keys_single_active_idx')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
  })
);

export const relayPools = pgTable('relay_pools', {
  id: varchar('id', { length: 32 }).primaryKey(),
  opfieldHostIdentityId: uuid('host_identity_id').notNull().defaultRandom(),
  desiredPolicyRevision: bigint('desired_policy_revision', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * off: raw streams. enabling: the target accepts resumable streams, sources do not open them yet. on: both. rotating:
 * the target has the new key, sources still the previous one. disabling: sources open raw streams, the target still
 * accepts resumable ones.
 */
export type RelayRouteResumeState = 'off' | 'enabling' | 'on' | 'rotating' | 'disabling';

export const relayPolicyState = pgTable('relay_policy_state', {
  id: varchar('id', { length: 32 }).primaryKey(),
  opfieldInstanceId: uuid('instance_id').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  /**
   * The resumable relay stream (RSv1) secret every route resume key derives from, envelope-encrypted like the grant
   * signing keys. Created once by Opfield; relays never see it or the keys.
   */
  resumeSecretEncrypted: text('resume_secret_encrypted'),
  resumeSecretDek: text('resume_secret_dek'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const relayEndpoints = pgTable(
  'relay_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    activeAssignmentGeneration: bigint('active_assignment_generation', { mode: 'number' }).notNull().default(1),
    ownerKind: varchar('owner_kind', { length: 64 }).notNull(),
    ownerId: text('owner_id').notNull(),
    subjectKind: varchar('subject_kind', { length: 32 }).notNull(),
    subjectId: text('subject_id').notNull(),
    certificateSha256: varchar('certificate_sha256', { length: 71 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(256),
    /**
     * Relay-local endpoints (subject_kind relay_instance): the port on the relay's loopback its tunnels are served on,
     * in the witness range 39400-39499 (an availability set's ClickHouse Keeper witness). Null for every other endpoint.
     */
    relayLocalPort: integer('relay_local_port'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerUnique: unique('relay_endpoints_owner_unique').on(table.ownerKind, table.ownerId),
    subjectIdx: index('relay_endpoints_subject_idx').on(table.subjectKind, table.subjectId),
  })
);

export const relayRoutes = pgTable(
  'relay_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    ownerKind: varchar('owner_kind', { length: 64 }).notNull(),
    ownerId: text('owner_id').notNull(),
    sourceKind: varchar('source_kind', { length: 32 }).notNull(),
    sourceId: text('source_id').notNull(),
    sourceCertificateSha256: varchar('source_certificate_sha256', { length: 71 }).notNull(),
    targetEndpointId: uuid('target_endpoint_id')
      .notNull()
      .references(() => relayEndpoints.id, { onDelete: 'cascade' }),
    /**
     * Availability set member routes (owner kind `set_member:<parent kind>`): the route whose path this one repeats
     * toward another member's endpoint. Deleting the parent deletes its member routes.
     */
    parentRouteId: uuid('parent_route_id').references((): AnyPgColumn => relayRoutes.id, { onDelete: 'cascade' }),
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(16),
    maxFrameBytes: integer('max_frame_bytes')
      .notNull()
      .default(1024 * 1024),
    managedDatabaseListener: jsonb('managed_database_listener').$type<RelayManagedDatabaseListenerConfig>(),
    secureLinkEgress: jsonb('secure_link_egress').$type<RelaySecureLinkEgressConfig>(),
    /**
     * Resumable streams (RSv1): where the route is in the ordered enable/rotate/disable sequence (see
     * relay-stream-resume.ts), its current resume key version and the previous one the target keeps accepting.
     */
    resumeState: varchar('resume_state', { length: 16 }).$type<RelayRouteResumeState>().notNull().default('off'),
    keyVersion: bigint('key_version', { mode: 'number' }).notNull().default(1),
    prevKeyVersion: bigint('prev_key_version', { mode: 'number' }),
    keyRotatedAt: timestamp('key_rotated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One route per owner, except proxy Secure Links, storage links and container links: a route served by an
    // ingress group has one source (and so one route, connect grant and relay placement term) per member nginx node
    // for the same link endpoint, and a storage or container link of an Availability workload one per placement node.
    ownerUnique: uniqueIndex('relay_routes_owner_unique')
      .on(table.ownerKind, table.ownerId)
      .where(sql`${table.ownerKind} not in ('proxy_host_secure_link', 'managed_storage_binding', 'container_link')`),
    proxyLinkSourceUnique: uniqueIndex('relay_routes_proxy_link_source_unique')
      .on(table.ownerKind, table.ownerId, table.sourceKind, table.sourceId)
      .where(sql`${table.ownerKind} = 'proxy_host_secure_link'`),
    storageLinkSourceUnique: uniqueIndex('relay_routes_storage_link_source_unique')
      .on(table.ownerKind, table.ownerId, table.sourceKind, table.sourceId)
      .where(sql`${table.ownerKind} = 'managed_storage_binding'`),
    containerLinkSourceUnique: uniqueIndex('relay_routes_container_link_source_unique')
      .on(table.ownerKind, table.ownerId, table.sourceKind, table.sourceId)
      .where(sql`${table.ownerKind} = 'container_link'`),
    sourceIdx: index('relay_routes_source_idx').on(table.sourceKind, table.sourceId),
    targetIdx: index('relay_routes_target_idx').on(table.targetEndpointId),
    parentIdx: index('relay_routes_parent_idx').on(table.parentRouteId),
  })
);

export const dockerRegistryNodeBindings = pgTable(
  'docker_registry_node_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).$type<'builder' | 'runtime' | 'mirror'>().notNull(),
    repository: text('repository').notNull(),
    actions: text('actions').array().notNull(),
    contextKind: varchar('context_kind', { length: 32 })
      .$type<'build' | 'container' | 'deployment' | 'compose_project' | 'availability'>()
      .notNull(),
    contextId: text('context_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    contextUnique: unique('docker_registry_node_bindings_context_unique').on(
      table.nodeId,
      table.role,
      table.contextKind,
      table.contextId,
      table.repository
    ),
    nodeStatusIdx: index('docker_registry_node_bindings_node_status_idx').on(table.nodeId, table.status),
  })
);

export const relayInstances = pgTable(
  'relay_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: varchar('pool_id', { length: 32 })
      .notNull()
      .references(() => relayPools.id, { onDelete: 'cascade' }),
    kind: relayInstanceKindEnum('kind').notNull(),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    faultDomainId: uuid('fault_domain_id').notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    advertisedAddresses: text('advertised_addresses').array().notNull().default([]),
    servicePort: integer('service_port').notNull().default(9443),
    state: relayInstanceStateEnum('state').notNull().default('joining'),
    manualDrainStartedAt: timestamp('manual_drain_started_at', { withTimezone: true }),
    drainForcedAt: timestamp('drain_forced_at', { withTimezone: true }),
    /** When the current drain disconnects what is left; resumable streams leave before it. Null when not draining. */
    drainDeadlineAt: timestamp('drain_deadline_at', { withTimezone: true }),
    certificateIdentity: varchar('certificate_identity', { length: 255 }),
    certificateFingerprint: varchar('certificate_fingerprint', { length: 71 }),
    certificateExpiresAt: timestamp('certificate_expires_at', { withTimezone: true }),
    policySigningKeyId: varchar('policy_signing_key_id', { length: 64 }),
    policyPublicKeyFingerprint: varchar('policy_public_key_fingerprint', { length: 71 }),
    buildVersion: varchar('build_version', { length: 64 }),
    protocolMajor: integer('protocol_major'),
    capabilities: jsonb('capabilities').$type<RelayInstanceCapabilities>(),
    appliedPolicyRevision: bigint('applied_policy_revision', { mode: 'number' }).notNull().default(0),
    policyExpiresAt: timestamp('policy_expires_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    health: jsonb('health').$type<RelayInstanceHealth>(),
    desiredArtifact: jsonb('desired_artifact').$type<RelayArtifactDescriptor>(),
    /** Admin opt-in: this relay may host availability witnesses (lease voter, ClickHouse Keeper witness). */
    witnessHostingAllowed: boolean('witness_hosting_allowed').notNull().default(false),
    /**
     * What the relay supervisor last reported about local witness hosting: allowed, protected_needs_opt_in (a protected
     * relay without the local opt-in file) or disabled. Null until a supervisor that knows witnesses reported.
     */
    witnessHostingLocal: varchar('witness_hosting_local', { length: 32 }).$type<RelayWitnessHostingLocal>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    poolFaultDomainUnique: unique('relay_instances_pool_fault_domain_unique').on(table.poolId, table.faultDomainId),
    nodeUnique: unique('relay_instances_node_unique').on(table.nodeId),
    poolStateIdx: index('relay_instances_pool_state_idx').on(table.poolId, table.state),
    servicePortValid: check(
      'relay_instances_service_port_valid',
      sql`${table.servicePort} > 0 AND ${table.servicePort} <= 65535`
    ),
  })
);

/**
 * Per relay instance, Opfield-side policy bookkeeping written by snapshot builds: the route tuples
 * the relay may admit (see RelayPolicyRouteEntry) and the content key, revision and lease of the
 * last snapshot built for it, so an unchanged policy is not rebuilt under a new revision.
 *
 * Kept out of relay_instances, and without a foreign key to it, on purpose: builds write it under
 * the policy revision lock after a share lock on relay_policy_state, while other transactions lock
 * a relay_instances row and then bump relay_policy_state. Any relay_instances lock taken here
 * (a row update, or the key-share lock of a foreign key check) would deadlock with them. Rows of
 * removed relays are pruned by the revocation evaluator.
 */
export const relayInstancePolicyState = pgTable('relay_instance_policy_state', {
  instanceId: uuid('instance_id').primaryKey(),
  routes: jsonb('routes').$type<RelayPolicyRouteEntry[]>().notNull().default([]),
  snapshotKey: varchar('snapshot_key', { length: 64 }),
  snapshotRevision: bigint('snapshot_revision', { mode: 'number' }),
  snapshotIssuedAtUnix: bigint('snapshot_issued_at_unix', { mode: 'number' }),
  snapshotExpiresAtUnix: bigint('snapshot_expires_at_unix', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const relayEndpointAssignmentGenerations = pgTable(
  'relay_endpoint_assignment_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => relayEndpoints.id, { onDelete: 'cascade' }),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    state: relayAssignmentGenerationStateEnum('state').notNull().default('staging'),
    desiredRedundancy: integer('desired_redundancy').notNull().default(1),
    activationError: text('activation_error'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    drainStartedAt: timestamp('drain_started_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointGenerationUnique: unique('relay_assignment_generations_endpoint_generation_unique').on(
      table.endpointId,
      table.generation
    ),
    endpointStateIdx: index('relay_assignment_generations_endpoint_state_idx').on(table.endpointId, table.state),
    oneActivePerEndpoint: uniqueIndex('relay_assignment_generations_one_active_per_endpoint')
      .on(table.endpointId)
      .where(sql`${table.state} = 'active'`),
    desiredRedundancyValid: check(
      'relay_assignment_generations_desired_redundancy_valid',
      sql`${table.desiredRedundancy} > 0`
    ),
  })
);

export const relayEndpointAssignments = pgTable(
  'relay_endpoint_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentGenerationId: uuid('assignment_generation_id')
      .notNull()
      .references(() => relayEndpointAssignmentGenerations.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id')
      .notNull()
      .references(() => relayInstances.id, { onDelete: 'restrict' }),
    role: relayAssignmentRoleEnum('role').notNull(),
    targetRegistrationState: relayProbeStateEnum('target_registration_state').notNull().default('pending'),
    targetRegisteredAt: timestamp('target_registered_at', { withTimezone: true }),
    targetRegistrationError: text('target_registration_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generationInstanceUnique: unique('relay_endpoint_assignments_generation_instance_unique').on(
      table.assignmentGenerationId,
      table.relayInstanceId
    ),
    instanceIdx: index('relay_endpoint_assignments_instance_idx').on(table.relayInstanceId),
  })
);

export const relayAssignmentSourceProbes = pgTable(
  'relay_assignment_source_probes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentGenerationId: uuid('assignment_generation_id')
      .notNull()
      .references(() => relayEndpointAssignmentGenerations.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id')
      .notNull()
      .references(() => relayInstances.id, { onDelete: 'restrict' }),
    sourceKind: varchar('source_kind', { length: 32 }).notNull(),
    sourceId: uuid('source_id').notNull(),
    certificateFingerprint: varchar('certificate_fingerprint', { length: 71 }).notNull(),
    state: relayProbeStateEnum('state').notNull().default('pending'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generationSourceInstanceUnique: unique('relay_source_probes_generation_source_instance_unique').on(
      table.assignmentGenerationId,
      table.sourceKind,
      table.sourceId,
      table.relayInstanceId
    ),
    generationStateIdx: index('relay_source_probes_generation_state_idx').on(table.assignmentGenerationId, table.state),
  })
);

export const relayPoolUpdateRuns = pgTable(
  'relay_pool_update_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: varchar('pool_id', { length: 32 })
      .notNull()
      .references(() => relayPools.id, { onDelete: 'cascade' }),
    state: relayPoolUpdateStateEnum('state').notNull().default('preflight'),
    targetArtifact: jsonb('target_artifact').$type<RelayArtifactDescriptor>().notNull(),
    compatibility: jsonb('compatibility').$type<Record<string, unknown>>(),
    forceDisconnectApproved: boolean('force_disconnect_approved').notNull().default(false),
    terminalError: text('terminal_error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    poolStateIdx: index('relay_pool_update_runs_pool_state_idx').on(table.poolId, table.state),
    oneActiveRunPerPool: uniqueIndex('relay_pool_update_runs_one_active_per_pool')
      .on(table.poolId)
      .where(sql`${table.state} in ('preflight', 'draining', 'updating', 'verifying', 'paused', 'rolling_back')`),
  })
);

export const relayPoolUpdateSteps = pgTable(
  'relay_pool_update_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => relayPoolUpdateRuns.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id')
      .notNull()
      .references(() => relayInstances.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    state: relayPoolUpdateStepStateEnum('state').notNull().default('pending'),
    previousArtifact: jsonb('previous_artifact').$type<RelayArtifactDescriptor>(),
    targetArtifact: jsonb('target_artifact').$type<RelayArtifactDescriptor>().notNull(),
    drainDeadlineAt: timestamp('drain_deadline_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runInstanceUnique: unique('relay_pool_update_steps_run_instance_unique').on(table.runId, table.relayInstanceId),
    runSequenceUnique: unique('relay_pool_update_steps_run_sequence_unique').on(table.runId, table.sequence),
  })
);
