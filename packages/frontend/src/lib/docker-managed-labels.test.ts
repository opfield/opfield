import { describe, expect, it } from "vitest";
import { hasManagedLabelPrefix, isManagedLabelKey, managedLabel } from "./docker-managed-labels";

describe("managed Docker labels", () => {
  it("reads the Opfield key first and falls back to the previous one", () => {
    expect(
      managedLabel(
        { "net.opfield.deployment.id": "new", "wiolett.gateway.deployment.id": "old" },
        "deployment.id"
      )
    ).toBe("new");
    expect(managedLabel({ "wiolett.gateway.deployment.id": "old" }, "deployment.id")).toBe("old");
    expect(managedLabel({}, "deployment.id")).toBeUndefined();
    expect(managedLabel(undefined, "deployment.id")).toBeUndefined();
  });

  it("matches keys and prefixes under both names", () => {
    expect(isManagedLabelKey("net.opfield.gpu.group-ids", "gpu.group-ids")).toBe(true);
    expect(isManagedLabelKey("wiolett.gateway.gpu.group-ids", "gpu.group-ids")).toBe(true);
    expect(isManagedLabelKey("app.gpu.group-ids", "gpu.group-ids")).toBe(false);
    expect(hasManagedLabelPrefix("net.opfield.availability.policy", "availability.")).toBe(true);
    expect(hasManagedLabelPrefix("wiolett.gateway.availability.policy", "availability.")).toBe(
      true
    );
  });
});
