import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DatabaseCAService } from '@/services/database-ca.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type {
  CertificateRenewalStatusView,
  SystemCertificateRenewalService,
} from '@/services/system-certificate-renewal.service.js';
import type {
  CreateManagedDatabaseInput,
  ManagedAvailabilityEnableInput,
  ManagedAvailabilityPreflightInput,
  ManagedAvailabilitySettingsInput,
  ManagedDatabaseListQuery,
  UpdateManagedDatabaseInput,
} from './databases.schemas.js';
import type { DatabaseConnectionService } from './databases.service.js';
import type { ManagedAvailabilityHost } from './managed-database-availability.types.js';
import type {
  ManagedDatabaseLogOptions,
  ManagedDatabaseLogTarget,
  ManagedDatabaseRow,
  ManagedDatabaseRuntimeStats,
} from './managed-databases.service.core.js';
export class ManagedDatabaseService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _nodeDispatch: NodeDispatchService,
    _databaseCA?: DatabaseCAService | undefined,
    _databaseConnectionService?: DatabaseConnectionService | undefined
  ) {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  setEventBus(_bus: EventBusService): void {}
  setCertificateRenewal(_renewal: SystemCertificateRenewalService): void {}
  /** Database availability sets: the open-core host parts the commercial control plane uses (merged per call). */
  setAvailabilityHost(_host: Partial<ManagedAvailabilityHost>): void {}
  async getCertificateStatus(_id: string): Promise<CertificateRenewalStatusView> {
    return commercialModuleUnavailable();
  }
  async ensureBindingIdentity(_managedDatabaseId: string, _userId?: string | null): Promise<ManagedDatabaseRow> {
    return commercialModuleUnavailable();
  }
  async finalizeBindingIdentity(
    _managedDatabaseId: string,
    _userId?: string | null,
    _expectedPendingOperationId?: string | null
  ): Promise<ManagedDatabaseRow> {
    return commercialModuleUnavailable();
  }
  async runBindingLifecycleOperation<T>(_managedDatabaseId: string, _operation: () => Promise<T>): Promise<T> {
    return commercialModuleUnavailable();
  }
  listCatalog(): {
    type: string;
    versions: string[];
  }[] {
    return commercialModuleUnavailable();
  }
  async list(_query?: ManagedDatabaseListQuery): Promise<
    {
      id: string;
      databaseConnectionId: string | null;
      nodeId: string;
      name: string;
      slug: string;
      type: 'postgres' | 'redis' | 'clickhouse';
      version: string;
      engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
      storageSizeBytes: number;
      runtimeConfig: {
        cpuCores: number;
        memoryMb: number;
        swapMb: number;
      };
      publishedPort: number | null;
      publishedNativePort: number | null;
      tlsEnabled: boolean;
      status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
      lastError: string | null;
      createdAt: Date;
      updatedAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async get(_id: string): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async getByDatabaseConnectionId(_databaseConnectionId: string): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return commercialModuleUnavailable();
  }
  async getCanonicalScopeResourceId(_id: string): Promise<string> {
    return commercialModuleUnavailable();
  }
  async resolveLogTarget(_databaseConnectionId: string): Promise<ManagedDatabaseLogTarget> {
    return commercialModuleUnavailable();
  }
  async getLogs(_databaseConnectionId: string, _options?: ManagedDatabaseLogOptions): Promise<string[]> {
    return commercialModuleUnavailable();
  }
  async reconcileDatabaseConnections(): Promise<void> {
    return commercialModuleUnavailable();
  }
  async reconcileClickHouseQueryPrincipals(_nodeId?: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async reconcileBindingIdentities(_nodeId?: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async reconcileDatabaseCertificates(): Promise<void> {
    return commercialModuleUnavailable();
  }
  /** PEM of the Opfield Database CA that issues managed database TLS certificates, if configured. */
  async getDatabaseCACertificate(): Promise<string | null> {
    return commercialModuleUnavailable();
  }
  /**
   * The member a backup of a database on several servers reads (P3-T06): an eligible copy within the lag bound, else
   * the primary; null for a database on one server.
   */
  async backupSource(
    _managedDatabaseId: string,
    _input: { executorNodeId: string; forcePrimary?: boolean }
  ): Promise<{ setId: string; memberId: string; nodeId: string; role: 'copy' | 'primary' } | null> {
    return commercialModuleUnavailable();
  }
  async warmReadyPostgresExtensionCatalogs(): Promise<void> {
    return commercialModuleUnavailable();
  }
  async create(
    _input: CreateManagedDatabaseInput,
    _userId: string,
    _options?: { keepLegacyRedisVersion?: boolean }
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async update(
    _id: string,
    _input: UpdateManagedDatabaseInput,
    _userId: string
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async rotateCertificate(
    _id: string,
    _userId: string,
    _options?: { allowRestart?: boolean }
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async pause(
    _id: string,
    _userId: string
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async unpause(
    _id: string,
    _userId: string
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async restart(
    _id: string,
    _userId: string
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async moveToValkeyPreflight(_id: string): Promise<{
    fromVersion: string;
    toVersion: string;
    keys: number;
    usedMemoryBytes: number;
    pendingStreamEntries: number;
    blockers: string[];
    estimatedPauseSeconds: number;
  }> {
    return commercialModuleUnavailable();
  }
  async moveToValkey(
    _id: string,
    _userId: string,
    _options?: { acceptPendingStreamLoss?: boolean }
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async delete(
    _id: string,
    _userId: string
  ): Promise<
    | {
        id: string;
        databaseConnectionId: string | null;
        nodeId: string;
        name: string;
        slug: string;
        type: 'postgres' | 'redis' | 'clickhouse';
        version: string;
        engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
        storageSizeBytes: number;
        runtimeConfig: {
          cpuCores: number;
          memoryMb: number;
          swapMb: number;
        };
        publishedPort: number | null;
        publishedNativePort: number | null;
        tlsEnabled: boolean;
        status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
        lastError: string | null;
        createdAt: Date;
        updatedAt: Date;
      }
    | {
        success: boolean;
      }
  > {
    return commercialModuleUnavailable();
  }
  async retryProvisioning(
    _id: string,
    _userId: string
  ): Promise<{
    id: string;
    databaseConnectionId: string | null;
    nodeId: string;
    name: string;
    slug: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    version: string;
    engine: 'postgres' | 'redis' | 'valkey' | 'clickhouse';
    storageSizeBytes: number;
    runtimeConfig: {
      cpuCores: number;
      memoryMb: number;
      swapMb: number;
    };
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    status: 'error' | 'creating' | 'updating' | 'ready' | 'paused' | 'stopped' | 'deleting';
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async revealCredentials(_id: string): Promise<{
    caCertificate?: string | undefined;
    caFingerprint?: string | undefined;
    publishedPort: number | null;
    publishedNativePort: number | null;
    tlsEnabled: boolean;
    databaseName?: string | undefined;
    username: string;
    password: string;
  }> {
    return commercialModuleUnavailable();
  }
  async rotateDirectAccessCredentials(
    _id: string,
    _userId: string
  ): Promise<{
    publishedPort: number | null;
    databaseName?: string | undefined;
    username: string;
    password: string;
  }> {
    return commercialModuleUnavailable();
  }
  async getRuntimeStatsByDatabaseConnectionId(
    _databaseConnectionId: string
  ): Promise<ManagedDatabaseRuntimeStats | null> {
    return commercialModuleUnavailable();
  }
  /** Replication metrics of a database on several servers (null on one server): worst copy lag, server round trip. */
  async getAvailabilityMetricsByDatabaseConnectionId(_databaseConnectionId: string): Promise<{
    replication_lag_bytes: number | null;
    replication_lag_seconds: number | null;
    rtt_ms: number | null;
  } | null> {
    return commercialModuleUnavailable();
  }
  async reconcilePendingOperations(): Promise<void> {
    return commercialModuleUnavailable();
  }
  /**
   * App kill switch: turn the direct publication off through the normal update path and keep its ports with a
   * reservation hold owned by `holdOwnerId` (owner kind `app_incident`). Returns the ports before, or null when the
   * database is gone or was not published.
   */
  async suspendPublication(
    _id: string,
    _holdOwnerId: string,
    _userId: string | null
  ): Promise<{ publishedPort: number | null; publishedNativePort: number | null } | null> {
    return commercialModuleUnavailable();
  }
  // Availability (one database on several servers): the commercial edition serves these; REST and MCP share them.
  async availabilityPreflightForCreate(
    _input: ManagedAvailabilityPreflightInput & {
      type: CreateManagedDatabaseInput['type'];
      version: string;
      tlsEnabled?: boolean;
      storageSizeGb?: number;
      folderId?: string | null;
    }
  ): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async availabilityPreflight(_id: string, _input: ManagedAvailabilityPreflightInput): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async enableAvailability(_id: string, _input: ManagedAvailabilityEnableInput, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async updateAvailability(_id: string, _input: ManagedAvailabilitySettingsInput, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async addAvailabilityMember(
    _id: string,
    _input: { nodeId: string; priority?: number },
    _userId: string
  ): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async removeAvailabilityMember(_id: string, _memberId: string, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async makeAvailabilityPrimary(
    _id: string,
    _input: { memberId: string; acceptDataLoss?: boolean },
    _userId: string
  ): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async rebuildAvailabilityMember(_id: string, _memberId: string, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async disableAvailability(_id: string, _userId: string, _input?: { keepMemberId?: string }): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async availabilityView(_id: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async availabilityEvents(_id: string, _query: { page?: number; limit?: number }): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  /** Republish the same ports and release the hold. False when the database is gone. */
  async resumePublication(
    _id: string,
    _prior: { publishedPort: number | null; publishedNativePort: number | null },
    _holdOwnerId: string,
    _userId: string | null
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
}
export type {
  ManagedDatabaseLogOptions,
  ManagedDatabaseLogTarget,
  ManagedDatabaseRuntimeStats,
} from './managed-databases.service.core.js';
