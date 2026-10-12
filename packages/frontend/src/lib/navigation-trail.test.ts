import { describe, expect, it } from "vitest";
import {
  EMPTY_NAVIGATION_TRAIL,
  NAVIGATION_TRAIL_LIMIT,
  type NavigationTrailState,
  type NavigationVisit,
  pageKeyForPath,
  parseNavigationTrail,
  planBackStep,
  recordNavigation,
} from "./navigation-trail";

function walk(visits: NavigationVisit[], start: NavigationTrailState = EMPTY_NAVIGATION_TRAIL) {
  return visits.reduce(recordNavigation, start);
}

const urls = (state: NavigationTrailState) => state.entries.map((entry) => entry.url);

describe("pageKeyForPath", () => {
  it("treats tab segments of a detail page as the same page", () => {
    expect(pageKeyForPath("/apps/shop")).toBe(pageKeyForPath("/apps/shop/activity"));
    expect(pageKeyForPath("/docker/containers/n1/web")).toBe(
      pageKeyForPath("/docker/containers/n1/web/logs")
    );
    expect(pageKeyForPath("/nodes/n1/")).toBe(pageKeyForPath("/nodes/n1/console"));
    expect(pageKeyForPath("/administration")).toBe(pageKeyForPath("/administration/users"));
    expect(pageKeyForPath("/docker")).toBe(pageKeyForPath("/docker/images"));
  });

  it("treats hub tabs as one page and keeps resources apart", () => {
    expect(pageKeyForPath("/routes")).toBe(pageKeyForPath("/routes/domains"));
    expect(pageKeyForPath("/routes/new")).toBe(pageKeyForPath("/routes"));
    expect(pageKeyForPath("/certificates")).toBe(pageKeyForPath("/certificates/pki"));
    expect(pageKeyForPath("/certificates/abc")).not.toBe(pageKeyForPath("/certificates"));
    expect(pageKeyForPath("/apps/shop")).not.toBe(pageKeyForPath("/apps/blog"));
    expect(pageKeyForPath("/apps/shop/env/prod")).not.toBe(pageKeyForPath("/apps/shop"));
    expect(pageKeyForPath("/apps")).not.toBe(pageKeyForPath("/apps/shop"));
    expect(pageKeyForPath("/docker/compose/p1")).not.toBe(pageKeyForPath("/docker/compose"));
    expect(pageKeyForPath("/docker/containers/n1/web")).not.toBe(
      pageKeyForPath("/docker/containers/n2/web")
    );
  });
});

describe("recordNavigation", () => {
  it("does not add a step for tab, query or hash changes and keeps the last URL", () => {
    const state = walk([
      { action: "PUSH", pathname: "/docker/containers/n1/web" },
      { action: "PUSH", pathname: "/apps/shop" },
      { action: "REPLACE", pathname: "/apps/shop/activity" },
      { action: "PUSH", pathname: "/apps/shop/activity", search: "?q=1", hash: "#top" },
    ]);
    expect(urls(state)).toEqual(["/docker/containers/n1/web", "/apps/shop/activity?q=1#top"]);
    expect(state.index).toBe(1);
  });

  it("replaces the current page on redirects and collapses onto the previous one", () => {
    const redirected = walk([
      { action: "PUSH", pathname: "/apps" },
      { action: "PUSH", pathname: "/proxy-hosts" },
      { action: "REPLACE", pathname: "/routes" },
    ]);
    expect(urls(redirected)).toEqual(["/apps", "/routes"]);

    const collapsed = walk([{ action: "REPLACE", pathname: "/apps" }], redirected);
    expect(urls(collapsed)).toEqual(["/apps"]);
    expect(collapsed.index).toBe(0);
  });

  it("moves the cursor on browser back and forward instead of appending", () => {
    const visited = walk([
      { action: "PUSH", pathname: "/docker", historyIdx: 0 },
      { action: "PUSH", pathname: "/docker/containers/n1/web", historyIdx: 1 },
      { action: "PUSH", pathname: "/apps/shop", historyIdx: 2 },
    ]);
    const back = walk(
      [{ action: "POP", pathname: "/docker/containers/n1/web", historyIdx: 1 }],
      visited
    );
    expect(back.index).toBe(1);
    expect(back.entries).toHaveLength(3);
    const forward = walk([{ action: "POP", pathname: "/apps/shop", historyIdx: 2 }], back);
    expect(forward.index).toBe(2);
    // A new page after going back drops the forward entries.
    const branched = walk([{ action: "PUSH", pathname: "/nodes", historyIdx: 2 }], back);
    expect(urls(branched)).toEqual(["/docker", "/docker/containers/n1/web", "/nodes"]);
  });

  it("keeps the trail on reload and starts over on another document load", () => {
    const visited = walk([
      { action: "PUSH", pathname: "/docker/containers/n1/web", historyIdx: 1 },
      { action: "PUSH", pathname: "/apps/shop", historyIdx: 2 },
    ]);
    const reloaded = walk(
      [{ action: "POP", pathname: "/apps/shop", historyIdx: 2, initial: true }],
      visited
    );
    expect(urls(reloaded)).toEqual(urls(visited));
    const typed = walk(
      [{ action: "POP", pathname: "/nodes", historyIdx: 3, initial: true }],
      visited
    );
    expect(urls(typed)).toEqual(["/nodes"]);
  });

  it("caps the trail length", () => {
    const visits: NavigationVisit[] = Array.from(
      { length: NAVIGATION_TRAIL_LIMIT + 10 },
      (_, i) => ({
        action: "PUSH",
        pathname: `/apps/app-${i}`,
      })
    );
    const state = walk(visits);
    expect(state.entries).toHaveLength(NAVIGATION_TRAIL_LIMIT);
    expect(state.index).toBe(NAVIGATION_TRAIL_LIMIT - 1);
    expect(state.entries.at(-1)?.url).toBe(`/apps/app-${NAVIGATION_TRAIL_LIMIT + 9}`);
  });
});

describe("planBackStep", () => {
  it("has no step without an earlier page (caller falls back to the logical parent)", () => {
    expect(planBackStep(EMPTY_NAVIGATION_TRAIL, undefined)).toBeNull();
    expect(planBackStep(walk([{ action: "PUSH", pathname: "/apps/shop" }]), 0)).toBeNull();
  });

  it("uses browser back only when the previous browser entry is the previous page", () => {
    const direct = walk([
      { action: "PUSH", pathname: "/docker/containers/n1/web", historyIdx: 4 },
      { action: "PUSH", pathname: "/apps/shop", historyIdx: 5 },
    ]);
    expect(planBackStep(direct, 5)).toEqual({ kind: "history", url: "/docker/containers/n1/web" });

    const afterTabPush = walk(
      [{ action: "PUSH", pathname: "/apps/shop/activity", historyIdx: 6 }],
      direct
    );
    const step = planBackStep(afterTabPush, 6);
    expect(step?.kind).toBe("url");
    expect(step?.url).toBe("/docker/containers/n1/web");
  });

  it("returns to the last URL of the previous page and never ping-pongs", () => {
    let state = walk([
      { action: "PUSH", pathname: "/docker/containers" },
      { action: "PUSH", pathname: "/docker/containers/n1/web" },
      { action: "REPLACE", pathname: "/docker/containers/n1/web/logs" },
      { action: "PUSH", pathname: "/apps/shop" },
    ]);

    const first = planBackStep(state, undefined);
    expect(first).toMatchObject({ kind: "url", url: "/docker/containers/n1/web/logs" });
    if (first?.kind !== "url") throw new Error("expected url step");
    state = recordNavigation(first.nextState, {
      action: "PUSH",
      pathname: "/docker/containers/n1/web/logs",
    });
    expect(urls(state)).toEqual(["/docker/containers", "/docker/containers/n1/web/logs"]);

    const second = planBackStep(state, undefined);
    expect(second?.url).toBe("/docker/containers");
    if (second?.kind !== "url") throw new Error("expected url step");
    state = recordNavigation(second.nextState, { action: "PUSH", pathname: "/docker/containers" });
    expect(urls(state)).toEqual(["/docker/containers"]);
    expect(planBackStep(state, undefined)).toBeNull();
  });
});

describe("parseNavigationTrail", () => {
  it("drops malformed or unsafe stored trails", () => {
    expect(parseNavigationTrail(null)).toEqual(EMPTY_NAVIGATION_TRAIL);
    expect(parseNavigationTrail({ entries: [{ key: "x", url: "//evil" }], index: 0 })).toEqual(
      EMPTY_NAVIGATION_TRAIL
    );
    expect(parseNavigationTrail({ entries: [{ key: "apps", url: "/apps" }], index: 7 })).toEqual({
      entries: [{ key: "apps", url: "/apps" }],
      index: 0,
    });
  });
});
