import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { IngressGroupDialog } from "@/components/ingress-groups/IngressGroupDialog";
import { IngressGroupMembersPanel } from "@/components/ingress-groups/IngressGroupMembersPanel";
import { IngressGroupRoutesPanel } from "@/components/ingress-groups/IngressGroupRoutesPanel";
import { groupHealthBadge } from "@/components/ingress-groups/ingress-group-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLeavePage } from "@/hooks/use-navigation-trail";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { ingressGroupsRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { usePublishedPageResource } from "@/stores/resolved-page-context";
import type { IngressGroupDetail as IngressGroupDetailData } from "@/types";

const NO_SCOPES: string[] = [];

export function IngressGroupDetail() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const leavePage = useLeavePage();
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const [group, setGroup] = useState<IngressGroupDetailData | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      setGroup(await api.getIngressGroup(groupId));
      setMissing(false);
    } catch (error) {
      setMissing(true);
      toastApiError(error, "Failed to load the ingress group");
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("ingress_group.changed", (payload) => {
    if ((payload as { id?: string } | undefined)?.id === groupId) void load();
  });
  useRealtime("node.changed", () => void load());
  useRealtime("proxy.host.changed", () => void load());
  usePublishedPageResource(
    groupId ? `/ingress-groups/${encodeURIComponent(groupId)}` : undefined,
    group ? { resourceType: "ingress-group", resourceId: group.id, label: group.name } : null
  );

  if (missing && !group) {
    return (
      <PageTransition>
        <div className="p-6">
          <EmptyState
            message="Ingress group not found."
            actionLabel="Back to Ingress Groups"
            onAction={() => navigate(ingressGroupsRoute())}
          />
        </div>
      </PageTransition>
    );
  }
  if (!group) return <DetailPageSkeleton label="Loading ingress group" />;

  const canManage = canCreateInFolder(scopes, "ingress:groups:manage", group.folderId);
  const health = groupHealthBadge(group);

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${group.name}?`,
      description:
        "Only a group without routes and domains can be deleted: move them to one node (or delete them) first. The members stay nginx nodes.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteIngressGroup(group.id);
      toast.success("Ingress group deleted");
      leavePage(ingressGroupsRoute());
    } catch (error) {
      toastApiError(error, "Failed to delete the ingress group");
    }
  };

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <PageHeader
          leading={<PageBackButton onClick={() => navigate(ingressGroupsRoute())} />}
          title={group.name}
          description={
            group.description || `${group.routeCount} routes · ${group.domainCount} domains`
          }
          badges={<Badge variant={health.variant}>{health.label}</Badge>}
          actions={
            canManage ? (
              <ResponsiveHeaderActions
                actions={[
                  {
                    label: "Edit",
                    icon: <Pencil className="h-4 w-4" />,
                    onClick: () => setEditing(true),
                  },
                  { label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: remove },
                ]}
              >
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" />
                  Edit
                </Button>
                <Button variant="outline" onClick={remove}>
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
              </ResponsiveHeaderActions>
            ) : null
          }
        />
        <Notice tone="info" title="DNS failover: none">
          {group.dnsFailoverNote}
        </Notice>
        <IngressGroupMembersPanel
          group={group}
          canManage={canManage}
          onChanged={() => void load()}
        />
        <IngressGroupRoutesPanel group={group} />
        <IngressGroupDialog
          open={editing}
          onOpenChange={setEditing}
          group={group}
          onSaved={() => void load()}
        />
      </div>
    </PageTransition>
  );
}
