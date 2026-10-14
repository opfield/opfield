import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppCreateContext } from "@/components/apps/app-create-context";
import type { AppEnvironmentDetail, Node, RouteIngressGroupOption } from "@/types";
import { CreateProxyHostDialog } from "./CreateProxyHostDialog";

const api = vi.hoisted(() => ({
  getCached: vi.fn(() => undefined),
  setCache: vi.fn(),
  listRouteIngressGroups: vi.fn(),
  listNodes: vi.fn(),
  listSSLCertificates: vi.fn(async () => ({ data: [] })),
  listNginxTemplates: vi.fn(async () => []),
  listDockerContainerSnapshots: vi.fn(async () => []),
  listDockerComposeProjects: vi.fn(async () => []),
  listFolders: vi.fn(async () => []),
  searchDomains: vi.fn(async () => ({ data: [] })),
  listPageProjects: vi.fn(async () => ({ data: [] })),
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/stores/auth", () => {
  const auth = {
    user: { id: "user-1", scopes: ["proxy:create"] },
    hasScope: () => true,
    hasScopedAccess: () => true,
  };
  return {
    useAuthStore: (selector?: (value: typeof auth) => unknown) =>
      selector ? selector(auth) : auth,
  };
});

// Radix Select scrolls the picked item into view, which jsdom does not implement.
Element.prototype.scrollIntoView = () => undefined;

const nginx = (id: string, hostname: string): Node =>
  ({
    id,
    hostname,
    displayName: hostname,
    type: "nginx",
    status: "online",
    serviceCreationLocked: false,
    capabilities: {},
  }) as unknown as Node;

const group = (id: string, name: string, memberIds: string[]): RouteIngressGroupOption => ({
  id,
  name,
  slug: id,
  dnsFailoverMode: "none",
  members: memberIds.map((memberId) => ({
    id: memberId,
    displayName: memberId,
    hostname: memberId,
    status: "online",
    state: "active",
  })) as RouteIngressGroupOption["members"],
});

const environment: AppEnvironmentDetail = {
  id: "env-live",
  slug: "live",
  name: "live",
  isProduction: true,
  maintenanceEnabled: false,
  health: "healthy",
  memberCounts: {},
  placementFolderIds: {
    containers: null,
    compose: null,
    routes: "folder-routes",
    databases: null,
    storage: null,
    pages: null,
    certificates: null,
    logging: null,
    domains: null,
  },
  allowedNodeIds: ["edge-1", "edge-2"],
};

const context: AppCreateContext = {
  app: { id: "app-1", slug: "shop", name: "Shop" },
  environments: [environment],
};

beforeEach(() => {
  window.localStorage.clear();
  api.listNodes.mockResolvedValue({
    data: [
      nginx("edge-1", "edge-fra-1"),
      nginx("edge-2", "edge-ams-1"),
      nginx("edge-3", "edge-lon-1"),
    ],
  });
  api.listRouteIngressGroups.mockResolvedValue([
    group("group-eu", "eu-edge", ["edge-1", "edge-2"]),
    group("group-all", "all-edge", ["edge-1", "edge-3"]),
  ]);
});

describe("Create Route from an app", () => {
  it("offers the allowed nginx nodes and only the groups whose members are all allowed", async () => {
    render(
      <MemoryRouter>
        <CreateProxyHostDialog open onOpenChange={() => undefined} appContext={context} />
      </MemoryRouter>
    );
    expect(
      await screen.findByText(
        "Only the nginx nodes and ingress groups allowed in live are offered."
      )
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Ingress node" }));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("edge-fra-1")).toBeInTheDocument();
    expect(within(listbox).getByText("edge-ams-1")).toBeInTheDocument();
    expect(within(listbox).getByText("eu-edge")).toBeInTheDocument();
    expect(within(listbox).queryByText("edge-lon-1")).not.toBeInTheDocument();
    expect(within(listbox).queryByText("all-edge")).not.toBeInTheDocument();
    expect(within(listbox).queryByText(/Automatic/)).not.toBeInTheDocument();
  });
});
