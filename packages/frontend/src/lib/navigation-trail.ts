import { matchPath } from "react-router-dom";
import { hubTabForPath } from "@/lib/navigation-hubs";
import { isSafeInternalPath } from "@/lib/return-navigation";

/**
 * The in-console navigation trail behind the page back arrow.
 *
 * The trail records pages, not URLs: tab switches, filters, queries and hashes of one page update
 * that page's entry (its last URL) instead of adding a back step. Browser back/forward moves the
 * cursor within the trail, redirects replace the current entry, and the page back arrow walks the
 * trail backwards without ever re-adding the page it leaves.
 */

export const NAVIGATION_TRAIL_LIMIT = 50;

export interface NavigationTrailEntry {
  /** Page identity, see {@link pageKeyForPath}. */
  key: string;
  /** Last URL (path, query and hash) this page was shown with. */
  url: string;
  /** Browser history index of the last visit, when the router exposes one. */
  historyIdx?: number;
}

export interface NavigationTrailState {
  entries: NavigationTrailEntry[];
  /** Cursor into entries; -1 when the trail is empty. */
  index: number;
}

export type NavigationAction = "PUSH" | "REPLACE" | "POP";

export interface NavigationVisit {
  action: NavigationAction;
  pathname: string;
  search?: string;
  hash?: string;
  historyIdx?: number;
  /** First location of a document load (initial render or reload). */
  initial?: boolean;
}

export const EMPTY_NAVIGATION_TRAIL: NavigationTrailState = { entries: [], index: -1 };

interface PagePattern {
  id: string;
  pattern: string;
  /** URL path stored for this page instead of the visited one (create dialogs that must not reopen). */
  canonicalPath?: string;
}

/**
 * Pages in match order (specific first). A trailing `/*` makes tab segments and any deeper
 * segments part of the same page; only the named params identify the page.
 */
const PAGE_PATTERNS: readonly PagePattern[] = [
  { id: "dashboard", pattern: "/" },
  { id: "dashboard", pattern: "/dashboard" },
  { id: "ai-chat", pattern: "/ai/chats/:conversationId/*" },
  { id: "apps", pattern: "/apps" },
  { id: "app-environment", pattern: "/apps/:appSlug/env/:envSlug/*" },
  { id: "app", pattern: "/apps/:appSlug/*" },
  { id: "hub:routes", pattern: "/routes/new", canonicalPath: "/routes" },
  { id: "route", pattern: "/proxy-hosts/:proxySlug/*" },
  { id: "pages", pattern: "/pages" },
  { id: "page-project", pattern: "/pages/:projectSlug/*" },
  { id: "nginx-template-new", pattern: "/nginx-templates/new" },
  { id: "nginx-template", pattern: "/nginx-templates/:id/*" },
  { id: "ingress-group", pattern: "/ingress-groups/:groupId/*" },
  { id: "ca", pattern: "/cas/:id/*" },
  { id: "certificate", pattern: "/certificates/:id/*" },
  { id: "administration", pattern: "/administration/*" },
  { id: "notifications", pattern: "/notifications/*" },
  { id: "status-page", pattern: "/status-page/*" },
  { id: "databases", pattern: "/databases" },
  { id: "database", pattern: "/databases/:databaseSlug/*" },
  { id: "storage", pattern: "/storage" },
  { id: "storage-detail", pattern: "/storage/:storageSlug/*" },
  { id: "logging-environment", pattern: "/logging/environments/:environmentSlug/*" },
  { id: "logging-schema", pattern: "/logging/schemas/:schemaSlug/*" },
  { id: "logging", pattern: "/logging/*" },
  { id: "profile", pattern: "/profile/*" },
  { id: "settings", pattern: "/settings/*" },
  { id: "nodes", pattern: "/nodes" },
  { id: "hosting", pattern: "/hosting/:connectorId/*" },
  { id: "node", pattern: "/nodes/:nodeSlug/*" },
  { id: "docker-compose-new", pattern: "/docker/compose/new" },
  { id: "docker-compose", pattern: "/docker/compose/:projectId/*" },
  { id: "docker-container", pattern: "/docker/containers/:nodeSlug/:containerName/*" },
  { id: "docker-deployment", pattern: "/docker/deployments/:nodeSlug/:deploymentName/*" },
  { id: "docker-volume", pattern: "/docker/volumes/:nodeSlug/:volumeName/*" },
  { id: "docker", pattern: "/docker/*" },
];

function normalizePath(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return trimmed || "/";
}

export interface PageIdentity {
  key: string;
  /** Path to store for the page (usually the visited one). */
  path: string;
}

/** Page identity of a path: route pattern plus the params that name its resource. */
export function pageIdentityForPath(pathname: string): PageIdentity {
  const path = normalizePath(pathname);
  // Routes and Certificates are tabbed hubs whose tabs have their own paths.
  const hubTab = hubTabForPath(path);
  if (hubTab) return { key: `hub:${hubTab.hub.id}`, path };

  for (const page of PAGE_PATTERNS) {
    const match = matchPath({ path: page.pattern, end: true }, path);
    if (!match) continue;
    const params = Object.entries(match.params)
      .filter(([name]) => name !== "*")
      .map(([name, value]) => `${name}=${value ?? ""}`);
    return {
      key: params.length > 0 ? `${page.id}|${params.join("|")}` : page.id,
      path: page.canonicalPath ?? path,
    };
  }
  return { key: `path:${path}`, path };
}

export function pageKeyForPath(pathname: string): string {
  return pageIdentityForPath(pathname).key;
}

function capTrail(state: NavigationTrailState): NavigationTrailState {
  const overflow = state.entries.length - NAVIGATION_TRAIL_LIMIT;
  if (overflow <= 0) return state;
  return {
    entries: state.entries.slice(overflow),
    index: Math.max(0, state.index - overflow),
  };
}

function withEntry(
  state: NavigationTrailState,
  position: number,
  entry: NavigationTrailEntry
): NavigationTrailState {
  const entries = state.entries.slice();
  entries[position] = entry;
  return { entries, index: position };
}

/** Records one router location change. Returns the same object when nothing changed. */
export function recordNavigation(
  state: NavigationTrailState,
  visit: NavigationVisit
): NavigationTrailState {
  const identity = pageIdentityForPath(visit.pathname);
  const entry: NavigationTrailEntry = {
    key: identity.key,
    url: `${identity.path}${visit.search ?? ""}${visit.hash ?? ""}`,
    ...(visit.historyIdx !== undefined ? { historyIdx: visit.historyIdx } : {}),
  };
  const current = state.index >= 0 ? state.entries[state.index] : undefined;

  if (!current) return { entries: [entry], index: 0 };

  if (visit.initial) {
    // A reload keeps its trail; any other document load (typed URL, new tab) starts over.
    if (current.key === entry.key) return withEntry(state, state.index, entry);
    const restored = findByHistoryIdx(state, entry);
    if (restored >= 0) return withEntry(state, restored, entry);
    return { entries: [entry], index: 0 };
  }

  // Tab, filter, query or hash change of the same page: refresh its last URL only.
  if (current.key === entry.key) {
    if (current.url === entry.url && current.historyIdx === entry.historyIdx) return state;
    return withEntry(state, state.index, entry);
  }

  if (visit.action === "REPLACE") {
    const previous = state.entries[state.index - 1];
    if (previous?.key === entry.key) {
      // Redirected back onto the page before: collapse instead of keeping a duplicate step.
      const entries = state.entries.slice();
      entries.splice(state.index, 1);
      entries[state.index - 1] = entry;
      return { entries, index: state.index - 1 };
    }
    return withEntry(state, state.index, entry);
  }

  if (visit.action === "POP") return recordPop(state, entry, current);

  // PUSH: a new step; forward entries are gone like in the browser.
  return capTrail({
    entries: [...state.entries.slice(0, state.index + 1), entry],
    index: state.index + 1,
  });
}

function findByHistoryIdx(state: NavigationTrailState, entry: NavigationTrailEntry): number {
  if (entry.historyIdx === undefined) return -1;
  return state.entries.findIndex(
    (candidate) => candidate.key === entry.key && candidate.historyIdx === entry.historyIdx
  );
}

function recordPop(
  state: NavigationTrailState,
  entry: NavigationTrailEntry,
  current: NavigationTrailEntry
): NavigationTrailState {
  const exact = findByHistoryIdx(state, entry);
  if (exact >= 0) return withEntry(state, exact, entry);

  const backward =
    entry.historyIdx !== undefined && current.historyIdx !== undefined
      ? entry.historyIdx < current.historyIdx
      : undefined;

  if (backward !== false && state.entries[state.index - 1]?.key === entry.key) {
    return withEntry(state, state.index - 1, entry);
  }
  if (backward !== true && state.entries[state.index + 1]?.key === entry.key) {
    return withEntry(state, state.index + 1, entry);
  }
  if (backward !== false) {
    for (let position = state.index - 2; position >= 0; position -= 1) {
      if (state.entries[position].key === entry.key) return withEntry(state, position, entry);
    }
  }
  if (backward !== true) {
    for (let position = state.index + 2; position < state.entries.length; position += 1) {
      if (state.entries[position].key === entry.key) return withEntry(state, position, entry);
    }
  }

  if (backward) {
    // Back onto a page the trail never saw: it sits before the page the user left.
    const entries = state.entries.slice();
    entries.splice(state.index, 0, entry);
    return capTrail({ entries, index: state.index });
  }
  return capTrail({
    entries: [...state.entries.slice(0, state.index + 1), entry],
    index: state.index + 1,
  });
}

export type BackStep =
  | { kind: "history"; url: string }
  | { kind: "url"; url: string; nextState: NavigationTrailState };

/**
 * How the page back arrow leaves the current page, or null when the trail has no earlier page.
 * Browser back is used only when the previous browser entry is that page; otherwise the page is
 * opened by URL and the current entry is dropped first, so repeated Back keeps walking back.
 */
export function planBackStep(
  state: NavigationTrailState,
  currentHistoryIdx: number | undefined
): BackStep | null {
  if (state.index <= 0) return null;
  const current = state.entries[state.index];
  const previous = state.entries[state.index - 1];
  if (!current || !previous) return null;

  if (
    currentHistoryIdx !== undefined &&
    previous.historyIdx !== undefined &&
    current.historyIdx === currentHistoryIdx &&
    previous.historyIdx === currentHistoryIdx - 1
  ) {
    return { kind: "history", url: previous.url };
  }

  return {
    kind: "url",
    url: previous.url,
    nextState: { entries: state.entries.slice(0, state.index), index: state.index - 1 },
  };
}

function pathOfUrl(url: string): string {
  const end = url.search(/[?#]/);
  return normalizePath(end >= 0 ? url.slice(0, end) : url);
}

function isUnderPath(path: string, prefix: string): boolean {
  const base = normalizePath(prefix);
  return path === base || path.startsWith(base === "/" ? "/" : `${base}/`);
}

export interface LeavePlanInput {
  trail: NavigationTrailState;
  /** Path of the page being left (its resource is gone or moved away). */
  pathname: string;
  /** Browser history index of the current entry, when the router exposes one. */
  historyIdx: number | undefined;
  /** `returnTo` of the current link state, already checked by the caller or not. */
  returnTo: string | null;
  /** The page's list or logical parent, used when nothing else applies. */
  fallback: string;
  /** Further paths that are gone with the page (pages of a deleted node, app, ...). */
  gonePaths?: readonly string[];
}

export type LeaveStep =
  | { kind: "history"; url: string }
  | { kind: "url"; url: string; nextState?: NavigationTrailState };

/**
 * Where a page goes when its resource is deleted or otherwise gone: the page the user opened it
 * from (an app tab, an environment, a node, a folder, search...), skipping pages that are gone
 * too, then a `returnTo` link state, then the fallback. Only console paths are ever returned.
 * A `url` step replaces the current history entry, so Back never lands on the deleted page.
 */
export function planLeaveStep(input: LeavePlanInput): LeaveStep {
  const currentKey = pageKeyForPath(pathOfUrl(input.pathname));
  const gonePaths = input.gonePaths ?? [];
  const isGone = (url: string) => {
    if (!isSafeInternalPath(url)) return true;
    const path = pathOfUrl(url);
    if (pageKeyForPath(path) === currentKey) return true;
    return gonePaths.some((prefix) => isUnderPath(path, prefix));
  };

  const { trail } = input;
  const current = trail.entries[trail.index];
  if (current && current.key === currentKey) {
    for (let position = trail.index - 1; position >= 0; position -= 1) {
      const candidate = trail.entries[position];
      if (isGone(candidate.url)) continue;
      if (
        position === trail.index - 1 &&
        input.historyIdx !== undefined &&
        current.historyIdx === input.historyIdx &&
        candidate.historyIdx === input.historyIdx - 1
      ) {
        return { kind: "history", url: candidate.url };
      }
      return {
        kind: "url",
        url: candidate.url,
        nextState: { entries: trail.entries.slice(0, position + 1), index: position },
      };
    }
  }

  if (input.returnTo && !isGone(input.returnTo)) return { kind: "url", url: input.returnTo };
  return { kind: "url", url: isSafeInternalPath(input.fallback) ? input.fallback : "/" };
}

/** Parses a persisted trail, dropping anything malformed. */
export function parseNavigationTrail(value: unknown): NavigationTrailState {
  if (!value || typeof value !== "object") return EMPTY_NAVIGATION_TRAIL;
  const raw = value as { entries?: unknown; index?: unknown };
  if (!Array.isArray(raw.entries) || typeof raw.index !== "number") return EMPTY_NAVIGATION_TRAIL;
  const entries: NavigationTrailEntry[] = [];
  for (const item of raw.entries) {
    const candidate = item as Partial<NavigationTrailEntry> | null;
    if (!candidate || typeof candidate.key !== "string" || !isSafeInternalPath(candidate.url)) {
      return EMPTY_NAVIGATION_TRAIL;
    }
    entries.push({
      key: candidate.key,
      url: candidate.url,
      ...(typeof candidate.historyIdx === "number" ? { historyIdx: candidate.historyIdx } : {}),
    });
  }
  if (entries.length === 0) return EMPTY_NAVIGATION_TRAIL;
  const index = Math.min(Math.max(0, Math.trunc(raw.index)), entries.length - 1);
  return capTrail({ entries, index });
}

/** Pages of a resource that can be an app member, opened from an app or from another such page. */
const APP_MEMBER_PAGE_IDS = new Set([
  "route",
  "page-project",
  "database",
  "storage-detail",
  "docker-compose",
  "docker-container",
  "docker-deployment",
  "docker-volume",
]);

function pageIdOf(key: string): string {
  return key.split("|")[0];
}

/**
 * The app page a member page was opened from: the current page is a member resource reached from an app (or
 * an environment) through member pages only. The sidebar then keeps Apps selected. Null when the page was reached
 * from its own list, the dashboard or anything else, and for every page that is not a member resource.
 */
export function appContextOf(state: NavigationTrailState): string | null {
  for (let position = state.index; position >= 0; position -= 1) {
    const id = pageIdOf(state.entries[position].key);
    if (id === "app" || id === "app-environment")
      return position === state.index ? null : state.entries[position].url;
    if (!APP_MEMBER_PAGE_IDS.has(id)) return null;
  }
  return null;
}
