import { ArrowDown, ArrowUp, ArrowUpCircle, MoreVertical, RefreshCw, Trash2 } from "lucide-react";
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
  activeMembers,
  eligibilityText,
  formatLag,
  memberHealthVariant,
  memberName,
  memberRoleLabel,
  roleVariant,
  syncStateLabel,
} from "./availability-labels";

export interface MemberActions {
  onMakePrimary: (member: AvailabilityMember) => void;
  onRebuild: (member: AvailabilityMember) => void;
  onRemove: (member: AvailabilityMember) => void;
  /** Moves a server one place in the failover order; without it the order shows without move buttons. */
  onMove?: (member: AvailabilityMember, delta: -1 | 1) => void;
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
 * Servers of an availability set in failover order: role, whether a copy can take over (and why
 * not), how far it is behind, how it replicates and when it last reported. Up and down move a
 * server in the order; the other row actions sit in a "…" menu.
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
  const rows = activeMembers(view);
  const removing = view.members.filter((member) => member.desiredState === "removing");
  const columns: SimpleTableColumn<AvailabilityMember>[] = [
    {
      id: "order",
      header: "Order",
      render: (member) => {
        const index = rows.indexOf(member);
        return index === -1 ? "—" : index + 1;
      },
    },
    {
      id: "server",
      header: "Server",
      render: (member) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{memberName(member)}</span>
          <Badge size="inline" variant={roleVariant(member.role)}>
            {memberRoleLabel(member)}
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
        // Nobody holds the primary role: any server may be made primary (with the loss confirmation).
        const noHolder = view.mode === "automatic" && !!view.lease && !view.lease.holderNodeId;
        if (!canManage || member.desiredState === "removing") return null;
        const index = rows.indexOf(member);
        const name = memberName(member);
        return (
          <div className="flex justify-end gap-1">
            {actions.onMove ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${name} up in the failover order`}
                  disabled={busy || index <= 0}
                  onClick={() => actions.onMove?.(member, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${name} down in the failover order`}
                  disabled={busy || index === -1 || index === rows.length - 1}
                  onClick={() => actions.onMove?.(member, 1)}
                >
                  <ArrowDown />
                </Button>
              </>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Actions for ${name}`}
                  title="Actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={(primary && !noHolder) || busy}
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
          </div>
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
