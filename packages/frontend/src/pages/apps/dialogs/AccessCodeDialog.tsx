import { CopyButton } from "@/components/common/CopyButton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import type { AppMaintenanceAccessCode } from "@/types";
import { plural } from "../app-shared";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

export interface AccessCodeState extends AppMaintenanceAccessCode {
  /** "Shop" or "live of Shop". */
  scopeLabel: string;
}

/** The route page's Maintenance Access Code dialog, for every route of an app or environment. */
export function AccessCodeDialog({
  value,
  onClose,
}: {
  value: AccessCodeState | null;
  onClose: () => void;
}) {
  const shown = useRetainedDialogValue(value, value !== null);
  return (
    <Dialog
      open={value !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Maintenance Access Code</DialogTitle>
          <DialogDescription>
            Share this one-time code only with the person who needs temporary access. It opens{" "}
            {shown ? `${plural(shown.routeCount, "route")} of ${shown.scopeLabel}` : "the routes"}{" "}
            in maintenance once each and expires in 5 minutes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 rounded-md overflow-hidden border border-input bg-background">
          <Input
            value={shown?.code ?? ""}
            readOnly
            aria-label="Maintenance access code"
            className="min-w-0 flex-1 border-0 bg-transparent font-mono focus-visible:ring-0"
          />
          <CopyButton
            value={shown?.code ?? ""}
            label="maintenance access code"
            className="border-l border-border"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
