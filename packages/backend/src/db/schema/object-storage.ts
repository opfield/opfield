import {
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
import { objectStorageFolders } from './object-storage-folders.js';
import { users } from './users.js';

// `aws`…`other` and `seaweedfs` address S3-compatible object stores;
// `ftp`/`ftps`/`sftp` address file-protocol servers, which have no buckets,
// regions, or access keys. Both families share this table because a connection
// is the same thing to the rest of Opfield — a named, credentialed,
// health-checked place to read and write blobs. `isFileProtocolProvider` in
// object-storage-protocol.ts is the single place that decides which family a
// provider belongs to. `seaweedfs` (what new managed clusters register as) is
// appended last so its migration is a plain `ADD VALUE`.
export const objectStorageProviderEnum = pgEnum('object_storage_provider', [
  'aws',
  'cloudflare_r2',
  'minio',
  'other',
  'ftp',
  'ftps',
  'sftp',
  'seaweedfs',
]);
export const objectStorageHealthStatusEnum = pgEnum('object_storage_health_status', [
  'online',
  'offline',
  'degraded',
  'unknown',
]);
// Lives here (rather than in managed-storage.ts) because
// managed-storage.ts's managedStorageClusters references
// objectStorageConnections via a FK — defining the origin enum on the
// connections side and importing it into managed-storage.ts avoids a
// circular import between the two schema files.
export const objectStorageConnectionOriginEnum = pgEnum('object_storage_connection_origin', ['user', 'managed']);

export interface ObjectStorageHealthEntry {
  ts: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  responseMs?: number;
  slow?: boolean;
}

export const objectStorageConnections = pgTable(
  'object_storage_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 60 }).notNull(),
    provider: objectStorageProviderEnum('provider').notNull(),
    origin: objectStorageConnectionOriginEnum('origin').notNull().default('user'),
    description: text('description'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    endpoint: varchar('endpoint', { length: 512 }),
    // S3-only: file-protocol connections have neither, hence nullable.
    region: varchar('region', { length: 128 }),
    accessKeyId: varchar('access_key_id', { length: 255 }),
    defaultBucket: varchar('default_bucket', { length: 255 }),
    forcePathStyle: boolean('force_path_style').notNull().default(false),
    // File-protocol only (ftp/ftps/sftp); null for S3 connections.
    host: varchar('host', { length: 255 }),
    port: integer('port'),
    username: varchar('username', { length: 255 }),
    // Every remote path is resolved beneath this root, so a connection can be
    // confined to a subtree of the server.
    basePath: varchar('base_path', { length: 1024 }),
    // FTPS only: true = implicit TLS (usually port 990), false = explicit AUTH TLS.
    implicitTls: boolean('implicit_tls').notNull().default(false),
    encryptedConfig: text('encrypted_config').notNull(),
    healthStatus: objectStorageHealthStatusEnum('health_status').notNull().default('unknown'),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastError: text('last_error'),
    healthHistory: jsonb('health_history').$type<ObjectStorageHealthEntry[]>().notNull().default([]),
    folderId: uuid('folder_id').references(() => objectStorageFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerIdx: index('object_storage_connections_provider_idx').on(table.provider),
    healthIdx: index('object_storage_connections_health_idx').on(table.healthStatus),
    folderIdx: index('object_storage_connections_folder_idx').on(table.folderId),
    createdByIdx: index('object_storage_connections_created_by_idx').on(table.createdById),
    updatedByIdx: index('object_storage_connections_updated_by_idx').on(table.updatedById),
    slugUnique: unique('object_storage_connections_slug_unique').on(table.slug),
  })
);
