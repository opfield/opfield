import { and, eq, isNull, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessLists } from '@/db/schema/access-lists.js';
import { nodes, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { INGRESS_GROUP_CAPABILITY, nodeReportsCapability } from '@/modules/ingress-groups/ingress-group-routing.js';
import { withIngressHealthLocation } from '@/modules/ingress-groups/ingress-health.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { PageRouteService } from '@/modules/pages/routes/page-route.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  HostApplyOptions,
  NginxCertificateDistributionService,
  PreparedTlsCertificate,
} from '@/services/nginx-certificate-distribution.service.js';
import type { NginxConfigGenerator, ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { nginxConfigRejection } from '@/services/nginx-config-rejection.js';
import { isNodeNotConnectedError } from '@/services/node-connection-errors.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPoolService } from '@/services/relay-pool.service.js';
import type { AdditionalRouteService } from './additional-route.service.js';
import { supportsPagesRouteTemplate } from './additional-route-template.js';
import { effectiveMaintenance } from './effective-maintenance.js';
import { MAINTENANCE_FLAG_CAPABILITY } from './nginx-maintenance-flag-guard.js';
import {
  NGINX_ACCESS_LOG_FORMAT_CAPABILITY,
  NGINX_OPFIELD_NAMES_CAPABILITY,
  nginxNamesForNode,
} from './nginx-node-names.js';
import type { NginxTemplateService } from './nginx-template.service.js';
import type { CreateProxyHostInput, UpdateProxyHostInput } from './proxy.schemas.js';
import {
  type CertPaths,
  normalizeProxyValidationOptions,
  type ProxyValidationInput,
  updateUsesRawMode,
} from './proxy.service-helpers.js';
import {
  clearDockerUpstreamFields,
  type DockerUpstreamReference,
  type ProxyDockerUpstreamService,
} from './proxy-docker-upstream.service.js';
import { runOutsideProxyLocks, withProxyHostLock } from './proxy-host-lock.js';
import type { ProxyMaintenanceAccessService } from './proxy-maintenance-access.service.js';
import { assertProxyReferenceAccess, type ProxyReferenceInput } from './proxy-reference-access.js';
import type { ProxySecureLinkService } from './proxy-secure-link.service.js';
import type { WithDockerUpstreamDisplay } from './proxy-upstream-display.js';
import { hasRawClientIpMarker, withClientIpDirectives, withRawClientIpMarker } from './route-client-ip.js';
import { routeClientIpDirectives } from './route-client-ip-runtime.js';
import {
  NGINX_SECURE_LINK_LOOPBACK_CAPABILITY,
  secureLinkLoopbackAddresses,
  withSecureLinkLoopbackUpstreams,
} from './secure-link-loopback.js';

export { __testOnly } from './proxy.service-helpers.js';

export const logger = createChildLogger('ProxyService');
export const SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS = 500;
export const SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES = 200;
export const SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES = 10_000;
// The focused UI retains 60 samples at a 2-second cadence.
export const SECURE_LINK_TRAFFIC_WINDOW_SECONDS = 2 * 60;
export const SECURE_LINK_RUNTIME_CACHE_PREFIX = 'proxy-secure-link-runtime:';
export const SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS = 24 * 60 * 60;

export function sameDomainNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = left.map((domain) => domain.toLowerCase()).sort();
  const normalizedRight = right.map((domain) => domain.toLowerCase()).sort();
  return normalizedLeft.every((domain, index) => domain === normalizedRight[index]);
}

export function isDockerUpstream(kind: string): kind is 'docker_container' | 'docker_deployment' {
  return kind === 'docker_container' || kind === 'docker_deployment';
}

export function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProxyHostRow = typeof proxyHosts.$inferSelect;
export type CertPathOptions = { prepare?: boolean; legacy?: boolean; preserveLegacyOnUnsupported?: boolean };
export type ProxyHostView = WithDockerUpstreamDisplay<ProxyHostRow>;

export interface ProxyHostTrafficRuntime {
  hostId: string;
  statusCodes: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
  avgResponseTime: number;
  p95ResponseTime: number;
  totalRequests: number;
  totalBytes: number;
  requestsPerSecond: number;
  bytesPerSecond: number;
  busiestClientRps: number;
  windowSeconds: number;
  sampleTruncated: boolean;
  lastRequestAt?: string;
}

export type ProxyRouteRuntime = Awaited<ReturnType<ProxySecureLinkService['getRuntime']>>;

export interface ProxySecureLinkRuntimeSnapshot {
  timestamp: string;
  runtime: ProxyRouteRuntime | null;
  traffic: ProxyHostTrafficRuntime | null;
}

export interface ProxySecureLinkRuntimeSample {
  snapshot: ProxySecureLinkRuntimeSnapshot;
  history: ProxySecureLinkRuntimeSnapshot[];
}

export interface StatusPageSystemHostInput {
  domain: string;
  /** The nginx node, or with `ingressGroupId` ignored (the group's first member is recorded). */
  nodeId: string;
  /** Serve the status page from every member of this ingress group. */
  ingressGroupId?: string | null;
  sslCertificateId?: string | null;
  nginxTemplateId?: string | null;
  upstreamUrl?: string | null;
}

export interface RegistrySystemHostInput {
  domain: string;
  nodeId: string;
  sslCertificateId: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export abstract class ProxyServiceCore {
  protected abstract queueDockerReconciliation(force?: boolean): void;
  protected abstract refreshExternalBranding(): Promise<void>;
  protected abstract updateRenamedContainerReferences(nodeId: string, oldName: string, newName: string): Promise<void>;
  abstract collectSecureLinkRuntimeSnapshots(): Promise<void>;
  protected abstract requireManagedProxyHost(id: string): Promise<ProxyHostRow>;
  protected abstract runImmediateHealthCheck(hostId: string): void;
  protected abstract queueSecureLinkRuntimeSample(host: { id: string; nodeId: string | null }): void;

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly nginxTemplateService: NginxTemplateService,
    protected readonly auditService: AuditService,
    protected readonly configGenerator: NginxConfigGenerator,
    protected readonly nodeDispatch: NodeDispatchService,
    protected readonly certificateDistribution: NginxCertificateDistributionService,
    protected readonly dockerUpstreams?: ProxyDockerUpstreamService,
    protected readonly secureLinks?: ProxySecureLinkService,
    protected readonly cache?: CacheService,
    protected readonly maintenanceAccess?: ProxyMaintenanceAccessService,
    protected readonly generalSettings?: GeneralSettingsService,
    protected readonly relayPool?: RelayPoolService
  ) {}

  protected eventBus?: EventBusService;
  protected notificationEvaluator?: NotificationEvaluatorService;
  protected pageRoutes?: PageRouteService;
  protected additionalRoutes?: AdditionalRouteService;
  protected availabilityIngressReconciler?: (hostId: string) => Promise<boolean>;
  protected dockerReconcileRunning = false;
  protected dockerReconcileDirty = false;
  protected dockerReconcileForce = false;
  protected dockerReconcileRetry?: ReturnType<typeof setTimeout>;
  protected dockerReconcileBackoffMs = 5_000;
  /** Bumped on every config push/removal; reconnect cleanup uses it to detect concurrent writes. */
  protected readonly hostConfigEpochs = new Map<string, number>();
  protected readonly secureLinkRuntimeHistory = new Map<string, ProxySecureLinkRuntimeSnapshot[]>();
  protected readonly secureLinkRuntimeSamplesInFlight = new Map<string, Promise<ProxySecureLinkRuntimeSample>>();
  protected secureLinkRuntimeBackgroundInFlight: Promise<void> | null = null;
  protected secureLinkRuntimeCollectionPending = false;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('docker.snapshot.changed', (payload) => {
      if ((payload as { kind?: string })?.kind === 'containers') this.queueDockerReconciliation();
    });
    bus.subscribe('docker.deployment.changed', () => this.queueDockerReconciliation());
    bus.subscribe('node.service_address.changed', () => this.queueDockerReconciliation(true));
    bus.subscribe('node.changed', () => this.queueDockerReconciliation(true));
    bus.subscribe('system.config.changed', (payload) => {
      if ((payload as { externalBrandingChanged?: boolean })?.externalBrandingChanged) {
        void this.refreshExternalBranding().catch((error) => {
          logger.error('Failed to refresh public proxy branding', { error });
        });
      }
    });
    bus.subscribe('docker.container.changed', (payload) => {
      const event = payload as { action?: string; nodeId?: string; name?: string; oldName?: string };
      if (event.action === 'renamed' && event.nodeId && event.name && event.oldName) {
        void this.updateRenamedContainerReferences(event.nodeId, event.oldName, event.name).catch((error) => {
          logger.error('Failed to update proxy references after container rename', { error });
        });
      }
    });
    bus.subscribe('nginx.template.changed', (payload) => {
      const event = payload as {
        id?: string;
        action?: string;
        renderingChanged?: boolean;
        type?: string;
        isBuiltin?: boolean;
      };
      if (event.id && event.action === 'updated' && event.renderingChanged === true) {
        void this.reconcileTemplateHosts(event.id, {
          type: event.type,
          isBuiltin: event.isBuiltin === true,
        }).catch((error) => {
          logger.error('Failed to reconcile routes after Nginx template update', {
            templateId: event.id,
            error,
          });
        });
      }
    });
    this.queueDockerReconciliation(true);
    // Do not wait for the first 10s scheduler tick. If startup reconciliation
    // is still using daemon command capacity, the collection is retained and
    // starts as soon as reconciliation releases it.
    void this.collectSecureLinkRuntimeSnapshots();
  }
  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.notificationEvaluator = evaluator;
  }
  setPageRoutes(pageRoutes: PageRouteService) {
    this.pageRoutes = pageRoutes;
  }
  setAdditionalRoutes(additionalRoutes: AdditionalRouteService) {
    this.additionalRoutes = additionalRoutes;
    additionalRoutes.setHostRuntime(this);
  }
  setAvailabilityIngressReconciler(reconciler: (hostId: string) => Promise<boolean>) {
    this.availabilityIngressReconciler = reconciler;
    this.queueDockerReconciliation(true);
  }

  /** Require access to referenced certificates, access lists and templates (see proxy-reference-access). */
  async assertReferenceAccess(
    scopes: string[],
    input: ProxyReferenceInput,
    existing?: ProxyReferenceInput
  ): Promise<void> {
    await assertProxyReferenceAccess(this.db, scopes, input, existing);
  }

  /** Re-render a host after an Additional Route lifecycle transition. */
  async reconcileAdditionalRouteHost(hostId: string): Promise<void> {
    await this.reapplyHostConfig(hostId);
  }

  /**
   * Re-render and apply the current DB state of one enabled host through the
   * normal build/apply path (raw configs, maintenance, Secure Links, Pages,
   * Additional Routes, access-list credentials and config ownership).
   * Returns the applied host, or null when the host is missing or disabled.
   */
  async reapplyHostConfig(hostId: string, apply?: HostApplyOptions): Promise<ProxyHostRow | null> {
    return withProxyHostLock(hostId, async () => {
      const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
      if (!host?.enabled) return null;
      await this.renderAndApplyHost(host, { preserveLegacyOnUnsupported: true }, undefined, apply);
      return host;
    });
  }

  /** Renders and applies a route on every node that serves it (see ProxyServiceDelivery.deliverHost). */
  protected abstract deliverHost(
    host: ProxyHostRow,
    options?: {
      certOptions?: CertPathOptions;
      pagesRouteIncludePathOverride?: string;
      nodeIds?: string[];
      apply?: HostApplyOptions;
    }
  ): Promise<{ config: string; configOwnership: string; epoch: number; configs: Map<string, string> }>;

  protected async renderAndApplyHost(
    host: ProxyHostRow,
    certOptions: CertPathOptions = {},
    nodeIds?: string[],
    apply?: HostApplyOptions
  ): Promise<{ config: string; configOwnership: string; epoch: number; configs: Map<string, string> }> {
    return this.deliverHost(host, { certOptions, nodeIds, apply });
  }

  async reconcileTemplateHosts(
    templateId: string,
    options: { type?: string; isBuiltin?: boolean } = {}
  ): Promise<{ total: number; succeeded: number; failed: number; deferred: number }> {
    const templateMatch =
      options.isBuiltin && options.type
        ? and(
            eq(proxyHosts.type, options.type as ProxyHostRow['type']),
            or(eq(proxyHosts.nginxTemplateId, templateId), isNull(proxyHosts.nginxTemplateId))
          )
        : eq(proxyHosts.nginxTemplateId, templateId);
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(templateMatch, eq(proxyHosts.enabled, true)),
    });
    let succeeded = 0;
    let failed = 0;
    // Routes of nodes without a control session (at Opfield start the built-in templates are updated before the
    // nodes reconnect) are rendered from the current templates by the node's reconnect sync; pushing them now can
    // only fail.
    let deferred = 0;

    for (const host of hosts) {
      if (host.nodeId && !this.nodeDispatch.isNodeConnected(host.nodeId)) {
        deferred += 1;
        continue;
      }
      try {
        await this.reconcileAdditionalRouteHost(host.id);
        succeeded += 1;
      } catch (error) {
        if (isNodeNotConnectedError(error)) {
          // The node went away meanwhile: same as above.
          deferred += 1;
          continue;
        }
        failed += 1;
        logger.error('Failed to regenerate route after Nginx template update', {
          templateId,
          hostId: host.id,
          nodeId: host.nodeId,
          error,
        });
      }
    }

    logger.info('Reconciled routes after Nginx template update', {
      templateId,
      total: hosts.length,
      succeeded,
      failed,
      ...(deferred > 0 ? { deferredToNodeReconnect: deferred } : {}),
    });
    return { total: hosts.length, succeeded, failed, deferred };
  }
  protected reconcileMaintenanceAlerts(hostId?: string) {
    void this.notificationEvaluator?.reconcileProxyMaintenance(hostId).catch((error) => {
      logger.warn('Failed to reconcile proxy maintenance alerts', { hostId, error });
    });
  }
  protected emitHost(id: string, action: string, domain?: string, extra: Record<string, unknown> = {}) {
    // Subscribers start their own work; it must not inherit a lock held by the emitter.
    runOutsideProxyLocks(() => this.eventBus?.publish('proxy.host.changed', { id, action, domain, ...extra }));
  }

  protected async isOpfieldPublicRoute(host: Pick<ProxyHostRow, 'domainNames'>): Promise<boolean> {
    const publicUrl = await this.generalSettings?.getPublicUrl();
    if (!publicUrl) return false;
    let publicHostname: string;
    try {
      publicHostname = normalizedHostname(new URL(publicUrl).hostname);
    } catch {
      return false;
    }
    return host.domainNames.some((domain) => normalizedHostname(domain) === publicHostname);
  }

  protected async applyConfigToNode(
    hostId: string,
    config: string,
    nodeId: string | null,
    preparedTls?: PreparedTlsCertificate | null,
    configOwnership = 'user_owned',
    accessListId?: string | null,
    applyOptions: HostApplyOptions = {}
  ): Promise<void> {
    const resolvedNodeId = preparedTls?.nodeId ?? (await this.nodeDispatch.resolveNodeId(nodeId));
    this.bumpHostConfigEpoch(hostId);
    await this.deployAccessListCredentials(resolvedNodeId, accessListId);
    if (preparedTls) {
      await this.certificateDistribution.applyHostBundle(
        { id: hostId, nodeId },
        config,
        preparedTls,
        configOwnership,
        applyOptions
      );
    } else {
      const result = await this.nodeDispatch.applyConfig(
        resolvedNodeId,
        hostId,
        config,
        false,
        configOwnership,
        applyOptions.deferReload ?? false,
        applyOptions.maintenance
      );
      if (!result.success) {
        const error = result.error || 'Daemon config apply failed';
        throw nginxConfigRejection(error) ?? new Error(error);
      }
    }
    await this.auditService.log({
      userId: null,
      action: 'node.config_push',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { nodeId: resolvedNodeId },
    });
  }

  protected async deployAccessListCredentials(nodeId: string, accessListId?: string | null): Promise<void> {
    if (!accessListId) return;

    const list = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, accessListId),
    });
    if (!list?.basicAuthEnabled) return;

    const users = list.basicAuthUsers as { username: string; passwordHash: string }[];
    if (users.length === 0) {
      throw new Error(`Access list ${accessListId} has basic auth enabled without credentials`);
    }
    const content = `${users.map((user) => `${user.username}:${user.passwordHash}`).join('\n')}\n`;
    const result = await this.nodeDispatch.deployHtpasswd(nodeId, accessListId, content);
    if (!result.success) {
      throw new Error(result.error || `Failed to deploy access list credentials to node ${nodeId}`);
    }
  }

  protected configOwnershipForHost(host: ProxyHostRow): 'managed_secure_link' | 'user_owned' {
    const committedSecureConfig = host.secureLinkGeneration > 0 && host.secureLinkMigratedAt != null;
    return host.type === 'proxy' &&
      !host.rawConfigEnabled &&
      isDockerUpstream(host.upstreamKind) &&
      committedSecureConfig
      ? 'managed_secure_link'
      : 'user_owned';
  }

  protected async restoreConfigOnNode(host: ProxyHostRow): Promise<void> {
    await this.renderAndApplyHost(host, { preserveLegacyOnUnsupported: true });
  }

  protected bumpHostConfigEpoch(hostId: string): number {
    const next = (this.hostConfigEpochs.get(hostId) ?? 0) + 1;
    this.hostConfigEpochs.set(hostId, next);
    return next;
  }

  protected async removeConfigFromNode(hostId: string, nodeId: string | null): Promise<void> {
    const resolvedNodeId = await this.nodeDispatch.resolveNodeId(nodeId);
    this.bumpHostConfigEpoch(hostId);
    const result = await this.nodeDispatch.removeConfig(resolvedNodeId, hostId);
    if (!result.success) {
      throw new Error(result.error || 'Daemon config remove failed');
    }
  }

  protected async disablePageHostForDeferredCleanup(hostId: string, cleanupError: unknown): Promise<void> {
    try {
      await this.db.update(proxyHosts).set({ enabled: false, updatedAt: new Date() }).where(eq(proxyHosts.id, hostId));
    } catch (disableError) {
      logger.warn('Failed to disable Pages Route host retained for deferred cleanup', {
        hostId,
        cleanupError,
        disableError,
      });
    }
  }

  protected requireDockerUpstreams(): ProxyDockerUpstreamService {
    if (!this.dockerUpstreams) {
      throw new AppError(500, 'DOCKER_UPSTREAMS_UNAVAILABLE', 'Docker upstream resolution is unavailable');
    }
    return this.dockerUpstreams;
  }

  protected async assertPagesTemplateCompatible(templateId: string | null | undefined): Promise<void> {
    if (!templateId) return;
    const template = await this.nginxTemplateService.getTemplate(templateId);
    if (template.type === 'proxy' && supportsPagesRouteTemplate(template.content)) return;
    throw new AppError(
      400,
      'PAGES_ROUTE_TEMPLATE_UNSUPPORTED',
      'Select a proxy template that includes the managed Pages route placeholder'
    );
  }

  protected async prepareCreateUpstream(input: CreateProxyHostInput, options: ProxyValidationInput) {
    const normalized = normalizeProxyValidationOptions(options);
    if (input.type !== 'proxy' || input.rawConfigEnabled) {
      return { upstreamKind: 'manual' as const, forwardHost: null, forwardPort: null, ...clearDockerUpstreamFields() };
    }
    if (input.upstreamKind === 'manual') {
      return { upstreamKind: 'manual' as const, ...clearDockerUpstreamFields() };
    }
    if (input.upstreamKind === 'pages') {
      if (!this.pageRoutes) throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route service is unavailable');
      await this.pageRoutes.validateCreate(input);
      return {
        upstreamKind: 'pages' as const,
        forwardHost: null,
        forwardPort: null,
        ...clearDockerUpstreamFields(),
      };
    }
    return this.requireDockerUpstreams().resolve(input, {
      actorScopes: normalized.actorScopes,
      requireAvailable: true,
      refreshOnMiss: true,
      followAvailability: true,
    });
  }

  protected async prepareUpdateUpstream(
    existing: ProxyHostRow,
    input: UpdateProxyHostInput,
    options: ProxyValidationInput
  ): Promise<Record<string, unknown>> {
    const normalized = normalizeProxyValidationOptions(options);
    const effectiveType = input.type ?? existing.type;
    // Raw mode is an alternate renderer for an existing host. Keep the dormant
    // upstream so disabling raw mode can restore the previous target.
    if (updateUsesRawMode(existing, input)) return {};
    if (effectiveType !== 'proxy') {
      return { upstreamKind: 'manual', forwardHost: null, forwardPort: null, ...clearDockerUpstreamFields() };
    }

    const effectiveKind = input.upstreamKind ?? existing.upstreamKind;
    if (effectiveKind === 'pages' || existing.upstreamKind === 'pages') {
      if (effectiveKind !== 'pages' || existing.upstreamKind !== 'pages') {
        throw new AppError(
          409,
          'PAGES_ROUTE_KIND_CHANGE_UNSUPPORTED',
          'Recreate the Route to change its Pages target type'
        );
      }
      if (input.nodeId && input.nodeId !== existing.nodeId && !normalized.allowPagesNodeMove) {
        throw new AppError(409, 'PAGES_ROUTE_MIGRATION_REQUIRED', 'Move this Pages Route through ingress migration');
      }
      return {};
    }
    if (effectiveKind === 'manual') {
      if (
        existing.upstreamKind !== 'manual' &&
        input.upstreamKind === 'manual' &&
        (input.forwardHost === undefined || input.forwardPort === undefined)
      ) {
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host and port are required for a manual upstream');
      }
      const forwardHost = input.forwardHost === undefined ? existing.forwardHost : input.forwardHost;
      const forwardPort = input.forwardPort === undefined ? existing.forwardPort : input.forwardPort;
      if (!forwardHost || !forwardPort) {
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host and port are required for a manual upstream');
      }
      return { upstreamKind: 'manual', forwardHost, forwardPort, ...clearDockerUpstreamFields() };
    }
    if (effectiveKind === 'managed_storage') {
      throw new AppError(
        409,
        'MANAGED_STORAGE_MAIN_UPSTREAM_UNSUPPORTED',
        'Managed storage is available only through Additional Secure Links'
      );
    }

    // A stored Compose target also records its resolved container name, so a
    // request naming a container without mentioning the Compose fields is a
    // switch to that named container: the Compose reference must not win.
    const selectsNamedContainer =
      typeof input.dockerContainerName === 'string' &&
      input.dockerComposeProjectId === undefined &&
      input.dockerComposeServiceName === undefined &&
      (existing.dockerComposeProjectId != null || existing.dockerComposeServiceName != null);
    const reference: DockerUpstreamReference = {
      upstreamKind: effectiveKind,
      dockerNodeId: input.dockerNodeId === undefined ? existing.dockerNodeId : input.dockerNodeId,
      dockerContainerName:
        input.dockerContainerName === undefined ? existing.dockerContainerName : input.dockerContainerName,
      dockerComposeProjectId: selectsNamedContainer
        ? null
        : input.dockerComposeProjectId === undefined
          ? existing.dockerComposeProjectId
          : input.dockerComposeProjectId,
      dockerComposeServiceName: selectsNamedContainer
        ? null
        : input.dockerComposeServiceName === undefined
          ? existing.dockerComposeServiceName
          : input.dockerComposeServiceName,
      dockerDeploymentId:
        input.dockerDeploymentId === undefined ? existing.dockerDeploymentId : input.dockerDeploymentId,
      dockerContainerPort:
        input.dockerContainerPort === undefined ? existing.dockerContainerPort : input.dockerContainerPort,
      dockerHostPort: input.dockerHostPort === undefined ? existing.dockerHostPort : input.dockerHostPort,
      dockerProtocol: input.dockerProtocol === undefined ? existing.dockerProtocol : input.dockerProtocol,
    };
    const targetChanged =
      existing.upstreamKind !== effectiveKind ||
      existing.dockerNodeId !== reference.dockerNodeId ||
      existing.dockerContainerName !== reference.dockerContainerName ||
      existing.dockerComposeProjectId !== reference.dockerComposeProjectId ||
      existing.dockerComposeServiceName !== reference.dockerComposeServiceName ||
      existing.dockerDeploymentId !== reference.dockerDeploymentId ||
      existing.dockerContainerPort !== reference.dockerContainerPort ||
      (existing.dockerProtocol ?? 'tcp') !== (reference.dockerProtocol ?? 'tcp');
    if (!targetChanged) return {};
    const resolved = await this.requireDockerUpstreams().resolve(reference, {
      actorScopes: normalized.actorScopes,
      requireAvailable: true,
      refreshOnMiss: true,
      followAvailability: true,
    });
    // Create-time Docker resolution uses loopback placeholders, but an update
    // must retain the real legacy endpoint until Secure Link cutover commits.
    const { forwardHost: _forwardHost, forwardPort: _forwardPort, ...candidate } = resolved;
    return candidate;
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async validateAdvancedConfig(
    snippet: string,
    rawMode = false,
    bypassAdvancedValidation = false,
    bypassRawValidation = false,
    proxyHostId?: string
  ) {
    if (!rawMode && bypassAdvancedValidation) {
      return { valid: true, errors: [] };
    }

    // Basic static checks first
    const staticResult = this.configGenerator.validateAdvancedConfig(snippet, rawMode, bypassRawValidation);
    if (!staticResult.valid) return staticResult;

    // Do not run backend-local nginx -t for raw mode. Raw configs can contain
    // valid node-specific includes/paths that do not exist inside Opfield
    // container, so local syntax checks produce false failures. The actual
    // node-side validation still happens during save/apply.
    if (rawMode) {
      return staticResult;
    }

    if (proxyHostId) {
      await this.requireManagedProxyHost(proxyHostId);
      await this.secureLinks?.assertAdditionalReferences(proxyHostId, snippet);
    } else if (/\{\{additionalSecureLinks\./.test(snippet)) {
      return { valid: false, errors: ['Select a route before validating additional Secure Link variables'] };
    }

    try {
      this.nginxTemplateService.previewWithSampleData(snippet);
    } catch (err) {
      return {
        valid: false,
        errors: [err instanceof Error ? `Template rendering error: ${err.message}` : 'Template rendering error'],
      };
    }

    return staticResult;
  }

  // -----------------------------------------------------------------------
  // Helpers — cert path resolution
  // -----------------------------------------------------------------------

  protected async resolveCertPaths(host: ProxyHostRow, options: CertPathOptions = {}): Promise<CertPaths> {
    if (!host.sslEnabled) return { sslCertPath: null, sslKeyPath: null, sslChainPath: null };
    if (options.legacy) return this.certificateDistribution.legacyPathsForHost(host);
    if (options.preserveLegacyOnUnsupported && !(await this.certificateDistribution.supportsNode(host.nodeId))) {
      return this.certificateDistribution.legacyPathsForHost(host);
    }
    if (options.prepare === false) return this.certificateDistribution.peekPathsForHost(host);

    const preparedTls = await this.certificateDistribution.prepareForHost(host);
    if (!preparedTls) return { sslCertPath: null, sslKeyPath: null, sslChainPath: null };
    return {
      sslCertPath: preparedTls.sslCertPath,
      sslKeyPath: preparedTls.sslKeyPath,
      sslChainPath: preparedTls.sslChainPath,
      preparedTls,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers — access list resolution
  // -----------------------------------------------------------------------

  protected async resolveAccessList(accessListId: string | null): Promise<ProxyHostConfig['accessList']> {
    if (!accessListId) return null;

    const list = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, accessListId),
    });

    if (!list) return null;

    return {
      id: list.id,
      ipRules: list.ipRules as { type: string; value: string }[],
      basicAuthEnabled: list.basicAuthEnabled,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers — build ProxyHostConfig from DB row
  // -----------------------------------------------------------------------

  protected async buildNginxConfig(
    host: ProxyHostRow,
    certPaths: CertPaths,
    accessList: ProxyHostConfig['accessList'],
    pagesRouteIncludePathOverride?: string
  ): Promise<string> {
    // Raw mode is an explicit user-owned escape hatch: only the node's file and nginx names in it follow the node
    // (nginx-node-names.ts).
    if ((host.type === 'raw' || host.rawConfigEnabled) && host.rawConfig) {
      // A raw config gets the client IP directives only where it asks for them (route-client-ip.ts).
      const raw = hasRawClientIpMarker(host.rawConfig)
        ? withRawClientIpMarker(host.rawConfig, await routeClientIpDirectives(this.db, host))
        : host.rawConfig;
      return this.withNodeNginxNames(host.nodeId, raw);
    }

    const usesSecureLink =
      isDockerUpstream(host.upstreamKind) && host.secureLinkGeneration > 0 && host.secureLinkMigratedAt != null;
    const usesRegistryIngress = host.isSystem && host.systemKind === 'docker_registry';
    const additionalSecureLinks = this.secureLinks ? await this.secureLinks.getActiveAdditional(host.id) : [];
    const availabilityMembers =
      isDockerUpstream(host.upstreamKind) && this.secureLinks?.getActiveAvailabilityMembers
        ? await this.secureLinks.getActiveAvailabilityMembers(host.id, `proxy-host:${host.id}`)
        : [];
    const usesAvailabilityMembers = availabilityMembers.length > 0;
    const additionalRoutes = this.additionalRoutes ? await this.additionalRoutes.getRenderConfig(host.id) : [];
    await this.secureLinks?.assertAdditionalReferences(host.id, host.advancedConfig);
    if (host.upstreamKind === 'pages' && !this.pageRoutes) {
      throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route service is unavailable');
    }
    const pagesRouteConfig = host.upstreamKind === 'pages' ? await this.pageRoutes!.getRenderConfig(host.id) : null;
    const pagesRouteIncludePath = pagesRouteConfig
      ? (pagesRouteIncludePathOverride ?? pagesRouteConfig.includePath)
      : undefined;
    const registryAuthRealm = usesRegistryIngress
      ? new URL('/api/docker/registry/token', await this.generalSettings!.requirePublicUrl()).href
      : undefined;
    const config: ProxyHostConfig = {
      id: host.id,
      type: host.type,
      domainNames: host.domainNames,
      enabled: host.enabled,
      forwardHost: usesSecureLink || usesAvailabilityMembers || usesRegistryIngress ? '127.0.0.1' : host.forwardHost,
      forwardPort: usesSecureLink ? (host.secureLinkListenerPort ?? host.forwardPort) : host.forwardPort,
      forwardScheme: host.forwardScheme ?? 'http',
      upstreamIpv6Enabled: host.upstreamIpv6Enabled,
      secureLinkUpstream: usesSecureLink || usesAvailabilityMembers || usesRegistryIngress,
      secureLinkSocketPath: usesSecureLink
        ? `/run/opfield-secure-links/${host.id}.sock`
        : usesAvailabilityMembers
          ? `/run/opfield-secure-links/${availabilityMembers[0]!.id}.sock`
          : usesRegistryIngress
            ? `/run/opfield-registry-links/${host.id}.sock`
            : undefined,
      secureLinkSocketPaths: usesAvailabilityMembers
        ? availabilityMembers.map((binding) => `/run/opfield-secure-links/${binding.id}.sock`)
        : undefined,
      registryAuthRealm,
      additionalSecureLinks: await Promise.all(
        additionalSecureLinks.map(async (binding) => {
          const members = this.secureLinks?.getActiveAvailabilityMembers
            ? await this.secureLinks.getActiveAvailabilityMembers(host.id, `additional-secure-link:${binding.id}`)
            : [];
          return {
            id: binding.id,
            name: binding.name,
            scheme: binding.forwardScheme,
            socketPath: `/run/opfield-secure-links/${binding.id}.sock`,
            socketPaths:
              members.length > 0 ? members.map((member) => `/run/opfield-secure-links/${member.id}.sock`) : undefined,
          };
        })
      ),
      sslEnabled: host.sslEnabled && !!certPaths.sslCertPath && !!certPaths.sslKeyPath,
      sslForced: host.sslForced,
      http2Support: host.http2Support,
      websocketSupport: host.websocketSupport,
      redirectUrl: host.redirectUrl,
      redirectStatusCode: host.redirectStatusCode ?? 301,
      customHeaders: (host.customHeaders ?? []) as { name: string; value: string }[],
      cacheEnabled: host.cacheEnabled,
      cacheOptions: host.cacheOptions as Record<string, unknown> | null,
      rateLimitEnabled: host.rateLimitEnabled,
      rateLimitMode: host.rateLimitMode,
      rateLimitOptions: host.rateLimitOptions as Record<string, unknown> | null,
      customRewrites: (host.customRewrites ?? []) as { source: string; destination: string; type: string }[],
      advancedConfig: host.advancedConfig,
      accessList,
      sslCertPath: certPaths.sslCertPath,
      sslKeyPath: certPaths.sslKeyPath,
      sslChainPath: certPaths.sslChainPath,
      templateVariables: (host.templateVariables ?? {}) as Record<string, string | number | boolean>,
      pagesRouteIncludePath,
      pagesSpaFallback: pagesRouteConfig?.spaFallback,
      pagesFallbackUrl: pagesRouteConfig?.fallbackUrl,
      additionalRoutes,
      statusPageStaleCache: host.isSystem && host.systemKind === 'status_page',
    };

    const hideExternalBranding = (await this.generalSettings?.getConfig())?.hideExternalBranding ?? false;
    const rendered = await this.nginxTemplateService.renderForHost(
      config,
      host.nginxTemplateId ?? null,
      hideExternalBranding
    );
    // On a node that keeps maintenance flags the guard is part of the config in and out of maintenance, so a toggle
    // reloads nothing (nginx-maintenance-flag-guard.ts). Otherwise, and for a config that cannot carry it, the guard
    // is rendered only during maintenance and each toggle reloads nginx.
    // An app kill switch locks the route down: the plain maintenance page without team access, in the config itself
    // (a reload), so no flag, access code or earlier bypass cookie opens it.
    const lockdown = (host.appMaintenanceMode ?? 'off') === 'lockdown';
    const flagGuard =
      !lockdown && this.maintenanceAccess && (await this.nodeKeepsMaintenanceFlag(host))
        ? this.nginxTemplateService.applyMaintenanceFlagGuard(
            rendered,
            { hostId: host.id, secret: this.maintenanceAccess.secretForHost(host.id) },
            hideExternalBranding
          )
        : null;
    let result = flagGuard ?? rendered;
    if (!flagGuard && effectiveMaintenance(host)) {
      const access =
        !lockdown && this.maintenanceAccess && (await this.maintenanceAccess.isNodeSupported(host.nodeId))
          ? { hostId: host.id, secret: this.maintenanceAccess.secretForHost(host.id) }
          : undefined;
      result = this.nginxTemplateService.applyMaintenanceGuard(rendered, access, hideExternalBranding);
    }
    // A node whose daemon serves the links on loopback TCP gets them there: a cut stream then ends with a reset,
    // which nginx reports, instead of the clean end a Unix socket gives (secure-link-loopback.ts). Rendered per node:
    // an older daemon serves the Unix sockets only.
    if (await this.nodeReports(host.nodeId, NGINX_SECURE_LINK_LOOPBACK_CAPABILITY)) {
      result = withSecureLinkLoopbackUpstreams(result, await secureLinkLoopbackAddresses(this.db, result));
    }
    // Every server block on a node with the ingress health responder answers the reserved health path (rendered
    // per node: an older daemon lacks the generation variable the location uses).
    if (await this.nodeServesIngressHealth(host.nodeId)) result = withIngressHealthLocation(result);
    // The client address behind Cloudflare or trusted proxies, for access lists, rate limits, logs and upstreams.
    result = withClientIpDirectives(result, await routeClientIpDirectives(this.db, host));
    return this.withNodeNginxNames(host.nodeId, result);
  }

  /**
   * A config with the names the node runs with: the Opfield ones once its daemon reports them, else the pre-Opfield
   * ones (a 2.12.0 daemon, or a newer one the launcher has not committed yet). See nginx-node-names.ts.
   */
  protected async withNodeNginxNames(nodeId: string | null, config: string): Promise<string> {
    const opfieldNames = !nodeId || (await this.nodeReports(nodeId, NGINX_OPFIELD_NAMES_CAPABILITY));
    const accessLogFormat = !!nodeId && (await this.nodeReports(nodeId, NGINX_ACCESS_LOG_FORMAT_CAPABILITY));
    return nginxNamesForNode(config, opfieldNames, accessLogFormat);
  }

  protected async nodeServesIngressHealth(nodeId: string | null): Promise<boolean> {
    return this.nodeReports(nodeId, INGRESS_GROUP_CAPABILITY);
  }

  /** Whether the route can enter maintenance and its node switches maintenance by flag instead of by reload. */
  protected async nodeKeepsMaintenanceFlag(
    host: Pick<ProxyHostRow, 'type' | 'rawConfigEnabled' | 'isSystem' | 'nodeId'>
  ): Promise<boolean> {
    if (host.type !== 'proxy' || host.rawConfigEnabled || host.isSystem) return false;
    return this.nodeKeepsMaintenanceFlags(host.nodeId);
  }

  /**
   * The maintenance state a route's apply carries to a node that keeps maintenance flags; undefined for a node that
   * does not (the flag stays as it is).
   */
  protected async maintenanceFlagFor(
    host: Pick<ProxyHostRow, 'enabled' | 'maintenanceEnabled'> & { appMaintenanceMode?: string | null },
    nodeId: string | null
  ): Promise<boolean | undefined> {
    if (!(await this.nodeKeepsMaintenanceFlags(nodeId))) return undefined;
    return host.enabled && effectiveMaintenance(host);
  }

  protected async nodeKeepsMaintenanceFlags(nodeId: string | null): Promise<boolean> {
    return this.nodeReports(nodeId, MAINTENANCE_FLAG_CAPABILITY);
  }

  private async nodeReports(nodeId: string | null, capability: string): Promise<boolean> {
    if (!nodeId) return false;
    const node = await this.db.query?.nodes?.findFirst?.({
      where: eq(nodes.id, nodeId),
      columns: { capabilities: true },
    });
    return nodeReportsCapability(node?.capabilities, capability);
  }
}
