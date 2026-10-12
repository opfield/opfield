// Isolate <app> (canvas frame app-kill): the kill switch for a security incident. Scope, the
// consequences with live counts, then type the app name to confirm.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Notice } from "@/components/common/Notice";
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
import { APP_DIALOG_WIDTH } from "./AppNameDialog";
import {
  Consequences,
  defaultScope,
  type IncidentScope,
  isolationConsequences,
  ScopeSelect,
  scopeEnvironmentIds,
  useIncidentPreview,
} from "./incident-scope";

export function KillSwitchDialog({
  app,
  open,
  onOpenChange,
  onDone,
}: {
  app: AppDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [scope, setScope] = useState<IncidentScope>(() => defaultScope(app));
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const { preview, error } = useIncidentPreview(app, "isolation", scope, open);

  useEffect(() => {
    if (!open) return;
    setScope(defaultScope(app));
    setConfirmation("");
  }, [open, app]);

  const isolate = async () => {
    setPending(true);
    try {
      await api.isolateApp(app.id, scopeEnvironmentIds(scope), confirmation);
      toast.success(`${app.name} is being isolated`);
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toastApiError(reason, "Failed to isolate the app");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Isolate {app.name}</DialogTitle>
          <DialogDescription>
            For a security incident. Select the scope, then type {app.name} to confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ScopeSelect app={app} value={scope} onChange={setScope} disabled={pending} />
          {error ? (
            <Notice tone="destructive" title={error} />
          ) : (
            <Consequences items={preview ? isolationConsequences(preview.summary) : null} />
          )}
          <SettingsInlineControl label={`Type ${app.name}`}>
            <Input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-label={`Type ${app.name}`}
            />
          </SettingsInlineControl>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            pending={pending}
            disabled={!scope || confirmation !== app.name}
            onClick={() => void isolate()}
          >
            Isolate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
