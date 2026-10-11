import { Download, HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
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
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { formatDisplayImageRef } from "@/lib/docker-image-ref";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { dockerContainerRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { canCreateInFolder } from "@/lib/scope-utils";
import { formatBytes, formatDateTime, formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { useDockerFolderStore } from "@/stores/docker-folders";
import type {
  DockerFolderTreeNode,
  DockerImage,
  DockerRegistry,
  Node,
  NodeAppearanceColor,
} from "@/types";
import { filterDockerImages } from "./docker-images-filter";
import {
  type DockerImageUsageContainer,
  normalizeDockerImageUsageContainers,
} from "./docker-images-usage";

interface DockerImageListItem extends DockerImage {
  _nodeId: string;
  _nodeSlug: string;
  _nodeName?: string;
  _nodeColor?: NodeAppearanceColor | null;
}

export function DockerImages({
  embedded,
  onPullRef,
  onCreateFolderRef,
  onRefreshRef,
  onPruneRef,
  fixedNodeId,
}: {
  embedded?: boolean;
  onPullRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
  onRefreshRef?: (fn: () => void) => void;
  onPruneRef?: (fn: () => void) => void;
  fixedNodeId?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const { images, selectedNodeId, setSelectedNode, fetchImages } = useDockerStore();
  const requestSnapshotRefresh = useDockerStore((s) => s.requestSnapshotRefresh);
  const isLoading = useDockerStore((s) => s.loading.images);
  const storeDockerNodes = useDockerStore((s) => s.dockerNodes);
  const dockerNodesLoaded = useDockerStore((s) => s.dockerNodesLoaded);
  const visibleNodeId = fixedNodeId ?? selectedNodeId;
  const imageFolders = useDockerFolderStore((s) => s.foldersByType.image);
  const pruneNodeId =
    visibleNodeId ?? (storeDockerNodes.length === 1 ? storeDockerNodes[0]?.id : null);
  const canFetchData = !!visibleNodeId || dockerNodesLoaded;

  const [dockerNodes, setDockerNodes] = useState<Node[]>([]);
  // The first list request; until it settles an empty list is not yet "no results".
  const [initialFetchDone, setInitialFetchDone] = useState(false);
  const [search, setSearch] = useState("");
  const [filterUsage, setFilterUsage] = useState("all");
  const [pruning, setPruning] = useState(false);
  const [removingImageId, setRemovingImageId] = useState<string | null>(null);
  const createFolderRef = useRef<(() => void) | null>(null);

  // Details dialog
  const [usageContainers, setUsageContainers] = useState<DockerImageUsageContainer[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const {
    open: detailsOpen,
    value: detailsImage,
    setValue: setDetailsImage,
    close: closeDetails,
    onOpenChange: onDetailsOpenChange,
  } = useDeferredDialogState<DockerImageListItem>();

  const loadUsageContainers = useCallback(
    async (imageTag: string, nodeId?: string, nodeSlug = "") => {
      const nid = nodeId || selectedNodeId;
      if (!nid) return;
      setUsageContainers([]);
      setUsageLoading(true);
      try {
        const containers = await api.listDockerContainers(nid);
        setUsageContainers(
          normalizeDockerImageUsageContainers(containers, imageTag, nid, nodeSlug)
        );
      } catch {
        setUsageContainers([]);
      } finally {
        setUsageLoading(false);
      }
    },
    [selectedNodeId]
  );

  // Pull dialog
  const [pullOpen, setPullOpen] = useState(false);
  const [pullNodeId, setPullNodeId] = useState<string>("");
  const openPull = useCallback(() => {
    setPullNodeId(selectedNodeId || "");
    setPullRef("");
    setPullRegistryId("");
    setPullFolderId("");
    setPullOpen(true);
  }, [selectedNodeId]);
  useEffect(() => {
    onPullRef?.(() => openPull());
  }, [onPullRef, openPull]);
  useEffect(() => {
    onRefreshRef?.(() => void requestSnapshotRefresh("images", visibleNodeId));
  }, [onRefreshRef, requestSnapshotRefresh, visibleNodeId]);
  const [pullRef, setPullRef] = useState("");
  const [pullRegistryId, setPullRegistryId] = useState<string>("");
  const [pullFolderId, setPullFolderId] = useState<string>("");
  const canPullHere = canCreateInFolder(
    user?.scopes ?? [],
    "docker:images:pull",
    pullFolderId || null,
    pullNodeId
  );
  const [pulling, setPulling] = useState(false);
  const [registries, setRegistries] = useState<DockerRegistry[]>([]);
  const folderList = useMemo(() => flattenFolders(imageFolders), [imageFolders]);

  const loadImagePageState = useCallback(async () => {
    try {
      const regs = await api.listDockerRegistries();
      setRegistries(regs.filter((registry) => registry.id !== "gateway-internal-registry"));
    } catch {}

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
        ["docker:images:view", "docker:images:pull"],
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
    void loadImagePageState();
  }, [loadImagePageState]);

  useEffect(() => {
    if (!canFetchData) return;
    void fetchImages(fixedNodeId, search).finally(() => setInitialFetchDone(true));
    const interval = setInterval(() => fetchImages(fixedNodeId, search), 30_000);
    return () => clearInterval(interval);
  }, [canFetchData, fetchImages, fixedNodeId, search]);

  useRealtime("docker.image.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (visibleNodeId && ev?.nodeId && ev.nodeId !== visibleNodeId) return;
    fetchImages(fixedNodeId, search);
  });
  useRealtime("docker.snapshot.changed", (payload) => {
    const ev = payload as { nodeId?: string; kind?: string };
    if (ev.kind !== "images" || (visibleNodeId && ev.nodeId && ev.nodeId !== visibleNodeId)) return;
    void fetchImages(fixedNodeId, search);
  });

  const filteredImages = useMemo(
    () => filterDockerImages(images, search, filterUsage),
    [images, search, filterUsage]
  );
  const truncatedListMeta = images.find((img) => img._listTruncated);
  const canManageSomeFolders = useCanManageSomeFolders("docker:folders:manage");
  const canManageFolders = !fixedNodeId && canManageSomeFolders;
  const usageColumns = useMemo<SimpleTableColumn<DockerImageUsageContainer>[]>(
    () => [
      {
        id: "container",
        header: "Container",
        cellClassName: "font-medium",
        render: (container) => container.name.replace(/^\//, ""),
      },
      {
        id: "id",
        header: "ID",
        cellClassName: "font-mono text-muted-foreground",
        render: (container) => container.id.slice(0, 12),
      },
      {
        id: "state",
        header: "State",
        align: "right",
        render: (container) => (
          <Badge variant={container.state === "running" ? "success" : "secondary"}>
            {container.state}
          </Badge>
        ),
      },
    ],
    []
  );

  const handleRemove = useCallback(
    async (imageId: string, tag: string, nodeId?: string) => {
      const nid = nodeId || selectedNodeId;
      if (!nid) return;
      const ok = await confirm({
        title: "Remove Image",
        description: `Remove "${tag}"? This may affect running containers that use this image.`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
      setRemovingImageId(imageId);
      try {
        await api.removeImage(nid, imageId);
        toast.success("Image removed");
        fetchImages(undefined, search);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove image");
      } finally {
        setRemovingImageId(null);
      }
    },
    [fetchImages, selectedNodeId, search]
  );

  const handlePrune = useCallback(async () => {
    const ok = await confirm({
      title: "Prune Dangling Images",
      description: "Remove dangling images from this node? Tagged unused images are preserved.",
      confirmLabel: "Prune",
    });
    if (!ok) return;
    setPruning(true);
    try {
      if (!pruneNodeId) {
        toast.error("Select a node to prune images");
        return;
      }
      const result = await api.pruneImages(pruneNodeId);
      const freed = result.spaceReclaimed ?? result.SpaceReclaimed;
      toast.success(
        freed ? `Pruned images, freed ${formatBytes(Number(freed))}` : "Pruned dangling images"
      );
      fetchImages(undefined, search);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Prune failed");
    } finally {
      setPruning(false);
    }
  }, [fetchImages, pruneNodeId, search]);
  useEffect(() => {
    onPruneRef?.(() => void handlePrune());
  }, [handlePrune, onPruneRef]);

  const openImageDetails = useCallback(
    (image: DockerImageListItem) => {
      const tags = image.repoTags ?? [];
      const rawTag = tags.length > 0 ? tags[0] : "<none>:<none>";
      setDetailsImage(image);
      void loadUsageContainers(rawTag, image._nodeId, image._nodeSlug);
    },
    [loadUsageContainers, setDetailsImage]
  );

  const closePull = useCallback(() => {
    setPullOpen(false);
  }, []);

  const handlePull = useCallback(async () => {
    if (pulling || !pullNodeId || !pullRef.trim()) return;
    if (!canPullHere) {
      toast.error("Select an authorized destination folder");
      return;
    }
    setPulling(true);
    try {
      await api.pullImage(
        pullNodeId,
        pullRef.trim(),
        pullRegistryId || undefined,
        pullFolderId || undefined
      );
      toast.success(`Pulling "${pullRef.trim()}" — check Tasks tab for progress`);
      closePull();
      useDockerStore.getState().invalidate("tasks");
      // Poll images to detect when pull completes
      setTimeout(() => fetchImages(undefined, search), 5000);
      setTimeout(() => fetchImages(undefined, search), 15000);
      setTimeout(() => fetchImages(undefined, search), 30000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to pull image");
    } finally {
      setPulling(false);
    }
  }, [
    closePull,
    fetchImages,
    pulling,
    pullFolderId,
    pullNodeId,
    pullRef,
    pullRegistryId,
    search,
    canPullHere,
  ]);

  const allImageColumns: ResourceListColumn<DockerImageListItem>[] = useMemo(
    () => [
      {
        id: "tag",
        label: "Repository:Tag",
        width: "minmax(0, 1.45fr)",
        renderCell: (img) => {
          const tags = img.repoTags ?? [];
          const tag = tags.length > 0 ? formatDisplayImageRef(tags[0]) : "<none>:<none>";
          return (
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-muted shrink-0">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <TruncateStart text={tag} className="text-sm font-medium" />
                {tags.length > 1 && (
                  <p className="text-xs text-muted-foreground truncate">
                    +{tags.length - 1} more tag{tags.length > 2 ? "s" : ""}
                  </p>
                )}
              </div>
            </div>
          );
        },
      },
      {
        id: "node",
        label: "Node",
        width: "minmax(0, 1.15fr)",
        renderCell: (img) => (
          <div className="min-w-0">
            <Badge variant="secondary" className={nodeBadgeClassName((img as any)._nodeColor)}>
              <span className="truncate">{(img as any)._nodeName || "-"}</span>
            </Badge>
          </div>
        ),
      },
      {
        id: "usage",
        label: "Usage",
        width: "6.5rem",
        renderCell: (img) => {
          if (img.availability === "unavailable") {
            return (
              <Badge variant="secondary" className="w-fit">
                Unavailable
              </Badge>
            );
          }
          const containerCount = img.containers ?? -1;
          const isUsed = containerCount > 0;
          return isUsed ? (
            <Badge variant="success" className="w-fit">
              In use
            </Badge>
          ) : (
            <Badge variant="secondary" className="w-fit">
              {containerCount === 0 ? "Unused" : "Unknown"}
            </Badge>
          );
        },
      },
      {
        id: "size",
        label: "Size",
        width: "6.25rem",
        renderCell: (img) => {
          const size = img.size ?? 0;
          return (
            <Badge variant="secondary" className="font-mono">
              {formatBytes(size)}
            </Badge>
          );
        },
      },
      {
        id: "created",
        label: "Created",
        width: "8rem",
        align: "right" as const,
        renderCell: (img) => (
          <RelativeTime
            value={img.created ? img.created * 1000 : null}
            className="text-sm text-muted-foreground"
          />
        ),
      },
      {
        id: "actions",
        label: "Actions",
        width: "5.75rem",
        align: "right" as const,
        renderCell: (img) => {
          const tags = img.repoTags ?? [];
          const tag = tags.length > 0 ? tags[0] : "<none>:<none>";
          const id = img.id ?? "";
          const containerCount = img.containers ?? -1;
          const canDelete = containerCount === 0;
          return (
            <div
              className="flex items-center justify-end pr-1"
              onClick={(e) => e.stopPropagation()}
            >
              {(hasScope("docker:images:delete") ||
                hasScopedAccess(
                  `docker:images:delete:${img._nodeId}/${img.scopeResourceId ?? img.id}`
                )) &&
                canDelete &&
                img.availability !== "unavailable" && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    pending={removingImageId === id}
                    onClick={() => handleRemove(id, tag, img._nodeId)}
                    title="Remove"
                  >
                    {removingImageId !== id && <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                )}
            </div>
          );
        },
      },
    ],
    [hasScope, handleRemove, hasScopedAccess, removingImageId]
  );
  const imageColumns = allImageColumns.filter((c) => {
    if (fixedNodeId && c.id === "node") return false;
    if (!hasScopedAccess("docker:images:delete") && c.id === "actions") return false;
    return true;
  });

  const content = (
    <>
      {/* Header — hidden in embedded mode */}
      {!embedded && (
        <PageHeader
          title="Docker Images"
          description="Manage Docker images across your nodes"
          badges={
            !isLoading && visibleNodeId ? (
              <Badge variant="secondary" size="inline">
                {images.length}
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
                        onClick: () => requestSnapshotRefresh("images", visibleNodeId),
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
                      ...(hasScope("docker:images:delete") ||
                      hasScope(`docker:images:delete:${selectedNodeId}`)
                        ? [
                            {
                              label: "Prune Dangling",
                              icon: <Trash2 className="h-4 w-4" />,
                              onClick: handlePrune,
                              disabled: pruning,
                            },
                          ]
                        : []),
                      ...(hasScope("docker:images:pull") || hasScopedAccess("docker:images:pull")
                        ? [
                            {
                              label: "Pull Image",
                              icon: <Download className="h-4 w-4" />,
                              onClick: () => openPull(),
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
                    onClick={() => requestSnapshotRefresh("images", visibleNodeId)}
                    disabled={isLoading}
                  />
                  {canManageFolders && (
                    <Button variant="outline" onClick={() => createFolderRef.current?.()}>
                      New Folder
                    </Button>
                  )}
                  {(hasScope("docker:images:delete") ||
                    hasScope(`docker:images:delete:${selectedNodeId}`)) && (
                    <Button variant="outline" onClick={handlePrune} pending={pruning}>
                      <Trash2 className="h-4 w-4 mr-1" />
                      Prune Dangling
                    </Button>
                  )}
                  {(hasScope("docker:images:pull") || hasScopedAccess("docker:images:pull")) && (
                    <Button onClick={() => openPull()}>
                      <Download className="h-4 w-4 mr-1" />
                      Pull Image
                    </Button>
                  )}
                </>
              )}
            </ResponsiveHeaderActions>
          }
        />
      )}

      <DockerFolderedResourceList<DockerImageListItem>
        resourceType="image"
        resources={filteredImages as DockerImageListItem[]}
        columns={imageColumns}
        search={{
          initialFiltersOpen: new URLSearchParams(location.search).get("filters") === "1",
          search,
          onSearchChange: setSearch,
          placeholder: "Search images by repository or tag...",
          hasActiveFilters: search !== "" || filterUsage !== "all" || !!selectedNodeId,
          onReset: () => {
            setSearch("");
            setFilterUsage("all");
            setSelectedNode(null);
          },
          filters: (
            <div className="flex items-center gap-3">
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
              <Select value={filterUsage} onValueChange={setFilterUsage}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Usage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All images</SelectItem>
                  <SelectItem value="used">In use</SelectItem>
                  <SelectItem value="unused">Unused</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ),
        }}
        afterSearch={
          truncatedListMeta ? (
            <Notice
              tone="warning"
              role="status"
              title={`Showing the first ${truncatedListMeta._listLimit ?? images.length} of ${truncatedListMeta._listTotal ?? "many"} images`}
            >
              Narrow the node or search filters for more specific data.
            </Notice>
          ) : null
        }
        loading={images.length === 0 && (!initialFetchDone || isLoading)}
        loadingLabel="Loading images..."
        emptyState={
          <EmptyState
            message="No images found."
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
          />
        }
        minWidth={fixedNodeId ? "760px" : "900px"}
        fixedNodeId={fixedNodeId}
        canManageFolders={canManageFolders}
        getResourceKey={(img) => img.id}
        getResourceLabel={(img) => {
          const tags = (img as any).repoTags ?? (img as any).RepoTags ?? [];
          return tags.length > 0 ? tags[0] : img.id;
        }}
        onItemClick={openImageDetails}
        onRefresh={() => fetchImages(undefined, search)}
        onCreateFolderRef={(fn) => {
          createFolderRef.current = fn;
          onCreateFolderRef?.(fn);
        }}
      />

      {/* Pull Image Dialog */}
      <Dialog open={pullOpen} onOpenChange={closePull}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pull Image</DialogTitle>
            <DialogDescription>Pull a Docker image from a registry.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Node */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Node <span className="text-destructive">*</span>
              </label>
              <Select
                value={pullNodeId}
                onValueChange={(v) => {
                  setPullNodeId(v);
                  setPullRegistryId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a node" />
                </SelectTrigger>
                <SelectContent>
                  {(useDockerStore.getState().dockerNodes.length > 0
                    ? useDockerStore.getState().dockerNodes
                    : dockerNodes
                  ).map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.displayName || n.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Registry */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Registry</label>
              <Select
                value={pullRegistryId || "__default__"}
                onValueChange={(v) => setPullRegistryId(v === "__default__" ? "" : v)}
                disabled={!pullNodeId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={pullNodeId ? "Docker Hub" : "Select a node first"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Docker Hub</SelectItem>
                  {registries
                    .filter((r) => r.scope === "global" || r.nodeId === pullNodeId)
                    .map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name} ({r.url}){r.scope === "node" ? " · this node" : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* Image */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Destination folder</label>
              <Select
                value={
                  pullFolderId ||
                  (canCreateInFolder(user?.scopes ?? [], "docker:images:pull", null, pullNodeId)
                    ? "__none__"
                    : "")
                }
                onValueChange={(value) => setPullFolderId(value === "__none__" ? "" : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a folder" />
                </SelectTrigger>
                <SelectContent>
                  {canCreateInFolder(
                    user?.scopes ?? [],
                    "docker:images:pull",
                    null,
                    pullNodeId
                  ) && <SelectItem value="__none__">No folder</SelectItem>}
                  {folderList
                    .filter(
                      (folder) =>
                        !folder.isSystem &&
                        canCreateInFolder(
                          user?.scopes ?? [],
                          "docker:images:pull",
                          folder.id,
                          pullNodeId
                        )
                    )
                    .map((folder) => (
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
                Image <span className="text-destructive">*</span>
              </label>
              <Input
                value={pullRef}
                onChange={(e) => setPullRef(e.target.value)}
                placeholder="nginx:latest"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handlePull();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePull}>
              Cancel
            </Button>
            <Button
              onClick={handlePull}
              pending={pulling}
              disabled={!pullRef.trim() || !pullNodeId || !canPullHere}
            >
              Pull
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Details Dialog */}
      <Dialog open={detailsOpen} onOpenChange={onDetailsOpenChange}>
        <DialogContent className="max-w-full sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Image Details</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs break-all">
                {detailsImage?.repoTags?.[0] ?? detailsImage?.id ?? ""}
              </span>
            </DialogDescription>
          </DialogHeader>
          {detailsImage ? (
            <div className="min-w-0 space-y-4">
              <div className="min-w-0 divide-y divide-border overflow-hidden border border-border bg-card">
                {[
                  [
                    "Repository tag",
                    formatDisplayImageRef(detailsImage.repoTags?.[0] ?? "<none>:<none>"),
                  ],
                  ["Image ID", detailsImage.id],
                  ["Size", formatBytes(detailsImage.size ?? 0)],
                  [
                    "Created",
                    formatRelativeDate(detailsImage.created ? detailsImage.created * 1000 : null),
                    // The exact moment on hover, as `RelativeTime` shows it elsewhere.
                    detailsImage.created ? formatDateTime(detailsImage.created * 1000) : undefined,
                  ],
                  ["Node", detailsImage._nodeName || detailsImage._nodeId],
                  [
                    "Usage",
                    detailsImage.containers == null || detailsImage.containers < 0
                      ? "Unknown"
                      : `${detailsImage.containers} containers`,
                  ],
                  ["Tags", detailsImage.repoTags?.map(formatDisplayImageRef).join(", ") || "-"],
                  ["Digests", detailsImage.repoDigests?.join(", ") || "-"],
                ].map(([label, value, title]) => (
                  <div
                    key={label}
                    className="grid min-w-0 grid-cols-[minmax(96px,max-content)_minmax(0,1fr)] items-center gap-4 px-4 py-3"
                  >
                    <span className="text-sm text-muted-foreground">{label}</span>
                    <span
                      className="min-w-0 truncate text-right font-mono text-sm"
                      title={title ?? value}
                    >
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <PanelShell title="Containers Using This Image">
                <SimpleTable
                  columns={usageColumns}
                  rows={usageContainers}
                  getRowKey={(container) => container.id}
                  loading={usageLoading}
                  emptyMessage="No containers found using this image."
                  onRowClick={(container) => {
                    closeDetails();
                    const nodeSlug =
                      storeDockerNodes.find((node) => node.id === container.nodeId)?.slug ||
                      container.nodeSlug;
                    navigate(dockerContainerRoute(nodeSlug, container.name.replace(/^\//, "")), {
                      state: createReturnNavigationState(location),
                    });
                  }}
                />
              </PanelShell>
            </div>
          ) : null}
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
