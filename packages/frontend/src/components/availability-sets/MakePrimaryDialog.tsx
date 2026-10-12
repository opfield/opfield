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
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { AvailabilityMember, AvailabilityOwner, AvailabilityView } from "@/types";
import { AVAILABILITY_CAPABILITY, memberName, primaryOf } from "./availability-labels";

interface LossEstimate {
  message: string;
  lossBytes: number | null;
  /** The old primary's last report, when it is gone (writes after it may be lost). */
  lastReportedAt: string | null;
}

function lossDetail(loss: LossEstimate): string {
  const amount =
    loss.lossBytes !== null && loss.lossBytes > 0 ? `about ${formatBytes(loss.lossBytes)}` : null;
  if (loss.lastReportedAt) {
    return `Writes after ${formatDateTime(loss.lastReportedAt)} may be lost${amount ? `, ${amount}` : ""}.`;
  }
  return amount ? `This copy is ${amount} behind.` : "Recent writes may be missing on this copy.";
}

/**
 * Whether making `member` primary may lose writes, judged from the view: the primary stopped
 * reporting, or the copy cannot take over (behind, not confirming). The backend decides; a
 * planned switch it refuses as lossy turns the dialog into the lossy confirmation.
 */
export function lossEstimateOf(
  view: AvailabilityView,
  member: AvailabilityMember
): LossEstimate | null {
  const primary = primaryOf(view);
  const primaryLost = !primary?.reporting;
  if (!primaryLost && member.eligible) return null;
  return {
    message: primaryLost
      ? "The primary is not reporting. Writes it took after its last report may be lost."
      : "This copy cannot take over without losing writes.",
    lossBytes: member.lagBytes,
    lastReportedAt: primaryLost ? (primary?.lastReportedAt ?? null) : null,
  };
}

/**
 * "Make this copy primary": a planned switch loses nothing; a lossy one (primary gone, copy
 * behind) shows the estimate and asks to type the resource name.
 */
export function MakePrimaryDialog({
  owner,
  view,
  member: memberProp,
  resourceName,
  onClose,
  onDone,
}: {
  owner: AvailabilityOwner;
  view: AvailabilityView;
  member: AvailabilityMember | null;
  resourceName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = memberProp !== null;
  const member = useRetainedDialogValue(memberProp, open);
  const [loss, setLoss] = useState<LossEstimate | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from what the view says about this copy; later view refreshes do not
  // reset the estimate or the typed name.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is read when the dialog opens
  useEffect(() => {
    if (!memberProp) return;
    setLoss(lossEstimateOf(view, memberProp));
    setConfirmation("");
    setError(null);
  }, [memberProp]);

  const primary = primaryOf(view);
  const submit = async () => {
    if (!member) return;
    setSaving(true);
    setError(null);
    try {
      await api.makeAvailabilityPrimary(owner, member.id, loss !== null);
      toast.success(loss ? "Promoting the copy" : "Switching the primary");
      onDone();
      onClose();
    } catch (failure) {
      setSaving(false);
      if (failure instanceof ApiRequestError && failure.code === "AVAILABILITY_LOSSY_PROMOTION") {
        const details = (failure.details ?? {}) as {
          lossBytes?: unknown;
          lastReportedAt?: unknown;
        };
        setLoss({
          message: failure.message.replace(/ Confirm with acceptDataLoss\.?$/, ""),
          lossBytes: typeof details.lossBytes === "number" ? details.lossBytes : member.lagBytes,
          lastReportedAt:
            typeof details.lastReportedAt === "string" ? details.lastReportedAt : null,
        });
      } else if (!handleLicenseApiError(failure, AVAILABILITY_CAPABILITY)) {
        setError(failure instanceof Error ? failure.message : "Failed to switch the primary");
      }
    }
  };

  const name = member ? memberName(member) : "";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make {name} Primary</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {loss ? "This switch may lose recent writes." : "A planned switch loses no writes."}
        </DialogDescription>
        <div className="space-y-4">
          {loss ? (
            <>
              <Notice tone="destructive" title="Writes may be lost">
                <p>{loss.message}</p>
                <p className="mt-1 text-xs">
                  {lossDetail(loss)} When the old primary comes back, it rejoins as a copy and drops
                  those writes.
                </p>
              </Notice>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="make-primary-confirm">
                  Type {resourceName} to confirm
                </label>
                <Input
                  id="make-primary-confirm"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {primary ? memberName(primary) : "The primary"} stops taking writes, {name} catches up
              and takes over, and the old primary becomes a copy. Clients reconnect once.
            </p>
          )}
          {error ? (
            <Notice tone="warning" title="Not switched">
              {error}
            </Notice>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={loss ? "destructive" : "default"}
            pending={saving}
            disabled={loss !== null && confirmation !== resourceName}
            onClick={() => void submit()}
          >
            {loss ? "Promote and accept loss" : "Make primary"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
