import 'reflect-metadata';
import type { getEnv } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { OperationLeaseStore } from '@/db/operation-lease.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { ACMERenewalJob } from '@/jobs/acme-renewal.job.js';
import { DaemonUpdateCheckJob } from '@/jobs/daemon-update-check.job.js';
import { DnsCheckJob } from '@/jobs/dns-check.job.js';
import { ExpiryAlertJob } from '@/jobs/expiry-alert.job.js';
import { HealthCheckJob } from '@/jobs/health-check.job.js';
import { HousekeepingJob } from '@/jobs/housekeeping.job.js';
import { NotificationRetryJob } from '@/jobs/notification-retry.job.js';
import { SiemDeliveryJob } from '@/jobs/siem-delivery.job.js';
import { UpdateCheckJob } from '@/jobs/update-check.job.js';
import { logger } from '@/lib/logger.js';
import { repairDanglingResourceScopes } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import { AppIncidentRunner } from '@/modules/apps/app-incident-runner.js';
import { AppMaintenanceService } from '@/modules/apps/app-maintenance.service.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { backupRuntime } from '@/modules/backups/backup-runtime.js';
import { CloudLinkService } from '@/modules/cloud-link/cloud-link.service.js';
import { createCloudLinkActions } from '@/modules/cloud-link/cloud-link-actions.js';
import { CloudLinkAgent } from '@/modules/cloud-link/cloud-link-agent.js';
import { CloudLinkEnrollFile, createEnrollFileLicense } from '@/modules/cloud-link/cloud-link-enroll-file.js';
import { CloudManagedSso } from '@/modules/cloud-link/cloud-link-managed-sso.js';
import { createCloudLinkProbe } from '@/modules/cloud-link/cloud-link-probe.js';
import { createCloudSsoClient } from '@/modules/cloud-link/cloud-link-sso-client.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { DiagnosticsService } from '@/modules/diagnostics/diagnostics.service.js';
import { createOpfieldAlertObserver } from '@/modules/diagnostics/diagnostics-alerts.js';
import { PostgresProbe } from '@/modules/diagnostics/postgres-probe.js';
import { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import { AvailabilityLeaseService } from '@/modules/docker/availability/lease/availability-lease.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerBuildService } from '@/modules/docker/docker-build.service.js';
import { DockerBuildRunnerService } from '@/modules/docker/docker-build-runner.service.js';
import { DockerHealthCheckService } from '@/modules/docker/docker-health-check.service.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { OrphanedSourceBindingRepair } from '@/modules/docker/docker-source-orphan-repair.js';
import { DockerTaskReconciler } from '@/modules/docker/docker-task-reconciler.js';
import { detectPublicIP, initDnsResolver } from '@/modules/domains/dns.utils.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { HostingConnectorsService } from '@/modules/hosting/hosting-connectors.service.js';
import { HostingFinanceService } from '@/modules/hosting/hosting-finance.service.js';
import { HostingFirewallService } from '@/modules/hosting/hosting-firewall.service.js';
import { HostingInventoryService } from '@/modules/hosting/hosting-inventory.service.js';
import { HostingManagementService } from '@/modules/hosting/hosting-management.service.js';
import { HostingObservationsService } from '@/modules/hosting/hosting-observations.service.js';
import { HostingProvisioningService } from '@/modules/hosting/hosting-provisioning.service.js';
import { IngressGroupConvergence } from '@/modules/ingress-groups/ingress-group-convergence.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { LICENSE_SCHEDULER_INTERVAL_MS } from '@/modules/license/license.types.js';
import { LICENSE_ENDPOINTS_REFRESH_INTERVAL_MS } from '@/modules/license/license-endpoints.js';
import { LicenseEntitlementReconcilerService } from '@/modules/license/license-entitlement-reconciler.service.js';
import { LicenseModuleService } from '@/modules/license/license-module.service.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { NODE_MONITORING_CADENCE_MS } from '@/modules/nodes/node-monitoring.service.js';
import { NotificationAlertRuleService } from '@/modules/notifications/notification-alert-rule.service.js';
import { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import { NotificationDispatcherService } from '@/modules/notifications/notification-dispatcher.service.js';
import { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { NotificationWebhookService } from '@/modules/notifications/notification-webhook.service.js';
import {
  OpfieldOutboundMonitor,
  OUTBOUND_CHECK_INTERVAL_MS,
} from '@/modules/notifications/opfield-outbound-monitor.js';
import {
  ObjectStorageMonitoringService,
  type StorageMetricSnapshot,
} from '@/modules/object-storage/object-storage-monitoring.service.js';
import { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import { TemplatesService } from '@/modules/pki/templates.service.js';
import { AdditionalRouteService } from '@/modules/proxy/additional-route.service.js';
import { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { InternalCertificateRenewalService } from '@/modules/ssl/internal-cert-renewal.service.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { CacheService, type RedisClient } from '@/services/cache.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { DockerService } from '@/services/docker.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { ManagedLeftoverRepair } from '@/services/managed-leftover-repair.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  OPFIELD_IDENTITY_RENEWAL_CHECK_INTERVAL_MS,
  OpfieldIdentityRenewalService,
} from '@/services/opfield-identity-renewal.service.js';
import { OpfieldLifecycleService } from '@/services/opfield-lifecycle.service.js';
import { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { isExpectedSyncFailure } from '@/services/relay-registry-sync.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import {
  SYSTEM_CERTIFICATE_RENEWAL_CHECK_INTERVAL_MS,
  SystemCertificateRenewalService,
} from '@/services/system-certificate-renewal.service.js';
import { UpdateService } from '@/services/update.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';

export async function initializeBackgroundServices(): Promise<void> {
  const env = container.resolve<ReturnType<typeof getEnv>>(TOKENS.Env);
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const notifRuleService = container.resolve(NotificationAlertRuleService);
  const notifWebhookService = container.resolve(NotificationWebhookService);
  const notifDispatcherService = container.resolve(NotificationDispatcherService);
  const cacheService = container.resolve(CacheService);
  const nodeRegistry = container.resolve(NodeRegistryService);
  const loggingEnvironmentService = container.resolve(LoggingEnvironmentService);
  const loggingClickHouseService = container.resolve(LoggingClickHouseService);
  const dockerManagementService = container.resolve(DockerManagementService);
  const dockerAvailabilityService = container.resolve(DockerAvailabilityService);
  const dockerHealthCheckService = container.resolve(DockerHealthCheckService);
  const databaseMonitoringService = container.resolve(DatabaseMonitoringService);
  const proxyService = container.resolve(ProxyService);
  const licenseEntitlementReconciler = container.resolve(LicenseEntitlementReconcilerService);
  const housekeepingService = container.resolve(HousekeepingService);
  const notifDeliveryService = container.resolve(NotificationDeliveryService);
  const siemDeliveryService = container.resolve(SiemDeliveryService);
  const templatesService = container.resolve(TemplatesService);
  const nginxTemplateService = container.resolve(NginxTemplateService);
  const relayPolicyService = container.isRegistered(RelayPolicyService)
    ? container.resolve(RelayPolicyService)
    : undefined;
  const relayPoolService = container.isRegistered(RelayPoolService) ? container.resolve(RelayPoolService) : undefined;
  const systemCertificateLifecycleService = container.resolve(SystemCertificateLifecycleService);
  const nginxCertificateDistribution = container.resolve(NginxCertificateDistributionService);
  const sslService = container.resolve(SSLService);
  const alertService = container.resolve(AlertService);
  const nodeDispatch = container.resolve(NodeDispatchService);
  const domainsService = container.resolve(DomainsService);
  const additionalRouteService = container.resolve(AdditionalRouteService);
  const dockerBuildService = container.resolve(DockerBuildService);
  const dockerBuildRunnerService = container.isRegistered(DockerBuildRunnerService)
    ? container.resolve(DockerBuildRunnerService)
    : undefined;
  const dockerSourceService = container.resolve(DockerSourceService);
  const dockerInternalRegistryService = container.resolve(DockerInternalRegistryService);
  const dockerSnapshotReconciler = container.resolve(DockerSnapshotReconciler);
  const dockerSnapshotService = container.resolve(DockerSnapshotService);
  const updateService = container.resolve(UpdateService);
  const eventBus = container.resolve(EventBusService);
  const licenseService = container.resolve(LicenseService);
  const generalSettingsService = container.resolve(GeneralSettingsService);
  const daemonUpdateService = container.resolve(DaemonUpdateService);
  const loggingMaintenanceService = container.resolve(LoggingMaintenanceService);
  const integrationsService = container.resolve(IntegrationsService);
  const externalSshService = container.resolve(ExternalSshService);
  const readModelCoordinator = container.resolve(ReadModelCoordinator);

  // Configure DNS resolvers and detect public IP
  initDnsResolver(
    env.DNS_RESOLVERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  await detectPublicIP(env.PUBLIC_IPV4, env.PUBLIC_IPV6);

  const notifEvaluatorService = new NotificationEvaluatorService(
    db,
    notifRuleService,
    notifWebhookService,
    notifDispatcherService,
    cacheService,
    nodeRegistry
  );
  notifEvaluatorService.setEventBus(eventBus);
  notifEvaluatorService.setLoggingServices(loggingEnvironmentService, loggingClickHouseService);
  dockerManagementService.setEvaluator(notifEvaluatorService);
  dockerHealthCheckService.setEvaluator(notifEvaluatorService);
  databaseMonitoringService.setEvaluator(notifEvaluatorService);
  databaseMonitoringService.setEventBus(eventBus);
  nodeRegistry.setEvaluator(notifEvaluatorService);
  proxyService.setEvaluator(notifEvaluatorService);
  // Managed storage metrics (disk usage) come with each monitoring sample of its storage connection.
  if (container.isRegistered(ObjectStorageMonitoringService)) {
    container
      .resolve(ObjectStorageMonitoringService)
      .on('snapshot', ({ snapshot }: { snapshot: StorageMetricSnapshot }) => {
        notifEvaluatorService
          .evaluateStorageSnapshot(snapshot)
          .catch((error) => logger.warn('Failed to evaluate storage alert rules', { error }));
      });
  }
  notifEvaluatorService.start();
  container.registerInstance(NotificationEvaluatorService, notifEvaluatorService);
  await licenseEntitlementReconciler.start();

  housekeepingService.setNotifDeliveryService(notifDeliveryService);
  housekeepingService.setSiemDeliveryService(siemDeliveryService);

  // Seed built-in templates
  await templatesService.seedBuiltinTemplates();
  await nginxTemplateService.seedBuiltinTemplates();

  // Background jobs
  const scheduler = new SchedulerService();
  container.registerInstance(SchedulerService, scheduler);

  // Opfield's own diagnostics: one sample a minute for the 48-hour history and Opfield alerts.
  const diagnosticsService = new DiagnosticsService(
    db,
    container.resolve<RedisClient>(TOKENS.RedisClient),
    container.resolve(DockerService),
    scheduler,
    container.resolve(OpfieldLifecycleService),
    container.resolve(PostgresProbe),
    env.APP_VERSION
  );
  container.registerInstance(DiagnosticsService, diagnosticsService);
  diagnosticsService.setObserver(createOpfieldAlertObserver(notifEvaluatorService));
  // The installation's one socket to its cloud account; started with the scheduler, on the replica holding its lease.
  container.registerInstance(
    CloudLinkAgent,
    new CloudLinkAgent(
      container.resolve(CloudLinkService),
      new OperationLeaseStore(db),
      createCloudLinkProbe(diagnosticsService, env.APP_VERSION, createCloudLinkActions())
    )
  );
  // When the cloud link ends or switches accounts, the sign-in the cloud gave goes with it (see CloudSsoClient.detach).
  const cloudSsoClient = createCloudSsoClient();
  container.resolve(CloudLinkService).setSignInDetacher((reason) => cloudSsoClient.detach(reason));
  // A managed installation enrols itself from the code its provisioning left in the app container.
  const cloudEnrollFile = new CloudLinkEnrollFile(
    container.resolve(CloudLinkService),
    new OperationLeaseStore(db),
    createEnrollFileLicense(licenseService, container.resolve(LicenseModuleService))
  );
  // ... and comes up signed in with the Opfield account when the file carries the account's client and owner.
  cloudEnrollFile.setManagedSso(
    new CloudManagedSso({
      db,
      oidcSettings: container.resolve(OidcSettingsService),
      authSettings: container.resolve(AuthSettingsService),
      generalSettings: container.resolve(GeneralSettingsService),
      setupPolicy: container.resolve(SetupTokenPolicyService),
      finalizeSetup: container.resolve(FinalizeSetupService),
      invalidateOidc: () => container.resolve(AuthService).invalidateOidcConfiguration(),
      refreshIdentities: async () => {
        await container.resolve(OpfieldIdentityRenewalService).refreshGrpcIdentity();
        if ((await container.resolve(WebTransportSettingsService).getConfig()).tlsEnabled) {
          await container.resolve(WebIdentityService).refresh();
        }
      },
      closeSetupAccess: () => container.resolve(SetupAccessService).invalidate(),
      enableMcpServer: async () => {
        await container.resolve(McpSettingsService).updateConfig({ serverEnabled: true });
      },
      audit: (details) => container.resolve(CloudLinkService).recordManagedSso(details),
    })
  );
  container.registerInstance(CloudLinkEnrollFile, cloudEnrollFile);
  scheduler.registerInterval('opfield-diagnostics-sample', 60_000, () => diagnosticsService.sampleMinute());
  container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .initializeBackups(scheduler, backupRuntime, relayPolicyService);
  // Grants naming deleted resources: left behind by older releases, repaired at every start (idempotent), then
  // swept hourly as a safety net for any deletion path that misses the in-transaction cleanup.
  await repairDanglingResourceScopes(db).catch((error) =>
    logger.warn('Failed to remove permissions naming deleted resources', { error })
  );
  scheduler.registerInterval('dangling-resource-permissions', 60 * 60 * 1000, async () => {
    await repairDanglingResourceScopes(db);
  });
  // Container Git sources left behind by containers removed under older releases. A container must be seen absent
  // in two passes at least 5 minutes apart (a recreate briefly hides its name), so: at start, again at +6 minutes
  // (a restart still repairs in one go), then hourly. Offline nodes and unknown inventory are never acted on.
  const orphanedSourceBindings = new OrphanedSourceBindingRepair(db, {
    isNodeOnline: (nodeId) => !!nodeRegistry.getNode(nodeId),
    listContainers: (nodeId) => nodeDispatch.sendDockerContainerCommand(nodeId, 'list'),
    hasActiveTransition: (nodeId, name) => !!dockerManagementService.getContainerTransition(nodeId, name),
  });
  await orphanedSourceBindings
    .run()
    .catch((error) => logger.warn('Failed to remove orphaned container source bindings', { error }));
  setTimeout(
    () => {
      orphanedSourceBindings
        .run()
        .catch((error) => logger.warn('Failed to remove orphaned container source bindings', { error }));
    },
    6 * 60 * 1000
  ).unref?.();
  scheduler.registerInterval('orphaned-container-source-bindings', 60 * 60 * 1000, async () => {
    await orphanedSourceBindings.run();
  });
  // What managed databases and storage left on their nodes without a record (a container of a deleted instance, a
  // record zeroed by a crash): removed once Opfield has no instance of the id in two passes 5+ minutes apart. The
  // first pass waits a minute for the nodes to connect, the second confirms at +7 minutes, then every 30 minutes.
  // Daemons without the leftovers action are left alone.
  const managedLeftovers = new ManagedLeftoverRepair(db, {
    isNodeOnline: (nodeId) => !!nodeRegistry.getNode(nodeId),
    listLeftovers: (nodeId, kind) =>
      kind === 'storage'
        ? nodeDispatch.sendDockerStorageCommand(nodeId, 'leftovers', '', '', 15_000)
        : nodeDispatch.sendDockerDatabaseCommand(nodeId, 'leftovers', '', '', 15_000),
    removeLeftover: (nodeId, kind, id, memberId) => {
      const payload = JSON.stringify(memberId ? { leftover: true, memberId } : { leftover: true });
      return kind === 'storage'
        ? nodeDispatch.sendDockerStorageCommand(nodeId, 'remove', id, payload)
        : nodeDispatch.sendDockerDatabaseCommand(nodeId, 'remove', id, payload);
    },
    audit: async ({ nodeId, kind, leftover }) => {
      await container.resolve(AuditService).log({
        userId: null,
        action: 'node.managed_leftover.removed',
        resourceType: 'node',
        resourceId: nodeId,
        details: {
          kind,
          instanceId: leftover.id,
          record: leftover.record,
          ...(leftover.record === 'member' ? { setId: leftover.setId, memberId: leftover.memberId } : {}),
          containers: leftover.containers ?? [],
          imageBytes: leftover.imageBytes,
          allocatedBytes: leftover.allocatedBytes,
        },
      });
    },
  });
  const runManagedLeftovers = () =>
    managedLeftovers.run().catch((error) => logger.warn('Failed to check managed leftovers on nodes', { error }));
  setTimeout(() => void runManagedLeftovers(), 60 * 1000).unref?.();
  setTimeout(() => void runManagedLeftovers(), 7 * 60 * 1000).unref?.();
  scheduler.registerInterval('managed-leftovers', 30 * 60 * 1000, async () => {
    await managedLeftovers.run();
  });
  scheduler.registerInterval('system-certificate-crl-retry', 5 * 60 * 1000, async () => {
    await systemCertificateLifecycleService.retryPendingCRLs();
  });
  scheduler.registerInterval('opfield-identity-renewal', OPFIELD_IDENTITY_RENEWAL_CHECK_INTERVAL_MS, async () => {
    await container.resolve(OpfieldIdentityRenewalService).renewDue();
  });
  // Managed storage and database TLS certificates (hot reload, restart only as the last resort).
  scheduler.registerInterval('system-certificate-renewal', SYSTEM_CERTIFICATE_RENEWAL_CHECK_INTERVAL_MS, async () => {
    if (container.isRegistered(SystemCertificateRenewalService)) {
      await container.resolve(SystemCertificateRenewalService).renewDue();
    }
  });
  // First pass shortly after start, once node daemons have reconnected, so a
  // certificate that must be repaired (missing loopback names) does not wait an hour.
  setTimeout(
    () => {
      if (!container.isRegistered(SystemCertificateRenewalService)) return;
      container
        .resolve(SystemCertificateRenewalService)
        .renewDue()
        .catch((error) => logger.warn('Initial system certificate renewal pass failed', { error }));
    },
    2 * 60 * 1000
  ).unref?.();
  if (relayPolicyService) {
    scheduler.registerInterval('relay-policy-sync', 30_000, () =>
      relayPolicyService!
        .reconcileAndSync()
        .then(() => undefined)
        .catch((error) => {
          // The local relay is away (stopped, restarting, Opfield started before it): its outage is reported on its
          // own, and this job runs again in 30 s (stand rc.9, O-1: ERROR "Name resolution failed for dns:relay").
          if (!isExpectedSyncFailure(error)) throw error;
          logger.debug('Relay policy sync waits for the local relay', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
    );
    scheduler.registerInterval('relay-grant-refresh', 15 * 60 * 1000, () =>
      relayPolicyService!.refreshAllNodeGrantsIfDue().then(() => undefined)
    );
    scheduler.registerInterval('relay-signing-key-rotation', 60 * 60 * 1000, () =>
      relayPolicyService!.rotateIfDue().then(() => undefined)
    );
    scheduler.registerInterval('relay-pool-policy-lease-refresh', 5 * 60 * 1000, () =>
      relayPoolService!.refreshRemotePolicies()
    );
    // Same baseline cadence as ordinary node monitoring. Link Runtime pages
    // add focused 2s samples, but history does not depend on a page being open.
    scheduler.registerInterval('secure-link-runtime-monitoring', NODE_MONITORING_CADENCE_MS.background, () =>
      proxyService.collectSecureLinkRuntimeSnapshots()
    );
  }
  // Ingress groups converge without an operator: joining members are promoted, draining members cleaned up once
  // DNS moved, and routes or certificates that missed a connected member are delivered again.
  const ingressGroupConvergence = container.resolve(IngressGroupConvergence);
  scheduler.registerInterval('ingress-group-convergence', 60 * 1000, () => ingressGroupConvergence.reconcile());
  eventBus.subscribe('node.changed', (payload) => {
    const event = payload as { status?: string } | undefined;
    if (event?.status === 'online') {
      void ingressGroupConvergence
        .reconcile()
        .catch((error) => logger.warn('Ingress group convergence after a node reconnect failed', { error }));
    }
  });
  scheduler.registerInterval('nginx-tls-certificate-integrity', 6 * 60 * 60 * 1000, async () => {
    await nginxCertificateDistribution.reconcileIntegrity();
    await nginxCertificateDistribution.cleanupDueReplicas();
  });

  const acmeRenewalJob = new ACMERenewalJob(db, sslService, alertService);
  acmeRenewalJob.setEventBus(eventBus);
  const healthCheckJob = new HealthCheckJob(db, nodeDispatch);
  healthCheckJob.setEventBus(eventBus);
  healthCheckJob.setEvaluator(notifEvaluatorService);
  if (container.isRegistered(RelaySupervisorService)) {
    healthCheckJob.setLocalRelayOutage(container.resolve(RelaySupervisorService));
  }
  const expiryAlertJob = new ExpiryAlertJob(db, alertService);
  expiryAlertJob.setEventBus(eventBus);
  // Rotate GitLab tokens that can rotate themselves before alerting on the rest.
  expiryAlertJob.setGitTokenMaintenance(() => integrationsService.maintainGitTokens());

  const dnsCheckJob = new DnsCheckJob(domainsService);
  scheduler.registerInterval('dns-check', env.DNS_CHECK_INTERVAL_SECONDS * 1000, () => dnsCheckJob.run());

  scheduler.register('acme-renewal', env.ACME_RENEWAL_CRON, () => acmeRenewalJob.run());
  // Linked internal PKI leaves are reissued from their CA on the same daily cadence.
  const internalCertificateRenewal = container.resolve(InternalCertificateRenewalService);
  scheduler.register('internal-certificate-renewal', env.ACME_RENEWAL_CRON, async () => {
    await internalCertificateRenewal.repairMissingIssuerChains();
    await internalCertificateRenewal.runDue();
  });
  // Internal certificates delivered by older releases lack their intermediate
  // CAs; add them shortly after start, once Nginx daemons have reconnected.
  setTimeout(
    () => {
      internalCertificateRenewal
        .repairMissingIssuerChains()
        .catch((error) => logger.warn('Initial internal certificate issuer chain repair failed', { error }));
    },
    2 * 60 * 1000
  ).unref?.();
  // Scan at the minimum supported per-host cadence; the job itself evaluates
  // each host's configured interval and skips hosts that are not due.
  scheduler.registerInterval('health-check', Math.min(Math.max(env.HEALTH_CHECK_INTERVAL_SECONDS, 1), 5) * 1000, () =>
    healthCheckJob.run()
  );
  scheduler.registerInterval('proxy-maintenance-alerts', env.HEALTH_CHECK_INTERVAL_SECONDS * 1000, () =>
    notifEvaluatorService.reconcileProxyMaintenance()
  );
  scheduler.registerInterval('docker-health-check', 10000, () => dockerHealthCheckService.runDueChecks());
  scheduler.registerInterval('docker-availability-controller', 5000, () =>
    dockerAvailabilityService.processPendingOperations()
  );
  scheduler.registerInterval('docker-availability-lease', 5000, () =>
    container.resolve(AvailabilityLeaseService).reconcile()
  );
  scheduler.registerInterval('docker-build-lease-recovery', 15000, async () => {
    await dockerBuildService.recoverExpiredLeases();
  });
  if (dockerBuildRunnerService) {
    scheduler.registerInterval('docker-build-runner', 5000, () => dockerBuildRunnerService.reconcile());
  }
  const runDockerSourceAutomation = async (task: () => Promise<unknown>): Promise<void> => {
    try {
      await task();
    } catch (error) {
      if (error instanceof AppError && error.code === 'LICENSE_ENTITLEMENT_REQUIRED') return;
      throw error;
    }
  };
  scheduler.registerInterval('docker-source-poll', 60_000, async () => {
    await runDockerSourceAutomation(() => dockerSourceService.pollDue());
  });
  scheduler.registerInterval('docker-source-webhooks', 15 * 60_000, async () => {
    await runDockerSourceAutomation(() => dockerSourceService.reconcileWebhooks());
  });
  scheduler.registerInterval('docker-internal-registry-health', 10_000, async () => {
    await dockerInternalRegistryService.probeHealth();
  });
  scheduler.registerInterval('docker-snapshot-containers', 10000, async () => {
    dockerSnapshotReconciler.enqueueConnected('containers');
  });
  scheduler.registerInterval('docker-snapshot-inventory', 60000, async () => {
    dockerSnapshotReconciler.enqueueConnected('images');
    dockerSnapshotReconciler.enqueueConnected('volumes');
    dockerSnapshotReconciler.enqueueConnected('networks');
  });
  scheduler.registerInterval('docker-snapshot-details', 5000, () => dockerSnapshotReconciler.enqueueDueDetails());
  scheduler.registerInterval('docker-snapshot-housekeeping', 60 * 60 * 1000, () =>
    dockerSnapshotService.purgeOrphans()
  );
  scheduler.registerInterval('additional-route-reconcile', 60 * 1000, async () => {
    await additionalRouteService.reconcile();
  });
  scheduler.register('expiry-alerts', env.EXPIRY_CHECK_CRON, async () => {
    await Promise.all([expiryAlertJob.run(), notifEvaluatorService.evaluateCertificateExpiry()]);
  });

  const updateCheckJob = new UpdateCheckJob(updateService, eventBus);
  scheduler.registerInterval('update-check', env.UPDATE_CHECK_INTERVAL_HOURS * 3_600_000, () => updateCheckJob.run());
  setTimeout(() => void updateCheckJob.run(), 0);
  scheduler.registerInterval('license-heartbeat', LICENSE_SCHEDULER_INTERVAL_MS, () => licenseService.heartbeat());
  scheduler.registerInterval('license-endpoints', LICENSE_ENDPOINTS_REFRESH_INTERVAL_MS, () =>
    licenseService.refreshServiceEndpoints()
  );

  const daemonUpdateCheckJob = new DaemonUpdateCheckJob(daemonUpdateService);
  scheduler.registerInterval('daemon-update-check', env.UPDATE_CHECK_INTERVAL_HOURS * 3_600_000, () =>
    daemonUpdateCheckJob.run()
  );
  // The interval restarts with every restart, including the one that finishes an Opfield update,
  // so check now: daemon releases for the new Opfield show up without waiting hours.
  setTimeout(() => void daemonUpdateCheckJob.run(), 0);

  const housekeepingJob = new HousekeepingJob(housekeepingService);
  const hkConfig = await housekeepingService.getConfig();
  scheduler.register('housekeeping', hkConfig.cronExpression, () => housekeepingJob.run());
  scheduler.registerInterval('clickhouse-health-guard', 5 * 60 * 1000, async () => {
    const config = await housekeepingService.getConfig();
    await loggingMaintenanceService.runGuard(
      config.enabled ? config.structuredLogs : undefined,
      config.enabled ? config.clickHouseInternals : undefined
    );
    await notifEvaluatorService.evaluateLoggingRatios();
  });

  // Stale node detection (every 60 seconds) + missed health report detection (every 30 seconds)
  // Docker tasks Opfield lost track of (it restarted, or a node's control stream dropped while they ran) are settled
  // with their nodes once these are connected; until then they stay active, so a daemon update waiting for a node's
  // tasks keeps waiting for them (F-1).
  const dockerTaskReconciler = new DockerTaskReconciler(
    () => dockerManagementService.taskReconcileContext(),
    (nodeId) => !!nodeRegistry.getNode(nodeId)
  );
  scheduler.registerInterval('docker-task-reconcile', 5_000, () => dockerTaskReconciler.sweep());
  // Apps shutdown / kill switch: items that could not be applied or restored are retried every 30 s and as soon as a
  // node reconnects; routes keep the overlays open incidents hold after a restart.
  const appIncidentRunner = container.resolve(AppIncidentRunner);
  scheduler.registerInterval('app-incident-retry', 30_000, () => appIncidentRunner.runOpen());
  eventBus.subscribe('node.changed', (payload) => {
    if ((payload as { status?: string } | undefined)?.status === 'online') void appIncidentRunner.runOpen();
  });
  void container
    .resolve(AppMaintenanceService)
    .repairStaleOverlays()
    .catch((error) => logger.warn('Repairing app maintenance overlays failed', { error }));
  eventBus.subscribe('node.changed', (payload) => {
    const event = payload as { id?: string; status?: string } | undefined;
    if (event?.status === 'online' && event.id) {
      void dockerTaskReconciler
        .sweep(event.id)
        .catch((error) => logger.warn('Settling Docker tasks after a node reconnect failed', { error }));
    }
  });
  scheduler.registerInterval('stale-node-check', 60000, () => nodeRegistry.markStaleNodesOffline());
  scheduler.registerInterval('node-health-record', 30000, () => nodeRegistry.recordHealthChecks());

  // Notification webhook retry job (every 30 seconds)
  const notifRetryJob = new NotificationRetryJob(notifDeliveryService, notifDispatcherService);
  scheduler.registerInterval('notification-retry', 30000, () => notifRetryJob.run());
  // Opfield's own outbound connectivity: the "Opfield lost outbound connectivity" alert, the route alerts it explains
  // fold under it, and paused webhooks resume as soon as it is back.
  const outboundMonitor = new OpfieldOutboundMonitor(db, notifEvaluatorService, notifDispatcherService);
  scheduler.registerInterval('opfield-outbound-check', OUTBOUND_CHECK_INTERVAL_MS, () => outboundMonitor.run());
  const siemDeliveryJob = new SiemDeliveryJob(siemDeliveryService, generalSettingsService);
  scheduler.registerInterval('siem-delivery', 30000, () => siemDeliveryJob.run());
  container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).registerJobs(scheduler);
  scheduler.registerInterval('github-integration-health', 60000, () => integrationsService.runDueGitHubHealthChecks());
  scheduler.registerInterval('ssh-integration-health', 60000, () => externalSshService.runDueHealthChecks());
  scheduler.registerInterval('cloudflare-integration-sync', 60000, () => integrationsService.runDueCloudflareSyncs());
  scheduler.registerInterval('hosting-inventory-sync', 60000, () =>
    container.resolve(HostingInventoryService).reconcileDue()
  );
  const hostingObservations = new HostingObservationsService(
    db,
    container.resolve(HostingConnectorsService),
    container.resolve(ResourceSnapshotStore),
    eventBus
  );
  scheduler.registerInterval('hosting-alert-observations', 30_000, () => hostingObservations.publish());
  scheduler.registerInterval('hosting-operations', 5000, async (signal) => {
    // An SSH installer session can run for minutes; shutdown ends it instead of waiting for it.
    await container.resolve(HostingProvisioningService).reconcileDue(signal);
    if (signal?.aborted) return;
    await container.resolve(HostingManagementService).reconcileDue();
    if (signal?.aborted) return;
    await container.resolve(HostingFinanceService).reconcileDue();
  });
  scheduler.registerInterval('hosting-firewalls', 5000, () => container.resolve(HostingFirewallService).reconcileDue());
  scheduler.registerInterval('hosting-vm-snapshots', 30_000, () =>
    container.resolve(HostingManagementService).snapshots.readModel.refreshDue()
  );

  setTimeout(() => {
    // The first heartbeat goes to the addresses the latest endpoints document names.
    licenseService
      .refreshServiceEndpoints()
      .then(() => licenseService.heartbeat())
      .catch((error) => {
        logger.warn('Initial license heartbeat failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, 1000);
  setTimeout(() => {
    housekeepingService
      .getConfig()
      .then((config) =>
        loggingMaintenanceService.runGuard(
          config.enabled ? config.structuredLogs : undefined,
          config.enabled ? config.clickHouseInternals : undefined
        )
      )
      .catch((error) => logger.warn('Initial ClickHouse health guard failed', { error }));
  }, 1000);

  // Read models warm asynchronously. Opfield readiness and request handlers
  // never wait for a node or external resource to answer this initial pass.
  readModelCoordinator.start();
}
