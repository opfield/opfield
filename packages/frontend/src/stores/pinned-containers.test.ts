import { afterEach, describe, expect, it } from "vitest";
import {
  containerPinKey,
  keyContainerPinsByName,
  syncPinnedContainerMeta,
  usePinnedContainersStore,
} from "@/stores/pinned-containers";
import type { DockerContainer } from "@/types";

const STORAGE_KEY = "opfield-pinned-containers";

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  usePinnedContainersStore.setState({
    dashboardContainerIds: [],
    sidebarContainerIds: [],
    containerMeta: {},
  });
});

describe("container pins keyed by node and name", () => {
  it("heals a pin saved under a Docker ID that a recreate replaced, so its page can unpin it", async () => {
    // A container pinned before v2, then moved into an app: the pin still names the old Docker ID.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          dashboardContainerIds: ["dep-1"],
          sidebarContainerIds: ["old-docker-id", "no-meta-id", "dep-1"],
          containerMeta: {
            "old-docker-id": { nodeId: "node-1", nodeSlug: "edge", name: "web", state: "running" },
            "dep-1": { nodeId: "node-1", nodeSlug: "edge", name: "api", kind: "deployment" },
          },
        },
      })
    );
    await usePinnedContainersStore.persist.rehydrate();

    const key = containerPinKey("node-1", "web");
    const pins = usePinnedContainersStore.getState();
    expect(pins.sidebarContainerIds).toEqual([key, "dep-1"]);
    expect(pins.dashboardContainerIds).toEqual(["dep-1"]);
    expect(pins.containerMeta[key]).toMatchObject({ nodeSlug: "edge", name: "web" });
    // The container page builds the same key from its route, whatever the Docker ID is now.
    expect(pins.isPinnedSidebar(containerPinKey("node-1", "web"))).toBe(true);

    pins.toggleSidebar(key);
    expect(usePinnedContainersStore.getState().sidebarContainerIds).toEqual(["dep-1"]);
    expect(usePinnedContainersStore.getState().containerMeta[key]).toBeUndefined();
  });

  it("merges a stale pin and a fresh pin of the same container into one", () => {
    const key = containerPinKey("node-1", "web");
    const meta = { nodeId: "node-1", nodeSlug: "edge", name: "web" };
    expect(
      keyContainerPinsByName({
        dashboardContainerIds: [],
        sidebarContainerIds: ["old-id", "new-id"],
        containerMeta: { "old-id": meta, "new-id": { ...meta, state: "running" } },
      })
    ).toEqual({
      dashboardContainerIds: [],
      sidebarContainerIds: [key],
      containerMeta: { [key]: meta },
    });
  });

  it("follows a recreated container in the list by node and name", () => {
    const key = containerPinKey("node-1", "web");
    usePinnedContainersStore.setState({
      sidebarContainerIds: [key],
      dashboardContainerIds: [],
      containerMeta: {
        [key]: { nodeId: "node-1", nodeSlug: "edge", name: "web", state: "running" },
      },
    });
    syncPinnedContainerMeta([
      { id: "brand-new-id", name: "web", state: "exited", _nodeId: "node-1", _nodeSlug: "edge" },
    ] as DockerContainer[]);
    expect(usePinnedContainersStore.getState().containerMeta[key]?.state).toBe("exited");
  });
});
