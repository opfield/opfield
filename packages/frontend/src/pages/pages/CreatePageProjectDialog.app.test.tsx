import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppCreateContext } from "@/components/apps/app-create-context";
import type { AppEnvironmentDetail } from "@/types";
import { CreatePageProjectDialog } from "./CreatePageProjectDialog";

const api = vi.hoisted(() => ({
  listPageProjectPlacementOptions: vi.fn(),
  createPageProject: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/stores/auth", () => {
  const auth = { user: { id: "user-1", scopes: ["pages:create"] } };
  return {
    useAuthStore: (selector?: (value: typeof auth) => unknown) =>
      selector ? selector(auth) : auth,
  };
});

const environment: AppEnvironmentDetail = {
  id: "env-staging",
  slug: "staging",
  name: "staging",
  isProduction: false,
  maintenanceEnabled: false,
  health: "healthy",
  memberCounts: {},
  placementFolderIds: {
    containers: null,
    compose: null,
    routes: null,
    databases: null,
    storage: null,
    pages: "folder-pages-staging",
    certificates: null,
    logging: null,
  },
  allowedNodeIds: ["edge-2"],
};

const context: AppCreateContext = {
  app: { id: "app-1", slug: "shop", name: "Shop" },
  environments: [environment],
  environmentId: "env-staging",
};

beforeEach(() => {
  window.localStorage.clear();
  api.listPageProjectPlacementOptions.mockResolvedValue([
    {
      id: "edge-1",
      displayName: "Edge Frankfurt",
      hostname: "edge-1",
      status: "online",
      pagesCapable: true,
    },
    {
      id: "edge-2",
      displayName: "Edge Amsterdam",
      hostname: "edge-2",
      status: "online",
      pagesCapable: true,
    },
  ]);
  api.createPageProject.mockResolvedValue({ id: "project-1", slug: "shop-status" });
});

describe("Create Page Project from an app", () => {
  it("creates on the only allowed node, in the environment's folder", async () => {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <MemoryRouter>
        <CreatePageProjectDialog
          open
          onOpenChange={onOpenChange}
          onCreated={onCreated}
          appContext={context}
        />
      </MemoryRouter>
    );
    expect(await screen.findByText("The only nginx node allowed in staging.")).toBeInTheDocument();
    const nodeField = screen.getByRole("combobox", { name: "Home node" });
    await waitFor(() => expect(nodeField).toHaveTextContent("Edge Amsterdam"));
    expect(nodeField).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Folder" })).toHaveTextContent("No folder");

    await userEvent.type(screen.getByLabelText("Project name"), "shop-status");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(api.createPageProject).toHaveBeenCalledWith({
        name: "shop-status",
        description: null,
        nodeId: "edge-2",
        folderId: "folder-pages-staging",
      })
    );
    expect(onCreated).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(window.localStorage.getItem("apps:last-environment:app-1")).toBe("env-staging");
  });
});
