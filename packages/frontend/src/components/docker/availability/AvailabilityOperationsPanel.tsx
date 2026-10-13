import { Activity, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DockerAvailabilityOperation } from "@/types";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function variant(status: string) {
  if (["completed", "healthy", "serving", "ready"].includes(status)) return "success" as const;
  if (["failed", "unavailable", "unhealthy"].includes(status)) return "destructive" as const;
  if (["waiting", "cleanup_pending", "running", "pending"].includes(status))
    return "warning" as const;
  return "secondary" as const;
}

function operationStatus(operation: DockerAvailabilityOperation, desiredGeneration: number) {
  const retryable = ["failed", "waiting", "cleanup_pending"].includes(operation.status);
  return retryable && operation.targetGeneration < desiredGeneration
    ? "superseded"
    : operation.status;
}

function StatusBadge({
  operation,
  desiredGeneration,
}: {
  operation: DockerAvailabilityOperation;
  desiredGeneration: number;
}) {
  const status = operationStatus(operation, desiredGeneration);
  const error = status === "superseded" || status === "completed" ? null : operation.errorMessage;
  const badge = (
    <Badge
      size="inline"
      variant={variant(status)}
      tabIndex={error ? 0 : undefined}
      aria-label={error ? `${label(status)}: ${error}` : undefined}
    >
      {label(status)}
    </Badge>
  );
  if (!error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm break-words">
        {error}
      </TooltipContent>
    </Tooltip>
  );
}

export function AvailabilityOperationsPanel({
  policyId,
  desiredGeneration,
}: {
  policyId: string;
  desiredGeneration: number;
}) {
  const canManage = useAuthStore((state) => state.hasScope("docker:availability:manage"));
  const [recent, setRecent] = useState<DockerAvailabilityOperation[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DockerAvailabilityOperation[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const requestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadRecent = useCallback(async () => {
    setRecentLoading(true);
    try {
      const result = await api.listDockerAvailabilityOperationsPage(policyId, {
        page: 1,
        limit: 5,
      });
      setRecent(result.data.slice(0, 5));
    } catch (error) {
      toastApiError(error, "Failed to load Availability operations");
    } finally {
      setRecentLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);
  useRealtime("docker.availability.operation.changed", (payload) => {
    const event = payload as { policyId?: string };
    if (event.policyId && event.policyId !== policyId) return;
    void loadRecent();
  });

  const loadPage = useCallback(
    async (page: number, replace: boolean) => {
      if (!replace && loadingMore.current) return;
      const currentRequest = ++requestId.current;
      if (!replace) loadingMore.current = true;
      setLoading(true);
      try {
        const result = await api.listDockerAvailabilityOperationsPage(policyId, {
          page,
          limit: 50,
        });
        if (currentRequest !== requestId.current) return;
        setRows((current) => (replace ? result.data : [...current, ...result.data]));
        setNextPage(result.nextPage);
      } catch (error) {
        if (currentRequest === requestId.current) {
          toastApiError(error, "Failed to load Availability operations");
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [policyId]
  );

  useEffect(() => {
    if (!open) return;
    void loadPage(1, true);
  }, [loadPage, open]);

  useEffect(() => {
    const root = tableScrollRef.current;
    const sentinel = sentinelRef.current;
    if (!open || !root || !sentinel || !nextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore.current) void loadPage(nextPage, false);
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadPage, nextPage, open]);

  const retry = useCallback(
    async (operation: DockerAvailabilityOperation) => {
      setRetryingId(operation.id);
      try {
        await api.retryDockerAvailabilityOperation(policyId, operation.id);
        toast.success("Availability operation queued again");
        await loadRecent();
        if (open) await loadPage(1, true);
      } catch (error) {
        toastApiError(error, "Failed to retry Availability operation");
      } finally {
        setRetryingId(null);
      }
    },
    [loadPage, loadRecent, open, policyId]
  );

  const openAll = () => {
    requestId.current += 1;
    loadingMore.current = false;
    setRows([]);
    setNextPage(null);
    setLoading(true);
    setOpen(true);
  };

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      requestId.current += 1;
      loadingMore.current = false;
    }
  };

  const previewColumns = useMemo<SimpleTableColumn<DockerAvailabilityOperation>[]>(
    () => [
      {
        id: "operation",
        header: "Operation",
        render: (operation) => (
          <span className="inline-flex items-center gap-2">
            <span>{label(operation.type)}</span>
            <StatusBadge operation={operation} desiredGeneration={desiredGeneration} />
          </span>
        ),
      },
      { id: "phase", header: "Phase", render: (operation) => label(operation.phase) },
      {
        id: "generation",
        header: "Generation",
        align: "right",
        render: (operation) => operation.targetGeneration,
      },
      {
        id: "time",
        header: "Time",
        align: "right",
        cellClassName: "text-muted-foreground",
        render: (operation) => <RelativeTime value={operation.createdAt} />,
      },
    ],
    [desiredGeneration]
  );

  const columns = useMemo<DataTableColumn<DockerAvailabilityOperation>[]>(
    () => [
      {
        key: "time",
        header: "Time",
        width: "7rem",
        render: (row) => <RelativeTime value={row.createdAt} />,
      },
      {
        key: "operation",
        header: "Operation",
        width: "13rem",
        render: (row) => (
          <span className="inline-flex items-center gap-2">
            <span>{label(row.type)}</span>
            <StatusBadge operation={row} desiredGeneration={desiredGeneration} />
          </span>
        ),
      },
      { key: "phase", header: "Phase", width: "11rem", render: (row) => label(row.phase) },
      {
        key: "generation",
        header: "Generation",
        width: "6rem",
        render: (row) => row.targetGeneration,
      },
      {
        key: "message",
        header: "Details",
        // Rows have a fixed height: one line, the full text on hover.
        render: (row) =>
          row.progress.message ? (
            <span className="block truncate" title={row.progress.message}>
              {row.progress.message}
            </span>
          ) : (
            "—"
          ),
      },
      ...(canManage
        ? [
            {
              key: "action",
              header: "",
              width: "7rem",
              render: (row: DockerAvailabilityOperation) => {
                const status = operationStatus(row, desiredGeneration);
                const retryable = ["failed", "waiting", "cleanup_pending"].includes(status);
                return retryable ? (
                  <Button
                    variant="outline"
                    pending={retryingId === row.id}
                    onClick={() => void retry(row)}
                  >
                    {retryingId !== row.id && <RefreshCw />} Retry
                  </Button>
                ) : null;
              },
            },
          ]
        : []),
    ],
    [canManage, desiredGeneration, retry, retryingId]
  );

  const tableHeight = rows.length ? 49 + rows.length * 49 + 44 : undefined;

  return (
    <TooltipProvider delayDuration={200}>
      <PanelShell
        icon={<Activity className="h-4 w-4" />}
        title="Operations"
        description="Enable, scaling, failover, rollout, and cleanup history."
        actions={
          <Button variant="quiet" size="inline" className="text-sm font-normal" onClick={openAll}>
            View all
          </Button>
        }
      >
        {recent.length === 0 && !recentLoading ? (
          <EmptyState embedded message="No Availability operations" />
        ) : (
          <SimpleTable
            columns={previewColumns}
            rows={recent}
            getRowKey={(row) => row.id}
            loading={recentLoading}
            loadingMessage="Loading operations..."
            emptyMessage="No Availability operations"
            tableClassName="min-w-[640px]"
          />
        )}
      </PanelShell>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-h-[85dvh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Availability Operations</DialogTitle>
          </DialogHeader>
          <DialogDescription>Scroll the table to load older operations.</DialogDescription>
          <div
            className="max-h-[min(64dvh,40rem)]"
            style={tableHeight ? { height: tableHeight } : undefined}
          >
            <DataTable
              columns={columns}
              data={rows}
              loading={loading && rows.length === 0}
              keyFn={(row) => row.id}
              horizontalScroll
              minWidth="60rem"
              className="h-full"
              fixedRowHeight={49}
              emptyMessage="No Availability operations"
              scrollRef={tableScrollRef}
              footer={
                nextPage ? (
                  <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
                    {loading ? "Loading more…" : "Scroll to load older operations"}
                  </div>
                ) : null
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
