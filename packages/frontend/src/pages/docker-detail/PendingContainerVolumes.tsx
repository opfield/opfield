import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DockerSourceContainerVolume } from "@/types";
import {
  MOUNT_INPUT_CELL,
  mountsAsVolumes,
  pendingVolumesError,
  volumesAsMounts,
} from "./pending-container-volumes";
import {
  ensureManagedMountVolumes,
  type MountEntry,
  serializeMounts,
  VolumeMountsSection,
} from "./VolumeMountsSection";

/**
 * The volume mounts of a container its first build has not created yet: the mount editor of the Settings tab,
 * saved with the container's creation settings. The first build creates and starts the container with them.
 */
export function PendingContainerVolumes({
  nodeId,
  containerName,
  scopeResourceId,
  volumes,
  onSaved,
}: {
  nodeId: string;
  containerName: string;
  scopeResourceId: string;
  volumes: DockerSourceContainerVolume[] | undefined;
  onSaved: (volumes: DockerSourceContainerVolume[]) => void;
}) {
  const { hasScope, hasScopedAccess } = useAuthStore();
  const canEdit =
    hasScope(`docker:containers:edit:${nodeId}/${scopeResourceId}`) &&
    hasScopedAccess("docker:volumes:view");
  const [baseline, setBaseline] = useState<MountEntry[]>(() => volumesAsMounts(volumes));
  const [mounts, setMounts] = useState<MountEntry[]>(baseline);
  const [saving, setSaving] = useState(false);
  const changed = serializeMounts(mounts) !== serializeMounts(baseline);
  const error = pendingVolumesError(mounts);

  const save = async () => {
    if (saving || !changed || error) return;
    const ok = await confirm({
      title: "Save",
      description: `Save the volume mounts of “${containerName}”? They apply when the first build creates the container.`,
      confirmLabel: "Save",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await ensureManagedMountVolumes(nodeId, mounts, baseline);
      const saved = await api.updatePendingContainerVolumes(
        nodeId,
        containerName,
        mountsAsVolumes(mounts)
      );
      const next = volumesAsMounts(saved.volumes);
      setBaseline(next);
      setMounts(next);
      onSaved(saved.volumes);
      toast.success("Volume mounts saved — they apply when the first build creates the container");
    } catch (saveError) {
      toastApiError(saveError, "Failed to save volume mounts");
    } finally {
      setSaving(false);
    }
  };

  return (
    <VolumeMountsSection
      nodeId={nodeId}
      canEdit={canEdit}
      canChangeHostBinds={false}
      mounts={mounts}
      setMounts={setMounts}
      mountsChanged={changed}
      inputCell={MOUNT_INPUT_CELL}
      description={changed && error ? error : "Applied when the first build creates the container"}
      saveAction={
        <Button
          variant="warning"
          onClick={() => void save()}
          pending={saving}
          disabled={!changed || !!error}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Save
        </Button>
      }
    />
  );
}
