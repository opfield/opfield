import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_PAGE_CONTEXT_EXEMPT_PATHS,
  AI_PAGE_ROUTES,
  NO_PAGE_CONTEXT,
  resolveAIPageContext,
} from "./ai-page-context";
import { NAVIGATION_HUBS } from "./navigation-hubs";

const srcDir = path.resolve(import.meta.dirname, "..");

describe("resolveAIPageContext: resource pages", () => {
  const published = (resourceType: string, resourceId: string, label?: string, nodeId?: string) =>
    ({ resourceType, resourceId, label, nodeId }) as never;

  it.each([
    ["/nodes/edge-1/overview", "node", "n-1", "edge-1"],
    ["/databases/orders", "database", "db-1", "orders"],
    ["/storage/media/browser", "storage", "s-1", "media"],
    ["/proxy-hosts/shop/settings", "proxy-host", "r-1", "shop.example.com"],
    ["/pages/docs/deployments", "page-project", "p-1", "Docs"],
    ["/logging/environments/prod/explore", "logging-environment", "le-1", "prod"],
    ["/logging/schemas/http", "logging-schema", "ls-1", "http"],
    ["/docker/containers/edge-1/web/logs", "docker-container", "c-1", "web"],
    ["/docker/deployments/edge-1/api", "docker-deployment", "d-1", "api"],
    ["/docker/volumes/edge-1/data.v2", "docker-volume", "data.v2", "data.v2"],
    ["/docker/compose/cp-1/services", "docker-compose-project", "cp-1", "shop-stack"],
    ["/apps/shop/activity", "app", "a-1", "Shop"],
    ["/apps/shop/env/production", "app-environment", "e-1", "production of Shop"],
    ["/ingress-groups/ig-1", "ingress-group", "ig-1", "Edge"],
    ["/cas/ca-1", "ca", "ca-1", "Root CA"],
    ["/certificates/cert-1", "certificate", "cert-1", "api.internal"],
  ])("%s sends the published %s", (route, resourceType, resourceId, label) => {
    const result = resolveAIPageContext(
      route,
      published(resourceType, resourceId, label, "node-1")
    );
    expect(result.context).toEqual({
      route,
      resourceType,
      resourceId,
      label,
      nodeId: "node-1",
    });
    expect(result.viewing).toBe(label);
  });

  it.each([
    ["/apps/shop", "app", "shop", "app"],
    ["/apps/shop/members", "app", "shop", "app"],
    ["/cas/ca-1", "ca", "ca-1", "certificate authority"],
    ["/certificates/cert-1", "certificate", "cert-1", "certificate"],
    ["/ingress-groups/ig-1", "ingress-group", "ig-1", "ingress group"],
    ["/docker/compose/cp-1", "docker-compose-project", "cp-1", "Compose project"],
    ["/nginx-templates/t-1", "nginx-template", "t-1", "route template"],
    ["/hosting/conn-1/servers", "hosting-connector", "conn-1", "hosting account"],
  ])("%s falls back to the id in the URL", (route, resourceType, resourceId, noun) => {
    const result = resolveAIPageContext(route, null);
    expect(result.context).toEqual({ route, resourceType, resourceId });
    expect(result.viewing).toBe(noun);
  });

  it.each([
    "/nodes/edge-1",
    "/databases/orders",
    "/docker/containers/edge-1/web",
    "/apps/shop/env/production",
  ])("%s shows no resource until the page publishes it", (route) => {
    expect(resolveAIPageContext(route, null)).toEqual({ context: { route }, viewing: null });
  });

  it("ignores a published resource of another kind", () => {
    const result = resolveAIPageContext(
      "/apps/shop/env/production",
      published("app", "a-1", "Shop")
    );
    expect(result).toEqual({ context: { route: "/apps/shop/env/production" }, viewing: null });
  });

  it("names the resource kind when the published resource has no name", () => {
    expect(resolveAIPageContext("/nodes/edge-1", published("node", "n-1")).viewing).toBe("node");
  });
});

describe("resolveAIPageContext: list and section pages", () => {
  it.each([
    ["/", "Dashboard"],
    ["/dashboard", "Dashboard"],
    ["/apps", "Apps"],
    ["/routes", "Routes"],
    ["/routes/domains", "Domains"],
    ["/routes/ingress-groups", "Ingress Groups"],
    ["/routes/access-lists", "Access Lists"],
    ["/routes/templates", "Route Templates"],
    ["/routes/new", "New Route"],
    ["/certificates", "SSL Certificates"],
    ["/certificates/authorities", "Certificate Authorities"],
    ["/certificates/pki", "PKI Certificates"],
    ["/certificates/templates", "Certificate Templates"],
    ["/pages", "Pages"],
    ["/nginx-templates/new", "New Route Template"],
    ["/databases", "Databases"],
    ["/storage", "Storage"],
    ["/nodes", "Nodes"],
    ["/docker", "Docker"],
    ["/docker/containers", "Docker Containers"],
    ["/docker/images", "Docker Images"],
    ["/docker/networks", "Docker Networks"],
    ["/docker/volumes", "Docker Volumes"],
    ["/docker/compose", "Compose Projects"],
    ["/logging", "Logging"],
    ["/logging/schemas", "Logging Schemas"],
    ["/administration", "Administration"],
    ["/administration/users", "Users"],
    ["/administration/groups", "Groups"],
    ["/notifications", "Notifications"],
    ["/notifications/alerts", "Alert Rules"],
    ["/status-page", "Status Page"],
    ["/status-page/incidents", "Status Page Incidents"],
    ["/settings", "Settings"],
    ["/settings/ai", "AI Settings"],
    ["/profile/sessions", "Profile"],
  ])("%s is %s", (route, title) => {
    expect(resolveAIPageContext(route, null)).toEqual({
      context: { route, label: title },
      viewing: title,
    });
  });

  it("falls back to the page title for an unknown tab", () => {
    expect(resolveAIPageContext("/settings/unknown", null).viewing).toBe("Settings");
  });

  it("sends only the route for paths without page context", () => {
    expect(resolveAIPageContext("/ai/chats/abc", null)).toEqual({
      context: { route: "/ai/chats/abc" },
      viewing: null,
    });
  });

  it("leaves the page out entirely when excluded", () => {
    expect(NO_PAGE_CONTEXT).toEqual({ route: "" });
  });
});

describe("AI_PAGE_ROUTES coverage", () => {
  const appSource = readFileSync(path.join(srcDir, "App.tsx"), "utf8");
  const layoutStart = appSource.indexOf("<Route element={<DashboardLayout");
  const layoutEnd = appSource.indexOf('<Route path="*"', layoutStart);
  const dashboardRoutes = [
    ...appSource.slice(layoutStart, layoutEnd).matchAll(/\bpath="([^"]+)"/g),
  ].map((match) => match[1]);
  const covered = new Set([
    ...AI_PAGE_ROUTES.map((entry) => entry.path),
    ...AI_PAGE_CONTEXT_EXEMPT_PATHS,
  ]);

  it("covers every dashboard route in App.tsx", () => {
    expect(layoutStart).toBeGreaterThan(0);
    expect(dashboardRoutes.length).toBeGreaterThan(30);
    expect(dashboardRoutes.filter((route) => !covered.has(route))).toEqual([]);
  });

  it("covers every navigation hub tab", () => {
    const hubPaths = NAVIGATION_HUBS.flatMap((hub) => hub.tabs.map((tab) => tab.path));
    expect(hubPaths.filter((route) => !covered.has(route))).toEqual([]);
  });

  it("has a publisher for every resource that needs one", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (
          /\.tsx?$/.test(name) &&
          !/\.test\.tsx?$/.test(name) &&
          // The route table and the store's type union name every type; a publisher must too.
          !name.startsWith("ai-page-context") &&
          name !== "resolved-page-context.ts"
        )
          sources.push(readFileSync(file, "utf8"));
      }
    };
    walk(srcDir);
    const all = sources.join("\n");
    const unpublished = AI_PAGE_ROUTES.flatMap((entry) =>
      "resource" in entry && !entry.resource.idParam ? [entry.resource.resourceType] : []
    ).filter((type) => !all.includes(`"${type}"`));
    expect(unpublished).toEqual([]);
  });
});
