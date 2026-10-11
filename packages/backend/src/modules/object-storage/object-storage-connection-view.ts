import type { ManagedStorageClusterRow, ObjectStorageHealthEntry } from '@/db/schema/index.js';
import type { AppMemberRef } from '@/modules/apps/app-membership.js';
import type { StorageProvider } from './object-storage.schemas.js';
import { type FileProtocolProvider, isFileProtocolProvider } from './object-storage-protocol.js';

export type ObjectStorageConnectionOrigin = 'user' | 'managed';

export interface ObjectStorageManagedView {
  id: string;
  nodeId: string;
  /** `minio` marks a legacy cluster: manageable, but no longer creatable. */
  engine: 'minio' | 'seaweedfs';
  version: string;
  storageSizeBytes: number;
  runtimeConfig: { cpuCores: number; memoryMb: number; swapMb: number };
  publishS3?: boolean;
  publishedPort: number;
  status: 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'error' | 'deleting';
  lastError: string | null;
  /** Present while a migration write freeze keeps every issued key read-only. */
  writesFrozenAt?: string;
}

export type ObjectStorageHealthStatus = 'online' | 'offline' | 'degraded' | 'unknown';

/** Encrypted portion of an S3 connection — never returned in plaintext unless revealed. */
export interface S3SecretConfig {
  secretAccessKey: string;
  sessionToken?: string | null;
}

/** Encrypted portion of a file-protocol (ftp/ftps/sftp) connection. */
export interface FileProtocolSecretConfig {
  hostKeyFingerprint?: string | null;
  password?: string | null;
  /** SFTP key-based auth; an alternative to `password`, not an addition. */
  privateKey?: string | null;
  passphrase?: string | null;
  /** Pins a private CA for FTPS instead of the system trust store. */
  caPem?: string | null;
}

/**
 * What `encrypted_config` actually holds. Which fields are populated depends on
 * the provider family, so every one is optional at rest.
 */
export type StoredSecretConfig = Partial<S3SecretConfig> & FileProtocolSecretConfig;

/** Full resolved connection config (columns + decrypted secret). */
export interface S3ConnectionConfig extends S3SecretConfig {
  provider: StorageProvider;
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  defaultBucket: string | null;
  forcePathStyle: boolean;
}

/** Full resolved config for an ftp/ftps/sftp connection. */
export interface FileProtocolConnectionConfig extends FileProtocolSecretConfig {
  provider: FileProtocolProvider;
  host: string;
  port: number;
  username: string;
  basePath: string | null;
  implicitTls: boolean;
  defaultBucket: string | null;
}

export type StorageConnectionConfig = S3ConnectionConfig | FileProtocolConnectionConfig;

export function isFileProtocolConfig(config: StorageConnectionConfig): config is FileProtocolConnectionConfig {
  return isFileProtocolProvider(config.provider);
}

export interface ObjectStorageConnectionView {
  hostKeyFingerprint?: string | null;
  id: string;
  name: string;
  slug: string;
  provider: StorageProvider;
  description: string | null;
  tags: string[];
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  defaultBucket: string | null;
  forcePathStyle: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  basePath: string | null;
  implicitTls: boolean;
  healthStatus: ObjectStorageHealthStatus;
  lastHealthCheckAt: string | null;
  lastError: string | null;
  healthHistory?: ObjectStorageHealthEntry[];
  folderId: string | null;
  /** The app and environment the connection belongs to (null outside apps); set on lists and details. */
  app?: AppMemberRef | null;
  sortOrder: number;
  hasStoredSecret: boolean;
  hasStoredSessionToken: boolean;
  hasStoredPassword: boolean;
  hasStoredPrivateKey: boolean;
  hasStoredCaPem: boolean;
  config: {
    secretAccessKey: string;
    sessionToken: string | null;
    password: string | null;
    privateKey: string | null;
    passphrase: string | null;
    caPem: string | null;
  };
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
  origin: ObjectStorageConnectionOrigin;
  managed?: ObjectStorageManagedView;
}

export type ObjectStorageConnectionRow = {
  id: string;
  name: string;
  slug: string;
  provider: StorageProvider;
  description: string | null;
  tags: unknown;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  defaultBucket: string | null;
  forcePathStyle: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  basePath: string | null;
  implicitTls: boolean;
  healthStatus: ObjectStorageHealthStatus;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  healthHistory: unknown;
  folderId: string | null;
  sortOrder: number;
  createdById: string;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  origin: ObjectStorageConnectionOrigin;
};

export function maskStorageCredential(value: string | null | undefined): string {
  return value ? '••••••••' : '';
}

/** Returns a stored optional secret either in the clear or masked, never partially. */
function revealSecret(value: string | null | undefined, reveal: boolean): string | null {
  if (!value) return null;
  return reveal ? value : maskStorageCredential(value);
}

/** Derives the user-facing runtime shape from a managed cluster's stored Docker resource config. */
function deriveManagedRuntimeConfig(runtimeConfig: ManagedStorageClusterRow['runtimeConfig']): {
  cpuCores: number;
  memoryMb: number;
  swapMb: number;
} {
  const memoryLimitBytes = runtimeConfig.memoryLimitBytes ?? 0;
  const memorySwapBytes = runtimeConfig.memorySwapBytes ?? memoryLimitBytes;
  return {
    cpuCores: (runtimeConfig.nanoCPUs ?? 0) / 1_000_000_000,
    memoryMb: Math.round(memoryLimitBytes / (1024 * 1024)),
    swapMb: Math.max(0, Math.round((memorySwapBytes - memoryLimitBytes) / (1024 * 1024))),
  };
}

export function toObjectStorageConnectionView(
  row: ObjectStorageConnectionRow,
  secret: StoredSecretConfig,
  revealCredentials: boolean,
  includeHealthHistory = true,
  managedCluster?: ManagedStorageClusterRow | null
): ObjectStorageConnectionView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    provider: row.provider,
    description: row.description,
    tags: (row.tags as string[] | null) ?? [],
    endpoint: row.endpoint,
    region: row.region,
    accessKeyId: row.accessKeyId,
    defaultBucket: row.defaultBucket,
    forcePathStyle: row.forcePathStyle,
    host: row.host,
    port: row.port,
    username: row.username,
    basePath: row.basePath,
    implicitTls: row.implicitTls,
    healthStatus: row.healthStatus,
    lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
    lastError: row.lastError,
    ...(includeHealthHistory ? { healthHistory: (row.healthHistory as ObjectStorageHealthEntry[] | null) ?? [] } : {}),
    folderId: row.folderId,
    sortOrder: row.sortOrder,
    hasStoredSecret: !!secret.secretAccessKey,
    hasStoredSessionToken: !!secret.sessionToken,
    hostKeyFingerprint: secret.hostKeyFingerprint ?? null,
    hasStoredPassword: !!secret.password,
    hasStoredPrivateKey: !!secret.privateKey,
    hasStoredCaPem: !!secret.caPem,
    config: {
      secretAccessKey: revealCredentials
        ? (secret.secretAccessKey ?? '')
        : maskStorageCredential(secret.secretAccessKey),
      sessionToken: revealSecret(secret.sessionToken, revealCredentials),
      password: revealSecret(secret.password, revealCredentials),
      // The private key is masked like any other secret; revealing it requires
      // the same storage:credentials:reveal scope as an S3 secret key.
      privateKey: revealSecret(secret.privateKey, revealCredentials),
      passphrase: revealSecret(secret.passphrase, revealCredentials),
      caPem: revealSecret(secret.caPem, revealCredentials),
    },
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    origin: row.origin,
    ...(managedCluster
      ? {
          managed: {
            id: managedCluster.id,
            nodeId: managedCluster.nodeId,
            // Rows written before the engine column existed are MinIO clusters.
            engine: managedCluster.engine === 'seaweedfs' ? 'seaweedfs' : 'minio',
            version: managedCluster.version,
            storageSizeBytes: Number(managedCluster.storageSizeBytes),
            runtimeConfig: deriveManagedRuntimeConfig(managedCluster.runtimeConfig),
            publishedPort: managedCluster.publishedPort,
            publishS3: managedCluster.publishS3 ?? false,
            status: managedCluster.status,
            lastError: managedCluster.lastError,
            ...(managedCluster.writesFrozenAt ? { writesFrozenAt: managedCluster.writesFrozenAt.toISOString() } : {}),
          },
        }
      : {}),
  };
}
