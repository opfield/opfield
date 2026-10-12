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
import { api } from "@/services/api";
import type { IngressGroup, Node } from "@/types";
import { ingressGroupCandidateNodes } from "./IngressGroupDialog";

interface AddIngressGroupMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: IngressGroup;
  onAdded?: (group: IngressGroup) => void;
}

const END_POSITION = "end";

export function AddIngressGroupMemberDialog({
  open,
  onOpenChange,
  group,
  onAdded,
}: AddIngressGroupMemberDialogProps) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [position, setPosition] = useState(END_POSITION);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setNodeId("");
    setPosition(END_POSITION);
    let cancelled = false;
    const members = new Set(group.members.map((member) => member.nodeId));
    void api
      .listNodes({ type: "nginx" })
      .then((response) => {
        if (cancelled) return;
        setNodes(
          ingressGroupCandidateNodes(response.data ?? []).filter((node) => !members.has(node.id))
        );
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, group.members]);

  const add = async () => {
    setSaving(true);
    try {
      const updated = await api.addIngressGroupMember(group.id, {
        nodeId,
        ...(position === END_POSITION ? {} : { position: Number(position) }),
      });
      const member = updated.members.find((candidate) => candidate.nodeId === nodeId);
      toast.success(
        member?.state === "active"
          ? "Member added and published in DNS"
          : "Member added; it joins once every route reached it"
      );
      onAdded?.(updated);
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to add the member");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Member</DialogTitle>
          <DialogDescription>
            The node receives every route config, certificate and Secure Link source of the group
            first; its address is published in DNS only after that. An offline node stays joining
            until it reconnects.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Node</p>
            <Select value={nodeId || undefined} onValueChange={setNodeId}>
              <SelectTrigger aria-label="Node">
                <SelectValue placeholder="Select an nginx node..." />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id} disabled={node.serviceCreationLocked}>
                    {node.displayName || node.hostname} ({node.status})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {nodes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other nginx node supports ingress groups.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Site preference</p>
            <Select value={position} onValueChange={setPosition}>
              <SelectTrigger aria-label="Site preference">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {group.members.map((member, index) => (
                  <SelectItem key={member.nodeId} value={String(index)}>
                    Position {index + 1}
                  </SelectItem>
                ))}
                <SelectItem value={END_POSITION}>Last</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={add} disabled={!nodeId} pending={saving}>
            Add Member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
