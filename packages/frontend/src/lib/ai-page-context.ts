import { matchRoutes, type RouteObject } from "react-router-dom";
import { CERTIFICATES_HUB, ROUTES_HUB } from "@/lib/navigation-hubs";
import type { ResolvedPageResource } from "@/stores/resolved-page-context";
import type { PageContext } from "@/types/ai";

/**
 * What each dashboard page tells the AI assistant. Every route under the dashboard layout has an
 * entry here or in AI_PAGE_CONTEXT_EXEMPT_PATHS (a test checks App.tsx against both), so a new
 * page cannot ship without page context.
 *
 * A page entry sends its route and title. A resource entry sends the resource: from the URL when
 * `idParam` names a param the assistant's tools accept as the id, otherwise only once the page has
 * published the loaded resource (useResolvedPageRoute in its guard, or usePublishedPageResource).
 * A published resource of the same type always wins, since it carries the real id and name.
 */
export type AIPageRouteEntry =
  | { path: string; page: string; tabs?: Readonly<Record<string, string>> }
  | {
      path: string;
      resource: {
        resourceType: string;
        /** Shown in the panel when the published resource has no name and for URL-only ids. */
        noun: string;
        idParam?: string;
      };
    };

const hubTabTitles: Record<string, string> = {
  "/routes": "Routes",
  "/routes/domains": "Domains",
  "/routes/ingress-groups": "Ingress Groups",
  "/routes/access-lists": "Access Lists",
  "/routes/templates": "Route Templates",
  "/certificates": "SSL Certificates",
  "/certificates/authorities": "Certificate Authorities",
  "/certificates/pki": "PKI Certificates",
  "/certificates/templates": "Certificate Templates",
};

const hubEntries: AIPageRouteEntry[] = [ROUTES_HUB, CERTIFICATES_HUB].flatMap((hub) =>
  hub.tabs.map((tab) => ({ path: tab.path, page: hubTabTitles[tab.path] ?? tab.label }))
);

export const AI_PAGE_ROUTES: readonly AIPageRouteEntry[] = [
  { path: "/", page: "Dashboard" },
  { path: "/dashboard", page: "Dashboard" },
  { path: "/apps", page: "Apps" },
  {
    path: "/apps/:appSlug/env/:envSlug",
    resource: { resourceType: "app-environment", noun: "app environment" },
  },
  {
    path: "/apps/:appSlug/:tab?",
    // get_app accepts a slug, so the URL is enough until the page publishes the app.
    resource: { resourceType: "app", noun: "app", idParam: "appSlug" },
  },
  ...hubEntries,
  { path: "/routes/new", page: "New Route" },
  {
    path: "/proxy-hosts/:proxySlug/:tab?",
    resource: { resourceType: "proxy-host", noun: "route" },
  },
  { path: "/pages", page: "Pages" },
  {
    path: "/pages/:projectSlug/:tab?",
    resource: { resourceType: "page-project", noun: "Pages project" },
  },
  { path: "/nginx-templates/new", page: "New Route Template" },
  {
    path: "/nginx-templates/:id",
    resource: { resourceType: "nginx-template", noun: "route template", idParam: "id" },
  },
  {
    path: "/ingress-groups/:groupId",
    resource: { resourceType: "ingress-group", noun: "ingress group", idParam: "groupId" },
  },
  {
    path: "/cas/:id",
    resource: { resourceType: "ca", noun: "certificate authority", idParam: "id" },
  },
  {
    path: "/certificates/:id",
    resource: { resourceType: "certificate", noun: "certificate", idParam: "id" },
  },
  { path: "/administration", page: "Administration" },
  {
    path: "/administration/:tab",
    page: "Administration",
    tabs: { users: "Users", groups: "Groups", audit: "Audit Log" },
  },
  {
    path: "/notifications/:tab?",
    page: "Notifications",
    tabs: {
      alerts: "Alert Rules",
      webhooks: "Webhooks",
      deliveries: "Webhook Delivery Log",
      siem: "SIEM Destinations",
      "siem-deliveries": "SIEM Delivery Log",
    },
  },
  {
    path: "/status-page/:tab?",
    page: "Status Page",
    tabs: {
      services: "Status Page Services",
      incidents: "Status Page Incidents",
      settings: "Status Page Settings",
    },
  },
  { path: "/databases", page: "Databases" },
  {
    path: "/databases/:databaseSlug/:tab?",
    resource: { resourceType: "database", noun: "database" },
  },
  { path: "/storage", page: "Storage" },
  {
    path: "/storage/:storageSlug/:tab?",
    resource: { resourceType: "storage", noun: "storage" },
  },
  { path: "/logging", page: "Logging" },
  {
    path: "/logging/:section",
    page: "Logging",
    tabs: { environments: "Logging Environments", schemas: "Logging Schemas" },
  },
  {
    path: "/logging/environments/:environmentSlug/:tab?",
    resource: { resourceType: "logging-environment", noun: "logging environment" },
  },
  {
    path: "/logging/schemas/:schemaSlug/:tab?",
    resource: { resourceType: "logging-schema", noun: "logging schema" },
  },
  { path: "/profile/:tab?", page: "Profile" },
  {
    path: "/settings/:tab?",
    page: "Settings",
    tabs: {
      general: "General Settings",
      authentication: "Authentication Settings",
      advanced: "Advanced Settings",
      environment: "Environment Settings",
      relay: "Relay Settings",
      features: "Feature Settings",
      integrations: "Integrations",
      ai: "AI Settings",
      inference: "Inference Settings",
    },
  },
  { path: "/nodes", page: "Nodes" },
  {
    path: "/nodes/:nodeSlug/:tab?",
    resource: { resourceType: "node", noun: "node" },
  },
  {
    path: "/hosting/:connectorId/:tab?",
    resource: {
      resourceType: "hosting-connector",
      noun: "hosting account",
      idParam: "connectorId",
    },
  },
  {
    path: "/docker/:tab?",
    page: "Docker",
    tabs: {
      containers: "Docker Containers",
      compose: "Compose Projects",
      images: "Docker Images",
      volumes: "Docker Volumes",
      networks: "Docker Networks",
      tasks: "Docker Tasks",
      builds: "Docker Builds",
    },
  },
  {
    path: "/docker/compose/:projectId/:tab?",
    resource: {
      resourceType: "docker-compose-project",
      noun: "Compose project",
      idParam: "projectId",
    },
  },
  {
    path: "/docker/containers/:nodeSlug/:containerName/:tab?",
    resource: { resourceType: "docker-container", noun: "container" },
  },
  {
    path: "/docker/deployments/:nodeSlug/:deploymentName/:tab?",
    resource: { resourceType: "docker-deployment", noun: "deployment" },
  },
  {
    path: "/docker/volumes/:nodeSlug/:volumeName/:tab?",
    resource: { resourceType: "docker-volume", noun: "volume" },
  },
];

/**
 * Dashboard routes with no page context: the AI workspace itself (no side panel there) and old
 * URLs that only redirect.
 */
export const AI_PAGE_CONTEXT_EXEMPT_PATHS: readonly string[] = [
  "/ai/chats/:conversationId",
  "/proxy-hosts",
  "/proxy-hosts/new",
  "/ssl-certificates/*",
  "/domains/*",
  "/ingress-groups",
  "/access-lists/*",
  "/cas",
  "/templates/*",
  "/audit",
  "/admin/users",
  "/admin/groups",
  "/docker/compose/new",
];

const ROUTE_OBJECTS: RouteObject[] = AI_PAGE_ROUTES.map((entry) => ({
  path: entry.path,
  handle: entry,
}));

/** The assistant sees no page at all: an empty route overrides the conversation's last page. */
export const NO_PAGE_CONTEXT: PageContext = { route: "" };

export interface AIPageContext {
  /** Sent with the message; the backend puts route, title and resource into the prompt. */
  context: PageContext;
  /** "Viewing …" text, or null while the page has nothing the assistant would see beyond the URL. */
  viewing: string | null;
}

export function matchAIPageRoute(
  pathname: string
): { entry: AIPageRouteEntry; params: Record<string, string | undefined> } | null {
  const matches = matchRoutes(ROUTE_OBJECTS, pathname);
  const match = matches?.[matches.length - 1];
  if (!match) return null;
  return { entry: match.route.handle as AIPageRouteEntry, params: match.params };
}

/**
 * The page context for a URL. `published` is the resource the current page published, when the
 * store holds one for this route.
 */
export function resolveAIPageContext(
  pathname: string,
  published: ResolvedPageResource | null
): AIPageContext {
  const route = pathname;
  const matched = matchAIPageRoute(pathname);
  if (!matched) return { context: { route }, viewing: null };
  const { entry, params } = matched;

  if ("page" in entry) {
    const tab = params.tab ?? params.section;
    const title = (tab && entry.tabs?.[tab]) || entry.page;
    return { context: { route, label: title }, viewing: title };
  }

  const { resourceType, noun, idParam } = entry.resource;
  if (published && published.resourceType === resourceType) {
    return {
      context: {
        route,
        resourceType,
        resourceId: published.resourceId,
        label: published.label,
        nodeId: published.nodeId,
      },
      viewing: published.label || noun,
    };
  }
  const urlId = idParam ? params[idParam] : undefined;
  if (urlId) {
    return { context: { route, resourceType, resourceId: urlId }, viewing: noun };
  }
  return { context: { route }, viewing: null };
}
