import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_HUBS } from "@/lib/navigation-hubs";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import type { User } from "@/types";
import { LegacyNavigationRedirect, NavigationHubPage } from "./NavigationHubPage";

// The tab bodies are the existing pages; here each one is its header plus the hub tab row.
const stubPage = vi.hoisted(
  () => async (name: string, title: (props: Record<string, unknown>) => string) => {
    const React = await import("react");
    const { HubTabs } = await vi.importActual<typeof import("@/components/common/HubTabs")>(
      "@/components/common/HubTabs"
    );
    return {
      [name]: (props: Record<string, unknown>) =>
        React.createElement(
          "div",
          null,
          React.createElement("h1", null, title(props)),
          React.createElement(HubTabs)
        ),
    };
  }
);

vi.mock("@/pages/ProxyHosts", () =>
  stubPage("ProxyHosts", (props) => (props.initialCreateDialogOpen ? "Routes (create)" : "Routes"))
);
vi.mock("@/pages/Domains", () => stubPage("Domains", () => "Domains"));
vi.mock("@/pages/IngressGroups", () => stubPage("IngressGroups", () => "Ingress Groups"));
vi.mock("@/pages/AccessLists", () => stubPage("AccessLists", () => "Access Lists"));
vi.mock("@/pages/SSLCertificates", () => stubPage("SSLCertificates", () => "SSL Certificates"));
vi.mock("@/pages/CAs", () => stubPage("CAs", () => "Certificate Authorities"));
vi.mock("@/pages/Certificates", () => stubPage("Certificates", () => "PKI Certificates"));
vi.mock("@/pages/TemplatesPage", () =>
  stubPage("TemplatesPage", (props) => `${String(props.kind)} templates`)
);

function CurrentUrl() {
  const location = useLocation();
  return <output data-testid="url">{`${location.pathname}${location.search}`}</output>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<p>Start page</p>} />
        {NAVIGATION_HUBS.flatMap((hub) =>
          hub.tabs.map((tab) => (
            <Route
              key={tab.path}
              path={tab.path}
              element={<NavigationHubPage hubId={hub.id} tab={tab.value} />}
            />
          ))
        )}
        <Route
          path="/routes/new"
          element={<NavigationHubPage hubId="routes" tab="routes" create />}
        />
        {["/proxy-hosts", "/proxy-hosts/new", "/cas", "/ingress-groups"].map((path) => (
          <Route key={path} path={path} element={<LegacyNavigationRedirect />} />
        ))}
        {["/domains/*", "/ssl-certificates/*", "/access-lists/*", "/templates/*"].map((path) => (
          <Route key={path} path={path} element={<LegacyNavigationRedirect />} />
        ))}
      </Routes>
      <CurrentUrl />
    </MemoryRouter>
  );
}

function signIn(scopes: string[], pkiEnabled = true) {
  useAuthStore.setState({ user: { id: "user-1", scopes } as unknown as User });
  useSystemConfigStore.getState().setConfig({
    features: { ...useSystemConfigStore.getState().config.features, pkiEnabled },
  });
}

const tabNames = () =>
  within(screen.getByRole("tablist"))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

describe("Routes page", () => {
  beforeEach(() => {
    signIn([
      "proxy:view",
      "domains:view",
      "ingress:groups:view",
      "acl:view",
      "proxy:templates:view",
    ]);
  });

  it("shows the five text tabs with the open one selected", async () => {
    renderAt("/routes");
    expect(await screen.findByRole("heading", { name: "Routes" })).toBeInTheDocument();
    expect(tabNames()).toEqual([
      "Routes",
      "Domains",
      "Ingress Groups",
      "Access Lists",
      "Templates",
    ]);
    expect(screen.getByRole("tab", { name: "Routes" })).toHaveAttribute("aria-selected", "true");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.querySelector("svg")).toBeNull();
    }
  });

  it("switches tabs by URL", async () => {
    renderAt("/routes");
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Domains" }));
    expect(await screen.findByRole("heading", { name: "Domains" })).toBeInTheDocument();
    expect(screen.getByTestId("url")).toHaveTextContent("/routes/domains");
  });

  it("opens the nginx templates on the Templates tab", async () => {
    renderAt("/routes/templates");
    expect(await screen.findByRole("heading", { name: "nginx templates" })).toBeInTheDocument();
  });

  it("opens the create dialog from /routes/new", async () => {
    renderAt("/routes/new");
    expect(await screen.findByRole("heading", { name: "Routes (create)" })).toBeInTheDocument();
  });
});

describe("per-tab permissions", () => {
  it("shows a Domains-only user the Routes page with only Domains", async () => {
    signIn(["domains:view"]);
    renderAt("/routes");
    expect(await screen.findByRole("heading", { name: "Domains" })).toBeInTheDocument();
    expect(screen.getByTestId("url")).toHaveTextContent("/routes/domains");
    expect(tabNames()).toEqual(["Domains"]);
  });

  it("moves a user off a tab they may not open", async () => {
    signIn(["proxy:view", "acl:view"]);
    renderAt("/routes/ingress-groups");
    expect(await screen.findByRole("heading", { name: "Routes" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["Routes", "Access Lists"]);
  });

  it("hides the PKI tabs while PKI is off", async () => {
    signIn(["ssl:cert:view", "pki:ca:view", "pki:cert:view", "pki:templates:view"], false);
    renderAt("/certificates/authorities");
    expect(await screen.findByRole("heading", { name: "SSL Certificates" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["SSL"]);
  });

  it("shows all four Certificates tabs with PKI on", async () => {
    signIn(["ssl:cert:view", "pki:ca:view", "pki:cert:view", "pki:templates:view"]);
    renderAt("/certificates/templates");
    expect(await screen.findByRole("heading", { name: "pki templates" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["SSL", "Authorities", "PKI Certificates", "Templates"]);
  });

  it("sends a user with no tab back to the start page", async () => {
    signIn(["apps:view"]);
    renderAt("/certificates");
    expect(await screen.findByText("Start page")).toBeInTheDocument();
  });
});

describe("old URLs", () => {
  beforeEach(() => {
    signIn([
      "proxy:view",
      "domains:view",
      "ingress:groups:view",
      "acl:view",
      "proxy:templates:view",
      "ssl:cert:view",
      "pki:ca:view",
      "pki:cert:view",
      "pki:templates:view",
    ]);
  });

  it.each([
    ["/proxy-hosts", "/routes", "Routes"],
    ["/proxy-hosts/new", "/routes/new", "Routes (create)"],
    ["/domains?domain=app.example.com", "/routes/domains?domain=app.example.com", "Domains"],
    ["/domains/app.example.com", "/routes/domains?domain=app.example.com", "Domains"],
    ["/ingress-groups", "/routes/ingress-groups", "Ingress Groups"],
    ["/access-lists", "/routes/access-lists", "Access Lists"],
    ["/templates/nginx", "/routes/templates", "nginx templates"],
    ["/ssl-certificates", "/certificates", "SSL Certificates"],
    ["/ssl-certificates?certificate=c1", "/certificates?certificate=c1", "SSL Certificates"],
    ["/cas", "/certificates/authorities", "Certificate Authorities"],
    ["/templates/pki", "/certificates/templates", "pki templates"],
    ["/templates", "/routes/templates", "nginx templates"],
    ["/certificates?ca=ca1", "/certificates/pki?ca=ca1", "PKI Certificates"],
    ["/certificates?status=expired", "/certificates/pki?status=expired", "PKI Certificates"],
  ])("%s opens %s", async (from, to, heading) => {
    renderAt(from);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("url")).toHaveTextContent(to));
  });
});
