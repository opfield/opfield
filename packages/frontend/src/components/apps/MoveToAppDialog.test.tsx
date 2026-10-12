import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDetail, AppEnvironmentDetail, AppSummary } from "@/types";
import { MoveToAppDialog } from "./MoveToAppDialog";

const api = vi.hoisted(() => ({
  listApps: vi.fn(),
  getApp: vi.fn(),
  placeAppMembers: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const bootstrap = vi.hoisted(() => ({
  snapshot: {
    navigation: {
      nodes: { data: [{ id: "node-1", displayName: "edge-1", hostname: "edge-1.local" }] },
    },
  },
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/stores/ui-bootstrap", () => ({
  useUIBootstrapStore: (selector: (state: typeof bootstrap) => unknown) => selector(bootstrap),
}));

// Radix Select scrolls the picked item into view, which jsdom does not implement.
Element.prototype.scrollIntoView = () => undefined;

function environment(id: string, name: string, isProduction = false): AppEnvironmentDetail {
  return {
    id,
    slug: name,
    name,
    isProduction,
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
    allowedNodeIds: [],
  };
}

function app(id: string, name: string, envManage: Record<string, boolean>): AppDetail {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    maintenanceOverride: false,
    environments: [
      environment(`${id}-prod`, "production", true),
      environment(`${id}-stg`, "staging"),
    ],
    permissions: { edit: true, delete: false, operate: false, envManage, promote: {} },
  };
}

const shop = app("shop", "Shop", { "shop-prod": true, "shop-stg": true });
const blog = app("blog", "Blog", { "blog-prod": false, "blog-stg": false });

function summary(detail: AppDetail): AppSummary {
  return {
    id: detail.id,
    slug: detail.slug,
    name: detail.name,
    environments: detail.environments.map(({ id, name, isProduction, health }) => ({
      id,
      name,
      isProduction,
      health,
    })),
    health: "healthy",
    incident: "none",
    cpuPercent: null,
    memoryBytes: null,
    running: 0,
    failing: 0,
    degraded: 0,
  };
}

const onOpenChange = vi.fn();
const onMoved = vi.fn();

function renderDialog() {
  render(
    <MoveToAppDialog
      open
      onOpenChange={onOpenChange}
      members={[{ type: "container", nodeId: "node-1", resourceKey: "web" }]}
      resourceLabel="web"
      onMoved={onMoved}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  api.listApps.mockResolvedValue([summary(shop), summary(blog)]);
  api.getApp.mockImplementation(async (id: string) => (id === "shop" ? shop : blog));
});

describe("MoveToAppDialog", () => {
  it("lists No app and only the apps whose members the user may manage", async () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "No app" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Shop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Blog" })).not.toBeInTheDocument();
    // Not in an app yet: "No app" is the current state, so there is nothing to move.
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
  });

  it("starts at the last used environment and places the member there", async () => {
    window.localStorage.setItem("apps:last-environment:shop", "shop-stg");
    api.placeAppMembers.mockResolvedValue({ placed: 1, refused: [] });
    renderDialog();

    await userEvent.click(await screen.findByRole("button", { name: "Shop" }));
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent("staging");
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(api.placeAppMembers).toHaveBeenCalledWith({
        target: { appId: "shop", environmentId: "shop-stg" },
        members: [{ type: "container", nodeId: "node-1", resourceKey: "web" }],
      })
    );
    expect(toast.success).toHaveBeenCalledWith("Moved web to Shop · staging");
    expect(onMoved).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("defaults to Production and keeps the dialog open to show refused members", async () => {
    api.placeAppMembers.mockResolvedValue({
      placed: 0,
      refused: [
        {
          member: { type: "container", nodeId: "node-1", resourceKey: "web" },
          code: "APP_NODE_NOT_ALLOWED",
          message: "Node is not allowed in this environment",
        },
      ],
    });
    renderDialog();

    await userEvent.click(await screen.findByRole("button", { name: "Shop" }));
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent(
      "production · Production"
    );
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    expect(await screen.findByText("Nothing was moved")).toBeInTheDocument();
    expect(
      screen.getByText(
        "web: Its node edge-1 is not allowed in production; add it to the environment's allowed nodes first"
      )
    ).toBeInTheDocument();
    expect(onMoved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
