import {
  Activity,
  AppWindow,
  Bell,
  Box,
  Database,
  Globe,
  HardDrive,
  LayoutDashboard,
  Lock,
  PanelsTopLeft,
  ScrollText,
  Server,
  Settings,
  Users,
} from "lucide-react";
import type { ElementType } from "react";
import {
  CERTIFICATES_HUB,
  type HubAccessContext,
  type NavigationHub,
  ROUTES_HUB,
  visibleHubTabs,
} from "@/lib/navigation-hubs";
import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";

export type AppNavigationGroupId = "main" | "reverse-proxy" | "resources" | "management";

export type AppNavigationItemId =
  | "dashboard"
  | "apps"
  | "proxy-hosts"
  | "ssl-certificates"
  | "docker"
  | "pages"
  | "databases"
  | "storage"
  | "logging"
  | "nodes"
  | "notifications"
  | "status-page"
  | "administration"
  | "settings";

export interface AppNavigationItem {
  id: AppNavigationItemId;
  name: string;
  href: string;
  icon: ElementType;
  shortcutKey?: string;
  keywords?: readonly string[];
  /** Other URL prefixes that belong to this item (its tabs and detail pages); it stays highlighted there. */
  activePaths?: readonly string[];
}

export interface AppNavigationGroup {
  id: AppNavigationGroupId;
  label: string;
  items: readonly AppNavigationItem[];
}

export interface AppNavigationVisibility {
  scopes: readonly string[];
  pkiEnabled: boolean;
  siemEnabled: boolean;
  loggingEnabled: boolean;
  inferenceEnabled: boolean;
  hasLowInferenceUsage?: boolean;
  statusPageEnabled?: boolean;
  pagesEnabled?: boolean;
  hasNginxNodes?: boolean;
  hasCloudflareIntegration?: boolean;
  hasDockerNodes?: boolean;
}

export const APP_NAVIGATION_GROUPS: readonly AppNavigationGroup[] = [
  {
    id: "main",
    label: "Main",
    items: [
      {
        id: "dashboard",
        name: "Dashboard",
        href: "/",
        icon: LayoutDashboard,
        shortcutKey: "1",
        keywords: ["overview", "home"],
      },
      {
        id: "apps",
        name: "Apps",
        href: "/apps",
        icon: AppWindow,
        keywords: ["applications", "environments", "projects", "staging", "production"],
      },
    ],
  },
  {
    id: "reverse-proxy",
    label: "Ingress",
    items: [
      {
        id: "proxy-hosts",
        name: "Routes",
        href: "/routes",
        icon: Globe,
        shortcutKey: "3",
        keywords: [
          "nginx",
          "upstream",
          "reverse proxy",
          "route",
          "proxy hosts",
          "domains",
          "dns",
          "ingress groups",
          "access lists",
          "acl",
          "nginx templates",
        ],
        activePaths: ["/proxy-hosts", "/ingress-groups", "/nginx-templates"],
      },
      {
        id: "ssl-certificates",
        name: "Certificates",
        href: "/certificates",
        icon: Lock,
        shortcutKey: "4",
        keywords: [
          "ssl",
          "tls",
          "acme",
          "letsencrypt",
          "ssl certificates",
          "pki",
          "pki certificates",
          "authorities",
          "certificate authority",
          "ca",
          "certificate templates",
        ],
        activePaths: ["/cas"],
      },
    ],
  },
  {
    id: "resources",
    label: "Resources",
    items: [
      {
        id: "docker",
        name: "Docker",
        href: "/docker",
        icon: Box,
        shortcutKey: "8",
        keywords: ["containers", "deployments", "images", "volumes", "networks", "tasks"],
      },
      {
        id: "pages",
        name: "Pages",
        href: "/pages",
        icon: PanelsTopLeft,
        keywords: ["static sites", "deployments", "tags", "previews", "webhook"],
      },
      {
        id: "databases",
        name: "Databases",
        href: "/databases",
        icon: Database,
        keywords: ["postgres", "postgresql", "clickhouse", "redis", "valkey", "key-value"],
      },
      {
        id: "storage",
        name: "Storage",
        href: "/storage",
        icon: HardDrive,
        keywords: ["s3", "seaweedfs", "minio", "r2", "ftp", "sftp", "backups"],
      },
      {
        id: "logging",
        name: "Logging",
        href: "/logging",
        icon: ScrollText,
        keywords: ["logs", "schemas", "environments", "ingest"],
      },
      {
        id: "nodes",
        name: "Nodes",
        href: "/nodes",
        icon: Server,
        shortcutKey: "9",
        keywords: ["daemons", "servers", "hosts"],
      },
    ],
  },
  {
    id: "management",
    label: "Management",
    items: [
      {
        id: "notifications",
        name: "Notifications",
        href: "/notifications",
        icon: Bell,
        keywords: ["alerts", "webhooks", "delivery log", "siem", "audit export"],
      },
      {
        id: "status-page",
        name: "Status Page",
        href: "/status-page",
        icon: Activity,
        keywords: ["services", "incidents", "public status"],
      },
      {
        id: "administration",
        name: "Administration",
        href: "/administration",
        icon: Users,
        keywords: ["users", "groups", "audit log"],
      },
      {
        id: "settings",
        name: "Settings",
        href: "/settings",
        icon: Settings,
        keywords: [
          "gateway",
          "features",
          "integrations",
          "gitlab",
          "cloudflare",
          "ai assistant",
          "inference",
          "license",
          "updates",
          "docker registries",
          "housekeeping",
        ],
      },
    ],
  },
] as const;

const NOTIFICATION_CORE_SCOPES = [
  "notifications:alerts:view",
  "notifications:alerts:manage",
  "notifications:webhooks:view",
  "notifications:webhooks:manage",
] as const;

const SIEM_NOTIFICATION_SCOPES = ["audit:siem:view", "audit:siem:manage"] as const;

const SETTINGS_SCOPES = [
  "settings:gateway:view",
  "settings:gateway:edit",
  "docker:registries:view",
  "admin:update",
  "license:view",
  "license:manage",
  "status-page:view",
  "housekeeping:view",
  "housekeeping:run",
  "housekeeping:configure",
  "integrations:gitlab:view",
  "integrations:gitlab:manage",
  "integrations:cloudflare:view",
  "integrations:cloudflare:manage",
  "integrations:hosting:view",
  "integrations:hosting:manage",
  "feat:ai:configure",
] as const;

function hasAnyScope(scopes: readonly string[], required: readonly string[]): boolean {
  return required.some((scope) => scopeMatches(scopes, scope));
}

export function hasDashboardContent(context: AppNavigationVisibility): boolean {
  const { scopes } = context;
  return (
    hasScopeBase(scopes, "proxy:view") ||
    hasScopeBase(scopes, "ssl:cert:view") ||
    hasScopeBase(scopes, "nodes:details") ||
    scopeMatches(scopes, "admin:audit") ||
    (context.pkiEnabled &&
      (hasScopeBase(scopes, "pki:cert:view") || hasScopeBase(scopes, "pki:ca:view"))) ||
    (context.inferenceEnabled &&
      context.hasLowInferenceUsage === true &&
      scopeMatches(scopes, "feat:ai:use"))
  );
}

export function canAccessNavigationItem(
  item: AppNavigationItem,
  context: AppNavigationVisibility
): boolean {
  const { scopes } = context;
  switch (item.id) {
    case "dashboard":
      return hasDashboardContent(context);
    case "apps":
      return hasScopeBase(scopes, "apps:view") || scopeMatches(scopes, "apps:create");
    case "proxy-hosts":
      return visibleHubTabs(ROUTES_HUB, hubContext(context)).length > 0;
    case "ssl-certificates":
      return visibleHubTabs(CERTIFICATES_HUB, hubContext(context)).length > 0;
    case "docker": {
      const canAccess =
        hasScopeBase(scopes, "docker:containers:view") ||
        hasScopeBase(scopes, "docker:images:view") ||
        hasScopeBase(scopes, "docker:volumes:view") ||
        hasScopeBase(scopes, "docker:networks:view") ||
        hasScopeBase(scopes, "docker:tasks") ||
        hasScopeBase(scopes, "docker:folders:manage");
      return (
        canAccess &&
        (context.hasDockerNodes !== false || hasScopeBase(scopes, "docker:folders:manage"))
      );
    }
    case "pages":
      return (
        context.pagesEnabled === true &&
        (hasScopeBase(scopes, "pages:view") ||
          hasScopeBase(scopes, "pages:create") ||
          scopeMatches(scopes, "pages:folders:manage"))
      );
    // Create-only (for example folder-scoped) grants open the page so the user can create.
    case "storage":
      return (
        hasScopeBase(scopes, "storage:view") ||
        hasScopeBase(scopes, "storage:create") ||
        scopeMatches(scopes, "storage:folders:manage")
      );
    case "databases":
      return (
        hasScopeBase(scopes, "databases:view") ||
        hasScopeBase(scopes, "databases:create") ||
        scopeMatches(scopes, "databases:folders:manage")
      );
    case "logging":
      return (
        context.loggingEnabled &&
        (hasScopeBase(scopes, "logs:environments:view") ||
          hasScopeBase(scopes, "logs:schemas:view") ||
          hasScopeBase(scopes, "logs:read") ||
          hasScopeBase(scopes, "logs:environments:create") ||
          hasScopeBase(scopes, "logs:schemas:create"))
      );
    case "nodes":
      return hasScopeBase(scopes, "nodes:details") || scopeMatches(scopes, "nodes:folders:manage");
    case "notifications":
      return (
        hasAnyScope(scopes, NOTIFICATION_CORE_SCOPES) ||
        (context.siemEnabled && hasAnyScope(scopes, SIEM_NOTIFICATION_SCOPES))
      );
    case "status-page":
      return context.statusPageEnabled === true && scopeMatches(scopes, "status-page:view");
    case "administration":
      return ["admin:audit", "admin:users", "admin:groups"].some((scope) =>
        hasScopeBase(scopes, scope)
      );
    case "settings":
      return (
        hasAnyScope(scopes, SETTINGS_SCOPES) ||
        (context.inferenceEnabled &&
          hasAnyScope(scopes, [
            "inference:providers:view",
            "inference:providers:manage",
            "inference:models:manage",
            "inference:limits:manage",
            "inference:usage:view",
          ]))
      );
  }
}

function hubContext(context: AppNavigationVisibility): HubAccessContext {
  return { scopes: context.scopes, pkiEnabled: context.pkiEnabled };
}

const HUB_BY_NAVIGATION_ITEM: Partial<Record<AppNavigationItemId, NavigationHub>> = {
  "proxy-hosts": ROUTES_HUB,
  "ssl-certificates": CERTIFICATES_HUB,
};

/** A hub item links to its first tab the user may open, so a Domains-only user lands on Domains. */
function withVisibleHref(item: AppNavigationItem, context: AppNavigationVisibility) {
  const hub = HUB_BY_NAVIGATION_ITEM[item.id];
  if (!hub) return item;
  const tabs = visibleHubTabs(hub, hubContext(context));
  const href = tabs[0]?.path ?? item.href;
  if (href === item.href) return item;
  return { ...item, href, activePaths: [item.href, ...(item.activePaths ?? [])] };
}

export function visibleNavigationGroups(context: AppNavigationVisibility): AppNavigationGroup[] {
  return APP_NAVIGATION_GROUPS.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => canAccessNavigationItem(item, context))
      .map((item) => withVisibleHref(item, context)),
  })).filter((group) => group.items.length > 0);
}

export function keyboardNavigationRoutes(context: AppNavigationVisibility): Record<string, string> {
  return Object.fromEntries(
    APP_NAVIGATION_GROUPS.flatMap((group) => group.items)
      .filter(
        (item): item is AppNavigationItem & { shortcutKey: string } =>
          !!item.shortcutKey && canAccessNavigationItem(item, context)
      )
      .map((item) => [item.shortcutKey, item.href])
  );
}
