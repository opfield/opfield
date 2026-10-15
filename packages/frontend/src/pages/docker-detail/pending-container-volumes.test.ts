import { describe, expect, it } from "vitest";
import { mountsAsVolumes, pendingVolumesError, volumesAsMounts } from "./pending-container-volumes";
import type { MountEntry } from "./VolumeMountsSection";

const row = (name: string, containerPath: string, readOnly = false): MountEntry => ({
  hostPath: "",
  name,
  containerPath,
  readOnly,
});

describe("volumes of a container before its first build", () => {
  it("round-trips the saved list through the mount editor rows and leaves out empty rows", () => {
    const saved = [{ name: "rin-data", containerPath: "/data", readOnly: true }];
    expect(mountsAsVolumes([...volumesAsMounts(saved), row("", "")])).toEqual(saved);
  });

  it("names what blocks a save", () => {
    expect(pendingVolumesError([row("rin-data", "/data")])).toBeNull();
    expect(pendingVolumesError([row("", "/data")])).toBe("Select a volume for every mount");
    expect(pendingVolumesError([row("rin-data", "data")])).toBe("Container paths must be absolute");
    expect(pendingVolumesError([row("a", "/data"), row("b", "/data/")])).toBe(
      "A path takes one volume"
    );
  });
});
