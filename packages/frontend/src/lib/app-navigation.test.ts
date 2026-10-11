import { describe, expect, it } from "vitest";
import { APP_NAVIGATION_GROUPS, visibleNavigationGroups } from "./app-navigation";

const context = (scopes: string[]) => ({
  scopes,
  pkiEnabled: false,
  siemEnabled: false,
  loggingEnabled: false,
  inferenceEnabled: false,
});

describe("Apps navigation item", () => {
  it("sits in Main right after Dashboard", () => {
    const main = APP_NAVIGATION_GROUPS.find((group) => group.id === "main");
    expect(main?.items.map((item) => item.id).slice(0, 2)).toEqual(["dashboard", "apps"]);
    expect(main?.items[1]?.href).toBe("/apps");
  });

  it("shows for users who may view or create apps only", () => {
    const hasApps = (scopes: string[]) =>
      visibleNavigationGroups(context(scopes))
        .flatMap((group) => group.items)
        .some((item) => item.id === "apps");
    expect(hasApps(["apps:view"])).toBe(true);
    expect(hasApps(["apps:create"])).toBe(true);
    expect(hasApps(["proxy:view"])).toBe(false);
  });
});
