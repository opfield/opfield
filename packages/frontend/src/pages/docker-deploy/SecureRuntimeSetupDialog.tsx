import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SecureRuntimeSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenNodeSettings: () => void;
}

export function SecureRuntimeSetupDialog({
  open,
  onOpenChange,
  onOpenNodeSettings,
}: SecureRuntimeSetupDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Secure Runtime Setup Required</DialogTitle>
        </DialogHeader>
        <div>
          <p className="text-sm text-muted-foreground">
            Set up Secure Runtime on this node before using it for a container or deployment.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={onOpenNodeSettings}>
            <Settings className="h-4 w-4" />
            Open node settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
