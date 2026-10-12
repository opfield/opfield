import { describe, expect, it } from "vitest";
import type { AppDetail, AppEnvironmentDetail } from "@/types";
import { allowedNodeName } from "./allowed-nodes";
import { presentHiddenMembers } from "./app-shared";

const app = (hiddenMemberTypes: AppEnvironmentDetail["hiddenMemberTypes"]) =>
  ({ environments: [{ id: "env-1", hiddenMemberTypes }] }) as unknown as AppDetail;

const HIDDEN = [
  { title: "Containers and deployments", scope: "docker:containers:view" },
  { title: "Compose projects", scope: "docker:compose:view" },
  { title: "Pages projects", scope: "pages:view" },
  { title: "Routes", scope: "proxy:view" },
];

describe("members the user cannot see", () => {
  it("names only the types the app really has out of sight", () => {
    expect(presentHiddenMembers(app([]), HIDDEN)).toEqual([]);
    expect(presentHiddenMembers(app(undefined), HIDDEN)).toEqual([]);
    expect(
      presentHiddenMembers(app(["compose", "route"]), HIDDEN).map((entry) => entry.title)
    ).toEqual(["Compose projects", "Routes"]);
    expect(presentHiddenMembers(app(["deployment"]), HIDDEN).map((entry) => entry.scope)).toEqual([
      "docker:containers:view",
    ]);
  });
});

describe("allowed node names", () => {
  it("uses the app's node name without node permissions", () => {
    const nodeId = "2357df2a-0000-4000-8000-000000000000";
    expect(
      allowedNodeName({
        nodeId,
        node: undefined,
        allowed: { nodeId, name: "edge-1", usedBy: {} },
        usedBy: {},
      })
    ).toBe("edge-1");
    expect(allowedNodeName({ nodeId, node: undefined, usedBy: undefined })).toBe("2357df2a");
  });
});
