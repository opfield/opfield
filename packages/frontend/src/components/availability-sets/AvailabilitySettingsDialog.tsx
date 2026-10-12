import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type {
  AvailabilityDurability,
  AvailabilityOwner,
  AvailabilitySettingsInput,
  AvailabilityView,
} from "@/types";
import { type AvailabilityEngine, fixedDurabilityOf } from "./AvailabilityCreateSection";
import { AVAILABILITY_CAPABILITY, AVAILABILITY_FEATURE } from "./availability-labels";
import { DurabilityNotice } from "./DurabilityNotice";

/** Durability and switching back to the preferred server of an availability set. */
export function AvailabilitySettingsDialog({
  open,
  onOpenChange,
  owner,
  engine,
  view,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: AvailabilityOwner;
  engine: AvailabilityEngine;
  view: AvailabilityView;
  onDone: () => void;
}) {
  const fixed = fixedDurabilityOf(engine);
  const [durability, setDurability] = useState<AvailabilityDurability>(view.durability);
  const [priorityMode, setPriorityMode] = useState(view.priorityMode);
  const [failbackDelay, setFailbackDelay] = useState(String(view.failbackDelaySeconds));
  const [saving, setSaving] = useState(false);

  // Each opening starts from the saved settings.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is read when the dialog opens
  useEffect(() => {
    if (!open) return;
    setDurability(view.durability);
    setPriorityMode(view.priorityMode);
    setFailbackDelay(String(view.failbackDelaySeconds));
  }, [open]);

  const delay = Number(failbackDelay);
  const delayValid = Number.isInteger(delay) && delay >= 0 && delay <= 3600;

  const submit = async () => {
    if (!requireLicenseFeature(AVAILABILITY_FEATURE, AVAILABILITY_CAPABILITY)) return;
    const input: AvailabilitySettingsInput = {};
    if (!fixed && durability !== view.durability) input.durability = durability;
    if (priorityMode !== view.priorityMode) input.priorityMode = priorityMode;
    if (delay !== view.failbackDelaySeconds) input.failbackDelaySeconds = delay;
    setSaving(true);
    try {
      await api.updateAvailabilitySettings(owner, input);
      toast.success("Availability settings saved");
      onDone();
      onOpenChange(false);
    } catch (error) {
      if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
        toastApiError(error, "Failed to save the settings");
      }
    } finally {
      setSaving(false);
    }
  };

  const unchanged =
    durability === view.durability &&
    priorityMode === view.priorityMode &&
    delay === view.failbackDelaySeconds;

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Availability Settings</DialogTitle>
          <DialogDescription>
            How writes reach the copies and when the primary moves back.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {fixed ? null : (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="availability-settings-durability">
                Durability
              </label>
              <Select
                value={durability}
                onValueChange={(next) => setDurability(next as AvailabilityDurability)}
              >
                <SelectTrigger id="availability-settings-durability">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="synchronous"
                    description="A commit returns after the copy has it."
                  >
                    Synchronous
                  </SelectItem>
                  <SelectItem value="asynchronous" description="A commit returns at once.">
                    Asynchronous
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {fixed ? null : (
            <DurabilityNotice
              durability={durability}
              rttP50Ms={view.rttP50Ms}
              lossWindowText={
                durability === view.durability
                  ? view.lossWindowText
                  : durability === "synchronous"
                    ? "Synchronous: an automatic failover loses no acknowledged commit while the copy confirms."
                    : "Asynchronous: an automatic failover can lose the most recent writes the copy has not received."
              }
            />
          )}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Switch back to the first server</p>
              <p className="text-xs text-muted-foreground">
                After a failover, move the primary back once that server is healthy again.
              </p>
            </div>
            <Switch
              checked={priorityMode}
              onChange={setPriorityMode}
              ariaLabel="Switch back to the first server"
            />
          </div>
          {priorityMode ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="availability-settings-failback">
                Wait before switching back (seconds)
              </label>
              <Input
                id="availability-settings-failback"
                type="number"
                min={0}
                max={3600}
                value={failbackDelay}
                onChange={(event) => setFailbackDelay(event.target.value)}
              />
            </div>
          ) : null}
          {!delayValid ? (
            <Notice tone="warning" title="Check the wait">
              Use 0 to 3600 seconds.
            </Notice>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            pending={saving}
            disabled={unchanged || !delayValid}
            onClick={() => void submit()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
