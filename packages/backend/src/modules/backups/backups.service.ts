import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { BackupEngine, BackupManifest } from '../../db/schema/backups.js';
import type {
  BackupDestination,
  BackupHistoryArtifactsAction,
  BackupHistoryDeleteResult,
  BackupPolicyInput,
  BackupRestoreInput,
  BackupRuntimeConnection,
  BackupRunView,
  StorageBackupTargetConfig,
} from './backups.types.js';
export interface NodeBackupDispatch {
  sendDockerBackupCommand(
    nodeId: string,
    action: 'preflight' | 'start' | 'status' | 'cancel',
    runId: string,
    configJson: string,
    timeoutMs: number
  ): Promise<{
    success: boolean;
    detail?: string;
    error?: string;
  }>;
}
export interface BackupAuthorization {
  /** `databaseId` is null for a backup of a deleted database: only an unscoped grant reaches it. */
  assertSource(userId: string, databaseId: string | null, purpose: 'backup' | 'restore'): Promise<void>;
  assertDestination(userId: string, destinationId: string, purpose: 'read' | 'write' | 'delete'): Promise<void>;
  assertExecutor(userId: string, nodeId: string): Promise<void>;
  assertRestoreTarget?(userId: string, connectionId: string): Promise<void>;
  assertScheduledActor(
    userId: string,
    databaseId: string,
    destinationId: string,
    executorNodeId: string
  ): Promise<void>;
}
export interface BackupTargetStore {
  getBackupTarget(id: string): Promise<StorageBackupTargetConfig>;
  deleteOwnedBackupArtifacts(
    target: StorageBackupTargetConfig,
    selection: {
      bucket: string;
      prefix: string;
    },
    manifest: BackupManifest
  ): Promise<void>;
}
export interface ManagedDatabaseBackupExecutorPreparation {
  prepareConnectionForExecutor(
    runId: string,
    executorNodeId: string,
    connectionId: string,
    purpose: 'backup' | 'restore'
  ): Promise<
    BackupRuntimeConnection & {
      relayRouteId: string;
      managedDatabaseId: string;
    }
  >;
}
export interface BackupRestoreTargetPreparation {
  prepareRestoreTargetForExecutor(
    runId: string,
    executorNodeId: string,
    userId: string,
    target: {
      newManagedDatabaseName?: string;
      restoreTargetConnectionId?: string;
    }
  ): Promise<
    BackupRuntimeConnection & {
      newManagedDatabaseName?: string;
      newManagedDatabaseId?: string;
    }
  >;
}
export interface StorageBackupRuntimeResolver {
  resolve(
    target: StorageBackupTargetConfig,
    executorNodeId: string,
    selection: {
      runId: string;
      bucket: string;
      prefix: string;
      ownerKind: 'storage_backup_target' | 'storage_backup_staging';
    }
  ): Promise<BackupDestination>;
}
export interface BackupRuntimeCleanup {
  cleanupRuntime(runId: string): Promise<void>;
}
export interface RedisStageReachability {
  /** A server-approved executor address that the selected external Redis can connect back to. */
  getExecutorReachableAddress(executorNodeId: string): Promise<string>;
}
export interface BackupToolImageCatalog {
  get(engine: BackupEngine): string | undefined;
  getRedisStage(): string | undefined;
}
export class BackupService {
  registerScheduler(): void {}
  async createPolicy(
    _databaseId: string,
    _input: BackupPolicyInput,
    _userId: string
  ): Promise<{
    id: string;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
    enabled: boolean;
    databaseConnectionId: string;
    destinationId: string;
    bucket: string;
    prefix: string;
    stagingStorageConnectionId: string | null;
    stagingBucket: string | null;
    executorNodeId: string;
    schedule: string | null;
    timezone: string;
    lastScheduledAt: Date | null;
    retentionCount: number;
    limits: {
      workspaceBytes: number;
      timeoutSeconds: number;
      cpuCores: number;
      memoryMb: number;
    };
  }> {
    return commercialModuleUnavailable();
  }
  async updatePolicy(
    _databaseId: string,
    _policyId: string,
    _input: BackupPolicyInput,
    _userId: string
  ): Promise<{
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
    lastScheduledAt: Date | null;
    retentionCount: number;
    limits: {
      workspaceBytes: number;
      timeoutSeconds: number;
      cpuCores: number;
      memoryMb: number;
    };
    enabled: boolean;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async deletePolicy(_databaseId: string, _policyId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async listRuns(_databaseId: string): Promise<BackupRunView[]> {
    return commercialModuleUnavailable();
  }
  /** Runs of deleted databases: their history and backup files are kept. */
  async listOrphanedRuns(): Promise<BackupRunView[]> {
    return commercialModuleUnavailable();
  }
  async listPolicies(_databaseId: string): Promise<
    {
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
      lastScheduledAt: Date | null;
      lastError: string | null;
      lastErrorAt: Date | null;
      retentionCount: number;
      limits: {
        workspaceBytes: number;
        timeoutSeconds: number;
        cpuCores: number;
        memoryMb: number;
      };
      enabled: boolean;
      createdById: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async startBackup(_databaseId: string, _policyId: string, _userId: string): Promise<BackupRunView> {
    return commercialModuleUnavailable();
  }
  async startRestore(
    _databaseId: string,
    _sourceRunId: string,
    _input: BackupRestoreInput,
    _userId: string
  ): Promise<BackupRunView> {
    return commercialModuleUnavailable();
  }
  async startOrphanedRestore(
    _sourceRunId: string,
    _input: BackupRestoreInput,
    _userId: string
  ): Promise<BackupRunView> {
    return commercialModuleUnavailable();
  }
  async deleteHistory(
    _databaseId: string,
    _runId: string,
    _userId: string,
    _options?: { artifacts?: BackupHistoryArtifactsAction }
  ): Promise<BackupHistoryDeleteResult> {
    return commercialModuleUnavailable();
  }
  async deleteOrphanedHistory(
    _runId: string,
    _userId: string,
    _options?: { artifacts?: BackupHistoryArtifactsAction }
  ): Promise<BackupHistoryDeleteResult> {
    return commercialModuleUnavailable();
  }
  async cancel(_databaseId: string, _runId: string, _userId: string, _options?: { force?: boolean }): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cancelOrphaned(_runId: string, _userId: string, _options?: { force?: boolean }): Promise<void> {
    return commercialModuleUnavailable();
  }
  async reconcileActiveRuns(): Promise<void> {
    return commercialModuleUnavailable();
  }
}
