import {
  Activity,
  AppWindow,
  Award,
  Bell,
  Box,
  Database,
  FileText,
  Globe,
  Globe2,
  HardDrive,
  LayoutDashboard,
  Lock,
  Network,
  PanelsTopLeft,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import type { ElementType } from "react";
import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";

export type AppNavigationGroupId = "main" | "reverse-proxy" | "pki" | "resources" | "management";

export type AppNavigationItemId =
  | "dashboard"
  | "apps"
  | "profile"
  | "proxy-hosts"
  | "domains"
  | "ingress-groups"
  | "ssl-certificates"
  | "authorities"
  | "certificates"
  | "docker"
  | "pages"
  | "databases"
  | "storage"
  | "logging"
  | "nodes"
  | "templates"
  | "access-lists"
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
      {
        id: "profile",
        name: "Profile",
        href: "/profile",
        icon: UserRound,
        keywords: ["preferences", "authorizations", "tokens", "oauth"],
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
        href: "/proxy-hosts",
        icon: Globe,
        shortcutKey: "3",
        keywords: ["nginx", "upstream", "reverse proxy", "route"],
      },
      {
        id: "ssl-certificates",
        name: "SSL Certificates",
        href: "/ssl-certificates",
        icon: Lock,
        shortcutKey: "4",
        keywords: ["tls", "acme", "letsencrypt"],
      },
      {
        id: "domains",
        name: "Domains",
        href: "/domains",
        icon: Globe2,
        shortcutKey: "2",
        keywords: ["dns", "cloudflare"],
      },
      {
        id: "ingress-groups",
        name: "Ingress Groups",
        href: "/ingress-groups",
        icon: Network,
        keywords: ["sites", "failover", "multi-node", "availability", "nginx nodes"],
      },
    ],
  },
  {
    id: "pki",
    label: "PKI",
    items: [
      {
        id: "authorities",
        name: "Authorities",
        href: "/cas",
        icon: ShieldCheck,
        shortcutKey: "5",
        keywords: ["ca", "certificate authority", "root", "intermediate"],
      },
      {
        id: "certificates",
        name: "Certificates",
        href: "/certificates",
        icon: FileText,
        shortcutKey: "6",
        keywords: ["pki certificates"],
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
        id: "templates",
        name: "Templates",
        href: "/templates",
        icon: Award,
        shortcutKey: "7",
        keywords: ["nginx templates", "pki templates", "certificate templates"],
      },
      {
        id: "access-lists",
        name: "Access Lists",
        href: "/access-lists",
        icon: ShieldAlert,
        shortcutKey: "0",
        keywords: ["acl", "ip rules", "basic auth"],
      },
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
    case "profile":
      return true;
    case "proxy-hosts":
      return hasScopeBase(scopes, "proxy:view") || scopeMatches(scopes, "proxy:folders:manage");
    case "domains":
      return hasScopeBase(scopes, "domains:view");
    case "ingress-groups":
      return hasScopeBase(scopes, "ingress:groups:view");
    case "ssl-certificates":
      return hasScopeBase(scopes, "ssl:cert:view");
    case "authorities":
      return context.pkiEnabled && hasScopeBase(scopes, "pki:ca:view");
    case "certificates":
      return context.pkiEnabled && hasScopeBase(scopes, "pki:cert:view");
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
    case "templates":
      return (
        (context.pkiEnabled && hasScopeBase(scopes, "pki:templates:view")) ||
        hasScopeBase(scopes, "proxy:templates:view")
      );
    case "access-lists":
      return hasScopeBase(scopes, "acl:view");
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

export function visibleNavigationGroups(context: AppNavigationVisibility): AppNavigationGroup[] {
  return APP_NAVIGATION_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccessNavigationItem(item, context)),
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
