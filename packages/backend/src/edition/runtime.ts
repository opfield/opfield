import { logger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
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
import type { SiemConstructors, siemCommercialRuntime } from '@/modules/audit/siem-commercial-runtime.js';
import type { backupRuntime } from '@/modules/backups/backup-runtime.js';
import type { databaseCommercialRuntime } from '@/modules/databases/database-commercial-runtime.js';
import type { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
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
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { LoggingConstructors, loggingCommercialRuntime } from '@/modules/logging/logging-commercial-runtime.js';
import type { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import type { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import type { ObjectStorageUploadService } from '@/modules/object-storage/object-storage-upload.service.js';
import type { StorageBackendFactory } from '@/modules/object-storage/storage-backend.js';
import type { storageCommercialRuntime } from '@/modules/object-storage/storage-commercial-runtime.js';
import type { storageToolRuntime } from '@/modules/object-storage/storage-tool-runtime.js';
import type { PagesConstructors, pagesCommercialRuntime } from '@/modules/pages/pages-commercial-runtime.js';
import type { StatusPageService } from '@/modules/status-page/status-page.service.js';
import type { statusPageCommercialRuntime } from '@/modules/status-page/status-page-commercial-runtime.js';
import type { ManagedStorageConstructors, managedStorageRuntime } from '@/modules/storage/managed-storage-runtime.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
import type { SchedulerService } from '@/services/scheduler.service.js';
import type { User } from '@/types.js';
import type {
  CommercialEditionStatus,
  CommercialHost,
  CommercialOrchestrationActivity,
  CommercialRegistration,
  CommercialRouteHost,
} from './contract.js';
import { type LoadedCommercialPackage, loadCommercialPackage } from './loader.js';
import { commercialModuleUnavailable } from './unavailable.js';

/** One instance owns package registration and every lifecycle invocation. */
export class CommercialEditionRuntime {
  private registration: CommercialRegistration = {};
  private started?: Promise<void>;
  private quiesced?: Promise<void>;
  private drained?: Promise<void>;
  private forced?: Promise<void>;
  private closed?: Promise<void>;
  private routesRegistered = false;
  private jobsRegistered = false;
  private stopping = false;

  private constructor(private readonly editionStatus: CommercialEditionStatus) {}

  static community(): CommercialEditionRuntime {
    return new CommercialEditionRuntime({ state: 'community' });
  }

  static unavailable(): CommercialEditionRuntime {
    return new CommercialEditionRuntime({ state: 'unavailable', reason: 'invalid_package' });
  }

  static async register(loaded: LoadedCommercialPackage, host: CommercialHost): Promise<CommercialEditionRuntime> {
    const runtime = new CommercialEditionRuntime({
      state: 'ready',
      version: loaded.manifest.version,
      releaseId: loaded.releaseId,
    });
    const registration = await loaded.module.register(host);
    if (!registration || typeof registration !== 'object') throw new Error('Commercial registration is invalid');
    if (registration.registerRoutes !== undefined && typeof registration.registerRoutes !== 'function') {
      throw new Error('Commercial route registration is invalid');
    }
    if (
      registration.lifecycle &&
      ['start', 'quiesce', 'drain', 'forceClose', 'close'].some(
        (hook) =>
          typeof registration.lifecycle?.[hook as keyof NonNullable<CommercialRegistration['lifecycle']>] !== 'function'
      )
    )
      throw new Error('Commercial lifecycle is incomplete');
    runtime.registration = registration;
    return runtime;
  }

  get status(): CommercialEditionStatus {
    return { ...this.editionStatus };
  }

  initializeAI(runtime: typeof aiCommercialRuntime): void {
    this.registration.initializeAI?.(runtime);
  }

  get planning(): AIPlanningRuntime | undefined {
    return this.registration.planning;
  }

  createAIPlanService(
    Base: typeof AIPlanService,
    args: ConstructorParameters<typeof AIPlanService>,
    runtime: typeof aiCommercialRuntime
  ): AIPlanService {
    return this.registration.createAIPlanService?.(args, runtime) ?? new Base(...args);
  }

  createDockerSourceService(
    Base: typeof DockerSourceService,
    args: ConstructorParameters<typeof DockerSourceService>,
    runtime: typeof dockerSourceCommercialRuntime
  ): DockerSourceService {
    return this.registration.createDockerSourceService?.(args, runtime) ?? new Base(...args);
  }

  createDockerBuild<Key extends keyof DockerBuildConstructors>(
    key: Key,
    args: ConstructorParameters<DockerBuildConstructors[Key]>,
    runtime: typeof dockerBuildCommercialRuntime
  ): InstanceType<DockerBuildConstructors[Key]> {
    return (
      this.registration.createDockerBuild?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<DockerBuildConstructors[Key]>)
    );
  }

  createDockerDeployment<Key extends keyof DockerDeploymentConstructors>(
    key: Key,
    args: ConstructorParameters<DockerDeploymentConstructors[Key]>,
    runtime: typeof dockerDeploymentCommercialRuntime
  ): InstanceType<DockerDeploymentConstructors[Key]> {
    return (
      this.registration.createDockerDeployment?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<DockerDeploymentConstructors[Key]>)
    );
  }

  createDockerManagementService(
    Base: typeof DockerManagementService,
    args: ConstructorParameters<typeof DockerManagementService>,
    runtime: typeof dockerManagementCommercialRuntime
  ): DockerManagementService {
    return this.registration.createDockerManagementService?.(Base, args, runtime) ?? new Base(...args);
  }

  createDockerRegistryService(
    Base: typeof DockerInternalRegistryService,
    args: ConstructorParameters<typeof DockerInternalRegistryService>,
    runtime: typeof dockerRegistryCommercialRuntime
  ): DockerInternalRegistryService {
    return this.registration.createDockerRegistryService?.(Base, args, runtime) ?? new Base(...args);
  }

  createRegistryIngress(
    Base: typeof RelayRegistryIngressService,
    args: ConstructorParameters<typeof RelayRegistryIngressService>,
    runtime: typeof dockerRegistryCommercialRuntime
  ): RelayRegistryIngressService {
    return this.registration.createRegistryIngress?.(Base, args, runtime) ?? new Base(...args);
  }

  createStatusPageService(
    args: ConstructorParameters<typeof StatusPageService>,
    runtime: typeof statusPageCommercialRuntime
  ): StatusPageService {
    return (
      this.registration.createStatusPageService?.(args, runtime) ?? new runtime.constructors.StatusPageService(...args)
    );
  }

  createLogging<Key extends keyof LoggingConstructors>(
    key: Key,
    args: ConstructorParameters<LoggingConstructors[Key]>,
    runtime: typeof loggingCommercialRuntime
  ): InstanceType<LoggingConstructors[Key]> {
    return (
      this.registration.createLogging?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<LoggingConstructors[Key]>)
    );
  }

  createPages<Key extends keyof PagesConstructors>(
    key: Key,
    args: ConstructorParameters<PagesConstructors[Key]>,
    runtime: typeof pagesCommercialRuntime
  ): InstanceType<PagesConstructors[Key]> {
    return (
      this.registration.createPages?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<PagesConstructors[Key]>)
    );
  }

  createAuditService(Base: typeof AuditService, args: ConstructorParameters<typeof AuditService>): AuditService {
    return this.registration.createAuditService?.(Base, args) ?? new Base(...args);
  }
  createPki<Key extends keyof PkiConstructors>(
    key: Key,
    args: ConstructorParameters<PkiConstructors[Key]>,
    runtime: typeof pkiCommercialRuntime
  ): InstanceType<PkiConstructors[Key]> {
    return (
      this.registration.createPki?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<PkiConstructors[Key]>)
    );
  }
  createSiem<Key extends keyof SiemConstructors>(
    key: Key,
    args: ConstructorParameters<SiemConstructors[Key]>,
    runtime: typeof siemCommercialRuntime
  ): InstanceType<SiemConstructors[Key]> {
    return (
      this.registration.createSiem?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<SiemConstructors[Key]>)
    );
  }

  executeDockerArchive<Key extends keyof DockerArchiveOperations>(
    key: Key,
    args: Parameters<DockerArchiveOperations[Key]>[0],
    runtime: typeof dockerArchiveCommercialRuntime
  ): ReturnType<DockerArchiveOperations[Key]> {
    if (!this.registration.executeDockerArchive) return commercialModuleUnavailable();
    return this.registration.executeDockerArchive(key, args, runtime);
  }

  createDockerAvailabilityService(
    setup: DockerAvailabilitySetup,
    runtime: typeof dockerAvailabilityCommercialRuntime
  ): DockerAvailabilityService {
    return (
      this.registration.createDockerAvailabilityService?.(setup, runtime) ??
      new runtime.constructors.DockerAvailabilityService(
        setup.db,
        setup.nodes,
        setup.license,
        setup.audit,
        setup.events,
        undefined,
        setup.environment,
        setup.workloads
      )
    );
  }

  createDockerMigration<Key extends keyof DockerMigrationConstructors>(
    key: Key,
    args: ConstructorParameters<DockerMigrationConstructors[Key]>,
    runtime: typeof dockerMigrationCommercialRuntime
  ): InstanceType<DockerMigrationConstructors[Key]> {
    return (
      this.registration.createDockerMigration?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<DockerMigrationConstructors[Key]>)
    );
  }

  createAIRunService(
    Base: typeof AIRunService,
    args: ConstructorParameters<typeof AIRunService>,
    runtime: typeof aiRunCommercialRuntime
  ): AIRunService {
    return this.registration.createAIRunService?.(Base, args, runtime) ?? new Base(...args);
  }

  createAISandboxJobsService(
    Base: typeof AISandboxJobsService,
    args: ConstructorParameters<typeof AISandboxJobsService>,
    runtime: typeof aiCommercialRuntime
  ): AISandboxJobsService {
    return this.registration.createAISandboxJobsService?.(args, runtime) ?? new Base(...args);
  }

  createAISandboxService(
    Base: typeof AISandboxService,
    args: ConstructorParameters<typeof AISandboxService>,
    runtime: typeof aiCommercialRuntime
  ): AISandboxService {
    return this.registration.createAISandboxService?.(args, runtime) ?? new Base(...args);
  }

  async listAIScenarios(user: User, context?: PageContext): Promise<AIScenarioDefinition[]> {
    return this.registration.listAIScenarios?.(user, context) ?? [];
  }

  initializeBackups(scheduler: SchedulerService, runtime: typeof backupRuntime, relay?: RelayPolicyService): void {
    if (this.registration.initializeBackups) this.registration.initializeBackups(scheduler, runtime, relay);
    else {
      runtime.container.registerInstance(runtime.BackupService, new runtime.BackupService());
      runtime.container.registerInstance(runtime.StorageCopyService, new runtime.StorageCopyService());
    }
  }

  async executeBackupTool(user: User, args: Record<string, unknown>, runtime: typeof backupRuntime): Promise<unknown> {
    this.requireAvailable();
    if (!this.registration.executeBackupTool)
      throw new AppError(503, 'COMMERCIAL_MODULE_UNAVAILABLE', 'Backup tools are unavailable');
    return this.registration.executeBackupTool(user, args, runtime);
  }

  get vcsProviders(): NonNullable<CommercialRegistration['vcsProviders']> {
    return this.registration.vcsProviders ?? [];
  }

  createManagedDatabase<Key extends keyof ManagedDatabaseConstructors>(
    key: Key,
    args: ConstructorParameters<ManagedDatabaseConstructors[Key]>,
    runtime: typeof managedDatabaseRuntime
  ): InstanceType<ManagedDatabaseConstructors[Key]> {
    return (
      this.registration.createManagedDatabase?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<ManagedDatabaseConstructors[Key]>)
    );
  }

  createManagedStorage<Key extends keyof ManagedStorageConstructors>(
    key: Key,
    args: ConstructorParameters<ManagedStorageConstructors[Key]>,
    runtime: typeof managedStorageRuntime
  ): InstanceType<ManagedStorageConstructors[Key]> {
    return (
      this.registration.createManagedStorage?.(key, args, runtime) ??
      (Reflect.construct(runtime.constructors[key], args) as InstanceType<ManagedStorageConstructors[Key]>)
    );
  }

  createContainerLinks(
    args: ConstructorParameters<typeof ContainerLinksService>,
    runtime: typeof containerLinksRuntime
  ): ContainerLinksService {
    return this.registration.createContainerLinks?.(args, runtime) ?? new runtime.ContainerLinksService(...args);
  }

  createDatabaseMonitoring(
    Base: typeof DatabaseMonitoringService,
    args: ConstructorParameters<typeof DatabaseMonitoringService>,
    runtime: typeof databaseCommercialRuntime
  ): DatabaseMonitoringService {
    return this.registration.createDatabaseMonitoring?.(Base, args, runtime) ?? new Base(...args);
  }

  createDatabaseService(
    Base: typeof DatabaseConnectionService,
    args: ConstructorParameters<typeof DatabaseConnectionService>,
    runtime: typeof databaseCommercialRuntime
  ): DatabaseConnectionService {
    return this.registration.createDatabaseService?.(Base, args, runtime) ?? new Base(...args);
  }

  readonly createStorageBackend: StorageBackendFactory = (config, options) => {
    this.requireAvailable();
    if (!this.registration.createStorageBackend)
      throw new AppError(503, 'COMMERCIAL_MODULE_UNAVAILABLE', 'Storage module is unavailable');
    return this.registration.createStorageBackend(config, options);
  };

  createObjectStorageService(
    Base: typeof ObjectStorageService,
    args: ConstructorParameters<typeof ObjectStorageService>,
    runtime: typeof storageCommercialRuntime
  ): ObjectStorageService {
    return this.registration.createObjectStorageService?.(Base, args, runtime) ?? new Base(...args);
  }

  createStorageMonitoring(
    Base: typeof ObjectStorageMonitoringService,
    args: ConstructorParameters<typeof ObjectStorageMonitoringService>,
    runtime: typeof storageCommercialRuntime
  ): ObjectStorageMonitoringService {
    return this.registration.createStorageMonitoring?.(Base, args, runtime) ?? new Base(...args);
  }

  createStorageUploads(
    Base: typeof ObjectStorageUploadService,
    args: ConstructorParameters<typeof ObjectStorageUploadService>,
    runtime: typeof storageCommercialRuntime
  ): ObjectStorageUploadService {
    return this.registration.createStorageUploads?.(Base, args, runtime) ?? new Base(...args);
  }

  createIntegrationsService(
    Base: typeof IntegrationsService,
    args: ConstructorParameters<typeof IntegrationsService>,
    runtime: typeof integrationCommercialRuntime
  ): IntegrationsService {
    return this.registration.createIntegrationsService?.(Base, args, runtime) ?? new Base(...args);
  }

  requireAvailable(): void {
    if (this.editionStatus.state === 'ready' && (!this.stopping || acceptedOperations.isActive())) return;
    throw new AppError(503, 'COMMERCIAL_MODULE_UNAVAILABLE', 'This operation requires an available commercial module');
  }

  async executeDatabaseTool(
    context: DatabaseToolContext,
    user: User,
    name: string,
    args: Record<string, unknown>,
    runtime: typeof databaseToolRuntime
  ): Promise<unknown> {
    this.requireAvailable();
    if (!this.registration.executeDatabaseTool)
      throw new AppError(503, 'COMMERCIAL_MODULE_UNAVAILABLE', 'Database tools are unavailable');
    return this.registration.executeDatabaseTool(context, user, name, args, runtime);
  }

  async executeStorageTool(
    user: User,
    name: string,
    args: Record<string, unknown>,
    runtime: typeof storageToolRuntime
  ): Promise<unknown> {
    this.requireAvailable();
    if (!this.registration.executeStorageTool)
      throw new AppError(503, 'COMMERCIAL_MODULE_UNAVAILABLE', 'Storage tools are unavailable');
    return this.registration.executeStorageTool(user, name, args, runtime);
  }

  registerRoutes(host: CommercialRouteHost): void {
    if (this.routesRegistered) throw new Error('Commercial routes are already registered');
    this.routesRegistered = true;
    this.registration.registerRoutes?.(host);
  }

  registerJobs(scheduler: SchedulerService): void {
    if (this.jobsRegistered) throw new Error('Commercial jobs are already registered');
    this.jobsRegistered = true;
    this.registration.registerJobs?.(scheduler);
  }

  /** Null when the installed core cannot report its orchestration work. */
  async activeOrchestrationOperations(): Promise<CommercialOrchestrationActivity[] | null> {
    const orchestration = this.registration.orchestration;
    if (typeof orchestration?.activeOperations !== 'function') return null;
    return orchestration.activeOperations();
  }

  /** Returns false when the installed core cannot hold new orchestration work. */
  setOrchestrationAdmissionHold(reason: string | null): boolean {
    const orchestration = this.registration.orchestration;
    if (typeof orchestration?.setAdmissionHold !== 'function') return false;
    orchestration.setAdmissionHold(reason);
    return true;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Commercial jobs cannot restart during shutdown'));
    return (this.started ??= Promise.resolve().then(() => this.registration.lifecycle?.start()));
  }

  quiesce(): Promise<void> {
    this.stopping = true;
    return (this.quiesced ??= Promise.resolve().then(async () => {
      await this.started;
      await this.registration.lifecycle?.quiesce();
    }));
  }

  drain(deadline: number): Promise<void> {
    return (this.drained ??= this.quiesce().then(() => this.registration.lifecycle?.drain(deadline)));
  }

  forceClose(): Promise<void> {
    this.stopping = true;
    return (this.forced ??= Promise.resolve().then(() => this.registration.lifecycle?.forceClose()));
  }

  close(deadline: number): Promise<void> {
    return (this.closed ??= this.quiesce().then(() => this.registration.lifecycle?.close(deadline)));
  }
}

export async function initializeCommercialEdition(host: CommercialHost): Promise<CommercialEditionRuntime> {
  let loaded: LoadedCommercialPackage | null;
  try {
    loaded = await loadCommercialPackage({
      directory: host.env.OPFIELD_COMMERCIAL_DIR,
      hostVersion: host.env.APP_VERSION,
    });
  } catch (error) {
    logger.error('Installed commercial package was rejected before registration', { error });
    return CommercialEditionRuntime.unavailable();
  }
  if (!loaded) return CommercialEditionRuntime.community();
  // Registration errors abort startup: the package may already have registered
  // services, so falling back here would leave a partially initialized host.
  return CommercialEditionRuntime.register(loaded, host);
}

import type { PkiConstructors, pkiCommercialRuntime } from '@/modules/pki/pki-commercial-runtime.js';
import type { RelayRegistryIngressService } from '@/services/relay-registry-ingress.service.js';
import { acceptedOperations } from './accepted-operations.js';
