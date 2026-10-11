import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";

/**
 * Routes and Certificates are tabbed pages that replace several former sidebar pages. Each tab keeps
 * the permission check of the page it replaced, so a user who could open only Domains sees Routes
 * with only the Domains tab.
 */
export type NavigationHubId = "routes" | "certificates";

export type RoutesHubTab = "routes" | "domains" | "ingress-groups" | "access-lists" | "templates";
export type CertificatesHubTab = "ssl" | "authorities" | "pki" | "templates";

export interface HubAccessContext {
  scopes: readonly string[];
  pkiEnabled: boolean;
}

export interface NavigationHubTab {
  value: string;
  label: string;
  path: string;
  /** The page URL this tab replaced; keeps palette contexts and AI quick actions working. */
  legacyPath: string;
  canAccess: (context: HubAccessContext) => boolean;
}

export interface NavigationHub {
  id: NavigationHubId;
  /** The sidebar item this hub is. */
  navigationItemId: "proxy-hosts" | "ssl-certificates";
  tabs: readonly NavigationHubTab[];
}

export const ROUTES_HUB: NavigationHub = {
  id: "routes",
  navigationItemId: "proxy-hosts",
  tabs: [
    {
      value: "routes",
      label: "Routes",
      path: "/routes",
      legacyPath: "/proxy-hosts",
      canAccess: ({ scopes }) =>
        hasScopeBase(scopes, "proxy:view") || scopeMatches(scopes, "proxy:folders:manage"),
    },
    {
      value: "domains",
      label: "Domains",
      path: "/routes/domains",
      legacyPath: "/domains",
      canAccess: ({ scopes }) => hasScopeBase(scopes, "domains:view"),
    },
    {
      value: "ingress-groups",
      label: "Ingress Groups",
      path: "/routes/ingress-groups",
      legacyPath: "/ingress-groups",
      canAccess: ({ scopes }) => hasScopeBase(scopes, "ingress:groups:view"),
    },
    {
      value: "access-lists",
      label: "Access Lists",
      path: "/routes/access-lists",
      legacyPath: "/access-lists",
      canAccess: ({ scopes }) => hasScopeBase(scopes, "acl:view"),
    },
    {
      value: "templates",
      label: "Templates",
      path: "/routes/templates",
      legacyPath: "/templates/nginx",
      canAccess: ({ scopes }) => hasScopeBase(scopes, "proxy:templates:view"),
    },
  ],
};

export const CERTIFICATES_HUB: NavigationHub = {
  id: "certificates",
  navigationItemId: "ssl-certificates",
  tabs: [
    {
      value: "ssl",
      label: "SSL",
      path: "/certificates",
      legacyPath: "/ssl-certificates",
      canAccess: ({ scopes }) => hasScopeBase(scopes, "ssl:cert:view"),
    },
    {
      value: "authorities",
      label: "Authorities",
      path: "/certificates/authorities",
      legacyPath: "/cas",
      canAccess: ({ scopes, pkiEnabled }) => pkiEnabled && hasScopeBase(scopes, "pki:ca:view"),
    },
    {
      value: "pki",
      label: "PKI Certificates",
      path: "/certificates/pki",
      legacyPath: "/certificates",
      canAccess: ({ scopes, pkiEnabled }) => pkiEnabled && hasScopeBase(scopes, "pki:cert:view"),
    },
    {
      value: "templates",
      label: "Templates",
      path: "/certificates/templates",
      legacyPath: "/templates/pki",
      canAccess: ({ scopes, pkiEnabled }) =>
        pkiEnabled && hasScopeBase(scopes, "pki:templates:view"),
    },
  ],
};

export const NAVIGATION_HUBS: readonly NavigationHub[] = [ROUTES_HUB, CERTIFICATES_HUB];

export function navigationHub(id: NavigationHubId): NavigationHub {
  return id === "routes" ? ROUTES_HUB : CERTIFICATES_HUB;
}

export function visibleHubTabs(hub: NavigationHub, context: HubAccessContext): NavigationHubTab[] {
  return hub.tabs.filter((tab) => tab.canAccess(context));
}

/** The hub and tab a hub tab URL shows, or null for any other path (detail pages included). */
export function hubTabForPath(
  pathname: string
): { hub: NavigationHub; tab: NavigationHubTab } | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const hub of NAVIGATION_HUBS) {
    const tab = hub.tabs.find((candidate) => candidate.path === normalized);
    if (tab) return { hub, tab };
  }
  return null;
}

/**
 * The URL a page had before it became a tab, for keys that predate the hubs (palette usage
 * contexts, AI quick actions). Other paths come back unchanged.
 */
export function legacyPathForPath(pathname: string): string {
  return hubTabForPath(pathname)?.tab.legacyPath ?? pathname;
}

/** Templates used to be one page with PKI and nginx tabs; it opens whichever the user may see. */
export function templatesLandingPath(context: HubAccessContext): string | null {
  const nginx = ROUTES_HUB.tabs.find((tab) => tab.value === "templates");
  const pki = CERTIFICATES_HUB.tabs.find((tab) => tab.value === "templates");
  if (nginx?.canAccess(context)) return nginx.path;
  if (pki?.canAccess(context)) return pki.path;
  return null;
}

function withSearch(path: string, search: string, hash: string, extra?: Record<string, string>) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!params.has(key)) params.set(key, value);
  }
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

/**
 * Where an old page URL goes now, keeping its query and hash. Returns null for paths that are not
 * old page URLs (detail pages such as /cas/:id or /ingress-groups/:id stay where they are).
 */
export function legacyNavigationRedirect(
  location: { pathname: string; search?: string; hash?: string },
  context: HubAccessContext
): string | null {
  const search = location.search ?? "";
  const hash = location.hash ?? "";
  const segments = location.pathname.split("/").filter(Boolean).map(decodeSegment);
  const [first, second, ...rest] = segments;
  const to = (path: string, extra?: Record<string, string>) =>
    withSearch(path, search, hash, extra);

  switch (first) {
    case "proxy-hosts":
      if (second === undefined) return to("/routes");
      if (second === "new" && rest.length === 0) return to("/routes/new");
      return null;
    case "domains":
      if (second === undefined) return to("/routes/domains");
      // There was never a domain page; a domain link opens the domain on the Domains tab.
      return to("/routes/domains", { domain: second });
    case "ingress-groups":
      return second === undefined ? to("/routes/ingress-groups") : null;
    case "access-lists":
      return to("/routes/access-lists");
    case "ssl-certificates":
      if (second === undefined) return to("/certificates");
      return to("/certificates", { certificate: second });
    case "cas":
      return second === undefined ? to("/certificates/authorities") : null;
    case "templates":
      if (second === "nginx") return to("/routes/templates");
      if (second === "pki") return to("/certificates/templates");
      return to(templatesLandingPath(context) ?? "/");
    default:
      return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
