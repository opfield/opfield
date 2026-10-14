// The Domains section of the Network tab: the columns of its rows (same cells as the Domains list).
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { DnsStatusBadge } from "@/components/domains/DnsStatusBadge";
import { Badge } from "@/components/ui/badge";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import type { Domain, Node } from "@/types";
import { RowMenu } from "../app-shared";
import { nodeDisplayName } from "../use-node-index";
import { MemberMenuItems, type TabActions } from "./tab-shared";

export function domainColumns({
  nodesById,
  actions,
  onOpen,
}: {
  nodesById: ReadonlyMap<string, Node>;
  actions: TabActions;
  onOpen: (domain: Domain) => void;
}): ResourceListColumn<Domain>[] {
  return [
    {
      id: "domain",
      label: "Domain",
      renderCell: (domain) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{domain.domain}</p>
          {domain.description && (
            <p className="truncate text-xs text-muted-foreground" title={domain.description}>
              {domain.description}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "ingress",
      label: "Ingress",
      width: "9rem",
      renderCell: (domain) => {
        if (domain.ingressGroupId) return <Badge variant="secondary">Ingress group</Badge>;
        const node = domain.nginxNodeId ? nodesById.get(domain.nginxNodeId) : undefined;
        return (
          <Badge variant="secondary" className={nodeBadgeClassName(node?.appearanceColor)}>
            {domain.nginxNodeId ? nodeDisplayName(node, domain.nginxNodeId) : "Unassigned"}
          </Badge>
        );
      },
    },
    {
      id: "dns",
      label: "DNS",
      width: "7rem",
      renderCell: (domain) => <DnsStatusBadge status={domain.dnsStatus} />,
    },
    {
      id: "actions",
      label: "Actions",
      width: "5rem",
      align: "right",
      renderCell: (domain) => (
        <RowMenu label={`Domain actions for ${domain.domain}`}>
          <DropdownMenuItem onClick={() => onOpen(domain)}>Open</DropdownMenuItem>
          <MemberMenuItems
            member={{
              type: "domain",
              id: domain.id,
              nodeId: domain.nginxNodeId ?? null,
              name: domain.domain,
              environmentId: domain.app?.environmentId ?? "",
            }}
            actions={actions}
          />
        </RowMenu>
      ),
    },
  ];
}
