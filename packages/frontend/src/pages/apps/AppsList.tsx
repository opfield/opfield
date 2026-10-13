// Apps: the top-level list (canvas frames apps-list, apps-empty, apps-new-app).
// Same page frame and rows as Databases and Docker containers.
import { FolderPlus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppMark } from "@/components/apps/AppMark";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { appRoute } from "@/lib/app-routes";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { APPS_LIST_CACHE_KEY } from "@/services/api-apps";
import { useAuthStore } from "@/stores/auth";
import { APPS_REALTIME_CHANNEL, type AppSummary } from "@/types";
import { HEALTH_BADGE, orderedEnvironments } from "./app-shared";
import { NewAppDialog } from "./dialogs/NewAppDialog";

type AppStatus = AppSummary["health"] | "stopped" | "isolated";

/** The status the Health column shows: an incident first, then the Production health. */
function appStatus(app: AppSummary): AppStatus {
  if (app.incident === "isolated" || app.incident === "partial") return "isolated";
  if (app.incident === "stopped") return "stopped";
  return app.health;
}

function AppHealthCell({ app }: { app: AppSummary }) {
  const status = appStatus(app);
  if (status === "isolated") return <Badge variant="destructive">isolated</Badge>;
  if (status === "stopped") return <Badge variant="secondary">stopped</Badge>;
  return <Badge variant={HEALTH_BADGE[status]}>{status}</Badge>;
}

const STATUS_OPTIONS: Array<{ value: AppStatus; label: string }> = [
  { value: "healthy", label: "Healthy" },
  { value: "degraded", label: "Degraded" },
  { value: "failing", label: "Failing" },
  { value: "unknown", label: "Unknown" },
  { value: "stopped", label: "Stopped" },
  { value: "isolated", label: "Isolated" },
];

const columns: ResourceListColumn<AppSummary>[] = [
  {
    id: "name",
    label: "Name",
    renderCell: (app) => (
      <div className="flex min-w-0 items-center gap-4">
        <AppMark logoUrl={app.logoUrl} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{app.name}</p>
          {app.description && (
            <p className="truncate text-xs text-muted-foreground">{app.description}</p>
          )}
        </div>
      </div>
    ),
  },
  {
    id: "environments",
    label: "Environments",
    width: "14rem",
    align: "right",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (app) => (
      <span className="truncate">
        {orderedEnvironments(app.environments)
          .map((env) => env.name)
          .join(", ")}
      </span>
    ),
  },
  {
    id: "cpu",
    label: "CPU",
    width: "6.5rem",
    align: "right",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (app) => (app.cpuPercent === null ? "—" : `${app.cpuPercent.toFixed(1)}%`),
  },
  {
    id: "memory",
    label: "Memory",
    width: "7rem",
    align: "right",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (app) => (app.memoryBytes === null ? "—" : formatBytes(app.memoryBytes)),
  },
  {
    id: "health",
    label: "Health",
    // A fixed column: the badge never squeezes.
    width: "9rem",
    align: "right",
    renderCell: (app) => <AppHealthCell app={app} />,
  },
];

export function AppsList() {
  const navigate = useNavigate();
  const canCreate = useAuthStore((state) => state.hasScopedAccess("apps:create"));
  const canEdit = useAuthStore((state) => state.hasScopedAccess("apps:edit"));
  const canManageFolders = useCanManageSomeFolders("apps:folders:manage");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [apps, setApps] = useState<AppSummary[]>(
    () => api.getCached<AppSummary[]>(APPS_LIST_CACHE_KEY) ?? []
  );
  const [loading, setLoading] = useState(() => !api.getCached(APPS_LIST_CACHE_KEY));
  const [refreshing, setRefreshing] = useState(false);
  const initialLoading = useInitialLoading(loading);
  const [newOpen, setNewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | AppStatus>("all");
  const hasActiveFilters = search !== "" || statusFilter !== "all";
  const resetFilters = () => {
    setSearch("");
    setStatusFilter("all");
  };

  // The list is not paginated: search and filters apply to the apps already loaded.
  const visibleApps = useMemo(() => {
    const query = search.trim().toLowerCase();
    return apps.filter(
      (app) =>
        (statusFilter === "all" || appStatus(app) === statusFilter) &&
        (!query ||
          app.name.toLowerCase().includes(query) ||
          app.slug.toLowerCase().includes(query) ||
          (app.description ?? "").toLowerCase().includes(query) ||
          app.environments.some((env) => env.name.toLowerCase().includes(query)))
    );
  }, [apps, search, statusFilter]);

  const load = useCallback(async () => {
    try {
      const next = await api.listApps();
      api.setCache(APPS_LIST_CACHE_KEY, next);
      setApps(next);
    } catch (error) {
      toastApiError(error, "Failed to load apps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(APPS_REALTIME_CHANNEL, () => void load(), { onReconnect: () => void load() });

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const headerActions = [
    {
      label: "Refresh",
      icon: <RefreshCw className="h-4 w-4" />,
      onClick: () => void refresh(),
    },
    ...(canManageFolders && createFolderAction
      ? [
          {
            label: "Add Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: createFolderAction,
          },
        ]
      : []),
    ...(canCreate
      ? [{ label: "New App", icon: <Plus className="h-4 w-4" />, onClick: () => setNewOpen(true) }]
      : []),
  ];

  return (
    <PageTransition>
      <ContentLoading loading={initialLoading} />
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <PageHeader
          title="Apps"
          description="Applications with their containers, databases, storage, routes and Pages"
          actions={
            <ResponsiveHeaderActions reservedContentWidth={160} actions={headerActions}>
              <Button
                variant="outline"
                size="icon"
                title="Refresh"
                aria-label="Refresh apps"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              </Button>
              {canManageFolders && createFolderAction && (
                <Button variant="outline" onClick={() => createFolderAction()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {canCreate && (
                <Button onClick={() => setNewOpen(true)}>
                  <Plus className="h-4 w-4" />
                  New App
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        {initialLoading ? null : (
          <FolderedResourceList<AppSummary>
            resourceType="app"
            realtimeChannel="apps.folder.changed"
            resources={visibleApps}
            columns={columns}
            search={{
              search,
              onSearchChange: setSearch,
              placeholder: "Search apps...",
              hasActiveFilters,
              onReset: resetFilters,
              filters: (
                <Select
                  value={statusFilter}
                  onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}
                >
                  <SelectTrigger className="w-[180px]" aria-label="Status">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            }}
            loading={loading}
            loadingLabel="Loading apps..."
            emptyState={
              apps.length === 0 ? (
                <EmptyState
                  message="No apps yet. An app keeps the containers, databases, storage, routes and Pages of one application together."
                  {...(canCreate
                    ? { actionLabel: "Create an app", onAction: () => setNewOpen(true) }
                    : {})}
                />
              ) : (
                <EmptyState
                  message="No apps match the search or filters."
                  hasActiveFilters={hasActiveFilters}
                  onReset={resetFilters}
                />
              )
            }
            canManageFolders={canManageFolders}
            // Moving an app between folders needs apps:edit on it (the server checks the destination too).
            canReorganizeItem={(app) => app.access !== "members" && (canManageFolders || canEdit)}
            getResourceLabel={(app) => app.name}
            onItemClick={(app) => navigate(appRoute(app.slug))}
            onRefresh={load}
            onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
          />
        )}
      </div>
      <NewAppDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(app) => {
          void load();
          navigate(appRoute(app.slug));
        }}
      />
    </PageTransition>
  );
}
