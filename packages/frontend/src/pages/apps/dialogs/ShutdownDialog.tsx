// Shut Down <app> (canvas frame app-shutdown): stops what can be stopped in the chosen scope; Start
// brings back exactly that set.
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
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { AppDetail } from "@/types";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";
import {
  Consequences,
  defaultScope,
  type IncidentScope,
  ScopeSelect,
  scopeEnvironmentIds,
  shutdownBlockedReason,
  shutdownConsequences,
  useIncidentPreview,
} from "./incident-scope";

export function ShutdownDialog({
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
  const [pending, setPending] = useState(false);
  const { preview, error } = useIncidentPreview(app, "shutdown", scope, open);
  const blocked = scope ? shutdownBlockedReason(app, scope) : null;

  useEffect(() => {
    if (open) setScope(defaultScope(app));
  }, [open, app]);

  const shutDown = async () => {
    setPending(true);
    try {
      await api.shutdownApp(app.id, scopeEnvironmentIds(scope));
      toast.success(`${app.name} is shutting down`);
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toastApiError(reason, "Failed to shut down the app");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Shut Down {app.name}</DialogTitle>
          <DialogDescription>
            Stops what can be stopped. Members stay editable while it is shut down; Start brings
            back what still exists.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ScopeSelect app={app} value={scope} onChange={setScope} disabled={pending} />
          {blocked ? (
            <p className="text-sm text-destructive">{blocked}</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <Consequences items={preview ? shutdownConsequences(preview.summary) : null} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            pending={pending}
            disabled={!scope || blocked !== null}
            title={blocked ?? undefined}
            onClick={() => void shutDown()}
          >
            Shut down
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
