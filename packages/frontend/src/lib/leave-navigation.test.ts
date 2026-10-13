import { describe, expect, it } from "vitest";
import {
  EMPTY_NAVIGATION_TRAIL,
  type LeavePlanInput,
  type NavigationTrailState,
  type NavigationVisit,
  parseNavigationTrail,
  planLeaveStep,
  recordNavigation,
} from "./navigation-trail";
import { nodeScopedPaths } from "./resource-routes";
import {
  getReturnNavigationTarget,
  isSafeInternalPath,
  preserveReturnNavigationState,
  readReturnNavigationTarget,
} from "./return-navigation";

function walk(visits: NavigationVisit[], start: NavigationTrailState = EMPTY_NAVIGATION_TRAIL) {
  return visits.reduce(recordNavigation, start);
}

function plan(trail: NavigationTrailState, input: Partial<LeavePlanInput> = {}) {
  const current = trail.entries[trail.index];
  return planLeaveStep({
    trail,
    pathname: current?.url.split(/[?#]/)[0] ?? "/",
    historyIdx: current?.historyIdx,
    returnTo: null,
    fallback: "/docker",
    ...input,
  });
}

describe("isSafeInternalPath", () => {
  it("accepts console paths with query and hash", () => {
    expect(isSafeInternalPath("/apps/shop/compute")).toBe(true);
    expect(isSafeInternalPath("/docker/containers?nodeId=n1&filters=1#row")).toBe(true);
    expect(isSafeInternalPath("/docker/containers/n1/web%20app")).toBe(true);
    expect(isSafeInternalPath("/")).toBe(true);
  });

  it("rejects anything that could leave the console", () => {
    for (const value of [
      "https://evil.example/apps",
      "//evil.example/apps",
      "/\\evil.example",
      "\\\\evil.example",
      "/apps\\..\\x",
      "javascript:alert(1)",
      "apps/shop",
      "",
      "/apps\n/x",
      "/apps\u0000",
      "/api/auth/logout",
      "/auth/logout",
      `/${"a".repeat(5000)}`,
      42,
      null,
      undefined,
      { toString: () => "/apps" },
    ]) {
      expect(isSafeInternalPath(value), String(value)).toBe(false);
    }
  });

  it("guards returnTo link state the same way", () => {
    expect(readReturnNavigationTarget({ returnTo: "/apps/shop/data" })).toBe("/apps/shop/data");
    expect(readReturnNavigationTarget({ returnTo: "//evil.example" })).toBeNull();
    expect(readReturnNavigationTarget({ returnTo: "/\\evil.example" })).toBeNull();
    expect(readReturnNavigationTarget(null)).toBeNull();
    expect(getReturnNavigationTarget({ returnTo: "https://evil.example" }, "/docker")).toBe(
      "/docker"
    );
    expect(preserveReturnNavigationState({ returnTo: "/\\evil.example" })).toEqual({});
    expect(preserveReturnNavigationState({ returnTo: "/nodes/n1" })).toEqual({
      returnTo: "/nodes/n1",
    });
  });

  it("drops a stored trail holding an unsafe URL", () => {
    expect(
      parseNavigationTrail({ entries: [{ key: "x", url: "/\\evil.example" }], index: 0 })
    ).toEqual(EMPTY_NAVIGATION_TRAIL);
  });
});

describe("planLeaveStep", () => {
  it("returns to the app tab a deleted container was opened from, by browser back", () => {
    const trail = walk([
      { action: "PUSH", pathname: "/apps", historyIdx: 1 },
      { action: "PUSH", pathname: "/apps/shop", historyIdx: 2 },
      { action: "PUSH", pathname: "/apps/shop/compute", historyIdx: 3 },
      { action: "PUSH", pathname: "/docker/containers/n1/web", historyIdx: 4 },
      { action: "PUSH", pathname: "/docker/containers/n1/web/logs", historyIdx: 5 },
    ]);
    // Tab switches of one page are one trail step, so the history entry before is not the app.
    expect(plan(trail)).toEqual({
      kind: "url",
      url: "/apps/shop/compute",
      nextState: { entries: trail.entries.slice(0, 2), index: 1 },
    });

    const direct = walk([
      { action: "PUSH", pathname: "/apps/shop/compute", historyIdx: 3 },
      { action: "PUSH", pathname: "/docker/containers/n1/web", historyIdx: 4 },
    ]);
    expect(plan(direct)).toEqual({ kind: "history", url: "/apps/shop/compute" });
  });

  it("keeps the app tab, query and environment the user came from", () => {
    const fromEnv = walk([
      { action: "PUSH", pathname: "/apps/shop/env/live", search: "?allow=node" },
      { action: "PUSH", pathname: "/databases/orders/explorer" },
    ]);
    expect(plan(fromEnv, { fallback: "/databases" }).url).toBe("/apps/shop/env/live?allow=node");

    const fromNode = walk([
      { action: "PUSH", pathname: "/nodes/n1/containers" },
      { action: "PUSH", pathname: "/proxy-hosts/shop-web" },
    ]);
    expect(plan(fromNode, { fallback: "/routes" }).url).toBe("/nodes/n1/containers");
  });

  it("skips pages that are gone with the deleted one", () => {
    const trail = walk([
      { action: "PUSH", pathname: "/apps/shop/compute" },
      { action: "PUSH", pathname: "/docker/containers/n1/web" },
      { action: "PUSH", pathname: "/nodes/n1" },
      { action: "PUSH", pathname: "/docker/deployments/n1/api" },
      { action: "PUSH", pathname: "/nodes/n1/settings" },
    ]);
    const step = plan(trail, { fallback: "/nodes", gonePaths: nodeScopedPaths("n1") });
    expect(step).toEqual({
      kind: "url",
      url: "/apps/shop/compute",
      nextState: { entries: trail.entries.slice(0, 1), index: 0 },
    });

    // Deleting an app also drops its environment pages from the way back.
    const app = walk([
      { action: "PUSH", pathname: "/docker/containers/n1/web" },
      { action: "PUSH", pathname: "/apps/shop/env/live" },
      { action: "PUSH", pathname: "/apps/shop/settings" },
    ]);
    expect(plan(app, { fallback: "/apps", gonePaths: ["/apps/shop"] }).url).toBe(
      "/docker/containers/n1/web"
    );
  });

  it("never treats a sibling path prefix as gone", () => {
    const trail = walk([
      { action: "PUSH", pathname: "/apps/shop-2" },
      { action: "PUSH", pathname: "/apps/shop" },
    ]);
    expect(plan(trail, { fallback: "/apps", gonePaths: ["/apps/shop"] }).url).toBe("/apps/shop-2");
  });

  it("uses returnTo, then the list, when the trail has no earlier page", () => {
    const opened = walk([{ action: "POP", pathname: "/docker/containers/n1/web", initial: true }]);
    expect(plan(opened)).toEqual({ kind: "url", url: "/docker" });
    expect(plan(opened, { returnTo: "/docker/volumes/n1/data" })).toEqual({
      kind: "url",
      url: "/docker/volumes/n1/data",
    });
    // A returnTo that is the deleted page itself or unsafe is ignored.
    expect(plan(opened, { returnTo: "/docker/containers/n1/web/logs" }).url).toBe("/docker");
    expect(plan(opened, { returnTo: "//evil.example" }).url).toBe("/docker");
    expect(plan(opened, { fallback: "https://evil.example" }).url).toBe("/");
  });

  it("ignores a trail that does not point at the page being left", () => {
    const trail = walk([
      { action: "PUSH", pathname: "/apps/shop" },
      { action: "PUSH", pathname: "/nodes/n1" },
    ]);
    expect(plan(trail, { pathname: "/docker/containers/n1/web" }).url).toBe("/docker");
  });

  it("survives a reload: the stored trail still leads back to the app", () => {
    const before = walk([
      { action: "PUSH", pathname: "/apps/shop/data", historyIdx: 2 },
      { action: "PUSH", pathname: "/storage/media", historyIdx: 3 },
    ]);
    const reloaded = walk(
      [{ action: "POP", pathname: "/storage/media", historyIdx: 3, initial: true }],
      parseNavigationTrail(JSON.parse(JSON.stringify(before)))
    );
    expect(plan(reloaded, { fallback: "/storage" })).toEqual({
      kind: "history",
      url: "/apps/shop/data",
    });
  });
});
