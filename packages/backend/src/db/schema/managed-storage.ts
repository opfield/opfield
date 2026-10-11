import { sql } from 'drizzle-orm';
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
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
// Side-effect import, load-order fix: `certificates.ts` and
// `certificate-templates.ts` form a circular dependency (certificates ->
// certificate-templates -> certificates) that only evaluates safely when
// certificate-templates.ts starts loading first — schema/index.ts's
// alphabetical export order happens to sequence it that way. Any module
// (like this one) that imports `certificates.js` directly, outside the
// barrel, must force the same safe order or `certTypeEnum` is read before
// it's assigned.
import './certificate-templates.js';
import { certificates } from './certificates.js';
import { nodes } from './nodes.js';
import { objectStorageConnections } from './object-storage.js';
import { users } from './users.js';

// `objectStorageConnectionOriginEnum` lives in object-storage.ts (see the
// comment there) rather than here. It is not re-exported from this module:
// both this file and object-storage.ts are re-exported via `export *` from
// the schema barrel (./index.ts), and a re-export here would collide with
// object-storage.ts's own export of the same name.

/**
 * The object storage server a managed cluster runs. `seaweedfs` is the only
 * engine new clusters are created with; `minio` rows are legacy clusters that
 * stay manageable on their cached image (see `MANAGED_STORAGE_CATALOG`).
 */
export const managedStorageEngineEnum = pgEnum('managed_storage_engine', ['minio', 'seaweedfs']);

export type ManagedStorageEngine = (typeof managedStorageEngineEnum.enumValues)[number];

export const managedStorageStatusEnum = pgEnum('managed_storage_status', [
  'creating',
  'updating',
  'ready',
  // Paused by an app shutdown (docker pause); restart and update are refused while paused.
  'paused',
  'stopped',
  'error',
  'deleting',
]);

export interface ManagedStorageRuntimeConfig {
  nanoCPUs?: number;
  cpuShares?: number;
  memoryLimitBytes?: number;
  memorySwapBytes?: number;
  pidsLimit?: number;
}

export interface ManagedStoragePendingOperation {
  id: string;
  action: 'create' | 'update' | 'restart' | 'delete';
  /**
   * An update that changes the S3 publication: the publication before it. Its
   * ports stay reserved (held) until the daemon confirms the change, and are
   * restored when the update fails.
   */
  previousPorts?: { publishS3: boolean; publishedPort: number };
  /**
   * An update: the disk size and resources before it. A failed update puts
   * them back, so the cluster shows what its node applied and a retry is
   * checked against that.
   */
  previousSettings?: { storageSizeBytes: number; runtimeConfig: ManagedStorageRuntimeConfig };
  /**
   * An update: the status before it. An update the node refused before it
   * changed anything (too little disk, a size below the applied one) puts it
   * back, so a serving cluster stays ready and keeps its links.
   */
  previousStatus?: string;
}

export interface ManagedStorageErasureConfig {
  nodeCount: number;
  drivesPerNode: number;
}

export const managedStorageMemberStatusEnum = pgEnum('managed_storage_member_status', [
  'pending',
  'ready',
  'error',
  'removing',
]);

/**
 * Deployment and storage state for a managed object storage cluster (SeaweedFS,
 * or a legacy MinIO cluster). The linked object_storage_connections row is the
 * canonical user-facing resource; this table only owns the storage-node
 * lifecycle. Mirrors `managedDatabaseInstances` in databases.ts, with
 * storage-specific columns in place of database engine config: no
 * `publishedNativePort`, no `engineConfig` (neither engine needs any beyond
 * root credentials + size).
 */
export const managedStorageClusters = pgTable(
  'managed_storage_clusters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectStorageConnectionId: uuid('object_storage_connection_id').references(() => objectStorageConnections.id, {
      onDelete: 'restrict',
    }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    // Rows created before SeaweedFS existed are MinIO clusters, hence the default.
    engine: managedStorageEngineEnum('engine').notNull().default('minio'),
    // Version key into MANAGED_STORAGE_CATALOG[engine].
    version: varchar('version', { length: 128 }).notNull(),
    imageRef: varchar('image_ref', { length: 512 }).notNull(),
    // {username(accessKey),password(secretKey)} JSON, encryptString'd.
    encryptedRootCredentials: text('encrypted_root_credentials').notNull(),
    storageSizeBytes: bigint('storage_size_bytes', { mode: 'number' }).notNull(),
    runtimeConfig: jsonb('runtime_config').$type<ManagedStorageRuntimeConfig>().notNull().default({}),
    erasureConfig: jsonb('erasure_config')
      .$type<ManagedStorageErasureConfig>()
      .notNull()
      .default({ nodeCount: 1, drivesPerNode: 1 }),
    // S3 API host port (fixed — required at create; container 9000/tcp).
    publishS3: boolean('publish_s3').notNull().default(false),
    publishedPort: integer('published_port').notNull(),
    status: managedStorageStatusEnum('status').notNull().default('creating'),
    tlsEnabled: boolean('tls_enabled').notNull().default(false),
    // A relay create forces `tlsEnabled` too (see `ManagedStorageService.create`) — the
    // S3 client verifies the container's cert over the gateway-local loopback leg opened
    // by `ManagedStorageTunnelProxy`. Default false ⇒ every existing/non-relay cluster is
    // unaffected: the direct `host:publishedPort` endpoint path stays byte-identical.
    relayEnabled: boolean('relay_enabled').notNull().default(false),
    certificateId: uuid('certificate_id').references(() => certificates.id, { onDelete: 'restrict' }),
    // Opt-in exposure of MinIO's built-in SFTP server (see
    // `StorageWorkloadDispatch.renderCommandPayload`'s `--sftp=...` flag).
    // Legacy MinIO only: SeaweedFS clusters are created without SFTP/FTP.
    // Default false ⇒ every existing/non-SFTP cluster is unaffected: no
    // `--sftp` flag, no extra port binding, no host-key staged_mounts entry.
    // `sftpPort` is operator-supplied at create time (same no-conflict-check
    // model as `publishedPort` — see `CreateManagedStorageSchema`) and is
    // only ever non-null when `sftpEnabled`. `encryptedSftpHostKey` holds a
    // Gateway-generated SSH host key private PEM
    // (`CryptoService.generateKeyPair('ecdsa-p256')`), envelope-encrypted
    // with `CryptoService.encryptString` exactly like
    // `encryptedRootCredentials` — decrypted only at dispatch time to stage
    // it into the container, never logged, never returned by any view.
    sftpEnabled: boolean('sftp_enabled').notNull().default(false),
    sftpPort: integer('sftp_port'),
    encryptedSftpHostKey: text('encrypted_sftp_host_key'),
    // Opt-in exposure of MinIO's built-in FTP server (see
    // `StorageWorkloadDispatch.renderCommandPayload`'s `--ftp=...` flags).
    // Default false ⇒ every existing/non-FTP cluster is unaffected: no
    // `--ftp` flags, no extra port bindings, no new staged_mounts entry.
    // Unlike SFTP, FTP has no host-key concept — auth is the same IAM
    // access-key credentials, and FTPS auto-reuses the TLS certs already
    // staged when `tlsEnabled` (MinIO's `globalIsTLS` auto-detect), so no
    // `encryptedFtpHostKey`-shaped column exists here. `ftpPort` is the
    // operator-supplied host control port (container listens on a fixed
    // `:8021`); `ftpPassivePortStart` is the first of the passive-mode data
    // range (`start` .. `start + ftpPassivePortCount - 1`, host==container
    // for each, required by FTP's protocol — the server advertises its own
    // listening port number in the PASV response). Both are operator-supplied
    // (same no-conflict-check model as `publishedPort`/`sftpPort`) and only
    // ever non-null when `ftpEnabled`.
    ftpEnabled: boolean('ftp_enabled').notNull().default(false),
    ftpPort: integer('ftp_port'),
    ftpPassivePortStart: integer('ftp_passive_port_start'),
    // Size of the passive-mode data range (Phase 2b-viii Task 1). Nullable —
    // every effective-count read site uses `ftpPassivePortCount ?? 10`, so a
    // pre-existing FTP-enabled row (created before this column existed, thus
    // still `null`) keeps its byte-identical 10-port behavior with no
    // backfill needed. Only ever non-null when `ftpEnabled` for rows created
    // after this column shipped (see `ManagedStorageService.create`, which
    // persists an explicit `10` default rather than leaving it null).
    ftpPassivePortCount: integer('ftp_passive_port_count'),
    pendingOperation: jsonb('pending_operation').$type<ManagedStoragePendingOperation>(),
    lastError: text('last_error'),
    // Migration write freeze (`freeze_writes`): while set, every access key and
    // workload-link key Gateway issued on this cluster is read-only, including
    // keys issued during the freeze. The root identity keeps writing, so a
    // server-side copy still works. Cleared by `unfreeze_writes`.
    writesFrozenAt: timestamp('writes_frozen_at', { withTimezone: true }),
    writesFrozenById: uuid('writes_frozen_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    objectStorageConnectionUnique: unique('managed_storage_clusters_object_storage_connection_unique').on(
      table.objectStorageConnectionId
    ),
    nodeIdx: index('managed_storage_clusters_node_idx').on(table.nodeId),
    statusIdx: index('managed_storage_clusters_status_idx').on(table.status),
    slugUnique: unique('managed_storage_clusters_slug_unique').on(table.slug),
    // One cluster per name on a node (409 MANAGED_STORAGE_NAME_IN_USE); a
    // cluster being deleted no longer holds its name.
    nodeNameActiveUnique: uniqueIndex('managed_storage_clusters_node_name_active_unique')
      .on(table.nodeId, table.name)
      .where(sql`${table.status} <> 'deleting'`),
  })
);

export type ManagedStorageClusterRow = typeof managedStorageClusters.$inferSelect;

/**
 * A single storage node's membership in a managed storage cluster. One row per
 * node participating in the cluster, ordered by `memberIndex` (0-based, stable
 * — matches the legacy MinIO server pool argument order). Single-node clusters,
 * which includes every SeaweedFS cluster, have exactly one member row.
 */
export const managedStorageClusterMembers = pgTable(
  'managed_storage_cluster_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => managedStorageClusters.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    memberIndex: integer('member_index').notNull(),
    drives: integer('drives').notNull().default(1),
    status: managedStorageMemberStatusEnum('status').notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clusterIdx: index('managed_storage_cluster_members_cluster_idx').on(table.clusterId),
    clusterMemberIndexUnique: unique('managed_storage_cluster_members_cluster_id_member_index_unique').on(
      table.clusterId,
      table.memberIndex
    ),
  })
);

export type ManagedStorageClusterMemberRow = typeof managedStorageClusterMembers.$inferSelect;

/**
 * One IAM access key issued for a managed storage cluster, created via the
 * daemon's managed-storage `create_key` IAM action (see
 * `NodeDispatchService.sendDockerStorageIamCommand`). On a legacy MinIO
 * cluster the key is a service account of the root user (madmin-go against
 * the cluster's admin API); on SeaweedFS it belongs to its own IAM user,
 * `principal`, which carries the key's policy. This table is the source of
 * truth for a key's display `name`/ownership/existence from Gateway's side;
 * the storage server is the source of truth for whether the key still
 * works. `encryptedSecretKey` holds the one-shot-revealed secret
 * (`CryptoService.encryptString`'d, mirroring
 * `managedStorageClusters.encryptedRootCredentials`) purely so a future
 * re-reveal could be added later — today's `createAccessKey` returns the
 * plaintext secret exactly once and no read path decrypts it back out.
 */
export const managedStorageAccessKeys = pgTable(
  'managed_storage_access_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => managedStorageClusters.id, { onDelete: 'cascade' }),
    // Server-generated (or Gateway-chosen) access key id — an identifier,
    // not a secret; safe to store and return in plaintext from `listAccessKeys`.
    accessKeyId: varchar('access_key_id', { length: 128 }).notNull(),
    // SeaweedFS only: the IAM user (`gw-<key row id>`) that owns this key and
    // its policy. Revoking the key deletes the whole principal. Null on
    // MinIO keys, which are service accounts of the root user.
    principal: varchar('principal', { length: 128 }),
    encryptedSecretKey: text('encrypted_secret_key').notNull(),
    name: varchar('name', { length: 255 }),
    // The access level and bucket scope this key's inline IAM policy grants
    // (Phase 2b-vii Task 2 — see `buildManagedStoragePolicy` in
    // `managed-storage-iam-policy.ts`). Persisted purely as a display/audit
    // summary of what was dispatched at create time; the storage server's
    // own policy remains the source of truth for what the key can actually
    // do. `access` is nullable so pre-Phase-2b-vii rows (created
    // before this column existed) don't need a backfill; `buckets` defaults
    // to `[]` (all buckets) matching `createAccessKey`'s own default.
    access: varchar('access', { length: 16 }),
    buckets: jsonb('buckets').$type<string[]>().notNull().default([]),
    // Optional expiration (Phase 2b-ix): when set, the storage server
    // invalidates the key after this instant (a MinIO service account, or a
    // SeaweedFS service account of `principal`). Null means the key never
    // expires. Display source of truth — the server enforces the expiry.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clusterIdx: index('managed_storage_access_keys_cluster_idx').on(table.clusterId),
    clusterAccessKeyUnique: unique('managed_storage_access_keys_cluster_id_access_key_id_unique').on(
      table.clusterId,
      table.accessKeyId
    ),
  })
);

export type ManagedStorageAccessKeyRow = typeof managedStorageAccessKeys.$inferSelect;

export const storageBindingTargetTypeEnum = pgEnum('storage_binding_target_type', ['container', 'deployment']);
export const storageBindingStatusEnum = pgEnum('storage_binding_status', ['creating', 'ready', 'error', 'deleting']);

/**
 * Whether a ready link already reached the workload's runtime. `target_applied`: the link is saved in the
 * workload's desired configuration (a deployment's config, a container's secrets) and takes effect when the
 * workload is next created, started or rolled out. `active`: the running (or stopped) runtime carries it.
 */
export type ManagedStorageBindingObservedState = 'target_applied' | 'active';

/** Environment variable names a binding injects into its target workload. */
export interface StorageBindingEnvironment {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  region?: string;
}

/**
 * One application's private route to a managed storage cluster.
 *
 * Structurally the managed-database binding's twin: a connector sidecar on the
 * target node fronts the cluster inside a private network, and the app reaches
 * it by alias. What differs is the credential — S3 has no per-binding database
 * user, so a binding owns a scoped IAM access key (see
 * managed_storage_access_keys) restricted to its buckets.
 */
export const managedStorageBindings = pgTable(
  'managed_storage_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => managedStorageClusters.id, { onDelete: 'cascade' }),
    targetNodeId: uuid('target_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    targetType: storageBindingTargetTypeEnum('target_type').notNull(),
    targetResourceId: varchar('target_resource_id', { length: 255 }).notNull(),
    networkName: varchar('network_name', { length: 128 }).notNull(),
    connectorName: varchar('connector_name', { length: 128 }).notNull(),
    connectorAlias: varchar('connector_alias', { length: 128 }).notNull(),
    environment: jsonb('environment').$type<StorageBindingEnvironment>().notNull(),
    // The IAM access key issued for this binding. Kept as a column rather than
    // a FK so revoking the key on the cluster cannot orphan the binding row
    // before its own teardown runs.
    accessKeyId: varchar('access_key_id', { length: 255 }),
    // SeaweedFS only: the IAM user that owns the binding's key and policy;
    // teardown deletes the whole principal. Null for legacy MinIO bindings.
    principal: varchar('principal', { length: 128 }),
    buckets: jsonb('buckets').$type<string[]>().notNull().default([]),
    status: storageBindingStatusEnum('status').notNull().default('creating'),
    observedState: varchar('observed_state', { length: 32 })
      .$type<ManagedStorageBindingObservedState>()
      .notNull()
      .default('active'),
    // Per node: the link's consumers still need their one recreate after its sidecar went, so they resolve the alias
    // through the shared connector anew (D8, R2); durable across restarts. Any entry counts (earlier releases left a
    // cutover time or an address here).
    sidecarCutovers: jsonb('sidecar_cutovers').$type<Record<string, string>>().notNull().default({}),
    lastError: text('last_error'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clusterIdx: index('managed_storage_bindings_cluster_idx').on(table.clusterId),
    targetNodeIdx: index('managed_storage_bindings_target_node_idx').on(table.targetNodeId),
    targetUnique: unique('managed_storage_bindings_target_unique').on(
      table.clusterId,
      table.targetNodeId,
      table.targetType,
      table.targetResourceId
    ),
  })
);

export type ManagedStorageBindingRow = typeof managedStorageBindings.$inferSelect;
