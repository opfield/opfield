import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import type { User } from "@/types";
import { DeletedDatabaseBackupsPanel } from "./DeletedDatabaseBackupsPanel";

const api = vi.hoisted(() => ({
  listOrphanedBackupRuns: vi.fn(),
  restoreOrphanedBackup: vi.fn(),
  deleteOrphanedBackupHistory: vi.fn(),
  cancelOrphanedBackup: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api }));
// The real table virtualizes its rows, and jsdom has no layout to measure them.
vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    columns,
    data,
    keyFn,
  }: {
    columns: { key: string; render: (row: unknown) => ReactNode }[];
    data: unknown[];
    keyFn: (row: unknown) => string;
  }) => (
    <div>
      {data.map((row) => (
        <div key={keyFn(row)}>
          {columns.map((column) => (
            <div key={column.key}>{column.render(row)}</div>
          ))}
        </div>
      ))}
    </div>
  ),
}));
vi.mock("@/lib/managed-database-nodes", () => ({
  listManagedDatabaseCandidateNodes: async () => [],
  isDatabaseBackupCandidateNode: () => true,
}));

const run = {
  id: "run-1",
  policyId: null,
  databaseConnectionId: null,
  databaseConnectionName: "old-kv",
  destinationId: "storage-1",
  destinationBucket: "backups",
  destinationPrefix: "kv",
  stagingStorageConnectionId: null,
  stagingBucket: null,
  timezone: "UTC",
  executorNodeId: "node-1",
  direction: "backup",
  engine: "redis",
  status: "completed",
  phase: "completed",
  bytes: "1024",
  manifest: { engineVersion: "valkey 9.1.2", ownedPrefix: "kv/run-1", artifactKeys: [] },
  error: null,
  startedAt: "2026-10-01T00:00:00Z",
  completedAt: "2026-10-01T00:01:00Z",
  artifactsDeletedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
};

function signIn(scopes: string[]) {
  useAuthStore.setState({ user: { id: "user-1", scopes } as User, isLoading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listOrphanedBackupRuns.mockResolvedValue([run]);
});

// Stand e2e 2.12: the backups of a deleted store disappeared from every list.
describe("backups of deleted databases on the Databases page", () => {
  it("lists them with the deleted database's name and offers a restore", async () => {
    signIn(["databases:backups:view", "databases:backups:restore"]);
    render(<DeletedDatabaseBackupsPanel />);

    expect(await screen.findByText("old-kv")).toBeInTheDocument();
    expect(screen.getByText("Backups of deleted databases")).toBeInTheDocument();
    expect(screen.getByText("Key-value · valkey 9.1.2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("stays hidden for a grant scoped to one database", async () => {
    signIn(["databases:backups:view:db-1"]);
    const { container } = render(<DeletedDatabaseBackupsPanel />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api.listOrphanedBackupRuns).not.toHaveBeenCalled();
  });

  it("stays hidden when there is no such history or no backup module", async () => {
    signIn(["databases:backups:view"]);
    api.listOrphanedBackupRuns.mockRejectedValue(new Error("Commercial module unavailable"));
    const { container } = render(<DeletedDatabaseBackupsPanel />);

    await waitFor(() => expect(api.listOrphanedBackupRuns).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
