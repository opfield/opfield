import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { ContentLoading } from "@/components/common/ContentLoading";
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
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { ManagedDatabaseMoveToValkeyCheck } from "@/types";

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * Moves a managed key-value store that still runs Redis to Valkey. Opening it checks the store on
 * its node first; the move is offered only when nothing blocks it.
 */
export function MoveToValkeyDialog({
  open,
  managedDatabaseId,
  onOpenChange,
  onMoved,
}: {
  open: boolean;
  managedDatabaseId: string;
  onOpenChange: (open: boolean) => void;
  onMoved: () => void;
}) {
  const [loadedCheck, setLoadedCheck] = useState<ManagedDatabaseMoveToValkeyCheck | null>(null);
  const [acceptPendingStreamLoss, setAcceptPendingStreamLoss] = useState(false);
  const [moving, setMoving] = useState(false);
  const check = useRetainedDialogValue(loadedCheck, open);

  useEffect(() => {
    if (!open) {
      setLoadedCheck(null);
      setAcceptPendingStreamLoss(false);
      return;
    }
    let cancelled = false;
    api
      .getManagedDatabaseMoveToValkeyCheck(managedDatabaseId)
      .then((result) => {
        if (!cancelled) setLoadedCheck(result);
      })
      .catch((error) => {
        if (cancelled) return;
        toastApiError(error, "Failed to check the key-value store");
        onOpenChange(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, managedDatabaseId, onOpenChange]);

  const blocked = (check?.blockers.length ?? 0) > 0;
  const hasPendingStreamEntries = (check?.pendingStreamEntries ?? 0) > 0;
  const pendingStreamEntries = plural(
    check?.pendingStreamEntries ?? 0,
    "pending stream entry",
    "pending stream entries"
  );
  const canMove = !!check && !blocked && (!hasPendingStreamEntries || acceptPendingStreamLoss);

  const move = async () => {
    if (!check || !canMove || moving) return;
    setMoving(true);
    try {
      const moved = await api.moveManagedDatabaseToValkey(
        managedDatabaseId,
        hasPendingStreamEntries ? { acceptPendingStreamLoss: true } : {}
      );
      toast.success(moved.status === "updating" ? "Moving to Valkey" : "Moved to Valkey");
      onOpenChange(false);
      onMoved();
    } catch (error) {
      toastApiError(error, "Failed to move to Valkey");
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !moving && onOpenChange(nextOpen)}>
      <DialogContent hideCloseButton={moving}>
        <ContentLoading loading={open && loadedCheck === null} />
        <DialogHeader>
          <DialogTitle>Move to Valkey</DialogTitle>
        </DialogHeader>
        {check ? (
          <div className="space-y-4">
            <DialogDescription className="break-words [overflow-wrap:anywhere]">
              Copies {plural(check.keys, "key", "keys")} into Valkey {check.toVersion} on the same
              node and switches this key-value store to it. Writes pause for about{" "}
              {check.estimatedPauseSeconds.toLocaleString()} s while the keys are copied; reads keep
              working until the switch. The Redis data stays on the node until the copy is verified,
              and the store goes back to Redis if anything fails.
            </DialogDescription>
            {blocked ? (
              <Notice tone="destructive" title="Valkey cannot take over">
                {check.blockers.join(", ")}. Remove them and try again.
              </Notice>
            ) : null}
            {hasPendingStreamEntries ? (
              <>
                <Notice tone="warning" title={`${pendingStreamEntries} will not be moved`}>
                  Consumers won't see them again.
                </Notice>
                <CheckboxCard
                  label="Move without the pending stream entries"
                  checked={acceptPendingStreamLoss}
                  onCheckedChange={setAcceptPendingStreamLoss}
                  disabled={blocked || moving}
                />
              </>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={moving}>
            Cancel
          </Button>
          <Button pending={moving} disabled={!canMove} onClick={() => void move()}>
            Move to Valkey
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
