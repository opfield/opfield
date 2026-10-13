import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDetail, AppEnvironmentDetail } from "@/types";
import { ImportDialog } from "./ImportDialog";

const api = vi.hoisted(() => ({
  listDockerContainerSnapshots: vi.fn(),
  allowAppNode: vi.fn(),
  placeAppMembers: vi.fn(),
  // The scope picker module (imported for its viewport class) reads cached stores on load.
  getCached: vi.fn(() => undefined),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/services/api", () => ({ api }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/stores/license-paywall", () => ({ planIncludes: () => true }));
vi.mock("../use-node-index", () => ({
  useNodeIndex: () => ({
    byId: new Map([
      ["node-edge", { id: "node-edge", displayName: "edge-1", hostname: "edge-1.local" }],
      ["node-root", { id: "node-root", displayName: "Root Workloads", hostname: "root.local" }],
    ]),
  }),
  nodeDisplayName: (node: { displayName?: string } | undefined, id: string) =>
    node?.displayName ?? id,
}));

Element.prototype.scrollIntoView = () => undefined;

function environment(id: string, name: string, allowedNodeIds: string[]): AppEnvironmentDetail {
  return {
    id,
    slug: name,
    name,
    isProduction: name === "production",
    maintenanceEnabled: false,
    health: "healthy",
    memberCounts: {},
    placementFolderIds: {
      containers: null,
      compose: null,
      routes: null,
      databases: null,
      storage: null,
      pages: null,
    },
    allowedNodeIds,
  };
}

const app: AppDetail = {
  id: "oworia",
  slug: "oworia",
  name: "Oworia",
  maintenanceOverride: false,
  environments: [environment("prod", "production", ["node-edge"])],
  permissions: {
    edit: true,
    delete: false,
    operate: false,
    envManage: { prod: true },
    promote: {},
  },
} as AppDetail;

function container(id: string, nodeId: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, image: `ghcr.io/oworia/${id}:1`, nodeId, labels: {}, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  api.listDockerContainerSnapshots.mockResolvedValue([
    container("oworia-api", "node-edge", { kind: "deployment", deploymentId: "dep-api" }),
    container("oworia-jobs", "node-edge", {
      // Built from Git: the list names the repository, never the internal registry image.
      image: `127.0.0.1:5443/gateway/builds/3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f@sha256:${"a".repeat(64)}`,
      source: {
        repositoryFullPath: "oworia/jobs",
        branch: "main",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      },
    }),
    container("oworia-payments", "node-edge", {
      app: {
        id: "billing",
        name: "Billing",
        environmentId: "b-prod",
        environmentName: "production",
      },
    }),
    container("burnbox", "node-root"),
  ]);
  api.placeAppMembers.mockResolvedValue({ placed: 1, refused: [] });
  api.allowAppNode.mockResolvedValue({
    nodes: [
      { nodeId: "node-edge", usedBy: {} },
      { nodeId: "node-root", usedBy: {} },
    ],
  });
});

function renderDialog(onImported = vi.fn(), onClose = vi.fn()) {
  render(
    <ImportDialog
      app={app}
      request={{ family: "containers" }}
      onClose={onClose}
      onImported={onImported}
    />
  );
  return { onImported, onClose };
}

const rowCheckbox = (name: string) =>
  within(screen.getByText(name).closest("label") as HTMLElement).getByRole("checkbox");

describe("ImportDialog", () => {
  it("groups rows by node and locks a node the environment does not allow", async () => {
    renderDialog();
    await screen.findByText("burnbox");

    expect(screen.getByText("edge-1")).toBeInTheDocument();
    expect(screen.getByText("Root Workloads")).toBeInTheDocument();
    expect(screen.getByText("Not allowed in production")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.getByText("oworia/oworia-api:1")).toBeInTheDocument();
    expect(screen.getByText("oworia/jobs · 0123456789")).toBeInTheDocument();
    expect(screen.queryByText(/5443|gateway\/builds/)).not.toBeInTheDocument();
    expect(screen.getByText("deployment")).toBeInTheDocument();
    expect(screen.getByText("in Billing · moves here")).toBeInTheDocument();
    expect(rowCheckbox("burnbox")).toBeDisabled();
    expect(rowCheckbox("oworia-jobs")).toBeEnabled();
    expect(screen.getByText("0 of 4 selected")).toBeInTheDocument();
  });

  it("imports the picked rows with the count on the button", async () => {
    const { onImported, onClose } = renderDialog();
    await screen.findByText("oworia-jobs");
    const user = userEvent.setup();

    await user.click(rowCheckbox("oworia-jobs"));
    await user.click(rowCheckbox("oworia-api"));
    expect(screen.getByText("2 of 4 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import 2" }));

    await waitFor(() => expect(api.placeAppMembers).toHaveBeenCalledTimes(1));
    expect(api.placeAppMembers.mock.calls[0][0]).toEqual({
      target: { appId: "oworia", environmentId: "prod" },
      members: [
        { type: "deployment", id: "dep-api", nodeId: "node-edge" },
        { type: "container", id: "oworia-jobs", nodeId: "node-edge" },
      ],
    });
    expect(onImported).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("allows a node from its header and unlocks its rows", async () => {
    const { onImported } = renderDialog();
    await screen.findByText("burnbox");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(rowCheckbox("burnbox")).toBeEnabled());
    expect(api.allowAppNode).toHaveBeenCalledWith("oworia", "prod", "node-root");
    expect(onImported).toHaveBeenCalled();
    expect(screen.queryByText("Not allowed in production")).not.toBeInTheDocument();
  });

  it("says when the search matches nothing, with no filter button", async () => {
    renderDialog();
    await screen.findByText("burnbox");
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText("Search containers..."), "zzz");
    expect(screen.getByText("Nothing matches “zzz”.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /filter/i })).not.toBeInTheDocument();
  });

  it("shows the empty state without candidates", async () => {
    api.listDockerContainerSnapshots.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText("No containers and deployments to import.")).toBeInTheDocument();
  });
});
