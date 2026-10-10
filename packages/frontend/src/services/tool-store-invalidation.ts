import { api } from "@/services/api";
import {
  apiTokenChangedChannel,
  inferenceTokenChangedChannel,
  oauthAuthorizationChangedChannel,
} from "@/services/user-resource-events";

export const TOOL_STORE_INVALIDATION_CHANNEL_PREFIX = "tool.store.invalidated.";

const STORE_EVENT_CHANNELS: Record<string, string[]> = {
  accessLists: ["access-list.changed"],
  apps: ["apps"],
  ca: ["ca.changed"],
  certificates: ["cert.changed"],
  containers: ["docker.container.changed"],
  databases: ["database.changed"],
  "docker-deployments": ["docker.deployment.changed"],
  "docker-tasks": ["docker.task.changed"],
  dockerRegistries: ["docker.registry.changed"],
  domains: ["domain.changed"],
  folders: [
    "node.folder.changed",
    "database.folder.changed",
    "docker.folder.changed",
    "pages.folder.changed",
    "proxy.host.changed",
  ],
  groups: ["group.changed"],
  images: ["docker.image.changed"],
  integrations: ["integration.connector.changed"],
  logging: ["logging.environment.changed", "logging.schema.changed"],
  loggingTokens: ["logging.token.changed"],
  networks: ["docker.network.changed"],
  nodes: ["node.changed"],
  pages: ["pages.project.changed"],
  pageTokens: ["pages.token.changed"],
  proxy: ["proxy.host.changed"],
  "proxy-hosts": ["proxy.host.changed"],
  settings: ["system.config.changed"],
  ssl: ["ssl.cert.changed"],
  tasks: ["docker.task.changed"],
  templates: ["pki.template.changed"],
  users: ["user.changed"],
  volumes: ["docker.volume.changed"],
};

export interface ToolStoreInvalidationPayload {
  userId?: string;
  source?: "ai" | "mcp";
  toolName?: string;
  stores?: string[];
  resourceId?: string;
  context?: Record<string, string>;
}

export function invalidateToolStore(storeName: string): void {
  switch (storeName) {
    case "ca":
      invalidate("req:/api/cas", "cas:list:", "req:/api/monitoring/dashboard", "dashboard:stats:");
      break;
    case "certificates":
      invalidate(
        "req:/api/certificates",
        "certificates:list:",
        "req:/api/monitoring/dashboard",
        "dashboard:stats:"
      );
      break;
    case "ssl":
      invalidate(
        "req:/api/ssl-certificates",
        "ssl:list:",
        "req:/api/monitoring/dashboard",
        "dashboard:stats:"
      );
      break;
    case "proxy":
    case "proxy-hosts":
      invalidate(
        "req:/api/proxy-hosts",
        "req:/api/proxy-host-folders/grouped",
        "proxy:grouped",
        "req:/api/domains",
        "domains:list",
        "req:/api/monitoring/dashboard",
        "req:/api/monitoring/health-status",
        "dashboard:stats:",
        "dashboard:health"
      );
      break;
    case "templates":
      invalidate("req:/api/templates", "templates:list", "templates");
      break;
    case "domains":
      invalidate("req:/api/domains", "domains:list", "domains");
      break;
    case "accessLists":
      invalidate("req:/api/access-lists", "access-lists:list");
      break;
    case "nodes":
      invalidate("req:/api/nodes", "req:/api/monitoring/dashboard", "dashboard:stats:");
      break;
    case "groups":
      invalidate("req:/api/admin/groups", "req:/api/admin/users", "admin:groups", "admin:users");
      break;
    case "users":
      invalidate("req:/api/admin/users", "admin:users");
      break;
    case "containers":
    case "images":
    case "volumes":
    case "networks":
    case "docker-deployments":
    case "docker-tasks":
    case "tasks":
      invalidate("req:/api/docker", "docker:");
      break;
    case "databases":
      invalidate("req:/api/databases", "databases:list");
      break;
    case "integrations":
      invalidate(
        "req:/api/integrations/gitlab/connectors",
        "settings:gitlab-connectors",
        "req:/api/integrations/cloudflare/connectors",
        "settings:cloudflare-connectors",
        "req:/api/integrations/github/connectors",
        "settings:github-connectors",
        "req:/api/integrations/git/connectors",
        "settings:git-connectors",
        "req:/api/integrations/ssh/connectors",
        "settings:ssh-connectors"
      );
      break;
    case "dockerRegistries":
      invalidate("req:/api/docker/registries", "settings:docker-registries");
      break;
    case "settings":
      invalidate(
        "req:/api/system/config",
        "req:/api/system/license",
        "req:/api/housekeeping",
        "settings:"
      );
      break;
    case "logging":
      invalidate("req:/api/logging", "logging:");
      break;
    case "loggingTokens":
      invalidate("req:/api/logging/environments", "logging:tokens");
      break;
    case "pages":
      invalidate("req:/api/pages", "pages:");
      break;
    case "apps":
      // Members join and leave the normal lists when an app changes.
      invalidate(
        "req:/api/apps",
        "apps:",
        "req:/api/proxy-hosts",
        "req:/api/proxy-host-folders/grouped",
        "proxy:grouped",
        "req:/api/databases",
        "databases:list",
        "req:/api/object-storage",
        "storage:list",
        "req:/api/pages",
        "pages:",
        "req:/api/docker",
        "docker:"
      );
      break;
    case "pageTokens":
      invalidate("req:/api/pages", "pages:tokens");
      break;
    case "apiTokens":
      invalidate("req:/api/tokens", "settings:api-tokens");
      break;
    case "inferenceTokens":
      invalidate("req:/api/inference/tokens", "settings:inference-tokens");
      break;
    case "oauthAuthorizations":
      invalidate("req:/api/oauth/authorizations", "settings:oauth-authorizations");
      break;
    case "folders":
      invalidate("folders:");
      break;
  }
}

export function toolStoreEventChannels(stores: string[], userId?: string): string[] {
  const channels = stores.flatMap((store) => STORE_EVENT_CHANNELS[store] ?? []);
  if (userId) {
    if (stores.includes("apiTokens")) channels.push(apiTokenChangedChannel(userId));
    if (stores.includes("inferenceTokens")) channels.push(inferenceTokenChangedChannel(userId));
    if (stores.includes("oauthAuthorizations")) {
      channels.push(oauthAuthorizationChangedChannel(userId));
    }
  }
  return [...new Set(channels)];
}

function invalidate(...prefixes: string[]): void {
  for (const prefix of prefixes) api.invalidateCache(prefix);
}
