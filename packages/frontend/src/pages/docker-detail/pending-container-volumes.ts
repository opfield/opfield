import type { DockerSourceContainerVolume } from "@/types";
import type { MountEntry } from "./VolumeMountsSection";

/** The shared input cell of the mount editor rows, as on the Settings tab. */
export const MOUNT_INPUT_CELL =
  "h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

/** Saved volumes of a container its first build has not created yet, as rows of the mount editor. */
export function volumesAsMounts(volumes: DockerSourceContainerVolume[] | undefined): MountEntry[] {
  return (volumes ?? []).map((volume) => ({
    hostPath: "",
    containerPath: volume.containerPath,
    name: volume.name,
    readOnly: volume.readOnly,
    existing: false,
  }));
}

/** The mount editor rows as the volumes the first build creates the container with; empty rows are left out. */
export function mountsAsVolumes(mounts: MountEntry[]): DockerSourceContainerVolume[] {
  return mounts
    .filter((mount) => mount.name.trim() || mount.containerPath.trim())
    .map((mount) => ({
      name: mount.name.trim(),
      containerPath: mount.containerPath.trim(),
      readOnly: mount.readOnly,
    }));
}

/** Why the rows cannot be saved: a row without a volume or an absolute path, or two rows at one path. */
export function pendingVolumesError(mounts: MountEntry[]): string | null {
  const volumes = mountsAsVolumes(mounts);
  if (volumes.some((volume) => !volume.name)) return "Select a volume for every mount";
  if (volumes.some((volume) => !volume.containerPath.startsWith("/")))
    return "Container paths must be absolute";
  const paths = volumes.map((volume) => volume.containerPath.replace(/\/+$/, "") || "/");
  if (new Set(paths).size !== paths.length) return "A path takes one volume";
  return null;
}
