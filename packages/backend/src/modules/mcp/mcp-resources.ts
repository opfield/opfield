import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { container } from '@/container.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { DOC_TOPIC_SCOPES, INTERNAL_DOCS } from '@/modules/ai/ai.docs.js';
import { LoggingEnvironmentService } from '@/modules/logging/logging-environment.service.js';
import { MonitoringService } from '@/modules/monitoring/monitoring.service.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { stripRawProxyConfigForProgrammatic } from '@/modules/proxy/raw-visibility.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';

type ResourceDefinition = {
  name: string;
  uri: string;
  title: string;
  description: string;
  requiredScopes: string[];
  read: (uri: URL, scopes: string[]) => Promise<unknown>;
};

function canAccess(scopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) return true;
  return requiredScopes.some((scope) => hasScopeBase(scopes, scope));
}

function dashboardStatsOptions(scopes: string[]) {
  return {
    allowedCaTypes: (hasScope(scopes, 'pki:ca:view') ? ['root', 'intermediate'] : []) as Array<'root' | 'intermediate'>,
    allowedProxyHostIds: hasScope(scopes, 'proxy:view') ? undefined : getResourceScopedIds(scopes, 'proxy:view'),
    allowedSslCertificateIds: hasScope(scopes, 'ssl:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'ssl:cert:view'),
    allowedPkiCertificateIds: hasScope(scopes, 'pki:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'pki:cert:view'),
    allowedNodeIds: hasScope(scopes, 'nodes:details') ? undefined : getResourceScopedIds(scopes, 'nodes:details'),
  };
}

function compactResource(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: 'application/json',
        text: JSON.stringify(data),
      },
    ],
  };
}

function take<T>(items: T[] | undefined, limit = 25): T[] {
  return (items ?? []).slice(0, limit);
}

function docUri(topic: string): string {
  return `opfield://docs/${encodeURIComponent(topic)}`;
}

function docRequiredScopes(topic: string): string[] {
  const requiredScope = DOC_TOPIC_SCOPES[topic];
  if (!requiredScope) return [];
  const scopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
  // Topics open to every MCP connection (read_opfield_documentation reads them with mcp:use) stay open here.
  if (scopes.includes('mcp:use')) return [];
  return scopes.filter((scope) => scope !== 'ai:workspace:use' && scope !== 'feat:ai:use');
}

function accessibleDocTopics(scopes: string[]) {
  return Object.keys(INTERNAL_DOCS)
    .sort()
    .filter((topic) => canAccess(scopes, docRequiredScopes(topic)))
    .map((topic) => ({
      topic,
      uri: docUri(topic),
      requiredScopes: docRequiredScopes(topic),
    }));
}

const operationalResources: ResourceDefinition[] = [
  {
    name: 'opfield-overview',
    uri: 'opfield://overview',
    title: 'Opfield overview',
    description: 'Dashboard-level counts filtered to the token scopes.',
    requiredScopes: ['proxy:view', 'ssl:cert:view', 'pki:cert:view', 'pki:ca:view', 'nodes:details'],
    async read(_uri, scopes) {
      const stats = await container.resolve(MonitoringService).getDashboardStats(dashboardStatsOptions(scopes));
      const filtered: Record<string, unknown> = { generatedAt: new Date().toISOString() };
      if (hasScopeBase(scopes, 'proxy:view')) filtered.proxyHosts = stats.proxyHosts;
      if (hasScopeBase(scopes, 'ssl:cert:view')) filtered.sslCertificates = stats.sslCertificates;
      if (hasScopeBase(scopes, 'pki:cert:view')) filtered.pkiCertificates = stats.pkiCertificates;
      if (hasScope(scopes, 'pki:ca:view')) filtered.cas = stats.cas;
      if (hasScopeBase(scopes, 'nodes:details')) filtered.nodes = stats.nodes;
      return filtered;
    },
  },
  {
    name: 'opfield-nodes',
    uri: 'opfield://nodes',
    title: 'Opfield nodes',
    description: 'Bounded list of Opfield nodes and connection state.',
    requiredScopes: ['nodes:details'],
    async read(_uri, scopes) {
      const result = await container
        .resolve(NodesService)
        .list(
          { page: 1, limit: 25 },
          hasScope(scopes, 'nodes:details') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'nodes:details') }
        );
      return {
        total: result.total,
        nodes: take(result.data).map((node) => ({
          id: node.id,
          hostname: node.hostname,
          displayName: node.displayName,
          appearanceColor: node.appearanceColor,
          type: node.type,
          status: node.status,
          isConnected: node.isConnected,
        })),
      };
    },
  },
  {
    name: 'opfield-proxy-hosts',
    uri: 'opfield://proxy/hosts',
    title: 'Ingress routes',
    description: 'Bounded list of ingress routes, node placement, targets, TLS, and health status.',
    requiredScopes: ['proxy:view'],
    async read(_uri, scopes) {
      const result = await container
        .resolve(ProxyService)
        .listProxyHosts(
          { page: 1, limit: 25 },
          hasScope(scopes, 'proxy:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'proxy:view') }
        );
      return {
        total: result.pagination.total,
        hosts: take(result.data).map((host) => {
          const safeHost = stripRawProxyConfigForProgrammatic(host as any);
          return {
            id: safeHost.id,
            domainNames: safeHost.domainNames,
            type: safeHost.type,
            enabled: safeHost.enabled,
            nodeId: safeHost.nodeId,
            forwardHost: safeHost.forwardHost,
            forwardPort: safeHost.forwardPort,
            sslEnabled: safeHost.sslEnabled,
            healthStatus: safeHost.healthStatus,
            effectiveHealthStatus: (safeHost as { effectiveHealthStatus?: string }).effectiveHealthStatus,
          };
        }),
      };
    },
  },
  {
    name: 'opfield-docker-nodes',
    uri: 'opfield://docker/nodes',
    title: 'Docker nodes',
    description: 'Bounded list of Docker-capable nodes.',
    requiredScopes: ['nodes:details'],
    async read(_uri, scopes) {
      const result = await container.resolve(NodesService).list(
        {
          type: 'docker',
          page: 1,
          limit: 25,
        },
        hasScope(scopes, 'nodes:details') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'nodes:details') }
      );
      return {
        total: result.total,
        nodes: take(result.data).map((node) => ({
          id: node.id,
          hostname: node.hostname,
          displayName: node.displayName,
          status: node.status,
          isConnected: node.isConnected,
        })),
      };
    },
  },
  {
    name: 'opfield-logging-environments',
    uri: 'opfield://logging/environments',
    title: 'Logging environments',
    description: 'Bounded list of external logging environments.',
    requiredScopes: ['logs:environments:view'],
    async read(_uri, scopes) {
      const environments = await container
        .resolve(LoggingEnvironmentService)
        .list(
          hasScope(scopes, 'logs:environments:view')
            ? undefined
            : { allowedIds: getResourceScopedIds(scopes, 'logs:environments:view') }
        );
      return {
        total: environments.length,
        environments: take(environments).map((environment) => ({
          id: environment.id,
          name: environment.name,
          slug: environment.slug,
          enabled: environment.enabled,
          schemaMode: environment.schemaMode,
          retentionDays: environment.retentionDays,
          rateLimitRequestsPerWindow: environment.rateLimitRequestsPerWindow,
          rateLimitEventsPerWindow: environment.rateLimitEventsPerWindow,
        })),
      };
    },
  },
  {
    name: 'opfield-status-page-summary',
    uri: 'opfield://status-page/summary',
    title: 'Status page summary',
    description: 'Status page config, exposed services, and active incidents.',
    requiredScopes: ['status-page:view'],
    async read() {
      const service = container.resolve(StatusPageService);
      const [config, services, incidents] = await Promise.all([
        service.getConfig(),
        service.listServices(),
        service.listIncidents({ status: 'active', limit: 10 }),
      ]);
      return {
        config: {
          enabled: config.enabled,
          domain: config.domain,
          nodeId: config.nodeId,
          proxyHostId: config.proxyHostId,
        },
        services: take(services, 25).map((entry) => ({
          id: entry.id,
          publicName: entry.publicName,
          publicGroup: entry.publicGroup,
          enabled: entry.enabled,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          currentStatus: entry.currentStatus,
          broken: entry.broken,
        })),
        activeIncidents: take(incidents, 10).map((incident) => ({
          id: incident.id,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          affectedServiceIds: incident.affectedServiceIds,
          startedAt: incident.startedAt,
        })),
      };
    },
  },
  {
    name: 'opfield-certificates-expiring',
    uri: 'opfield://certificates/expiring',
    title: 'Expiring certificates',
    description: 'SSL certificates expiring in the next 30 days.',
    requiredScopes: ['ssl:cert:view'],
    async read(_uri, scopes) {
      const certs = await container
        .resolve(SSLService)
        .getCertsExpiringSoon(
          30,
          hasScope(scopes, 'ssl:cert:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'ssl:cert:view') }
        );
      return {
        windowDays: 30,
        total: certs.length,
        certificates: take(certs).map((cert) => ({
          id: cert.id,
          name: cert.name,
          domainNames: cert.domainNames,
          type: cert.type,
          status: cert.status,
          autoRenew: cert.autoRenew,
          notAfter: cert.notAfter,
        })),
      };
    },
  },
];

const docsResources: ResourceDefinition[] = [
  {
    name: 'opfield-internal-docs',
    uri: 'opfield://docs',
    title: 'Opfield internal documentation',
    description: 'Index of internal documentation topics available to this MCP token.',
    requiredScopes: [],
    async read(_uri, scopes) {
      const topics = accessibleDocTopics(scopes);
      return {
        total: topics.length,
        topics,
      };
    },
  },
  ...Object.keys(INTERNAL_DOCS)
    .sort()
    .map(
      (topic): ResourceDefinition => ({
        name: `opfield-internal-docs-${topic}`,
        uri: docUri(topic),
        title: `Opfield internal documentation: ${topic}`,
        description: `Internal Opfield operator documentation for ${topic}.`,
        requiredScopes: docRequiredScopes(topic),
        async read() {
          return {
            topic,
            content: INTERNAL_DOCS[topic],
          };
        },
      })
    ),
];

const resources: ResourceDefinition[] = [...operationalResources, ...docsResources];

export function registerMcpResources(server: McpServer, scopes: string[]): void {
  for (const resource of resources) {
    if (!canAccess(scopes, resource.requiredScopes)) continue;
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: 'application/json',
      },
      async (uri) => compactResource(uri, await resource.read(uri, scopes))
    );
  }
}
