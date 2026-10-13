import { createHash } from 'node:crypto';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import type { AISettingsService } from '@/modules/ai/ai.settings.service.js';
import type { AIProviderRuntimeService } from '@/modules/ai/ai-provider-runtime.service.js';
import { hasAppsSectionScope } from '@/modules/apps/app-access.js';
import { AppsService } from '@/modules/apps/apps.service.js';
import { DEMO_MODE_CTA_URL, isDemoMode } from '@/modules/demo/demo-mode.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { entitlementsIncludeFeature } from '@/modules/license/license-features.js';
import type { LicensePolicyService, SafeLicenseSummary } from '@/modules/license/license-policy.service.js';
import type { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import type { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import {
  DEFAULT_GENERAL_SETTINGS,
  type GeneralSettings,
  type GeneralSettingsService,
} from '@/modules/settings/general-settings.service.js';
import type { StatusPageConfig, StatusPageService } from '@/modules/status-page/status-page.service.js';
import type { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import type {
  ResourceSnapshotEnvelope,
  ResourceSnapshotLease,
  ResourceSnapshotStore,
} from '@/services/resource-snapshot.store.js';
import type { UpdateService } from '@/services/update.service.js';
import type { User } from '@/types.js';

const logger = createChildLogger('UIBootstrap');

const NODE_SNAPSHOT_KIND = 'ui-shell-nodes';
const NODE_SNAPSHOT_ID = 'all';
const CONFIG_SNAPSHOT_KIND = 'ui-shell-config';
const CONFIG_SNAPSHOT_ID = 'global';
const STATUS_PAGE_SNAPSHOT_KIND = 'ui-shell-status-page';
const STATUS_PAGE_SNAPSHOT_ID = 'global';
const CLOUDFLARE_SNAPSHOT_KIND = 'ui-shell-cloudflare';
const CLOUDFLARE_SNAPSHOT_ID = 'global';
const DOCKER_VIEW_SCOPES = [
  'docker:containers:view',
  'docker:images:view',
  'docker:volumes:view',
  'docker:networks:view',
] as const;

type ShellNode = Awaited<ReturnType<NodesService['list']>>['data'][number];

export interface UIBootstrapShell {
  demo?: {
    ctaUrl: typeof DEMO_MODE_CTA_URL;
  };
  access: {
    fingerprint: string;
    scopes: string[];
  };
  systemConfig: {
    publicUrl: string | null;
    fileUploadMaxBytes: number;
    fileOpenMaxBytes: number;
    grpcPublicTarget: string | null;
    grpcLocalIp: string | null;
    relayAutoRecovery: boolean;
    features: {
      pkiEnabled: boolean;
      domainsEnabled: boolean;
      siemEnabled: boolean;
      loggingEnabled: boolean;
      inferenceEnabled: boolean;
    };
  };
  navigation: {
    hasNginxNodes: boolean;
    hasCloudflareIntegration: boolean;
    statusPageEnabled: boolean;
    pagesEnabled: boolean;
    /**
     * The caller has no apps:view or apps:create but sees at least one app through members it can view: the Apps
     * section is shown for those apps.
     */
    appsByMembers: boolean;
    dockerNodes: ShellNode[];
    nodes: ResourceSnapshotEnvelope<ShellNode[]>;
  };
  update: unknown | null;
  aiStatus: unknown | null;
  aiWorkspace: { configured: boolean; installationOwner: boolean };
  license: SafeLicenseSummary;
  commercialModule: 'community' | 'unavailable' | 'ready';
}

/**
 * The authenticated UI's first request. It contains only permission-filtered
 * shell data, so layout decisions are stable before page-area data arrives.
 */
export class UIBootstrapService {
  constructor(
    private readonly snapshots: ResourceSnapshotStore,
    private readonly coordinator: ReadModelCoordinator,
    private readonly nodes: NodesService,
    private readonly settings: GeneralSettingsService,
    private readonly loggingFeature: LoggingFeatureService,
    private readonly integrations: IntegrationsService,
    private readonly statusPage: StatusPageService,
    private readonly updates: UpdateService,
    private readonly aiRuntime: AIProviderRuntimeService,
    private readonly aiSettings: AISettingsService,
    private readonly finalizeSetup: FinalizeSetupService,
    private readonly licensePolicy: LicensePolicyService,
    private readonly pageProfile?: PageProfileService,
    private readonly commercialEdition?: CommercialEditionRuntime
  ) {
    this.coordinator.register({
      id: 'ui-shell:nodes',
      refresh: () => this.refreshNodes(),
      events: [{ channel: 'node.changed' }, { channel: 'node.slug.changed' }],
      fallbackIntervalMs: 10_000,
    });
    this.coordinator.register({
      id: 'ui-shell:config',
      refresh: () => this.refreshConfig(),
      events: [{ channel: 'system.config.changed' }],
      fallbackIntervalMs: 10_000,
    });
    this.coordinator.register({
      id: 'ui-shell:status-page',
      refresh: () => this.refreshStatusPageConfig(),
      events: [{ channel: 'status-page.changed' }],
      fallbackIntervalMs: 10_000,
    });
    this.coordinator.register({
      id: 'ui-shell:cloudflare',
      refresh: () => this.refreshCloudflareIntegration(),
      events: [{ channel: 'integration.connector.changed' }],
      fallbackIntervalMs: 10_000,
    });
  }

  async getShell(user: User, scopes: string[]): Promise<UIBootstrapShell> {
    const [
      nodeSnapshot,
      configSnapshot,
      statusPageSnapshot,
      cloudflareSnapshot,
      update,
      aiStatus,
      aiWorkspaceConfigured,
      installationOwner,
      license,
      pagesEnabled,
      appsByMembers,
    ] = await Promise.all([
      this.getNodeSnapshot(),
      this.getConfigSnapshot(),
      this.getStatusPageConfigSnapshot(),
      this.getCloudflareIntegrationSnapshot(),
      hasScope(scopes, 'admin:update') ? this.updates.getCachedStatus() : Promise.resolve(null),
      hasScope(scopes, 'ai:workspace:use') ? this.aiRuntime.statusForUser(user) : Promise.resolve(null),
      this.aiSettings.isEnabled(),
      this.finalizeSetup.isOwner(user.id),
      this.licensePolicy.getSummary(),
      hasScopeBase(scopes, 'pages:view') || hasScope(scopes, 'pages:folders:manage')
        ? (this.pageProfile?.isEnabled() ?? Promise.resolve(false))
        : Promise.resolve(false),
      this.appsByMembers(scopes),
    ]);
    const config = configSnapshot.data;
    const canViewOpfieldSettings = hasScope(scopes, 'settings:opfield:view');

    const visibleNodes = this.visibleNodes(nodeSnapshot.data, scopes);
    const dockerNodes = this.visibleDockerNodes(nodeSnapshot.data, scopes);

    return {
      ...(isDemoMode() ? { demo: { ctaUrl: DEMO_MODE_CTA_URL } } : {}),
      access: {
        fingerprint: createHash('sha256')
          .update(`${user.id}\u0000${[...scopes].sort().join('\u0000')}`)
          .digest('base64url'),
        scopes: [...scopes],
      },
      systemConfig: {
        publicUrl: config.publicUrl,
        fileUploadMaxBytes: config.fileUploadMaxBytes,
        fileOpenMaxBytes: config.fileOpenMaxBytes,
        grpcPublicTarget: canViewOpfieldSettings ? config.grpcPublicTarget : null,
        grpcLocalIp: canViewOpfieldSettings ? config.grpcLocalIp : null,
        relayAutoRecovery: canViewOpfieldSettings ? config.relayAutoRecovery : false,
        features: {
          // The switches default to on; a plan without the feature reports them off.
          pkiEnabled:
            config.features.pkiEnabled && entitlementsIncludeFeature(license.entitlements.features, 'internal-pki'),
          domainsEnabled: config.features.domainsEnabled,
          siemEnabled:
            config.features.siemEnabled && entitlementsIncludeFeature(license.entitlements.features, 'siem-export'),
          loggingEnabled: this.loggingFeature.isEnabled(),
          inferenceEnabled: config.features.inferenceEnabled,
        },
      },
      navigation: {
        // Navigation is permission-driven, not data-driven. Keeping the
        // section present avoids a late layout shift while node snapshots are
        // warming; an empty resource page owns its own empty state.
        hasNginxNodes: true,
        hasCloudflareIntegration: cloudflareSnapshot.data,
        statusPageEnabled: hasScope(scopes, 'status-page:view') && statusPageSnapshot.data.enabled,
        pagesEnabled: pagesEnabled && entitlementsIncludeFeature(license.entitlements.features, 'pages'),
        appsByMembers,
        dockerNodes,
        nodes: { ...nodeSnapshot, data: visibleNodes },
      },
      update,
      aiStatus,
      aiWorkspace: {
        configured: aiWorkspaceConfigured,
        installationOwner,
      },
      license,
      commercialModule: this.commercialEdition?.status.state ?? 'community',
    };
  }

  private async getNodeSnapshot(): Promise<ResourceSnapshotEnvelope<ShellNode[]>> {
    const cached = await this.snapshots.get<ShellNode[]>(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, (lease) =>
      this.loadNodes(lease)
    );
    if (refreshed.acquired) return refreshed.value;

    // Another request is already rebuilding the safe DB-derived source. Do
    // not block the shell or issue a live daemon request; keep routes visible
    // until the snapshot arrives on the next lightweight refresh.
    this.coordinator.enqueue('ui-shell:nodes');
    return {
      data: [],
      revision: 0,
      observedAt: null,
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
      refreshStatus: 'refreshing',
      availability: 'unknown',
    };
  }

  private async refreshNodes(): Promise<void> {
    const leased = await this.snapshots.withLease(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, (lease) =>
      this.loadNodes(lease)
    );
    if (!leased.acquired) return;
  }

  private async getConfigSnapshot(): Promise<ResourceSnapshotEnvelope<GeneralSettings>> {
    const cached = await this.snapshots.get<GeneralSettings>(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID, (lease) =>
      this.loadConfig(lease)
    );
    if (refreshed.acquired) return refreshed.value;

    // A peer is already doing the safe database read. The request still needs
    // the feature contract before it renders navigation, so fall back only to
    // the safe database source rather than inventing a permissive default.
    return this.loadConfig();
  }

  private async refreshConfig(): Promise<void> {
    const leased = await this.snapshots.withLease(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID, (lease) =>
      this.loadConfig(lease)
    );
    if (!leased.acquired) return;
  }

  private async getStatusPageConfigSnapshot(): Promise<ResourceSnapshotEnvelope<StatusPageConfig>> {
    const cached = await this.snapshots.get<StatusPageConfig>(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, (lease) =>
      this.loadStatusPageConfig(lease)
    );
    if (refreshed.acquired) return refreshed.value;

    // The UI needs a stable navigation decision now. This remains a safe DB
    // read and never reaches a managed resource or node daemon.
    return this.loadStatusPageConfig();
  }

  private async refreshStatusPageConfig(): Promise<void> {
    const leased = await this.snapshots.withLease(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, (lease) =>
      this.loadStatusPageConfig(lease)
    );
    if (!leased.acquired) return;
  }

  private async getCloudflareIntegrationSnapshot(): Promise<ResourceSnapshotEnvelope<boolean>> {
    const cached = await this.snapshots.get<boolean>(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID);
    if (cached) return cached;

    const refreshed = await this.snapshots.withLease(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, (lease) =>
      this.loadCloudflareIntegration(lease)
    );
    if (refreshed.acquired) return refreshed.value;

    // This is a local persisted-settings lookup, never a request to Cloudflare.
    return this.loadCloudflareIntegration();
  }

  private async refreshCloudflareIntegration(): Promise<void> {
    const leased = await this.snapshots.withLease(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, (lease) =>
      this.loadCloudflareIntegration(lease)
    );
    if (!leased.acquired) return;
  }

  private async loadNodes(lease?: ResourceSnapshotLease | null): Promise<ResourceSnapshotEnvelope<ShellNode[]>> {
    await this.snapshots.markRefreshing(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, [], 'unknown', lease);
    try {
      const nodes: ShellNode[] = [];
      for (let page = 1; ; page += 1) {
        const response = await this.nodes.list({ page, limit: 1_000 });
        nodes.push(...response.data);
        if (page >= (response.totalPages ?? page)) break;
      }
      return await this.snapshots.replace(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, nodes, {
        availability: 'available',
        lease,
      });
    } catch (error) {
      return this.snapshots.markError(NODE_SNAPSHOT_KIND, NODE_SNAPSHOT_ID, [], error, 'unknown', lease);
    }
  }

  private async loadConfig(lease?: ResourceSnapshotLease | null): Promise<ResourceSnapshotEnvelope<GeneralSettings>> {
    await this.snapshots.markRefreshing(
      CONFIG_SNAPSHOT_KIND,
      CONFIG_SNAPSHOT_ID,
      DEFAULT_GENERAL_SETTINGS,
      'unknown',
      lease
    );
    try {
      const config = await this.settings.getConfig();
      return await this.snapshots.replace(CONFIG_SNAPSHOT_KIND, CONFIG_SNAPSHOT_ID, config, {
        availability: 'available',
        lease,
      });
    } catch (error) {
      return this.snapshots.markError(
        CONFIG_SNAPSHOT_KIND,
        CONFIG_SNAPSHOT_ID,
        DEFAULT_GENERAL_SETTINGS,
        error,
        'unknown',
        lease
      );
    }
  }

  private async loadStatusPageConfig(
    lease?: ResourceSnapshotLease | null
  ): Promise<ResourceSnapshotEnvelope<StatusPageConfig>> {
    const fallback = { enabled: false } as StatusPageConfig;
    await this.snapshots.markRefreshing(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, fallback, 'unknown', lease);
    try {
      const config = await this.statusPage.getConfig();
      return await this.snapshots.replace(STATUS_PAGE_SNAPSHOT_KIND, STATUS_PAGE_SNAPSHOT_ID, config, {
        availability: 'available',
        lease,
      });
    } catch (error) {
      return this.snapshots.markError(
        STATUS_PAGE_SNAPSHOT_KIND,
        STATUS_PAGE_SNAPSHOT_ID,
        fallback,
        error,
        'unknown',
        lease
      );
    }
  }

  private async loadCloudflareIntegration(
    lease?: ResourceSnapshotLease | null
  ): Promise<ResourceSnapshotEnvelope<boolean>> {
    await this.snapshots.markRefreshing(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, false, 'unknown', lease);
    try {
      const hasIntegration = await this.integrations.hasEnabledCloudflareConnector();
      return await this.snapshots.replace(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, hasIntegration, {
        availability: 'available',
        lease,
      });
    } catch (error) {
      return this.snapshots.markError(CLOUDFLARE_SNAPSHOT_KIND, CLOUDFLARE_SNAPSHOT_ID, false, error, 'unknown', lease);
    }
  }

  /** Only for callers without apps:view and apps:create (they get the section anyway); a failure hides it. */
  private async appsByMembers(scopes: string[]): Promise<boolean> {
    if (hasAppsSectionScope(scopes) || !container.isRegistered(AppsService)) return false;
    try {
      return await container.resolve(AppsService).hasAppsByMembers(scopes);
    } catch (error) {
      logger.warn('Failed to read apps visible through members', { error });
      return false;
    }
  }

  private visibleNodes(nodes: ShellNode[], scopes: string[]): ShellNode[] {
    if (hasScope(scopes, 'nodes:details') || hasScope(scopes, 'nodes:folders:manage')) return nodes;
    const allowed = new Set(getResourceScopedIds(scopes, 'nodes:details'));
    return allowed.size > 0 || hasScopeBase(scopes, 'nodes:details')
      ? nodes.filter((node) => allowed.has(String(node.id)))
      : [];
  }

  private visibleDockerNodes(nodes: ShellNode[], scopes: string[]): ShellNode[] {
    const broadDockerAccess = DOCKER_VIEW_SCOPES.some((scope) => hasScope(scopes, scope));
    const allowedNodeIds = new Set(dockerScopedNodeIds(scopes, DOCKER_VIEW_SCOPES));
    if (!broadDockerAccess && allowedNodeIds.size === 0) return [];
    return nodes.filter(
      (node) =>
        node.type === 'docker' &&
        node.status === 'online' &&
        node.isConnected &&
        !(node.capabilities as Record<string, unknown> | undefined)?.versionMismatch &&
        (broadDockerAccess || allowedNodeIds.has(String(node.id)))
    );
  }
}

import type { CommercialEditionRuntime } from '@/edition/runtime.js';
