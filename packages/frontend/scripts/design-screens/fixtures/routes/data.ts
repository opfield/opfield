/**
 * Routes (proxy hosts) of the fictional Northwind installation: the nine
 * catalog routes with their upstreams, TLS, folders and the option lists the
 * route pages load (certificates, access lists, templates, Docker targets).
 * Seeds 21000-21999 belong to this group.
 */
import type {
  AccessList,
  DockerContainer,
  DomainSearchResult,
  FolderTreeNode,
  NginxTemplate,
  ProxyAdditionalRoute,
  ProxyAdditionalSecureLink,
  ProxyHost,
  SSLCertificate,
} from "@/types";
import { pageProjects, people, routes } from "../catalog";
import { edgeNode, nodeBySlug, nodes } from "../nodes";
import { ago, ahead, uuid } from "../time";

type CatalogSlug = (typeof routes)[number]["slug"];

const route = (slug: CatalogSlug) => routes.find((item) => item.slug === slug)!;
const node = (slug: string) => nodeBySlug(slug)!;

const edgeFra = edgeNode;
const edgeAms = node("edge-ams-1");
const apps1 = node("apps-1");
const apps2 = node("apps-2");

// ── Folders ─────────────────────────────────────────────────────────────

export const folderIds = {
  production: uuid(21001),
  internal: uuid(21002),
} as const;

// ── Certificates ────────────────────────────────────────────────────────

function certificate(
  seed: number,
  overrides: Partial<SSLCertificate> & Pick<SSLCertificate, "name" | "domainNames">
): SSLCertificate {
  return {
    id: uuid(21100 + seed),
    type: "acme",
    acmeProvider: "letsencrypt",
    acmeChallengeType: "http-01",
    acmePendingOperation: null,
    acmePendingChallenges: null,
    internalCertId: null,
    notBefore: ago(34, "d"),
    notAfter: ahead(56, "d"),
    autoRenew: true,
    autoRenewProvider: null,
    autoRenewDnsBindings: null,
    autoRenewDisabledReason: null,
    autoRenewDisabledAt: null,
    lastRenewedAt: ago(34, "d"),
    renewalError: null,
    status: "active",
    distribution: {
      status: "ready",
      replicaCount: 1,
      readyReplicaCount: 1,
      lastVerifiedAt: ago(4, "m"),
      error: null,
    },
    isSystem: false,
    folderId: null,
    sortOrder: seed,
    createdAt: ago(180, "d"),
    updatedAt: ago(34, "d"),
    ...overrides,
  };
}

export const certificates: SSLCertificate[] = [
  certificate(1, { name: "app.example.com", domainNames: ["app.example.com"] }),
  certificate(2, {
    name: "api.example.com",
    domainNames: ["api.example.com"],
    notBefore: ago(3, "h"),
    notAfter: ahead(90, "d"),
    lastRenewedAt: ago(3, "h"),
  }),
  certificate(3, {
    name: "*.example.com",
    domainNames: ["*.example.com", "example.com"],
    acmeChallengeType: "dns-01",
    autoRenewProvider: "cloudflare",
    notBefore: ago(21, "d"),
    notAfter: ahead(69, "d"),
    lastRenewedAt: ago(21, "d"),
  }),
  certificate(4, {
    name: "grafana.example.com",
    domainNames: ["grafana.example.com"],
    notBefore: ago(81, "d"),
    notAfter: ahead(9, "d"),
    lastRenewedAt: ago(81, "d"),
  }),
  certificate(5, {
    name: "docs.example.org",
    domainNames: ["docs.example.org", "www.docs.example.org"],
  }),
  certificate(6, { name: "shop.example.net", domainNames: ["shop.example.net"] }),
  certificate(7, {
    name: "Northwind services (internal)",
    type: "internal",
    domainNames: ["auth.example.com", "status.example.com"],
    acmeProvider: null,
    acmeChallengeType: null,
    autoRenew: true,
    internalCertId: uuid(21150),
    notBefore: ago(40, "d"),
    notAfter: ahead(325, "d"),
    lastRenewedAt: ago(40, "d"),
  }),
  certificate(8, {
    name: "legacy-admin (uploaded)",
    type: "upload",
    domainNames: ["legacy-admin.example.com"],
    acmeProvider: null,
    acmeChallengeType: null,
    autoRenew: false,
    notBefore: ago(300, "d"),
    notAfter: ahead(65, "d"),
    lastRenewedAt: null,
  }),
];

const cert = (name: string) => certificates.find((item) => item.name === name)!;

// ── Access lists ────────────────────────────────────────────────────────

const OPEN_LIST = {
  signInMethods: [],
  users: [],
  sharedPasswordSet: false,
  skipIpRanges: [],
  includeRules: [],
  requireRules: [],
  excludeRules: [],
  sessionTtlSeconds: null,
} satisfies Partial<AccessList>;

export const accessLists: AccessList[] = [
  {
    ...OPEN_LIST,
    id: uuid(21201),
    name: "Office VPN",
    description: "Headquarters and VPN egress ranges",
    skipIpRanges: ["198.51.100.0/24", "203.0.113.64/27"],
    createdAt: ago(200, "d"),
    updatedAt: ago(12, "d"),
    usageCount: 2,
  },
  {
    ...OPEN_LIST,
    id: uuid(21202),
    name: "Staff basic auth",
    description: "Shared login for internal tools",
    signInMethods: ["basic"],
    users: [{ username: "ops" }, { username: "support" }],
    includeRules: [{ selector: "everyone", values: [] }],
    createdAt: ago(160, "d"),
    updatedAt: ago(40, "d"),
    usageCount: 0,
  },
  {
    ...OPEN_LIST,
    id: uuid(21203),
    name: "Partner API allowlist",
    description: "Payment and logistics partners",
    skipIpRanges: ["192.0.2.0/25"],
    createdAt: ago(90, "d"),
    updatedAt: ago(90, "d"),
    usageCount: 0,
  },
];

// ── Nginx templates ─────────────────────────────────────────────────────

const PROXY_TEMPLATE_VARIABLES: NginxTemplate["variables"] = [
  { name: "cacheEnabled", type: "boolean", default: false, description: "Cache upstream responses" },
  { name: "cacheMaxAge", type: "number", default: 3600, description: "Cache lifetime in seconds" },
  {
    name: "rateLimitMode",
    type: "string",
    default: "inherit",
    description: "Use the Opfield default, a custom policy, or disable protection",
  },
  {
    name: "rateLimitRPS",
    type: "number",
    default: 1000,
    description: "Requests allowed per second for each client IP",
  },
  {
    name: "rateLimitBurst",
    type: "number",
    default: 3000,
    description: "Additional request burst allowed for each client IP",
  },
  {
    name: "connectionsPerIp",
    type: "number",
    default: 1000,
    description: "Concurrent connections allowed for each client IP",
  },
];

const ADDITIONAL_ROUTES_HOLE =
  "{{{renderAdditionalRoutes additionalRoutes id accessList rateLimitEnabled rateLimitBurst connectionsPerIp}}}";

export const nginxTemplates: NginxTemplate[] = [
  {
    id: uuid(21301),
    name: "Default Proxy",
    description:
      "Standard reverse proxy with SSL, caching, rate limiting, WebSocket, and access control support.",
    isBuiltin: true,
    type: "proxy",
    content: `server {\n  listen 443 ssl;\n  server_name {{serverNames}};\n  ${ADDITIONAL_ROUTES_HOLE}\n}`,
    variables: PROXY_TEMPLATE_VARIABLES,
    createdAt: ago(300, "d"),
    updatedAt: ago(300, "d"),
  },
  {
    id: uuid(21302),
    name: "Default Redirect",
    description: "HTTP redirect with optional SSL termination.",
    isBuiltin: true,
    type: "redirect",
    content: "server {\n  return {{redirectStatusCode}} {{redirectUrl}};\n}",
    variables: [],
    createdAt: ago(300, "d"),
    updatedAt: ago(300, "d"),
  },
  {
    id: uuid(21303),
    name: "Default 404",
    description: "Returns 404 for all requests. Use to block domains.",
    isBuiltin: true,
    type: "404",
    content: "server {\n  return 404;\n}",
    variables: [],
    createdAt: ago(300, "d"),
    updatedAt: ago(300, "d"),
  },
  {
    id: uuid(21304),
    name: "Hardened proxy (HSTS + CSP)",
    description: "Default proxy plus strict transport and content security headers.",
    isBuiltin: false,
    type: "proxy",
    content: `server {\n  add_header Strict-Transport-Security "max-age=63072000" always;\n  ${ADDITIONAL_ROUTES_HOLE}\n}`,
    variables: PROXY_TEMPLATE_VARIABLES,
    createdAt: ago(120, "d"),
    updatedAt: ago(15, "d"),
  },
  {
    id: uuid(21305),
    name: "Long-poll API",
    description: "Raised read timeouts and disabled buffering for streaming endpoints.",
    isBuiltin: false,
    type: "proxy",
    content: `server {\n  proxy_read_timeout 300s;\n  proxy_buffering off;\n  ${ADDITIONAL_ROUTES_HOLE}\n}`,
    variables: PROXY_TEMPLATE_VARIABLES,
    createdAt: ago(75, "d"),
    updatedAt: ago(75, "d"),
  },
];

// ── Health history ──────────────────────────────────────────────────────

type HealthSample = NonNullable<ProxyHost["healthHistory"]>[number];

/** One probe every 5 minutes over the last 16 hours, newest last. */
function healthSamples(
  seed: number,
  pick: (minutesAgo: number) => Pick<HealthSample, "status"> & Partial<HealthSample>
): HealthSample[] {
  const samples: HealthSample[] = [];
  for (let minutesAgo = 16 * 60; minutesAgo >= 1; minutesAgo -= 5) {
    const jitter = ((minutesAgo * 31 + seed * 17) % 23) - 11;
    samples.push({
      ts: ago(minutesAgo, "m"),
      responseMs: 38 + seed * 6 + jitter,
      slow: false,
      ...pick(minutesAgo),
    });
  }
  return samples;
}

const healthyHistory = (seed: number) =>
  healthSamples(seed, (minutesAgo) =>
    // One slow probe during the overnight deploy window.
    minutesAgo === 7 * 60 + 5 ? { status: "online", slow: true, responseMs: 410 } : { status: "online" }
  );

export const healthHistories: Record<string, HealthSample[]> = {
  app: healthyHistory(1),
  api: healthyHistory(2),
  auth: healthyHistory(3),
  status: healthyHistory(4),
  grafana: healthSamples(5, (minutesAgo) =>
    minutesAgo < 50
      ? { status: "degraded", slow: true, responseMs: 1_840 - minutesAgo * 3 }
      : { status: "online" }
  ),
  docs: healthyHistory(6),
  shop: healthyHistory(7),
  "legacy-admin": healthSamples(8, (minutesAgo) =>
    minutesAgo < 150 ? { status: "offline", responseMs: undefined } : { status: "online" }
  ),
};

// ── Routes ──────────────────────────────────────────────────────────────

function proxyHost(
  slug: CatalogSlug,
  overrides: Partial<ProxyHost> & Pick<ProxyHost, "nodeId" | "folderId" | "sortOrder">
): ProxyHost {
  const entry = route(slug);
  const history = healthHistories[slug];
  return {
    id: entry.id,
    slug: entry.slug,
    type: "proxy",
    domainNames: [...entry.domains],
    enabled: entry.enabled,
    maintenanceEnabled: false,
    maintenanceStartedAt: null,
    upstreamKind: "manual",
    forwardHost: null,
    forwardPort: null,
    forwardScheme: "http",
    upstreamIpv6Enabled: false,
    dockerNodeId: null,
    dockerNodeSlug: null,
    dockerContainerName: null,
    dockerComposeProjectId: null,
    dockerComposeServiceName: null,
    dockerDeploymentId: null,
    dockerDeploymentName: null,
    dockerNodeAppearanceColor: null,
    dockerContainerPort: null,
    dockerHostPort: null,
    dockerProtocol: null,
    relaySpreadMode: "inherit",
    relaySpreadCount: null,
    pageTarget: null,
    secureLinkActive: false,
    sslEnabled: true,
    sslForced: true,
    http2Support: true,
    sslCertificateId: null,
    internalCertificateId: null,
    websocketSupport: false,
    redirectUrl: null,
    redirectStatusCode: 301,
    customHeaders: [],
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitMode: "inherit",
    rateLimitOptions: null,
    customRewrites: [],
    advancedConfig: null,
    rawConfig: null,
    rawConfigEnabled: false,
    accessListId: null,
    nginxTemplateId: null,
    templateVariables: {},
    healthCheckEnabled: true,
    healthCheckUrl: "/",
    healthCheckInterval: 30,
    healthCheckExpectedStatus: null,
    healthCheckExpectedBody: null,
    healthCheckBodyMatchMode: "includes",
    healthCheckSlowThreshold: 3,
    healthStatus: entry.health,
    effectiveHealthStatus: entry.health,
    lastHealthCheckAt: ago(18, "s"),
    healthHistory: history,
    isSystem: false,
    systemKind: null,
    createdById: people[0].id,
    createdAt: ago(190, "d"),
    updatedAt: ago(6, "d"),
    tlsDistribution: {
      status: "ready",
      replicaCount: 1,
      readyReplicaCount: 1,
      lastVerifiedAt: ago(4, "m"),
      error: null,
    },
    ...overrides,
  };
}

const docsPortal = pageProjects.find((project) => project.slug === "docs-portal")!;

export const proxyHosts: ProxyHost[] = [
  proxyHost("app", {
    nodeId: edgeFra.id,
    folderId: folderIds.production,
    sortOrder: 0,
    upstreamKind: "docker_container",
    dockerNodeId: apps1.id,
    dockerNodeSlug: apps1.slug,
    dockerContainerName: "web",
    dockerNodeAppearanceColor: apps1.appearanceColor,
    dockerContainerPort: 3000,
    dockerHostPort: 31_000,
    dockerProtocol: "tcp",
    secureLinkActive: true,
    sslCertificateId: cert("app.example.com").id,
    sslCertificate: cert("app.example.com"),
    websocketSupport: true,
    customHeaders: [
      { name: "X-Frame-Options", value: "SAMEORIGIN" },
      { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { name: "Permissions-Policy", value: "camera=(), microphone=()" },
    ],
    customRewrites: [
      { source: "/login", destination: "https://auth.example.com/login", type: "temporary" },
      { source: "/pricing", destination: "https://shop.example.net/plans", type: "permanent" },
    ],
    rateLimitEnabled: true,
    rateLimitMode: "custom",
    rateLimitOptions: { requestsPerSecond: 200, burst: 400, connectionsPerIp: 100 },
    cacheOptions: { maxAge: 3600 },
    templateVariables: {
      cacheEnabled: false,
      cacheMaxAge: 3600,
      rateLimitMode: "custom",
      rateLimitRPS: 200,
      rateLimitBurst: 400,
      connectionsPerIp: 100,
    },
    healthCheckUrl: "/healthz",
    healthCheckExpectedStatus: 200,
    healthCheckExpectedBody: "ok",
    healthCheckBodyMatchMode: "includes",
    updatedAt: ago(52, "m"),
  }),
  proxyHost("api", {
    nodeId: edgeFra.id,
    folderId: folderIds.production,
    sortOrder: 1,
    upstreamKind: "docker_deployment",
    dockerNodeId: apps1.id,
    dockerNodeSlug: apps1.slug,
    dockerDeploymentId: uuid(21401),
    dockerDeploymentName: "api",
    dockerNodeAppearanceColor: apps1.appearanceColor,
    dockerContainerPort: 8080,
    dockerProtocol: "tcp",
    secureLinkActive: true,
    sslCertificateId: cert("api.example.com").id,
    healthCheckUrl: "/v1/health",
    healthCheckExpectedStatus: 200,
    rateLimitEnabled: true,
    rateLimitMode: "custom",
    rateLimitOptions: { requestsPerSecond: 500, burst: 1000, connectionsPerIp: 200 },
    accessListId: null,
  }),
  proxyHost("auth", {
    nodeId: edgeFra.id,
    folderId: folderIds.production,
    sortOrder: 2,
    forwardScheme: "https",
    forwardHost: "192.0.2.31",
    forwardPort: 9443,
    sslCertificateId: cert("Northwind services (internal)").id,
    healthCheckUrl: "/.well-known/openid-configuration",
  }),
  proxyHost("shop", {
    nodeId: edgeAms.id,
    folderId: folderIds.production,
    sortOrder: 3,
    forwardHost: "198.51.100.40",
    forwardPort: 8080,
    sslCertificateId: cert("shop.example.net").id,
    cacheEnabled: true,
    cacheOptions: { maxAge: 600 },
    healthCheckUrl: "/status",
  }),
  proxyHost("status", {
    nodeId: edgeFra.id,
    folderId: folderIds.production,
    sortOrder: 4,
    forwardHost: "192.0.2.40",
    forwardPort: 3001,
    sslCertificateId: cert("Northwind services (internal)").id,
  }),
  proxyHost("grafana", {
    nodeId: edgeFra.id,
    folderId: folderIds.internal,
    sortOrder: 0,
    upstreamKind: "docker_container",
    dockerNodeId: apps2.id,
    dockerNodeSlug: apps2.slug,
    dockerContainerName: "grafana",
    dockerNodeAppearanceColor: apps2.appearanceColor,
    dockerContainerPort: 3000,
    dockerProtocol: "tcp",
    secureLinkActive: true,
    sslCertificateId: cert("grafana.example.com").id,
    websocketSupport: true,
    accessListId: accessLists[0].id,
    healthCheckUrl: "/api/health",
  }),
  proxyHost("legacy-admin", {
    nodeId: edgeFra.id,
    folderId: folderIds.internal,
    sortOrder: 1,
    forwardHost: "192.0.2.77",
    forwardPort: 8081,
    sslEnabled: false,
    sslForced: false,
    http2Support: false,
    tlsDistribution: null,
    accessListId: accessLists[0].id,
    healthCheckUrl: "/login",
    lastHealthCheckAt: ago(22, "s"),
    updatedAt: ago(41, "d"),
  }),
  proxyHost("docs", {
    nodeId: edgeAms.id,
    folderId: null,
    sortOrder: 0,
    upstreamKind: "pages",
    pageTarget: {
      projectId: docsPortal.id,
      projectName: docsPortal.name,
      projectSlug: docsPortal.slug,
      projectAppearanceColor: "pink",
      tagId: uuid(21501),
      tagName: "production",
      deploymentId: uuid(21502),
      status: "ready",
      generation: 14,
      lastErrorCode: null,
    },
    sslCertificateId: cert("docs.example.org").id,
    healthCheckUrl: "/",
  }),
  proxyHost("staging-app", {
    nodeId: edgeFra.id,
    folderId: null,
    sortOrder: 1,
    type: "redirect",
    upstreamKind: undefined,
    redirectUrl: "https://app.example.com",
    redirectStatusCode: 302,
    sslEnabled: true,
    sslCertificateId: cert("*.example.com").id,
    healthCheckEnabled: false,
    healthStatus: "unknown",
    effectiveHealthStatus: "disabled",
    lastHealthCheckAt: null,
    healthHistory: [],
    tlsDistribution: null,
    updatedAt: ago(19, "d"),
  }),
];

export const proxyHostById = (id: string) => proxyHosts.find((host) => host.id === id);
export const proxyHostBySlug = (slug: string) => proxyHosts.find((host) => host.slug === slug);
export const appRoute = proxyHostBySlug("app")!;

function folder(id: string, name: string, sortOrder: number): FolderTreeNode {
  return {
    id,
    name,
    parentId: null,
    sortOrder,
    depth: 0,
    createdAt: ago(200, "d"),
    updatedAt: ago(200, "d"),
    children: [],
    hosts: proxyHosts.filter((host) => host.folderId === id),
  };
}

export const folderTree: FolderTreeNode[] = [
  folder(folderIds.production, "Production", 0),
  folder(folderIds.internal, "Internal", 1),
];

// ── Docker targets (Secure Link candidates) ─────────────────────────────

function container(
  overrides: Partial<DockerContainer> & Pick<DockerContainer, "id" | "name" | "image" | "nodeId">
): DockerContainer {
  return {
    state: "running",
    status: "Up 6 days (healthy)",
    created: Math.floor(Date.parse(ago(6, "d")) / 1000),
    ports: [],
    kind: "container",
    availability: "available",
    labels: {},
    ...overrides,
  };
}

/** `/api/docker/containers` rows, before the client adds node metadata. */
export const dockerSnapshotRows: DockerContainer[] = [
  container({
    id: "c0ffee01a1b2",
    name: "web",
    image: "registry.example.com/northwind/web:2.8.1",
    nodeId: apps1.id,
    ports: [{ privatePort: 3000, publicPort: 0, type: "tcp" }],
  }),
  container({
    id: uuid(21401),
    name: "api",
    image: "registry.example.com/northwind/api:2.8.1",
    nodeId: apps1.id,
    kind: "deployment",
    deploymentId: uuid(21401),
    activeSlot: "green",
    status: "Up 14 minutes (healthy)",
    ports: [{ privatePort: 8080, publicPort: 0, type: "tcp" }],
  }),
  container({
    id: "c0ffee03a1b2",
    name: "worker",
    image: "registry.example.com/northwind/worker:2.8.1",
    nodeId: apps1.id,
    ports: [
      { privatePort: 8081, publicPort: 0, type: "tcp" },
      { privatePort: 9464, publicPort: 0, type: "tcp" },
    ],
  }),
  container({
    id: "c0ffee04a1b2",
    name: "grafana",
    image: "grafana/grafana:11.2.0",
    nodeId: apps2.id,
    ports: [{ privatePort: 3000, publicPort: 0, type: "tcp" }],
  }),
  container({
    id: "c0ffee05a1b2",
    name: "redis-cache",
    image: "redis:7.4-alpine",
    nodeId: apps2.id,
    ports: [{ privatePort: 6379, publicPort: 0, type: "tcp" }],
  }),
];

export const dockerSnapshotNodes = nodes
  .filter((item) => item.type === "docker")
  .map((item) => ({
    id: item.id,
    slug: item.slug,
    hostname: item.hostname,
    displayName: item.displayName ?? undefined,
    appearanceColor: item.appearanceColor,
  }));

// ── App route: additional routes and Secure Link bindings ───────────────

function additionalRoute(
  seed: number,
  overrides: Partial<ProxyAdditionalRoute> &
    Pick<ProxyAdditionalRoute, "path" | "targetKind">
): ProxyAdditionalRoute {
  return {
    id: uuid(21600 + seed),
    proxyHostId: appRoute.id,
    enabled: true,
    forwardHost: null,
    forwardPort: null,
    forwardScheme: "http",
    dockerNodeId: null,
    dockerNodeName: null,
    dockerContainerName: null,
    dockerComposeProjectId: null,
    dockerComposeServiceName: null,
    dockerDeploymentId: null,
    dockerDeploymentName: null,
    dockerContainerPort: null,
    dockerHostPort: null,
    dockerProtocol: null,
    secureLinkId: null,
    pageProjectId: null,
    pageProjectName: null,
    pageProjectSlug: null,
    pageProjectAppearanceColor: null,
    pageTagId: null,
    pageTagName: null,
    activeDeploymentId: null,
    advancedConfig: null,
    stripPrefix: false,
    websocketSupport: false,
    requestBuffering: true,
    responseBuffering: true,
    connectTimeoutSeconds: 5,
    readTimeoutSeconds: 60,
    sendTimeoutSeconds: 60,
    status: "ready",
    lastError: null,
    generation: 3,
    createdAt: ago(60, "d"),
    updatedAt: ago(8, "d"),
    ...overrides,
  };
}

export const appAdditionalRoutes: ProxyAdditionalRoute[] = [
  additionalRoute(1, {
    path: "/api/",
    targetKind: "docker_deployment",
    dockerNodeId: apps1.id,
    dockerNodeName: apps1.displayName,
    dockerDeploymentId: uuid(21401),
    dockerDeploymentName: "api",
    dockerContainerPort: 8080,
    dockerProtocol: "tcp",
    secureLinkId: uuid(21701),
  }),
  additionalRoute(2, {
    path: "/realtime/",
    targetKind: "docker_container",
    dockerNodeId: apps1.id,
    dockerNodeName: apps1.displayName,
    dockerContainerName: "worker",
    dockerContainerPort: 8081,
    dockerProtocol: "tcp",
    secureLinkId: uuid(21702),
    stripPrefix: true,
    websocketSupport: true,
    responseBuffering: false,
    readTimeoutSeconds: 300,
  }),
  additionalRoute(3, {
    path: "/help/",
    targetKind: "pages",
    pageProjectId: docsPortal.id,
    pageProjectName: docsPortal.name,
    pageProjectSlug: docsPortal.slug,
    pageProjectAppearanceColor: "pink",
    pageTagId: uuid(21501),
    pageTagName: "production",
    activeDeploymentId: uuid(21502),
    stripPrefix: true,
  }),
  additionalRoute(4, {
    path: "/legacy/",
    targetKind: "manual",
    forwardHost: "192.0.2.77",
    forwardPort: 8081,
    enabled: false,
    status: "disabled",
    updatedAt: ago(41, "d"),
  }),
];

function secureLink(
  seed: number,
  overrides: Partial<ProxyAdditionalSecureLink> &
    Pick<ProxyAdditionalSecureLink, "name" | "purpose" | "targetContainer" | "dockerContainerPort">
): ProxyAdditionalSecureLink {
  return {
    id: uuid(21700 + seed),
    proxyHostId: appRoute.id,
    referenceId: null,
    managedRoutePath: null,
    upstreamKind: "docker_container",
    managedStorageId: null,
    forwardScheme: "http",
    sourceNodeId: edgeFra.id,
    dockerNodeId: apps1.id,
    dockerContainerName: null,
    dockerComposeProjectId: null,
    dockerComposeServiceName: null,
    dockerDeploymentId: null,
    dockerHostPort: 31_000 + seed,
    generation: 2,
    status: "active",
    lastError: null,
    listenerPort: 42_100 + seed,
    connectorPort: 43_100 + seed,
    createdAt: ago(60, "d"),
    updatedAt: ago(8, "d"),
    ...overrides,
  };
}

export const appSecureLinks: ProxyAdditionalSecureLink[] = [
  secureLink(1, {
    name: "route_api",
    purpose: "additional_route",
    referenceId: uuid(21601),
    managedRoutePath: "/api/",
    upstreamKind: "docker_deployment",
    dockerDeploymentId: uuid(21401),
    targetContainer: "api",
    dockerContainerPort: 8080,
  }),
  secureLink(2, {
    name: "route_realtime",
    purpose: "additional_route",
    referenceId: uuid(21602),
    managedRoutePath: "/realtime/",
    dockerContainerName: "worker",
    targetContainer: "worker",
    dockerContainerPort: 8081,
  }),
  secureLink(3, {
    name: "metrics",
    purpose: "user_managed",
    dockerContainerName: "worker",
    targetContainer: "worker",
    dockerContainerPort: 9464,
  }),
];

// ── Registered domains (create dialog suggestions) ──────────────────────

export const registeredDomains: DomainSearchResult[] = [
  { id: uuid(21801), domain: "beta.example.com", dnsStatus: "valid", dnsProvider: "cloudflare", nginxNodeId: edgeFra.id },
  { id: uuid(21802), domain: "billing.example.com", dnsStatus: "valid", dnsProvider: "cloudflare", nginxNodeId: edgeFra.id },
  { id: uuid(21803), domain: "metrics.example.com", dnsStatus: "pending", dnsProvider: "cloudflare", nginxNodeId: edgeFra.id },
  { id: uuid(21804), domain: "cdn.example.net", dnsStatus: "valid", dnsProvider: "legacy", nginxNodeId: edgeAms.id },
  { id: uuid(21805), domain: "partners.example.org", dnsStatus: "valid", dnsProvider: "legacy", nginxNodeId: edgeAms.id },
];
