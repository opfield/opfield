import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { AvailabilityOwner, AvailabilityView } from "@/types";
import { AVAILABILITY_CAPABILITY, memberName, ownerNoun, primaryOf } from "./availability-labels";

/** Back to one server: the primary stays, every copy and its data goes. */
export function DisableAvailabilityDialog({
  open,
  onOpenChange,
  owner,
  view,
  resourceName,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: AvailabilityOwner;
  view: AvailabilityView;
  resourceName: string;
  onDone: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const primary = primaryOf(view);

  useEffect(() => {
    if (open) setConfirmation("");
  }, [open]);

  const submit = async () => {
    setSaving(true);
    try {
      await api.disableAvailability(owner);
      toast.success("Turning off availability");
      onDone();
      onOpenChange(false);
    } catch (error) {
      if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
        toast.error(error instanceof Error ? error.message : "Failed to turn off availability");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Turn Off Availability</DialogTitle>
          <DialogDescription>The {ownerNoun(owner)} goes back to one server.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {primary ? memberName(primary) : "The primary"} keeps the data and keeps serving. The
            copies on the other servers are removed with their data, and there is no failover until
            you turn availability on again.
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="availability-disable-confirm">
              Type {resourceName} to confirm
            </label>
            <Input
              id="availability-disable-confirm"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            pending={saving}
            disabled={confirmation !== resourceName}
            onClick={() => void submit()}
          >
            Turn off availability
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
