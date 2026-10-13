const RESOURCE_PROJECTIONS: Record<string, string[]> = {
  "access-lists": ["access-lists:list"],
  // Placing members changes every normal list (members leave or rejoin them).
  apps: [
    "apps:",
    "proxy:grouped",
    "req:/api/proxy-hosts",
    "req:/api/proxy-host-folders/grouped",
    "databases:list",
    "req:/api/databases",
    "storage:list",
    "req:/api/object-storage",
    "pages:",
    "req:/api/pages",
    "docker:",
    "req:/api/docker",
  ],
  admin: ["admin:"],
  cas: ["cas:list:", "certificates:list:"],
  certificates: ["certificates:list:", "cas:list:"],
  databases: ["databases:list"],
  docker: ["docker:"],
  domains: ["domains:list"],
  housekeeping: ["housekeeping:"],
  inference: ["settings:ai-config"],
  integrations: ["settings:"],
  logging: ["logging:"],
  "nginx-templates": ["nginx-templates:list"],
  nodes: ["nodes:list:", "docker:snapshots:"],
  notifications: ["notifications:"],
  pages: ["pages:"],
  "proxy-host-folders": ["proxy:grouped", "req:/api/proxy-hosts"],
  "proxy-hosts": ["proxy:grouped", "req:/api/proxy-host-folders/grouped", "domains:list"],
  "ssl-certificates": ["ssl:list:"],
  "status-page": ["status-page:", "settings:status-page-"],
  system: ["system:", "settings:", "req:/api/ui/bootstrap"],
  templates: ["templates:list"],
};

const DASHBOARD_RESOURCES = new Set([
  "cas",
  "certificates",
  "databases",
  "docker",
  "domains",
  "housekeeping",
  "inference",
  "logging",
  "nodes",
  "proxy-host-folders",
  "proxy-hosts",
  "ssl-certificates",
  "system",
]);

/** Resources that can be app members: deleting one changes its app's pages. */
const APP_MEMBER_RESOURCES = new Set([
  "databases",
  "docker",
  "nodes",
  "object-storage",
  "pages",
  "proxy-hosts",
]);

/**
 * Resolve request-cache and independently warmed projection namespaces that
 * become stale after a successful API mutation.
 */
export function mutationCachePrefixes(url: string, method = "POST"): string[] {
  const pathname = new URL(url, "http://opfield.local").pathname;
  const apiPath = pathname.startsWith("/api/") ? pathname.slice(5) : pathname.replace(/^\//, "");
  const resource = apiPath.split("/")[0];
  if (!resource) return [];

  const prefixes = new Set<string>([
    `req:/api/${resource}`,
    ...(RESOURCE_PROJECTIONS[resource] ?? []),
  ]);
  // A deleted member must not linger on its app's page served from the cache.
  if (method.toUpperCase() === "DELETE" && APP_MEMBER_RESOURCES.has(resource)) {
    prefixes.add("apps:");
  }
  if (DASHBOARD_RESOURCES.has(resource)) {
    prefixes.add("req:/api/monitoring/dashboard");
    prefixes.add("req:/api/monitoring/health-status");
    prefixes.add("dashboard:");
  }
  return [...prefixes];
}
