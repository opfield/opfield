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

export interface PlacementGroupChoice {
  id: string;
  name: string;
  memberNodeIds: string[];
  memberLabels: string[];
}

interface IngressPlacementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "route" | "domain";
  resourceId: string;
  /** Route folder, to list the groups a route there may use. */
  folderId?: string | null;
  currentNodeId: string | null;
  /** Set when the resource is on a group: the dialog then moves it back to one member. */
  currentGroup: {
    id: string;
    name: string;
    members: Array<{ nodeId: string; label: string }>;
  } | null;
  onChanged: () => void;
}

/**
 * Moves a route or domain onto an ingress group (config and certificates reach the new members first, DNS last), or
 * back to one member node (DNS first, then the other members are cleaned up). The node that serves it now must stay
 * among the nodes that serve it, so nothing stops serving during the move.
 */
export function IngressPlacementDialog({
  open,
  onOpenChange,
  kind,
  resourceId,
  folderId,
  currentNodeId,
  currentGroup,
  onChanged,
}: IngressPlacementDialogProps) {
  const [groups, setGroups] = useState<PlacementGroupChoice[]>([]);
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setChoice(currentGroup ? (currentNodeId ?? "") : "");
    if (currentGroup) return;
    let cancelled = false;
    const load =
      kind === "route"
        ? api.listRouteIngressGroups(folderId).then((options) =>
            options.map((group) => ({
              id: group.id,
              name: group.name,
              memberNodeIds: group.members.map((member) => member.id),
              memberLabels: group.members.map((member) => member.displayName || member.hostname),
            }))
          )
        : api.listDomainIngressGroups().then((options) =>
            options.map((group) => ({
              id: group.id,
              name: group.name,
              memberNodeIds: group.members.map((member) => member.id),
              memberLabels: group.members.map((member) => member.displayName || member.hostname),
            }))
          );
    void load
      .then((result) => {
        if (!cancelled) setGroups(result);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, folderId, currentGroup, currentNodeId]);

  const apply = async () => {
    setSaving(true);
    try {
      if (kind === "route") {
        await api.changeRouteIngressPlacement(
          resourceId,
          currentGroup ? { ingressGroupId: null, nodeId: choice } : { ingressGroupId: choice }
        );
      } else {
        await api.changeDomainIngressPlacement(
          resourceId,
          currentGroup ? { ingressGroupId: null, nginxNodeId: choice } : { ingressGroupId: choice }
        );
      }
      toast.success(
        currentGroup ? "Now served from one node" : "Now served by every member of the group"
      );
      onChanged();
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to change where it is served");
    }
  };

  const subject = kind === "route" ? "route" : "domain and its routes";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {currentGroup ? "Serve From One Node" : "Serve From an Ingress Group"}
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {currentGroup
            ? `DNS is changed first; then the ${subject} leave the other members of ${currentGroup.name}. The node you keep serves throughout.`
            : `Config and certificates reach every member first; DNS changes last. The node that serves the ${subject} now must be a member and keeps serving throughout.`}
        </DialogDescription>
        <Select value={choice || undefined} onValueChange={setChoice}>
          <SelectTrigger aria-label={currentGroup ? "Node" : "Ingress group"}>
            <SelectValue
              placeholder={currentGroup ? "Select the node to keep..." : "Select a group..."}
            />
          </SelectTrigger>
          <SelectContent>
            {currentGroup
              ? currentGroup.members.map((member) => (
                  <SelectItem key={member.nodeId} value={member.nodeId}>
                    {member.label}
                  </SelectItem>
                ))
              : groups.map((group) => {
                  const keepsServing =
                    !currentNodeId || group.memberNodeIds.includes(currentNodeId);
                  return (
                    <SelectItem key={group.id} value={group.id} disabled={!keepsServing}>
                      {group.name} · {group.memberLabels.join(", ")}
                      {keepsServing ? "" : " (the current node is not a member)"}
                    </SelectItem>
                  );
                })}
          </SelectContent>
        </Select>
        {!currentGroup && groups.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No ingress group is available to you. Groups are created on the Ingress Groups page.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!choice} pending={saving}>
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
