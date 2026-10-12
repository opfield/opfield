import { Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDialogPresence,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { type DockerGpuAttachment, gpuDeviceLabel, type NodeGpuDevice } from "@/types";

interface GpuUsage {
  deviceId: string;
  containerCount: number;
  containers: Array<{ name: string }>;
}

export function normalizeGpuDeviceIds(ids: readonly string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function gpuVramLabel(device?: NodeGpuDevice) {
  const total = device?.memoryTotalBytes;
  return typeof total === "number" && total > 0 ? formatBytes(total) : "—";
}

function containerCountLabel(count: number) {
  return `${count} container${count === 1 ? "" : "s"}`;
}

export function GpuSettingsSection({
  nodeId,
  attachment,
  canEdit,
  deviceIds,
  dirty,
  onDeviceIdsChange,
}: {
  nodeId: string;
  attachment: DockerGpuAttachment;
  canEdit: boolean;
  deviceIds: string[];
  dirty: boolean;
  onDeviceIdsChange: (deviceIds: string[]) => void;
}) {
  const [gpuDevices, setGpuDevices] = useState<NodeGpuDevice[]>([]);
  const [gpuInventoryLoaded, setGpuInventoryLoaded] = useState(false);
  const [gpuUsage, setGpuUsage] = useState<GpuUsage[]>([]);
  const [gpuUsageLoaded, setGpuUsageLoaded] = useState(false);
  const [gpuUsageUnavailable, setGpuUsageUnavailable] = useState(false);
  const [gpuAddOpen, setGpuAddOpen] = useState(false);
  // Without GPUs the section is omitted, so the tab waits for the inventory and usage first.
  useContentLoading(!gpuInventoryLoaded || !gpuUsageLoaded);
  const [gpuCandidateId, setGpuCandidateId] = useState("");
  const gpuAddPresent = useDialogPresence(gpuAddOpen);
  // Reset once the close animation has played, so the closing dialog keeps its content.
  useEffect(() => {
    if (!gpuAddPresent) setGpuCandidateId("");
  }, [gpuAddPresent]);

  useEffect(() => {
    let cancelled = false;
    setGpuInventoryLoaded(false);
    void api
      .getNode(nodeId)
      .then((node) => {
        if (cancelled) return;
        setGpuDevices(node.liveHealthReport?.gpuDevices ?? node.lastHealthReport?.gpuDevices ?? []);
      })
      .catch(() => {
        if (!cancelled) setGpuDevices([]);
      })
      .finally(() => {
        if (!cancelled) setGpuInventoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  useEffect(() => {
    let cancelled = false;
    if (attachment.mode === "external") {
      setGpuUsage([]);
      setGpuUsageLoaded(true);
      setGpuUsageUnavailable(false);
      return () => {
        cancelled = true;
      };
    }

    setGpuUsageLoaded(false);
    setGpuUsageUnavailable(false);
    void api
      .listDockerGpuUsage(nodeId)
      .then((usage) => {
        if (!cancelled) setGpuUsage(usage);
      })
      .catch(() => {
        if (!cancelled) {
          setGpuUsage([]);
          setGpuUsageUnavailable(true);
        }
      })
      .finally(() => {
        if (!cancelled) setGpuUsageLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [attachment.mode, nodeId]);

  const gpuDevicesById = useMemo(
    () => new Map(gpuDevices.map((device) => [device.id, device])),
    [gpuDevices]
  );
  const addableGpuDevices = useMemo(
    () => gpuDevices.filter((device) => device.attachable && !deviceIds.includes(device.id)),
    [deviceIds, gpuDevices]
  );
  const gpuUsageByDevice = useMemo(
    () => new Map(gpuUsage.map((usage) => [usage.deviceId, usage])),
    [gpuUsage]
  );
  const tableGridColumns = canEdit
    ? "grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)_minmax(0,1fr)_36px]"
    : "grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)_minmax(0,1fr)]";

  if (
    gpuInventoryLoaded &&
    gpuDevices.length === 0 &&
    deviceIds.length === 0 &&
    attachment.mode !== "external"
  ) {
    return null;
  }

  return (
    <>
      <PanelShell
        title={
          <SettingsHelpTitle
            label="GPU"
            help="Assigns specific host GPU devices to the container. The container image must include compatible drivers and libraries, and changes require recreation."
          />
        }
        description="Requires container recreation"
        dirty={dirty}
        actions={
          canEdit && attachment.mode !== "external" ? (
            <Button
              type="button"
              disabled={!gpuInventoryLoaded || addableGpuDevices.length === 0}
              onClick={() => {
                setGpuCandidateId(addableGpuDevices[0]?.id ?? "");
                setGpuAddOpen(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          ) : null
        }
      >
        {attachment.mode === "external" ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {attachment.reason || "This GPU mapping cannot be safely changed by Opfield."}
          </p>
        ) : !gpuInventoryLoaded ? null : deviceIds.length > 0 ? (
          <>
            <div
              className={`grid ${tableGridColumns} border-b border-border bg-header text-xs font-medium text-muted-foreground uppercase tracking-wider`}
            >
              <div className="px-3 py-2">GPU</div>
              <div className="border-l border-border px-3 py-2">VRAM</div>
              <div className="border-l border-border px-3 py-2">Containers</div>
              <div className="border-l border-border px-3 py-2">Identifier</div>
              {canEdit && <div />}
            </div>
            <div>
              {deviceIds.map((deviceId) => {
                const device = gpuDevicesById.get(deviceId);
                const usage = gpuUsageByDevice.get(deviceId);

                return (
                  <div
                    key={deviceId}
                    className={`grid ${tableGridColumns} border-b border-border last:border-b-0`}
                  >
                    <div className="flex min-h-9 min-w-0 items-center px-3 py-2 text-sm">
                      <span className="truncate font-medium">
                        {device ? gpuDeviceLabel(device) : "GPU no longer reported by this node"}
                      </span>
                    </div>
                    <div className="flex min-h-9 items-center border-l border-border px-3 py-2 text-sm text-muted-foreground">
                      {gpuVramLabel(device)}
                    </div>
                    <div className="flex min-h-9 min-w-0 items-center border-l border-border px-3 py-2 text-sm">
                      {!gpuUsageLoaded ? (
                        <span className="text-muted-foreground">Loading…</span>
                      ) : gpuUsageUnavailable ? (
                        <span className="text-muted-foreground">Unavailable</span>
                      ) : !usage || usage.containerCount === 0 ? (
                        <span className="text-muted-foreground">No containers</span>
                      ) : (
                        <span className="font-medium">
                          {containerCountLabel(usage.containerCount)}
                        </span>
                      )}
                    </div>
                    <div className="flex min-h-9 min-w-0 items-center border-l border-border px-3 py-2 font-mono text-xs text-muted-foreground">
                      <span className="truncate" title={deviceId}>
                        {deviceId}
                      </span>
                    </div>
                    {canEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0 rounded-none border-l border-border"
                        onClick={() => onDeviceIdsChange(deviceIds.filter((id) => id !== deviceId))}
                        aria-label={`Remove ${device ? gpuDeviceLabel(device) : deviceId}`}
                        title="Remove GPU"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <EmptyState
            message={
              gpuDevices.length === 0
                ? "No GPUs are currently reported by this node. Existing GPU selection will be preserved."
                : "No GPUs attached"
            }
            embedded
          />
        )}
      </PanelShell>

      <Dialog
        open={gpuAddOpen}
        onOpenChange={(open) => {
          setGpuAddOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add GPU</DialogTitle>
            <DialogDescription>
              Physical GPUs are shared with other containers on this node. This selection is applied
              when you save and recreate this container.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="container-gpu-device">
              GPU
            </label>
            <Select value={gpuCandidateId} onValueChange={setGpuCandidateId}>
              <SelectTrigger id="container-gpu-device">
                <SelectValue placeholder="Select GPU" />
              </SelectTrigger>
              <SelectContent>
                {addableGpuDevices.map((gpu) => (
                  <SelectItem key={gpu.id} value={gpu.id} description={gpu.id}>
                    {gpuDeviceLabel(gpu)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setGpuAddOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!gpuCandidateId}
              onClick={() => {
                if (!gpuCandidateId) return;
                onDeviceIdsChange(normalizeGpuDeviceIds([...deviceIds, gpuCandidateId]));
                setGpuAddOpen(false);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              Add GPU
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
