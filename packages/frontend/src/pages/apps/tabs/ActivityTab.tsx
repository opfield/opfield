// Activity: the audit log of the app and its members (canvas frame app-activity).
import { History, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { toastApiError } from "@/lib/api-error-toast";
import { getAuditActionLabel } from "@/pages/audit-log/audit-action-labels";
import { getAuditEntryUserLabel, getAuditResourceDisplay } from "@/pages/audit-log/audit-format";
import { api } from "@/services/api";
import type { AppDetail, AuditLogEntry } from "@/types";

const PAGE_SIZE = 50;

function initials(label: string): string {
  return label
    .split(/[\s@._-]+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** The audit log's columns (src/pages/AuditLog.tsx), filtered to the app's members. */
const columns: DataTableColumn<AuditLogEntry>[] = [
  {
    key: "user",
    header: "User",
    width: "minmax(180px, 1fr)",
    truncate: true,
    render: (entry) => {
      const label = getAuditEntryUserLabel(entry);
      const system = label === "System";
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar className="h-7 w-7">
            {!system && <AvatarImage src={entry.userAvatarUrl ?? undefined} />}
            <AvatarFallback className="text-xs">
              {system ? <Settings className="h-3.5 w-3.5" /> : initials(label)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{label}</span>
        </span>
      );
    },
  },
  {
    key: "action",
    header: "Action",
    width: "minmax(180px, 1fr)",
    render: (entry) => (
      <span title={entry.action} className="text-muted-foreground">
        {getAuditActionLabel(entry.action)}
      </span>
    ),
  },
  {
    key: "resource",
    header: "Resource",
    width: "minmax(260px, 1.6fr)",
    truncate: true,
    render: (entry) => {
      const resource = getAuditResourceDisplay(entry);
      return (
        <span className="text-muted-foreground" title={resource.title}>
          {resource.label}
        </span>
      );
    },
  },
  {
    key: "ip",
    header: "IP Address",
    width: "minmax(140px, 0.7fr)",
    truncate: true,
    render: (entry) => (
      <span className="font-mono text-xs text-muted-foreground">{entry.ipAddress || "—"}</span>
    ),
  },
  {
    key: "time",
    header: "Time",
    width: "minmax(130px, 0.65fr)",
    align: "right",
    render: (entry) => <RelativeTime value={entry.createdAt} className="text-muted-foreground" />,
  },
];

export function ActivityTab({ app, version }: { app: AppDetail; version: number }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (nextPage: number) => {
      const result = await api.getAppActivity(app.id, { page: nextPage, limit: PAGE_SIZE });
      setTotal(result.total);
      setPage(nextPage);
      setEntries((current) => (nextPage === 1 ? result.data : [...current, ...result.data]));
    },
    [app.id]
  );

  useEffect(() => {
    void version;
    let cancelled = false;
    load(1)
      .catch((error) => {
        if (!cancelled) toastApiError(error, "Failed to load activity");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, version]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      await load(page + 1);
    } catch (error) {
      toastApiError(error, "Failed to load activity");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="pb-6">
      <PanelShell
        title="Activity"
        icon={<History className="h-4 w-4" />}
        description="Audit log of the app and its resources"
        bodyClassName="flex flex-col p-0"
      >
        <DataTable
          columns={columns}
          data={entries}
          keyFn={(entry) => entry.id}
          loading={loading && entries.length === 0}
          horizontalScroll
          minWidth="900px"
          embedded
          className="w-full"
          emptyMessage="No activity yet. History starts when a resource joins the app."
          footer={
            entries.length < total ? (
              <div className="flex justify-center border-t border-border px-4 py-3">
                <Button
                  variant="link"
                  className="h-auto p-0"
                  pending={loadingMore}
                  onClick={() => void loadMore()}
                >
                  Show more
                </Button>
              </div>
            ) : undefined
          }
        />
      </PanelShell>
    </div>
  );
}
