import { describe, expect, it } from "vitest";
import {
  APP_NAVIGATION_GROUPS,
  type AppNavigationVisibility,
  globalSectionScopes,
  hasDashboardContent,
  keyboardNavigationRoutes,
  visibleNavigationGroups,
} from "./app-navigation";
import { isSidebarNavigationActive } from "./sidebar-navigation";

const context = (
  scopes: string[],
  extra: Partial<AppNavigationVisibility> = {}
): AppNavigationVisibility => ({
  scopes,
  pkiEnabled: false,
  siemEnabled: false,
  loggingEnabled: false,
  inferenceEnabled: false,
  ...extra,
});

const items = (ctx: AppNavigationVisibility) =>
  visibleNavigationGroups(ctx).flatMap((group) => group.items);
const item = (ctx: AppNavigationVisibility, id: string) =>
  items(ctx).find((candidate) => candidate.id === id);

describe("sidebar", () => {
  it("has the approved 14 items in four groups", () => {
    expect(
      APP_NAVIGATION_GROUPS.map((group) => [group.label, group.items.map((entry) => entry.name)])
    ).toEqual([
      ["Main", ["Dashboard", "Apps"]],
      ["Ingress", ["Routes", "Certificates"]],
      ["Resources", ["Docker", "Pages", "Databases", "Storage", "Logging", "Nodes"]],
      ["Management", ["Notifications", "Status Page", "Administration", "Settings"]],
    ]);
  });

  it("has no Profile item; Profile lives in the account menu", () => {
    const names = APP_NAVIGATION_GROUPS.flatMap((group) => group.items.map((entry) => entry.name));
    expect(names).not.toContain("Profile");
  });
});

describe("Apps navigation item", () => {
  it("shows for users who may view or create apps only", () => {
    const hasApps = (scopes: string[]) => item(context(scopes), "apps") !== undefined;
    expect(hasApps(["apps:view"])).toBe(true);
    expect(hasApps(["apps:create"])).toBe(true);
    expect(hasApps(["proxy:view"])).toBe(false);
  });

  it("shows for users who see an app only through members they can view", () => {
    const scopes = ["docker:containers:view:folder/env-folder"];
    expect(item(context(scopes), "apps")).toBeUndefined();
    expect(item(context(scopes, { appsByMembers: false }), "apps")).toBeUndefined();
    expect(item(context(scopes, { appsByMembers: true }), "apps")?.href).toBe("/apps");
  });
});

describe("Routes and Certificates items", () => {
  it("show when the user may open any of their tabs, linking to the first one", () => {
    expect(item(context(["proxy:view"]), "proxy-hosts")?.href).toBe("/routes");
    expect(item(context(["domains:view"]), "proxy-hosts")?.href).toBe("/routes/domains");
    expect(item(context(["acl:view"]), "proxy-hosts")?.href).toBe("/routes/access-lists");
    expect(item(context(["proxy:templates:view"]), "proxy-hosts")?.href).toBe("/routes/templates");
    expect(item(context(["apps:view"]), "proxy-hosts")).toBeUndefined();

    expect(item(context(["ssl:cert:view"]), "ssl-certificates")?.href).toBe("/certificates");
    expect(item(context(["pki:ca:view"], { pkiEnabled: true }), "ssl-certificates")?.href).toBe(
      "/certificates/authorities"
    );
    expect(item(context(["pki:ca:view"]), "ssl-certificates")).toBeUndefined();
  });

  it("stay highlighted on every tab and on their detail pages", () => {
    const routes = item(context(["domains:view"]), "proxy-hosts");
    const certificates = item(context(["ssl:cert:view"]), "ssl-certificates");
    const active = (entry: typeof routes, pathname: string) =>
      !!entry && isSidebarNavigationActive(pathname, entry.href, entry.activePaths);

    for (const path of [
      "/routes",
      "/routes/domains",
      "/routes/templates",
      "/proxy-hosts/app-example-com/logs",
      "/ingress-groups/g1",
      "/nginx-templates/t1",
    ]) {
      expect(active(routes, path)).toBe(true);
      expect(active(certificates, path)).toBe(false);
    }
    for (const path of ["/certificates", "/certificates/pki", "/certificates/c1", "/cas/ca1"]) {
      expect(active(certificates, path)).toBe(true);
      expect(active(routes, path)).toBe(false);
    }
    expect(active(routes, "/routesx")).toBe(false);
  });
});

describe("global sections for users limited to apps", () => {
  // Effective scopes of an "In an app environment" line: the folder grants on the environment's
  // hidden folders and the resource grants they expand to, plus the app scopes.
  const APP_LINE = [
    "apps:view:env/env-1",
    "docker:containers:view:folder/env-docker",
    "docker:containers:view:node-1/container-1",
    "docker:compose:view:folder/env-compose",
    "proxy:view:folder/env-routes",
    "proxy:view:route-1",
    "proxy:create:folder/env-routes",
    "databases:view:folder/env-databases",
    "databases:view:database-1",
    "storage:view:folder/env-storage",
    "storage:view:storage-1",
    "pages:view:folder/env-pages",
  ];
  // What the UI bootstrap reports for those scopes alone.
  const APP_ONLY = [
    "databases:view",
    "docker:compose:view",
    "docker:containers:view",
    "pages:view",
    "proxy:create",
    "proxy:view",
    "storage:view",
  ];
  const GLOBAL_IDS = ["proxy-hosts", "docker", "pages", "databases", "storage"];
  const ids = (ctx: AppNavigationVisibility) => items(ctx).map((entry) => entry.id);
  const appUser = (scopes: string[], appOnlyScopeBases: string[]) =>
    context(scopes, { pagesEnabled: true, appOnlyScopeBases });

  it("shows Apps only, without the sections the app grants reach", () => {
    expect(ids(appUser(APP_LINE, APP_ONLY))).toEqual(["apps"]);
    expect(hasDashboardContent(appUser(APP_LINE, APP_ONLY))).toBe(false);
    expect(keyboardNavigationRoutes(appUser(APP_LINE, APP_ONLY))).toEqual({});
  });

  it("showed those sections before the bootstrap could tell app places apart", () => {
    expect(ids(context(APP_LINE, { pagesEnabled: true }))).toEqual(
      expect.arrayContaining(["apps", ...GLOBAL_IDS])
    );
  });

  it("keeps a section the user also reaches outside the app", () => {
    // Storage also granted on a user folder: the bootstrap keeps storage:view.
    const mixed = appUser(
      [...APP_LINE, "storage:view:folder/team-folder"],
      APP_ONLY.filter((base) => base !== "storage:view")
    );
    expect(ids(mixed)).toEqual(["apps", "storage"]);
    // A resource grant outside the app: the bootstrap keeps databases:view, and only that family.
    expect(
      ids(
        appUser(
          [...APP_LINE, "databases:view:database-9"],
          APP_ONLY.filter((base) => base !== "databases:view")
        )
      )
    ).toEqual(["apps", "databases"]);
  });

  it("keeps every section for broad scopes", () => {
    const broad = [...APP_LINE, "proxy:view", "docker:containers:view", "storage:view"];
    const bases = APP_ONLY.filter(
      (base) => !["proxy:view", "docker:containers:view", "storage:view"].includes(base)
    );
    expect(ids(appUser(broad, bases))).toEqual(
      expect.arrayContaining(["dashboard", "apps", "proxy-hosts", "docker", "storage"])
    );
    expect(ids(appUser(broad, bases))).not.toContain("databases");
    expect(keyboardNavigationRoutes(appUser(broad, bases))).toMatchObject({
      "3": "/routes",
      "8": "/docker",
    });
  });

  it("filters only the app-only bases, so an implied global view still counts", () => {
    const scopes = ["storage:edit:folder/env-storage", "storage:edit:storage-1", "storage:view:x"];
    expect(globalSectionScopes(scopes, ["storage:edit"])).toEqual(["storage:view:x"]);
    expect(globalSectionScopes(scopes, [])).toBe(scopes);
    expect(globalSectionScopes(scopes, undefined)).toBe(scopes);
    // An app-only edit grant does not open Storage through the view it implies.
    expect(ids(appUser(["storage:edit:folder/env-storage"], ["storage:edit"]))).toEqual([]);
  });
});
