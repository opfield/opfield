import type { AppMembershipRef } from "./apps";
import type { NodeAppearanceColor } from "./nodes";
import type { CertificateDistributionState, SSLCertificate } from "./ssl";

// Proxy Host Types
export type ProxyHostType = "proxy" | "redirect" | "404" | "raw";
export type ForwardScheme = "http" | "https";
export type ProxyUpstreamKind = "manual" | "docker_container" | "docker_deployment" | "pages";
export type HealthStatus = "online" | "offline" | "degraded" | "unknown" | "disabled";

export interface CustomHeader {
  name: string;
  value: string;
}

export interface CacheOptions {
  maxAge?: number;
  staleWhileRevalidate?: number;
}

export interface RateLimitOptions {
  requestsPerSecond: number;
  burst?: number;
  connectionsPerIp?: number;
}

export type RateLimitMode = "inherit" | "custom" | "disabled";
export type ClientIpSource = "auto" | "direct" | "cloudflare" | "reverse_proxy";

export interface ClientIpOptions {
  trustedProxyCidrs: string[];
  header: "x_forwarded_for" | "x_real_ip";
}

export interface RewriteRule {
  source: string;
  destination: string;
  type: "permanent" | "temporary";
}

export interface ProxyHost {
  /** Set when the resource is a member of an app environment. */
  app?: AppMembershipRef | null;
  id: string;
  slug: string;
  type: ProxyHostType;
  domainNames: string[];
  enabled: boolean;
  maintenanceEnabled: boolean;
  maintenanceStartedAt: string | null;
  nodeId?: string | null;
  /** Set when the route is served by every member of an ingress group (nodeId is then its first active member). */
  ingressGroupId?: string | null;
  servingNodeIds?: import("./ingress-groups").RouteIngressPlacementView["servingNodeIds"];
  ingressGroup?: import("./ingress-groups").RouteIngressPlacementView["ingressGroup"];
  ingressDelivery?: import("./ingress-groups").RouteIngressPlacementView["ingressDelivery"];
  upstreamKind?: ProxyUpstreamKind;
  forwardHost: string | null;
  forwardPort: number | null;
  forwardScheme: ForwardScheme;
  upstreamIpv6Enabled?: boolean;
  dockerNodeId?: string | null;
  dockerNodeSlug?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerDeploymentName?: string | null;
  dockerNodeAppearanceColor?: NodeAppearanceColor | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: "tcp" | null;
  relaySpreadMode?: "inherit" | "fixed" | "all";
  relaySpreadCount?: number | null;
  pageTarget?: {
    projectId: string;
    projectName: string;
    projectSlug: string;
    projectAppearanceColor: NodeAppearanceColor | null;
    tagId: string;
    tagName: string;
    deploymentId: string | null;
    status: string;
    generation: number;
    lastErrorCode: string | null;
  } | null;
  secureLinkActive?: boolean;
  /** Secure Links besides the primary one: user-managed links and the links of additional routes. */
  additionalSecureLinkCount?: number;
  sslEnabled: boolean;
  sslForced: boolean;
  http2Support: boolean;
  sslCertificateId: string | null;
  internalCertificateId: string | null;
  websocketSupport: boolean;
  redirectUrl: string | null;
  redirectStatusCode: number;
  customHeaders: CustomHeader[];
  cacheEnabled: boolean;
  cacheOptions: CacheOptions | null;
  rateLimitEnabled: boolean;
  rateLimitMode?: RateLimitMode;
  rateLimitOptions: RateLimitOptions | null;
  clientIpSource?: ClientIpSource;
  clientIpOptions?: ClientIpOptions | null;
  /** What clientIpSource resolves to now (route detail only). */
  clientIpEffectiveSource?: Exclude<ClientIpSource, "auto">;
  customRewrites: RewriteRule[];
  advancedConfig: string | null;
  rawConfig: string | null;
  rawConfigEnabled: boolean;
  accessListId: string | null;
  folderId: string | null;
  sortOrder: number;
  nginxTemplateId: string | null;
  templateVariables: Record<string, string | number | boolean>;
  healthCheckEnabled: boolean;
  healthCheckUrl: string;
  healthCheckInterval: number;
  healthCheckExpectedStatus: number | null;
  healthCheckExpectedBody: string | null;
  healthCheckBodyMatchMode: "includes" | "exact" | "starts_with" | "ends_with";
  healthCheckSlowThreshold: number | null;
  healthStatus: HealthStatus;
  effectiveHealthStatus?: string;
  lastHealthCheckAt: string | null;
  healthHistory?: Array<{ ts: string; status: string; responseMs?: number; slow?: boolean }>;
  isSystem?: boolean;
  systemKind?: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  // Relations (populated in detail views)
  sslCertificate?: SSLCertificate;
  tlsDistribution?: CertificateDistributionState | null;
  accessList?: AccessList;
}

export interface ProxySecureLinkStatus {
  /** False for a route whose primary target has no Secure Link (Pages, a manual address): the primary fields are null. */
  hasPrimary: boolean;
  state: string | null;
  generation: number | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  transport: string | null;
  migratedAt: string | null;
  lastError: string | null;
  telemetrySampledAt?: string | null;
  telemetryStale?: boolean;
  healthCheck: {
    enabled: boolean;
    intervalSeconds: number;
  } | null;
  sourceNode: { id: string; name: string; status: string } | null;
  targetNode: { id: string; name: string; status: string } | null;
  rateLimit: {
    mode: RateLimitMode;
    enabled: boolean;
    requestsPerSecond: number;
    burst: number;
    connectionsPerIp: number;
  } | null;
  runtime: {
    routeId: string;
    activeStreams: number;
    openedTotal: string;
    completedTotal: string;
    failedTotal: string;
    throttledTotal: string;
    sourceToTargetBytes: string;
    targetToSourceBytes: string;
    setupLatencyP95Ms: number;
    averageDurationMs: number;
    lastActivityAt: string | null;
    metricsSince: string;
    /** False when a relay that holds the route did not answer: its relay counters are unknown. */
    relayCountersComplete?: boolean;
  } | null;
  traffic: {
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
  } | null;
  history: Array<{
    timestamp: string;
    runtime: ProxySecureLinkStatus["runtime"];
    traffic: ProxySecureLinkStatus["traffic"];
  }>;
  additionalLinks?: ProxyAdditionalSecureLinkRuntime[];
}

export interface ProxyAdditionalSecureLinkRuntime {
  id: string;
  name: string;
  purpose: "user_managed" | "additional_route";
  referenceId: string | null;
  /** The additional route path for a route-owned link, the link name otherwise. */
  label: string;
  status: ProxyAdditionalSecureLinkStatus;
  generation: number;
  targetContainer: string;
  forwardScheme: ForwardScheme;
  lastError: string | null;
  runtime: ProxySecureLinkStatus["runtime"];
  history: Array<{
    timestamp: string;
    runtime: ProxySecureLinkStatus["runtime"];
  }>;
}

export type ProxyAdditionalSecureLinkStatus =
  | "provisioning"
  | "active"
  | "failed"
  | "cleanup_pending";

export interface ProxyAdditionalSecureLink {
  id: string;
  proxyHostId: string;
  name: string;
  purpose: "user_managed" | "additional_route";
  referenceId: string | null;
  managedRoutePath?: string | null;
  upstreamKind: "docker_container" | "docker_deployment" | "managed_storage";
  managedStorageId?: string | null;
  forwardScheme: ForwardScheme;
  sourceNodeId: string;
  dockerNodeId: string;
  dockerContainerName: string | null;
  dockerComposeProjectId: string | null;
  dockerComposeServiceName: string | null;
  dockerDeploymentId: string | null;
  dockerContainerPort: number;
  dockerHostPort: number;
  targetContainer: string;
  generation: number;
  status: ProxyAdditionalSecureLinkStatus;
  lastError: string | null;
  listenerPort: number | null;
  connectorPort: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProxyAdditionalSecureLinkRequest {
  name: string;
  upstreamKind: "docker_container" | "docker_deployment" | "managed_storage";
  managedStorageId?: string | null;
  forwardScheme: ForwardScheme;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number;
}

export type ProxyAdditionalRouteTargetKind =
  | "manual"
  | "docker_container"
  | "docker_deployment"
  | "pages";

export type ProxyAdditionalRouteStatus =
  | "pending"
  | "provisioning"
  | "staging"
  | "ready"
  | "failed"
  | "capability_missing"
  | "disabled"
  | "cleanup_pending";

export interface ProxyAdditionalRoute {
  id: string;
  proxyHostId: string;
  path: string;
  enabled: boolean;
  targetKind: ProxyAdditionalRouteTargetKind;
  forwardHost: string | null;
  forwardPort: number | null;
  forwardScheme: ForwardScheme;
  dockerNodeId: string | null;
  dockerNodeName?: string | null;
  dockerContainerName: string | null;
  dockerComposeProjectId: string | null;
  dockerComposeServiceName: string | null;
  dockerDeploymentId: string | null;
  dockerDeploymentName?: string | null;
  dockerContainerPort: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: "tcp" | null;
  secureLinkId?: string | null;
  pageProjectId: string | null;
  pageProjectName?: string | null;
  pageProjectSlug?: string | null;
  pageProjectAppearanceColor?: NodeAppearanceColor | null;
  pageTagId: string | null;
  pageTagName?: string | null;
  activeDeploymentId?: string | null;
  includePath?: string | null;
  runtimeConfigPath?: string | null;
  runtimeConfigGeneration?: number;
  advancedConfig?: string | null;
  stripPrefix: boolean;
  websocketSupport: boolean;
  requestBuffering: boolean;
  responseBuffering: boolean;
  connectTimeoutSeconds: number;
  readTimeoutSeconds: number;
  sendTimeoutSeconds: number;
  status: ProxyAdditionalRouteStatus;
  lastError: string | null;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProxyAdditionalRouteRequest {
  path: string;
  enabled?: boolean;
  targetKind: ProxyAdditionalRouteTargetKind;
  forwardHost?: string | null;
  forwardPort?: number | null;
  forwardScheme?: ForwardScheme;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number | null;
  pageProjectId?: string | null;
  pageTagId?: string | null;
  advancedConfig?: string | null;
  stripPrefix?: boolean;
  websocketSupport?: boolean;
  requestBuffering?: boolean;
  responseBuffering?: boolean;
  connectTimeoutSeconds?: number;
  readTimeoutSeconds?: number;
  sendTimeoutSeconds?: number;
}

export type UpdateProxyAdditionalRouteRequest = Partial<CreateProxyAdditionalRouteRequest>;

// Access List Types
export interface IPRule {
  type: "allow" | "deny";
  value: string;
}

export interface BasicAuthUser {
  username: string;
}

export interface AccessList {
  id: string;
  name: string;
  description: string | null;
  ipRules: IPRule[];
  basicAuthEnabled: boolean;
  basicAuthUsers: BasicAuthUser[];
  createdAt: string;
  updatedAt: string;
  usageCount?: number;
}

// Request types (Opfield)
/** A hostname of a route about to be created that no registered domain covers. */
export interface MissingRouteDomain {
  hostname: string;
  /** create: a Cloudflare domain is created in zoneName with the route; unavailable: reason says why not. */
  status: "create" | "unavailable";
  zoneName: string | null;
  code: string | null;
  reason: string | null;
}

export interface MissingRouteDomainsRequest {
  domainNames: string[];
  folderId?: string;
  nodeId?: string;
  ingressGroupId?: string;
}

export interface CreateProxyHostRequest {
  type: ProxyHostType;
  /** Create a Cloudflare domain for each hostname no registered domain covers (default false). */
  createMissingDomains?: boolean;
  /** Omitted: the ingress node of the registered domains, or the only node the caller may use. */
  nodeId?: string;
  /** Serve the route from every member of this ingress group instead of one node. */
  ingressGroupId?: string | null;
  domainNames: string[];
  upstreamKind?: ProxyUpstreamKind;
  forwardHost?: string;
  forwardPort?: number;
  forwardScheme?: ForwardScheme;
  upstreamIpv6Enabled?: boolean;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: "tcp" | null;
  pageProjectId?: string | null;
  pageTagId?: string | null;
  relaySpreadMode?: "inherit" | "fixed" | "all";
  relaySpreadCount?: number | null;
  sslEnabled?: boolean;
  sslForced?: boolean;
  http2Support?: boolean;
  sslCertificateId?: string | null;
  internalCertificateId?: string | null;
  websocketSupport?: boolean;
  redirectUrl?: string;
  redirectStatusCode?: number;
  customHeaders?: CustomHeader[];
  cacheEnabled?: boolean;
  cacheOptions?: CacheOptions;
  rateLimitEnabled?: boolean;
  rateLimitMode?: RateLimitMode;
  rateLimitOptions?: RateLimitOptions;
  clientIpSource?: ClientIpSource;
  clientIpOptions?: ClientIpOptions | null;
  customRewrites?: RewriteRule[];
  advancedConfig?: string | null;
  rawConfig?: string;
  rawConfigEnabled?: boolean;
  accessListId?: string | null;
  folderId?: string | null;
  nginxTemplateId?: string | null;
  templateVariables?: Record<string, string | number | boolean>;
  healthCheckEnabled?: boolean;
  healthCheckUrl?: string;
  healthCheckInterval?: number;
  healthCheckExpectedStatus?: number | null;
  healthCheckExpectedBody?: string | null;
  healthCheckBodyMatchMode?: "includes" | "exact" | "starts_with" | "ends_with" | null;
  healthCheckSlowThreshold?: number | null;
}

// Proxy Host Folder Types
export interface ProxyHostFolder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

export interface FolderTreeNode extends ProxyHostFolder {
  children: FolderTreeNode[];
  hosts: ProxyHost[];
}

export interface GroupedProxyHostsResponse {
  folders: FolderTreeNode[];
  ungroupedHosts: ProxyHost[];
  totalHosts: number;
}

// Nginx Config Template Types
export interface TemplateVariableDef {
  name: string;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  description?: string;
}

export interface NginxTemplate {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  type: ProxyHostType;
  content: string;
  variables: TemplateVariableDef[];
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccessListRequest {
  name: string;
  description?: string;
  ipRules: IPRule[];
  basicAuthEnabled?: boolean;
  basicAuthUsers?: { username: string; password: string }[];
}
