import {
  CircleCheck,
  Download,
  GitBranch,
  ListTodo,
  type LucideIcon,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Truck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { confirmDockerMigrationResolve } from "@/components/docker/confirm-docker-migration-resolve";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { dockerMigrationError } from "@/lib/docker-migration-status";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import type { DockerMigration, DockerTask, Node } from "@/types";
import { isNodeIncompatible } from "@/types";

const STATUS_BADGE: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  pending: "secondary",
  running: "default",
  succeeded: "success",
  failed: "destructive",
};

const TASK_TYPE_ICONS: Record<string, LucideIcon> = {
  deployment_deploy: GitBranch,
  kill: XCircle,
  pull: Download,
  recreate: RotateCcw,
  restart: RefreshCw,
  stop: Square,
  update: RefreshCw,
  webhook_update: RefreshCw,
  migration: Truck,
};

const ACTIVE_TASK_STATUSES = new Set(["pending", "running"]);

type DockerTaskRow = DockerTask & { migration?: DockerMigration };

function migrationTaskStatus(status: DockerMigration["status"]): DockerTask["status"] {
  if (status === "pending") return "pending";
  if (["running", "waiting", "cancelling", "cleanup_pending"].includes(status)) return "running";
  if (status === "completed") return "succeeded";
  return "failed";
}

function migrationToTask(migration: DockerMigration): DockerTaskRow {
  return {
    id: `migration:${migration.id}`,
    nodeId: migration.sourceNodeId,
    containerName: migration.resourceName,
    type: "migration",
    status: migrationTaskStatus(migration.status),
    progress:
      typeof migration.progress.message === "string"
        ? migration.progress.message
        : migration.phase.replaceAll("_", " "),
    error: dockerMigrationError(migration) ?? undefined,
    createdAt: migration.createdAt,
    completedAt: migration.completedAt ?? undefined,
    migration,
  };
}

function TaskTypeLabel({ type }: { type: string }) {
  const Icon = TASK_TYPE_ICONS[type] ?? ListTodo;
  return (
    <span className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap font-medium">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </span>
      <span className="truncate">{type}</span>
    </span>
  );
}

function formatDuration(start: string, end?: string): string {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, e - s);
  if (diff < 1000) return "<1s";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600_000)
    return `${Math.floor(diff / 60_000)}m ${Math.floor((diff % 60_000) / 1000)}s`;
  return `${Math.floor(diff / 3600_000)}h ${Math.floor((diff % 3600_000) / 60_000)}m`;
}

export function DockerTasks({ embedded }: { embedded?: boolean } = {}) {
  const { tasks, fetchTasks, selectedNodeId } = useDockerStore();
  const hasScope = useAuthStore((s) => s.hasScope);
  const canManageTask = (task: DockerTaskRow) =>
    hasScope("docker:tasks:manage") ||
    hasScope(`docker:tasks:manage:${task.nodeId}`) ||
    (!!task.migration?.targetNodeId &&
      hasScope(`docker:tasks:manage:${task.migration.targetNodeId}`));

  const [dockerNodes, setDockerNodes] = useState<Node[]>([]);
  const [migrations, setMigrations] = useState<DockerMigration[]>([]);
  // Tasks and migrations arrive together on the first load; cached tasks alone would miss the migration rows.
  const [isLoading, setIsLoading] = useState(true);
  useContentLoading(isLoading);
  const [search, setSearch] = useState("");
  const [filterNode, setFilterNode] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [forceCancellingTaskId, setForceCancellingTaskId] = useState<string | null>(null);
  const {
    open: taskDetailsOpen,
    value: selectedTask,
    setValue: setSelectedTask,
    onOpenChange: onTaskDetailsOpenChange,
  } = useDeferredDialogState<DockerTaskRow>();

  const loadTasks = useCallback(async () => {
    try {
      const [, nextMigrations] = await Promise.all([
        fetchTasks(),
        api.listDockerMigrations(selectedNodeId ? { nodeId: selectedNodeId } : undefined),
      ]);
      setMigrations(nextMigrations);
    } finally {
      setIsLoading(false);
    }
  }, [fetchTasks, selectedNodeId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    loadTasks();
    api
      .listNodes({ type: "docker", limit: 100 })
      .then((r) =>
        setDockerNodes(r.data.filter((n) => n.status === "online" && !isNodeIncompatible(n)))
      )
      .catch(() => {});
  }, []);

  // Auto-refresh every 5s
  useEffect(() => {
    const interval = setInterval(() => loadTasks(), 5_000);
    return () => clearInterval(interval);
  }, [loadTasks]);

  useRealtime("docker.task.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (selectedNodeId && ev?.nodeId && ev.nodeId !== selectedNodeId) return;
    loadTasks();
  });

  useRealtime("docker.migration.changed", () => {
    loadTasks();
  });

  const taskRows = useMemo<DockerTaskRow[]>(
    () => [...tasks, ...migrations.map(migrationToTask)],
    [migrations, tasks]
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, Pick<Node, "appearanceColor"> & { name: string }>();
    for (const n of dockerNodes) {
      map.set(n.id, { name: n.displayName || n.hostname, appearanceColor: n.appearanceColor });
    }
    return map;
  }, [dockerNodes]);

  const taskTypes = useMemo(() => {
    const types = new Set(taskRows.map((t) => t.type));
    return Array.from(types).sort();
  }, [taskRows]);

  const filteredTasks = useMemo(() => {
    let result = taskRows;
    if (filterNode !== "all") {
      result = result.filter(
        (t) => t.nodeId === filterNode || t.migration?.targetNodeId === filterNode
      );
    }
    if (filterType !== "all") {
      result = result.filter((t) => t.type === filterType);
    }
    if (filterStatus !== "all") {
      result = result.filter((t) => t.status === filterStatus);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.type.toLowerCase().includes(q) ||
          (t.containerName ?? "").toLowerCase().includes(q) ||
          (t.error ?? "").toLowerCase().includes(q)
      );
    }
    // Sort by createdAt descending
    return [...result].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [taskRows, filterNode, filterType, filterStatus, search]);

  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset visible count when filters change
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filterNode, filterType, filterStatus, search]);

  const visibleTasks = filteredTasks.slice(0, visibleCount);
  const hasMore = visibleCount < filteredTasks.length;

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore) {
          setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, filteredTasks.length));
        }
      },
      { root: scrollRef.current, threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, filteredTasks.length]);

  const taskColumns: DataTableColumn<DockerTaskRow>[] = useMemo(
    () => [
      {
        key: "type",
        header: "Type",
        width: "minmax(220px, 1.3fr)",
        truncate: true,
        render: (t) => <TaskTypeLabel type={t.type} />,
      },
      {
        key: "container",
        header: "Container",
        width: "minmax(180px, 1fr)",
        truncate: true,
        render: (t) => (
          <Badge variant="secondary" className="max-w-full font-mono">
            {t.containerName || t.containerId?.slice(0, 12) || "-"}
          </Badge>
        ),
      },
      {
        key: "node",
        header: "Node",
        width: "160px",
        truncate: true,
        render: (t) => {
          const nodeInfo = nodeMap.get(t.nodeId);
          return (
            <Badge variant="secondary" className={nodeBadgeClassName(nodeInfo?.appearanceColor)}>
              {nodeInfo?.name ?? t.nodeId.slice(0, 8)}
              {t.migration
                ? ` → ${
                    nodeMap.get(t.migration.targetNodeId)?.name ??
                    t.migration.targetNodeId.slice(0, 8)
                  }`
                : ""}
            </Badge>
          );
        },
      },
      {
        key: "status",
        header: "Status",
        width: "130px",
        render: (t) => (
          <Badge
            variant={
              t.migration?.status === "cleanup_pending"
                ? "warning"
                : (STATUS_BADGE[t.status] ?? "secondary")
            }
            className={t.status === "running" ? "animate-pulse" : ""}
          >
            {t.migration?.status.replaceAll("_", " ") ?? t.status}
          </Badge>
        ),
      },
      {
        key: "started",
        header: "Started",
        width: "110px",
        align: "right",
        render: (t) => (
          <RelativeTime value={t.createdAt} className="text-muted-foreground whitespace-nowrap" />
        ),
      },
      {
        key: "duration",
        header: "Duration",
        width: "100px",
        align: "right",
        render: (t) => (
          <span className="text-muted-foreground whitespace-nowrap">
            {formatDuration(t.createdAt, t.completedAt)}
          </span>
        ),
      },
    ],
    [nodeMap]
  );

  const hasActiveFilters =
    search !== "" || filterNode !== "all" || filterType !== "all" || filterStatus !== "all";

  const handleForceCancelTask = async (task: DockerTaskRow) => {
    setForceCancellingTaskId(task.id);
    try {
      const updatedTask = await api.forceCancelDockerTask(task.id);
      setSelectedTask(updatedTask);
      await fetchTasks();
      toast.success("Task force-cancelled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to force-cancel task");
    } finally {
      setForceCancellingTaskId(null);
    }
  };

  const handleCancelMigration = async (task: DockerTaskRow) => {
    if (!task.migration) return;
    setForceCancellingTaskId(task.id);
    try {
      setSelectedTask(migrationToTask(await api.cancelDockerMigration(task.migration.id)));
      await loadTasks();
      toast.success("Migration cancellation requested");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to cancel migration");
    } finally {
      setForceCancellingTaskId(null);
    }
  };

  const handleResolveMigration = async (task: DockerTaskRow) => {
    if (!task.migration) return;
    const side = await confirmDockerMigrationResolve(task.migration);
    if (!side) return;
    setForceCancellingTaskId(task.id);
    try {
      setSelectedTask(migrationToTask(await api.resolveDockerMigration(task.migration.id, side)));
      await loadTasks();
      toast.success("Migration resolved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resolve migration");
    } finally {
      setForceCancellingTaskId(null);
    }
  };

  const handleRetryCleanup = async (task: DockerTaskRow) => {
    if (!task.migration) return;
    setForceCancellingTaskId(task.id);
    try {
      setSelectedTask(migrationToTask(await api.retryDockerMigrationCleanup(task.migration.id)));
      await loadTasks();
      toast.success("Migration cleanup resumed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to retry cleanup");
    } finally {
      setForceCancellingTaskId(null);
    }
  };

  const handleClearCompleted = async () => {
    // Filter out completed/failed tasks visually
    setFilterStatus("running");
    toast.success("Showing active tasks only");
  };

  const content = (
    <>
      {/* Header — hidden in embedded mode */}
      {!embedded && (
        <PageHeader
          title="Docker Tasks"
          description="View pending and completed Docker operations (auto-refreshes every 5s)"
          badges={
            <Badge variant="secondary" size="inline">
              {taskRows.length}
            </Badge>
          }
          actions={
            <ResponsiveHeaderActions
              actions={[
                {
                  label: "Refresh",
                  icon: <RefreshCw className="h-4 w-4" />,
                  onClick: () => void loadTasks(),
                  disabled: isLoading,
                },
                ...(taskRows.some((task) => task.status === "succeeded" || task.status === "failed")
                  ? [
                      {
                        label: "Hide Completed",
                        icon: <Trash2 className="h-4 w-4" />,
                        onClick: () => void handleClearCompleted(),
                      },
                    ]
                  : []),
              ]}
            >
              <RefreshButton onClick={loadTasks} disabled={isLoading} />
              {taskRows.some((t) => t.status === "succeeded" || t.status === "failed") && (
                <Button variant="outline" onClick={handleClearCompleted}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Hide Completed
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />
      )}

      {/* Filters */}
      <SearchFilterBar
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={() => {}}
        placeholder="Search tasks..."
        hasActiveFilters={hasActiveFilters}
        onReset={() => {
          setSearch("");
          setFilterNode("all");
          setFilterType("all");
          setFilterStatus("all");
        }}
        filters={
          <div className="flex items-center gap-2">
            <Select value={filterNode} onValueChange={setFilterNode}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Node" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All nodes</SelectItem>
                {dockerNodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.displayName || n.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {taskTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="succeeded">Succeeded</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      {filteredTasks.length > 0 ? (
        <DataTable<DockerTaskRow>
          columns={taskColumns}
          data={visibleTasks}
          keyFn={(t) => t.id}
          onRowClick={setSelectedTask}
          scrollRef={scrollRef}
          horizontalScroll
          minWidth="900px"
          footer={
            hasMore ? (
              <div
                ref={sentinelRef}
                className="flex items-center justify-center py-3 text-xs text-muted-foreground"
              >
                Loading more...
              </div>
            ) : undefined
          }
        />
      ) : isLoading ? null : (
        <EmptyState
          message="No tasks found."
          hasActiveFilters={hasActiveFilters}
          onReset={() => {
            setSearch("");
            setFilterNode("all");
            setFilterType("all");
            setFilterStatus("all");
          }}
        />
      )}

      {/* Task Detail Dialog */}
      <Dialog open={taskDetailsOpen} onOpenChange={onTaskDetailsOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Task Details</DialogTitle>
          </DialogHeader>
          {selectedTask && (
            <div className="min-w-0">
              <div className="border border-border bg-card divide-y divide-border overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 min-w-0">
                  <span className="text-sm text-muted-foreground shrink-0">Type</span>
                  <span className="text-sm font-medium truncate ml-4 min-w-0">
                    {selectedTask.type}
                  </span>
                </div>
                {selectedTask.migration && (
                  <div className="flex items-center justify-between px-4 py-3 min-w-0">
                    <span className="text-sm text-muted-foreground shrink-0">Target</span>
                    <Badge
                      variant="secondary"
                      className={nodeBadgeClassName(
                        nodeMap.get(selectedTask.migration.targetNodeId)?.appearanceColor,
                        "ml-4"
                      )}
                    >
                      {nodeMap.get(selectedTask.migration.targetNodeId)?.name ??
                        selectedTask.migration.targetNodeId.slice(0, 8)}
                    </Badge>
                  </div>
                )}
                <div className="flex items-center justify-between px-4 py-3 min-w-0">
                  <span className="text-sm text-muted-foreground shrink-0">Container</span>
                  <Badge variant="secondary" className="ml-4 max-w-full font-mono">
                    {selectedTask.containerName || selectedTask.containerId?.slice(0, 12) || "-"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between px-4 py-3 min-w-0">
                  <span className="text-sm text-muted-foreground shrink-0">Node</span>
                  <Badge
                    variant="secondary"
                    className={nodeBadgeClassName(
                      nodeMap.get(selectedTask.nodeId)?.appearanceColor,
                      "ml-4"
                    )}
                  >
                    {nodeMap.get(selectedTask.nodeId)?.name ?? selectedTask.nodeId.slice(0, 8)}
                  </Badge>
                </div>
                <div className="flex items-center justify-between px-4 py-3 min-w-0">
                  <span className="text-sm text-muted-foreground shrink-0">Status</span>
                  <Badge
                    variant={STATUS_BADGE[selectedTask.status] ?? "secondary"}
                    className={selectedTask.status === "running" ? "animate-pulse" : ""}
                  >
                    {selectedTask.migration?.status.replaceAll("_", " ") ?? selectedTask.status}
                  </Badge>
                </div>
                {selectedTask.progress && (
                  <div className="flex items-center justify-between px-4 py-3 min-w-0">
                    <span className="text-sm text-muted-foreground shrink-0">Progress</span>
                    <span className="text-sm truncate ml-4 min-w-0">{selectedTask.progress}</span>
                  </div>
                )}
                <div className="flex items-center justify-between px-4 py-3 min-w-0">
                  <span className="text-sm text-muted-foreground shrink-0">Started</span>
                  <RelativeTime
                    value={selectedTask.createdAt}
                    className="text-sm truncate ml-4 min-w-0"
                  />
                </div>
                {selectedTask.completedAt && (
                  <div className="flex items-center justify-between px-4 py-3 min-w-0">
                    <span className="text-sm text-muted-foreground shrink-0">Finished</span>
                    <RelativeTime
                      value={selectedTask.completedAt}
                      className="text-sm truncate ml-4 min-w-0"
                    />
                  </div>
                )}
                <div className="flex items-center justify-between px-4 py-3 min-w-0">
                  <span className="text-sm text-muted-foreground shrink-0">Duration</span>
                  <span className="text-sm truncate ml-4 min-w-0">
                    {formatDuration(selectedTask.createdAt, selectedTask.completedAt)}
                  </span>
                </div>
              </div>
              {selectedTask.error && (
                <Notice tone="destructive" className="mt-3" title="Task error">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {selectedTask.error}
                  </pre>
                </Notice>
              )}
            </div>
          )}
          {selectedTask?.migration?.status === "cleanup_pending" && (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleRetryCleanup(selectedTask)}
                pending={forceCancellingTaskId === selectedTask.id}
              >
                {forceCancellingTaskId !== selectedTask.id && <RotateCcw className="h-4 w-4" />}
                Retry cleanup
              </Button>
            </DialogFooter>
          )}
          {selectedTask?.migration?.status === "needs_attention" && canManageTask(selectedTask) && (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleResolveMigration(selectedTask)}
                pending={forceCancellingTaskId === selectedTask.id}
              >
                {forceCancellingTaskId !== selectedTask.id && <CircleCheck className="h-4 w-4" />}
                Resolve
              </Button>
            </DialogFooter>
          )}
          {selectedTask?.migration &&
            canManageTask(selectedTask) &&
            ["pending", "running", "waiting", "cancelling"].includes(
              selectedTask.migration.status
            ) &&
            !selectedTask.migration.cutoverAt && (
              <DialogFooter>
                <Button
                  variant="destructive"
                  onClick={() => handleCancelMigration(selectedTask)}
                  pending={forceCancellingTaskId === selectedTask.id}
                >
                  {forceCancellingTaskId !== selectedTask.id && <XCircle className="h-4 w-4" />}
                  Cancel and roll back
                </Button>
              </DialogFooter>
            )}
          {selectedTask &&
            !selectedTask.migration &&
            canManageTask(selectedTask) &&
            ACTIVE_TASK_STATUSES.has(selectedTask.status) && (
              <DialogFooter>
                <Button
                  variant="destructive"
                  onClick={() => handleForceCancelTask(selectedTask)}
                  pending={forceCancellingTaskId === selectedTask.id}
                >
                  {forceCancellingTaskId !== selectedTask.id && <XCircle className="h-4 w-4" />}
                  Force Cancel
                </Button>
              </DialogFooter>
            )}
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return <div className="flex flex-col flex-1 min-h-0 space-y-3">{content}</div>;

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-3">{content}</div>
    </PageTransition>
  );
}
