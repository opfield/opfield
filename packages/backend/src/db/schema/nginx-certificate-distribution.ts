import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';

/** The source table that owns a TLS certificate's canonical material. */
export const nginxCertificateReferenceTypeEnum = pgEnum('nginx_certificate_reference_type', ['ssl', 'internal']);
export const nginxCertificateAssetFormatEnum = pgEnum('nginx_certificate_asset_format', ['legacy', 'v2']);
export const nginxCertificateAssetStateEnum = pgEnum('nginx_certificate_asset_state', [
  'migration_pending',
  'ready',
  'migration_failed',
]);
export const nginxCertificateReplicaStatusEnum = pgEnum('nginx_certificate_replica_status', [
  'pending',
  'ready',
  'failed',
  'daemon_update_required',
  'cleanup_pending',
]);
export const nginxProxyHostDeploymentStateEnum = pgEnum('nginx_proxy_host_deployment_state', [
  'candidate',
  'active',
  'superseded',
  'failed',
  'deleting',
]);

/**
 * Opfield-owned canonical material for a Proxy Host TLS reference.
 *
 * `referenceType`/`referenceId` intentionally stay polymorphic so legacy
 * direct PKI references can use the same distribution lifecycle as ordinary
 * SSL certificates. The encrypted key follows the existing envelope format.
 */
export const nginxCertificateAssets = pgTable(
  'nginx_certificate_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referenceType: nginxCertificateReferenceTypeEnum('reference_type').notNull(),
    referenceId: uuid('reference_id').notNull(),
    format: nginxCertificateAssetFormatEnum('format').notNull().default('v2'),
    state: nginxCertificateAssetStateEnum('state').notNull().default('ready'),

    // The canonical certificate, chain and private key are serialized into a
    // single envelope-encrypted payload. Keeping no PEM material in a
    // separate column prevents a database read from yielding a usable bundle.
    encryptedMaterial: text('encrypted_material'),
    encryptedDek: text('encrypted_dek'),
    dekIv: text('dek_iv'),
    fingerprint: varchar('fingerprint', { length: 128 }),
    version: varchar('version', { length: 128 }),

    migrationError: text('migration_error'),
    migratedAt: timestamp('migrated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    referenceUnique: uniqueIndex('nginx_certificate_assets_reference_unique').on(
      table.referenceType,
      table.referenceId
    ),
    stateIdx: index('nginx_certificate_assets_state_idx').on(table.state),
  })
);

/** Per-node desired and observed certificate replica state. */
export const nginxCertificateReplicas = pgTable(
  'nginx_certificate_replicas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => nginxCertificateAssets.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    desiredVersion: varchar('desired_version', { length: 128 }),
    appliedVersion: varchar('applied_version', { length: 128 }),
    observedFingerprint: varchar('observed_fingerprint', { length: 128 }),
    status: nginxCertificateReplicaStatusEnum('status').notNull().default('pending'),
    generation: integer('generation').notNull().default(0),
    lastError: text('last_error'),
    // Consecutive automatic repair failures; drives retry backoff and resets
    // once the replica is ready again.
    repairAttempts: integer('repair_attempts').notNull().default(0),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    cleanupAfter: timestamp('cleanup_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetNodeUnique: uniqueIndex('nginx_certificate_replicas_asset_node_unique').on(table.assetId, table.nodeId),
    nodeStatusIdx: index('nginx_certificate_replicas_node_status_idx').on(table.nodeId, table.status),
    cleanupIdx: index('nginx_certificate_replicas_cleanup_idx').on(table.cleanupAfter),
  })
);

/**
 * Immutable applied/candidate history used as the reference-count source for
 * replica cleanup and reconnect reconciliation. It is internal-only.
 */
export const nginxProxyHostDeployments = pgTable(
  'nginx_proxy_host_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Deliberately not a schema-level foreign key: proxy_hosts and
    // nginx_templates already form a legacy import cycle, and deployments
    // are explicitly retired before a host is deleted by ProxyService.
    hostId: uuid('host_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => nginxCertificateAssets.id, { onDelete: 'set null' }),
    generation: varchar('generation', { length: 128 }).notNull(),
    configContent: text('config_content').notNull(),
    state: nginxProxyHostDeploymentStateEnum('state').notNull().default('candidate'),
    lastError: text('last_error'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hostGenerationUnique: uniqueIndex('nginx_proxy_host_deployments_host_generation_unique').on(
      table.hostId,
      table.generation
    ),
    activeNodeIdx: index('nginx_proxy_host_deployments_node_state_idx').on(table.nodeId, table.state),
    assetStateIdx: index('nginx_proxy_host_deployments_asset_state_idx').on(table.assetId, table.state),
  })
);
