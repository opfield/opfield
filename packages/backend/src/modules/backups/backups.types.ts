import type { BackupDirection, BackupEngine, BackupManifest, BackupRunStatus } from '@/db/schema/backups.js';

export interface BackupLimits {
  workspaceBytes: number;
  timeoutSeconds: number;
  cpuCores: number;
  memoryMb: number;
}

export interface BackupPolicyInput {
  destinationId: string;
  bucket: string;
  prefix: string;
  stagingStorageConnectionId?: string | null;
  stagingBucket?: string | null;
  executorNodeId: string;
  schedule?: string | null;
  timezone: string;
  retentionCount: number;
  limits: BackupLimits;
  enabled?: boolean;
}

export interface BackupRestoreInput {
  executorNodeId: string;
  newManagedDatabaseName?: string;
  /**
   * Database name inside a new managed restore target. Defaults to the backup's
   * source database name, normalized to a plain identifier.
   */
  targetDatabaseName?: string;
  restoreTargetConnectionId?: string;
  /** Folder of a new managed restore target; folder-scoped creators must name one they can create in. */
  folderId?: string | null;
  /**
   * Size and resources of a new managed restore target, with the names and limits of managed database create. Each
   * defaults to the source managed instance's value when the backup comes from one.
   */
  storageSizeGb?: number;
  cpuCores?: number;
  memoryMb?: number;
  swapMb?: number;
  /** Restore never overwrites an existing nonempty target. */
  overwrite?: false;
  limits?: Partial<BackupLimits>;
}

/**
 * Removing a backup from history while its files still exist: `delete` removes the
 * files first and keeps the entry when that fails; `forget` removes only the entry
 * and leaves the files in storage (for files that are unreachable or kept on purpose).
 */
export type BackupHistoryArtifactsAction = 'delete' | 'forget';

export interface BackupHistoryDeleteResult {
  success: boolean;
  /** What happened to the backup files: none existed, they were deleted, or they were left in storage. */
  artifacts: 'none' | 'deleted' | 'kept';
}

export interface BackupRunView {
  id: string;
  policyId: string | null;
  /** Null once the source connection was deleted; history is retained. */
  databaseConnectionId: string | null;
  databaseConnectionName: string | null;
  destinationId: string;
  destinationBucket: string;
  destinationPrefix: string;
  stagingStorageConnectionId: string | null;
  stagingBucket: string | null;
  timezone: string;
  /** Null once the executor node was deleted; the run stays in history. */
  executorNodeId: string | null;
  direction: BackupDirection;
  engine: BackupEngine;
  status: BackupRunStatus;
  phase: string;
  bytes: string;
  manifest: BackupManifest | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  artifactsDeletedAt: Date | null;
  createdAt: Date;
  /** A database on several servers: the member the backup read (a copy when one was eligible), else null. */
  source?: { memberId: string | null; nodeId: string | null; role: 'copy' | 'primary' } | null;
}

export interface BackupRuntimeConnection {
  connectionId: string;
  host: string;
  port: number;
  database?: string;
  username?: string;
  password?: string;
  tls?: boolean;
  /**
   * Explicit server certificate verification of an external database. Sent
   * only to executors that report database_backups_tls_verification_v1; older
   * daemons reject unknown fields. Absent on managed relay routes.
   */
  tlsVerifyCertificate?: boolean;
  caPem?: string;
  serverName?: string;
  relayRouteId?: string;
  managedDatabaseId?: string;
}

export interface BackupDestination extends BackupRuntimeConnection {
  provider: 's3' | 'ftp' | 'ftps' | 'sftp';
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  privateKey?: string;
  passphrase?: string;
  hostKeyFingerprint?: string;
  basePath?: string;
  implicitTls?: boolean;
  forcePathStyle?: boolean;
  relayRouteId?: string;
}

/** Structural view of ObjectStorageService.getBackupTarget; central storage owns the concrete type. */
export interface StorageBackupTargetConfig {
  connectionId: string;
  provider: 'aws' | 'cloudflare_r2' | 'minio' | 'other' | 'ftp' | 'ftps' | 'sftp' | 'seaweedfs';
  endpoint?: string;
  host?: string;
  port?: number;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  caPem?: string;
  hostKeyFingerprint?: string;
  basePath?: string;
  implicitTls?: boolean;
  forcePathStyle?: boolean;
  managedClusterId?: string;
  managedNodeId?: string;
}

export interface BackupRuntimePayload {
  runId: string;
  version: 1;
  direction: BackupDirection;
  engine: BackupEngine;
  source?: BackupRuntimeConnection;
  destination: BackupDestination;
  staging?: BackupDestination;
  restoreTarget?: BackupRuntimeConnection & { newManagedDatabaseName?: string };
  limits: BackupLimits;
  toolImage: string;
  redisStageImage?: string;
  /** Server-approved executor address reachable from an external Redis target. */
  redisStageAdvertiseHost?: string;
  restoreArtifact?: BackupManifest;
  /**
   * Absolute run deadline (ISO 8601). Sent only to executors that report the
   * database_backups_deadline_v1 capability; older daemons reject unknown fields.
   */
  deadlineAt?: string;
}
