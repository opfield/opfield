import { FolderPlus, HardDrive, HardDriveDownload, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { NORMAL_LIST_FILTER } from "@/lib/app-members";
import { refreshDynamicScopes } from "@/lib/live-scopes";
import {
  isManagedStorageCandidateNode,
  listManagedDatabaseCandidateNodes,
} from "@/lib/managed-database-nodes";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { storageRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature } from "@/stores/license-paywall";
import type {
  ManagedObjectStorageCatalogEntry,
  ManagedObjectStorageStatus,
  Node,
  ObjectStorageConnection,
  ObjectStorageProvider,
} from "@/types";
import { ManagedStorageCreateDialog } from "./storage-create/ManagedStorageCreateDialog";
import { StorageConnectionCreateDialog } from "./storage-create/StorageConnectionCreateDialog";
import { isManagedStorageFull } from "./storage-detail/managed-storage-engine";
import { formatProviderLabel } from "./storage-detail/shared";

const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
};

const MANAGED_STORAGE_STATUS_BADGE: Record<
  string,
  "success" | "secondary" | "warning" | "destructive"
> = {
  creating: "secondary",
  updating: "warning",
  ready: "success",
  stopped: "secondary",
  error: "destructive",
  deleting: "warning",
};

const STORAGE_NODE_APPEARANCE_CACHE_KEY = "storage:nodes";

function formatHealthLabel(
  status: ObjectStorageConnection["healthStatus"] | ManagedObjectStorageStatus
): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function StorageTagSummary({
  tags,
  provider,
}: {
  tags: string[];
  provider: ObjectStorageConnection["provider"];
}) {
  return (
    <ResourceTagSummary
      tags={tags}
      typeFirst
      typeBadge={<Badge variant="secondary">{formatProviderLabel(provider)}</Badge>}
    />
  );
}

const STORAGE_FRAME: LicenseFeatureFrame = {
  kind: "page",
  title: "Storage",
  description: "Saved S3-compatible object storage connections managed through Opfield",
};

export function Storage() {
  return (
    <LicenseFeatureBoundary
      feature="storage-connections"
      capability="Storage connections"
      frame={STORAGE_FRAME}
    >
      <StorageContent />
    </LicenseFeatureBoundary>
  );
}

function StorageContent() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess, isLoading: authLoading } = useAuthStore();
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<"all" | ObjectStorageProvider>("all");
  const [healthFilter, setHealthFilter] = useState<
    "all" | "online" | "offline" | "degraded" | "unknown"
  >("all");
  const storageCacheKey = useMemo(
    () => `storage:list:${search}:${providerFilter}:${healthFilter}`,
    [healthFilter, providerFilter, search]
  );
  const [rows, setRows] = useState<ObjectStorageConnection[]>(
    () =>
      api.getCached<ObjectStorageConnection[]>("storage:list::all:all") ??
      api.getCached<ObjectStorageConnection[]>("storage:list") ??
      []
  );
  const [loading, setLoading] = useState(
    () =>
      api.getCached<ObjectStorageConnection[]>("storage:list::all:all") === undefined &&
      api.getCached<ObjectStorageConnection[]>("storage:list") === undefined
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [moveToAppStorage, setMoveToAppStorage] = useState<ObjectStorageConnection | null>(null);
  const shownMoveToAppStorage = useRetainedDialogValue(moveToAppStorage, moveToAppStorage !== null);
  const [managedCreateOpen, setManagedCreateOpen] = useState(false);
  const [managedCatalog, setManagedCatalog] = useState<ManagedObjectStorageCatalogEntry[]>([]);
  // Cached with the list so a cached list keeps its node icon colors on the first frame.
  const [storageNodes, setStorageNodes] = useState<Node[]>(
    () => api.getCached<Node[]>(STORAGE_NODE_APPEARANCE_CACHE_KEY) ?? []
  );

  const openConnectionCreate = () => {
    if (!requireLicenseFeature("storage-connections", "Storage connections")) return;
    setCreateOpen(true);
  };

  const openManagedCreate = useCallback(() => {
    if (!requireLicenseFeature("managed-storage", "Managed storage")) return;
    setManagedCreateOpen(true);
  }, []);

  const load = useCallback(async () => {
    const cachedRows = api.getCached<ObjectStorageConnection[]>(storageCacheKey);
    if (cachedRows) {
      setRows(cachedRows);
      setLoading(false);
    } else {
      setRows([]);
      setLoading(true);
    }
    // Rows are server-filtered; this lets row actions catch up with folder grants too.
    void refreshDynamicScopes();
    try {
      const result = await api.listObjectStorages({
        limit: 200,
        search: search || undefined,
        provider: providerFilter === "all" ? undefined : providerFilter,
        healthStatus: healthFilter === "all" ? undefined : healthFilter,
        ...NORMAL_LIST_FILTER,
      });
      api.setCache(storageCacheKey, result.data);
      if (search === "" && providerFilter === "all" && healthFilter === "all") {
        api.setCache("storage:list", result.data);
      }
      setRows(result.data);
      const [nodes, catalog] = await Promise.allSettled([
        listManagedDatabaseCandidateNodes(100),
        api.listManagedObjectStorageCatalog(),
      ]);
      if (nodes.status === "fulfilled") {
        const candidates = nodes.value.filter(isManagedStorageCandidateNode);
        api.setCache(STORAGE_NODE_APPEARANCE_CACHE_KEY, candidates);
        setStorageNodes(candidates);
      }
      if (catalog.status === "fulfilled") setManagedCatalog(catalog.value);
    } catch (error) {
      toastApiError(error, "Failed to load storage");
    } finally {
      setLoading(false);
    }
  }, [healthFilter, providerFilter, search, storageCacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const canCreate = hasScopedAccess("storage:create");
  const canManageFolders = useCanManageSomeFolders("storage:folders:manage");

  // The server already filters the list by view grants, including folder grants that cover
  // resources created after the cached scopes were loaded, and leaves app members out (they live on
  // their app's page); row actions keep their own checks.
  const canMoveToApps = hasScopedAccess("storage:edit");
  const canMoveStorageToApp = useCallback(
    (row: ObjectStorageConnection) => !row.app && hasScope(`storage:edit:${row.id}`),
    [hasScope]
  );

  const storageNodeById = useMemo(
    () => new Map(storageNodes.map((node) => [node.id, node])),
    [storageNodes]
  );
  const deployableStorageNodes = useMemo(
    () => storageNodes.filter((node) => node.status === "online" && node.isConnected),
    [storageNodes]
  );
  const columns = useMemo<ResourceListColumn<ObjectStorageConnection>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        renderCell: (row) => {
          const Icon = row.managed ? HardDriveDownload : HardDrive;
          const node = row.managed ? storageNodeById.get(row.managed.nodeId) : undefined;
          const iconClassNames = nodeIconClassNames(node?.appearanceColor);

          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className={iconClassNames.wrapper}>
                <Icon className={cn("h-5 w-5", iconClassNames.icon)} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.endpoint || formatProviderLabel(row.provider)}
                  {row.defaultBucket ? ` · ${row.defaultBucket}` : ""}
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
        renderCell: (row) => <StorageTagSummary tags={row.tags} provider={row.provider} />,
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
          if (row.managed && isManagedStorageFull(row)) {
            // Serving but refusing uploads: its connection is degraded, with the reason.
            return (
              <Badge variant="warning" title={row.lastError ?? undefined}>
                {formatHealthLabel("degraded")}
              </Badge>
            );
          }
          if (row.managed) {
            return (
              <Badge variant={MANAGED_STORAGE_STATUS_BADGE[row.managed.status] ?? "secondary"}>
                {formatHealthLabel(row.managed.status)}
              </Badge>
            );
          }
          return (
            <Badge variant={HEALTH_BADGE[row.healthStatus] ?? "secondary"}>
              {formatHealthLabel(row.healthStatus)}
            </Badge>
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
              renderCell: (row: ObjectStorageConnection) =>
                canMoveStorageToApp(row) ? (
                  <MoveToAppRowMenu
                    resourceLabel={row.name}
                    onOpen={() => navigate(storageRoute(row.slug, "overview"))}
                    onMoveToApp={() => setMoveToAppStorage(row)}
                  />
                ) : null,
            } satisfies ResourceListColumn<ObjectStorageConnection>,
          ]
        : []),
    ],
    [canMoveStorageToApp, canMoveToApps, navigate, storageNodeById]
  );

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <PageHeader
          leading={<LiteModeBackButton />}
          title="Storage"
          description="Saved S3-compatible object storage connections managed through Opfield"
          actions={
            <ResponsiveHeaderActions
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
                        label: "Deploy managed storage",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: openManagedCreate,
                      },
                      {
                        label: "Connect existing storage",
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
                aria-label="Refresh storage"
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
                  Deploy managed storage
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <FolderedResourceList<ObjectStorageConnection>
          resourceType="storage"
          realtimeChannel="storage.folder.changed"
          resources={rows}
          columns={columns}
          search={{
            placeholder: "Search storage...",
            search,
            onSearchChange: setSearch,
            onSearchSubmit: () => void load(),
            hasActiveFilters: search !== "" || providerFilter !== "all" || healthFilter !== "all",
            onReset: () => {
              setSearch("");
              setProviderFilter("all");
              setHealthFilter("all");
            },
            filters: (
              <>
                <Select
                  value={providerFilter}
                  onValueChange={(value) => setProviderFilter(value as typeof providerFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All providers</SelectItem>
                    <SelectItem value="aws">AWS S3</SelectItem>
                    <SelectItem value="cloudflare_r2">Cloudflare R2</SelectItem>
                    <SelectItem value="seaweedfs">SeaweedFS</SelectItem>
                    <SelectItem value="minio">MinIO</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                    <SelectItem value="sftp">SFTP</SelectItem>
                    <SelectItem value="ftp">FTP</SelectItem>
                    <SelectItem value="ftps">FTPS</SelectItem>
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
          loadingLabel="Loading storage connections..."
          emptyState={
            <EmptyState
              message="No storage connections. Add an S3-compatible bucket to manage it through Opfield."
              {...(canCreate ? { actionLabel: "Add Storage", onAction: openConnectionCreate } : {})}
              hasActiveFilters={search !== "" || providerFilter !== "all" || healthFilter !== "all"}
              onReset={() => {
                setSearch("");
                setProviderFilter("all");
                setHealthFilter("all");
              }}
            />
          }
          canManageFolders={canManageFolders}
          canViewItem={(row) => hasScope("storage:view") || hasScope(`storage:view:${row.id}`)}
          canReorganizeItem={(row) => canManageFolders && !row.app}
          getResourceLabel={(row) => row.name}
          onItemClick={(row) => navigate(storageRoute(row.slug, "overview"))}
          onRefresh={() => load()}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />
      </div>

      {canMoveToApps && (
        <MoveToAppDialog
          open={moveToAppStorage !== null}
          onOpenChange={(open) => {
            if (!open) setMoveToAppStorage(null);
          }}
          members={shownMoveToAppStorage ? [{ type: "storage", id: shownMoveToAppStorage.id }] : []}
          resourceLabel={shownMoveToAppStorage?.name ?? "the storage"}
          onMoved={() => void load()}
        />
      )}

      <StorageConnectionCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

      <ManagedStorageCreateDialog
        open={managedCreateOpen}
        onOpenChange={setManagedCreateOpen}
        nodes={deployableStorageNodes}
        catalog={managedCatalog}
      />
    </PageTransition>
  );
}

import {
  LicenseFeatureBoundary,
  type LicenseFeatureFrame,
} from "@/components/license/LicenseFeatureBoundary";
