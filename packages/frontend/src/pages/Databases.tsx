import {
  ArrowRight,
  Database as DatabaseIcon,
  DatabaseZap,
  FolderPlus,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppMemberBadge } from "@/components/apps/AppMembership";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { MoveToAppRowMenu } from "@/components/apps/MoveToAppRowMenu";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResourceTagSummary } from "@/components/common/ResourceTagSummary";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { NORMAL_LIST_FILTER } from "@/lib/app-members";
import { DATABASE_TYPE_LABELS, databaseTypeLabel } from "@/lib/database-type";
import { refreshDynamicScopes } from "@/lib/live-scopes";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { databaseRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature } from "@/stores/license-paywall";
import type { DatabaseConnection, ManagedDatabaseCatalogEntry, Node } from "@/types";
import { DatabaseConnectionCreateDialog } from "./database-create/DatabaseConnectionCreateDialog";
import { ManagedDatabaseCreateDialog } from "./database-create/ManagedDatabaseCreateDialog";
import { DeletedDatabaseBackupsPanel } from "./database-detail/DeletedDatabaseBackupsPanel";

const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
};

const DATABASE_NODE_APPEARANCE_CACHE_KEY = "databases:nodes";

type DatabaseChangedPayload = {
  id?: string;
  action?: string;
  healthStatus?: DatabaseConnection["healthStatus"];
  sampledAt?: string;
};

export function applyDatabaseHealthSample(
  rows: DatabaseConnection[],
  payload: DatabaseChangedPayload
): DatabaseConnection[] {
  if (!payload.id || payload.action !== "health.sampled") return rows;
  let changed = false;
  const next = rows.map((row) => {
    if (row.id !== payload.id) return row;
    changed = true;
    return {
      ...row,
      ...(payload.healthStatus ? { healthStatus: payload.healthStatus } : {}),
      ...(payload.sampledAt ? { lastHealthCheckAt: payload.sampledAt } : {}),
    };
  });
  return changed ? next : rows;
}

export function canRenderDatabaseRowsWithNodeAppearance(
  rows: DatabaseConnection[],
  nodes: Node[]
): boolean {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return rows.every((row) => !row.managed || nodeIds.has(row.managed.nodeId));
}
function formatHealthLabel(status: DatabaseConnection["healthStatus"] | "paused"): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function DatabaseTagSummary({ tags, type }: { tags: string[]; type: DatabaseConnection["type"] }) {
  return (
    <ResourceTagSummary
      tags={tags}
      typeBadge={
        <Badge variant="outline" className="uppercase">
          {databaseTypeLabel(type)}
        </Badge>
      }
    />
  );
}

export function Databases(props: Parameters<typeof DatabasesContent>[0] = {}) {
  return (
    <LicenseFeatureBoundary
      feature="external-database-connections"
      capability="Database connections"
      frame={
        props.embedded
          ? undefined
          : { kind: "page", title: "Databases", description: "Manage and deploy databases" }
      }
    >
      <DatabasesContent {...props} />
    </LicenseFeatureBoundary>
  );
}

function DatabasesContent({
  embedded = false,
  managedNodeId,
}: {
  embedded?: boolean;
  managedNodeId?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, isLoading: authLoading } = useAuthStore();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "postgres" | "clickhouse" | "redis">("all");
  const [healthFilter, setHealthFilter] = useState<
    "all" | "online" | "offline" | "degraded" | "unknown"
  >("all");
  const databaseCacheKey = useMemo(
    () =>
      managedNodeId
        ? `databases:managed-node:${managedNodeId}:${search}:${typeFilter}:${healthFilter}`
        : `databases:list:${search}:${typeFilter}:${healthFilter}`,
    [healthFilter, managedNodeId, search, typeFilter]
  );
  const initialListState = useRef<{
    rows: DatabaseConnection[];
    nodes: Node[];
    loading: boolean;
  } | null>(null);
  if (!initialListState.current) {
    const cachedRows = embedded
      ? undefined
      : (api.getCached<DatabaseConnection[]>("databases:list::all:all") ??
        api.getCached<DatabaseConnection[]>("databases:list"));
    const cachedNodes = api.getCached<Node[]>(DATABASE_NODE_APPEARANCE_CACHE_KEY) ?? [];
    const canRenderCachedRows =
      !embedded &&
      cachedRows !== undefined &&
      canRenderDatabaseRowsWithNodeAppearance(cachedRows, cachedNodes);
    initialListState.current = {
      rows: canRenderCachedRows ? cachedRows : [],
      nodes: cachedNodes,
      loading: embedded || !canRenderCachedRows,
    };
  }
  const [rows, setRows] = useState<DatabaseConnection[]>(initialListState.current.rows);
  const [loading, setLoading] = useState(initialListState.current.loading);
  const [createOpen, setCreateOpen] = useState(false);
  const [managedCreateOpen, setManagedCreateOpen] = useState(false);
  const [managedNodeRequiredOpen, setManagedNodeRequiredOpen] = useState(false);
  const [managedCatalog, setManagedCatalog] = useState<ManagedDatabaseCatalogEntry[]>([]);
  const [databaseNodes, setDatabaseNodes] = useState<Node[]>(initialListState.current.nodes);
  const [databaseNodesLoaded, setDatabaseNodesLoaded] = useState(
    initialListState.current.nodes.length > 0
  );
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [moveToAppDatabase, setMoveToAppDatabase] = useState<DatabaseConnection | null>(null);
  const shownMoveToAppDatabase = useRetainedDialogValue(
    moveToAppDatabase,
    moveToAppDatabase !== null
  );
  const openConnectionCreate = () => {
    if (requireLicenseFeature("external-database-connections", "External database connections"))
      setCreateOpen(true);
  };

  const openManagedCreate = useCallback(() => {
    if (!requireLicenseFeature("managed-databases", "Managed databases")) return;
    if (databaseNodesLoaded && databaseNodes.length === 0) {
      setManagedNodeRequiredOpen(true);
      return;
    }
    setManagedCreateOpen(true);
  }, [databaseNodes.length, databaseNodesLoaded]);

  useEffect(() => {
    if (!(location.state as { createManagedDatabase?: boolean } | null)?.createManagedDatabase) {
      return;
    }
    openManagedCreate();
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate, openManagedCreate]);

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      // A node's view keeps app members; the normal list leaves them to their app's page (server-filtered).
      const cachedRows = api.getCached<DatabaseConnection[]>(databaseCacheKey);
      const cachedNodes = api.getCached<Node[]>(DATABASE_NODE_APPEARANCE_CACHE_KEY) ?? [];
      if (cachedRows && canRenderDatabaseRowsWithNodeAppearance(cachedRows, cachedNodes)) {
        setDatabaseNodes(cachedNodes);
        setDatabaseNodesLoaded(true);
        setRows(cachedRows);
        setLoading(false);
      } else if (!background) {
        setRows([]);
        setLoading(true);
      }

      const nodesRequest = listManagedDatabaseCandidateNodes().catch(() => null);
      // Rows are server-filtered; this lets row actions catch up with folder grants too.
      void refreshDynamicScopes();
      if (!embedded) {
        void api
          .listManagedDatabaseCatalog()
          .then(setManagedCatalog)
          .catch(() => undefined);
      }

      try {
        let data: DatabaseConnection[];
        if (managedNodeId) {
          const managed = await api.listManagedDatabases();
          const managedRows = await Promise.all(
            managed
              .filter(
                (database) => database.nodeId === managedNodeId && database.databaseConnectionId
              )
              .map((database) => api.getDatabase(database.databaseConnectionId))
          );
          data = managedRows.filter(
            (database) =>
              (!search || database.name.toLowerCase().includes(search.toLowerCase())) &&
              (typeFilter === "all" || database.type === typeFilter) &&
              (healthFilter === "all" || database.healthStatus === healthFilter)
          );
        } else {
          const result = await api.listDatabases({
            limit: 200,
            search: search || undefined,
            type: typeFilter === "all" ? undefined : typeFilter,
            healthStatus: healthFilter === "all" ? undefined : healthFilter,
            ...NORMAL_LIST_FILTER,
          });
          data = result.data;
        }

        const nodes = await nodesRequest;
        if (nodes) {
          api.setCache(DATABASE_NODE_APPEARANCE_CACHE_KEY, nodes);
          setDatabaseNodes(nodes);
          setDatabaseNodesLoaded(true);
        }
        api.setCache(databaseCacheKey, data);
        if (search === "" && typeFilter === "all" && healthFilter === "all") {
          api.setCache("databases:list", data);
        }
        setRows(data);
      } catch (error) {
        toastApiError(error, "Failed to load databases");
      } finally {
        setLoading(false);
      }
    },
    [databaseCacheKey, embedded, healthFilter, managedNodeId, search, typeFilter]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("database.changed", (rawPayload) => {
    const payload = rawPayload as DatabaseChangedPayload;
    if (payload.action === "health.sampled") {
      setRows((currentRows) => {
        const nextRows = applyDatabaseHealthSample(currentRows, payload);
        if (nextRows === currentRows) return currentRows;
        api.setCache(databaseCacheKey, nextRows);
        if (search === "" && typeFilter === "all" && healthFilter === "all") {
          api.setCache("databases:list", nextRows);
        }
        return nextRows;
      });
      return;
    }
    void load({ background: true });
  });

  useRealtime("database.folder.changed", () => {
    void load({ background: true });
  });

  useRealtime(hasScopedAccess("nodes:details") ? "node.changed" : null, () => {
    void listManagedDatabaseCandidateNodes()
      .then((nodes) => {
        api.setCache(DATABASE_NODE_APPEARANCE_CACHE_KEY, nodes);
        setDatabaseNodes(nodes);
        setDatabaseNodesLoaded(true);
      })
      .catch(() => undefined);
  });

  const canCreate = !embedded && hasScopedAccess("databases:create");
  const canManageSomeFolders = useCanManageSomeFolders("databases:folders:manage");
  const canManageFolders = !embedded && canManageSomeFolders;

  // The server already filters the list by view grants, including folder grants that cover
  // resources created after the cached scopes were loaded; row actions keep their own checks.
  const filtered = rows;

  const databaseNodeById = useMemo(
    () => new Map(databaseNodes.map((node) => [node.id, node])),
    [databaseNodes]
  );
  const deployableDatabaseNodes = useMemo(
    () => databaseNodes.filter((node) => node.status === "online" && node.isConnected),
    [databaseNodes]
  );

  // Members never show here (they live on their app's page); a node's view lists them read-only.
  const canMoveToApps = !embedded && hasScopedAccess("databases:edit");
  const canMoveDatabaseToApp = useCallback(
    (row: DatabaseConnection) => !row.app && hasScope(`databases:edit:${row.id}`),
    [hasScope]
  );

  const columns = useMemo<ResourceListColumn<DatabaseConnection>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        renderCell: (row) => {
          const Icon = row.managed ? DatabaseZap : DatabaseIcon;
          const node = row.managed ? databaseNodeById.get(row.managed.nodeId) : undefined;
          const iconClassNames = nodeIconClassNames(node?.appearanceColor);

          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className={iconClassNames.wrapper}>
                <Icon className={cn("h-5 w-5", iconClassNames.icon)} />
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  {row.app && <AppMemberBadge app={row.app} />}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {row.host}:{row.port}
                  {row.databaseName ? ` · ${row.databaseName}` : ""}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "tags",
        label: "Tags",
        width: "16rem",
        align: "right",
        renderCell: (row) => <DatabaseTagSummary tags={row.tags} type={row.type} />,
      },
      {
        id: "lastCheck",
        label: "Last Check",
        width: "8.5rem",
        align: "right",
        renderCell: (row) => (
          <Badge variant="outline">
            <RelativeTime value={row.lastHealthCheckAt} fallback="Never" />
          </Badge>
        ),
      },
      {
        id: "health",
        label: "Health",
        width: "8rem",
        align: "right",
        renderCell: (row) => {
          const node = row.managed ? databaseNodeById.get(row.managed.nodeId) : undefined;
          if (node && (node.status !== "online" || !node.isConnected)) {
            return <Badge variant="secondary">Unavailable</Badge>;
          }
          const status = row.managed?.status === "paused" ? "paused" : row.healthStatus;
          return (
            <Badge variant={HEALTH_BADGE[status] ?? "secondary"}>{formatHealthLabel(status)}</Badge>
          );
        },
      },
      ...(canMoveToApps
        ? [
            {
              id: "actions",
              label: "Actions",
              width: "4.5rem",
              align: "right" as const,
              renderCell: (row: DatabaseConnection) =>
                canMoveDatabaseToApp(row) ? (
                  <MoveToAppRowMenu
                    resourceLabel={row.name}
                    onOpen={() => navigate(databaseRoute(row.slug, "overview"))}
                    onMoveToApp={() => setMoveToAppDatabase(row)}
                  />
                ) : null,
            } satisfies ResourceListColumn<DatabaseConnection>,
          ]
        : []),
    ],
    [canMoveDatabaseToApp, canMoveToApps, databaseNodeById, navigate]
  );

  return (
    <PageTransition>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <PageHeader
            leading={<LiteModeBackButton />}
            title="Databases"
            description="Manage and deploy databases"
            actions={
              <ResponsiveHeaderActions
                reservedContentWidth={160}
                actions={[
                  {
                    label: "Refresh",
                    icon: <RefreshCw className="h-4 w-4" />,
                    onClick: () => void load(),
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
                    ? [
                        {
                          label: "Deploy managed database",
                          icon: <Plus className="h-4 w-4" />,
                          onClick: openManagedCreate,
                        },
                        {
                          label: "Connect existing database",
                          icon: <Plus className="h-4 w-4" />,
                          onClick: openConnectionCreate,
                        },
                      ]
                    : []),
                ]}
              >
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void load()}
                  title="Refresh"
                  aria-label="Refresh databases"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                {canManageFolders && (
                  <Button variant="outline" onClick={() => createFolderAction?.()}>
                    <FolderPlus className="h-4 w-4" />
                    Add Folder
                  </Button>
                )}
                {canCreate && (
                  <Button variant="outline" onClick={openConnectionCreate}>
                    <Plus className="h-4 w-4" />
                    Connect existing
                  </Button>
                )}
                {canCreate && (
                  <Button onClick={openManagedCreate}>
                    <Plus className="h-4 w-4" />
                    Deploy database
                  </Button>
                )}
              </ResponsiveHeaderActions>
            }
          />
        )}

        <FolderedResourceList<DatabaseConnection>
          resourceType="database"
          realtimeChannel="database.folder.changed"
          resources={filtered}
          columns={columns}
          search={{
            placeholder: "Search databases...",
            search,
            onSearchChange: setSearch,
            onSearchSubmit: () => void load(),
            hasActiveFilters: search !== "" || typeFilter !== "all" || healthFilter !== "all",
            onReset: () => {
              setSearch("");
              setTypeFilter("all");
              setHealthFilter("all");
            },
            filters: (
              <>
                <Select
                  value={typeFilter}
                  onValueChange={(value) => setTypeFilter(value as typeof typeFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="postgres">Postgres</SelectItem>
                    <SelectItem value="clickhouse">ClickHouse</SelectItem>
                    <SelectItem value="redis">{DATABASE_TYPE_LABELS.redis}</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={healthFilter}
                  onValueChange={(value) => setHealthFilter(value as typeof healthFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Health" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All health states</SelectItem>
                    <SelectItem value="online">Online</SelectItem>
                    <SelectItem value="degraded">Degraded</SelectItem>
                    <SelectItem value="offline">Offline</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </>
            ),
          }}
          loading={loading || authLoading}
          loadingLabel="Loading databases..."
          emptyState={
            <EmptyState
              message="No databases yet. Connect an existing database or deploy a managed instance."
              {...(canCreate
                ? { actionLabel: "Connect existing database", onAction: openConnectionCreate }
                : {})}
              hasActiveFilters={search !== "" || typeFilter !== "all" || healthFilter !== "all"}
              onReset={() => {
                setSearch("");
                setTypeFilter("all");
                setHealthFilter("all");
              }}
            />
          }
          canManageFolders={canManageFolders}
          canViewItem={(row) => hasScope("databases:view") || hasScope(`databases:view:${row.id}`)}
          canReorganizeItem={(row) => canManageFolders && !row.app}
          getResourceLabel={(row) => row.name}
          onItemClick={(row) => navigate(databaseRoute(row.slug, "overview"))}
          onRefresh={() => load()}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />

        {!embedded && <DeletedDatabaseBackupsPanel />}
      </div>

      {canMoveToApps && (
        <MoveToAppDialog
          open={moveToAppDatabase !== null}
          onOpenChange={(open) => {
            if (!open) setMoveToAppDatabase(null);
          }}
          members={
            shownMoveToAppDatabase ? [{ type: "database", id: shownMoveToAppDatabase.id }] : []
          }
          resourceLabel={shownMoveToAppDatabase?.name ?? "the database"}
          onMoved={() => void load({ background: true })}
        />
      )}

      {!embedded && (
        <DatabaseConnectionCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      )}

      {!embedded && (
        <ManagedDatabaseCreateDialog
          open={managedCreateOpen}
          onOpenChange={setManagedCreateOpen}
          nodes={deployableDatabaseNodes}
          catalog={managedCatalog}
        />
      )}

      {!embedded && (
        <Dialog open={managedNodeRequiredOpen} onOpenChange={setManagedNodeRequiredOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Connect a Node First</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Managed databases run on a connected node. Add a node first, then return here to
              deploy your database.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setManagedNodeRequiredOpen(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setManagedNodeRequiredOpen(false);
                  navigate("/nodes");
                }}
              >
                Open Nodes <ArrowRight className="h-4 w-4" />
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageTransition>
  );
}

import { LicenseFeatureBoundary } from "@/components/license/LicenseFeatureBoundary";
