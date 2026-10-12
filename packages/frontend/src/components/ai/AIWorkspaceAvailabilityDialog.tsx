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

export type AIWorkspaceAvailability = "needs_configuration" | "not_configured" | "no_access";

export function AIWorkspaceAvailabilityDialog({
  state,
  onClose,
  onConfigure,
}: {
  state: AIWorkspaceAvailability | null;
  onClose: () => void;
  onConfigure: () => void;
}) {
  const visibleState = useRetainedDialogValue(state, state !== null);
  const canConfigure = visibleState === "needs_configuration";
  const title =
    visibleState === "no_access"
      ? "AI Workspace Access Required"
      : "AI Workspace Is Not Configured";
  const description =
    visibleState === "no_access"
      ? "Your account does not have access to AI Workspace. Ask an administrator to grant the AI Workspace permission."
      : canConfigure
        ? "AI Workspace needs a model connection before it can be used. Configure it now or continue in Operations Console."
        : "An administrator has not configured AI Workspace yet. Operations Console remains fully available.";

  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription>{description}</DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {canConfigure && <Button onClick={onConfigure}>Configure AI Workspace</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
