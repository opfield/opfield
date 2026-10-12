import { describe, expect, it } from "vitest";
import { deriveFamilyLimit, whereLabel } from "./ScopeSectionLimit";

const label = (target: string) => target.slice("folder/".length);

describe("deriveFamilyLimit", () => {
  it("reads a header choice back after save: every row carries the same places", () => {
    // Picked "shop" and "prod-env" in the header: each selected scope was saved with both.
    const saved = [
      ["folder/shop", "folder/prod-env"],
      ["folder/prod-env", "folder/shop"],
      ["folder/shop", "folder/prod-env"],
    ];
    const derived = deriveFamilyLimit(saved);
    expect(derived).toEqual({ targets: ["folder/shop", "folder/prod-env"], mixed: false });
    expect(whereLabel(derived.targets, label)).toBe("2 places");
  });

  it("keeps one place as the section's place", () => {
    expect(whereLabel(deriveFamilyLimit([["folder/shop"]]).targets, label)).toBe("shop");
  });

  it("is everywhere without restrictions", () => {
    expect(deriveFamilyLimit([[], []])).toEqual({ targets: [], mixed: false });
    expect(deriveFamilyLimit([])).toEqual({ targets: [], mixed: false });
  });

  it("ignores rows limited to single resources", () => {
    expect(deriveFamilyLimit([["folder/shop"], ["node-1/container-7"]])).toEqual({
      targets: ["folder/shop"],
      mixed: false,
    });
  });

  it("shows where differing rows reach together, without dropping a place", () => {
    expect(deriveFamilyLimit([["folder/shop"], ["folder/shop"], ["folder/public"]])).toEqual({
      targets: ["folder/shop", "folder/public"],
      mixed: true,
    });
  });

  it("is everywhere when one differing row reaches everywhere", () => {
    expect(deriveFamilyLimit([["folder/shop"], []])).toEqual({ targets: [], mixed: true });
  });
});
