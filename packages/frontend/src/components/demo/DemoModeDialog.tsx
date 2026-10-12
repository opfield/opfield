import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DEMO_CTA_URL, useDemoModeStore } from "@/stores/demo-mode";

export function DemoModeDialog() {
  const open = useDemoModeStore((state) => state.open);
  const close = useDemoModeStore((state) => state.close);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>This Action Is Unavailable in the Demo</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <p className="text-sm text-muted-foreground">
            You can explore the configured Opfield, but changes, credentials, consoles, and external
            automation are locked in the public demo.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button asChild>
            <a href={DEMO_CTA_URL} target="_blank" rel="noreferrer">
              Get your own Opfield
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
