import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsInlineControl } from "@/components/common/SettingsControlRow";
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
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { AppDetail } from "@/types";
import { memberTotal, plural } from "../app-shared";
import { markAppDeleted } from "../use-app";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

/** Delete App: members keep running and leave the app; type the name to confirm. */
export function DeleteAppDialog({
  app,
  open,
  onOpenChange,
  onDeleted,
}: {
  app: AppDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const members = app.environments.reduce((sum, env) => sum + memberTotal(env.memberCounts), 0);

  useEffect(() => {
    if (open) setConfirmation("");
  }, [open]);

  const remove = async () => {
    setDeleting(true);
    // The app's page stops reloading before the request, so the deletion's realtime events never fetch it again.
    markAppDeleted(app.id);
    try {
      await api.deleteApp(app.id);
      onDeleted();
      onOpenChange(false);
      toast.success(`App ${app.name} deleted`);
    } catch (error) {
      markAppDeleted(app.id, false);
      toastApiError(error, "Failed to delete the app");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Delete {app.name}</DialogTitle>
          <DialogDescription>Type {app.name} to confirm.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              {members > 0
                ? `${plural(members, "resource")} keep running and leave the app`
                : "The app has no resources"}
            </li>
            <li>Environment variables, secrets and allowed nodes are deleted</li>
            <li>Access granted for the app and its environments is removed</li>
          </ul>
          <SettingsInlineControl label={`Type ${app.name}`}>
            <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </SettingsInlineControl>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            pending={deleting}
            disabled={confirmation !== app.name}
            onClick={() => void remove()}
          >
            Delete app
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
