import type { Dispatch, SetStateAction } from "react";
import { useAuthStore } from "@/stores/auth";
import { MOUNT_INPUT_CELL, pendingVolumesError } from "../docker-detail/pending-container-volumes";
import { type MountEntry, VolumeMountsSection } from "../docker-detail/VolumeMountsSection";

/**
 * The Volumes step of a container created from a repository: managed volumes saved with it and mounted when its
 * first build creates and starts it. The mount editor of the Settings tab.
 */
export function DockerDeployVolumesStep({
  nodeId,
  mounts,
  onMountsChange,
}: {
  nodeId: string;
  mounts: MountEntry[];
  onMountsChange: Dispatch<SetStateAction<MountEntry[]>>;
}) {
  const { hasScopedAccess } = useAuthStore();
  return (
    <VolumeMountsSection
      nodeId={nodeId}
      canEdit={hasScopedAccess("docker:volumes:view")}
      canChangeHostBinds={false}
      mounts={mounts}
      setMounts={onMountsChange}
      mountsChanged={false}
      inputCell={MOUNT_INPUT_CELL}
      description={
        pendingVolumesError(mounts) ?? "Mounted when the first build creates the container"
      }
    />
  );
}
