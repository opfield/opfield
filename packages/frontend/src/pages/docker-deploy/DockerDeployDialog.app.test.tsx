import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppCreateContext } from "@/components/apps/app-create-context";
import type { AppEnvironmentDetail, Node } from "@/types";
import { DockerDeployDialog } from "../DockerDeployDialog";

const state = vi.hoisted(() => ({ nodes: [] as Node[] }));

vi.mock("@/lib/docker-node-access", () => ({
  loadVisibleDockerNodes: vi.fn(async () => state.nodes),
}));
vi.mock("./useDockerDeployData", () => ({
  useDockerDeployData: () => ({
    checkingSourceAdmission: false,
    initialLoading: false,
    deployLocalImages: [],
    deployPullableImages: [],
    registries: [],
    sourceAdmission: null,
    sourceConnectorOptions: [],
    sourceLoadErrors: {},
    sourceRepositories: [],
    sourceRepositoriesLoading: false,
    sourceRepositoriesHint: null,
    onSourceRepositorySearch: () => undefined,
  }),
}));
vi.mock("@/stores/docker", () => ({
  useDockerStore: (selector: (value: { dockerNodes: Node[] }) => unknown) =>
    selector({ dockerNodes: [] }),
}));
vi.mock("@/stores/auth", () => {
  const auth = {
    user: { id: "user-1", scopes: ["docker:containers:create"] },
    hasScope: () => true,
    hasScopedAccess: () => true,
  };
  return {
    useAuthStore: (selector?: (value: typeof auth) => unknown) =>
      selector ? selector(auth) : auth,
  };
});

const node = (id: string, name: string): Node =>
  ({
    id,
    slug: id,
    hostname: name,
    displayName: name,
    type: "docker",
    status: "online",
    isConnected: true,
    serviceCreationLocked: false,
    capabilities: {},
  }) as unknown as Node;

const environment = (allowedNodeIds: string[]): AppEnvironmentDetail => ({
  id: "env-staging",
  slug: "staging",
  name: "staging",
  isProduction: false,
  maintenanceEnabled: false,
  health: "healthy",
  memberCounts: {},
  placementFolderIds: {
    containers: "folder-containers",
    compose: "folder-compose",
    routes: null,
    databases: null,
    storage: null,
    pages: null,
    certificates: null,
    logging: null,
  },
  allowedNodeIds,
});

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderDeploy(allowedNodeIds: string[]) {
  const context: AppCreateContext = {
    app: { id: "app-1", slug: "shop", name: "Shop" },
    environments: [environment(allowedNodeIds)],
    environmentId: "env-staging",
  };
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter initialEntries={["/apps/shop/compute"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <DockerDeployDialog open onOpenChange={onOpenChange} appContext={context} />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
  return { onOpenChange };
}

// Radix Select scrolls the picked item into view, which jsdom does not implement.
Element.prototype.scrollIntoView = () => undefined;

beforeEach(() => {
  window.localStorage.clear();
  state.nodes = [
    node("docker-1", "docker-fra-1"),
    node("docker-2", "docker-ams-1"),
    node("docker-3", "docker-lon-1"),
  ];
});

describe("Deploy from an app", () => {
  it("locks the node field to the only allowed Docker node", async () => {
    renderDeploy(["docker-2"]);
    expect(await screen.findByText("The only Docker node allowed in staging.")).toBeInTheDocument();
    const nodeField = screen.getByRole("combobox", { name: "Node" });
    await waitFor(() => expect(nodeField).toHaveValue("docker-ams-1"));
    expect(nodeField).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "App" })).toBeDisabled();
  });

  it("offers only the allowed Docker nodes when several are allowed", async () => {
    renderDeploy(["docker-1", "docker-3"]);
    expect(
      await screen.findByText("Only the 2 Docker nodes allowed in staging are offered.")
    ).toBeInTheDocument();
    const nodeField = screen.getByRole("combobox", { name: "Node" });
    expect(nodeField).toBeEnabled();
    await userEvent.click(nodeField);
    // Combobox options are buttons.
    expect(await screen.findByRole("button", { name: "docker-fra-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "docker-lon-1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "docker-ams-1" })).not.toBeInTheDocument();
  });

  it("blocks creation and links to Allow Node when no Docker node is allowed", async () => {
    const { onOpenChange } = renderDeploy([]);
    expect(await screen.findByText("No Docker node is allowed in staging")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Node" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Allow a node" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("location")).toHaveTextContent("/apps/shop/env/staging?allow=node");
  });
});
