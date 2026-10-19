export type BackupEngine = "postgres" | "redis" | "clickhouse";
export type BackupRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackupLimits {
  workspaceBytes: number;
  timeoutSeconds: number;
  cpuCores: number;
  memoryMb: number;
}

export interface BackupPolicy {
  id: string;
  databaseConnectionId: string;
  destinationId: string;
  bucket: string;
  prefix: string;
  stagingStorageConnectionId: string | null;
  stagingBucket: string | null;
  executorNodeId: string;
  schedule: string | null;
  timezone: string;
  retentionCount: number;
  limits: BackupLimits;
  enabled: boolean;
  /** Last skipped schedule slot or retention failure; cleared by the next scheduled start. */
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export interface BackupManifest {
  engine: BackupEngine;
  version: 1;
  sourceIdentity: string;
  sourceDatabase?: string;
  artifactKeys: string[];
  sizes: Record<string, number>;
  engineVersion: string;
  fileChecksums: Record<string, string>;
  manifestSha256: string;
  ownedPrefix: string;
  nativeStagePrefix?: string;
}

export interface BackupRun {
  id: string;
  policyId: string | null;
  /** Null after the source connection was deleted; the history is kept. */
  databaseConnectionId: string | null;
  databaseConnectionName?: string | null;
  destinationId: string;
  destinationBucket: string;
  destinationPrefix: string;
  stagingStorageConnectionId: string | null;
  stagingBucket: string | null;
  timezone: string;
  /** Null once the executor node was deleted; the run stays in history. */
  executorNodeId: string | null;
  direction: "backup" | "restore";
  engine: BackupEngine;
  status: BackupRunStatus;
  phase: string;
  bytes: string;
  manifest: BackupManifest | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  artifactsDeletedAt: string | null;
  createdAt: string;
}

/** What to do with files that still exist when a backup is removed from history. */
export type BackupHistoryArtifactsAction = "delete" | "forget";

export interface BackupHistoryDeleteResult {
  success: boolean;
  artifacts: "none" | "deleted" | "kept";
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
  /** Database name inside a new managed target; defaults to the normalized source name. */
  targetDatabaseName?: string;
  restoreTargetConnectionId?: string;
  /** Folder of a new managed restore target; null or omitted is the root. */
  folderId?: string | null;
  /** Size and resources of a new managed restore target; each defaults to the source managed instance's. */
  storageSizeGb?: number;
  cpuCores?: number;
  memoryMb?: number;
  swapMb?: number;
  overwrite?: false;
  limits?: Partial<BackupLimits>;
}
