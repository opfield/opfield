import type { DrizzleClient } from '@/db/client.js';
import type { ManagedStorageClusterRow, ManagedStoragePendingOperation } from '@/db/schema/managed-storage.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { ManagedWorkloadDispatch } from '@/modules/managed-workloads/managed-workload-dispatch.js';
import type { ManagedWorkloadLifecycle } from '@/modules/managed-workloads/managed-workload-lifecycle.js';
import type { ManagedWorkloadProvider } from '@/modules/managed-workloads/managed-workload-provider.js';
import type { ManagedWorkloadStore } from '@/modules/managed-workloads/managed-workload-store.js';
import type { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import type {
  BackupHistoryRehomeResult,
  StorageBackupHistoryOptions,
} from '@/modules/object-storage/storage-backup-references.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';
import type {
  CertificateRenewalStatusView,
  RenewalOutcome,
  SystemCertificateRenewalService,
} from '@/services/system-certificate-renewal.service.js';
import type {
  CreateManagedStorageAccessKeyInput,
  CreateManagedStorageInput,
  ManagedStorageKeyImportResult,
  ManagedStorageListQuery,
  ManagedStorageWriteFreezeResult,
  UpdateManagedStorageInput,
} from './managed-storage.schemas.js';
import type { ManagedStorageTunnelProxy } from './managed-storage-tunnel-proxy.js';
import type { StorageClusterMemberStore } from './storage-cluster-member-store.js';
import type { StorageRootCredentials } from './storage-workload-dispatch.js';
export interface ClusterHostPorts {
  ports: number[];
  intraConflict?: {
    port: number;
    reason: string;
  };
}
export interface ClusterPortFields {
  publishS3?: boolean;
  publishedPort: number;
  sftpEnabled?: boolean | null;
  sftpPort?: number | null;
  ftpEnabled?: boolean | null;
  ftpPort?: number | null;
  ftpPassivePortStart?: number | null;
  ftpPassivePortCount?: number | null;
}
export declare function collectClusterHostPorts(fields: ClusterPortFields): ClusterHostPorts;
export declare function managedStorageCanonicalEndpoint(
  row: {
    relayEnabled: boolean;
    tlsEnabled: boolean;
    publishedPort: number;
  },
  host: string
): string;
export declare function managedStorageServiceAddresses(
  node: {
    serviceAddress: string | null;
    hostname?: string | null;
    lastHealthReport: unknown;
  },
  relay?: boolean
): string[];
export class ManagedStorageService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _nodeDispatch: NodeDispatchService,
    _storageProvider: ManagedWorkloadProvider,
    _objectStorageService: ObjectStorageService,
    _storageWorkloadStore: ManagedWorkloadStore,
    _storageWorkloadDispatch: ManagedWorkloadDispatch<ManagedStorageClusterRow, StorageRootCredentials>,
    _storageLifecycle: ManagedWorkloadLifecycle<ManagedStorageClusterRow, StorageRootCredentials>,
    _memberStore?: StorageClusterMemberStore,
    _tunnelProxy?: ManagedStorageTunnelProxy,
    _storageCA?: StorageCAService | undefined,
    _relayPolicy?: Pick<RelayPolicyService, 'revokeOwner'> | undefined
  ) {}
  setBindingsTeardown(_teardown: (cluster: ManagedStorageClusterRow, userId: string) => Promise<void>): void {}
  setEventBus(_bus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  listCatalog(): import('@/modules/managed-workloads/managed-workload-provider.js').ManagedWorkloadCatalogEntry[] {
    return commercialModuleUnavailable();
  }
  async list(_query?: ManagedStorageListQuery): Promise<
    {
      id: string;
      name: string;
      slug: string;
      nodeId: string;
      engine: 'minio' | 'seaweedfs';
      version: string;
      imageRef: string;
      storageSizeBytes: number;
      publishedPort: number;
      publishS3: boolean;
      relayEnabled: boolean;
      tlsEnabled: boolean;
      runtimeConfig: import('@/db/schema/managed-storage.js').ManagedStorageRuntimeConfig;
      sftpEnabled: boolean;
      sftpPort: number | null;
      ftpEnabled: boolean;
      ftpPort: number | null;
      ftpPassivePortStart: number | null;
      ftpPassivePortCount: number | null;
      status: 'stopped' | 'error' | 'ready' | 'creating' | 'updating' | 'deleting';
      pendingOperation: ManagedStoragePendingOperation | null;
      lastError: string | null;
      objectStorageConnectionId: string | null;
      createdAt: Date;
      updatedAt: Date;
      createdById: string;
      updatedById: string | null;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async get(_id: string): Promise<{
    id: string;
    name: string;
    slug: string;
    nodeId: string;
    engine: 'minio' | 'seaweedfs';
    version: string;
    imageRef: string;
    storageSizeBytes: number;
    publishedPort: number;
    publishS3: boolean;
    relayEnabled: boolean;
    tlsEnabled: boolean;
    runtimeConfig: import('@/db/schema/managed-storage.js').ManagedStorageRuntimeConfig;
    sftpEnabled: boolean;
    sftpPort: number | null;
    ftpEnabled: boolean;
    ftpPort: number | null;
    ftpPassivePortStart: number | null;
    ftpPassivePortCount: number | null;
    status: 'stopped' | 'error' | 'ready' | 'creating' | 'updating' | 'deleting';
    pendingOperation: ManagedStoragePendingOperation | null;
    lastError: string | null;
    objectStorageConnectionId: string | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    updatedById: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async getByObjectStorageConnectionId(_objectStorageConnectionId: string): Promise<{
    id: string;
    name: string;
    slug: string;
    nodeId: string;
    engine: 'minio' | 'seaweedfs';
    version: string;
    imageRef: string;
    storageSizeBytes: number;
    publishedPort: number;
    publishS3: boolean;
    relayEnabled: boolean;
    tlsEnabled: boolean;
    runtimeConfig: import('@/db/schema/managed-storage.js').ManagedStorageRuntimeConfig;
    sftpEnabled: boolean;
    sftpPort: number | null;
    ftpEnabled: boolean;
    ftpPort: number | null;
    ftpPassivePortStart: number | null;
    ftpPassivePortCount: number | null;
    status: 'stopped' | 'error' | 'ready' | 'creating' | 'updating' | 'deleting';
    pendingOperation: ManagedStoragePendingOperation | null;
    lastError: string | null;
    objectStorageConnectionId: string | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    updatedById: string | null;
  } | null> {
    return commercialModuleUnavailable();
  }
  async getCanonicalScopeResourceId(_id: string): Promise<string | null> {
    return commercialModuleUnavailable();
  }
  async create(_input: CreateManagedStorageInput, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async update(_id: string, _input: UpdateManagedStorageInput, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async restart(_id: string, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async delete(_id: string, _userId: string, _options?: StorageBackupHistoryOptions): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async retryProvisioning(_id: string, _userId: string): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async getCaCertificate(_id: string): Promise<{
    certificatePem: string;
    fingerprintSha256: string;
  }> {
    return commercialModuleUnavailable();
  }
  setCertificateRenewal(_renewal: SystemCertificateRenewalService): void {}
  async getCertificateStatus(_id: string): Promise<CertificateRenewalStatusView> {
    return commercialModuleUnavailable();
  }
  async renewCertificate(
    _id: string,
    _userId: string,
    _options?: { allowRestart?: boolean }
  ): Promise<{ outcome: RenewalOutcome; status: CertificateRenewalStatusView }> {
    return commercialModuleUnavailable();
  }
  async revealCredentials(_id: string): Promise<{
    accessKey: string;
    secretKey: string;
  }> {
    return commercialModuleUnavailable();
  }
  async createAccessKey(
    _id: string,
    _input: CreateManagedStorageAccessKeyInput,
    _userId: string
  ): Promise<{
    accessKeyId: string;
    secretKey: string;
    name: string | null;
    createdAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async listAccessKeys(_id: string): Promise<
    {
      accessKeyId: string;
      name: string | null;
      access: string | null;
      buckets: string[];
      expiresAt: Date | null;
      createdAt: Date;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async removeAccessKey(
    _id: string,
    _accessKeyId: string,
    _userId: string
  ): Promise<{
    success: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async importAccessKeys(
    _sourceId: string,
    _targetId: string,
    _userId: string,
    _keyIds?: string[]
  ): Promise<ManagedStorageKeyImportResult> {
    return commercialModuleUnavailable();
  }
  async freezeWrites(_id: string, _userId: string): Promise<ManagedStorageWriteFreezeResult> {
    return commercialModuleUnavailable();
  }
  async unfreezeWrites(_id: string, _userId: string): Promise<ManagedStorageWriteFreezeResult> {
    return commercialModuleUnavailable();
  }
  async rehomeBackupHistory(
    _sourceId: string,
    _targetId: string,
    _userId: string,
    _options?: { dryRun?: boolean }
  ): Promise<BackupHistoryRehomeResult & { sourceStorageId: string; targetStorageId: string }> {
    return commercialModuleUnavailable();
  }
  async reconcilePendingOperations(): Promise<void> {
    return commercialModuleUnavailable();
  }
  /** App shutdown: docker pause every member of the cluster (status `paused`; restart and update refused). */
  async pause(_id: string, _userId: string | null): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  async unpause(_id: string, _userId: string | null): Promise<unknown> {
    return commercialModuleUnavailable();
  }
  /**
   * App kill switch: stop publishing the S3 port and keep it with a reservation hold owned by `holdOwnerId` (owner
   * kind `app_incident`). Returns the publication before, or null when the storage is gone or was not published.
   */
  async suspendPublication(
    _id: string,
    _holdOwnerId: string,
    _userId: string | null
  ): Promise<{ publishS3: boolean; publishedPort: number } | null> {
    return commercialModuleUnavailable();
  }
  /** Publish the same port again and release the hold. False when the storage is gone. */
  async resumePublication(
    _id: string,
    _prior: { publishS3: boolean; publishedPort: number },
    _holdOwnerId: string,
    _userId: string | null
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
}
