import { siemCommercialRuntime } from '@/modules/audit/siem-commercial-runtime.js';
import { dockerManagementCommercialRuntime } from '@/modules/docker/docker-management-commercial-runtime.js';
import { dockerRegistryCommercialRuntime } from '@/modules/docker/docker-registry-commercial-runtime.js';
import { loggingCommercialRuntime } from '@/modules/logging/logging-commercial-runtime.js';
import { pagesCommercialRuntime } from '@/modules/pages/pages-commercial-runtime.js';
import { pkiCommercialRuntime } from '@/modules/pki/pki-commercial-runtime.js';
import { statusPageCommercialRuntime } from '@/modules/status-page/status-page-commercial-runtime.js';
import 'reflect-metadata';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import { createDrizzleClient } from '@/db/client.js';
import { OperationLeaseStore } from '@/db/operation-lease.js';
import { hostingResources } from '@/db/schema/index.js';
import { COMMERCIAL_HOST_API_VERSION } from '@/edition/contract.js';
import { initializeCommercialEdition } from '@/edition/runtime.js';
import { RelayControlClient } from '@/grpc/relay-control.client.js';
import {
  currentGrpcServerCertificate,
  refreshGrpcServerCredentials,
  stageGrpcServerRelayTrust,
} from '@/grpc/server.js';
import { RelayTunnelHost } from '@/grpc/tunnel-worker/host.js';
import { createChildLogger, logger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { AccessListService } from '@/modules/access-lists/access-list.service.js';
import { AccessListFolderService } from '@/modules/access-lists/access-list-folders.service.js';
import { registerAccessSignIn } from '@/modules/access-signin/access-signin.registration.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import { AISandboxArtifactService } from '@/modules/ai/ai.sandbox-artifact.service.js';
import { AISandboxJobsService } from '@/modules/ai/ai.sandbox-jobs.service.js';
import { AISandboxRunnerService } from '@/modules/ai/ai.sandbox-runner.service.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { AISettingsService } from '@/modules/ai/ai.settings.service.js';
import { aiCommercialRuntime } from '@/modules/ai/ai-commercial-runtime.js';
import { AIConversationService } from '@/modules/ai/ai-conversation.service.js';
import { AIConversationFolderService } from '@/modules/ai/ai-conversation-folder.service.js';
import { AIConversationSearchService } from '@/modules/ai/ai-conversation-search.service.js';
import { AIPlanService } from '@/modules/ai/ai-plan.service.js';
import { AIProviderRuntimeService } from '@/modules/ai/ai-provider-runtime.service.js';
import { AIRunService } from '@/modules/ai/ai-run.service.js';
import { aiRunCommercialRuntime } from '@/modules/ai/ai-run-commercial-runtime.js';
import { AppActivityService } from '@/modules/apps/app-activity.service.js';
import { AppAuditTagger } from '@/modules/apps/app-audit-tagger.js';
import { AppEnvLayerService } from '@/modules/apps/app-env-layer.js';
import { AppFolderService } from '@/modules/apps/app-folders.service.js';
import { AppHealthService } from '@/modules/apps/app-health.service.js';
import { DefaultAppIncidentActions } from '@/modules/apps/app-incident-actions.js';
import { AppIncidentRunner } from '@/modules/apps/app-incident-runner.js';
import { AppIncidentTargetsReader } from '@/modules/apps/app-incident-targets.js';
import { AppIncidentsRepo } from '@/modules/apps/app-incidents.repo.js';
import { AppIncidentService } from '@/modules/apps/app-isolation.service.js';
import { AppListFolderService } from '@/modules/apps/app-list-folders.service.js';
import { AppMaintenanceService } from '@/modules/apps/app-maintenance.service.js';
import { AppMaintenanceAccessService } from '@/modules/apps/app-maintenance-access.js';
import { AppMemberFreeze } from '@/modules/apps/app-member-freeze.js';
import { AppMembersReader, AppMembersService } from '@/modules/apps/app-members.service.js';
import { AppMembershipService } from '@/modules/apps/app-membership.js';
import { AppNetworkIsolation } from '@/modules/apps/app-network-isolation.js';
import { AppNodesService } from '@/modules/apps/app-nodes.service.js';
import { AppOverviewService } from '@/modules/apps/app-overview.service.js';
import { AppPromotionService } from '@/modules/apps/app-promotion.service.js';
import { AppVariablesService } from '@/modules/apps/app-variables.service.js';
import { AppWorkloadSampler } from '@/modules/apps/app-workload-sampler.js';
import { AppsService } from '@/modules/apps/apps.service.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import { SiemDestinationService } from '@/modules/audit/siem-destination.service.js';
import { SiemAuditOutboxService } from '@/modules/audit/siem-outbox.service.js';
import { SiemTransportService } from '@/modules/audit/siem-transport.service.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { AuthEmailQueueService } from '@/modules/auth/auth-email-queue.service.js';
import { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { AvatarStorageService, resolveAvatarStorageDir } from '@/modules/auth/avatar-storage.service.js';
import { initializeHostCookieSince } from '@/modules/auth/legacy-session-cookie.js';
import { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { PasskeyService } from '@/modules/auth/passkey.service.js';
import { CloudLinkService } from '@/modules/cloud-link/cloud-link.service.js';
import { ConfigurationExportService } from '@/modules/configuration-transfer/configuration-export.service.js';
import { OpfieldMoveService } from '@/modules/configuration-transfer/opfield-move.service.js';
import { issueOwnerPasswordLink, keepRestoredOwnerLink } from '@/modules/configuration-transfer/owner-password-link.js';
import { completeConfigurationRestore } from '@/modules/configuration-transfer/restore-startup.js';
import { SetupRestoreService } from '@/modules/configuration-transfer/setup-restore.service.js';
import { databaseCommercialRuntime } from '@/modules/databases/database-commercial-runtime.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { managedDatabaseRuntime } from '@/modules/databases/managed-database-runtime.js';
import { ManagedDatabaseTunnelProxy } from '@/modules/databases/managed-database-tunnel-proxy.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { PostgresProbe } from '@/modules/diagnostics/postgres-probe.js';
import { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import { dockerAvailabilityCommercialRuntime } from '@/modules/docker/availability/docker-availability-commercial-runtime.js';
import { DockerWorkloadResolverService } from '@/modules/docker/availability/docker-workload-resolver.service.js';
import { AvailabilityLeaseService } from '@/modules/docker/availability/lease/availability-lease.service.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { DockerComposeNodeDispatcher } from '@/modules/docker/compose/compose-node-dispatcher.js';
import { ContainerLinksService } from '@/modules/docker/container-links/container-links.service.js';
import { containerLinksRuntime } from '@/modules/docker/container-links/container-links-runtime.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerAccessResourceService } from '@/modules/docker/docker-access-resource.service.js';
import { DockerBuildService } from '@/modules/docker/docker-build.service.js';
import { dockerBuildCommercialRuntime } from '@/modules/docker/docker-build-commercial-runtime.js';
import { DockerBuildQuery } from '@/modules/docker/docker-build-query.js';
import { DockerBuildRolloutService } from '@/modules/docker/docker-build-rollout.service.js';
import { DockerBuildRolloutGuard } from '@/modules/docker/docker-build-rollout-guard.js';
import { DockerBuildRunnerService } from '@/modules/docker/docker-build-runner.service.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { dockerDeploymentCommercialRuntime } from '@/modules/docker/docker-deployment-commercial-runtime.js';
import { DockerEnvironmentService } from '@/modules/docker/docker-environment.service.js';
import { DockerExternalChangeWatcher } from '@/modules/docker/docker-external-changes.service.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { DockerHealthCheckService } from '@/modules/docker/docker-health-check.service.js';
import { DockerImageCleanupService } from '@/modules/docker/docker-image-cleanup.service.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { dockerMigrationCommercialRuntime } from '@/modules/docker/docker-migration-commercial-runtime.js';
import { DockerMigrationCoordinator } from '@/modules/docker/docker-migration-coordinator.js';
import { DockerMigrationDispatchAdapter } from '@/modules/docker/docker-migration-dispatch.js';
import { DockerMigrationExecutor } from '@/modules/docker/docker-migration-executor.js';
import { DockerMigrationGuard } from '@/modules/docker/docker-migration-guard.js';
import { DockerMigrationPreflightService } from '@/modules/docker/docker-migration-preflight.js';
import { DockerNetworkAccessResourceService } from '@/modules/docker/docker-network-access-resource.service.js';
import { DockerRegistryService } from '@/modules/docker/docker-registry.service.js';
import {
  createDockerRegistryMaintenanceExecutor,
  DockerInternalRegistryService,
} from '@/modules/docker/docker-registry-internal.service.js';
import { createDockerRegistryMaintenanceStore } from '@/modules/docker/docker-registry-maintenance.js';
import { registryRetainedDigestKeys } from '@/modules/docker/docker-registry-retention.js';
import { DockerRegistryTokenService } from '@/modules/docker/docker-registry-token.service.js';
import { DockerRuntimeSettingsService } from '@/modules/docker/docker-runtime-settings.service.js';
import { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { dockerSourceCommercialRuntime } from '@/modules/docker/docker-source-commercial-runtime.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import { DockerWebhookService } from '@/modules/docker/docker-webhook.service.js';
import { DockerRegistryStorageService } from '@/modules/docker/registry-storage/registry-storage.service.js';
import { DomainsService } from '@/modules/domains/domain.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { GroupService } from '@/modules/groups/group.service.js';
import { PermissionGroupFolderService } from '@/modules/groups/permission-group-folders.service.js';
import { HostingConnectorsService } from '@/modules/hosting/hosting-connectors.service.js';
import { HostingFinanceService } from '@/modules/hosting/hosting-finance.service.js';
import { HostingFirewallService } from '@/modules/hosting/hosting-firewall.service.js';
import { HostingInventoryService } from '@/modules/hosting/hosting-inventory.service.js';
import { HostingManagementService } from '@/modules/hosting/hosting-management.service.js';
import { HostingOperationsService } from '@/modules/hosting/hosting-operations.service.js';
import { createHostingAdapter } from '@/modules/hosting/hosting-provider.js';
import { HostingProvisioningService } from '@/modules/hosting/hosting-provisioning.service.js';
import { InferenceAccountingService } from '@/modules/inference/accounting/inference-accounting.service.js';
import { InferenceBudgetLockService } from '@/modules/inference/accounting/inference-budget-lock.service.js';
import { InferenceBudgetPolicyService } from '@/modules/inference/accounting/inference-budget-policy.js';
import { InferenceBudgetReservationService } from '@/modules/inference/accounting/inference-budget-reservation.service.js';
import { InferenceCoreAccountingService } from '@/modules/inference/accounting/inference-core-accounting.service.js';
import { InferenceReservationReconciler } from '@/modules/inference/accounting/inference-reservation-reconciler.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { InferenceCoreBridgeService } from '@/modules/inference/core/inference-core-bridge.service.js';
import { InferenceCoreExecutor } from '@/modules/inference/core/inference-core-executor.service.js';
import { InferenceCoreOperationService } from '@/modules/inference/core/inference-core-operation.service.js';
import { InferenceCoreProxyService } from '@/modules/inference/core/inference-core-proxy.service.js';
import { InferenceCoreRuntimeService } from '@/modules/inference/core/inference-core-runtime.service.js';
import { InferenceCoreStore } from '@/modules/inference/core/inference-core-store.js';
import { InferenceCatalogEventsService } from '@/modules/inference/inference-catalog-events.service.js';
import { InferenceCredentialVault } from '@/modules/inference/inference-credential-vault.js';
import { InferenceRuntimeService } from '@/modules/inference/inference-runtime.service.js';
import { InferenceTokenService } from '@/modules/inference/inference-token.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import { InferenceModelAccessService } from '@/modules/inference/models/inference-model-access.service.js';
import { InferenceModelConfigurationService } from '@/modules/inference/models/inference-model-configuration.service.js';
import { workspaceConnectedToCloud } from '@/modules/inference/providers/inference-cloud.js';
import { InferenceDestinationPolicy } from '@/modules/inference/providers/inference-destination-policy.js';
import { InferenceOAuthService } from '@/modules/inference/providers/inference-oauth.service.js';
import { InferenceProviderRegistry } from '@/modules/inference/providers/inference-provider.registry.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { InferenceProviderCredentialService } from '@/modules/inference/providers/inference-provider-credential.service.js';
import { InferenceRoutingService } from '@/modules/inference/providers/inference-routing.service.js';
import { IngressGroupService } from '@/modules/ingress-groups/ingress-group.service.js';
import { IngressGroupConvergence } from '@/modules/ingress-groups/ingress-group-convergence.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { integrationCommercialRuntime } from '@/modules/integrations/integration-commercial-runtime.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicenseService } from '@/modules/license/license.service.js';
import { LicenseEntitlementReconcilerService } from '@/modules/license/license-entitlement-reconciler.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LicenseQuotaService } from '@/modules/license/license-quota.service.js';
import { LocalClickHouseService } from '@/modules/logging/local-clickhouse.service.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { LoggingEnvironmentFolderService } from '@/modules/logging/logging-environment-folders.service.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { LoggingIngestService } from '@/modules/logging/logging-ingest.service.js';
import { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import { LoggingMetadataService } from '@/modules/logging/logging-metadata.service.js';
import { LoggingRateLimitService } from '@/modules/logging/logging-rate-limit.service.js';
import { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import { LoggingSchemaService } from '@/modules/logging/logging-schema.service.js';
import { LoggingSchemaFolderService } from '@/modules/logging/logging-schema-folders.service.js';
import { LoggingSearchService } from '@/modules/logging/logging-search.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { LoggingTokenService } from '@/modules/logging/logging-token.service.js';
import { LoggingValidationService } from '@/modules/logging/logging-validation.service.js';
import { ManagedWorkloadLifecycle } from '@/modules/managed-workloads/managed-workload-lifecycle.js';
import { WitnessCatalog } from '@/modules/managed-workloads/witness-catalog.js';
import { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { DashboardReadModelService } from '@/modules/monitoring/dashboard-read-model.service.js';
import { MonitoringService } from '@/modules/monitoring/monitoring.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
import { NodeMonitoringService } from '@/modules/nodes/node-monitoring.service.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { NotificationAlertRuleService } from '@/modules/notifications/notification-alert-rule.service.js';
import { NotificationDeliveryService } from '@/modules/notifications/notification-delivery.service.js';
import { NotificationDispatcherService } from '@/modules/notifications/notification-dispatcher.service.js';
import {
  NotificationAlertRuleFolderService,
  NotificationWebhookFolderService,
} from '@/modules/notifications/notification-folders.service.js';
import { NotificationWebhookService } from '@/modules/notifications/notification-webhook.service.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { ObjectStorageFolderService } from '@/modules/object-storage/object-storage-folders.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { ObjectStorageUploadService } from '@/modules/object-storage/object-storage-upload.service.js';
import { storageCommercialRuntime } from '@/modules/object-storage/storage-commercial-runtime.js';
import { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import { PageArtifactStore, resolvePageStorageDir } from '@/modules/pages/artifacts/page-artifact-store.js';
import { PageBuildRolloutService } from '@/modules/pages/deployments/page-build-rollout.service.js';
import { PageDeploymentService } from '@/modules/pages/deployments/page-deployment.service.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PageMaintenanceService } from '@/modules/pages/retention/page-maintenance.service.js';
import { PageRetentionService } from '@/modules/pages/retention/page-retention.service.js';
import { PageRouteService } from '@/modules/pages/routes/page-route.service.js';
import { PageNodeRuntimeService } from '@/modules/pages/runtime/page-node-runtime.service.js';
import { PageRuntimeConfigService } from '@/modules/pages/runtime-config/page-runtime-config.service.js';
import { PagePublicationService } from '@/modules/pages/tags/page-publication.service.js';
import { PageTagService } from '@/modules/pages/tags/page-tag.service.js';
import { PageDeployTokenService } from '@/modules/pages/tokens/page-deploy-token.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { CertService } from '@/modules/pki/cert.service.js';
import { CRLService } from '@/modules/pki/crl.service.js';
import { ExportService } from '@/modules/pki/export.service.js';
import { OCSPService } from '@/modules/pki/ocsp.service.js';
import {
  CAFolderService,
  CertificateFolderService,
  PkiTemplateFolderService,
} from '@/modules/pki/pki-folders.service.js';
import { TemplatesService } from '@/modules/pki/templates.service.js';
import { AdditionalRouteService } from '@/modules/proxy/additional-route.service.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { NginxTemplateFolderService } from '@/modules/proxy/nginx-template-folders.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { ProxyDockerUpstreamService } from '@/modules/proxy/proxy-docker-upstream.service.js';
import { ProxyMaintenanceAccessService } from '@/modules/proxy/proxy-maintenance-access.service.js';
import { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import { RouteClientIpReconciler } from '@/modules/proxy/route-client-ip-runtime.js';
import { EnvironmentSettingsService } from '@/modules/settings/environment-settings.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { NetworkSettingsService } from '@/modules/settings/network-settings.service.js';
import { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import { SetupAccessService } from '@/modules/setup/setup-access.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { SetupWizardService } from '@/modules/setup/setup-wizard.service.js';
import { ACMEService } from '@/modules/ssl/acme.service.js';
import { resolveHttp01Ingress } from '@/modules/ssl/http01-ingress.js';
import { InternalCertificateRenewalService } from '@/modules/ssl/internal-cert-renewal.service.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import { ManagedStorageBindingsService } from '@/modules/storage/managed-storage-bindings.service.js';
import { managedStorageRuntime } from '@/modules/storage/managed-storage-runtime.js';
import { ManagedStorageTunnelProxy } from '@/modules/storage/managed-storage-tunnel-proxy.js';
import { StorageWorkloadDispatch } from '@/modules/storage/storage-workload-dispatch.js';
import { STORAGE_WORKLOAD_LABELS } from '@/modules/storage/storage-workload-labels.js';
import { StorageWorkloadProvider } from '@/modules/storage/storage-workload-provider.js';
import { StorageWorkloadStore } from '@/modules/storage/storage-workload-store.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { UIBootstrapService } from '@/modules/ui-bootstrap/ui-bootstrap.service.js';
import { AvailabilityAssignmentSigner } from '@/services/availability-assignment-signing.js';
import { AvailabilityMembersService } from '@/services/availability-members.service.js';
import { CacheService, createRedisClient } from '@/services/cache.service.js';
import { createKeeperPeerResolver } from '@/services/clickhouse-keeper-addressing.js';
import { CloudflareIpRangesService } from '@/services/cloudflare-ip-ranges.service.js';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { scheduleQueuedDaemonUpdateResume } from '@/services/daemon-node-update.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { loadLeaseUpdateView } from '@/services/daemon-update-lease-gate.js';
import { DaemonUpdateRollout } from '@/services/daemon-update-rollout.service.js';
import { DatabaseCAService } from '@/services/database-ca.service.js';
import { DockerService } from '@/services/docker.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { NginxConfigGenerator } from '@/services/nginx-config-generator.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeKeeperWitnessService } from '@/services/node-keeper-witness.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  hasUnexpiredEnrollmentTokens,
  OpfieldIdentityRenewalService,
} from '@/services/opfield-identity-renewal.service.js';
import { OpfieldLifecycleService } from '@/services/opfield-lifecycle.service.js';
import { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import { RelayCertificateRenewalService } from '@/services/relay-certificate-renewal.service.js';
import { RelayDockerRecoveryService } from '@/services/relay-docker-recovery.service.js';
import { RelayIdentityProvisionerService } from '@/services/relay-identity-provisioner.service.js';
import { applyNewerInstalledRelayArtifact, loadInstalledRelayArtifact } from '@/services/relay-installed-artifact.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayPolicySigningKeyService } from '@/services/relay-policy-signing-key.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { RelayRegistryService } from '@/services/relay-registry.service.js';
import { RelayRegistryIngressService } from '@/services/relay-registry-ingress.service.js';
import { RelayStartupFinalizerService } from '@/services/relay-startup-finalizer.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { RelayTopologyService } from '@/services/relay-topology.service.js';
import { RelayWitnessService } from '@/services/relay-witness.service.js';
import { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import { RuntimeRestartService } from '@/services/runtime-restart.service.js';
import { SessionService } from '@/services/session.service.js';
import { StorageCAService } from '@/services/storage-ca.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import { SystemCertificateRenewalService } from '@/services/system-certificate-renewal.service.js';
import { UpdateService, updateCommandFailure } from '@/services/update.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';

import { initializeBackgroundServices } from './bootstrap-background.js';

export { container };

export async function initializeContainer(): Promise<void> {
  const env = getEnv();

  logger.info('Initializing dependency injection container...');

  // Register environment config
  container.register(TOKENS.Env, { useValue: env });

  // Initialize and register database client
  logger.debug('Connecting to database...');
  const db = createDrizzleClient(env.DATABASE_URL);
  container.register(TOKENS.DrizzleClient, { useValue: db });
  const installedRelayArtifact = await loadInstalledRelayArtifact(db).catch((error) => {
    logger.warn('Failed to load persisted Relay artifact', { error });
    return null;
  });
  if (applyNewerInstalledRelayArtifact(env, installedRelayArtifact)) {
    logger.info('Restored newer managed Relay artifact from persisted update state', {
      buildVersion: installedRelayArtifact!.buildVersion,
    });
  }

  // Initialize and register Redis client
  logger.debug('Connecting to Redis...');
  const redis = createRedisClient(env.REDIS_URL);
  container.register(TOKENS.RedisClient, { useValue: redis });

  // Register services with explicit factories
  const cacheService = new CacheService(redis);
  container.registerInstance(CacheService, cacheService);
  // Its own Postgres connection for /health and diagnostics: a saturated pool must not read as an outage.
  container.registerInstance(PostgresProbe, new PostgresProbe(env.DATABASE_URL));

  const resourceSnapshotStore = new ResourceSnapshotStore(cacheService);
  container.registerInstance(ResourceSnapshotStore, resourceSnapshotStore);

  // Realtime event bus (in-process; swappable to Redis pub/sub later)
  const eventBus = new EventBusService();
  container.registerInstance(EventBusService, eventBus);
  const environmentSettingsService = new EnvironmentSettingsService(db, eventBus);
  await environmentSettingsService.initialize();
  container.registerInstance(EnvironmentSettingsService, environmentSettingsService);
  // Before requests are served: which sessions a legacy-named cookie may still carry.
  await initializeHostCookieSince(db);
  const readModelCoordinator = new ReadModelCoordinator(eventBus);
  container.registerInstance(ReadModelCoordinator, readModelCoordinator);
  const inferenceCatalogEvents = new InferenceCatalogEventsService(eventBus);
  container.registerInstance(InferenceCatalogEventsService, inferenceCatalogEvents);

  const sessionService = new SessionService(cacheService);
  container.registerInstance(SessionService, sessionService);
  container.registerInstance(RuntimeRestartService, new RuntimeRestartService());

  const cryptoService = new CryptoService(env.PKI_MASTER_KEY);
  container.registerInstance(CryptoService, cryptoService);

  const oidcSettingsService = new OidcSettingsService(db, cryptoService);
  container.registerInstance(OidcSettingsService, oidcSettingsService);

  const authSettingsService = new AuthSettingsService(db);
  container.registerInstance(AuthSettingsService, authSettingsService);
  const authEmailQueue = new AuthEmailQueueService(redis, cryptoService);
  const authMailService = new AuthMailService(db, cryptoService, authEmailQueue);
  authEmailQueue.start((delivery) =>
    authMailService.deliverSecurityEmail(delivery.recipient, delivery.input, delivery.dedupKey)
  );
  container.registerInstance(AuthEmailQueueService, authEmailQueue);
  container.registerInstance(AuthMailService, authMailService);

  const mcpSettingsService = new McpSettingsService(db);
  container.registerInstance(McpSettingsService, mcpSettingsService);

  const generalSettingsService = new GeneralSettingsService(db, inferenceCatalogEvents, eventBus);
  container.registerInstance(GeneralSettingsService, generalSettingsService);
  await generalSettingsService.importLegacyPublicUrl(process.env.APP_URL);
  container.registerInstance(OpfieldLifecycleService, new OpfieldLifecycleService());

  // SIEM reuses the existing installation identifier only as a non-secret
  // source label. It does not participate in licensing or tier checks.
  const licenseService = new LicenseService(db, cryptoService, env, fetch, generalSettingsService, eventBus);
  container.registerInstance(LicenseService, licenseService);
  container.registerInstance(
    CloudLinkService,
    new CloudLinkService(db, cryptoService, env, licenseService, cacheService)
  );
  const licensePolicyService = new LicensePolicyService(licenseService);
  container.registerInstance(LicensePolicyService, licensePolicyService);
  generalSettingsService.setLicensePolicyService(licensePolicyService);
  const licenseQuotaService = new LicenseQuotaService(db, licensePolicyService);
  const commercialEdition = await initializeCommercialEdition({
    operations: acceptedOperations,
    apiVersion: COMMERCIAL_HOST_API_VERSION,
    env,
    db,
    redis,
    container,
    tokens: TOKENS,
    license: licensePolicyService,
    errors: { AppError },
  });
  container.registerInstance(TOKENS.CommercialEdition, commercialEdition);
  container.registerInstance(LicenseQuotaService, licenseQuotaService);
  const siemOutboxService = commercialEdition.createSiem(
    'SiemAuditOutboxService',
    [licenseService, generalSettingsService],
    siemCommercialRuntime
  );
  siemOutboxService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(SiemAuditOutboxService, siemOutboxService);

  const webTransportSettingsService = new WebTransportSettingsService(db, env.WEB_TLS_BOOTSTRAP_MODE);
  await webTransportSettingsService.initialize();
  container.registerInstance(WebTransportSettingsService, webTransportSettingsService);

  const networkSettingsService = new NetworkSettingsService(db);
  container.registerInstance(NetworkSettingsService, networkSettingsService);

  const outboundWebhookPolicyService = new OutboundWebhookPolicyService(db);
  container.registerInstance(OutboundWebhookPolicyService, outboundWebhookPolicyService);

  const auditService = commercialEdition.createAuditService(AuditService, [db, siemOutboxService]);
  auditService.setEventBus(eventBus);
  container.registerInstance(AuditService, auditService);
  container.resolve(CloudLinkService).setAuditService(auditService);
  if (env.NODE_ENV === 'production') {
    // After a configuration restore: the address entered for this host applies before the listener
    // certificates are checked below, so they are issued for it.
    await completeConfigurationRestore(generalSettingsService, auditService, undefined, async (claimHash) => {
      const publicUrl = (await generalSettingsService.getPublicUrl()) ?? env.APP_URL;
      await keepRestoredOwnerLink(cacheService, claimHash, await issueOwnerPasswordLink(db, cacheService, publicUrl));
    }).catch((error) => logger.error('Could not complete the configuration restore', { error }));
  }

  const avatarStorageService = new AvatarStorageService(resolveAvatarStorageDir(env.NODE_ENV));
  await avatarStorageService.initialize();
  await avatarStorageService.migrateLegacyDataUrls(db);
  container.registerInstance(AvatarStorageService, avatarStorageService);

  const authService = new AuthService(
    db,
    sessionService,
    cacheService,
    authSettingsService,
    auditService,
    oidcSettingsService,
    generalSettingsService
  );
  authService.setLicenseQuotaService(licenseQuotaService);
  authService.setAvatarStorageService(avatarStorageService);
  container.registerInstance(AuthService, authService);
  container.registerInstance(
    LocalAuthService,
    new LocalAuthService(
      db,
      cacheService,
      sessionService,
      authSettingsService,
      container.resolve(AuthMailService),
      auditService,
      generalSettingsService
    )
  );
  const { DemoAuthService } = await import('@/modules/demo/demo-auth.service.js');
  container.registerInstance(
    DemoAuthService,
    new DemoAuthService(db, cacheService, container.resolve(AuthMailService))
  );
  container.registerInstance(MfaService, new MfaService(db, cacheService, cryptoService));
  container.registerInstance(
    PasskeyService,
    new PasskeyService(db, cacheService, authSettingsService, generalSettingsService)
  );
  const adminUserFolderService = new AdminUserFolderService(db, auditService);
  adminUserFolderService.setEventBus(eventBus);
  container.registerInstance(AdminUserFolderService, adminUserFolderService);

  const oauthService = new OAuthService(db, cacheService, auditService, authSettingsService, generalSettingsService);
  oauthService.setEventBus(eventBus);
  container.registerInstance(OAuthService, oauthService);

  const templatesService = commercialEdition.createPki('TemplatesService', [db], pkiCommercialRuntime);
  container.registerInstance(TemplatesService, templatesService);

  const caService = new CAService(db, cryptoService, auditService);
  container.registerInstance(CAService, caService);

  const certService = new CertService(db, cryptoService, caService, auditService);
  container.registerInstance(CertService, certService);

  const crlService = new CRLService(db, caService, cacheService);
  container.registerInstance(CRLService, crlService);
  const systemCertificateLifecycleService = new SystemCertificateLifecycleService(db, certService, crlService);
  container.registerInstance(SystemCertificateLifecycleService, systemCertificateLifecycleService);

  const ocspService = new OCSPService(db, cryptoService, caService, cacheService);
  container.registerInstance(OCSPService, ocspService);

  const exportService = commercialEdition.createPki('ExportService', [cryptoService], pkiCommercialRuntime);
  container.registerInstance(ExportService, exportService);

  const tokensService = new TokensService(db, auditService);
  tokensService.setEventBus(eventBus);
  container.registerInstance(TokensService, tokensService);

  const inferenceTokenService = new InferenceTokenService(db, auditService);
  inferenceTokenService.setEventBus(eventBus);
  container.registerInstance(InferenceTokenService, inferenceTokenService);
  const inferenceCredentialVault = new InferenceCredentialVault(cryptoService);
  container.registerInstance(InferenceCredentialVault, inferenceCredentialVault);
  const inferenceCoreStore = new InferenceCoreStore(db);
  container.registerInstance(InferenceCoreStore, inferenceCoreStore);
  const inferenceCoreBridgeService = new InferenceCoreBridgeService(inferenceCoreStore, inferenceCredentialVault);
  container.registerInstance(InferenceCoreBridgeService, inferenceCoreBridgeService);
  const inferenceProviderRegistry = new InferenceProviderRegistry();
  container.registerInstance(InferenceProviderRegistry, inferenceProviderRegistry);
  const inferenceDestinationPolicy = new InferenceDestinationPolicy();
  container.registerInstance(InferenceDestinationPolicy, inferenceDestinationPolicy);
  const inferenceOAuthService = new InferenceOAuthService(
    db,
    inferenceCredentialVault,
    inferenceProviderRegistry,
    fetch,
    inferenceCoreBridgeService
  );
  container.registerInstance(InferenceOAuthService, inferenceOAuthService);
  const inferenceProviderCredentialService = new InferenceProviderCredentialService(
    db,
    redis,
    inferenceCredentialVault,
    inferenceOAuthService
  );
  container.registerInstance(InferenceProviderCredentialService, inferenceProviderCredentialService);
  const inferenceProviderService = new InferenceProviderService(
    db,
    inferenceProviderRegistry,
    auditService,
    inferenceDestinationPolicy,
    inferenceCoreBridgeService,
    inferenceCatalogEvents
  );
  container.registerInstance(InferenceProviderService, inferenceProviderService);
  inferenceProviderService.start();
  const inferenceRoutingService = new InferenceRoutingService(db, redis);
  container.registerInstance(InferenceRoutingService, inferenceRoutingService);
  const inferenceBudgetPolicyService = new InferenceBudgetPolicyService(db);
  container.registerInstance(InferenceBudgetPolicyService, inferenceBudgetPolicyService);
  const inferenceModelAccessService = new InferenceModelAccessService(db, redis);
  container.registerInstance(InferenceModelAccessService, inferenceModelAccessService);
  const inferenceModelService = new InferenceModelService(
    db,
    inferenceProviderRegistry,
    inferenceModelAccessService,
    auditService,
    inferenceBudgetPolicyService,
    inferenceCatalogEvents,
    inferenceCoreBridgeService
  );
  container.registerInstance(InferenceModelService, inferenceModelService);
  const inferenceModelConfigurationService = new InferenceModelConfigurationService(
    db,
    inferenceProviderRegistry,
    inferenceModelService,
    inferenceModelAccessService,
    auditService,
    inferenceCatalogEvents
  );
  container.registerInstance(InferenceModelConfigurationService, inferenceModelConfigurationService);
  const inferenceRuntimeService = new InferenceRuntimeService();
  container.registerInstance(InferenceRuntimeService, inferenceRuntimeService);
  const inferenceBudgetReservationService = new InferenceBudgetReservationService(redis);
  container.registerInstance(InferenceBudgetReservationService, inferenceBudgetReservationService);
  const inferenceBudgetLockService = new InferenceBudgetLockService(db);
  container.registerInstance(InferenceBudgetLockService, inferenceBudgetLockService);
  const inferenceAccountingService = new InferenceAccountingService(
    inferenceBudgetPolicyService,
    inferenceBudgetReservationService,
    inferenceBudgetLockService,
    eventBus
  );
  container.registerInstance(InferenceAccountingService, inferenceAccountingService);
  const inferenceCoreAccountingService = new InferenceCoreAccountingService(
    db,
    inferenceBudgetPolicyService,
    inferenceBudgetReservationService,
    inferenceBudgetLockService,
    eventBus,
    redis
  );
  container.registerInstance(InferenceCoreAccountingService, inferenceCoreAccountingService);
  const inferenceCoreProxyService = new InferenceCoreProxyService(
    db,
    inferenceCoreBridgeService,
    inferenceModelService,
    inferenceRoutingService,
    inferenceCoreAccountingService,
    inferenceAccountingService
  );
  container.registerInstance(InferenceCoreProxyService, inferenceCoreProxyService);
  const inferenceCoreExecutor = new InferenceCoreExecutor(
    db,
    inferenceCoreProxyService,
    inferenceCoreAccountingService
  );
  container.registerInstance(InferenceCoreExecutor, inferenceCoreExecutor);
  inferenceRuntimeService.setExecutor(inferenceCoreExecutor);
  const inferenceUsageService = new InferenceUsageService(
    db,
    inferenceBudgetPolicyService,
    auditService,
    eventBus,
    inferenceModelAccessService
  );
  container.registerInstance(InferenceUsageService, inferenceUsageService);
  const inferenceReservationReconciler = new InferenceReservationReconciler(
    db,
    inferenceBudgetReservationService,
    inferenceBudgetLockService
  );
  container.registerInstance(InferenceReservationReconciler, inferenceReservationReconciler);
  inferenceReservationReconciler.start();

  const integrationsService = commercialEdition.createIntegrationsService(
    IntegrationsService,
    [db, auditService, cryptoService, [...commercialEdition.vcsProviders]],
    integrationCommercialRuntime
  );
  integrationsService.setEventBus(eventBus);
  integrationsService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(IntegrationsService, integrationsService);
  const externalSshService = new ExternalSshService(db, cryptoService);
  externalSshService.setEventBus(eventBus);
  container.registerInstance(ExternalSshService, externalSshService);

  const alertService = new AlertService(db);
  container.registerInstance(AlertService, alertService);

  // Upsert built-in groups (creates on fresh install, syncs scopes on upgrade)
  {
    const { syncPermissionGroupsAtStartup } = await import('@/lib/startup-scope-sync.js');
    await syncPermissionGroupsAtStartup(db, env.OPFIELD_DEPLOYMENT_MODE);
  }

  // Ensure system user exists before system CA (it's the owner of bootstrap resources)
  {
    const { users } = await import('@/db/schema/index.js');
    const { permissionGroups } = await import('@/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const SYSTEM_OIDC = 'system:opfield-setup';
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.oidcSubject, SYSTEM_OIDC)).limit(1);
    if (existing.length === 0) {
      const adminGroup = await db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.name, 'system-admin'),
      });
      if (adminGroup) {
        await db.insert(users).values({
          id: '00000000-0000-0000-0000-000000000000',
          oidcSubject: SYSTEM_OIDC,
          email: 'system@opfield.local',
          name: 'Opfield System',
          groupId: adminGroup.id,
        });
        logger.info('Created system user');
      }
    }
  }

  // System CA for node mTLS
  const systemCA = new SystemCAService(db, caService, certService, cryptoService);
  systemCA.setGeneralSettingsService(generalSettingsService);
  systemCA.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  container.registerInstance(SystemCAService, systemCA);
  await systemCA.ensureSystemCA();

  const databaseCA = new DatabaseCAService(db, caService, certService);
  databaseCA.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  container.registerInstance(DatabaseCAService, databaseCA);
  await databaseCA.ensureDatabaseCA();
  const storageCAService = new StorageCAService(db, caService, certService);
  storageCAService.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  container.registerInstance(StorageCAService, storageCAService);
  await storageCAService.ensureStorageCA();
  const systemCertificateReconciliation = await systemCertificateLifecycleService.reconcileExistingSystemLeaves();
  if (systemCertificateReconciliation.adopted || systemCertificateReconciliation.unknown) {
    logger.info('Reconciled existing system certificate lifecycle records', systemCertificateReconciliation);
  }
  await systemCertificateLifecycleService.retryPendingCRLs();
  // CRLs signed by older releases (negative serials, no CRL Number/AKI) are signed again in the background.
  void crlService.republishOutdatedCrls().catch((error) => logger.error('CRL republish on startup failed', { error }));

  const grpcIdentityService = new GrpcIdentityService(env, systemCA);
  container.registerInstance(GrpcIdentityService, grpcIdentityService);
  await grpcIdentityService.resolve();

  const relayIdentityProvisioner = new RelayIdentityProvisionerService(
    db,
    certService,
    systemCertificateLifecycleService,
    systemCA,
    grpcIdentityService,
    env.OPFIELD_RELAY_IDENTITY_DIR
  );
  container.registerInstance(RelayIdentityProvisionerService, relayIdentityProvisioner);
  let relayControlClient: RelayControlClient | undefined;
  let relayPolicyService: RelayPolicyService | undefined;
  let appRelayClientFingerprint: string | undefined;
  if (env.OPFIELD_RELAY_REQUIRED) {
    const identity = await relayIdentityProvisioner.ensure();
    appRelayClientFingerprint = identity.appClientFingerprint;
    relayControlClient = new RelayControlClient({
      target: env.OPFIELD_RELAY_TARGET,
      systemCaPath: `${env.OPFIELD_RELAY_IDENTITY_DIR}/system-ca.crt`,
      certificatePath: identity.appClientCertPath,
      privateKeyPath: identity.appClientKeyPath,
      previousCertificatePath: identity.previousAppClientCertPath,
      previousPrivateKeyPath: identity.previousAppClientKeyPath,
    });
    container.registerInstance(RelayControlClient, relayControlClient);
    relayPolicyService = new RelayPolicyService(db, cryptoService, generalSettingsService, relayControlClient);
    // Opfield's own tunnels (database tools, storage browser, copy jobs) move their bytes in a worker thread.
    const tunnelLogger = createChildLogger('RelayTunnelWorker');
    relayPolicyService.setOpfieldTunnels(
      RelayTunnelHost.inWorker(relayControlClient, {
        log: ({ level, message, meta }) => tunnelLogger[level](message, meta ?? {}),
      })
    );
    container.registerInstance(RelayPolicyService, relayPolicyService);
    await relayPolicyService.ensureInitialized();
  }

  const webIdentityService = new WebIdentityService(env, systemCA);
  container.registerInstance(WebIdentityService, webIdentityService);
  // Renews Opfield's own TLS identities while it runs and hot-reloads them; also the one
  // refresh path settings changes and first-run setup use.
  const opfieldIdentityRenewal = new OpfieldIdentityRenewalService({
    env,
    grpcIdentity: grpcIdentityService,
    grpcListener: {
      refreshCredentials: (certPath, keyPath) => refreshGrpcServerCredentials(certPath, keyPath, systemCA),
      servedCertificate: currentGrpcServerCertificate,
      stageRelayTrust: stageGrpcServerRelayTrust,
    },
    relayIdentity: env.OPFIELD_RELAY_REQUIRED ? relayIdentityProvisioner : undefined,
    relayControl: relayControlClient,
    startupRelayIdentity: env.OPFIELD_RELAY_REQUIRED ? await relayIdentityProvisioner.ensure() : undefined,
    onAppClientFingerprint: (fingerprint) => {
      // Before the tunnel proxies exist they are created with the active fingerprint below.
      if (container.isRegistered(ManagedDatabaseTunnelProxy)) {
        container.resolve(ManagedDatabaseTunnelProxy).setAppCertificateFingerprint(fingerprint);
      }
      if (container.isRegistered(ManagedStorageTunnelProxy)) {
        container.resolve(ManagedStorageTunnelProxy).setAppCertificateFingerprint(fingerprint);
      }
    },
    webIdentity: webIdentityService,
    hasPendingEnrollments: () => hasUnexpiredEnrollmentTokens(db),
    audit: auditService,
  });
  container.registerInstance(OpfieldIdentityRenewalService, opfieldIdentityRenewal);

  // Nginx config generator (pure config generation, no I/O)
  const configValidator = new ConfigValidatorService();
  container.registerInstance(ConfigValidatorService, configValidator);

  const nginxConfigGenerator = new NginxConfigGenerator(configValidator);
  container.registerInstance(NginxConfigGenerator, nginxConfigGenerator);

  const folderService = new FolderService(db, auditService);
  const appFolderService = new AppFolderService(db);
  container.registerInstance(AppFolderService, appFolderService);
  const appMembershipService = new AppMembershipService(db, appFolderService);
  container.registerInstance(AppMembershipService, appMembershipService);
  // Membership and name indexes are cached for 10 s; every app change drops them at once.
  eventBus.subscribe('apps', () => appMembershipService.invalidate());
  const appMembersReader = new AppMembersReader(db, appFolderService);
  container.registerInstance(AppMembersReader, appMembersReader);
  const appsService = new AppsService(db, auditService, appFolderService, appMembersReader);
  appsService.setEventBus(eventBus);
  appsService.setLogoStorage(avatarStorageService);
  container.registerInstance(AppsService, appsService);
  const appHealthService = new AppHealthService(db, appMembersReader);
  container.registerInstance(AppHealthService, appHealthService);
  appsService.setHealthProvider(appHealthService);
  container.registerInstance(AppActivityService, new AppActivityService(appsService, appMembersReader, auditService));
  const appAuditTagger = new AppAuditTagger(db, appFolderService, appMembershipService);
  auditService.setAppTagger(appAuditTagger);
  eventBus.subscribe('apps', () => appAuditTagger.invalidate());
  container.registerInstance(
    AppOverviewService,
    new AppOverviewService(db, appsService, appMembersReader, appHealthService)
  );
  const appNodesService = new AppNodesService(db, auditService, appsService, appMembersReader);
  container.registerInstance(AppNodesService, appNodesService);
  const appEnvLayerService = new AppEnvLayerService(db, cryptoService, appMembersReader);
  container.registerInstance(AppEnvLayerService, appEnvLayerService);
  container.registerInstance(
    AppVariablesService,
    new AppVariablesService(db, auditService, cryptoService, appsService, appEnvLayerService)
  );
  const appMembersService = new AppMembersService(db, auditService, appFolderService, appsService);
  appMembersService.setEventBus(eventBus);
  container.registerInstance(AppMembersService, appMembersService);
  container.registerInstance(FolderService, folderService);

  const nginxTemplateService = new NginxTemplateService(db, auditService, configValidator);
  container.registerInstance(NginxTemplateService, nginxTemplateService);

  // Node management (daemon communication)
  const nodeRegistry = new NodeRegistryService(db);
  container.registerInstance(NodeRegistryService, nodeRegistry);

  const nodeDispatch = new NodeDispatchService(nodeRegistry, db);
  container.registerInstance(NodeDispatchService, nodeDispatch);
  relayPolicyService?.setNodeDispatch(nodeDispatch);
  relayPolicyService?.setManagedLinkReports(nodeRegistry);
  relayPolicyService?.setEventBus(eventBus);
  relayPolicyService?.setAuditService(auditService);
  const relayPoolService = relayPolicyService
    ? new RelayPoolService(db, relayPolicyService, eventBus, auditService, generalSettingsService)
    : undefined;
  if (relayPoolService) container.registerInstance(RelayPoolService, relayPoolService);
  relayPoolService?.setTopology(new RelayTopologyService(db));
  // An Availability member's Secure Link starts on every lease relay, not on the local relay alone (D7).
  if (relayPoolService && relayPolicyService) {
    relayPolicyService.setInitialAssignmentPlanner((endpointId) => relayPoolService.planInitialAssignment(endpointId));
  }
  if (relayPoolService && relayPolicyService) {
    relayPoolService.setCertificateRenewal(
      new RelayCertificateRenewalService(
        db,
        systemCertificateLifecycleService,
        systemCA,
        nodeDispatch,
        relayPolicyService,
        auditService,
        eventBus
      )
    );
  }
  relayPoolService?.startReconciliation();

  const nginxCertificateDistribution = new NginxCertificateDistributionService(
    db,
    cryptoService,
    nginxConfigGenerator,
    nodeDispatch
  );
  nginxCertificateDistribution.setEventBus(eventBus);
  container.registerInstance(NginxCertificateDistributionService, nginxCertificateDistribution);

  const nodesService = new NodesService(db, auditService, nodeRegistry, grpcIdentityService, nodeDispatch);
  nodesService.setLicenseQuotaService(licenseQuotaService);
  nodesService.setGeneralSettingsService(generalSettingsService, env.GRPC_PORT);
  nodesService.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  container.registerInstance(NodesService, nodesService);
  const hostingConnectors = new HostingConnectorsService(
    db,
    cryptoService,
    auditService,
    eventBus,
    authService,
    createHostingAdapter
  );
  const hostingOperations = new HostingOperationsService(db, eventBus);
  const hostingInventory = new HostingInventoryService(
    db,
    hostingConnectors,
    nodesService,
    nodeDispatch,
    auditService,
    resourceSnapshotStore
  );
  hostingConnectors.setInventoryLifecycle(
    (id) => hostingInventory.initialize(id),
    async (id, resourceIds) => {
      const ids =
        resourceIds ??
        (
          await db
            .select({ id: hostingResources.id })
            .from(hostingResources)
            .where(eq(hostingResources.connectorId, id))
        ).map((resource) => resource.id);
      await Promise.all([
        resourceSnapshotStore.remove('hosting-resources', id),
        resourceSnapshotStore.remove('hosting-catalog', id),
        resourceSnapshotStore.remove('hosting-account-summary', id),
        ...ids.flatMap((resourceId) => [
          resourceSnapshotStore.remove('hosting-firewall', resourceId),
          resourceSnapshotStore.remove('hosting-vm-snapshots', resourceId),
        ]),
      ]);
    }
  );
  eventBus.subscribe('integration.connector.changed', (payload) => {
    const event = payload as { id?: string; provider?: string };
    if (event.provider === 'hosting' && event.id) void hostingInventory.refreshSnapshot(event.id).catch(() => {});
  });
  eventBus.subscribe('node.changed', (payload) => {
    const event = payload as { status?: string };
    if (event.status === 'online') void hostingInventory.reconcileAdoption().catch(() => {});
  });
  const hostingProvisioning = new HostingProvisioningService(
    db,
    hostingConnectors,
    hostingOperations,
    nodesService,
    cryptoService,
    authService,
    nodeDispatch,
    auditService,
    externalSshService,
    resourceSnapshotStore
  );
  const hostingManagement = new HostingManagementService(
    db,
    hostingConnectors,
    hostingOperations,
    authService,
    nodeDispatch,
    auditService,
    nodesService,
    resourceSnapshotStore,
    eventBus
  );
  const hostingFinance = new HostingFinanceService(db, hostingConnectors, hostingOperations, authService);
  eventBus.subscribe('hosting.operation.changed', (payload) => {
    const event = payload as { resourceId?: string; phase?: string };
    // Snapshot worker publishes persistent entity changes itself. Other VM operations
    // can change inventory too, but must never erase the last-known list.
    if (event.resourceId && !(payload as { action?: string }).action?.startsWith('snapshot_'))
      void hostingManagement.snapshots.readModel.refreshAfterOperation(event.resourceId).catch(() => {});
  });
  container.registerInstance(HostingConnectorsService, hostingConnectors);
  container.registerInstance(HostingOperationsService, hostingOperations);
  container.registerInstance(HostingInventoryService, hostingInventory);
  container.registerInstance(
    HostingFirewallService,
    new HostingFirewallService(db, hostingConnectors, resourceSnapshotStore, authService, auditService)
  );
  container.registerInstance(HostingProvisioningService, hostingProvisioning);
  container.registerInstance(HostingManagementService, hostingManagement);
  container.registerInstance(HostingFinanceService, hostingFinance);

  const nodeFolderService = new NodeFolderService(db, auditService);
  container.registerInstance(NodeFolderService, nodeFolderService);

  const nodeMonitoringService = new NodeMonitoringService(nodeRegistry, cacheService);
  container.registerInstance(NodeMonitoringService, nodeMonitoringService);

  const dockerManagementService = commercialEdition.createDockerManagementService(
    DockerManagementService,
    [db, auditService, nodeDispatch, nodeRegistry],
    dockerManagementCommercialRuntime
  );
  dockerManagementService.setLicensePolicyService(licensePolicyService);
  const dockerAccessResourceService = new DockerAccessResourceService(db);
  container.registerInstance(DockerAccessResourceService, dockerAccessResourceService);
  dockerManagementService.setAccessResourceService(dockerAccessResourceService);
  const dockerNetworkAccessResourceService = new DockerNetworkAccessResourceService(db);
  container.registerInstance(DockerNetworkAccessResourceService, dockerNetworkAccessResourceService);
  dockerManagementService.setNetworkAccessResourceService(dockerNetworkAccessResourceService);
  const dockerMigrationGuard = new DockerMigrationGuard(db);
  dockerManagementService.setMigrationGuard(dockerMigrationGuard);
  // Rename, update and migration-admission claims hold across backend processes.
  const operationLeases = new OperationLeaseStore(db);
  dockerManagementService.setOperationLeases(operationLeases);
  // A build rollout owns its target while its lease is live (see DockerBuildRolloutGuard).
  const dockerBuildRolloutGuard = new DockerBuildRolloutGuard(db);
  dockerManagementService.setBuildRolloutGuard(dockerBuildRolloutGuard);
  container.registerInstance(DockerManagementService, dockerManagementService);

  const dockerSnapshotService = new DockerSnapshotService(db, cacheService, nodeRegistry, eventBus);
  container.registerInstance(DockerSnapshotService, dockerSnapshotService);
  const dockerSnapshotReconciler = new DockerSnapshotReconciler(
    dockerSnapshotService,
    nodeDispatch,
    nodeRegistry,
    eventBus
  );
  container.registerInstance(DockerSnapshotReconciler, dockerSnapshotReconciler);
  dockerManagementService.setSnapshotReadBack((nodeId, kind, change) =>
    dockerSnapshotReconciler.readBackNow(nodeId, kind, change)
  );
  dockerManagementService.setRecreateReadBack((nodeId, name, newId, oldId) =>
    dockerSnapshotReconciler.readBackRecreatedContainer(nodeId, name, newId, oldId)
  );
  dockerSnapshotReconciler.start();
  // Managed containers removed, created or renamed outside Opfield: audit entry and container alert event.
  new DockerExternalChangeWatcher(db, nodeDispatch, nodeRegistry, eventBus, auditService).start();
  new AppWorkloadSampler(db, appMembersReader, appHealthService, cacheService, nodeDispatch).start();

  const dockerFolderService = new DockerFolderService(db, auditService);
  container.registerInstance(DockerFolderService, dockerFolderService);

  const dockerRegistryTokenService = new DockerRegistryTokenService();
  await dockerRegistryTokenService.initialize();
  container.registerInstance(DockerRegistryTokenService, dockerRegistryTokenService);
  const dockerInternalRegistryService = commercialEdition.createDockerRegistryService(
    DockerInternalRegistryService,
    [db, dockerRegistryTokenService, auditService],
    dockerRegistryCommercialRuntime
  );
  dockerInternalRegistryService.setEventBus(eventBus);
  dockerInternalRegistryService.setLicensePolicyService(licensePolicyService);
  await dockerInternalRegistryService.initialize();
  await dockerInternalRegistryService.probeHealth().catch((error) => {
    logger.warn('Initial internal registry health probe failed', { error });
  });
  container.registerInstance(DockerInternalRegistryService, dockerInternalRegistryService);
  let relayRegistryService: RelayRegistryService | undefined;
  if (relayPolicyService) {
    relayRegistryService = new RelayRegistryService(
      db,
      relayPolicyService,
      nodeDispatch,
      dockerInternalRegistryService
    );
    relayRegistryService.setEventBus(eventBus);
    relayRegistryService.start();
    container.registerInstance(RelayRegistryService, relayRegistryService);
  }

  const dockerRegistryService = new DockerRegistryService(db, auditService, cryptoService, nodeDispatch);
  dockerRegistryService.setInternalRegistryService(dockerInternalRegistryService);
  container.registerInstance(DockerRegistryService, dockerRegistryService);
  dockerManagementService.setRegistryService(dockerRegistryService);
  integrationsService.setDockerRegistryService(dockerRegistryService);

  const dockerSecretService = new DockerSecretService(db, auditService, cryptoService);
  dockerSecretService.setEventBus(eventBus);
  dockerSecretService.setMigrationGuard(dockerMigrationGuard);
  dockerSecretService.setBuildRolloutGuard(dockerBuildRolloutGuard);
  container.registerInstance(DockerSecretService, dockerSecretService);

  const dockerEnvironmentService = new DockerEnvironmentService(db, cryptoService);
  dockerEnvironmentService.setMigrationGuard(dockerMigrationGuard);
  container.registerInstance(DockerEnvironmentService, dockerEnvironmentService);

  const dockerRuntimeSettingsService = new DockerRuntimeSettingsService(db);
  container.registerInstance(DockerRuntimeSettingsService, dockerRuntimeSettingsService);

  const dockerTaskService = new DockerTaskService(db);
  container.registerInstance(DockerTaskService, dockerTaskService);
  const dockerComposeService = commercialEdition.createDockerDeployment(
    'DockerComposeService',
    [db, auditService, dockerTaskService, dockerSecretService, dockerSnapshotService],
    dockerDeploymentCommercialRuntime
  );
  dockerComposeService.setDispatcher(new DockerComposeNodeDispatcher(nodeDispatch));
  dockerComposeService.setEventBus(eventBus);
  dockerComposeService.setSnapshotReconciler(dockerSnapshotReconciler);
  dockerComposeService.setBuildRolloutGuard(dockerBuildRolloutGuard);
  container.registerInstance(DockerComposeService, dockerComposeService);
  const dockerDeploymentService = commercialEdition.createDockerDeployment(
    'DockerDeploymentService',
    [db, auditService, nodeDispatch, dockerRegistryService, dockerTaskService, nodeRegistry, dockerSecretService],
    dockerDeploymentCommercialRuntime
  );
  container.registerInstance(DockerDeploymentService, dockerDeploymentService);
  dockerDeploymentService.setLicensePolicyService(licensePolicyService);
  dockerDeploymentService.setMigrationGuard(dockerMigrationGuard);
  dockerDeploymentService.setBuildRolloutGuard(dockerBuildRolloutGuard);
  dockerDeploymentService.setAccessResourceService(dockerAccessResourceService);
  const dockerHealthCheckService = new DockerHealthCheckService(db, nodeDispatch);
  container.registerInstance(DockerHealthCheckService, dockerHealthCheckService);
  const dockerImageCleanupService = new DockerImageCleanupService(db, dockerManagementService);
  container.registerInstance(DockerImageCleanupService, dockerImageCleanupService);
  dockerManagementService.setImageCleanupService(dockerImageCleanupService);
  dockerDeploymentService.setImageCleanupService(dockerImageCleanupService);
  // A node keeps the images of the builds the internal registry keeps (each container's running and rollback build).
  const registryRetentionStore = createDockerRegistryMaintenanceStore(db);
  dockerImageCleanupService.setProtectedDigestsProvider(async () =>
    registryRetainedDigestKeys(await registryRetentionStore.listRetentionArtifacts(new Date()))
  );
  const dockerWebhookService = new DockerWebhookService(
    db,
    dockerManagementService,
    dockerTaskService,
    auditService,
    nodeDispatch,
    dockerRegistryService,
    dockerImageCleanupService,
    dockerDeploymentService,
    authService
  );
  container.registerInstance(DockerWebhookService, dockerWebhookService);
  const dockerBuildService = commercialEdition.createDockerBuild(
    'DockerBuildService',
    [db],
    dockerBuildCommercialRuntime
  );
  container.registerInstance(
    DockerBuildQuery,
    commercialEdition.createDockerBuild('DockerBuildQuery', [db], dockerBuildCommercialRuntime)
  );
  dockerBuildService.setEventBus(eventBus);
  dockerBuildService.setBuildReleaseHandler(async (buildId) => {
    // Runs in the background: the registry drops the builds beyond the running and the rollback one per container.
    dockerInternalRegistryService.buildFinished(buildId);
    // And every Docker node drops the source's build images beyond each container's image cleanup setting.
    dockerImageCleanupService.buildFinished(buildId);
    await relayRegistryService?.revokeContextBinding({ contextKind: 'build', contextId: buildId });
  });
  container.registerInstance(DockerBuildService, dockerBuildService);
  const dockerBuildRunnerService = relayRegistryService
    ? commercialEdition.createDockerBuild(
        'DockerBuildRunnerService',
        [db, dockerBuildService, nodeDispatch, integrationsService, relayRegistryService],
        dockerBuildCommercialRuntime
      )
    : null;
  if (dockerBuildRunnerService) container.registerInstance(DockerBuildRunnerService, dockerBuildRunnerService);
  dockerBuildService.setLicenseGuard(() => licensePolicyService.requireFeature('git-push-to-deploy'));
  // Builds queued before a registry collection began wait for it instead of failing against the restarting registry.
  dockerBuildService.setClaimGuard(() => dockerInternalRegistryService.canClaimBuilds());
  dockerBuildService.setAdmissionGuard(async () => {
    await dockerInternalRegistryService.assertBuildAdmission();
    if (!dockerBuildRunnerService) {
      throw new AppError(503, 'BUILD_RUNNER_UNAVAILABLE', 'Build scheduling is unavailable');
    }
    await dockerBuildRunnerService.assertBuildAdmission();
  });
  const dockerBuildRolloutService = relayRegistryService
    ? commercialEdition.createDockerBuild(
        'DockerBuildRolloutService',
        [db, dockerManagementService, dockerDeploymentService, relayRegistryService, dockerComposeService, authService],
        dockerBuildCommercialRuntime
      )
    : null;
  if (dockerBuildRolloutService) {
    container.registerInstance(DockerBuildRolloutService, dockerBuildRolloutService);
    dockerBuildService.setArtifactRollout((buildId, leaseOwner, operationId) =>
      dockerBuildRolloutService.rollout(buildId, leaseOwner, operationId)
    );
    // A Compose batch applied or recovered outside its builds' transitions: its source keeps two builds per service.
    dockerBuildRolloutService.setSourceAppliedHandler((sourceBindingId) => {
      dockerInternalRegistryService.sourceApplied(sourceBindingId);
      dockerImageCleanupService.sourceApplied(sourceBindingId);
    });
  }
  const dockerSourceService = commercialEdition.createDockerSourceService(
    DockerSourceService,
    [db, auditService, integrationsService, cryptoService],
    dockerSourceCommercialRuntime
  );
  dockerSourceService.setBuildService(dockerBuildService);
  dockerSourceService.setLicensePolicyService(licensePolicyService);
  // A container source rolls back to a build the registry keeps through the build rollout (its lock and guards).
  if (dockerBuildRolloutService) {
    dockerSourceService.setArtifactRollback({
      candidate: (sourceBindingId, buildId) => dockerBuildRolloutService.rollbackCandidate(sourceBindingId, buildId),
      rollback: (input) => dockerBuildRolloutService.rollbackContainer(input),
    });
  }
  dockerBuildRunnerService?.setSourceService(dockerSourceService);
  container.registerInstance(DockerSourceService, dockerSourceService);

  dockerManagementService.setTaskService(dockerTaskService);
  dockerManagementService.setEnvironmentService(dockerEnvironmentService);
  dockerManagementService.setRuntimeSettingsService(dockerRuntimeSettingsService);
  dockerManagementService.setSecretService(dockerSecretService);
  dockerManagementService.setFolderService(dockerFolderService);
  dockerManagementService.setEventBus(eventBus);
  dockerManagementService.setDeploymentService(dockerDeploymentService);
  dockerFolderService.setEventBus(eventBus);
  dockerTaskService.setEventBus(eventBus);
  // Tasks the nodes may still run stay active until they are settled with their node (DockerTaskReconciler).
  void dockerTaskService.detachActiveTasksOnStartup().catch((error) => {
    logger.warn('Failed to mark interrupted Docker tasks during bootstrap', { error });
  });
  void dockerComposeService
    .recoverInterruptedOperations()
    .then(() => dockerBuildRolloutService?.recoverInterruptedComposeRollouts())
    .catch((error) => {
      logger.warn('Failed to recover interrupted Compose operations during bootstrap', { error });
    });
  dockerDeploymentService.setEventBus(eventBus);
  dockerHealthCheckService.setEventBus(eventBus);
  dockerImageCleanupService.setEventBus(eventBus);
  dockerDeploymentService.setHealthCheckService(dockerHealthCheckService);
  dockerManagementService.setHealthCheckService(dockerHealthCheckService);
  dockerWebhookService.setEventBus(eventBus);
  authService.setEventBus(eventBus);
  templatesService.setEventBus(eventBus);
  caService.setEventBus(eventBus);
  certService.setEventBus(eventBus);
  nodesService.setEventBus(eventBus);
  nodeFolderService.setEventBus(eventBus);
  nodeRegistry.setEventBus(eventBus);
  folderService.setEventBus(eventBus);
  nginxTemplateService.setEventBus(eventBus);
  dockerRegistryService.setEventBus(eventBus);

  // Grants for Opfield's own tunnels name the client certificate the relay client presents. After
  // a restart that is the previous one until the local relay confirms the renewed identity.
  appRelayClientFingerprint = relayControlClient?.activeClientCertificateSha256() ?? appRelayClientFingerprint;
  const managedDatabaseTunnelProxy = commercialEdition.createManagedDatabase(
    'ManagedDatabaseTunnelProxy',
    [relayPolicyService, appRelayClientFingerprint],
    managedDatabaseRuntime
  );
  container.registerInstance(ManagedDatabaseTunnelProxy, managedDatabaseTunnelProxy);
  const managedStorageTunnelProxy = commercialEdition.createManagedStorage(
    'ManagedStorageTunnelProxy',
    [relayPolicyService, appRelayClientFingerprint],
    managedStorageRuntime
  );
  container.registerInstance(ManagedStorageTunnelProxy, managedStorageTunnelProxy);
  const databaseConnectionService = commercialEdition.createDatabaseService(
    DatabaseConnectionService,
    [db, auditService, cryptoService, managedDatabaseTunnelProxy],
    databaseCommercialRuntime
  );
  databaseConnectionService.setDatabaseCA(databaseCA);
  container.registerInstance(DatabaseConnectionService, databaseConnectionService);

  const managedDatabaseService = commercialEdition.createManagedDatabase(
    'ManagedDatabaseService',
    [db, auditService, cryptoService, nodeDispatch, databaseCA, databaseConnectionService],
    managedDatabaseRuntime
  );
  managedDatabaseService.setEventBus(eventBus);
  managedDatabaseService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(ManagedDatabaseService, managedDatabaseService);

  const managedDatabaseBindingService = commercialEdition.createManagedDatabase(
    'ManagedDatabaseBindingService',
    [
      db,
      auditService,
      cryptoService,
      nodeDispatch,
      dockerManagementService,
      dockerDeploymentService,
      dockerSecretService,
      relayPolicyService,
      dockerComposeService,
      managedDatabaseService,
    ],
    managedDatabaseRuntime
  );
  managedDatabaseBindingService.setEventBus(eventBus);
  managedDatabaseBindingService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(ManagedDatabaseBindingService, managedDatabaseBindingService);

  const databaseFolderService = new DatabaseFolderService(db, auditService);
  container.registerInstance(DatabaseFolderService, databaseFolderService);

  const databaseMonitoringService = commercialEdition.createDatabaseMonitoring(
    DatabaseMonitoringService,
    [databaseConnectionService, cacheService, managedDatabaseService],
    databaseCommercialRuntime
  );
  container.registerInstance(DatabaseMonitoringService, databaseMonitoringService);
  databaseConnectionService.setEventBus(eventBus);
  databaseFolderService.setEventBus(eventBus);

  const objectStorageService = commercialEdition.createObjectStorageService(
    ObjectStorageService,
    [db, auditService, cryptoService, storageCAService, managedStorageTunnelProxy],
    storageCommercialRuntime
  );
  container.registerInstance(ObjectStorageService, objectStorageService);
  container.registerInstance(
    ObjectStorageUploadService,
    commercialEdition.createStorageUploads(
      ObjectStorageUploadService,
      [
        objectStorageService,
        generalSettingsService,
        join(resolvePageStorageDir(env.PAGES_STORAGE_DIR, env.NODE_ENV), 'object-uploads'),
      ],
      storageCommercialRuntime
    )
  );

  const objectStorageFolderService = new ObjectStorageFolderService(db, auditService);
  container.registerInstance(ObjectStorageFolderService, objectStorageFolderService);

  const managedStorageMetricsProvider = commercialEdition.createManagedStorage(
    'ManagedStorageMetricsProvider',
    [db],
    managedStorageRuntime
  );
  const objectStorageMonitoringService = commercialEdition.createStorageMonitoring(
    ObjectStorageMonitoringService,
    [objectStorageService, cacheService, managedStorageMetricsProvider],
    storageCommercialRuntime
  );
  container.registerInstance(ObjectStorageMonitoringService, objectStorageMonitoringService);
  objectStorageService.setEventBus(eventBus);
  objectStorageFolderService.setEventBus(eventBus);

  const storageWorkloadProvider = commercialEdition.createManagedStorage(
    'StorageWorkloadProvider',
    [db, cryptoService, storageCAService],
    managedStorageRuntime
  );
  storageWorkloadProvider.setEventBus(eventBus);
  container.registerInstance(StorageWorkloadProvider, storageWorkloadProvider);

  const storageWorkloadStore = commercialEdition.createManagedStorage(
    'StorageWorkloadStore',
    [db],
    managedStorageRuntime
  );
  container.registerInstance(StorageWorkloadStore, storageWorkloadStore);

  // Shared across the dispatch and the service so both see the same
  // cluster-member rows within a request/reconcile cycle.
  const storageClusterMemberStore = commercialEdition.createManagedStorage(
    'StorageClusterMemberStore',
    [db],
    managedStorageRuntime
  );

  const storageWorkloadDispatch = commercialEdition.createManagedStorage(
    'StorageWorkloadDispatch',
    [
      nodeDispatch,
      auditService,
      cryptoService,
      storageWorkloadProvider,
      objectStorageService,
      db,
      storageClusterMemberStore,
      storageCAService,
      relayPolicyService,
    ],
    managedStorageRuntime
  );
  storageWorkloadDispatch.setEventBus(eventBus);
  container.registerInstance(StorageWorkloadDispatch, storageWorkloadDispatch);

  const storageWorkloadLifecycle = new ManagedWorkloadLifecycle(
    storageWorkloadStore,
    storageWorkloadDispatch,
    STORAGE_WORKLOAD_LABELS
  );

  const managedStorageService = commercialEdition.createManagedStorage(
    'ManagedStorageService',
    [
      db,
      auditService,
      cryptoService,
      nodeDispatch,
      storageWorkloadProvider,
      objectStorageService,
      storageWorkloadStore,
      storageWorkloadDispatch,
      storageWorkloadLifecycle,
      storageClusterMemberStore,
      managedStorageTunnelProxy,
      storageCAService,
      relayPolicyService,
    ],
    managedStorageRuntime
  );
  const managedStorageBindingsService = commercialEdition.createManagedStorage(
    'ManagedStorageBindingsService',
    [
      db,
      auditService,
      cryptoService,
      nodeDispatch,
      dockerManagementService,
      dockerDeploymentService,
      dockerSecretService,
      getEnv().SECURE_LINK_CONNECTOR_IMAGE,
      relayPolicyService,
      storageCAService,
      objectStorageService,
    ],
    managedStorageRuntime
  );
  managedStorageBindingsService.setEventBus(eventBus);
  managedStorageBindingsService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(ManagedStorageBindingsService, managedStorageBindingsService);
  // A removed container, or a free name a new container takes, releases the links saved for that name.
  let containerLinksService: ContainerLinksService | undefined;
  dockerManagementService.setManagedLinkReleaseHandler(async (nodeId, containerName, userId) => {
    await managedDatabaseBindingService.releaseContainerLinks(nodeId, containerName, userId);
    await managedStorageBindingsService.releaseContainerLinks(nodeId, containerName, userId);
    await containerLinksService?.releaseContainerLinks(nodeId, containerName, userId);
  });
  // Bindings own containers, networks and relay routes that the cluster's own
  // delete path knows nothing about; the FK cascade would drop only their rows.
  managedStorageService.setBindingsTeardown((cluster, userId) =>
    managedStorageBindingsService.deleteAllForCluster(cluster, userId)
  );
  managedStorageService.setEventBus(eventBus);
  managedStorageService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(ManagedStorageService, managedStorageService);
  // Renews managed storage and database TLS certificates while they run
  // (hot reload through the node daemon); scheduled in bootstrap-background.
  const systemCertificateRenewal = new SystemCertificateRenewalService(db, { audit: auditService, eventBus });
  managedStorageService.setCertificateRenewal(systemCertificateRenewal);
  managedDatabaseService.setCertificateRenewal(systemCertificateRenewal);
  container.registerInstance(SystemCertificateRenewalService, systemCertificateRenewal);

  const proxyDockerUpstreamService = new ProxyDockerUpstreamService(
    db,
    dockerSnapshotService,
    nodeRegistry,
    dockerAccessResourceService,
    dockerSnapshotReconciler
  );
  container.registerInstance(ProxyDockerUpstreamService, proxyDockerUpstreamService);
  const proxySecureLinkService = relayPolicyService
    ? new ProxySecureLinkService(
        db,
        nodeDispatch,
        relayPolicyService,
        getEnv().SECURE_LINK_CONNECTOR_IMAGE,
        proxyDockerUpstreamService
      )
    : undefined;
  proxySecureLinkService?.setEventBus(eventBus);
  if (proxySecureLinkService) managedDatabaseBindingService.setTargetRuntimeReconciler(proxySecureLinkService);
  if (proxySecureLinkService) container.registerInstance(ProxySecureLinkService, proxySecureLinkService);
  // Connector egress assignments carry the shared connector image for nodes without a proxy Secure Link binding.
  relayPolicyService?.setSecureLinkConnectorImage(getEnv().SECURE_LINK_CONNECTOR_IMAGE);
  containerLinksService = commercialEdition.createContainerLinks(
    [
      db,
      auditService,
      nodeDispatch,
      dockerManagementService,
      dockerDeploymentService,
      dockerSecretService,
      relayPolicyService,
      dockerComposeService,
      proxySecureLinkService,
    ],
    containerLinksRuntime
  );
  containerLinksService.setEventBus(eventBus);
  containerLinksService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(ContainerLinksService, containerLinksService);
  const proxyMaintenanceAccessService = new ProxyMaintenanceAccessService(
    db,
    cacheService,
    auditService,
    cryptoService
  );
  container.registerInstance(ProxyMaintenanceAccessService, proxyMaintenanceAccessService);
  const proxyService = new ProxyService(
    db,
    nginxTemplateService,
    auditService,
    nginxConfigGenerator,
    nodeDispatch,
    nginxCertificateDistribution,
    proxyDockerUpstreamService,
    proxySecureLinkService,
    cacheService,
    proxyMaintenanceAccessService,
    generalSettingsService,
    relayPoolService
  );
  proxyService.setEventBus(eventBus);
  proxyService.setWebTransportSettings(webTransportSettingsService);
  proxyMaintenanceAccessService.setRouteAccessCheck((hostId) => proxyService.maintenanceAccessOffered(hostId));
  container.registerInstance(ProxyService, proxyService);
  // Routes behind Cloudflare trust its current edge ranges: the stored list is in effect before any route renders, the
  // refresh job keeps it current (bootstrap-background), and routes follow a changed list or Cloudflare proxy flag.
  const cloudflareIpRanges = new CloudflareIpRangesService(db);
  await cloudflareIpRanges
    .load()
    .catch((error) => logger.warn('Stored Cloudflare IP ranges could not be read; using the built-in list', { error }));
  container.registerInstance(CloudflareIpRangesService, cloudflareIpRanges);
  const routeClientIp = new RouteClientIpReconciler(
    db,
    (hostId) => proxyService.reapplyHostConfig(hostId),
    (nodeId) => nodeDispatch.isNodeConnected(nodeId)
  );
  routeClientIp.start(eventBus);
  cloudflareIpRanges.onChanged(() => routeClientIp.reconcileCloudflareRanges());
  const appIncidentsRepo = new AppIncidentsRepo(db);
  container.registerInstance(AppIncidentsRepo, appIncidentsRepo);
  const appMaintenanceService = new AppMaintenanceService(db);
  appMaintenanceService.setIncidentsRepo(appIncidentsRepo);
  container.registerInstance(AppMaintenanceService, appMaintenanceService);
  container.registerInstance(AppMaintenanceAccessService, new AppMaintenanceAccessService(appsService));
  proxyService.setAppOverlayHook((routeIds) => appMaintenanceService.applyModes(routeIds));
  appsService.setMaintenanceHooks(appMaintenanceService);
  appMembersService.setRouteMoveHook((routeIds) => appMaintenanceService.applyModes(routeIds));
  // Apps shutdown and kill switch: incidents record every change with its prior state and restore it item by item;
  // members of an isolated environment are frozen in every mutation path.
  const appMemberFreeze = new AppMemberFreeze(db, appIncidentsRepo);
  container.registerInstance(AppMemberFreeze, appMemberFreeze);
  const appNetworkIsolation = new AppNetworkIsolation(db, nodeDispatch);
  container.registerInstance(AppNetworkIsolation, appNetworkIsolation);
  const appIncidentRunner = new AppIncidentRunner(
    appIncidentsRepo,
    new DefaultAppIncidentActions(db, appMaintenanceService, appNetworkIsolation),
    {
      changed: (incident) => {
        appMemberFreeze.invalidate();
        appsService.publish(incident.appId, 'incident_changed');
      },
      released: (incident) => appIncidentService.recordReleased(incident),
    },
    new OperationLeaseStore(db)
  );
  container.registerInstance(AppIncidentRunner, appIncidentRunner);
  const appIncidentService = new AppIncidentService(
    db,
    appsService,
    appIncidentsRepo,
    new AppIncidentTargetsReader(db, appMembersReader),
    appIncidentRunner,
    appMemberFreeze,
    auditService
  );
  container.registerInstance(AppIncidentService, appIncidentService);
  container.registerInstance(
    AppPromotionService,
    new AppPromotionService(db, appsService, appMembersReader, appMemberFreeze, auditService)
  );
  appsService.setIncidentGuard(appIncidentService);
  appMembersService.setIsolationCheck((environmentId) =>
    appIncidentService.environmentHasIncident(environmentId, 'isolation')
  );
  appNodesService.setFreezeCheck((environmentId) =>
    appMemberFreeze.assertNotFrozen({ kind: 'environment', id: environmentId })
  );
  proxyService.setAppFreezeGuard({
    assertRoute: (routeId) => appMemberFreeze.assertNotFrozen({ kind: 'route', id: routeId }),
    assertUpstream: (target) => appMemberFreeze.assertNotFrozen(target),
  });
  dockerManagementService.setAppFreezeGuard({
    anyIsolationOpen: () => appMemberFreeze.anyIsolationOpen(),
    assertContainer: (nodeId, name) => appMemberFreeze.assertNotFrozen({ kind: 'container', nodeId, name }),
    assertMayStart: (nodeId, name) => appMemberFreeze.assertMayStart(nodeId, name),
    assertNetworkNotHeld: (nodeId, network) => appMemberFreeze.assertNetworkNotHeld(nodeId, network),
  });
  const dockerWorkloadResolver = new DockerWorkloadResolverService(db);
  container.registerInstance(DockerWorkloadResolverService, dockerWorkloadResolver);
  dockerHealthCheckService.setWorkloadResolver(dockerWorkloadResolver);
  // Data-plane lease host: signs lease blocks with the relay policy key and hands relays and daemons their copy.
  const availabilityLeaseService = new AvailabilityLeaseService(
    db,
    nodeRegistry,
    auditService,
    eventBus,
    new RelayPolicySigningKeyService(db, cryptoService)
  );
  container.registerInstance(AvailabilityLeaseService, availabilityLeaseService);
  // Manual pairs' primary assignments are signed with the same relay policy key (decision 6).
  const availabilityAssignmentSigner = new AvailabilityAssignmentSigner(
    db,
    new RelayPolicySigningKeyService(db, cryptoService)
  );
  container.registerInstance(AvailabilityAssignmentSigner, availabilityAssignmentSigner);
  // Witness processes relays host for availability sets (decision 9): desired sets pushed, reports recorded.
  const relayWitnessService = new RelayWitnessService(db, nodeDispatch);
  relayWitnessService.setArtifactSource(new WitnessCatalog(env));
  relayWitnessService.setKeeperPeerResolver(createKeeperPeerResolver(db));
  container.registerInstance(RelayWitnessService, relayWitnessService);
  // Keeper witness containers on docker nodes (ClickHouse sets whose witness is a non-member docker node).
  const nodeKeeperWitnessService = new NodeKeeperWitnessService(db, nodeRegistry);
  container.registerInstance(NodeKeeperWitnessService, nodeKeeperWitnessService);
  // Members of database and storage availability sets: node configuration and health-stream reports.
  const availabilityMembers = new AvailabilityMembersService(db, nodeDispatch);
  availabilityMembers.setAssignmentSigner(container.resolve(AvailabilityAssignmentSigner));
  // Manual pairs' primaries keep serving only while they hear from Opfield (or their copy): asked every 5 s.
  availabilityMembers.startManualPairContact((nodeId) => nodeRegistry.requestHealthReport(nodeId, 4_000));
  container.registerInstance(AvailabilityMembersService, availabilityMembers);
  // Database and storage availability sets run on one shared orchestration; both get the same host parts.
  const availabilityHost = {
    lease: availabilityLeaseService,
    signer: availabilityAssignmentSigner,
    settings: { relayPolicyLeaseHours: async () => (await generalSettingsService.getConfig()).relayPolicyLeaseHours },
    members: availabilityMembers,
    // Keeper witnesses run on relays (supervisor) and on docker nodes (containers): both get the set's desired state.
    witnesses: {
      syncSet: async (setId: string) => {
        await relayWitnessService.syncSet(setId);
        await nodeKeeperWitnessService.syncSet(setId);
      },
    },
    principals: { reapply: (nodeId: string) => managedDatabaseBindingService.reconcileBindingPrincipals(nodeId) },
    ...(relayPolicyService ? { relay: relayPolicyService } : {}),
  };
  if (relayPolicyService) {
    relayPolicyService.setAvailabilityLeaseSource(availabilityLeaseService);
    availabilityLeaseService.setRelayPublisher(relayPolicyService);
  }
  managedDatabaseService.setAvailabilityHost(availabilityHost);
  managedStorageService.setAvailabilityHost(availabilityHost);
  const dockerAvailabilityService = commercialEdition.createDockerAvailabilityService(
    {
      db,
      nodes: nodeRegistry,
      license: licensePolicyService,
      audit: auditService,
      events: eventBus,
      dispatch: nodeDispatch,
      docker: dockerManagementService,
      environment: dockerEnvironmentService,
      secrets: dockerSecretService,
      registry: dockerInternalRegistryService,
      relay: relayRegistryService,
      bindings: managedDatabaseBindingService,
      proxy: proxyService,
      secureLinks: proxySecureLinkService,
      workloads: dockerWorkloadResolver,
      lease: availabilityLeaseService,
    },
    dockerAvailabilityCommercialRuntime
  );
  container.registerInstance(DockerAvailabilityService, dockerAvailabilityService);
  availabilityLeaseService.attachController(dockerAvailabilityService);
  // B2: Availability members carry their lease policy (and nginx gates them) only while the policy is in lease mode.
  eventBus.subscribe('docker.availability.changed', (payload) => {
    const event = payload as { policyId?: unknown; action?: unknown } | null;
    if (typeof event?.policyId !== 'string' || typeof event.action !== 'string' || !proxySecureLinkService) return;
    if (!['lease_lease', 'lease_closing', 'lease_legacy', 'lease_bootstrapping'].includes(event.action)) return;
    void proxySecureLinkService.syncAvailabilityPolicyMembers(event.policyId).catch((error) => {
      logger.warn('Availability member Secure Links will follow the lease mode on the next sync', {
        policyId: event.policyId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  dockerManagementService.setWorkloadResolver(dockerWorkloadResolver);
  dockerManagementService.setAvailabilityMutationGuard((nodeId, containerName) =>
    dockerAvailabilityService.assertContainerMutationAllowed(nodeId, containerName)
  );
  dockerManagementService.setAvailabilityMutationCoordinator({
    containerRemoved: (nodeId, containerName) => dockerAvailabilityService.containerRemoved(nodeId, containerName),
    getConfiguration: (nodeId, containerName) =>
      dockerAvailabilityService.getContainerConfiguration(nodeId, containerName),
    updateConfiguration: (nodeId, containerName, config, userId, options) =>
      dockerAvailabilityService.updateContainerConfiguration(nodeId, containerName, config, userId, options),
    updateEnvironment: (nodeId, containerName, env, removeEnv, userId) =>
      dockerAvailabilityService.updateContainerEnvironment(nodeId, containerName, env, removeEnv, userId),
    getEnvironment: (nodeId, containerName) => dockerAvailabilityService.getContainerEnvironment(nodeId, containerName),
    setRunning: (nodeId, containerName, running, userId, restart) =>
      dockerAvailabilityService.setContainerRunning(nodeId, containerName, running, userId, restart),
  });
  dockerDeploymentService.setAvailabilityCoordinator({
    isManaged: (deploymentId) => dockerAvailabilityService.isDeploymentManaged(deploymentId),
    deploy: (deploymentId, input, targetActiveSlot, userId, source, releaseId) =>
      dockerAvailabilityService.deployDeployment(deploymentId, input, targetActiveSlot, userId, source, releaseId),
    updateConfiguration: (deploymentId, snapshot, userId, reason) =>
      dockerAvailabilityService.updateDeploymentConfiguration(deploymentId, snapshot, userId, reason),
    setRunning: (deploymentId, running, userId, restart) =>
      dockerAvailabilityService.setDeploymentRunning(deploymentId, running, userId, restart),
    switchSlot: (deploymentId, targetActiveSlot, userId) =>
      dockerAvailabilityService.switchDeploymentSlot(deploymentId, targetActiveSlot, userId),
  });
  dockerComposeService.setAvailabilityCoordinator({
    isManaged: (projectId) => dockerAvailabilityService.isComposeManaged(projectId),
    removeManaged: (projectId, userId) => dockerAvailabilityService.removeComposeManaged(projectId, userId),
    applyRevision: (projectId, revisionId, userId) =>
      dockerAvailabilityService.applyComposeRevision(projectId, revisionId, userId),
    setRunning: (projectId, running, userId, restart) =>
      dockerAvailabilityService.setComposeRunning(projectId, running, userId, restart),
  });
  managedDatabaseBindingService.setAvailabilityCoordinator({
    resolvePolicyId: (target) => dockerAvailabilityService.resolveManagedDatabaseBindingPolicyId(target),
    queueDependencyRollout: async (policyId, userId) => {
      await dockerAvailabilityService.queueDependencyRollout(policyId, userId);
    },
    removeBinding: (policyId, userId) => dockerAvailabilityService.removeManagedDatabaseBinding(policyId, userId),
  });
  dockerManagementService.setContainerRecreateCompletedHandler(async (nodeId, newContainerId) => {
    await proxyService.reconcileDockerContainerRecreate(nodeId);
    await dockerSnapshotReconciler.finalizeContainerRecreate(nodeId, newContainerId);
    // A recreated workload keeps its persisted binding metadata, but the
    // daemon-owned listeners and Relay lanes still need to be proven against
    // the replacement container before the lifecycle task can report success.
    // Only the bindings of the recreated container are reconciled.
    // Without the commercial module there are no managed database bindings.
    await managedDatabaseBindingService.reconcileBindingPrincipals(nodeId, newContainerId).catch((error: unknown) => {
      if ((error as { code?: string } | null)?.code !== 'COMMERCIAL_MODULE_UNAVAILABLE') throw error;
    });
  });
  if (relayPolicyService && relayRegistryService) {
    const relayRegistryIngressService = commercialEdition.createRegistryIngress(
      RelayRegistryIngressService,
      [relayPolicyService, nodeDispatch, dockerInternalRegistryService, proxyService],
      dockerRegistryCommercialRuntime
    );
    relayRegistryIngressService.setEventBus(eventBus);
    dockerInternalRegistryService.setExternalAccessReconciler((next, previous, userId) =>
      relayRegistryIngressService.reconcile(next, previous, userId)
    );
    relayRegistryIngressService.start();
    container.registerInstance(RelayRegistryIngressService, relayRegistryIngressService);
  }
  const additionalRouteService = new AdditionalRouteService(
    db,
    auditService,
    proxyDockerUpstreamService,
    proxySecureLinkService
  );
  additionalRouteService.setEventBus(eventBus);
  proxyService.setAdditionalRoutes(additionalRouteService);
  container.registerInstance(AdditionalRouteService, additionalRouteService);
  nodesService.setProxyService(proxyService);

  const dockerMigrationDispatch = commercialEdition.createDockerMigration(
    'DockerMigrationDispatchAdapter',
    [nodeDispatch],
    dockerMigrationCommercialRuntime
  );
  container.registerInstance(DockerMigrationDispatchAdapter, dockerMigrationDispatch);
  const dockerMigrationPreflight = commercialEdition.createDockerMigration(
    'DockerMigrationPreflightService',
    [
      db,
      dockerManagementService,
      dockerDeploymentService,
      dockerMigrationDispatch,
      dockerEnvironmentService,
      dockerSecretService,
    ],
    dockerMigrationCommercialRuntime
  );
  container.registerInstance(DockerMigrationPreflightService, dockerMigrationPreflight);
  dockerMigrationPreflight.setLicensePolicyService(licensePolicyService);
  const dockerMigrationCoordinator = commercialEdition.createDockerMigration(
    'DockerMigrationCoordinator',
    [db, proxyService, dockerSnapshotReconciler, dockerAccessResourceService, relayRegistryService],
    dockerMigrationCommercialRuntime
  );
  container.registerInstance(DockerMigrationCoordinator, dockerMigrationCoordinator);
  const dockerMigrationExecutor = commercialEdition.createDockerMigration(
    'DockerMigrationExecutor',
    [
      db,
      dockerMigrationDispatch,
      dockerManagementService,
      dockerDeploymentService,
      dockerEnvironmentService,
      dockerSecretService,
      cryptoService,
    ],
    dockerMigrationCommercialRuntime
  );
  container.registerInstance(DockerMigrationExecutor, dockerMigrationExecutor);
  const dockerMigrationService = commercialEdition.createDockerMigration(
    'DockerMigrationService',
    [
      db,
      dockerMigrationPreflight,
      dockerMigrationExecutor,
      dockerMigrationCoordinator,
      auditService,
      eventBus,
      dockerManagementService,
      authService,
    ],
    dockerMigrationCommercialRuntime
  );
  container.registerInstance(DockerMigrationService, dockerMigrationService);

  const statusPageService = commercialEdition.createStatusPageService(
    [db, proxyService, auditService, generalSettingsService],
    statusPageCommercialRuntime
  );
  statusPageService.setEventBus(eventBus);
  statusPageService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(StatusPageService, statusPageService);
  registerAccessSignIn({
    db,
    cryptoService,
    cacheService,
    auditService,
    eventBus,
    proxyService,
    nodeRegistry,
    nodeDispatch,
    publicUrl: () => generalSettingsService.getPublicUrl(),
  });

  const acmeService = new ACMEService();
  const http01ChallengeNodes = new Map<string, string[]>();
  acmeService.onHttp01Preflight = async (domains: string[]) => {
    await Promise.all(
      [...new Set(domains.map((domain) => domain.trim().toLowerCase()))].map((domain) =>
        resolveHttp01Ingress(db, domain)
      )
    );
  };
  acmeService.onChallengeCreate = async (token: string, content: string, domain: string) => {
    // A domain on an ingress group gets the token on every online member: DNS may send the validation to any of them.
    const ingress = await resolveHttp01Ingress(db, domain);
    const published: string[] = [];
    try {
      for (const nodeId of ingress.nodeIds) {
        const deployed = await nodeDispatch.deployAcmeChallenge(nodeId, token, content);
        if (!deployed.success) {
          throw new AppError(
            502,
            'ACME_CHALLENGE_DEPLOY_FAILED',
            `Could not publish the HTTP-01 challenge for ${domain} on its Nginx node${ingress.nodeIds.length > 1 ? ` ${nodeId}` : ''}: ${deployed.error || 'the daemon rejected the challenge'}`
          );
        }
        published.push(nodeId);
      }
    } finally {
      http01ChallengeNodes.set(token, published);
    }
    if (ingress.offlineNodeIds.length > 0) {
      logger.warn('HTTP-01 challenge not published on offline ingress group members; validation may fail there', {
        domain,
        offlineNodeIds: ingress.offlineNodeIds,
      });
    }
  };
  acmeService.onChallengeRemove = async (token: string, domain: string) => {
    const nodeIds = http01ChallengeNodes.get(token) ?? (await resolveHttp01Ingress(db, domain)).nodeIds;
    try {
      const results = await Promise.allSettled(
        nodeIds.map((nodeId) => nodeDispatch.removeAcmeChallenge(nodeId, token))
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    } finally {
      http01ChallengeNodes.delete(token);
    }
  };
  container.registerInstance(ACMEService, acmeService);

  const accessListService = new AccessListService(
    db,
    nginxConfigGenerator,
    nginxTemplateService,
    auditService,
    nodeDispatch,
    nginxCertificateDistribution
  );
  accessListService.setEventBus(eventBus);
  accessListService.setHostRuntime(proxyService);
  container.registerInstance(AccessListService, accessListService);

  const sslService = new SSLService(db, acmeService, cryptoService, auditService, nginxCertificateDistribution);
  sslService.setEventBus(eventBus);
  // One ACME operation per certificate across backend processes.
  sslService.setOperationLeases(operationLeases);
  sslService.setIntegrationsService(integrationsService);
  sslService.setProxyService(proxyService);
  integrationsService.setSSLService(sslService);
  container.registerInstance(SSLService, sslService);
  const internalCertificateRenewal = new InternalCertificateRenewalService(
    db,
    certService,
    sslService,
    nginxCertificateDistribution,
    auditService,
    alertService
  );
  internalCertificateRenewal.setProxyService(proxyService);
  sslService.setInternalCertificateRenewal(internalCertificateRenewal);
  container.registerInstance(InternalCertificateRenewalService, internalCertificateRenewal);
  const sslCertificateFolderService = new SSLCertificateFolderService(db, auditService);
  sslCertificateFolderService.setEventBus(eventBus);
  container.registerInstance(SSLCertificateFolderService, sslCertificateFolderService);
  const caFolderService = new CAFolderService(db, auditService);
  caFolderService.setEventBus(eventBus);
  container.registerInstance(CAFolderService, caFolderService);
  const certificateFolderService = new CertificateFolderService(db, auditService);
  certificateFolderService.setEventBus(eventBus);
  container.registerInstance(CertificateFolderService, certificateFolderService);
  const pkiTemplateFolderService = new PkiTemplateFolderService(db, auditService);
  pkiTemplateFolderService.setEventBus(eventBus);
  container.registerInstance(PkiTemplateFolderService, pkiTemplateFolderService);
  const nginxTemplateFolderService = new NginxTemplateFolderService(db, auditService);
  nginxTemplateFolderService.setEventBus(eventBus);
  container.registerInstance(NginxTemplateFolderService, nginxTemplateFolderService);
  const notificationAlertRuleFolderService = new NotificationAlertRuleFolderService(db, auditService);
  notificationAlertRuleFolderService.setEventBus(eventBus);
  container.registerInstance(NotificationAlertRuleFolderService, notificationAlertRuleFolderService);
  const notificationWebhookFolderService = new NotificationWebhookFolderService(db, auditService);
  notificationWebhookFolderService.setEventBus(eventBus);
  container.registerInstance(NotificationWebhookFolderService, notificationWebhookFolderService);
  const accessListFolderService = new AccessListFolderService(db, auditService);
  accessListFolderService.setEventBus(eventBus);
  container.registerInstance(AccessListFolderService, accessListFolderService);
  const appListFolderService = new AppListFolderService(db, auditService);
  appListFolderService.setEventBus(eventBus);
  container.registerInstance(AppListFolderService, appListFolderService);

  // Monitoring services
  const monitoringService = new MonitoringService(db);
  container.registerInstance(MonitoringService, monitoringService);
  const dashboardReadModels = new DashboardReadModelService(
    resourceSnapshotStore,
    readModelCoordinator,
    monitoringService,
    proxyService,
    databaseConnectionService,
    sslService,
    certService,
    caService
  );
  container.registerInstance(DashboardReadModelService, dashboardReadModels);

  // AI Settings
  const aiSettingsService = new AISettingsService(db, cryptoService);
  aiSettingsService.setInferenceFeatureResolver(() => generalSettingsService.isFeatureEnabled('inferenceEnabled'));
  aiSettingsService.setOpfieldInferenceModelValidator(async (model) => {
    const models = await inferenceModelService.listAdmin();
    return models.some((candidate) => candidate.enabled && candidate.publicId === model);
  });
  inferenceModelService.setModelRemovedHandler((removedModel, replacementModel) =>
    aiSettingsService.handleOpfieldInferenceModelRemoved(removedModel, replacementModel)
  );
  generalSettingsService.setInferenceDisabledHandler(() => aiSettingsService.handleInferenceDisabled());
  aiSettingsService.setCloudConnectionResolver((config) => workspaceConnectedToCloud(db, config));
  container.registerInstance(AISettingsService, aiSettingsService);
  commercialEdition.initializeAI(aiCommercialRuntime);
  const aiSandboxArtifactService = new AISandboxArtifactService(env);
  await aiSandboxArtifactService.cleanInterruptedFiles().catch((error) => {
    logger.warn('Failed to clean interrupted AI artifact writes during bootstrap', { error });
  });
  container.registerInstance(AISandboxArtifactService, aiSandboxArtifactService);
  const aiProviderRuntimeService = new AIProviderRuntimeService(
    aiSettingsService,
    generalSettingsService,
    inferenceModelService,
    inferenceRuntimeService,
    inferenceBudgetPolicyService,
    aiSandboxArtifactService
  );
  container.registerInstance(AIProviderRuntimeService, aiProviderRuntimeService);
  const aiSandboxJobsService = commercialEdition.createAISandboxJobsService(
    AISandboxJobsService,
    [db],
    aiCommercialRuntime
  );
  container.registerInstance(AISandboxJobsService, aiSandboxJobsService);
  const aiSandboxRunnerService = new AISandboxRunnerService();
  container.registerInstance(AISandboxRunnerService, aiSandboxRunnerService);
  const aiSandboxService = commercialEdition.createAISandboxService(
    AISandboxService,
    [aiSandboxJobsService, aiSandboxRunnerService, aiSandboxArtifactService],
    aiCommercialRuntime
  );
  container.registerInstance(AISandboxService, aiSandboxService);
  const aiConversationSearchService = new AIConversationSearchService(db, auditService);
  container.registerInstance(AIConversationSearchService, aiConversationSearchService);
  const aiConversationService = new AIConversationService(
    db,
    {
      artifacts: aiSandboxArtifactService,
      sandbox: aiSandboxService,
    },
    aiConversationSearchService
  );
  container.registerInstance(AIConversationService, aiConversationService);
  const aiConversationFolderService = new AIConversationFolderService(db, aiConversationSearchService);
  container.registerInstance(AIConversationFolderService, aiConversationFolderService);
  const aiPlanService = commercialEdition.createAIPlanService(AIPlanService, [db], aiCommercialRuntime);
  container.registerInstance(AIPlanService, aiPlanService);
  const aiRunService = commercialEdition.createAIRunService(
    AIRunService,
    [db, eventBus, aiConversationSearchService, aiPlanService],
    aiRunCommercialRuntime
  );
  container.registerInstance(AIRunService, aiRunService);
  aiSandboxService.startPolicyReconciliation();
  authService.setSandboxService(aiSandboxService);

  // Domain management
  const domainsService = new DomainsService(db, auditService);
  domainsService.setEventBus(eventBus);
  domainsService.setIntegrationsService(integrationsService);
  domainsService.setNodeRegistryService(nodeRegistry);
  domainsService.setProxyService(proxyService);
  container.registerInstance(DomainsService, domainsService);
  domainsService.startIngressTargetReconciliation();
  domainsService.startCloudflareMigration();

  // Ingress groups: routes and domains served by several nginx nodes (normally one per site).
  const ingressGroupService = new IngressGroupService(db, auditService, {
    isNodeConnected: (nodeId) => nodeDispatch.isNodeConnected(nodeId),
  });
  ingressGroupService.setProxyService(proxyService);
  ingressGroupService.setDomainsService(domainsService);
  ingressGroupService.setEventBus(eventBus);
  ingressGroupService.setNodeRegistry(nodeRegistry);
  container.registerInstance(IngressGroupService, ingressGroupService);
  const ingressGroupConvergence = new IngressGroupConvergence(db, ingressGroupService, (nodeId) =>
    nodeDispatch.isNodeConnected(nodeId)
  );
  container.registerInstance(IngressGroupConvergence, ingressGroupConvergence);
  const domainFolderService = new DomainFolderService(db, auditService);
  domainFolderService.setEventBus(eventBus);
  container.registerInstance(DomainFolderService, domainFolderService);

  // Pages control plane
  const pageProjectService = commercialEdition.createPages(
    'PageProjectService',
    [db, auditService],
    pagesCommercialRuntime
  );
  pageProjectService.setEventBus(eventBus);
  container.registerInstance(PageProjectService, pageProjectService);
  const pageProjectFolderService = new PageProjectFolderService(db, auditService);
  pageProjectFolderService.setEventBus(eventBus);
  container.registerInstance(PageProjectFolderService, pageProjectFolderService);
  const pageArtifactStore = commercialEdition.createPages(
    'PageArtifactStore',
    [resolvePageStorageDir(env.PAGES_STORAGE_DIR, env.NODE_ENV)],
    pagesCommercialRuntime
  );
  await pageArtifactStore.initialize();
  container.registerInstance(PageArtifactStore, pageArtifactStore);
  const pageDeployTokenService = commercialEdition.createPages(
    'PageDeployTokenService',
    [db, auditService],
    pagesCommercialRuntime
  );
  pageDeployTokenService.setEventBus(eventBus);
  container.registerInstance(PageDeployTokenService, pageDeployTokenService);
  const pageDeploymentService = commercialEdition.createPages(
    'PageDeploymentService',
    [db, auditService, generalSettingsService, pageArtifactStore],
    pagesCommercialRuntime
  );
  pageDeploymentService.setEventBus(eventBus);
  container.registerInstance(PageDeploymentService, pageDeploymentService);
  const pageTagService = commercialEdition.createPages('PageTagService', [db, auditService], pagesCommercialRuntime);
  pageTagService.setEventBus(eventBus);
  container.registerInstance(PageTagService, pageTagService);
  const pageRuntimeConfigService = commercialEdition.createPages(
    'PageRuntimeConfigService',
    [db, auditService],
    pagesCommercialRuntime
  );
  pageRuntimeConfigService.setEventBus(eventBus);
  container.registerInstance(PageRuntimeConfigService, pageRuntimeConfigService);
  const pagePublicationService = commercialEdition.createPages(
    'PagePublicationService',
    [db, auditService, pageTagService],
    pagesCommercialRuntime
  );
  pagePublicationService.setEventBus(eventBus);
  container.registerInstance(PagePublicationService, pagePublicationService);
  const pageBuildRolloutService = commercialEdition.createPages(
    'PageBuildRolloutService',
    [db, dockerRegistryTokenService, pageDeploymentService, pagePublicationService],
    pagesCommercialRuntime
  );
  container.registerInstance(PageBuildRolloutService, pageBuildRolloutService);
  dockerBuildRolloutService?.setPagesRollout(pageBuildRolloutService);
  const pageRetentionService = commercialEdition.createPages(
    'PageRetentionService',
    [db, auditService, pageArtifactStore],
    pagesCommercialRuntime
  );
  pageRetentionService.setEventBus(eventBus);
  container.registerInstance(PageRetentionService, pageRetentionService);
  pageDeploymentService.setRetentionService(pageRetentionService);
  pageProjectService.setRetentionService(pageRetentionService);
  const pageMaintenanceService = commercialEdition.createPages(
    'PageMaintenanceService',
    [db, pageArtifactStore, pageRetentionService, eventBus],
    pagesCommercialRuntime
  );
  container.registerInstance(PageMaintenanceService, pageMaintenanceService);
  const pageProfileService = commercialEdition.createPages(
    'PageProfileService',
    [db, auditService, env.APP_URL],
    pagesCommercialRuntime
  );
  pageProfileService.setEventBus(eventBus);
  pageProfileService.setLicensePolicyService(licensePolicyService);
  pageProfileService.setGeneralSettings(generalSettingsService);
  container.registerInstance(PageProfileService, pageProfileService);
  const pageNodeRuntimeService = commercialEdition.createPages(
    'PageNodeRuntimeService',
    [db, pageArtifactStore, nodeDispatch, nginxCertificateDistribution],
    pagesCommercialRuntime
  );
  container.registerInstance(PageNodeRuntimeService, pageNodeRuntimeService);
  pageProjectService.setRuntimeAdapter(pageNodeRuntimeService);
  pageProjectService.setRouteRuntimeAdapter(proxyService);
  pageMaintenanceService.setMigrationReconciler(pageProjectService);
  const pageRouteService = commercialEdition.createPages(
    'PageRouteService',
    [db, pageNodeRuntimeService, auditService, pageRuntimeConfigService],
    pagesCommercialRuntime
  );
  container.registerInstance(PageRouteService, pageRouteService);
  pageRouteService.setAdditionalRoutePublicationAdapter(additionalRouteService);
  pageProfileService.setRuntimeAdapter(pageNodeRuntimeService);
  pagePublicationService.setDeploymentAdapter(pageNodeRuntimeService);
  pagePublicationService.setAdapter(pageRouteService);
  pageRuntimeConfigService.setPublicationAdapter(pageRouteService);
  pageRetentionService.setRuntimeAdapter(pageNodeRuntimeService);
  proxyService.setPageRoutes(pageRouteService);
  additionalRouteService.setPageRuntime(pageNodeRuntimeService, pageRuntimeConfigService);
  domainsService.setPageProfileService(pageProfileService);

  // Browser-based first-run setup.
  const setupTokenPolicyService = new SetupTokenPolicyService(db, env.SETUP_BOOTSTRAP);
  await setupTokenPolicyService.ensureSetupStarted();
  container.registerInstance(SetupTokenPolicyService, setupTokenPolicyService);
  const setupAccessService = new SetupAccessService(db, cacheService, setupTokenPolicyService);
  container.registerInstance(SetupAccessService, setupAccessService);
  const finalizeSetupService = new FinalizeSetupService(db);
  container.registerInstance(FinalizeSetupService, finalizeSetupService);

  container.registerInstance(
    SetupWizardService,
    new SetupWizardService(
      db,
      setupTokenPolicyService,
      setupAccessService,
      generalSettingsService,
      authSettingsService,
      oidcSettingsService,
      authMailService,
      authService,
      container.resolve(LocalAuthService),
      finalizeSetupService,
      mcpSettingsService,
      async () => {
        await opfieldIdentityRenewal.refreshGrpcIdentity();
      },
      async () => {
        const transport = await webTransportSettingsService.getConfig();
        if (transport.tlsEnabled) await webIdentityService.refresh();
      }
    )
  );

  // Docker service (kept for self-update and image pruning only)
  const dockerService = new DockerService('/var/run/docker.sock', '');
  const dockerRegistryStorageService = new DockerRegistryStorageService({
    db,
    docker: dockerService,
    tokenService: dockerRegistryTokenService,
    audit: auditService,
    eventBus,
    objectStorage: () => objectStorageService,
    composeProjectDir: env.COMPOSE_PROJECT_DIR,
    // Registered further down; until then (a maintenance run recovered at start) an update counts as running.
    updateInProgress: async () =>
      !container.isRegistered(UpdateService) || container.resolve(UpdateService).updateUnderWay(),
  });
  dockerInternalRegistryService.setExecutor(
    createDockerRegistryMaintenanceExecutor(dockerService, dockerRegistryTokenService, {
      registryDefinition: dockerRegistryStorageService.registryDefinition(),
    })
  );
  // A storage switch a restart interrupted is finished or rolled back first; it then owns the registry maintenance.
  if (!(await dockerRegistryStorageService.recoverAfterRestart())) {
    await dockerInternalRegistryService.recoverInterruptedMaintenance().catch((error) => {
      logger.error('Failed to recover interrupted internal registry maintenance', { error });
    });
  }
  container.registerInstance(DockerService, dockerService);
  container.registerInstance(DockerRegistryStorageService, dockerRegistryStorageService);
  container.registerInstance(SetupRestoreService, new SetupRestoreService(dockerService));
  container.resolve(ExternalSshService).setDockerService(dockerService);

  // Managed inference core lifecycle (OpenCodex container on this host).
  const inferenceCoreOperationService = new InferenceCoreOperationService(db);
  container.registerInstance(InferenceCoreOperationService, inferenceCoreOperationService);
  const inferenceCoreRuntimeService = new InferenceCoreRuntimeService(
    inferenceCoreStore,
    dockerService,
    env,
    container.resolve(InferenceCredentialVault),
    inferenceCoreOperationService,
    eventBus
  );
  container.registerInstance(InferenceCoreRuntimeService, inferenceCoreRuntimeService);
  // Reconcile with observed Docker state after a restart, then keep probing
  // health between steady states. Never blocks startup.
  void inferenceCoreRuntimeService.reconcileOnStartup().catch((error) => {
    console.error('[inference-core] startup reconciliation failed', error);
  });
  inferenceCoreRuntimeService.startHealthProbe();
  const relayDockerRecovery = new RelayDockerRecoveryService(dockerService, env);
  container.registerInstance(RelayDockerRecoveryService, relayDockerRecovery);
  const relayStartupFinalizer = new RelayStartupFinalizerService(relayControlClient ?? null, relayDockerRecovery, {
    required: env.OPFIELD_RELAY_REQUIRED,
    expectedVersion: env.OPFIELD_RELAY_BUILD_VERSION,
    expectedProtocolMajor: env.OPFIELD_RELAY_PROTOCOL_MAJOR,
    syncPolicy: relayPolicyService ? () => relayPolicyService!.syncSnapshot() : undefined,
  });
  container.registerInstance(RelayStartupFinalizerService, relayStartupFinalizer);
  const relaySupervisor = new RelaySupervisorService(
    db,
    cacheService,
    relayControlClient ?? null,
    env.OPFIELD_RELAY_REQUIRED ? relayDockerRecovery : null,
    generalSettingsService,
    eventBus,
    auditService,
    {
      required: env.OPFIELD_RELAY_REQUIRED,
      managed: env.OPFIELD_RELAY_MANAGED,
      expectedImage: env.OPFIELD_RELAY_IMAGE_REF ?? null,
      expectedService: env.OPFIELD_RELAY_SERVICE_NAME,
      expectedVersion: env.OPFIELD_RELAY_BUILD_VERSION,
      expectedProtocolMajor: env.OPFIELD_RELAY_PROTOCOL_MAJOR,
    }
  );
  relaySupervisor.setAvailabilityLeaseSink(availabilityLeaseService);
  container.registerInstance(RelaySupervisorService, relaySupervisor);
  // Node and remote relay control streams run through the local relay: its outages are not theirs.
  nodeRegistry.setLocalRelayOutage(relaySupervisor);
  nodeRegistry.setDisconnectAudit(async (nodeId, details) => {
    await auditService.log({
      userId: null,
      action: 'node.disconnected',
      resourceType: 'node',
      resourceId: nodeId,
      details,
    });
  });
  relayPoolService?.setLocalRelayOutage(relaySupervisor, nodeRegistry);
  // Opfield's own relayed streams avoid the local relay while it does not serve, and return to it once it is stable.
  relayPolicyService?.setLocalRelayOutage(relaySupervisor);
  // They take the nearest remote relay then: Opfield measures every one of the pool all the time, as daemons do.
  relayPolicyService?.measureOpfieldRelayPaths();

  // Update service
  const updateService = new UpdateService(
    db,
    dockerService,
    env,
    {
      setMaintenance: (enabled) => relaySupervisor.setMaintenance(enabled),
      setExpectedArtifact: (imageRef, buildVersion, protocolMajor) => {
        relayDockerRecovery.setExpectedImage(imageRef);
        relaySupervisor.setExpectedArtifact(imageRef, buildVersion, protocolMajor);
      },
      updateSecureLinkConnectorImage: (imageRef) => {
        relayPolicyService?.setSecureLinkConnectorImage(imageRef);
        return proxySecureLinkService?.updateConnectorImage(imageRef) ?? Promise.resolve();
      },
      probeNow: () => relaySupervisor.probeNow(),
    },
    generalSettingsService
  );
  updateService.setOrchestrationGate(commercialEdition, eventBus);
  container.registerInstance(UpdateService, updateService);
  container.registerInstance(
    LicenseModuleService,
    new LicenseModuleService(licenseService, commercialEdition, updateService, eventBus)
  );

  const loggingSettingsService = new LoggingSettingsService(db, cryptoService);
  container.registerInstance(LoggingSettingsService, loggingSettingsService);
  container.registerInstance(
    ConfigurationExportService,
    new ConfigurationExportService(
      dockerService,
      generalSettingsService,
      loggingSettingsService,
      licenseService,
      auditService
    )
  );
  const opfieldMoveService = new OpfieldMoveService(db, nodeRegistry, generalSettingsService);
  container.registerInstance(OpfieldMoveService, opfieldMoveService);
  await opfieldMoveService
    .initialize()
    .catch((error) => logger.error('Could not resume the announced Opfield address', { error }));
  const loggingClickHouseService = commercialEdition.createLogging(
    'LoggingClickHouseService',
    [],
    loggingCommercialRuntime
  );
  container.registerInstance(LoggingClickHouseService, loggingClickHouseService);
  const loggingFeatureService = new LoggingFeatureService(loggingClickHouseService);
  container.registerInstance(LoggingFeatureService, loggingFeatureService);

  const uiBootstrapService = new UIBootstrapService(
    resourceSnapshotStore,
    readModelCoordinator,
    nodesService,
    generalSettingsService,
    loggingFeatureService,
    integrationsService,
    statusPageService,
    updateService,
    aiProviderRuntimeService,
    aiSettingsService,
    finalizeSetupService,
    licensePolicyService,
    pageProfileService,
    commercialEdition
  );
  container.registerInstance(UIBootstrapService, uiBootstrapService);
  const localClickHouseService = commercialEdition.createLogging(
    'LocalClickHouseService',
    [dockerService],
    loggingCommercialRuntime
  );
  container.registerInstance(LocalClickHouseService, localClickHouseService);
  const loggingRuntimeService = commercialEdition.createLogging(
    'LoggingRuntimeService',
    [loggingSettingsService, localClickHouseService, loggingClickHouseService, loggingFeatureService],
    loggingCommercialRuntime
  );
  loggingRuntimeService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingRuntimeService, loggingRuntimeService);
  const licenseEntitlementReconciler = new LicenseEntitlementReconcilerService(licensePolicyService, eventBus);
  container.registerInstance(LicenseEntitlementReconcilerService, licenseEntitlementReconciler);
  const loggingMaintenanceService = commercialEdition.createLogging(
    'LoggingMaintenanceService',
    [loggingClickHouseService, loggingFeatureService],
    loggingCommercialRuntime
  );
  loggingMaintenanceService.setEventBus(eventBus);
  container.registerInstance(LoggingMaintenanceService, loggingMaintenanceService);
  try {
    await loggingRuntimeService.initialize();
  } catch (error) {
    loggingFeatureService.markUnavailable(error instanceof Error ? error.message : 'ClickHouse initialization failed');
    logger.warn('External logging ClickHouse initialization failed', { error });
  }
  const loggingEnvironmentService = commercialEdition.createLogging(
    'LoggingEnvironmentService',
    [db, auditService, loggingClickHouseService],
    loggingCommercialRuntime
  );
  loggingEnvironmentService.setEventBus(eventBus);
  loggingEnvironmentService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingEnvironmentService, loggingEnvironmentService);
  const loggingEnvironmentFolderService = new LoggingEnvironmentFolderService(db, auditService);
  loggingEnvironmentFolderService.setEventBus(eventBus);
  container.registerInstance(LoggingEnvironmentFolderService, loggingEnvironmentFolderService);
  const loggingTokenService = commercialEdition.createLogging(
    'LoggingTokenService',
    [db, auditService],
    loggingCommercialRuntime
  );
  loggingTokenService.setEventBus(eventBus);
  loggingTokenService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingTokenService, loggingTokenService);
  const loggingSchemaService = commercialEdition.createLogging(
    'LoggingSchemaService',
    [db, auditService],
    loggingCommercialRuntime
  );
  loggingSchemaService.setEventBus(eventBus);
  loggingSchemaService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(LoggingSchemaService, loggingSchemaService);
  const loggingSchemaFolderService = new LoggingSchemaFolderService(db, auditService);
  loggingSchemaFolderService.setEventBus(eventBus);
  container.registerInstance(LoggingSchemaFolderService, loggingSchemaFolderService);
  const loggingValidationService = commercialEdition.createLogging(
    'LoggingValidationService',
    [],
    loggingCommercialRuntime
  );
  container.registerInstance(LoggingValidationService, loggingValidationService);
  const loggingRateLimitService = commercialEdition.createLogging(
    'LoggingRateLimitService',
    [redis],
    loggingCommercialRuntime
  );
  container.registerInstance(LoggingRateLimitService, loggingRateLimitService);
  const loggingMetadataService = commercialEdition.createLogging(
    'LoggingMetadataService',
    [db],
    loggingCommercialRuntime
  );
  container.registerInstance(LoggingMetadataService, loggingMetadataService);
  const loggingIngestService = commercialEdition.createLogging(
    'LoggingIngestService',
    [loggingValidationService, loggingClickHouseService, loggingMetadataService],
    loggingCommercialRuntime
  );
  loggingIngestService.setEventBus(eventBus);
  container.registerInstance(LoggingIngestService, loggingIngestService);
  const loggingSearchService = commercialEdition.createLogging(
    'LoggingSearchService',
    [loggingEnvironmentService, loggingClickHouseService],
    loggingCommercialRuntime
  );
  container.registerInstance(LoggingSearchService, loggingSearchService);

  const daemonUpdateService = new DaemonUpdateService(db, env, generalSettingsService);
  daemonUpdateService.setEventBus(eventBus);
  daemonUpdateService.setNodeRegistry(nodeRegistry);
  container.registerInstance(DaemonUpdateService, daemonUpdateService);
  // Restarts of lease voters and candidates (daemon and relay updates) go one policy member at a time.
  const daemonUpdateRollout = new DaemonUpdateRollout({ loadView: () => loadLeaseUpdateView(db, nodeRegistry) });
  container.registerInstance(DaemonUpdateRollout, daemonUpdateRollout);
  const processStartedAt = new Date();
  // Updates sent before a restart lost their expiry timers and can no longer get a command result.
  void daemonUpdateService.resumeNodeUpdateDeadlines(processStartedAt).catch((error) =>
    logger.error('Daemon update deadlines could not be resumed after the restart', {
      error: error instanceof Error ? error.message : String(error),
    })
  );
  scheduleQueuedDaemonUpdateResume(
    {
      db,
      daemonUpdateService,
      dispatch: nodeDispatch,
      rollout: daemonUpdateRollout,
    },
    undefined,
    processStartedAt
  );
  nodeDispatch.setDaemonUpdateService(daemonUpdateService);
  nodesService.setDaemonUpdateService(daemonUpdateService);
  if (relayPoolService) {
    updateService.setRelayPoolUpdateRuntime({
      drainInstance: (instanceId, userId, enabled) =>
        relayPoolService.drainInstance(instanceId, userId, enabled, { manual: false }),
      forceDisconnectInstance: (instanceId, userId) =>
        relayPoolService.forceDisconnectInstance(instanceId, userId, { update: true }),
      localRelayTakeoverBlocker: (instanceId) => relayPoolService.localRelayTakeoverBlocker(instanceId),
      settlePlacement: (signal) => relayPoolService.settleForUpdate(signal),
      isRelayConnected: (nodeId) => relayPolicyService?.isRemoteInstanceConnected(nodeId) ?? true,
      relayStreamReports: () => relayPolicyService?.relayStreamReports() ?? [],
      prepareWorkerUpdate: (version, arch) =>
        daemonUpdateService.prepareTrustedDaemonUpdate('relay-worker', `${version}-relay`, version, arch),
      dispatchWorkerUpdate: async (nodeId, artifact) => {
        const result = await nodeDispatch.sendRelayWorkerUpdate(
          nodeId,
          artifact.downloadUrl,
          artifact.payload.version,
          artifact.checksum,
          artifact.signedManifest
        );
        if (!result.success) throw new Error(result.error || result.detail || 'Relay worker update failed');
      },
      awaitLeasePeers: async (relayInstanceId, signal) => {
        if (!(await daemonUpdateRollout.isLeaseMember(relayInstanceId))) return;
        await daemonUpdateRollout.enqueue({ memberId: relayInstanceId, run: async () => {}, signal });
      },
      awaitLeaseSettled: async (relayInstanceId, since, signal) => {
        await daemonUpdateRollout.awaitSettled(relayInstanceId, since, signal);
      },
      prepareSupervisorUpdate: (version, arch) =>
        daemonUpdateService.prepareTrustedDaemonUpdate('relay', `${version}-relay`, version, arch),
      dispatchSupervisorUpdate: async (nodeId, artifact) => {
        const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, artifact.payload.version);
        try {
          const command = await nodeDispatch.sendUpdateDaemonCommand(
            nodeId,
            artifact.downloadUrl,
            artifact.payload.version,
            artifact.checksum,
            artifact.signedManifest
          );
          daemonUpdateService.trackNodeUpdateCompletion(nodeId, operationId, command.result);
          await command.accepted;
          // A refusal (a protected relay accepts no older release) fails the pool step at once.
          return { failed: updateCommandFailure(command.result) };
        } catch (error) {
          await daemonUpdateService.clearNodeUpdateInProgress(nodeId, operationId);
          throw error;
        }
      },
    });
  }
  // Report a rolled-back Opfield update and fail Relay Pool runs this restart interrupted.
  updateService.setAuditLog(auditService);
  await updateService.recoverInterruptedUpdates();

  // Housekeeping service
  const housekeepingService = new HousekeepingService(db, dockerService, nodeDispatch, env);
  housekeepingService.setSandboxArtifactService(aiSandboxArtifactService);
  housekeepingService.setDockerManagementService(dockerManagementService);
  housekeepingService.setImageCleanupService(dockerImageCleanupService);
  housekeepingService.setLoggingMaintenanceService(loggingMaintenanceService, loggingFeatureService);
  housekeepingService.setSystemCertificateLifecycleService(systemCertificateLifecycleService);
  housekeepingService.setPagesMaintenanceService(pageMaintenanceService);
  housekeepingService.setInternalRegistryMaintenanceService(dockerInternalRegistryService);
  housekeepingService.setDockerTaskService(dockerTaskService);
  housekeepingService.setTokenCleanupServices(auditService, eventBus);
  container.registerInstance(HousekeepingService, housekeepingService);

  // Group service (injectable — resolve from container)
  const groupService = container.resolve(GroupService);
  groupService.setEventBus(eventBus);
  groupService.setSandboxService(aiSandboxService);
  groupService.setLicenseQuotaService(licenseQuotaService);
  container.registerInstance(GroupService, groupService);
  const permissionGroupFolderService = new PermissionGroupFolderService(db, auditService);
  permissionGroupFolderService.setEventBus(eventBus);
  container.registerInstance(PermissionGroupFolderService, permissionGroupFolderService);

  // ── Notification services (before AI — AI uses them) ──────────────
  const notifRuleService = new NotificationAlertRuleService(db, auditService);
  notifRuleService.setEventBus(eventBus);
  container.registerInstance(NotificationAlertRuleService, notifRuleService);

  const notifWebhookService = new NotificationWebhookService(db, auditService, cryptoService);
  notifWebhookService.setEventBus(eventBus);
  container.registerInstance(NotificationWebhookService, notifWebhookService);

  const notifDeliveryService = new NotificationDeliveryService(db);
  container.registerInstance(NotificationDeliveryService, notifDeliveryService);

  const notifDispatcherService = new NotificationDispatcherService(
    db,
    notifWebhookService,
    env,
    outboundWebhookPolicyService,
    generalSettingsService
  );
  container.registerInstance(NotificationDispatcherService, notifDispatcherService);

  const siemTransportService = commercialEdition.createSiem(
    'SiemTransportService',
    [env, cryptoService, outboundWebhookPolicyService, generalSettingsService],
    siemCommercialRuntime
  );
  container.registerInstance(SiemTransportService, siemTransportService);
  const siemDeliveryService = commercialEdition.createSiem(
    'SiemDeliveryService',
    [db, siemTransportService, generalSettingsService],
    siemCommercialRuntime
  );
  siemDeliveryService.setEventBus(eventBus);
  siemDeliveryService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(SiemDeliveryService, siemDeliveryService);
  const siemDestinationService = commercialEdition.createSiem(
    'SiemDestinationService',
    [db, auditService, cryptoService, siemTransportService],
    siemCommercialRuntime
  );
  siemDestinationService.setEventBus(eventBus);
  siemDestinationService.setLicensePolicyService(licensePolicyService);
  container.registerInstance(SiemDestinationService, siemDestinationService);

  // AI Service (depends on many services above)
  const aiService = new AIService(
    aiSettingsService,
    caService,
    certService,
    templatesService,
    proxyService,
    folderService,
    sslService,
    domainsService,
    accessListService,
    authService,
    auditService,
    monitoringService,
    nodesService,
    groupService,
    databaseConnectionService,
    dockerManagementService,
    notifRuleService,
    notifWebhookService,
    notifDeliveryService,
    notifDispatcherService,
    aiSandboxService,
    aiSandboxArtifactService,
    aiConversationSearchService,
    aiProviderRuntimeService,
    siemDestinationService,
    siemDeliveryService,
    generalSettingsService,
    aiPlanService,
    dockerSnapshotService,
    licensePolicyService,
    eventBus
  );
  container.registerInstance(AIService, aiService);
  if (!container.isRegistered(AIService)) {
    throw new Error('AIService must be registered before interrupted AI runs are recovered');
  }
  await aiRunService.recoverInterruptedRuns((userId) => authService.getUserById(userId));

  await initializeBackgroundServices();

  logger.info('Dependency injection container initialized');
}

import { acceptedOperations } from '@/edition/accepted-operations.js';
import { LicenseModuleService } from '@/modules/license/license-module.service.js';
