import { ArrowUpCircle, MoreVertical, RefreshCw, Trash2 } from "lucide-react";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AvailabilityMember, AvailabilityView } from "@/types";
import {
  eligibilityText,
  formatLag,
  memberHealthVariant,
  memberName,
  ROLE_LABELS,
  roleVariant,
  syncStateLabel,
} from "./availability-labels";

export interface MemberActions {
  onMakePrimary: (member: AvailabilityMember) => void;
  onRebuild: (member: AvailabilityMember) => void;
  onRemove: (member: AvailabilityMember) => void;
}

function HealthBadge({ member }: { member: AvailabilityMember }) {
  const badge = (
    <Badge
      size="inline"
      variant={memberHealthVariant(member)}
      tabIndex={member.lastError ? 0 : undefined}
    >
      {member.status === "error" ? "Error" : eligibilityText(member)}
    </Badge>
  );
  if (!member.lastError) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm break-words">
        {member.lastError}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Servers of an availability set: role, whether a copy can take over (and why not), how far it
 * is behind, how it replicates and when it last reported. Row actions sit in a "…" menu.
 */
export function MembersTable({
  view,
  canManage,
  busy,
  actions,
}: {
  view: AvailabilityView;
  canManage: boolean;
  /** An operation is running: member actions wait for it. */
  busy: boolean;
  actions: MemberActions;
}) {
  const rows = view.members.filter((member) => member.desiredState === "member");
  const removing = view.members.filter((member) => member.desiredState === "removing");
  const columns: SimpleTableColumn<AvailabilityMember>[] = [
    {
      id: "server",
      header: "Server",
      render: (member) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{memberName(member)}</span>
          <Badge size="inline" variant={roleVariant(member.role)}>
            {member.desiredState === "removing" ? "Removing" : ROLE_LABELS[member.role]}
          </Badge>
        </div>
      ),
    },
    {
      id: "health",
      header: "Health",
      render: (member) => <HealthBadge member={member} />,
    },
    { id: "lag", header: "Behind", render: (member) => formatLag(member) },
    { id: "replication", header: "Replication", render: (member) => syncStateLabel(member) },
    {
      id: "report",
      header: "Last report",
      render: (member) => (
        <RelativeTime value={member.lastReportedAt} className="text-muted-foreground" />
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      render: (member) => {
        const primary = member.id === view.primaryMemberId || member.role === "primary";
        if (!canManage || member.desiredState === "removing") return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${memberName(member)}`}
                title="Actions"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={primary || busy}
                onClick={() => actions.onMakePrimary(member)}
              >
                <ArrowUpCircle />
                Make this copy primary
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={primary || busy}
                onClick={() => actions.onRebuild(member)}
              >
                <RefreshCw />
                Rebuild copy
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                disabled={primary || busy}
                onClick={() => actions.onRemove(member)}
              >
                <Trash2 />
                Remove server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];
  return (
    <TooltipProvider delayDuration={200}>
      <SimpleTable
        columns={columns}
        rows={[...rows, ...removing]}
        getRowKey={(member) => member.id}
        emptyMessage="No servers yet."
      />
    </TooltipProvider>
  );
}
