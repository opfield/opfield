import { isNull, sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  HostingFirewallConfig,
  HostingFirewallObservation,
} from '../../modules/hosting/hosting-firewall.types.js';
import type {
  HostingOperationAction,
  HostingOperationPhase,
  HostingProvider,
  HostingProviderOperation,
  HostingResourceKind,
  HostingResourceSnapshot,
} from '../../modules/hosting/hosting-provider.types.js';
import type { HostingVmSnapshot } from '../../modules/hosting/hosting-snapshot.types.js';
import { integrationConnectors } from './integration-connectors.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

/** Provider resources survive removal of an Opfield node/connector. No remote delete cascades. */
export const hostingResources = pgTable(
  'hosting_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id').references(() => integrationConnectors.id, { onDelete: 'set null' }),
    provider: text('provider').$type<HostingProvider>().notNull(),
    authority: text('authority').notNull(),
    remoteId: text('remote_id').notNull(),
    kind: text('kind').$type<HostingResourceKind>().notNull(),
    origin: text('origin').$type<'discovered' | 'created' | 'adopted'>().notNull().default('discovered'),
    managedHostIdentity: uuid('managed_host_identity'),
    incarnation: text('incarnation'),
    snapshot: jsonb('snapshot').$type<HostingResourceSnapshot>().notNull(),
    adoptionReason: text('adoption_reason'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    missingSince: timestamp('missing_since', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A confirmed provider deletion may later recycle a VMID. Keep the historical row immutable and
    // create a new resource identity for the new incarnation instead of rebinding its node history.
    uniqueIndex('hosting_resource_active_identity_unique')
      .on(table.provider, table.authority, table.kind, table.remoteId)
      .where(isNull(table.missingSince)),
    unique('hosting_resource_host_unique').on(table.managedHostIdentity),
    unique('hosting_resource_host_pair_unique').on(table.id, table.managedHostIdentity),
    index('hosting_resource_connector_idx').on(table.connectorId),
  ]
);

/** Several daemon roles may share a host; a different host cannot bind to the same resource. */
export const hostingNodeBindings = pgTable(
  'hosting_node_bindings',
  {
    nodeId: uuid('node_id')
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id').notNull(),
    hostIdentityId: uuid('host_identity_id').notNull(),
    evidenceType: text('evidence_type').notNull(),
    evidenceDigest: text('evidence_digest').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'hosting_binding_resource_host_fk',
      columns: [table.resourceId, table.hostIdentityId],
      foreignColumns: [hostingResources.id, hostingResources.managedHostIdentity],
    }).onDelete('cascade'),
    index('hosting_binding_resource_idx').on(table.resourceId),
  ]
);

/** Desired VM firewall state survives UI sessions and disabled policies. Redis holds only its read model. */
export const hostingFirewalls = pgTable('hosting_firewalls', {
  resourceId: uuid('resource_id')
    .primaryKey()
    .references(() => hostingResources.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(0),
  config: jsonb('config').$type<HostingFirewallConfig>().notNull(),
  status: text('status').$type<'loading' | 'pending' | 'applying' | 'ready' | 'failed'>().notNull().default('loading'),
  observation: jsonb('observation').$type<HostingFirewallObservation>(),
  expectedFingerprint: text('expected_fingerprint'),
  connectorRevision: text('connector_revision').notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  error: text('error'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  observedAt: timestamp('observed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hostingOperations = pgTable(
  'hosting_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id').references(() => integrationConnectors.id, { onDelete: 'set null' }),
    resourceId: uuid('resource_id').references(() => hostingResources.id, { onDelete: 'restrict' }),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').$type<HostingOperationAction>().notNull(),
    phase: text('phase').$type<HostingOperationPhase>().notNull().default('pending'),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    encryptedBootstrap: text('encrypted_bootstrap'),
    bootstrapExpiresAt: timestamp('bootstrap_expires_at', { withTimezone: true }),
    providerOperation: jsonb('provider_operation').$type<HostingProviderOperation>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    dispatchStartedAt: timestamp('dispatch_started_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    generation: integer('generation').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('hosting_operation_intent_unique').on(table.connectorId, table.action, table.idempotencyKey),
    uniqueIndex('hosting_operation_resource_active_unique')
      .on(table.resourceId)
      .where(sql`${table.phase} NOT IN ('ready', 'failed')`),
    // A new client UUID cannot bypass a still-unresolved identical paid intent.
    uniqueIndex('hosting_operation_request_active_unique')
      .on(table.connectorId, table.action, table.requestHash)
      .where(sql`${table.phase} NOT IN ('ready', 'failed')`),
    index('hosting_operation_due_idx').on(table.phase, table.nextPollAt),
    index('hosting_operation_actor_idx').on(table.actorId, table.createdAt),
  ]
);

/**
 * Durable VM snapshot identity. New rows begin with the client idempotency
 * UUID; provider IDs are attached later by the operation worker.
 */
export const hostingSnapshotEntities = pgTable(
  'hosting_snapshot_entities',
  {
    id: uuid('id').primaryKey(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => hostingResources.id, { onDelete: 'cascade' }),
    incarnation: text('incarnation').notNull(),
    // No FK: a pending entity is persisted before its operation row exists.
    operationId: uuid('operation_id'),
    providerSnapshotId: text('provider_snapshot_id'),
    fingerprint: text('fingerprint'),
    name: text('name').notNull(),
    status: text('status')
      .$type<'pending' | 'ready' | 'failed' | 'deleting' | 'deleted'>()
      .notNull()
      .default('pending'),
    includeRam: boolean('include_ram').notNull().default(false),
    data: jsonb('data').$type<HostingVmSnapshot>().notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    unique('hosting_snapshot_entity_provider_unique').on(table.resourceId, table.incarnation, table.providerSnapshotId),
    index('hosting_snapshot_entity_resource_incarnation_idx').on(table.resourceId, table.incarnation),
    index('hosting_snapshot_entity_operation_idx').on(table.operationId),
  ]
);
