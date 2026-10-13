import type { createNodeWebSocket } from '@hono/node-ws';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { DependencyContainer } from 'tsyringe';
import type { Env } from '@/config/env.js';
import type { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import type { AppError } from '@/middleware/error-handler.js';
import type { DatabaseToolContext } from '@/modules/ai/ai.database-tools.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import type { AISandboxJobsService } from '@/modules/ai/ai.sandbox-jobs.service.js';
import type { PageContext } from '@/modules/ai/ai.types.js';
import type { aiCommercialRuntime } from '@/modules/ai/ai-commercial-runtime.js';
import type { AIPlanService } from '@/modules/ai/ai-plan.service.js';
import type { AIPlanningRuntime } from '@/modules/ai/ai-planning-runtime.js';
import type { AIRunService } from '@/modules/ai/ai-run.service.js';
import type { aiRunCommercialRuntime } from '@/modules/ai/ai-run-commercial-runtime.js';
import type { AIScenarioDefinition } from '@/modules/ai/ai-scenarios.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { auditExportRouteRuntime } from '@/modules/audit/audit-export-route-runtime.js';
import type { SiemConstructors, siemCommercialRuntime } from '@/modules/audit/siem-commercial-runtime.js';
import type { siemRouteRuntime } from '@/modules/audit/siem-route-runtime.js';
import type { backupRuntime } from '@/modules/backups/backup-runtime.js';
import type { databaseCommercialRuntime } from '@/modules/databases/database-commercial-runtime.js';
import type { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import type { databaseRouteRuntime } from '@/modules/databases/database-route-runtime.js';
import type { databaseToolRuntime } from '@/modules/databases/database-tool-runtime.js';
import type { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import type {
  ManagedDatabaseConstructors,
  managedDatabaseRuntime,
} from '@/modules/databases/managed-database-runtime.js';
import type { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import type {
  DockerAvailabilitySetup,
  dockerAvailabilityCommercialRuntime,
} from '@/modules/docker/availability/docker-availability-commercial-runtime.js';
import type { ContainerLinksService } from '@/modules/docker/container-links/container-links.service.js';
import type { containerLinksRuntime } from '@/modules/docker/container-links/container-links-runtime.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type {
  DockerArchiveOperations,
  dockerArchiveCommercialRuntime,
} from '@/modules/docker/docker-archive-commercial-runtime.js';
import type {
  DockerBuildConstructors,
  dockerBuildCommercialRuntime,
} from '@/modules/docker/docker-build-commercial-runtime.js';
import type {
  DockerDeploymentConstructors,
  dockerDeploymentCommercialRuntime,
} from '@/modules/docker/docker-deployment-commercial-runtime.js';
import type { dockerManagementCommercialRuntime } from '@/modules/docker/docker-management-commercial-runtime.js';
import type {
  DockerMigrationConstructors,
  dockerMigrationCommercialRuntime,
} from '@/modules/docker/docker-migration-commercial-runtime.js';
import type { dockerRegistryCommercialRuntime } from '@/modules/docker/docker-registry-commercial-runtime.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import type { dockerSourceCommercialRuntime } from '@/modules/docker/docker-source-commercial-runtime.js';
import type { integrationCommercialRuntime } from '@/modules/integrations/integration-commercial-runtime.js';
import type { VcsConnectorProvider } from '@/modules/integrations/integration-provider.types.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { LoggingConstructors, loggingCommercialRuntime } from '@/modules/logging/logging-commercial-runtime.js';
import type { loggingRouteRuntime } from '@/modules/logging/logging-route-runtime.js';
import type { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import type { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import type { ObjectStorageUploadService } from '@/modules/object-storage/object-storage-upload.service.js';
import type { StorageBackendFactory } from '@/modules/object-storage/storage-backend.js';
import type { storageCommercialRuntime } from '@/modules/object-storage/storage-commercial-runtime.js';
import type { storageRouteRuntime } from '@/modules/object-storage/storage-route-runtime.js';
import type { storageToolRuntime } from '@/modules/object-storage/storage-tool-runtime.js';
import type { PagesConstructors, pagesCommercialRuntime } from '@/modules/pages/pages-commercial-runtime.js';
import type { pagesRouteRuntime } from '@/modules/pages/pages-route-runtime.js';
import type { StatusPageService } from '@/modules/status-page/status-page.service.js';
import type { statusPageCommercialRuntime } from '@/modules/status-page/status-page-commercial-runtime.js';
import type { statusPageRouteRuntime } from '@/modules/status-page/status-page-route-runtime.js';
import type { managedStorageRouteRuntime } from '@/modules/storage/managed-storage-route-runtime.js';
import type { ManagedStorageConstructors, managedStorageRuntime } from '@/modules/storage/managed-storage-runtime.js';
import type { RedisClient } from '@/services/cache.service.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { SchedulerService } from '@/services/scheduler.service.js';
import type { AppEnv, User } from '@/types.js';

export const COMMERCIAL_HOST_API_VERSION = 1;

/** One first-party package shares the host's infrastructure and class identities. */
export interface CommercialHost {
  operations: typeof acceptedOperations;
  apiVersion: typeof COMMERCIAL_HOST_API_VERSION;
  env: Env;
  db: DrizzleClient;
  redis: RedisClient;
  container: DependencyContainer;
  tokens: typeof TOKENS;
  license: LicensePolicyService;
  errors: { AppError: typeof AppError };
}

export interface CommercialRouteHost {
  pki: typeof pkiRouteRuntime;
  siem: typeof siemRouteRuntime;
  auditExport: typeof auditExportRouteRuntime;
  pages: typeof pagesRouteRuntime;
  logging: typeof loggingRouteRuntime;
  statusPage: typeof statusPageRouteRuntime;
  backups: typeof backupRuntime;
  managedStorage: typeof managedStorageRouteRuntime;
  databases: typeof databaseRouteRuntime;
  storage: typeof storageRouteRuntime;
  app: OpenAPIHono<AppEnv>;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>['upgradeWebSocket'];
}

/** Hooks retain ownership of durable work until it drains or the process exits. */
export interface CommercialLifecycle {
  start(): Promise<void>;
  quiesce(): Promise<void>;
  drain(deadline: number): Promise<void>;
  forceClose(): Promise<void>;
  close(deadline: number): Promise<void>;
}

/** One kind of orchestration work that an Opfield restart would interrupt. */
export interface CommercialOrchestrationActivity {
  kind: string;
  /** Short plural label, e.g. "Blue/green deployments". */
  label: string;
  /** Executing now, in this process or on a node. */
  running: number;
  /** Accepted and executed without a new request, e.g. a slot drain due later. */
  queued: number;
  /** Epoch ms by which the known work of this kind should have finished. */
  expectedBy?: number | null;
}

/** Optional: cores older than the update gate omit it. */
export interface CommercialOrchestration {
  activeOperations(): Promise<CommercialOrchestrationActivity[]>;
  /** A reason refuses new orchestration operations with it; null accepts them again. */
  setAdmissionHold(reason: string | null): void;
}

export interface CommercialRegistration {
  orchestration?: CommercialOrchestration;
  createRegistryIngress?(
    Base: typeof RelayRegistryIngressService,
    args: ConstructorParameters<typeof RelayRegistryIngressService>,
    runtime: typeof dockerRegistryCommercialRuntime
  ): RelayRegistryIngressService;
  createPki?<Key extends keyof PkiConstructors>(
    key: Key,
    args: ConstructorParameters<PkiConstructors[Key]>,
    runtime: typeof pkiCommercialRuntime
  ): InstanceType<PkiConstructors[Key]>;
  createAuditService?(Base: typeof AuditService, args: ConstructorParameters<typeof AuditService>): AuditService;
  createSiem?<Key extends keyof SiemConstructors>(
    key: Key,
    args: ConstructorParameters<SiemConstructors[Key]>,
    runtime: typeof siemCommercialRuntime
  ): InstanceType<SiemConstructors[Key]>;
  createPages?<Key extends keyof PagesConstructors>(
    key: Key,
    args: ConstructorParameters<PagesConstructors[Key]>,
    runtime: typeof pagesCommercialRuntime
  ): InstanceType<PagesConstructors[Key]>;
  createLogging?<Key extends keyof LoggingConstructors>(
    key: Key,
    args: ConstructorParameters<LoggingConstructors[Key]>,
    runtime: typeof loggingCommercialRuntime
  ): InstanceType<LoggingConstructors[Key]>;
  createStatusPageService?(
    args: ConstructorParameters<typeof StatusPageService>,
    runtime: typeof statusPageCommercialRuntime
  ): StatusPageService;
  createDockerRegistryService?(
    Base: typeof DockerInternalRegistryService,
    args: ConstructorParameters<typeof DockerInternalRegistryService>,
    runtime: typeof dockerRegistryCommercialRuntime
  ): DockerInternalRegistryService;
  createDockerManagementService?(
    Base: typeof DockerManagementService,
    args: ConstructorParameters<typeof DockerManagementService>,
    runtime: typeof dockerManagementCommercialRuntime
  ): DockerManagementService;
  executeDockerArchive?<Key extends keyof DockerArchiveOperations>(
    key: Key,
    args: Parameters<DockerArchiveOperations[Key]>[0],
    runtime: typeof dockerArchiveCommercialRuntime
  ): ReturnType<DockerArchiveOperations[Key]>;
  createDockerAvailabilityService?(
    setup: DockerAvailabilitySetup,
    runtime: typeof dockerAvailabilityCommercialRuntime
  ): DockerAvailabilityService;
  createDockerMigration?<Key extends keyof DockerMigrationConstructors>(
    key: Key,
    args: ConstructorParameters<DockerMigrationConstructors[Key]>,
    runtime: typeof dockerMigrationCommercialRuntime
  ): InstanceType<DockerMigrationConstructors[Key]>;
  createDockerDeployment?<Key extends keyof DockerDeploymentConstructors>(
    key: Key,
    args: ConstructorParameters<DockerDeploymentConstructors[Key]>,
    runtime: typeof dockerDeploymentCommercialRuntime
  ): InstanceType<DockerDeploymentConstructors[Key]>;
  createDockerBuild?<Key extends keyof DockerBuildConstructors>(
    key: Key,
    args: ConstructorParameters<DockerBuildConstructors[Key]>,
    runtime: typeof dockerBuildCommercialRuntime
  ): InstanceType<DockerBuildConstructors[Key]>;
  createDockerSourceService?(
    args: ConstructorParameters<typeof DockerSourceService>,
    runtime: typeof dockerSourceCommercialRuntime
  ): DockerSourceService;
  createAIRunService?(
    Base: typeof AIRunService,
    args: ConstructorParameters<typeof AIRunService>,
    runtime: typeof aiRunCommercialRuntime
  ): AIRunService;
  initializeAI?(runtime: typeof aiCommercialRuntime): void;
  planning?: AIPlanningRuntime;
  createAISandboxJobsService?(
    args: ConstructorParameters<typeof AISandboxJobsService>,
    runtime: typeof aiCommercialRuntime
  ): AISandboxJobsService;
  createAISandboxService?(
    args: ConstructorParameters<typeof AISandboxService>,
    runtime: typeof aiCommercialRuntime
  ): AISandboxService;
  listAIScenarios?(user: User, context?: PageContext): Promise<AIScenarioDefinition[]>;
  createAIPlanService?(
    args: ConstructorParameters<typeof AIPlanService>,
    runtime: typeof aiCommercialRuntime
  ): AIPlanService;
  initializeBackups?(scheduler: SchedulerService, runtime: typeof backupRuntime, relay?: RelayPolicyService): void;
  executeBackupTool?(user: User, args: Record<string, unknown>, runtime: typeof backupRuntime): Promise<unknown>;
  createManagedDatabase?<Key extends keyof ManagedDatabaseConstructors>(
    key: Key,
    args: ConstructorParameters<ManagedDatabaseConstructors[Key]>,
    runtime: typeof managedDatabaseRuntime
  ): InstanceType<ManagedDatabaseConstructors[Key]>;
  createManagedStorage?<Key extends keyof ManagedStorageConstructors>(
    key: Key,
    args: ConstructorParameters<ManagedStorageConstructors[Key]>,
    runtime: typeof managedStorageRuntime
  ): InstanceType<ManagedStorageConstructors[Key]>;
  /** Optional: cores older than container links omit it. */
  createContainerLinks?(
    args: ConstructorParameters<typeof ContainerLinksService>,
    runtime: typeof containerLinksRuntime
  ): ContainerLinksService;
  executeDatabaseTool?(
    context: DatabaseToolContext,
    user: User,
    name: string,
    args: Record<string, unknown>,
    runtime: typeof databaseToolRuntime
  ): Promise<unknown>;
  createDatabaseMonitoring?(
    Base: typeof DatabaseMonitoringService,
    args: ConstructorParameters<typeof DatabaseMonitoringService>,
    runtime: typeof databaseCommercialRuntime
  ): DatabaseMonitoringService;
  createDatabaseService?(
    Base: typeof DatabaseConnectionService,
    args: ConstructorParameters<typeof DatabaseConnectionService>,
    runtime: typeof databaseCommercialRuntime
  ): DatabaseConnectionService;
  executeStorageTool?(
    user: User,
    name: string,
    args: Record<string, unknown>,
    runtime: typeof storageToolRuntime
  ): Promise<unknown>;
  createStorageMonitoring?(
    Base: typeof ObjectStorageMonitoringService,
    args: ConstructorParameters<typeof ObjectStorageMonitoringService>,
    runtime: typeof storageCommercialRuntime
  ): ObjectStorageMonitoringService;
  createStorageUploads?(
    Base: typeof ObjectStorageUploadService,
    args: ConstructorParameters<typeof ObjectStorageUploadService>,
    runtime: typeof storageCommercialRuntime
  ): ObjectStorageUploadService;
  createObjectStorageService?(
    Base: typeof ObjectStorageService,
    args: ConstructorParameters<typeof ObjectStorageService>,
    runtime: typeof storageCommercialRuntime
  ): ObjectStorageService;
  createStorageBackend?: StorageBackendFactory;
  vcsProviders?: readonly VcsConnectorProvider[];
  createIntegrationsService?(
    Base: typeof IntegrationsService,
    args: ConstructorParameters<typeof IntegrationsService>,
    runtime: typeof integrationCommercialRuntime
  ): IntegrationsService;
  registerRoutes?(host: CommercialRouteHost): void;
  registerJobs?(scheduler: SchedulerService): void;
  lifecycle?: CommercialLifecycle;
}

export interface CommercialModule {
  apiVersion: typeof COMMERCIAL_HOST_API_VERSION;
  register(host: CommercialHost): CommercialRegistration | Promise<CommercialRegistration>;
}

export type CommercialEditionStatus =
  | { state: 'community' }
  | { state: 'unavailable'; reason: 'invalid_package' }
  | { state: 'ready'; version: string; releaseId: string };

import type { PkiConstructors, pkiCommercialRuntime } from '@/modules/pki/pki-commercial-runtime.js';
import type { pkiRouteRuntime } from '@/modules/pki/pki-route-runtime.js';
import type { RelayRegistryIngressService } from '@/services/relay-registry-ingress.service.js';
import type { acceptedOperations } from './accepted-operations.js';
