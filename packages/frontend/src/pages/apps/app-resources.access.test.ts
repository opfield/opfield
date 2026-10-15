import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const api = vi.hoisted(() => ({
  listDockerContainerSnapshots: vi.fn(),
  listDockerComposeProjects: vi.fn(),
  getDockerComposeProject: vi.fn(),
  listAppRoutes: vi.fn(),
  listAppCertificates: vi.fn(),
  listAppDomains: vi.fn(),
  listContainerLinks: vi.fn(),
  listManagedDatabases: vi.fn(),
  listManagedObjectStorages: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/services/api", () => ({ api }));
vi.mock("@/stores/license-paywall", () => ({
  planIncludes: () => false,
  handleLicenseError: vi.fn(),
}));
vi.mock("@/stores/pinned-containers", () => ({ syncPinnedContainerMeta: vi.fn() }));

import { ApiRequestError } from "@/services/api-base";
import { loadAppCompute, loadAppNetwork, useAppLoad } from "./app-resources";

const APP = "app-1";
const container = {
  id: "c1",
  name: "web",
  nodeId: "n1",
  labels: {},
  app: { id: APP, environmentId: "env-1" },
};
const route = { id: "r1", app: { id: APP, environmentId: "env-1" } };
const forbidden = () =>
  new ApiRequestError("Missing docker:compose:view", { status: 403, code: "FORBIDDEN" });

describe("app member loading by scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listDockerContainerSnapshots.mockResolvedValue([container]);
    api.listDockerComposeProjects.mockResolvedValue([]);
    api.listAppRoutes.mockResolvedValue([route]);
    api.listAppCertificates.mockResolvedValue([]);
    api.listAppDomains.mockResolvedValue([]);
  });

  it("skips Compose without docker:compose:view and keeps the containers", async () => {
    const compute = await loadAppCompute(APP, { containers: true, compose: false, routes: false });
    expect(api.listDockerComposeProjects).not.toHaveBeenCalled();
    expect(compute.containers).toHaveLength(1);
    expect(compute.hidden).toEqual([{ title: "Compose projects", scope: "docker:compose:view" }]);
  });

  it("treats a refused Compose list as hidden instead of failing the tab", async () => {
    api.listDockerComposeProjects.mockRejectedValue(forbidden());
    const compute = await loadAppCompute(APP);
    expect(compute.containers).toHaveLength(1);
    expect(compute.hidden.map((entry) => entry.scope)).toEqual(["docker:compose:view"]);
  });

  it("lists each member Compose project's services as its own page does", async () => {
    const project = {
      id: "p1",
      name: "shop",
      nodeId: "n1",
      _nodeSlug: "edge-1",
      app: { id: APP, environmentId: "env-1" },
    };
    const service = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      image: `${name}:1`,
      state: "running",
      health: "healthy",
      containerIds: [`${name}-id`],
      ...extra,
    });
    api.listDockerComposeProjects.mockResolvedValue([
      project,
      { ...project, id: "p2", app: { id: "other", environmentId: "env-9" } },
    ]);
    api.getDockerComposeProject.mockResolvedValue({
      services: [
        service("worker", {
          image: `127.0.0.1:5443/gateway/builds/x@sha256:${"a".repeat(64)}`,
          source: { repositoryFullPath: "acme/shop", branch: "main", commitSha: "0123456789ab" },
        }),
        service("api"),
      ],
    });
    const compute = await loadAppCompute(APP);
    // Only the member project is read; the container list never carries Compose services.
    expect(api.getDockerComposeProject).toHaveBeenCalledTimes(1);
    expect(api.getDockerComposeProject).toHaveBeenCalledWith("n1", "p1");
    expect(compute.compose).toHaveLength(1);
    expect(compute.compose[0]!.services.map((row) => row.name)).toEqual(["api", "worker"]);
    expect(compute.compose[0]!.services[1]!.source?.repositoryFullPath).toBe("acme/shop");
  });

  it("keeps a member Compose project whose services cannot be read", async () => {
    api.listDockerComposeProjects.mockResolvedValue([
      { id: "p1", name: "shop", nodeId: "n1", app: { id: APP, environmentId: "env-1" } },
    ]);
    api.getDockerComposeProject.mockRejectedValue(new Error("node offline"));
    const compute = await loadAppCompute(APP);
    expect(compute.compose).toEqual([expect.objectContaining({ services: [] })]);
  });

  it("still fails on a real error", async () => {
    api.listDockerComposeProjects.mockRejectedValue(new Error("boom"));
    await expect(loadAppCompute(APP)).rejects.toThrow("boom");
  });

  it("shows routes and names the hidden Compose links on the Network tab", async () => {
    const network = await loadAppNetwork(APP, { containers: true, compose: false, routes: true });
    expect(network.routes).toEqual([route]);
    expect(network.hidden.map((entry) => entry.scope)).toEqual(["docker:compose:view"]);
  });

  it("skips routes without proxy:view", async () => {
    const network = await loadAppNetwork(APP, { containers: true, compose: true, routes: false });
    expect(api.listAppRoutes).not.toHaveBeenCalled();
    expect(network.routes).toEqual([]);
    expect(network.hidden).toEqual([{ title: "Routes", scope: "proxy:view" }]);
  });
});

describe("useAppLoad", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not toast a permission refusal, even when it reloads", async () => {
    const loader = vi.fn(() => Promise.reject(forbidden()));
    const { result, rerender } = renderHook(
      ({ version }) => useAppLoad("compute:app-1", version, loader),
      { initialProps: { version: 0 } }
    );
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    rerender({ version: 1 });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("still toasts an unexpected failure", async () => {
    renderHook(() => useAppLoad("compute:app-1", 0, () => Promise.reject(new Error("boom"))));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
  });
});
