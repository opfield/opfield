import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { IngressGroup, Node } from "@/types";
import { isNodeIncompatible } from "@/types";

interface IngressGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edits name and description of this group; creates a group when absent. */
  group?: IngressGroup | null;
  onSaved?: (group: IngressGroup) => void;
}

/** Whether the node's daemon reports the capability (capabilities.capabilities is the reported list). */
export function nodeReportsCapability(
  node: Pick<Node, "capabilities">,
  capability: string
): boolean {
  const reported = (node.capabilities as { capabilities?: unknown } | null | undefined)
    ?.capabilities;
  return Array.isArray(reported) && reported.includes(capability);
}

/** Nginx nodes whose daemon can be a member (ingress_group_v1). */
export function ingressGroupCandidateNodes(nodes: Node[]): Node[] {
  return nodes.filter(
    (node) =>
      node.type === "nginx" &&
      !isNodeIncompatible(node) &&
      nodeReportsCapability(node, "ingress_group_v1")
  );
}

export function IngressGroupDialog({
  open,
  onOpenChange,
  group,
  onSaved,
}: IngressGroupDialogProps) {
  const id = useId();
  const editing = !!group;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setDescription(group?.description ?? "");
    setSelected([]);
    if (group) return;
    let cancelled = false;
    void api
      .listNodes({ type: "nginx" })
      .then((response) => {
        if (!cancelled) setNodes(ingressGroupCandidateNodes(response.data ?? []));
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, group]);

  const toggle = (nodeId: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, nodeId] : current.filter((candidate) => candidate !== nodeId)
    );
  const valid = name.trim() !== "" && (editing || selected.length > 0);
  const order = useMemo(
    () => new Map(selected.map((nodeId, index) => [nodeId, index + 1])),
    [selected]
  );

  const save = async () => {
    setSaving(true);
    try {
      const saved = editing
        ? await api.updateIngressGroup(group.id, {
            name: name.trim(),
            description: description.trim() || null,
          })
        : await api.createIngressGroup({
            name: name.trim(),
            description: description.trim() || null,
            nodeIds: selected,
          });
      toast.success(editing ? "Ingress group updated" : "Ingress group created");
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      toastApiError(error, "Failed to save the ingress group");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Ingress Group" : "New Ingress Group"}</DialogTitle>
          <DialogDescription>
            Nginx nodes, normally one per site, that serve the same routes and domains. Each member
            keeps its own config and certificates, so it keeps serving when another member or
            Opfield is down.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              Name
            </label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={255}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production edge"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-description`} className="text-sm font-medium">
              Description
            </label>
            <Input
              id={`${id}-description`}
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional"
            />
          </div>
          {!editing && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Members</p>
              <p className="text-xs text-muted-foreground">
                Select in site-preference order: the first selected node is preferred. Only nginx
                nodes whose daemon supports ingress groups are listed.
              </p>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {nodes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No nginx node supports ingress groups yet. Update the nginx daemons first.
                  </p>
                ) : (
                  nodes.map((node) => (
                    <CheckboxCard
                      key={node.id}
                      checked={order.has(node.id)}
                      onCheckedChange={(checked) => toggle(node.id, checked)}
                      disabled={node.serviceCreationLocked}
                      label={
                        <>
                          {order.has(node.id) ? `${order.get(node.id)}. ` : ""}
                          {node.displayName || node.hostname}
                        </>
                      }
                      description={`${node.hostname} · ${node.status}`}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid} pending={saving}>
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
