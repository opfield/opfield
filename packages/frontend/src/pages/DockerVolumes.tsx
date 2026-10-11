import { ArrowRightLeft, Database, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { DockerFolderedResourceList } from "@/components/docker/DockerFolderedResourceList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TruncateStart } from "@/components/ui/truncate-start";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { canCreateDockerResourceOnNode, loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { canEditDockerVolume } from "@/lib/docker-volume-access";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { dockerVolumeRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { canCreateInFolder } from "@/lib/scope-utils";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { useDockerFolderStore } from "@/stores/docker-folders";
import { handleLicenseApiError, requireMinimumLicensePlan } from "@/stores/license-paywall";
import type { DockerFolderTreeNode, DockerVolume, Node, NodeAppearanceColor } from "@/types";

interface DockerVolumeListItem extends DockerVolume {
  _nodeId: string;
  _nodeSlug: string;
  _nodeName?: string;
  _nodeColor?: NodeAppearanceColor | null;
}

export function DockerVolumes({
  embedded,
  onCreateRef,
  onCreateFolderRef,
  onRefreshRef,
  fixedNodeId,
}: {
  embedded?: boolean;
  onCreateRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
  onRefreshRef?: (fn: () => void) => void;
  fixedNodeId?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const { volumes, selectedNodeId, setSelectedNode, fetchVolumes } = useDockerStore();
  const requestSnapshotRefresh = useDockerStore((s) => s.requestSnapshotRefresh);
  const isLoading = useDockerStore((s) => s.loading.volumes);
  const storeDockerNodes = useDockerStore((s) => s.dockerNodes);
  const dockerNodesLoaded = useDockerStore((s) => s.dockerNodesLoaded);
  const visibleNodeId = fixedNodeId ?? selectedNodeId;
  const volumeFolders = useDockerFolderStore((s) => s.foldersByType.volume);
  const canFetchData = !!visibleNodeId || dockerNodesLoaded;

  const [dockerNodes, setDockerNodes] = useState<Node[]>([]);
  // The first list request; until it settles an empty list is not yet "no results".
  const [initialFetchDone, setInitialFetchDone] = useState(false);
  const [search, setSearch] = useState("");
  const createFolderRef = useRef<(() => void) | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createNodeId, setCreateNodeId] = useState<string>("");
  const openCreate = useCallback(() => {
    setCreateNodeId(fixedNodeId || selectedNodeId || "");
    setCreateName("");
    setCreateStorageKind("regular");
    setCreateCapacityGb("10");
    setCreateFolderId("");
    setCreateOpen(true);
  }, [fixedNodeId, selectedNodeId]);
  useEffect(() => {
    onCreateRef?.(() => openCreate());
  }, [onCreateRef, openCreate]);
  useEffect(() => {
    onRefreshRef?.(() => void requestSnapshotRefresh("volumes", visibleNodeId));
  }, [onRefreshRef, requestSnapshotRefresh, visibleNodeId]);
  const [createName, setCreateName] = useState("");
  const [createStorageKind, setCreateStorageKind] = useState<"regular" | "disk-image">("regular");
  const [createCapacityGb, setCreateCapacityGb] = useState("10");
  const [createFolderId, setCreateFolderId] = useState("");
  const canCreateHere = canCreateInFolder(
    user?.scopes ?? [],
    "docker:volumes:create",
    createFolderId || null,
    createNodeId
  );
  const [creating, setCreating] = useState(false);
  const [pendingVolumeAction, setPendingVolumeAction] = useState<string | null>(null);
  const folderList = useMemo(() => flattenFolders(volumeFolders), [volumeFolders]);

  const loadVolumeNodes = useCallback(async () => {
    if (embedded && !fixedNodeId) {
      return;
    }
    if (fixedNodeId) {
      setSelectedNode(fixedNodeId);
      return;
    }

    try {
      const onlineNodes = await loadVisibleDockerNodes(
        user?.scopes ?? [],
        ["docker:volumes:view", "docker:volumes:create"],
        false
      );
      setDockerNodes(onlineNodes);
      useDockerStore.getState().setDockerNodes(onlineNodes);
    } catch {
      toast.error("Failed to load Docker nodes");
      setInitialFetchDone(true);
    }
  }, [embedded, fixedNodeId, setSelectedNode, user?.scopes]);

  useEffect(() => {
    void loadVolumeNodes();
  }, [loadVolumeNodes]);

  useEffect(() => {
    if (!canFetchData) return;
    void fetchVolumes(fixedNodeId, search).finally(() => setInitialFetchDone(true));
    const interval = setInterval(() => fetchVolumes(fixedNodeId, search), 30_000);
    return () => clearInterval(interval);
  }, [canFetchData, fetchVolumes, fixedNodeId, search]);

  useRealtime("docker.volume.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (visibleNodeId && ev?.nodeId && ev.nodeId !== visibleNodeId) return;
    fetchVolumes(fixedNodeId, search);
  });
  useRealtime("docker.snapshot.changed", (payload) => {
    const ev = payload as { nodeId?: string; kind?: string };
    if (ev.kind !== "volumes" || (visibleNodeId && ev.nodeId && ev.nodeId !== visibleNodeId))
      return;
    void fetchVolumes(fixedNodeId, search);
  });

  const filteredVolumes = useMemo(() => {
    const sorted = [...volumes].sort((a, b) => a.name.localeCompare(b.name));
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(
      (v) => v.name.toLowerCase().includes(q) || v.driver.toLowerCase().includes(q)
    );
  }, [volumes, search]);
  const truncatedListMeta = volumes.find((volume) => volume._listTruncated);
  const canManageSomeFolders = useCanManageSomeFolders("docker:folders:manage");
  const canManageFolders = !fixedNodeId && canManageSomeFolders;

  const handleRemove = useCallback(
    async (name: string, nodeId?: string) => {
      const nid = nodeId || selectedNodeId;
      if (!nid) return;
      const ok = await confirm({
        title: "Remove Volume",
        description: `Remove volume "${name}"? Any data stored in this volume will be permanently lost.`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
      setPendingVolumeAction(`remove:${nid}/${name}`);
      try {
        await api.removeVolume(nid, name);
        toast.success("Volume removed");
        fetchVolumes(undefined, search);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove volume");
      } finally {
        setPendingVolumeAction(null);
      }
    },
    [fetchVolumes, selectedNodeId, search]
  );

  const handleCreate = async () => {
    if (creating || !createNodeId || !createName.trim()) return;
    if (!canCreateHere) {
      toast.error("Select an authorized destination folder");
      return;
    }
    if (
      createStorageKind === "disk-image" &&
      !requireMinimumLicensePlan("personal", "Disk image volumes")
    ) {
      return;
    }
    setCreating(true);
    try {
      await api.createVolume(createNodeId, {
        name: createName.trim(),
        storageKind: createStorageKind,
        ...(createStorageKind === "disk-image"
          ? { capacityBytes: Number(createCapacityGb) * 1024 ** 3 }
          : {}),
        folderId: createFolderId || undefined,
      });
      toast.success("Volume created");
      closeCreate();
      fetchVolumes(undefined, search);
    } catch (err) {
      if (!handleLicenseApiError(err, "Disk image volumes")) {
        toast.error(err instanceof Error ? err.message : "Failed to create volume");
      }
    } finally {
      setCreating(false);
    }
  };

  const closeCreate = () => {
    setCreateOpen(false);
  };

  const handleAdopt = useCallback(
    async (name: string, nodeId: string) => {
      setPendingVolumeAction(`adopt:${nodeId}/${name}`);
      try {
        await api.adoptVolume(nodeId, name);
        toast.success("Volume migrated to Gateway management");
        await fetchVolumes(undefined, search);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to migrate volume");
      } finally {
        setPendingVolumeAction(null);
      }
    },
    [fetchVolumes, search]
  );

  // Only nodes the backend accepts a volume on, for some destination this user may pick.
  const createNodes = (
    useDockerStore.getState().dockerNodes.length > 0
      ? useDockerStore.getState().dockerNodes
      : dockerNodes
  ).filter((node) =>
    canCreateDockerResourceOnNode(user?.scopes ?? [], "docker:volumes:create", node.id)
  );
  const selectedNode = createNodes.find((n) => n.id === createNodeId);
  const selectedNodeCapabilities = selectedNode?.capabilities as
    | Record<string, unknown>
    | undefined;
  const advertisedNodeCapabilities = Array.isArray(selectedNodeCapabilities?.capabilities)
    ? selectedNodeCapabilities.capabilities
    : [];
  const supportsDiskImages = Boolean(
    selectedNodeCapabilities?.dockerVolumeStorageImagesV1 === true ||
      selectedNodeCapabilities?.docker_volume_storage_images_v1 === true ||
      advertisedNodeCapabilities.includes("docker_volume_storage_images_v1")
  );
  // A docker-daemon running without root cannot create disk-image volumes; say so instead of a generic refusal.
  const nodeRunsWithoutRoot = Boolean(
    selectedNodeCapabilities?.dockerDaemonNonRootV1 === true ||
      advertisedNodeCapabilities.includes("docker_daemon_non_root_v1")
  );
  const parsedCreateCapacityGb = Number(createCapacityGb);
  const createCapacityValid =
    Number.isInteger(parsedCreateCapacityGb) && parsedCreateCapacityGb >= 1;

  useEffect(() => {
    if (createOpen && !createNodeId && createNodes.length === 1) {
      setCreateNodeId(createNodes[0].id);
    }
  }, [createNodeId, createNodes, createOpen]);

  // Same destination rules as POST /nodes/:nodeId/volumes. A folder-only creator is never offered the
  // root, so preselect their only folder instead of leaving the picker empty.
  const canCreateVolumeAtRoot = canCreateInFolder(
    user?.scopes ?? [],
    "docker:volumes:create",
    null,
    createNodeId
  );
  const createVolumeFolderOptions = useMemo(
    () =>
      folderList.filter(
        (folder) =>
          !folder.isSystem &&
          canCreateInFolder(user?.scopes ?? [], "docker:volumes:create", folder.id, createNodeId)
      ),
    [createNodeId, folderList, user?.scopes]
  );
  useEffect(() => {
    if (
      createOpen &&
      !createFolderId &&
      !canCreateVolumeAtRoot &&
      createVolumeFolderOptions.length === 1
    ) {
      setCreateFolderId(createVolumeFolderOptions[0].id);
    }
  }, [canCreateVolumeAtRoot, createFolderId, createOpen, createVolumeFolderOptions]);

  useEffect(() => {
    if (createStorageKind === "disk-image" && !supportsDiskImages) {
      setCreateStorageKind("regular");
    }
  }, [createStorageKind, supportsDiskImages]);

  const allVolumeColumns: ResourceListColumn<DockerVolumeListItem>[] = useMemo(
    () => [
      {
        id: "name",
        label: "Name",
        width: "minmax(0, 1.35fr)",
        renderCell: (v) => (
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-muted shrink-0">
              <Database className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <TruncateStart text={v.name} className="text-sm font-medium" />
                {v.managementState === "legacy" && (
                  <Badge variant="warning" size="inline">
                    Legacy
                  </Badge>
                )}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: "driver",
        label: "Driver",
        width: "7rem",
        renderCell: (v) => <Badge variant="secondary">{v.driver}</Badge>,
      },
      {
        id: "node",
        label: "Node",
        width: "minmax(0, 1.15fr)",
        renderCell: (v) => (
          <div className="min-w-0">
            <Badge variant="secondary" className={nodeBadgeClassName((v as any)._nodeColor)}>
              <span className="truncate">{(v as any)._nodeName || "-"}</span>
            </Badge>
          </div>
        ),
      },
      {
        id: "usage",
        label: "Usage",
        width: "6.5rem",
        renderCell: (v) => {
          if (v.availability === "unavailable") {
            return (
              <Badge variant="secondary" className="w-fit">
                Unavailable
              </Badge>
            );
          }
          const usedBy: string[] = (v as any).usedBy ?? (v as any).UsedBy ?? [];
          const usedByCount = (v as any).usedByCount ?? usedBy.length;
          const isUsed = usedByCount > 0;
          return isUsed ? (
            <Badge variant="success" className="w-fit">
              In use
            </Badge>
          ) : (
            <Badge variant="secondary" className="w-fit">
              Unused
            </Badge>
          );
        },
      },
      {
        id: "size",
        label: "Size",
        width: "7rem",
        align: "right" as const,
        renderCell: (v) => (
          <span className="text-sm text-muted-foreground">
            {typeof v.usedBytes === "number" ? formatBytes(v.usedBytes) : "—"}
          </span>
        ),
      },
      {
        id: "created",
        label: "Created",
        width: "8rem",
        align: "right" as const,
        renderCell: (v) => (
          <RelativeTime value={v.createdAt} className="text-sm text-muted-foreground" />
        ),
      },
      {
        id: "actions",
        label: "Actions",
        width: "9rem",
        align: "right" as const,
        renderCell: (v) => {
          const usedBy: string[] = (v as any).usedBy ?? (v as any).UsedBy ?? [];
          const usedByCount = (v as any).usedByCount ?? usedBy.length;
          const isUsed = usedByCount > 0;
          return (
            <div
              className="flex items-center justify-end pr-1"
              onClick={(e) => e.stopPropagation()}
            >
              {(hasScope("docker:volumes:delete") ||
                hasScopedAccess(
                  `docker:volumes:delete:${(v as any)._nodeId}/${v.scopeResourceId ?? v.name}`
                )) &&
                !isUsed &&
                v.availability !== "unavailable" && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    pending={pendingVolumeAction === `remove:${(v as any)._nodeId}/${v.name}`}
                    onClick={() => handleRemove(v.name, (v as any)._nodeId)}
                    title="Remove"
                  >
                    {pendingVolumeAction !== `remove:${(v as any)._nodeId}/${v.name}` && (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              {v.managementState === "legacy" &&
                v.adoptable &&
                canEditDockerVolume(hasScope, (v as any)._nodeId, v.scopeResourceId ?? v.name) && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    pending={pendingVolumeAction === `adopt:${(v as any)._nodeId}/${v.name}`}
                    onClick={() => handleAdopt(v.name, (v as any)._nodeId)}
                    title="Migrate to Gateway management"
                    aria-label="Migrate to Gateway management"
                  >
                    {pendingVolumeAction !== `adopt:${(v as any)._nodeId}/${v.name}` && (
                      <ArrowRightLeft />
                    )}
                  </Button>
                )}
            </div>
          );
        },
      },
    ],
    [handleAdopt, hasScope, handleRemove, hasScopedAccess, pendingVolumeAction]
  );
  const volumeColumns = allVolumeColumns.filter((c) => {
    if (fixedNodeId && c.id === "node") return false;
    if (
      !hasScopedAccess("docker:volumes:delete") &&
      !hasScopedAccess("docker:volumes:edit") &&
      !hasScopedAccess("docker:volumes:create") &&
      c.id === "actions"
    )
      return false;
    return true;
  });

  const content = (
    <>
      {/* Header — hidden in embedded mode */}
      {!embedded && (
        <PageHeader
          title="Docker Volumes"
          description="Manage Docker volumes across your nodes"
          badges={
            !isLoading && visibleNodeId ? (
              <Badge variant="secondary" size="inline">
                {volumes.length}
              </Badge>
            ) : null
          }
          actions={
            <ResponsiveHeaderActions
              actions={
                selectedNodeId
                  ? [
                      {
                        label: "Refresh",
                        icon: <RefreshCw className="h-4 w-4" />,
                        onClick: () => requestSnapshotRefresh("volumes", visibleNodeId),
                        disabled: isLoading,
                      },
                      ...(canManageFolders
                        ? [
                            {
                              label: "New Folder",
                              onClick: () => createFolderRef.current?.(),
                            },
                          ]
                        : []),
                      ...(hasScope("docker:volumes:create") ||
                      hasScopedAccess("docker:volumes:create")
                        ? [
                            {
                              label: "Create Volume",
                              icon: <Plus className="h-4 w-4" />,
                              onClick: () => openCreate(),
                            },
                          ]
                        : []),
                    ]
                  : []
              }
            >
              {selectedNodeId && (
                <>
                  <RefreshButton
                    onClick={() => requestSnapshotRefresh("volumes", visibleNodeId)}
                    disabled={isLoading}
                  />
                  {canManageFolders && (
                    <Button variant="outline" onClick={() => createFolderRef.current?.()}>
                      New Folder
                    </Button>
                  )}
                  {(hasScope("docker:volumes:create") ||
                    hasScopedAccess("docker:volumes:create")) && (
                    <Button onClick={() => openCreate()}>
                      <Plus className="h-4 w-4 mr-1" />
                      Create Volume
                    </Button>
                  )}
                </>
              )}
            </ResponsiveHeaderActions>
          }
        />
      )}

      <DockerFolderedResourceList<DockerVolumeListItem>
        resourceType="volume"
        resources={filteredVolumes as DockerVolumeListItem[]}
        columns={volumeColumns}
        search={{
          initialFiltersOpen: new URLSearchParams(location.search).get("filters") === "1",
          search,
          onSearchChange: setSearch,
          placeholder: "Search volumes by name...",
          hasActiveFilters: search !== "" || !!selectedNodeId,
          onReset: () => {
            setSearch("");
            setSelectedNode(null);
          },
          filters: (
            <Select
              value={selectedNodeId ?? "__all__"}
              onValueChange={(v) => setSelectedNode(v === "__all__" ? null : v)}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All nodes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All nodes</SelectItem>
                {(embedded ? storeDockerNodes : dockerNodes).map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.displayName || n.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        }}
        afterSearch={
          truncatedListMeta ? (
            <Notice
              tone="warning"
              role="status"
              title={`Showing the first ${truncatedListMeta._listLimit ?? volumes.length} of ${truncatedListMeta._listTotal ?? "many"} volumes`}
            >
              Narrow the node or search filters for more specific data.
            </Notice>
          ) : null
        }
        loading={volumes.length === 0 && (!initialFetchDone || isLoading)}
        loadingLabel="Loading volumes..."
        emptyState={
          <EmptyState
            message="No volumes found."
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
            actionLabel={
              hasScope("docker:volumes:create") || hasScopedAccess("docker:volumes:create")
                ? "Create a volume"
                : undefined
            }
            onAction={
              hasScope("docker:volumes:create") || hasScopedAccess("docker:volumes:create")
                ? () => openCreate()
                : undefined
            }
          />
        }
        minWidth={fixedNodeId ? "720px" : "860px"}
        fixedNodeId={fixedNodeId}
        canManageFolders={canManageFolders}
        getResourceKey={(volume) => volume.name}
        getResourceLabel={(volume) => volume.name}
        onItemClick={(volume) =>
          navigate(dockerVolumeRoute(volume._nodeSlug, volume.name), {
            state: createReturnNavigationState(location),
          })
        }
        onRefresh={() => fetchVolumes(undefined, search)}
        onCreateFolderRef={(fn) => {
          createFolderRef.current = fn;
          onCreateFolderRef?.(fn);
        }}
      />

      {/* Create Volume Dialog */}
      <Dialog open={createOpen} onOpenChange={closeCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Volume</DialogTitle>
            <DialogDescription>
              Create a new volume on{" "}
              {selectedNode?.displayName || selectedNode?.hostname || "the selected node"}.
            </DialogDescription>
          </DialogHeader>
          <AnimatedHeight>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Destination folder</label>
                <Select
                  value={createFolderId || (canCreateVolumeAtRoot ? "__none__" : "")}
                  onValueChange={(value) => setCreateFolderId(value === "__none__" ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a folder" />
                  </SelectTrigger>
                  <SelectContent>
                    {canCreateVolumeAtRoot && <SelectItem value="__none__">No folder</SelectItem>}
                    {createVolumeFolderOptions.map((folder) => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {"— ".repeat(folder.depth)}
                        {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  Node <span className="text-destructive">*</span>
                </label>
                <Select value={createNodeId} onValueChange={setCreateNodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a node" />
                  </SelectTrigger>
                  <SelectContent>
                    {createNodes.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.displayName || n.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Volume type</label>
                <Select
                  value={createStorageKind}
                  onValueChange={(value) => setCreateStorageKind(value as "regular" | "disk-image")}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {createStorageKind === "disk-image" ? "Disk image" : "Regular volume"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      value="regular"
                      description="Standard Docker storage using shared node capacity."
                    >
                      Regular volume
                    </SelectItem>
                    <SelectItem
                      value="disk-image"
                      disabled={!supportsDiskImages}
                      description={
                        !selectedNode
                          ? "Select a node to check support."
                          : supportsDiskImages
                            ? "Fixed-capacity ext4 storage that can be expanded later."
                            : nodeRunsWithoutRoot
                              ? "Unavailable: disk-image volumes need docker-daemon to run as root, and this node runs it as a non-root user."
                              : "The selected node did not advertise disk-image support."
                      }
                    >
                      Disk image
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {createStorageKind === "disk-image" && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="volume-capacity-gb">
                    Capacity, GB <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="volume-capacity-gb"
                    type="number"
                    min={1}
                    step={1}
                    value={createCapacityGb}
                    onChange={(event) => setCreateCapacityGb(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Allocated as a fixed-size ext4 disk image.
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  Name <span className="text-destructive">*</span>
                </label>
                <Input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="my-volume"
                />
              </div>
            </div>
          </AnimatedHeight>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreate}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              pending={creating}
              disabled={
                !createName.trim() ||
                !createNodeId ||
                (createStorageKind === "disk-image" &&
                  (!supportsDiskImages || !createCapacityValid))
              }
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return <div className="flex flex-col flex-1 min-h-0 space-y-4">{content}</div>;

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">{content}</div>
    </PageTransition>
  );
}

function flattenFolders(folders: DockerFolderTreeNode[]): DockerFolderTreeNode[] {
  return folders.flatMap((folder) => [folder, ...flattenFolders(folder.children)]);
}
