import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { nodeRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import type { IngressGroup, IngressGroupMember } from "@/types";
import { AddIngressGroupMemberDialog } from "./AddIngressGroupMemberDialog";
import { MEMBER_STATE_BADGE, memberHealthLabel, memberName } from "./ingress-group-format";

interface IngressGroupMembersPanelProps {
  group: IngressGroup;
  canManage: boolean;
  onChanged: () => void;
}

/** Members in site-preference order with their state, health and delivery; order, add and remove. */
export function IngressGroupMembersPanel({
  group,
  canManage,
  onChanged,
}: IngressGroupMembersPanelProps) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const move = async (index: number, offset: -1 | 1) => {
    const order = group.members.map((member) => member.nodeId);
    const target = index + offset;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    setBusy(true);
    try {
      await api.reorderIngressGroup(group.id, order);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change the order");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: IngressGroupMember) => {
    const name = memberName(member);
    const draining = member.state === "draining";
    const ok = await confirm({
      title: draining ? `Remove ${name} now?` : `Remove ${name}?`,
      description: draining
        ? `${name} is draining: it is removed on its own once no public name resolves to it. Removing it now stops it serving while DNS caches may still send clients to it.`
        : member.state === "joining"
          ? `${name} was never published in DNS; it is removed at once.`
          : `${name} is withdrawn from DNS first and keeps serving until no public name of the group resolves to it (at most 24 hours); then its configs, certificates and Secure Link sources are removed.`,
      confirmLabel: draining ? "Remove now" : "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.removeIngressGroupMember(group.id, member.nodeId, { force: draining });
      toast.success(
        draining || member.state === "joining" ? "Member removed" : "Member is draining"
      );
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove the member");
    } finally {
      setBusy(false);
    }
  };

  const columns: SimpleTableColumn<IngressGroupMember>[] = [
    {
      id: "order",
      header: "#",
      className: "w-10",
      render: (member) => (
        <span className="text-sm text-muted-foreground">{member.priority + 1}</span>
      ),
    },
    {
      id: "node",
      header: "Node",
      render: (member) => (
        <div className="min-w-0">
          {member.node ? (
            <Link to={nodeRoute(member.node.slug)} className="text-sm font-medium hover:underline">
              {memberName(member)}
            </Link>
          ) : (
            <span className="text-sm font-medium">{memberName(member)}</span>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {member.node?.addresses.join(", ") || "No public ingress address"}
          </p>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      render: (member) => {
        const state = MEMBER_STATE_BADGE[member.state];
        return (
          <div className="space-y-1">
            <Badge variant={state.variant} title={state.help}>
              {state.label}
            </Badge>
            {member.state === "draining" && member.drainStartedAt && (
              <p className="text-xs text-muted-foreground">
                since <RelativeTime value={member.drainStartedAt} />
              </p>
            )}
          </div>
        );
      },
    },
    {
      id: "health",
      header: "Ingress health",
      render: (member) => {
        const health = memberHealthLabel(member);
        return (
          <div className="space-y-1">
            <Badge variant={health.variant}>{health.label}</Badge>
            {health.detail && <p className="text-xs text-muted-foreground">{health.detail}</p>}
          </div>
        );
      },
    },
    {
      id: "delivery",
      header: "Routes",
      render: (member) => (
        <div className="flex flex-wrap gap-1">
          <Badge variant="success">{member.delivery.ready} applied</Badge>
          {member.delivery.pending > 0 && (
            <Badge variant="warning">{member.delivery.pending} pending</Badge>
          )}
          {member.delivery.failed > 0 && (
            <Badge variant="destructive">{member.delivery.failed} failed</Badge>
          )}
        </div>
      ),
    },
    {
      id: "error",
      header: "Last error",
      render: (member) => (
        <p className="line-clamp-2 text-xs text-muted-foreground">{member.lastError || "—"}</p>
      ),
    },
    ...(canManage
      ? [
          {
            id: "actions",
            header: "",
            align: "right" as const,
            className: "w-32",
            render: (member: IngressGroupMember) => {
              const index = group.members.indexOf(member);
              return (
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move up"
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move down"
                    disabled={busy || index === group.members.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove member"
                    disabled={busy}
                    onClick={() => remove(member)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <PanelShell
      title="Members"
      description="Site-preference order: the first active member is recorded as the node of the group's routes and domains."
      actions={
        canManage ? (
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add Member
          </Button>
        ) : null
      }
    >
      <SimpleTable
        columns={columns}
        rows={group.members}
        getRowKey={(member) => member.nodeId}
        emptyMessage="No members."
      />
      <AddIngressGroupMemberDialog
        open={adding}
        onOpenChange={setAdding}
        group={group}
        onAdded={onChanged}
      />
    </PanelShell>
  );
}
