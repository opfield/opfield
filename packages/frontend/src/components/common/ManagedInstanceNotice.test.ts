import { describe, expect, it } from "vitest";
import { managedInstanceCondition } from "./ManagedInstanceNotice";

describe("managed instance condition", () => {
  it("reads the condition Opfield recorded from the node", () => {
    expect(
      managedInstanceCondition(
        "MANAGED_DISK_REPAIRING: The database disk went read-only after a write to it failed. The engine is stopped while the disk is checked and repaired; it starts again on its own."
      )
    ).toEqual({
      code: "MANAGED_DISK_REPAIRING",
      tone: "warning",
      title: "Disk is being repaired",
      message:
        "The database disk went read-only after a write to it failed. The engine is stopped while the disk is checked and repaired; it starts again on its own.",
    });
    expect(managedInstanceCondition("MANAGED_DISK_REPAIR_FAILED: x")?.tone).toBe("destructive");
    expect(managedInstanceCondition("MANAGED_ENGINE_OOM: x")?.title).toBe(
      "Engine ran out of memory"
    );
    expect(managedInstanceCondition("MANAGED_NODE_DISK_OVERSUBSCRIBED: x")?.title).toBe(
      "Node disk is oversubscribed"
    );
  });

  it("shows nothing for other errors", () => {
    expect(managedInstanceCondition(null)).toBeNull();
    expect(managedInstanceCondition("Managed database update failed: timeout")).toBeNull();
    expect(managedInstanceCondition("MANAGED_STORAGE_FULL: The storage disk is full")).toBeNull();
  });
});
