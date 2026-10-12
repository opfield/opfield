import { CopyValueField } from "@/components/common/CopyValueField";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
    // close-reset-ok: false positive, `value` is the code display prop; content reads `shown`
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
        <CopyValueField
          label="Maintenance access code"
          showLabel={false}
          value={shown?.code ?? ""}
          valueClassName="font-mono"
        />
      </DialogContent>
    </Dialog>
  );
}
