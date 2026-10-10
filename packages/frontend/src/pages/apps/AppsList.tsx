// Apps: the top-level list (canvas frames apps-list, apps-empty, apps-new-app).
// Same page frame and rows as Databases and Docker containers.
import { AppWindow, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import {
  ResourceListCell,
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { appRoute } from "@/lib/app-routes";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { APPS_LIST_CACHE_KEY } from "@/services/api-apps";
import { useAuthStore } from "@/stores/auth";
import { APPS_REALTIME_CHANNEL, type AppSummary } from "@/types";
import { HEALTH_BADGE, orderedEnvironments } from "./app-shared";
import { NewAppDialog } from "./dialogs/NewAppDialog";

function AppHealthCell({ app }: { app: AppSummary }) {
  if (app.incident === "isolated" || app.incident === "partial") {
    return <Badge variant="destructive">isolated</Badge>;
  }
  if (app.incident === "stopped") return <Badge variant="secondary">stopped</Badge>;
  return <Badge variant={HEALTH_BADGE[app.health]}>{app.health}</Badge>;
}

const columns: ResourceListColumn<AppSummary>[] = [
  {
    id: "name",
    label: "Name",
    width: "30%",
    renderCell: (app) => {
      const icon = nodeIconClassNames(null);
      return (
        <div className="flex min-w-0 items-center gap-4">
          <div className={icon.wrapper}>
            <AppWindow className={cn("h-5 w-5", icon.icon)} />
          </div>
          <p className="min-w-0 truncate text-sm font-medium">{app.name}</p>
        </div>
      );
    },
  },
  {
    id: "environments",
    label: "Environments",
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
  const canCreate = useAuthStore((state) => state.hasScope("apps:create"));
  const [apps, setApps] = useState<AppSummary[]>(
    () => api.getCached<AppSummary[]>(APPS_LIST_CACHE_KEY) ?? []
  );
  const [loading, setLoading] = useState(() => !api.getCached(APPS_LIST_CACHE_KEY));
  const [refreshing, setRefreshing] = useState(false);
  const initialLoading = useInitialLoading(loading);
  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.listApps();
      api.setCache(APPS_LIST_CACHE_KEY, next);
      setApps(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load apps");
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
              {canCreate && (
                <Button onClick={() => setNewOpen(true)}>
                  <Plus className="h-4 w-4" />
                  New App
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        {initialLoading ? null : apps.length === 0 ? (
          <EmptyState
            message="No apps yet. An app keeps the containers, databases, storage, routes and Pages of one application together."
            {...(canCreate
              ? { actionLabel: "Create an app", onAction: () => setNewOpen(true) }
              : {})}
          />
        ) : (
          <ResourceListFrame minWidth={920}>
            <ResourceListHeaderTable columns={columns} />
            <ResourceListTable columns={columns}>
              {apps.map((app) => (
                <ResourceListRow
                  key={app.id}
                  interactive
                  className="last:border-b-0"
                  onClick={() => navigate(appRoute(app.slug))}
                >
                  {columns.map((column) => (
                    <ResourceListCell
                      key={column.id}
                      align={column.align}
                      contentClassName={column.cellContentClassName}
                    >
                      {column.renderCell?.(app)}
                    </ResourceListCell>
                  ))}
                </ResourceListRow>
              ))}
            </ResourceListTable>
          </ResourceListFrame>
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
