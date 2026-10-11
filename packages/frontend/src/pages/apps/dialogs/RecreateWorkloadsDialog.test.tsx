import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPendingWorkload, AppWorkloadTask } from "@/types";
import { RecreateWorkloadsDialog } from "./RecreateWorkloadsDialog";

const api = vi.hoisted(() => ({
  recreateWithConfig: vi.fn(),
  getAppWorkloadTask: vi.fn(),
  deployDockerDeployment: vi.fn(),
  startDockerComposeOperation: vi.fn(),
  listDockerComposeOperations: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));

const workload = (kind: AppPendingWorkload["kind"], id: string, name = id): AppPendingWorkload => ({
  kind,
  id,
  nodeId: "node-1",
  name,
});
const web = workload("container", "web");
const worker = workload("container", "worker");
const shop = workload("deployment", "dep-1", "shop");

function task(
  status: AppWorkloadTask["status"],
  extra: Partial<AppWorkloadTask> = {}
): AppWorkloadTask {
  return {
    id: "task-1",
    type: "recreate",
    status,
    progress: null,
    error: null,
    completedAt: null,
    ...extra,
  };
}

function renderDialog(workloads: AppPendingWorkload[], onFinished = vi.fn()) {
  render(
    <RecreateWorkloadsDialog
      appId="app-1"
      environmentId="env-1"
      environmentName="staging"
      workloads={workloads}
      onClose={vi.fn()}
      onFinished={onFinished}
      pollMs={5}
    />
  );
  return { onFinished };
}

/** The dialog row of a workload: its title sits two levels below the row. */
const rowOf = (name: string) => screen.getByText(name).parentElement!.parentElement!;

describe("Save and recreate workloads", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  it("keeps a container in progress until its recreate task succeeds", async () => {
    api.recreateWithConfig.mockResolvedValue({ taskId: "task-1", containerId: "web", name: "web" });
    let release: (value: AppWorkloadTask) => void = () => undefined;
    api.getAppWorkloadTask
      .mockResolvedValueOnce(task("running", { progress: "Recreating container" }))
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { onFinished } = renderDialog([web]);

    await waitFor(() => expect(api.getAppWorkloadTask).toHaveBeenCalledTimes(2));
    expect(api.getAppWorkloadTask).toHaveBeenCalledWith("app-1", "env-1", "task-1");
    // Accepted by the node, not finished: no Done and no summary yet.
    expect(within(rowOf("web")).getByText("Recreating")).toBeInTheDocument();
    expect(screen.getByText("Container · Recreating container")).toBeInTheDocument();
    expect(screen.queryByText("1 workload recreated")).not.toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();

    release(task("succeeded"));
    await screen.findByText("1 workload recreated");
    expect(within(rowOf("web")).getByText("Done")).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("shows a failed recreate on its row with the error and does not start the rest", async () => {
    api.recreateWithConfig.mockResolvedValue({ taskId: "task-1" });
    api.getAppWorkloadTask.mockResolvedValue(task("failed", { error: "pull access denied" }));
    renderDialog([web, worker]);

    await screen.findByText("web failed; the rest was not started");
    expect(within(rowOf("web")).getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Container · pull access denied")).toBeInTheDocument();
    expect(within(rowOf("worker")).getByText("Not started")).toBeInTheDocument();
    expect(api.recreateWithConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/workloads? recreated/)).not.toBeInTheDocument();
  });

  it("counts only finished recreates and says what still rolls out", async () => {
    api.recreateWithConfig
      .mockResolvedValueOnce({ taskId: "task-1" })
      .mockResolvedValueOnce({ availabilityManaged: true });
    api.getAppWorkloadTask.mockResolvedValue(task("succeeded"));
    api.deployDockerDeployment.mockResolvedValue({ id: "dep-1", deploymentDeferred: true });
    renderDialog([web, worker, shop]);

    await screen.findByText("1 workload recreated");
    const note =
      "1 workload rolls out through its availability policy; " +
      "1 stopped deployment gets the values when started.";
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(within(rowOf("worker")).getByText("Rolling out")).toBeInTheDocument();
    expect(within(rowOf("shop")).getByText("On next start")).toBeInTheDocument();
  });
});
