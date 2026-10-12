import { Link } from "react-router-dom";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { getAuditActionLabel } from "@/pages/audit-log/audit-action-labels";
import { getAuditEntryUserLabel, getAuditResourceDisplay } from "@/pages/audit-log/audit-format";
import type { AuditLogEntry } from "@/types";

interface RecentActivityCardProps {
  activity: AuditLogEntry[];
  hasScope: (scope: string) => boolean;
}

export function RecentActivityCard({ activity, hasScope }: RecentActivityCardProps) {
  if (!hasScope("admin:audit")) return null;

  const getInitials = (entry: AuditLogEntry) =>
    getAuditEntryUserLabel(entry)
      .split(/[\s@._-]+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();

  const activityColumns: SimpleTableColumn<AuditLogEntry>[] = [
    {
      id: "user",
      header: "User",
      render: (entry) => {
        const label = getAuditEntryUserLabel(entry);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar className="h-7 w-7">
              {entry.userId && <AvatarImage src={entry.userAvatarUrl ?? undefined} />}
              <AvatarFallback className="text-xs">
                {entry.userId ? getInitials(entry) : "SY"}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">{label}</span>
          </span>
        );
      },
    },
    {
      id: "action",
      header: "Action",
      render: (entry) => (
        <Badge variant="secondary" title={entry.action}>
          {getAuditActionLabel(entry.action)}
        </Badge>
      ),
    },
    {
      id: "resource",
      header: "Resource",
      cellClassName: "max-w-0 w-full text-muted-foreground",
      render: (entry) => {
        const resource = getAuditResourceDisplay(entry);
        return (
          <span className="block truncate" title={resource.title}>
            {resource.label}
          </span>
        );
      },
    },
    {
      id: "time",
      header: "Time",
      align: "right",
      cellClassName: "whitespace-nowrap text-muted-foreground",
      render: (entry) => <RelativeTime value={entry.createdAt} />,
    },
  ];

  return (
    <PanelShell
      title="Recent Activity"
      actions={
        <Link
          to="/administration/audit"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          View all
        </Link>
      }
    >
      {activity.length > 0 ? (
        <SimpleTable
          columns={activityColumns}
          rows={activity}
          getRowKey={(entry) => entry.id}
          tableClassName="min-w-[640px]"
        />
      ) : (
        <EmptyState message="No recent activity" embedded />
      )}
    </PanelShell>
  );
}
