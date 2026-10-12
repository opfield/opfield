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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
import { nodeTypeLabel } from "@/lib/node-appearance";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail, Node } from "@/types";
import { nodeDisplayName } from "../use-node-index";

/** Allow Node: pick from the node list; the node itself does not move. */
export function AllowNodeDialog({
  app,
  env,
  nodes,
  open,
  onOpenChange,
  onAllowed,
}: {
  app: Pick<AppDetail, "id">;
  env: AppEnvironmentDetail;
  /** Every node the user may see. */
  nodes: Node[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAllowed: () => void;
}) {
  const candidates = nodes
    .filter((node) => !env.allowedNodeIds.includes(node.id))
    .sort((a, b) => nodeDisplayName(a, a.id).localeCompare(nodeDisplayName(b, b.id)));
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);

  useEffect(() => {
    if (open) setNodeId(null);
  }, [open]);

  const allow = async () => {
    if (!nodeId) return;
    setSaving(true);
    try {
      await api.allowAppNode(app.id, env.id, nodeId);
      const node = nodes.find((item) => item.id === nodeId);
      toast.success(`${nodeDisplayName(node, nodeId)} allowed in ${env.name}`);
      onOpenChange(false);
      onAllowed();
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to allow the node");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Allow Node</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Resources of {env.name} can then be created on it. The node stays in the node list and in
          its folder.
        </DialogDescription>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="app-allow-node">
            Node
          </label>
          <Select value={nodeId ?? undefined} onValueChange={setNodeId}>
            <SelectTrigger id="app-allow-node" aria-label="Node">
              <SelectValue
                placeholder={candidates.length > 0 ? "Select a node" : "Every node is allowed"}
              />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((node) => (
                <SelectItem key={node.id} value={node.id} description={nodeTypeLabel(node.type)}>
                  {nodeDisplayName(node, node.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void allow()} pending={saving} disabled={!nodeId}>
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
