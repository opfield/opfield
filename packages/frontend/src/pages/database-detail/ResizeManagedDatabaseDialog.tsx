import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
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
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";
import {
  keyValueStorageWarning,
  type ManagedDatabaseCapacity,
  managedDatabaseCapacity,
} from "./managed-database-capacity";

export function ResizeManagedDatabaseDialog({
  database,
  open,
  onOpenChange,
  onResized,
}: {
  database: DatabaseConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResized: () => void;
}) {
  const managed = database.managed!;
  // Sizes are in GB with at most one decimal place, as at create.
  const currentStorageSizeGb = Math.round((managed.storageSizeBytes / 1024 ** 3) * 10) / 10;
  const suggestedStorageSizeGb = Math.round((currentStorageSizeGb + 1) * 10) / 10;
  const [storageSizeGb, setStorageSizeGb] = useState(String(suggestedStorageSizeGb));
  const [capacity, setCapacity] = useState<ManagedDatabaseCapacity | null>(null);
  // The node's free space sets the maximum size; cleared on close so each opening waits for it.
  const [capacityLoaded, setCapacityLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);

  const present = useDialogPresence(open);

  useEffect(() => {
    if (!present) {
      setCapacityLoaded(false);
      return;
    }
    if (!open) return;

    let cancelled = false;
    setStorageSizeGb(String(suggestedStorageSizeGb));
    setCapacity(null);
    api
      .getNode(managed.nodeId)
      .then((node) => {
        if (!cancelled) setCapacity(managedDatabaseCapacity(node));
      })
      .catch(() => {
        if (!cancelled) setCapacity(null);
      })
      .finally(() => {
        if (!cancelled) setCapacityLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [managed.nodeId, open, present, suggestedStorageSizeGb]);

  const nextStorageSizeGb = Number(storageSizeGb);
  const maximumStorageSizeGb =
    capacity?.storageSizeGb === undefined
      ? undefined
      : Math.round((currentStorageSizeGb + capacity.storageSizeGb) * 10) / 10;
  const isValidSize =
    Number.isFinite(nextStorageSizeGb) &&
    Math.abs(nextStorageSizeGb * 10 - Math.round(nextStorageSizeGb * 10)) < 1e-9 &&
    nextStorageSizeGb > currentStorageSizeGb &&
    (maximumStorageSizeGb === undefined || nextStorageSizeGb <= maximumStorageSizeGb);

  const storageWarning =
    database.type === "redis" && isValidSize
      ? keyValueStorageWarning(
          nextStorageSizeGb,
          managed.runtimeConfig.memoryMb,
          managed.redisConfig?.maxmemoryPercent
        )
      : undefined;

  const resize = async () => {
    if (!isValidSize) return;
    setSaving(true);
    try {
      await api.updateManagedDatabase(managed.id, { storageSizeGb: nextStorageSizeGb });
      toast.success("Database storage resized");
      onOpenChange(false);
      onResized();
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to resize database storage");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resize Database</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ContentLoading loading={open && !capacityLoaded} />
          <DialogDescription>
            Database storage can only be increased. This change expands the managed storage image
            without recreating the database.
          </DialogDescription>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-database-resize-storage">
              New storage size, GB
            </label>
            <Input
              id="managed-database-resize-storage"
              type="number"
              min={currentStorageSizeGb}
              step="0.1"
              max={maximumStorageSizeGb}
              value={storageSizeGb}
              onChange={(event) => setStorageSizeGb(event.target.value)}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              {maximumStorageSizeGb === undefined
                ? `Enter a size greater than ${currentStorageSizeGb} GB, with at most one decimal place.`
                : `Larger than ${currentStorageSizeGb} GB, at most one decimal place. Maximum available now: ${maximumStorageSizeGb} GB.`}
            </p>
            {storageWarning && <p className="text-xs text-warning-text">{storageWarning}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void resize()}
            pending={saving}
            disabled={!isValidSize}
          >
            Resize database
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
