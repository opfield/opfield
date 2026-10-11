import { describe, expect, it } from "vitest";
import {
  APP_NAVIGATION_GROUPS,
  type AppNavigationVisibility,
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
