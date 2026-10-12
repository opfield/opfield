import { Network } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ingressGroupRoute } from "@/lib/resource-routes";
import { hasScopeBase } from "@/lib/scope-utils";
import { useAuthStore } from "@/stores/auth";
import { usePlanIncludes } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { ProxyHost } from "@/types";
import { IngressPlacementDialog } from "./IngressPlacementDialog";
import { DELIVERY_BADGE, MEMBER_STATE_BADGE, shortHash } from "./ingress-group-format";

const NO_SCOPES: string[] = [];

type MemberRow = NonNullable<NonNullable<ProxyHost["ingressGroup"]>["members"]>[number];

/** Node labels from the navigation snapshot (no node permission needed beyond seeing the route). */
export function useNodeLabel(): (nodeId: string) => string {
  const nodes = useUIBootstrapStore((state) => state.snapshot?.navigation.nodes.data);
  return (nodeId: string) => {
    const node = nodes?.find((candidate) => candidate.id === nodeId);
    return node ? node.displayName || node.hostname : nodeId.slice(0, 8);
  };
}

/**
 * Where a route is served: its ingress group with each member's delivery (config and certificate version it
 * applied), and the action that moves it between one node and a group.
 */
export function RouteIngressPlacementPanel({
  host,
  onChanged,
}: {
  host: ProxyHost;
  onChanged: () => void;
}) {
  const scopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const hasScope = useAuthStore((state) => state.hasScope);
  const canEdit = hasScope(`proxy:edit:${host.id}`);
  // The group page needs the group permission; without it the name is shown without a link.
  const canViewGroups = hasScopeBase(scopes, "ingress:groups:view");
  const label = useNodeLabel();
  const [moving, setMoving] = useState(false);
  const group = host.ingressGroup ?? null;
  // Moving onto a group needs multi-node availability; leaving one never does.
  const groupsInPlan = usePlanIncludes("multi-node-availability");

  const columns: SimpleTableColumn<MemberRow>[] = [
    {
      id: "member",
      header: "Member",
      render: (member) => <span className="text-sm">{label(member.nodeId)}</span>,
    },
    {
      id: "state",
      header: "State",
      render: (member) => (
        <Badge variant={MEMBER_STATE_BADGE[member.state].variant}>
          {MEMBER_STATE_BADGE[member.state].label}
        </Badge>
      ),
    },
    {
      id: "delivery",
      header: "Delivery",
      render: (member) => {
        const delivery = host.ingressDelivery?.find(
          (candidate) => candidate.nodeId === member.nodeId
        );
        const badge = DELIVERY_BADGE[delivery?.status ?? "pending"];
        return (
          <div className="space-y-1" title={delivery?.lastError ?? undefined}>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <p className="font-mono text-xs text-muted-foreground">
              config {shortHash(delivery?.appliedConfigHash ?? null)}
              {delivery?.appliedCertificateVersion
                ? ` · cert ${delivery.appliedCertificateVersion}`
                : ""}
            </p>
            {delivery?.lastError && (
              <p className="line-clamp-2 text-xs text-destructive">{delivery.lastError}</p>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PanelShell
        title={group ? "Ingress Group" : "Ingress"}
        icon={<Network className="h-4 w-4" />}
        description={
          group
            ? "Served by every member; each member has its own config and certificates."
            : "Served by one node. An ingress group serves it from several nodes, normally one per site."
        }
        actions={
          canEdit ? (
            group || groupsInPlan ? (
              <Button variant="outline" onClick={() => setMoving(true)}>
                {group ? "Serve From One Node" : "Serve From a Group"}
              </Button>
            ) : null
          ) : null
        }
      >
        {group ? (
          <div>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              {canViewGroups ? (
                <Link
                  to={ingressGroupRoute(group.id)}
                  className="text-sm font-medium hover:underline"
                >
                  {group.name}
                </Link>
              ) : (
                <span className="text-sm font-medium">{group.name}</span>
              )}
              <span className="text-xs text-muted-foreground">DNS failover: none</span>
            </div>
            <SimpleTable
              columns={columns}
              rows={group.members}
              getRowKey={(member) => member.nodeId}
            />
          </div>
        ) : null}
      </PanelShell>
      <IngressPlacementDialog
        open={moving}
        onOpenChange={setMoving}
        kind="route"
        resourceId={host.id}
        folderId={(host as { folderId?: string | null }).folderId ?? null}
        currentNodeId={host.nodeId ?? null}
        currentGroup={
          group
            ? {
                id: group.id,
                name: group.name,
                members: group.members.map((member) => ({
                  nodeId: member.nodeId,
                  label: label(member.nodeId),
                })),
              }
            : null
        }
        onChanged={onChanged}
      />
    </>
  );
}
