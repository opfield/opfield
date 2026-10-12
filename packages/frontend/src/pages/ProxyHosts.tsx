import { type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { ArrowRight, FolderPlus, MoreVertical, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderCreateDialog } from "@/components/common/FolderCreateDialog";
import { HubTabPanel, HubTabs } from "@/components/common/HubTabs";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { MoveToFolderDialog } from "@/components/common/MoveToFolderDialog";
import { PageHeader } from "@/components/common/PageHeader";
import { ResourceListForm } from "@/components/common/ResourceListForm";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import {
  applyRootFolderView,
  canMoveFolderInto,
  defaultOpenFolderId,
} from "@/components/common/resource-list/folder-view";
import { CreateProxyHostDialog } from "@/components/proxy/CreateProxyHostDialog";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useFolderAccess } from "@/hooks/use-folder-access";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { findFolderTreeNode } from "@/lib/folder-tree";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { isGatewayPublicRoute } from "@/lib/proxy-route-protection";
import { proxyHostRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { hasSavedProxyFolderExpansion, useFolderStore } from "@/stores/folders";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { FolderTreeNode, HealthStatus, ProxyHost, ProxyHostType } from "@/types";
import { HEALTH_BADGE, HEALTH_LABEL, TYPE_BADGE } from "./proxy-detail/helpers";

const typeOptions: { value: ProxyHostType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "proxy", label: "Proxy" },
  { value: "redirect", label: "Redirect" },
  { value: "404", label: "404" },
];

const healthOptions: { value: HealthStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
  { value: "degraded", label: "Degraded" },
  { value: "unknown", label: "Unknown" },
  { value: "disabled", label: "Disabled" },
];

function pruneEmptyFolders<T extends { children: T[]; hosts: Array<unknown> }>(folders: T[]): T[] {
  return folders
    .map((folder) => ({ ...folder, children: pruneEmptyFolders(folder.children) }))
    .filter((folder) => folder.hosts.length > 0 || folder.children.length > 0);
}

function TypeBadge({ type }: { type: ProxyHostType }) {
  return <Badge variant={TYPE_BADGE[type] ?? "secondary"}>{type}</Badge>;
}

export function ProxyHosts({
  initialCreateDialogOpen = false,
}: {
  initialCreateDialogOpen?: boolean;
} = {}) {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const gatewayPublicUrl = useUIBootstrapStore(
    (state) => state.snapshot?.systemConfig.publicUrl ?? null
  );
  const {
    folders,
    ungroupedHosts,
    isLoading,
    filters,
    expandedFolderIds,
    fetchGroupedHosts,
    setFilters,
    resetFilters,
    createFolder,
    renameFolder,
    deleteFolder,
    moveHostsToFolder,
    moveFolder,
    reorderFolders,
    reorderHosts,
    toggleFolder,
  } = useFolderStore();

  const [searchInput, setSearchInput] = useState(filters.search);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [moveDialogHostId, setMoveDialogHostId] = useState<string | null>(null);
  const shownMoveDialogHostId = useRetainedDialogValue(moveDialogHostId, moveDialogHostId !== null);
  const [moveToAppHost, setMoveToAppHost] = useState<ProxyHost | null>(null);
  const shownMoveToAppHost = useRetainedDialogValue(moveToAppHost, moveToAppHost !== null);
  const [activeDrag, setActiveDrag] = useState<DragEndEvent["active"] | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [nginxNodeRequiredOpen, setNginxNodeRequiredOpen] = useState(false);
  const [checkingCreateNodes, setCheckingCreateNodes] = useState(false);
  const initialCreateHandledRef = useRef(false);
  const isMobile = useIsMobile();
  // Visible only through folder grants: one top-most granted folder works as the root. Folder
  // management may be limited to some folders' subfolders.
  const {
    limitedToFolders,
    isGrantedFolder,
    canManageSomeFolders: canManageFolders,
    canManageFolderAt,
  } = useFolderAccess("proxy:view", "proxy:folders:manage");
  const [moveFolderId, setMoveFolderId] = useState<string | null>(null);
  const shownMoveFolderId = useRetainedDialogValue(moveFolderId, moveFolderId !== null);
  const isSearchFiltering = filters.search.trim() !== "";
  const canReorderFolders = canManageFolders && !isMobile && !isSearchFiltering;
  const canCreateProxyHost = hasScopedAccess("proxy:create");
  const canShowHostActions =
    canManageFolders || hasScopedAccess("proxy:edit") || hasScopedAccess("proxy:delete");
  const ingressNodes = useUIBootstrapStore((state) => state.snapshot?.navigation.nodes.data);
  const ingressNodeById = useMemo(
    () => new Map((ingressNodes ?? []).map((node) => [node.id, node] as const)),
    [ingressNodes]
  );

  const openCreateProxyHost = useCallback(async () => {
    if (checkingCreateNodes) return;
    setCheckingCreateNodes(true);
    try {
      const response = await api.listNodes({ type: "nginx", limit: 1 });
      if ((response.data ?? []).length === 0) {
        setNginxNodeRequiredOpen(true);
        return;
      }
      setCreateDialogOpen(true);
    } catch (error) {
      toastApiError(error, "Failed to check Ingress nodes");
    } finally {
      setCheckingCreateNodes(false);
    }
  }, [checkingCreateNodes]);

  useEffect(() => {
    if (!initialCreateDialogOpen || initialCreateHandledRef.current) return;
    initialCreateHandledRef.current = true;
    void openCreateProxyHost();
  }, [initialCreateDialogOpen, openCreateProxyHost]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  useEffect(() => {
    fetchGroupedHosts();
  }, [fetchGroupedHosts]);

  useRealtime("proxy.host.changed", (payload) => {
    if ((payload as { action?: string } | null)?.action === "health.sampled") return;
    fetchGroupedHosts();
  });

  const handleSearch = () => {
    setFilters({ search: searchInput });
  };

  const hasActiveFilters =
    filters.type !== "all" || filters.healthStatus !== "all" || filters.search !== "";
  const shown = useMemo(
    () =>
      applyRootFolderView(
        isSearchFiltering ? pruneEmptyFolders(folders) : folders,
        ungroupedHosts,
        (folder) => folder.hosts,
        { limitedToFolders, isGrantedFolder }
      ),
    [folders, isGrantedFolder, isSearchFiltering, limitedToFolders, ungroupedHosts]
  );
  const rootFolderId = shown.root?.id ?? null;
  // The first folder starts open, as in the other lists, until the user folds a folder.
  const defaultOpenId =
    limitedToFolders && !isSearchFiltering
      ? defaultOpenFolderId(shown.folders, shown.ungrouped.length, hasSavedProxyFolderExpansion())
      : null;

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    setTogglingIds((prev) => new Set(prev).add(id));
    try {
      await api.toggleProxyHost(id, !currentEnabled);
      api.invalidateCache();
      toast.success(currentEnabled ? "Proxy host disabled" : "Proxy host enabled");
      await fetchGroupedHosts();
    } catch (err) {
      toastApiError(err, "Failed to toggle route");
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleMaintenance = async (host: ProxyHost) => {
    const entering = !host.maintenanceEnabled;
    if (entering) {
      const ok = await confirm({
        title: "Enable Maintenance Mode",
        description:
          "All requests to this route will receive HTTP 503 and managed health checks will pause until maintenance ends.",
        confirmLabel: "Enable Maintenance",
      });
      if (!ok) return;
    }

    setTogglingIds((prev) => new Set(prev).add(host.id));
    try {
      await api.toggleProxyMaintenance(host.id, entering);
      api.invalidateCache();
      toast.success(entering ? "Maintenance mode enabled" : "Maintenance mode disabled");
      await fetchGroupedHosts();
    } catch (err) {
      toastApiError(err, "Failed to update maintenance mode");
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(host.id);
        return next;
      });
    }
  };

  const handleCreateFolder = async (name: string) => {
    try {
      await createFolder(name, createFolderParentId ?? rootFolderId ?? undefined);
      toast.success("Folder created");
      setCreateFolderOpen(false);
    } catch (err) {
      toastApiError(err, "Failed to create folder");
    }
  };

  const handleRenameFolder = async (id: string, name: string) => {
    try {
      await renameFolder(id, name);
      toast.success("Folder renamed");
    } catch (err) {
      toastApiError(err, "Failed to rename folder");
    }
  };

  const handleDeleteFolder = async (id: string) => {
    const ok = await confirm({
      title: "Delete Folder",
      description:
        "Are you sure? Hosts inside will be moved to ungrouped. Subfolders will be deleted.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await deleteFolder(id);
      toast.success("Folder deleted");
    } catch (err) {
      toastApiError(err, "Failed to delete folder");
    }
  };

  const handleMoveHost = async (folderId: string | null) => {
    if (!moveDialogHostId) return;
    try {
      await moveHostsToFolder([moveDialogHostId], folderId);
      toast.success("Host moved");
      setMoveDialogHostId(null);
    } catch (err) {
      toastApiError(err, "Failed to move host");
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDrag(null);
    if (!canManageFolders || isSearchFiltering) return;
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.type === "folder") {
      if (overData?.type !== "folder" || active.id === over.id) return;

      const findFolderSiblings = (
        nodes: typeof folders,
        folderId: string,
        parentId: string | null = null
      ): { siblings: typeof folders; parentId: string | null } | null => {
        for (const node of nodes) {
          if (node.id === folderId) return { siblings: nodes, parentId };
          const found = findFolderSiblings(node.children as typeof folders, folderId, node.id);
          if (found) return found;
        }
        return null;
      };

      const activeGroup = findFolderSiblings(folders, activeData.folderId as string);
      const overGroup = findFolderSiblings(folders, overData.folderId as string);
      if (!activeGroup || !overGroup || activeGroup.parentId !== overGroup.parentId) return;
      if (!canManageFolderAt(activeGroup.parentId)) return;

      const oldIndex = activeGroup.siblings.findIndex(
        (folder) => folder.id === activeData.folderId
      );
      const newIndex = overGroup.siblings.findIndex((folder) => folder.id === overData.folderId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const reordered = [...activeGroup.siblings];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      try {
        await reorderFolders(
          reordered.map((folder, index) => ({ id: folder.id, sortOrder: index }))
        );
      } catch (err) {
        toastApiError(err, "Failed to reorder folders");
      }
      return;
    }

    if (activeData?.type !== "host") return;

    const hostId = active.id as string;
    const host = activeData.host;
    const dropData = overData;
    if (!canManageFolderAt(host.folderId ?? null)) return;

    // Dropped on a folder header → move to folder
    if (dropData?.type === "folder") {
      const targetFolderId = dropData.folderId as string | null;
      if (host.folderId === targetFolderId || !canManageFolderAt(targetFolderId)) return;
      try {
        await moveHostsToFolder([hostId], targetFolderId);
        toast.success("Host moved");
      } catch (err) {
        toastApiError(err, "Failed to move host");
      }
      return;
    }

    // Dropped on another host → reorder within the same folder
    if (dropData?.type === "host" && active.id !== over.id) {
      const overHost = dropData.host;
      // Only reorder if same folder
      if (host.folderId !== overHost.folderId) {
        if (!canManageFolderAt(overHost.folderId ?? null)) return;
        // Different folders: move to that folder
        try {
          await moveHostsToFolder([hostId], overHost.folderId);
          toast.success("Host moved");
        } catch (err) {
          toastApiError(err, "Failed to move host");
        }
        return;
      }

      // Same folder: reorder
      const hostsInFolder = host.folderId ? findHostsInFolder(host.folderId) : ungroupedHosts;

      const oldIndex = hostsInFolder.findIndex((h) => h.id === hostId);
      const newIndex = hostsInFolder.findIndex((h) => h.id === over.id);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      // Build new order
      const reordered = [...hostsInFolder];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      try {
        await reorderHosts(reordered.map((h, i) => ({ id: h.id, sortOrder: i })));
      } catch (err) {
        toastApiError(err, "Failed to reorder");
      }
    }
  };

  const findHostsInFolder = (folderId: string): typeof ungroupedHosts => {
    const search = (nodes: typeof folders): typeof ungroupedHosts | null => {
      for (const node of nodes) {
        if (node.id === folderId) return node.hosts;
        const found = search(node.children);
        if (found) return found;
      }
      return null;
    };
    return search(folders) ?? [];
  };

  // Find current folder of host being moved (for dialog default)
  const findHostFolderId = (hostId: string): string | null => {
    for (const host of ungroupedHosts) {
      if (host.id === hostId) return null;
    }
    const search = (nodes: typeof folders): string | null => {
      for (const node of nodes) {
        for (const host of node.hosts) {
          if (host.id === hostId) return node.id;
        }
        const found = search(node.children);
        if (found !== null) return found;
      }
      return null;
    };
    return search(folders);
  };

  const canViewHost = (host: ProxyHost) =>
    hasScope("proxy:view") || hasScope(`proxy:view:${host.id}`);
  const canEditHost = (host: ProxyHost) =>
    hasScope("proxy:edit") || hasScope(`proxy:edit:${host.id}`);
  // Same checks as POST /proxy-host-folders/move-hosts: folder management plus
  // edit access on the route and on the destination.
  const canMoveHost = (host: ProxyHost) =>
    !host.app && canManageFolders && canEditHost(host) && canManageFolderAt(host.folderId ?? null);
  // System routes and the Gateway public route never join an app (the server refuses them too).
  const canMoveHostToApp = (host: ProxyHost) =>
    !host.app &&
    !host.isSystem &&
    !isGatewayPublicRoute(host, gatewayPublicUrl) &&
    canEditHost(host);
  const canMoveHostTo = (folderId: string | null) =>
    canCreateInFolder(user?.scopes ?? [], "proxy:edit", folderId) && canManageFolderAt(folderId);
  const canManageFolder = (folder: FolderTreeNode) => canManageFolderAt(folder.parentId ?? null);

  const handleMoveFolder = async (id: string, parentId: string | null) => {
    try {
      await moveFolder(id, parentId);
      toast.success("Folder moved");
    } catch (err) {
      toastApiError(err, "Failed to move folder");
    }
  };

  const columns: ResourceListColumn<ProxyHost>[] = [
    {
      id: "domain-names",
      label: "Domains",
      renderCell: (host) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{host.domainNames[0]}</p>
          {host.domainNames.length > 1 && (
            <p className="truncate text-xs text-muted-foreground">
              +{host.domainNames.length - 1} more
            </p>
          )}
        </div>
      ),
    },
    {
      id: "upstream",
      label: "Target",
      width: "22%",
      align: "right",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (host) =>
        host.type === "proxy" ? (
          <ProxyUpstreamTarget host={host} />
        ) : host.type === "redirect" && host.redirectUrl ? (
          host.redirectUrl
        ) : (
          "—"
        ),
    },
    {
      id: "ingress-node",
      label: "Ingress Node",
      width: "10rem",
      align: "right",
      renderCell: (host) => {
        const node = host.nodeId ? ingressNodeById.get(host.nodeId) : undefined;
        return (
          <Badge variant="secondary" className={nodeBadgeClassName(node?.appearanceColor)}>
            {node ? node.displayName || node.hostname : host.nodeId ? "Unknown node" : "Unassigned"}
          </Badge>
        );
      },
    },
    {
      id: "type",
      label: "Type",
      width: "6.5rem",
      align: "right",
      renderCell: (host) => <TypeBadge type={host.type} />,
    },
    {
      id: "health",
      label: "Health",
      width: "8rem",
      align: "right",
      renderCell: (host) => {
        if (host.maintenanceEnabled) return <Badge variant="warning">Maintenance</Badge>;
        const status = host.rawConfigEnabled
          ? "disabled"
          : host.effectiveHealthStatus || host.healthStatus;
        return (
          <Badge variant={HEALTH_BADGE[status] ?? "secondary"}>
            {HEALTH_LABEL[status] ?? status}
          </Badge>
        );
      },
    },
    {
      id: "enabled",
      label: "Enabled",
      width: "5.5rem",
      align: "right",
      renderCell: (host) => {
        const publicRouteLocked = isGatewayPublicRoute(host, gatewayPublicUrl) && host.enabled;
        return (
          <div onClick={(e) => e.stopPropagation()}>
            {host.isSystem || publicRouteLocked ? (
              <span
                className="inline-flex"
                title={
                  publicRouteLocked ? "The Opfield public route must remain enabled" : undefined
                }
              >
                <Switch checked onChange={() => undefined} disabled />
              </span>
            ) : (
              <Switch
                checked={host.enabled}
                onChange={(v) => handleToggle(host.id, !v)}
                disabled={!canEditHost(host) || togglingIds.has(host.id)}
              />
            )}
          </div>
        );
      },
    },
    ...(canShowHostActions
      ? [
          {
            id: "actions",
            label: "Actions",
            width: "5rem",
            align: "right" as const,
            renderCell: (host: ProxyHost) =>
              canEditHost(host) ? (
                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Route actions">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => navigate(proxyHostRoute(host.slug))}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          togglingIds.has(host.id) ||
                          (isGatewayPublicRoute(host, gatewayPublicUrl) &&
                            !host.maintenanceEnabled) ||
                          (!host.maintenanceEnabled &&
                            (!host.enabled || host.type !== "proxy" || host.rawConfigEnabled))
                        }
                        onClick={() => handleMaintenance(host)}
                      >
                        {host.maintenanceEnabled ? "Disable Maintenance" : "Enable Maintenance"}
                      </DropdownMenuItem>
                      {(canMoveHost(host) || canMoveHostToApp(host)) && <DropdownMenuSeparator />}
                      {canMoveHost(host) && (
                        <DropdownMenuItem onClick={() => setMoveDialogHostId(host.id)}>
                          Move to folder...
                        </DropdownMenuItem>
                      )}
                      {canMoveHostToApp(host) && (
                        <DropdownMenuItem onClick={() => setMoveToAppHost(host)}>
                          Move to app...
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="h-full overflow-y-auto px-6 pt-6 pb-3 space-y-4">
        <PageHeader
          leading={<LiteModeBackButton />}
          title="Routes"
          description="Route incoming domain traffic to services"
          actions={
            <ResponsiveHeaderActions
              actions={[
                ...(canManageFolders
                  ? [
                      {
                        label: "Add Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: () => {
                          setCreateFolderParentId(null);
                          setCreateFolderOpen(true);
                        },
                      },
                    ]
                  : []),
                ...(canCreateProxyHost
                  ? [
                      {
                        label: "Add Route",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => void openCreateProxyHost(),
                      },
                    ]
                  : []),
              ]}
            >
              {canManageFolders && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreateFolderParentId(null);
                    setCreateFolderOpen(true);
                  }}
                >
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {canCreateProxyHost && (
                <Button onClick={() => void openCreateProxyHost()} pending={checkingCreateNodes}>
                  <Plus className="h-4 w-4" />
                  Add Route
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />
        <HubTabs />
        <HubTabPanel className="space-y-4">
          <ResourceListForm<FolderTreeNode, ProxyHost>
            columns={columns}
            search={{
              placeholder: "Search by domain name...",
              search: searchInput,
              onSearchChange: setSearchInput,
              onSearchSubmit: handleSearch,
              hasActiveFilters,
              onReset: () => {
                resetFilters();
                setSearchInput("");
              },
              filters: (
                <>
                  <div className="w-40">
                    <Select
                      value={filters.type}
                      onValueChange={(v) => setFilters({ type: v as ProxyHostType | "all" })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {typeOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-40">
                    <Select
                      value={filters.healthStatus}
                      onValueChange={(v) => setFilters({ healthStatus: v as HealthStatus | "all" })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {healthOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ),
            }}
            loading={isLoading}
            loadingLabel="Loading routes..."
            hasContent={shown.folders.length > 0 || shown.ungrouped.length > 0}
            emptyState={
              <EmptyState
                message="No routes."
                {...(canCreateProxyHost
                  ? { actionLabel: "Add one", onAction: () => void openCreateProxyHost() }
                  : {})}
                hasActiveFilters={hasActiveFilters}
                onReset={() => {
                  resetFilters();
                  setSearchInput("");
                }}
              />
            }
            dnd={{
              sensors,
              active: activeDrag,
              onDragStart: (event) => setActiveDrag(event.active),
              onDragEnd: handleDragEnd,
              onDragCancel: () => setActiveDrag(null),
            }}
            folders={{
              folders: shown.folders,
              ungroupedItems: shown.ungrouped,
              expandedFolderIds,
              getFolderId: (folder) => folder.id,
              getFolderName: (folder) => folder.name,
              getFolderChildren: (folder) => folder.children,
              getFolderItems: (folder) => folder.hosts,
              getFolderSortableId: (folder) => `folder-${folder.id}`,
              getFolderSortableData: (folder) => ({
                type: "folder",
                folderId: folder.id,
                folder,
              }),
              isFolderExpanded: (folder) =>
                expandedFolderIds.has(folder.id) || folder.id === defaultOpenId,
              canManageFolder,
              canReorderFolder: (folder) => canReorderFolders && canManageFolder(folder),
              canCreateSubfolder: (folder) => folder.depth < 2,
              onToggleFolder: (id) => {
                // The first fold saves the folder that started open, so it stays as the user saw it.
                if (defaultOpenId) toggleFolder(defaultOpenId);
                toggleFolder(id);
              },
              onRenameFolder: handleRenameFolder,
              onDeleteFolder: handleDeleteFolder,
              onRequestMoveFolder: setMoveFolderId,
              onRequestCreateSubfolder: (parentId) => {
                setCreateFolderParentId(parentId);
                setCreateFolderOpen(true);
              },
              ungroupedDroppable: {
                id: "folder-ungrouped",
                data: { type: "folder", folderId: rootFolderId },
                disabled: !canReorderFolders || !canManageFolderAt(rootFolderId),
              },
            }}
            items={{
              getItemId: (host) => host.id,
              getItemSortableId: (host) => host.id,
              getItemSortableData: (host) => ({ type: "host", host }),
              canViewItem: canViewHost,
              isItemDragDisabled: (host) =>
                !!host.app ||
                !canReorderFolders ||
                !canEditHost(host) ||
                !canManageFolderAt(host.folderId ?? null),
              onItemClick: (host) => navigate(proxyHostRoute(host.slug)),
            }}
          />
        </HubTabPanel>
      </div>

      <MoveToAppDialog
        open={moveToAppHost !== null}
        onOpenChange={(open) => {
          if (!open) setMoveToAppHost(null);
        }}
        members={shownMoveToAppHost ? [{ type: "route", id: shownMoveToAppHost.id }] : []}
        resourceLabel={shownMoveToAppHost?.domainNames[0] ?? "the route"}
        onMoved={() => void fetchGroupedHosts()}
      />

      {/* Move to folder dialog */}
      <MoveToFolderDialog
        open={moveDialogHostId !== null}
        onOpenChange={(open) => {
          if (!open) setMoveDialogHostId(null);
        }}
        folders={shown.root ? shown.folders : folders}
        {...(shown.root ? { root: { id: shown.root.id, label: shown.root.name } } : {})}
        currentFolderId={shownMoveDialogHostId ? findHostFolderId(shownMoveDialogHostId) : null}
        onMove={handleMoveHost}
        canMoveTo={canMoveHostTo}
        describeFolder={(folder) => `${folder.hosts.length} hosts`}
      />

      <MoveToFolderDialog
        open={moveFolderId !== null}
        onOpenChange={(open) => {
          if (!open) setMoveFolderId(null);
        }}
        title="Move Folder"
        description="Select where to move the folder. Its subfolders and routes move with it."
        folders={shown.folders}
        root={
          shown.root
            ? { id: shown.root.id, label: shown.root.name }
            : { id: null, label: "Top level" }
        }
        currentFolderId={
          (shownMoveFolderId ? findFolderTreeNode(folders, shownMoveFolderId)?.parentId : null) ??
          null
        }
        canMoveTo={(parentId) =>
          !!shownMoveFolderId &&
          canMoveFolderInto(folders, shownMoveFolderId, parentId) &&
          canManageFolderAt(parentId)
        }
        onMove={(parentId) => {
          if (shownMoveFolderId) void handleMoveFolder(shownMoveFolderId, parentId);
        }}
        describeFolder={(folder) => `${folder.hosts.length} hosts`}
      />

      <FolderCreateDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        title={createFolderParentId ? "Create Subfolder" : "Create Folder"}
        description={
          createFolderParentId
            ? "Enter a name for the new subfolder."
            : "Enter a name for the new folder."
        }
        onCreate={handleCreateFolder}
      />

      <CreateProxyHostDialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open && initialCreateDialogOpen) navigate("/routes", { replace: true });
        }}
        onSuccess={(_, host) => {
          fetchGroupedHosts();
          if (host) navigate(proxyHostRoute(host.slug));
        }}
      />
      <Dialog
        open={nginxNodeRequiredOpen}
        onOpenChange={(open) => {
          if (open) return;
          setNginxNodeRequiredOpen(false);
          if (initialCreateDialogOpen) navigate("/routes", { replace: true });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>No Ingress Nodes</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Routes must be deployed to an Ingress node. Add and connect an Ingress node first, then
            return here to create the route.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setNginxNodeRequiredOpen(false);
                if (initialCreateDialogOpen) navigate("/routes", { replace: true });
              }}
            >
              Close
            </Button>
            <Button asChild>
              <Link to="/nodes" onClick={() => setNginxNodeRequiredOpen(false)}>
                Open Nodes <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
