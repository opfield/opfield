import { Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/services/api";

export interface MountEntry {
  hostPath: string;
  containerPath: string;
  name: string;
  readOnly: boolean;
  existing?: boolean;
}

function comparableMount(mount: MountEntry) {
  return JSON.stringify({
    hostPath: mount.hostPath,
    containerPath: mount.containerPath,
    name: mount.name,
    readOnly: mount.readOnly,
  });
}

/** Docker's rule for a named volume; mirrors the backend's volume create schema. */
const MANAGED_VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

export function serializeMounts(mounts: MountEntry[]) {
  return JSON.stringify(mounts.map(comparableMount));
}

export async function ensureManagedMountVolumes(
  nodeId: string,
  mounts: MountEntry[],
  baseline: MountEntry[]
) {
  const unchanged = new Set(baseline.map(comparableMount));
  const requiredNames = new Set(
    mounts
      .filter(
        (mount) => mount.name && mount.containerPath && !unchanged.has(comparableMount(mount))
      )
      .map((mount) => mount.name)
  );
  if (requiredNames.size === 0) return;
  // Checked before anything is created, so one bad row cannot leave half the volumes behind.
  for (const name of requiredNames) {
    if (!MANAGED_VOLUME_NAME_PATTERN.test(name)) {
      throw new Error(
        `"${name}" is not a valid volume name. Use letters, digits, "_", "." and "-", starting with a letter or digit. Host paths are not supported: select or create a managed volume.`
      );
    }
  }
  const existing = new Set((await api.listManagedVolumeOptions(nodeId)).map((row) => row.name));
  for (const name of requiredNames) {
    if (!existing.has(name)) await api.createVolume(nodeId, { name });
  }
}

interface VolumeMountsSectionProps {
  /** Attach and change managed volumes (the workload's edit and view access to volumes). */
  canEdit: boolean;
  /** Remove a legacy host bind mount (docker:containers:mounts). */
  canChangeHostBinds: boolean;
  mounts: MountEntry[];
  setMounts: React.Dispatch<React.SetStateAction<MountEntry[]>>;
  mountsChanged: boolean;
  inputCell: string;
  nodeId: string;
  disabledReason?: string;
}

export function VolumeMountsSection({
  canEdit,
  canChangeHostBinds,
  mounts,
  setMounts,
  mountsChanged,
  inputCell,
  nodeId,
  disabledReason,
}: VolumeMountsSectionProps) {
  const [managedVolumeNames, setManagedVolumeNames] = useState<string[]>([]);
  const [volumeOptionsLoaded, setVolumeOptionsLoaded] = useState(false);
  useContentLoading(!volumeOptionsLoaded);
  useEffect(() => {
    let cancelled = false;
    setVolumeOptionsLoaded(false);
    void api
      .listManagedVolumeOptions(nodeId)
      .then((rows) => {
        if (!cancelled) setManagedVolumeNames(rows.map((row) => row.name));
      })
      .catch(() => {
        if (!cancelled) setManagedVolumeNames([]);
      })
      .finally(() => {
        if (!cancelled) setVolumeOptionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);
  const volumeOptions = useMemo<ComboboxOption[]>(
    () => managedVolumeNames.map((name) => ({ value: name, label: name })),
    [managedVolumeNames]
  );
  const addMount = () =>
    setMounts((m) => [
      ...m,
      { hostPath: "", containerPath: "", name: "", readOnly: false, existing: false },
    ]);
  const removeMount = (i: number) => setMounts((m) => m.filter((_, idx) => idx !== i));
  const updateMount = (i: number, field: keyof MountEntry, val: string | boolean) =>
    setMounts((m) => m.map((entry, idx) => (idx === i ? { ...entry, [field]: val } : entry)));

  return (
    <PanelShell
      title={
        <SettingsHelpTitle
          label="Volume Mounts"
          help="Mounts persistent named volumes or host paths into the container. Data outside the container writable layer survives container recreation."
        />
      }
      description={disabledReason ?? "Requires container recreation"}
      dirty={mountsChanged}
      actions={
        canEdit ? (
          <Button onClick={addMount}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        ) : null
      }
    >
      {mounts.length > 0 ? (
        <>
          <div
            className={`grid ${canEdit ? "grid-cols-[1fr_1fr_100px_36px]" : "grid-cols-[1fr_1fr_100px]"} border-b border-border bg-header text-xs font-medium text-muted-foreground uppercase tracking-wider`}
          >
            <div className="px-3 py-2">Source</div>
            <div className="px-3 py-2 border-l border-border">Container Path</div>
            <div className="px-3 py-2 border-l border-border">Mode</div>
            {canEdit && <div />}
          </div>
          <div>
            {mounts.map((m, i) =>
              (() => {
                const legacy =
                  m.existing === true &&
                  (m.hostPath.length > 0 ||
                    (volumeOptionsLoaded && !managedVolumeNames.includes(m.name)));
                return (
                  <div
                    key={i}
                    className={`grid ${canEdit ? "grid-cols-[1fr_1fr_100px_36px]" : "grid-cols-[1fr_1fr_100px]"} border-b border-border last:border-b-0`}
                  >
                    <Combobox
                      freeText
                      inputClassName={inputCell}
                      value={m.hostPath || m.name}
                      options={volumeOptions}
                      onValueChange={(value) => {
                        updateMount(i, "name", value);
                        updateMount(i, "hostPath", "");
                      }}
                      placeholder="Select or create a volume"
                      searchPlaceholder="Search or enter a volume name..."
                      emptyMessage="Enter a name to create a volume."
                      disabled={!canEdit || legacy}
                    />
                    <div className="border-l border-border">
                      <Input
                        className={inputCell}
                        value={m.containerPath}
                        onChange={(e) => updateMount(i, "containerPath", e.target.value)}
                        placeholder="/container/path"
                        disabled={!canEdit || legacy}
                      />
                    </div>
                    <div className="border-l border-border">
                      <Select
                        value={m.readOnly ? "ro" : "rw"}
                        onValueChange={(v) => updateMount(i, "readOnly", v === "ro")}
                        disabled={!canEdit || legacy}
                      >
                        <SelectTrigger className="h-9 border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="rw">RW</SelectItem>
                          <SelectItem value="ro">RO</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove mount"
                        title="Remove mount"
                        className="shrink-0 rounded-none border-l border-border"
                        onClick={() => removeMount(i)}
                        disabled={m.hostPath.length > 0 && !canChangeHostBinds}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        </>
      ) : (
        <EmptyState message="No volume mounts" embedded />
      )}
    </PanelShell>
  );
}
