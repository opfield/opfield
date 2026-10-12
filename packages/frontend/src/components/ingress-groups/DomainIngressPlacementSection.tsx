import { useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePlanIncludes } from "@/stores/license-paywall";
import type { DomainWithUsage } from "@/types";
import { IngressPlacementDialog } from "./IngressPlacementDialog";
import { MEMBER_STATE_BADGE } from "./ingress-group-format";

/**
 * Where a domain (and its routes) is served: one node or an ingress group, with the addresses DNS lists for the
 * group's members, and the action that moves it between the two.
 */
export function DomainIngressPlacementSection({
  domain,
  canEdit,
  onChanged,
}: {
  domain: DomainWithUsage;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const group = domain.ingressGroup ?? null;
  // Moving onto a group needs multi-node availability; leaving one never does.
  const groupsInPlan = usePlanIncludes("multi-node-availability");
  // A single-node domain shows its node in the DNS panels; this panel only offers the move then.
  const memberLabel = (member: NonNullable<typeof group>["members"][number]) =>
    member.node ? member.node.displayName || member.node.hostname : member.nodeId.slice(0, 8);

  if (!group && (!canEdit || domain.isSystem)) return null;
  return (
    <>
      <PanelShell
        title="Ingress"
        description={
          group
            ? "Served by every member of the ingress group. Cloudflare-managed DNS lists every active member (round robin; plain records are not health-checked)."
            : "Served by one node. An ingress group serves the domain and its routes from several nodes."
        }
        actions={
          canEdit && !domain.isSystem ? (
            group || groupsInPlan ? (
              <Button variant="outline" onClick={() => setMoving(true)}>
                {group ? "Serve From One Node" : "Serve From a Group"}
              </Button>
            ) : null
          ) : null
        }
      >
        {group ? (
          <>
            <SettingsControlRow title="Ingress group">
              <span className="text-sm">{group.name}</span>
            </SettingsControlRow>
            {group.members.map((member) => (
              <SettingsControlRow
                key={member.nodeId}
                title={memberLabel(member)}
                description={member.addresses.join(", ") || "No public ingress address"}
              >
                <Badge variant={MEMBER_STATE_BADGE[member.state].variant}>
                  {MEMBER_STATE_BADGE[member.state].label}
                </Badge>
              </SettingsControlRow>
            ))}
            <SettingsControlRow title="Published addresses">
              <span className="break-all text-right text-sm">
                {group.targetIps.join(", ") || "None"}
              </span>
            </SettingsControlRow>
          </>
        ) : null}
      </PanelShell>
      <IngressPlacementDialog
        open={moving}
        onOpenChange={setMoving}
        kind="domain"
        resourceId={domain.id}
        currentNodeId={domain.nginxNodeId}
        currentGroup={
          group
            ? {
                id: group.id,
                name: group.name,
                members: group.members.map((member) => ({
                  nodeId: member.nodeId,
                  label: memberLabel(member),
                })),
              }
            : null
        }
        onChanged={onChanged}
      />
    </>
  );
}
