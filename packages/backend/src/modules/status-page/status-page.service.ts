import type { DrizzleClient } from '@/db/client.js';
import type { statusPageServices } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreateStatusPageIncidentInput,
  CreateStatusPageIncidentUpdateInput,
  CreateStatusPageServiceInput,
  StatusPageSettingsInput,
  UpdateStatusPageIncidentInput,
  UpdateStatusPageServiceInput,
} from './status-page.schemas.js';
import type { StatusPageSourceType } from './status-page-source-access.js';
export type StatusPageServiceStatus = 'operational' | 'degraded' | 'outage' | 'unknown' | 'maintenance';
export type StatusPageOverallStatus = 'operational' | 'degraded' | 'outage' | 'maintenance';
export interface StatusPageConfig {
  enabled: boolean;
  title: string;
  description: string;
  domain: string;
  nodeId: string | null;
  ingressGroupId: string | null;
  sslCertificateId: string | null;
  proxyTemplateId: string | null;
  upstreamUrl: string | null;
  proxyHostId: string | null;
  publicIncidentLimit: number;
  recentIncidentDays: number;
  autoDegradedEnabled: boolean;
  autoOutageEnabled: boolean;
  autoDegradedSeverity: 'info' | 'warning' | 'critical';
  autoOutageSeverity: 'info' | 'warning' | 'critical';
  autoCreateThresholdSeconds: number;
  autoResolveThresholdSeconds: number;
}
export interface PublicStatusPageDto {
  title: string;
  description: string;
  hideExternalBranding: boolean;
  generatedAt: string;
  overallStatus: StatusPageOverallStatus;
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    group: string | null;
    status: StatusPageServiceStatus;
    healthHistory: Array<{
      ts: string;
      status: StatusPageServiceStatus;
      slow?: boolean;
    }>;
  }>;
  incidents: Array<{
    id: string;
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    status: 'active' | 'resolved';
    type: 'automatic' | 'manual';
    startedAt: string;
    resolvedAt: string | null;
    affectedServiceIds: string[];
    updates: Array<{
      id: string;
      status: 'update' | 'investigating' | 'identified' | 'monitoring' | 'resolved';
      message: string;
      createdAt: string;
    }>;
  }>;
}
type StatusPageServiceRow = typeof statusPageServices.$inferSelect;
const DEFAULT_CONFIG: StatusPageConfig = {
  enabled: false,
  title: 'System Status',
  description: '',
  domain: '',
  nodeId: null,
  ingressGroupId: null,
  sslCertificateId: null,
  proxyTemplateId: null,
  upstreamUrl: null,
  proxyHostId: null,
  publicIncidentLimit: 25,
  recentIncidentDays: 14,
  autoDegradedEnabled: true,
  autoOutageEnabled: true,
  autoDegradedSeverity: 'warning',
  autoOutageSeverity: 'critical',
  autoCreateThresholdSeconds: 600,
  autoResolveThresholdSeconds: 60,
};

export class StatusPageService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _proxyService: ProxyService,
    _auditService: AuditService,
    _generalSettings?: GeneralSettingsService | undefined
  ) {}
  setEventBus(_bus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async getConfig(): Promise<StatusPageConfig> {
    return { ...DEFAULT_CONFIG };
  }
  async primePublicHost(): Promise<void> {}
  isCachedStatusHost(_hostHeader: string | undefined): boolean {
    return false;
  }
  async isStatusHost(_hostHeader: string | undefined): Promise<boolean> {
    return false;
  }
  async updateSettings(
    _input: StatusPageSettingsInput,
    _userId: string,
    _actorScopes?: string[]
  ): Promise<StatusPageConfig> {
    return commercialModuleUnavailable();
  }
  async listProxyTemplates(): Promise<
    {
      id: string;
      name: string;
    }[]
  > {
    return [];
  }
  async listServices(_actorScopes?: readonly string[]): Promise<
    {
      /** Present when listed with the caller scopes: whether the caller may edit this listing. */
      sourceVisible?: boolean;
      source: {
        label: string;
        status: StatusPageServiceStatus;
        rawStatus: string;
        history: Array<{
          ts?: string;
          status?: string;
          slow?: boolean;
        }>;
      } | null;
      currentStatus: StatusPageServiceStatus;
      broken: boolean;
      id: string;
      sourceType:
        | 'node'
        | 'proxy_host'
        | 'database'
        | 'docker_container'
        | 'docker_deployment'
        | 'docker_compose_project'
        | 'pages_project';
      sourceId: string;
      publicName: string;
      publicDescription: string | null;
      publicGroup: string | null;
      sortOrder: number;
      enabled: boolean;
      createThresholdSeconds: number;
      resolveThresholdSeconds: number;
      lastEvaluatedStatus: string;
      unhealthySince: Date | null;
      healthySince: Date | null;
      createdAt: Date;
      updatedAt: Date;
      createdById: string;
      updatedById: string | null;
    }[]
  > {
    return [];
  }
  async listSources(_scopes: readonly string[]): Promise<
    {
      sourceType: StatusPageSourceType;
      sourceId: string;
      name: string;
      nodeId: string | null;
      nodeName: string | null;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async assertSourceVisible(
    _scopes: readonly string[],
    _sourceType: StatusPageSourceType,
    _sourceId: string
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async createService(
    _input: CreateStatusPageServiceInput,
    _userId: string,
    _actorScopes?: readonly string[]
  ): Promise<{
    id: string;
    sourceType:
      | 'node'
      | 'proxy_host'
      | 'database'
      | 'docker_container'
      | 'docker_deployment'
      | 'docker_compose_project'
      | 'pages_project';
    sourceId: string;
    publicName: string;
    publicDescription: string | null;
    publicGroup: string | null;
    sortOrder: number;
    enabled: boolean;
    createThresholdSeconds: number;
    resolveThresholdSeconds: number;
    lastEvaluatedStatus: string;
    unhealthySince: Date | null;
    healthySince: Date | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    updatedById: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async updateService(
    _id: string,
    _input: UpdateStatusPageServiceInput,
    _userId: string,
    _actorScopes?: readonly string[]
  ): Promise<{
    id: string;
    sourceType:
      | 'node'
      | 'proxy_host'
      | 'database'
      | 'docker_container'
      | 'docker_deployment'
      | 'docker_compose_project'
      | 'pages_project';
    sourceId: string;
    publicName: string;
    publicDescription: string | null;
    publicGroup: string | null;
    sortOrder: number;
    enabled: boolean;
    createThresholdSeconds: number;
    resolveThresholdSeconds: number;
    lastEvaluatedStatus: string;
    unhealthySince: Date | null;
    healthySince: Date | null;
    createdById: string;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async reorderServices(
    _serviceIds: string[],
    _userId: string,
    _actorScopes: readonly string[]
  ): Promise<
    {
      source: {
        label: string;
        status: StatusPageServiceStatus;
        rawStatus: string;
        history: Array<{
          ts?: string;
          status?: string;
          slow?: boolean;
        }>;
      } | null;
      currentStatus: StatusPageServiceStatus;
      broken: boolean;
      id: string;
      sourceType:
        | 'node'
        | 'proxy_host'
        | 'database'
        | 'docker_container'
        | 'docker_deployment'
        | 'docker_compose_project'
        | 'pages_project';
      sourceId: string;
      publicName: string;
      publicDescription: string | null;
      publicGroup: string | null;
      sortOrder: number;
      enabled: boolean;
      createThresholdSeconds: number;
      resolveThresholdSeconds: number;
      lastEvaluatedStatus: string;
      unhealthySince: Date | null;
      healthySince: Date | null;
      createdAt: Date;
      updatedAt: Date;
      createdById: string;
      updatedById: string | null;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async deleteService(_id: string, _userId: string, _actorScopes: readonly string[]): Promise<void> {
    return commercialModuleUnavailable();
  }
  async listIncidents(_query: { status?: 'active' | 'resolved' | 'all'; limit?: number; offset?: number }): Promise<
    ({
      id: string;
      createdAt: Date;
      updatedAt: Date;
      createdById: string | null;
      updatedById: string | null;
      title: string;
      status: 'active' | 'resolved';
      startedAt: Date;
      resolvedAt: Date | null;
      type: 'automatic' | 'manual';
      message: string;
      severity: 'info' | 'warning' | 'critical';
      autoManaged: boolean;
      affectedServiceIds: string[];
      resolvedById: string | null;
    } & {
      updates: {
        id: string;
        createdAt: Date;
        createdById: string | null;
        status: 'resolved' | 'update' | 'investigating' | 'identified' | 'monitoring';
        message: string;
        incidentId: string;
      }[];
    })[]
  > {
    return [];
  }
  async createManualIncident(
    _input: CreateStatusPageIncidentInput,
    _userId: string
  ): Promise<{
    updates: {
      id: string;
      createdAt: Date;
      createdById: string | null;
      status: 'resolved' | 'update' | 'investigating' | 'identified' | 'monitoring';
      message: string;
      incidentId: string;
    }[];
    id: string;
    createdAt: Date;
    updatedAt: Date;
    createdById: string | null;
    updatedById: string | null;
    title: string;
    status: 'active' | 'resolved';
    startedAt: Date;
    resolvedAt: Date | null;
    type: 'automatic' | 'manual';
    message: string;
    severity: 'info' | 'warning' | 'critical';
    autoManaged: boolean;
    affectedServiceIds: string[];
    resolvedById: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async updateIncident(
    _id: string,
    _input: UpdateStatusPageIncidentInput,
    _userId: string
  ): Promise<{
    updates: {
      id: string;
      createdAt: Date;
      createdById: string | null;
      status: 'resolved' | 'update' | 'investigating' | 'identified' | 'monitoring';
      message: string;
      incidentId: string;
    }[];
    id: string;
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    status: 'active' | 'resolved';
    type: 'automatic' | 'manual';
    autoManaged: boolean;
    affectedServiceIds: string[];
    startedAt: Date;
    resolvedAt: Date | null;
    createdById: string | null;
    updatedById: string | null;
    resolvedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteIncident(_id: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async resolveIncident(
    _id: string,
    _userId: string
  ): Promise<{
    updates: {
      id: string;
      createdAt: Date;
      createdById: string | null;
      status: 'resolved' | 'update' | 'investigating' | 'identified' | 'monitoring';
      message: string;
      incidentId: string;
    }[];
    id: string;
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    status: 'active' | 'resolved';
    type: 'automatic' | 'manual';
    autoManaged: boolean;
    affectedServiceIds: string[];
    startedAt: Date;
    resolvedAt: Date | null;
    createdById: string | null;
    updatedById: string | null;
    resolvedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async promoteIncident(
    _id: string,
    _userId: string
  ): Promise<{
    updates: {
      id: string;
      createdAt: Date;
      createdById: string | null;
      status: 'resolved' | 'update' | 'investigating' | 'identified' | 'monitoring';
      message: string;
      incidentId: string;
    }[];
    id: string;
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    status: 'active' | 'resolved';
    type: 'automatic' | 'manual';
    autoManaged: boolean;
    affectedServiceIds: string[];
    startedAt: Date;
    resolvedAt: Date | null;
    createdById: string | null;
    updatedById: string | null;
    resolvedById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async createIncidentUpdate(
    _id: string,
    _input: CreateStatusPageIncidentUpdateInput,
    _userId: string
  ): Promise<{
    id: string;
    createdAt: Date;
    createdById: string | null;
    status: 'resolved' | 'update' | 'investigating' | 'identified' | 'monitoring';
    message: string;
    incidentId: string;
  }> {
    return commercialModuleUnavailable();
  }
  async getPublicDto(): Promise<PublicStatusPageDto | null> {
    return null;
  }
  async freezePublicSnapshot(): Promise<void> {}
  async getPreviewDto(): Promise<PublicStatusPageDto> {
    return commercialModuleUnavailable();
  }
  async resolveSources(_rows: StatusPageServiceRow[]): Promise<
    Map<
      string,
      {
        label: string;
        status: StatusPageServiceStatus;
        rawStatus: string;
        history: Array<{
          ts?: string;
          status?: string;
          slow?: boolean;
        }>;
      }
    >
  > {
    return new Map();
  }
  async createAutomaticIncident(_service: StatusPageServiceRow, _status: StatusPageServiceStatus): Promise<void> {
    return commercialModuleUnavailable();
  }
  async autoResolveIncident(_serviceId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
