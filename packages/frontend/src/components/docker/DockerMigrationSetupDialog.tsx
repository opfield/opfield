import { Truck } from "lucide-react";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { ContentLoading } from "@/components/common/ContentLoading";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Node } from "@/types";
import type { MigrationResource } from "./DockerMigrationDialog";

export function DockerMigrationSetupDialog({
  open,
  resource,
  nodes,
  targetNodeId,
  keepSource,
  loadingTargets,
  loadingPreflight,
  onTargetNodeChange,
  onKeepSourceChange,
  onRunPreflight,
  onClose,
}: {
  open: boolean;
  resource: MigrationResource;
  nodes: Node[];
  targetNodeId: string;
  keepSource: boolean;
  loadingTargets: boolean;
  loadingPreflight: boolean;
  onTargetNodeChange: (value: string) => void;
  onKeepSourceChange: (value: boolean) => void;
  onRunPreflight: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Migrate {resource.type}</DialogTitle>
          <DialogDescription>
            Move {resource.displayName} to another Docker node after compatibility checks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* The dialog opens once the target nodes are known. */}
          <ContentLoading loading={loadingTargets} />
          <div className="space-y-1.5">
            <label htmlFor="migration-target" className="text-sm font-medium">
              Target node
            </label>
            <Select value={targetNodeId} onValueChange={onTargetNodeChange}>
              <SelectTrigger id="migration-target" disabled={loadingTargets || nodes.length === 0}>
                <SelectValue placeholder="Select a Docker node" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!loadingTargets && nodes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No compatible online target nodes.</p>
            ) : null}
          </div>

          <CheckboxCard
            label="Keep source resource"
            description="Leave the source stopped with restart disabled after cutover."
            checked={keepSource}
            onCheckedChange={onKeepSourceChange}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onRunPreflight}
            pending={loadingPreflight}
            disabled={!targetNodeId || loadingTargets}
          >
            <Truck className="h-4 w-4" />
            Run preflight
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
