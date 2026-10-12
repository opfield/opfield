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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
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
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const primary = primaryOf(view);
  // No member holds the primary role (members that cannot take over): the admin picks the server whose data stays.
  const noHolder = view.mode === "automatic" && !!view.lease && !view.lease.holderNodeId;
  const members = view.members.filter((member) => member.desiredState === "member");
  const [keepMemberId, setKeepMemberId] = useState("");

  useEffect(() => {
    if (open) {
      setConfirmation("");
      setKeepMemberId(primary?.id ?? members[0]?.id ?? "");
    }
  }, [open, primary?.id, members[0]?.id]);

  const submit = async () => {
    setSaving(true);
    try {
      await api.disableAvailability(
        owner,
        noHolder && keepMemberId ? { force: true, keepMemberId } : undefined
      );
      toast.success("Turning off availability");
      onDone();
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
        toastApiError(error, "Failed to turn off availability");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Turn Off Availability</DialogTitle>
        </DialogHeader>
        <DialogDescription>The {ownerNoun(owner)} goes back to one server.</DialogDescription>
        <div className="space-y-4">
          {noHolder ? (
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">
                No server holds the primary role, so there is no primary to keep. Choose the server
                whose data stays; it serves alone. The other servers are removed with their data.
              </p>
              <label className="text-sm font-medium" htmlFor="availability-disable-keep">
                Keep
              </label>
              <Select value={keepMemberId} onValueChange={setKeepMemberId}>
                <SelectTrigger id="availability-disable-keep">
                  <SelectValue placeholder="Select server" />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {memberName(member)}
                      {member.id === view.primaryMemberId ? " (last primary)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {primary ? memberName(primary) : "The primary"} keeps the data and keeps serving. The
              copies on the other servers are removed with their data, and there is no failover
              until you turn availability on again.
            </p>
          )}
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
            disabled={confirmation !== resourceName || (noHolder && !keepMemberId)}
            onClick={() => void submit()}
          >
            Turn off availability
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
