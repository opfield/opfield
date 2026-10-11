import { describe, expect, it } from "vitest";
import {
  CERTIFICATES_HUB,
  hubTabForPath,
  legacyNavigationRedirect,
  legacyPathForPath,
  ROUTES_HUB,
  visibleHubTabs,
} from "./navigation-hubs";

const ALL_SCOPES = [
  "proxy:view",
  "domains:view",
  "ingress:groups:view",
  "acl:view",
  "proxy:templates:view",
  "ssl:cert:view",
  "pki:ca:view",
  "pki:cert:view",
  "pki:templates:view",
];
const everyone = { scopes: ALL_SCOPES, pkiEnabled: true };
const redirect = (url: string, context = everyone) => {
  const parsed = new URL(url, "https://gateway.test");
  return legacyNavigationRedirect(
    { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash },
    context
  );
};

describe("old page URLs", () => {
  it.each([
    ["/proxy-hosts", "/routes"],
    ["/proxy-hosts/new", "/routes/new"],
    ["/domains", "/routes/domains"],
    ["/ingress-groups", "/routes/ingress-groups"],
    ["/access-lists", "/routes/access-lists"],
    ["/templates/nginx", "/routes/templates"],
    ["/ssl-certificates", "/certificates"],
    ["/cas", "/certificates/authorities"],
    ["/templates/pki", "/certificates/templates"],
  ])("%s goes to %s", (from, to) => {
    expect(redirect(from)).toBe(to);
  });

  it("keeps the query and hash", () => {
    expect(redirect("/domains?domain=app.example.com#dns")).toBe(
      "/routes/domains?domain=app.example.com#dns"
    );
    expect(redirect("/ssl-certificates?certificate=c1")).toBe("/certificates?certificate=c1");
  });

  it("opens a domain link on the Domains tab", () => {
    expect(redirect("/domains/app.example.com")).toBe("/routes/domains?domain=app.example.com");
  });

  it("opens an SSL certificate link on the SSL tab", () => {
    expect(redirect("/ssl-certificates/c1")).toBe("/certificates?certificate=c1");
  });

  it("leaves detail pages where they are", () => {
    for (const path of [
      "/proxy-hosts/app-example-com",
      "/proxy-hosts/app-example-com/logs",
      "/ingress-groups/g1",
      "/cas/ca1",
      "/certificates/c1",
      "/nginx-templates/t1",
      "/profile",
    ]) {
      expect(redirect(path)).toBeNull();
    }
  });

  it("sends /templates to the templates the user may see", () => {
    expect(redirect("/templates")).toBe("/routes/templates");
    expect(redirect("/templates", { scopes: ["pki:templates:view"], pkiEnabled: true })).toBe(
      "/certificates/templates"
    );
    expect(redirect("/templates", { scopes: ["pki:templates:view"], pkiEnabled: false })).toBe("/");
  });
});

describe("hub tabs", () => {
  it("lists the approved tabs in order", () => {
    expect(ROUTES_HUB.tabs.map((tab) => tab.label)).toEqual([
      "Routes",
      "Domains",
      "Ingress Groups",
      "Access Lists",
      "Templates",
    ]);
    expect(CERTIFICATES_HUB.tabs.map((tab) => tab.label)).toEqual([
      "SSL",
      "Authorities",
      "PKI Certificates",
      "Templates",
    ]);
  });

  it("keeps each former page's permission per tab", () => {
    const routes = (scopes: string[]) =>
      visibleHubTabs(ROUTES_HUB, { scopes, pkiEnabled: true }).map((tab) => tab.value);
    expect(routes(["domains:view"])).toEqual(["domains"]);
    expect(routes(["proxy:folders:manage"])).toEqual(["routes"]);
    expect(routes(["proxy:view:r1"])).toEqual(["routes"]);
    expect(routes(["ingress:groups:view", "acl:view"])).toEqual(["ingress-groups", "access-lists"]);
    expect(routes(["proxy:templates:view"])).toEqual(["templates"]);
    expect(routes(["pki:templates:view"])).toEqual([]);

    const certificates = (scopes: string[], pkiEnabled = true) =>
      visibleHubTabs(CERTIFICATES_HUB, { scopes, pkiEnabled }).map((tab) => tab.value);
    expect(certificates(["ssl:cert:view"])).toEqual(["ssl"]);
    expect(certificates(["pki:ca:view:ca1"])).toEqual(["authorities"]);
    expect(certificates(["pki:cert:view", "pki:templates:view"])).toEqual(["pki", "templates"]);
    expect(certificates(["pki:ca:view", "pki:cert:view", "pki:templates:view"], false)).toEqual([]);
  });

  it("maps tab URLs back to the page URLs they replaced", () => {
    expect(hubTabForPath("/routes/domains")?.tab.value).toBe("domains");
    expect(hubTabForPath("/certificates/")?.tab.value).toBe("ssl");
    expect(hubTabForPath("/certificates/c1")).toBeNull();
    expect(legacyPathForPath("/routes")).toBe("/proxy-hosts");
    expect(legacyPathForPath("/certificates")).toBe("/ssl-certificates");
    expect(legacyPathForPath("/certificates/pki")).toBe("/certificates");
    expect(legacyPathForPath("/certificates/authorities")).toBe("/cas");
    expect(legacyPathForPath("/nodes")).toBe("/nodes");
  });
});
