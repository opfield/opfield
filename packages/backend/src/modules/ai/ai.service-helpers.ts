import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import { stripRawProxyConfigForProgrammatic } from '@/modules/proxy/raw-visibility.js';
import type { AIToolDefinition } from './ai.types.js';
import { getAIToolResourceId } from './ai-tool-policy-metadata.js';
import { hasAIToolCallScope } from './ai-tool-scope-policy.js';

const PROXY_HOST_UPDATE_FIELDS = [
  'type',
  'nodeId',
  'domainNames',
  'upstreamKind',
  'forwardHost',
  'forwardPort',
  'forwardScheme',
  'upstreamIpv6Enabled',
  'dockerNodeId',
  'dockerContainerName',
  'dockerDeploymentId',
  'dockerContainerPort',
  'pageProjectId',
  'pageTagId',
  'relaySpreadMode',
  'relaySpreadCount',
  'sslEnabled',
  'sslForced',
  'http2Support',
  'websocketSupport',
  'sslCertificateId',
  'internalCertificateId',
  'redirectUrl',
  'redirectStatusCode',
  'customHeaders',
  'cacheEnabled',
  'cacheOptions',
  'rateLimitEnabled',
  'rateLimitMode',
  'rateLimitOptions',
  'customRewrites',
  'accessListId',
  'folderId',
  'nginxTemplateId',
  'templateVariables',
  'healthCheckEnabled',
  'healthCheckUrl',
  'healthCheckInterval',
  'healthCheckExpectedStatus',
  'healthCheckExpectedBody',
  'healthCheckBodyMatchMode',
  'healthCheckSlowThreshold',
  'enabled',
] as const;

/** CA view is one CA-scopable scope for root and intermediate CAs. */
function caViewScope(caId?: string): string {
  return caId ? `pki:ca:view:${caId}` : 'pki:ca:view';
}

function caTypeRevokeScope(type: string): 'pki:ca:revoke:root' | 'pki:ca:revoke:intermediate' {
  return type === 'root' ? 'pki:ca:revoke:root' : 'pki:ca:revoke:intermediate';
}

function dashboardStatsOptionsForScopes(scopes: string[]) {
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

function allowedResourceIdsForScopes(scopes: string[], baseScope: string): string[] | undefined {
  return hasScope(scopes, baseScope) ? undefined : getResourceScopedIds(scopes, baseScope);
}

/**
 * Resource ids a list tool returns, like the REST list routes: undefined for broad access (implied scopes
 * included), otherwise the concrete ids of resource-scoped grants. Folder and node targets never reach an id
 * column: the authentication layer already expanded them to the resources they currently contain.
 */
function directResourceIdsForScopes(scopes: string[], baseScope: string): string[] | undefined {
  if (hasScope(scopes, baseScope)) return undefined;
  return getResourceScopedIds(scopes, baseScope).filter((id) => !id.includes('/'));
}

const SENSITIVE_TOOL_ARG_RE =
  /(?:password|passwd|passphrase|secret|signingsecret|privatekey|private_key|token|authorization|cookie|apikey|api_key|clientsecret|client_secret|refresh|contentbase64|connectionstring|connection_string|connectionuri|connection_uri)/i;
/** URL-valued arguments (url, baseUrl, repositoryUrl...) keep their shape; only embedded credentials go. */
const URL_TOOL_ARG_RE = /(?:url|uri)$/i;
const SENSITIVE_URL_QUERY_RE = /^(?:key|code|sig|auth|pass|pwd)$|signature|credential|access_?key/i;

function redactUrlCredentials(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const hasUserinfo = Boolean(url.username || url.password);
  const sensitiveParams = [...new Set(url.searchParams.keys())].filter(
    (name) => SENSITIVE_TOOL_ARG_RE.test(name) || SENSITIVE_URL_QUERY_RE.test(name)
  );
  if (!hasUserinfo && sensitiveParams.length === 0) return value;
  if (hasUserinfo) {
    url.username = 'REDACTED';
    url.password = '';
  }
  for (const name of sensitiveParams) url.searchParams.set(name, 'REDACTED');
  return url.toString();
}

function redactToolArgs(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';

  if (Array.isArray(value)) {
    return value.map((item) => redactToolArgs(item, depth + 1));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_TOOL_ARG_RE.test(key)
      ? '[REDACTED]'
      : URL_TOOL_ARG_RE.test(key) && typeof nested === 'string'
        ? redactUrlCredentials(nested)
        : redactToolArgs(nested, depth + 1);
  }
  return redacted;
}

function getToolResourceId(
  tool: Pick<AIToolDefinition, 'targetIdentity'> | undefined,
  args: Record<string, unknown>
): string {
  return getAIToolResourceId(tool, args);
}

function getToolAuthorizationResourceId(
  tool: Pick<AIToolDefinition, 'targetIdentity'> | string | undefined,
  args: Record<string, unknown>
): string {
  return getToolResourceId(typeof tool === 'string' ? undefined : tool, args);
}

function isMutatingTool(toolDef: { destructive: boolean; invalidateStores: string[] }): boolean {
  return toolDef.destructive || toolDef.invalidateStores.length > 0;
}

/** Per-call scope gate shared with the MCP server (see hasAIToolCallScope). */
function hasToolExecutionScope(
  scopes: string[],
  toolName: string,
  requiredScope: string | undefined,
  args: Record<string, unknown>,
  tool?: Pick<AIToolDefinition, 'targetIdentity' | 'requiredScopes'>
): boolean {
  if (!requiredScope) return false;
  return hasAIToolCallScope(
    scopes,
    { name: toolName, requiredScope, requiredScopes: tool?.requiredScopes, targetIdentity: tool?.targetIdentity },
    args
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: Record<string, unknown>[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') total += estimateTokens(msg.content);
    const toolCalls = msg.tool_calls as Array<{ function?: { arguments?: string } }> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        total += estimateTokens(tc.function?.arguments || '');
        total += 20;
      }
    }
    total += 4;
  }
  return total;
}

function compactProxyHostForAgent(host: Record<string, any>) {
  const safeHost = stripRawProxyConfigForProgrammatic(host);
  const managedTarget = {
    ...(safeHost.upstreamKind !== undefined ? { upstreamKind: safeHost.upstreamKind } : {}),
    ...(safeHost.dockerNodeId !== undefined ? { dockerNodeId: safeHost.dockerNodeId } : {}),
    ...(safeHost.dockerNodeSlug !== undefined ? { dockerNodeSlug: safeHost.dockerNodeSlug } : {}),
    ...(safeHost.dockerContainerName !== undefined ? { dockerContainerName: safeHost.dockerContainerName } : {}),
    ...(safeHost.dockerDeploymentId !== undefined ? { dockerDeploymentId: safeHost.dockerDeploymentId } : {}),
    ...(safeHost.dockerDeploymentName !== undefined ? { dockerDeploymentName: safeHost.dockerDeploymentName } : {}),
    ...(safeHost.dockerContainerPort !== undefined ? { dockerContainerPort: safeHost.dockerContainerPort } : {}),
    ...(safeHost.dockerHostPort !== undefined ? { dockerHostPort: safeHost.dockerHostPort } : {}),
    ...(safeHost.dockerProtocol !== undefined ? { dockerProtocol: safeHost.dockerProtocol } : {}),
    ...(safeHost.secureLinkActive !== undefined ? { secureLinkActive: safeHost.secureLinkActive } : {}),
    ...(safeHost.additionalSecureLinkCount !== undefined
      ? { additionalSecureLinkCount: safeHost.additionalSecureLinkCount }
      : {}),
    ...(safeHost.pageTarget
      ? {
          pageTarget: {
            projectId: safeHost.pageTarget.projectId,
            projectName: safeHost.pageTarget.projectName,
            projectSlug: safeHost.pageTarget.projectSlug,
            tagId: safeHost.pageTarget.tagId,
            tagName: safeHost.pageTarget.tagName,
            deploymentId: safeHost.pageTarget.deploymentId,
            status: safeHost.pageTarget.status,
            generation: safeHost.pageTarget.generation,
            lastErrorCode: safeHost.pageTarget.lastErrorCode,
          },
        }
      : {}),
    ...(safeHost.relaySpreadMode !== undefined ? { relaySpreadMode: safeHost.relaySpreadMode } : {}),
    ...(safeHost.relaySpreadCount !== undefined ? { relaySpreadCount: safeHost.relaySpreadCount } : {}),
    ...(safeHost.rateLimitMode !== undefined ? { rateLimitMode: safeHost.rateLimitMode } : {}),
    ...(safeHost.maintenanceEnabled !== undefined ? { maintenanceEnabled: safeHost.maintenanceEnabled } : {}),
    ...(safeHost.maintenanceStartedAt !== undefined ? { maintenanceStartedAt: safeHost.maintenanceStartedAt } : {}),
    ...(safeHost.appMaintenanceMode !== undefined && safeHost.appMaintenanceMode !== 'off'
      ? { appMaintenanceMode: safeHost.appMaintenanceMode }
      : {}),
    ...(safeHost.app !== undefined ? { app: safeHost.app } : {}),
  };
  return {
    id: safeHost.id,
    slug: safeHost.slug,
    type: safeHost.type,
    domainNames: safeHost.domainNames,
    enabled: safeHost.enabled,
    nodeId: safeHost.nodeId,
    ...(safeHost.ingressGroupId ? { ingressGroupId: safeHost.ingressGroupId } : {}),
    ...(safeHost.ingressGroup ? { ingressGroup: safeHost.ingressGroup } : {}),
    ...(Array.isArray(safeHost.servingNodeIds) && safeHost.ingressGroupId
      ? { servingNodeIds: safeHost.servingNodeIds }
      : {}),
    ...(Array.isArray(safeHost.ingressDelivery) && safeHost.ingressDelivery.length > 0
      ? { ingressDelivery: safeHost.ingressDelivery }
      : {}),
    ...managedTarget,
    forwardScheme: safeHost.forwardScheme,
    forwardHost: safeHost.forwardHost,
    forwardPort: safeHost.forwardPort,
    upstreamIpv6Enabled: safeHost.upstreamIpv6Enabled,
    sslEnabled: safeHost.sslEnabled,
    sslForced: safeHost.sslForced,
    sslCertificateId: safeHost.sslCertificateId,
    accessListId: safeHost.accessListId,
    healthCheckEnabled: safeHost.healthCheckEnabled,
    healthStatus: safeHost.healthStatus,
    effectiveHealthStatus: safeHost.effectiveHealthStatus,
    lastHealthCheckAt: safeHost.lastHealthCheckAt,
    createdAt: safeHost.createdAt,
    updatedAt: safeHost.updatedAt,
  };
}

function compactDockerContainerForAgent(container: Record<string, any>) {
  const name = ((container.name ?? container.Name ?? '') as string).replace(/^\//, '');
  const ports = container.ports ?? container.Ports;
  return {
    id: container.id ?? container.Id,
    name,
    image: container.image ?? container.Image,
    state: container.state ?? container.State,
    status: container.status ?? container.Status,
    created: container.created ?? container.Created,
    ports: Array.isArray(ports) ? ports.slice(0, 64) : ports,
    portsCount: Array.isArray(ports) ? ports.length : undefined,
    portsTruncated: Array.isArray(ports) && ports.length > 64,
    listeningPorts: Array.isArray(container.listeningPorts) ? container.listeningPorts : null,
    kind: container.kind ?? 'container',
    deploymentId: container.deploymentId,
    activeSlot: container.activeSlot,
    healthCheckId: container.healthCheckId,
    healthCheckEnabled: container.healthCheckEnabled,
    healthStatus: container.healthStatus,
    lastHealthCheckAt: container.lastHealthCheckAt,
    folderId: container.folderId,
    folderIsSystem: container.folderIsSystem,
    folderSortOrder: container.folderSortOrder,
    _transition: container._transition,
  };
}

function compactDockerDeploymentForAgent(deployment: Record<string, any>) {
  const healthCheck = deployment.healthCheck;
  const primaryRoute = Array.isArray(deployment.routes)
    ? (deployment.routes.find((route: any) => route.isPrimary) ?? deployment.routes[0])
    : undefined;
  return {
    id: deployment.id,
    nodeId: deployment.nodeId,
    name: deployment.name,
    status: deployment.status,
    activeSlot: deployment.activeSlot,
    desiredImage: deployment.desiredConfig?.image,
    primaryRoute: primaryRoute
      ? {
          hostPort: primaryRoute.hostPort,
          containerPort: primaryRoute.containerPort,
          host: primaryRoute.host,
          path: primaryRoute.path,
        }
      : null,
    slots: Array.isArray(deployment.slots)
      ? deployment.slots.map((slot: any) => ({
          slot: slot.slot,
          status: slot.status,
          image: slot.image,
          containerId: slot.containerId,
        }))
      : [],
    healthCheck: healthCheck
      ? {
          id: healthCheck.id,
          enabled: healthCheck.enabled,
          healthStatus: healthCheck.healthStatus,
          lastHealthCheckAt: healthCheck.lastHealthCheckAt,
        }
      : null,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    _transition: deployment._transition,
  };
}

const AGENT_LIST_RESULT_MAX = 1000;
const AGENT_PAGE_LIMIT_MAX = 100;
const AGENT_PAGE_MAX = 1000;
const AGENT_IMAGE_REF_PREVIEW_MAX = 20;
const AGENT_VOLUME_USED_BY_PREVIEW_MAX = 100;

function agentPageLimit(value: unknown, fallback = 50) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 1), AGENT_PAGE_LIMIT_MAX);
}

function agentPage(value: unknown, fallback = 1) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 1), AGENT_PAGE_MAX);
}

function compactAgentList<T>(items: T[]) {
  const truncated = items.length > AGENT_LIST_RESULT_MAX;
  return {
    data: truncated ? items.slice(0, AGENT_LIST_RESULT_MAX) : items,
    total: items.length,
    limit: AGENT_LIST_RESULT_MAX,
    truncated,
  };
}

function compactDockerImageForAgent(image: Record<string, any>) {
  const repoTags = image.repoTags ?? image.RepoTags;
  const repoDigests = image.repoDigests ?? image.RepoDigests;
  return {
    id: image.id ?? image.Id,
    parentId: image.parentId ?? image.ParentId,
    repoTags: Array.isArray(repoTags) ? repoTags.slice(0, AGENT_IMAGE_REF_PREVIEW_MAX) : repoTags,
    repoTagsCount: Array.isArray(repoTags) ? repoTags.length : undefined,
    repoTagsTruncated: Array.isArray(repoTags) && repoTags.length > AGENT_IMAGE_REF_PREVIEW_MAX,
    repoDigests: Array.isArray(repoDigests) ? repoDigests.slice(0, AGENT_IMAGE_REF_PREVIEW_MAX) : repoDigests,
    repoDigestsCount: Array.isArray(repoDigests) ? repoDigests.length : undefined,
    repoDigestsTruncated: Array.isArray(repoDigests) && repoDigests.length > AGENT_IMAGE_REF_PREVIEW_MAX,
    created: image.created ?? image.Created,
    size: image.size ?? image.Size,
    virtualSize: image.virtualSize ?? image.VirtualSize,
    sharedSize: image.sharedSize ?? image.SharedSize,
    containers: image.containers ?? image.Containers,
  };
}

function hasRegistryHost(imageRef: string) {
  const firstSegment = imageRef.split('/')[0] ?? '';
  return firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':');
}

function compactDockerVolumeForAgent(volume: Record<string, any>) {
  const usedBy = volume.usedBy ?? volume.UsedBy;
  return {
    name: volume.name ?? volume.Name,
    driver: volume.driver ?? volume.Driver,
    mountpoint: volume.mountpoint ?? volume.Mountpoint,
    scope: volume.scope ?? volume.Scope,
    createdAt: volume.createdAt ?? volume.CreatedAt,
    usedBy: Array.isArray(usedBy) ? usedBy.slice(0, AGENT_VOLUME_USED_BY_PREVIEW_MAX) : usedBy,
    usedByCount: Array.isArray(usedBy) ? usedBy.length : undefined,
    usedByTruncated: Array.isArray(usedBy) && usedBy.length > AGENT_VOLUME_USED_BY_PREVIEW_MAX,
  };
}

function compactDockerNetworkForAgent(network: Record<string, any>) {
  const containers = network.containers ?? network.Containers;
  return {
    id: network.id ?? network.Id,
    name: network.name ?? network.Name,
    driver: network.driver ?? network.Driver,
    scope: network.scope ?? network.Scope,
    created: network.created ?? network.Created,
    internal: network.internal ?? network.Internal,
    attachable: network.attachable ?? network.Attachable,
    ingress: network.ingress ?? network.Ingress,
    containersCount: containers && typeof containers === 'object' ? Object.keys(containers).length : undefined,
  };
}

function textMatchesSearch(values: unknown[], search: unknown) {
  if (typeof search !== 'string' || search.trim() === '') return true;
  const query = search.trim().toLowerCase();
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function dockerContainerMatchesSearch(container: Record<string, any>, search: unknown) {
  const ports = container.ports ?? container.Ports;
  const portText = Array.isArray(ports)
    ? ports.map((port: any) => [port.ip, port.publicPort, port.privatePort, port.type].join(' '))
    : [];
  return textMatchesSearch(
    [
      container.id ?? container.Id,
      container.name ?? container.Name,
      container.image ?? container.Image,
      container.state ?? container.State,
      container.status ?? container.Status,
      container.kind,
      container.deploymentId,
      portText,
    ],
    search
  );
}

function dockerDeploymentMatchesSearch(deployment: Record<string, any>, search: unknown) {
  const routes = Array.isArray(deployment.routes) ? deployment.routes : [];
  const routeText = routes.map((route: any) =>
    [route.host, route.path, route.hostPort, route.containerPort].filter(Boolean).join(' ')
  );
  return textMatchesSearch(
    [
      deployment.id,
      deployment.nodeId,
      deployment.name,
      deployment.status,
      deployment.activeSlot,
      deployment.desiredConfig?.image,
      routeText,
    ],
    search
  );
}

function dockerImageMatchesSearch(image: Record<string, any>, search: unknown) {
  return textMatchesSearch(
    [
      image.id ?? image.Id,
      image.parentId ?? image.ParentId,
      image.repoTags ?? image.RepoTags,
      image.repoDigests ?? image.RepoDigests,
    ],
    search
  );
}

function dockerVolumeMatchesSearch(volume: Record<string, any>, search: unknown) {
  return textMatchesSearch(
    [
      volume.name ?? volume.Name,
      volume.driver ?? volume.Driver,
      volume.mountpoint ?? volume.Mountpoint,
      volume.scope ?? volume.Scope,
      volume.usedBy ?? volume.UsedBy,
    ],
    search
  );
}

function dockerNetworkMatchesSearch(network: Record<string, any>, search: unknown) {
  return textMatchesSearch(
    [
      network.id ?? network.Id,
      network.name ?? network.Name,
      network.driver ?? network.Driver,
      network.scope ?? network.Scope,
    ],
    search
  );
}

export const aiServiceTestHelpers = {
  agentPage,
  agentPageLimit,
  compactAgentList,
  dockerContainerMatchesSearch,
  getToolAuthorizationResourceId,
  hasRegistryHost,
  redactToolArgs,
};

export {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  caTypeRevokeScope,
  caViewScope,
  compactAgentList,
  compactDockerContainerForAgent,
  compactDockerDeploymentForAgent,
  compactDockerImageForAgent,
  compactDockerNetworkForAgent,
  compactDockerVolumeForAgent,
  compactProxyHostForAgent,
  dashboardStatsOptionsForScopes,
  directResourceIdsForScopes,
  dockerContainerMatchesSearch,
  dockerDeploymentMatchesSearch,
  dockerImageMatchesSearch,
  dockerNetworkMatchesSearch,
  dockerVolumeMatchesSearch,
  estimateMessagesTokens,
  estimateTokens,
  getToolResourceId,
  hasRegistryHost,
  hasToolExecutionScope,
  isMutatingTool,
  PROXY_HOST_UPDATE_FIELDS,
  redactToolArgs,
  textMatchesSearch,
};
