import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Notice } from "@/components/common/Notice";
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
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { AvailabilityOwner, AvailabilityView, Node } from "@/types";
import { AVAILABILITY_CAPABILITY, AVAILABILITY_FEATURE } from "./availability-labels";

/** Adds a server to an availability set: it copies the data, then becomes a copy. */
export function AddMemberDialog({
  open,
  onOpenChange,
  owner,
  view,
  nodes,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: AvailabilityOwner;
  view: AvailabilityView;
  nodes: Node[];
  onDone: () => void;
}) {
  const [nodeId, setNodeId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [error, setError] = useState<string | null>(null);
  const memberNodeIds = new Set(view.members.map((member) => member.nodeId));
  const choices = nodes.filter((node) => !memberNodeIds.has(node.id));

  useEffect(() => {
    if (!open) return;
    setNodeId("");
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!requireLicenseFeature(AVAILABILITY_FEATURE, AVAILABILITY_CAPABILITY)) return;
    setSaving(true);
    setError(null);
    try {
      await api.addAvailabilityMember(owner, nodeId);
      toast.success("Adding the server");
      onDone();
      onOpenChange(false);
    } catch (failure) {
      setSaving(false);
      if (!handleLicenseApiError(failure, AVAILABILITY_CAPABILITY)) {
        setError(failure instanceof Error ? failure.message : "Failed to add the server");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Server</DialogTitle>
        </DialogHeader>
        <DialogDescription>The new server copies the data, then can take over.</DialogDescription>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="availability-add-node">
              Server
            </label>
            <Select value={nodeId} onValueChange={setNodeId}>
              <SelectTrigger id="availability-add-node">
                <SelectValue placeholder="Select node" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {choices.length === 0
                ? "Every online storage node already holds a server of this set."
                : "Use a storage node on another host. Witnesses are picked again for the new count."}
            </p>
          </div>
          {error ? (
            <Notice tone="warning" title="Not added">
              {error}
            </Notice>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button pending={saving} disabled={!nodeId} onClick={() => void submit()}>
            Add server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
