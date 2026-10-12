import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { waitForReveal } from "@/test/reveal";
import type { DatabaseConnection, User } from "@/types";
import { Databases } from "./Databases";

const api = vi.hoisted(() => ({
  getCached: vi.fn(() => undefined),
  setCache: vi.fn(),
  listDatabases: vi.fn(),
  listManagedDatabases: vi.fn(),
  getDatabase: vi.fn(),
  listManagedDatabaseCatalog: vi.fn(async () => []),
}));
const folderState = vi.hoisted(() => ({
  foldersByType: { database: [] },
  loadingByType: { database: false },
  expandedFolderIdsByType: {},
  fetchFolders: vi.fn(async () => undefined),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  reorderFolders: vi.fn(),
  moveResourcesToFolder: vi.fn(),
  reorderResources: vi.fn(),
  toggleFolder: vi.fn(),
  moveFolder: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));
vi.mock("@/lib/live-scopes", () => ({ refreshDynamicScopes: async () => undefined }));
vi.mock("@/lib/managed-database-nodes", () => ({
  listManagedDatabaseCandidateNodes: async () => [],
}));
vi.mock("@/components/license/LicenseFeatureBoundary", () => ({
  LicenseFeatureBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/stores/resource-folders", () => ({
  useResourceFolderStore: (selector?: (state: typeof folderState) => unknown) =>
    selector ? selector(folderState) : folderState,
  hasSavedFolderExpansion: () => false,
}));

function database(id: string, name: string, app: DatabaseConnection["app"] = null) {
  return {
    id,
    slug: name,
    name,
    type: "postgres",
    host: "db.internal",
    port: 5432,
    databaseName: name,
    healthStatus: "online",
    lastHealthCheckAt: null,
    tags: [],
    folderId: null,
    app,
  } as unknown as DatabaseConnection;
}

const orders = database("db-1", "orders");
const shopDb = database("db-2", "shop-db", {
  id: "app-1",
  slug: "shop",
  name: "Shop",
  environmentId: "env-1",
  environmentName: "production",
});

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: "user-1", scopes: ["databases:view", "databases:edit"] } as User,
    isLoading: false,
  });
});

describe("app members in the database list", () => {
  it("asks the server to leave app members out", async () => {
    // The server leaves members out (excludeAppMembers): the list shows what it returns.
    api.listDatabases.mockResolvedValue({ data: [orders] });
    render(
      <MemoryRouter>
        <Databases />
      </MemoryRouter>
    );

    expect(await screen.findByText("orders")).toBeInTheDocument();
    await waitForReveal();
    expect(screen.queryByText("shop-db")).not.toBeInTheDocument();
    expect(api.listDatabases).toHaveBeenCalledWith(
      expect.objectContaining({ excludeAppMembers: true })
    );
    // A non-member offers Move to app in its row menu.
    expect(await screen.findByRole("button", { name: "orders actions" })).toBeInTheDocument();
  });

  it("keeps members on a node's view with a badge that opens the app", async () => {
    api.listManagedDatabases.mockResolvedValue([
      { nodeId: "node-1", databaseConnectionId: "db-2" },
    ]);
    api.getDatabase.mockResolvedValue(shopDb);
    render(
      <MemoryRouter>
        <Databases embedded managedNodeId="node-1" />
      </MemoryRouter>
    );

    expect(await screen.findByText("shop-db")).toBeInTheDocument();
    await waitForReveal();
    const badge = screen.getByRole("link", { name: "Shop · production" });
    expect(badge).toHaveAttribute("href", "/apps/shop");
    await waitFor(() => expect(api.listDatabases).not.toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "shop-db actions" })).not.toBeInTheDocument();
  });
});
