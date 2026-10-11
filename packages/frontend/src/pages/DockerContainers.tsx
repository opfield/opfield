import { type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  ArrowRight,
  Box,
  GitBranch,
  MoreVertical,
  Play,
  Plus,
  RefreshCw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AppMemberBadge } from "@/components/apps/AppMembership";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderCreateDialog } from "@/components/common/FolderCreateDialog";
import { MoveToFolderDialog } from "@/components/common/MoveToFolderDialog";
import { Notice } from "@/components/common/Notice";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResourceListForm } from "@/components/common/ResourceListForm";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import {
  applyRootFolderView,
  canMoveFolderInto,
  defaultOpenFolderId,
} from "@/components/common/resource-list/folder-view";
import { DockerMoveToFolderDialog } from "@/components/docker/DockerMoveToFolderDialog";
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
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TruncateStart } from "@/components/ui/truncate-start";
import { useCanManageSomeFolders, useFolderAccess } from "@/hooks/use-folder-access";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useRealtime } from "@/hooks/use-realtime";
import { matchesDockerContainerStatus } from "@/lib/docker-container-filters";
import { formatDisplayImageRef } from "@/lib/docker-image-ref";
import { canCreateDockerResourceOnNode, loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { collectFolderTreeIds, findFolderTreeNode } from "@/lib/folder-tree";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { dockerContainerRoute, dockerDeploymentRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { isPendingContainerOperation } from "@/services/api-docker";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { hasSavedFolderExpansion, useDockerFolderStore } from "@/stores/docker-folders";
import type {
  AppPlaceMemberInput,
  DockerContainer,
  DockerFolderTreeNode,
  Node,
  NodeAppearanceColor,
} from "@/types";
import { DockerDeployDialog } from "./DockerDeployDialog";
import {
  containerDisplayName,
  containerLifecycleActions,
  STATUS_BADGE,
} from "./docker-detail/helpers";

interface DockerContainerListItem extends DockerContainer {
  _nodeId: string;
  _nodeSlug: string;
  _nodeName?: string;
  _nodeColor?: NodeAppearanceColor | null;
}

/** What Move to App sends for a container or a blue/green deployment. */
function containerAppMember(container: DockerContainerListItem): AppPlaceMemberInput {
  return container.kind === "deployment"
    ? {
        type: "deployment",
        id: container.deploymentId ?? container.id,
        nodeId: container._nodeId,
        resourceKey: container.name,
      }
    : { type: "container", nodeId: container._nodeId, resourceKey: container.name };
}

interface DockerFolderTreeNodeWithContainers extends DockerFolderTreeNode {
  containers: DockerContainerListItem[];
  children: DockerFolderTreeNodeWithContainers[];
}

function sortContainers(containers: DockerContainerListItem[]) {
  return [...containers].sort((a, b) => {
    const aOrder = a.folderSortOrder ?? 0;
    const bOrder = b.folderSortOrder ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return containerDisplayName(a.name).localeCompare(containerDisplayName(b.name));
  });
}

function attachContainersToFolders(
  folders: DockerFolderTreeNode[],
  containers: DockerContainerListItem[]
): DockerFolderTreeNodeWithContainers[] {
  const containersByFolder = new Map<string, DockerContainerListItem[]>();
  for (const container of containers) {
    if (!container.folderId) continue;
    const current = containersByFolder.get(container.folderId) ?? [];
    current.push(container);
    containersByFolder.set(container.folderId, current);
  }

  const mapNode = (folder: DockerFolderTreeNode): DockerFolderTreeNodeWithContainers => ({
    ...folder,
    containers: sortContainers(containersByFolder.get(folder.id) ?? []),
    children: folder.children.map(mapNode),
  });

  return folders.map(mapNode);
}

function pruneEmptyFolders(
  folders: DockerFolderTreeNodeWithContainers[]
): DockerFolderTreeNodeWithContainers[] {
  return folders
    .map((folder) => ({ ...folder, children: pruneEmptyFolders(folder.children) }))
    .filter((folder) => folder.containers.length > 0 || folder.children.length > 0);
}

function findContainersInFolder(
  nodes: DockerFolderTreeNodeWithContainers[],
  folderId: string
): DockerContainerListItem[] {
  for (const node of nodes) {
    if (node.id === folderId) return node.containers;
    const found = findContainersInFolder(node.children, folderId);
    if (found.length > 0) return found;
  }
  return [];
}

export function DockerContainers({
  embedded,
  onDeployRef,
  onCreateFolderRef,
  onRefreshRef,
  fixedNodeId,
}: {
  embedded?: boolean;
  onDeployRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
  onRefreshRef?: (fn: () => void) => void;
  fixedNodeId?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const containers = useDockerStore((s) => s.containers) as DockerContainerListItem[];
  const previousContainersRef = useRef(containers);
  const selectedNodeId = useDockerStore((s) => s.selectedNodeId);
  const filters = useDockerStore((s) => s.filters);
  const isLoading = useDockerStore((s) => s.loading.containers);
  const storeDockerNodes = useDockerStore((s) => s.dockerNodes);
  const dockerNodesLoaded = useDockerStore((s) => s.dockerNodesLoaded);
  const setSelectedNode = useDockerStore((s) => s.setSelectedNode);
  const setFilters = useDockerStore((s) => s.setFilters);
  const resetFilters = useDockerStore((s) => s.resetFilters);
  const fetchContainers = useDockerStore((s) => s.fetchContainers);
  const forceFetchContainers = useDockerStore((s) => s.forceFetchContainers);
  const requestSnapshotRefresh = useDockerStore((s) => s.requestSnapshotRefresh);
  const visibleNodeId = fixedNodeId ?? selectedNodeId;
  const canViewContainers = hasScopedAccess("docker:containers:view");

  const {
    folders,
    isLoading: foldersLoading,
    expandedFolderIds,
    fetchFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveFolder,
    reorderFolders,
    moveContainersToFolder,
    reorderContainers,
    toggleFolder,
  } = useDockerFolderStore();

  const [searchInput, setSearchInput] = useState(filters.search);
  const [dockerNodes, setDockerNodes] = useState<Node[]>([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  // Cached rows stay hidden until the first refresh, so stale folder placements never reshuffle.
  const [initialContentReady, setInitialContentReady] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [deployOpen, setDeployOpen] = useState(false);
  const [dockerNodeRequiredOpen, setDockerNodeRequiredOpen] = useState(false);
  const [checkingDeployNodes, setCheckingDeployNodes] = useState(false);
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [moveFolderId, setMoveFolderId] = useState<string | null>(null);
  const [moveDialogContainer, setMoveDialogContainer] = useState<DockerContainerListItem | null>(
    null
  );
  const [moveToAppContainer, setMoveToAppContainer] = useState<DockerContainerListItem | null>(
    null
  );
  const isMobile = useIsMobile();
  const [activeDrag, setActiveDrag] = useState<DragEndEvent["active"] | null>(null);
  const [optimisticContainers, setOptimisticContainers] = useState<
    DockerContainerListItem[] | null
  >(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const openDeploy = useCallback(async () => {
    if (checkingDeployNodes) return;
    if (fixedNodeId) {
      setDeployOpen(true);
      return;
    }

    setCheckingDeployNodes(true);
    try {
      const response = await api.listNodes({ type: "docker", limit: 1 });
      if ((response.data ?? []).length === 0) {
        setDockerNodeRequiredOpen(true);
        return;
      }
      setDeployOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to check Docker nodes");
    } finally {
      setCheckingDeployNodes(false);
    }
  }, [checkingDeployNodes, fixedNodeId]);

  useEffect(() => {
    onDeployRef?.(() => void openDeploy());
  }, [onDeployRef, openDeploy]);

  useEffect(() => {
    onCreateFolderRef?.(() => {
      setCreateFolderParentId(null);
      setCreateFolderOpen(true);
    });
  }, [onCreateFolderRef]);

  useEffect(() => {
    if (fixedNodeId) setSelectedNode(fixedNodeId);
  }, [fixedNodeId, setSelectedNode]);

  useEffect(() => {
    if (embedded || fixedNodeId) return;
    return () => {
      setSelectedNode(null);
    };
  }, [embedded, fixedNodeId, setSelectedNode]);

  const loadDockerNodes = useCallback(async () => {
    setNodesLoading(true);
    try {
      const compatible = await loadVisibleDockerNodes(
        user?.scopes ?? [],
        ["docker:containers:view", "docker:containers:create"],
        hasScopedAccess("nodes:details")
      );
      setDockerNodes(compatible);
      useDockerStore.getState().setDockerNodes(compatible);
    } catch {
      toast.error("Failed to load Docker nodes");
    } finally {
      setNodesLoading(false);
    }
  }, [hasScopedAccess, user?.scopes]);

  useEffect(() => {
    if (embedded) {
      setNodesLoading(!dockerNodesLoaded);
      return;
    }
    void loadDockerNodes();
  }, [dockerNodesLoaded, embedded, loadDockerNodes]);

  useEffect(() => {
    if (previousContainersRef.current === containers) return;
    previousContainersRef.current = containers;
    setOptimisticContainers(null);
  }, [containers]);

  const refreshData = useCallback(
    async (force = false) => {
      await Promise.all([
        canViewContainers
          ? force
            ? forceFetchContainers(visibleNodeId, filters.search)
            : fetchContainers(visibleNodeId, filters.search)
          : Promise.resolve(),
        fetchFolders(),
      ]);
    },
    [
      canViewContainers,
      fetchContainers,
      fetchFolders,
      filters.search,
      forceFetchContainers,
      visibleNodeId,
    ]
  );

  useEffect(() => {
    onRefreshRef?.(() => void requestSnapshotRefresh("containers", visibleNodeId));
  }, [onRefreshRef, requestSnapshotRefresh, visibleNodeId]);

  useEffect(() => {
    if (embedded && !fixedNodeId && !dockerNodesLoaded) {
      void fetchFolders();
      return;
    }
    if (!embedded && !fixedNodeId && nodesLoading) return;
    let cancelled = false;
    void refreshData().then(() => {
      if (!cancelled) setInitialContentReady(true);
    });
    const interval = setInterval(() => void refreshData(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [dockerNodesLoaded, embedded, fetchFolders, fixedNodeId, nodesLoading, refreshData]);

  useRealtime("docker.container.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (visibleNodeId && ev.nodeId && ev.nodeId !== visibleNodeId) return;
    void refreshData(true);
  });
  useRealtime("docker.snapshot.changed", (payload) => {
    const ev = payload as { nodeId?: string; kind?: string };
    if (ev.kind !== "containers" || (visibleNodeId && ev.nodeId && ev.nodeId !== visibleNodeId))
      return;
    void refreshData();
  });
  useRealtime("docker.task.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (visibleNodeId && ev.nodeId && ev.nodeId !== visibleNodeId) return;
    void refreshData(true);
  });
  useRealtime("docker.folder.changed", () => {
    void fetchFolders();
  });

  const handleSearch = useCallback(() => {
    setFilters({ search: searchInput });
  }, [searchInput, setFilters]);

  const visibleContainers = optimisticContainers ?? containers;
  const truncatedListMeta = visibleContainers.find((container) => container._listTruncated);

  const composeFolderIds = useMemo(() => {
    const hiddenIds = new Set(
      folders.filter((folder) => Boolean(folder.composeProject)).map((folder) => folder.id)
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (folder.parentId && hiddenIds.has(folder.parentId) && !hiddenIds.has(folder.id)) {
          hiddenIds.add(folder.id);
          changed = true;
        }
      }
    }
    return hiddenIds;
  }, [folders]);

  const generalFolders = useMemo(
    () => folders.filter((folder) => !composeFolderIds.has(folder.id)),
    [composeFolderIds, folders]
  );
  // App members live on their app's page (the server leaves them out too); a node's view keeps them.
  const generalContainers = useMemo(
    () =>
      visibleContainers.filter(
        (container) =>
          (!container.folderId || !composeFolderIds.has(container.folderId)) &&
          (!!fixedNodeId || !container.app)
      ),
    [composeFolderIds, fixedNodeId, visibleContainers]
  );

  const filteredContainers = useMemo(() => {
    let result = [...generalContainers];
    if (filters.status !== "all") {
      result = result.filter((container) =>
        matchesDockerContainerStatus(container, filters.status)
      );
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (c) =>
          containerDisplayName(c.name).toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q)
      );
    }
    return result;
  }, [filters, generalContainers]);

  const rawFolderTree = useMemo(
    () => attachContainersToFolders(generalFolders, filteredContainers),
    [filteredContainers, generalFolders]
  );
  const folderTree = useMemo(
    () => (fixedNodeId || filters.search.trim() ? pruneEmptyFolders(rawFolderTree) : rawFolderTree),
    [filters.search, fixedNodeId, rawFolderTree]
  );

  const folderIds = useMemo(() => collectFolderTreeIds(generalFolders), [generalFolders]);
  const ungroupedContainers = useMemo(
    () =>
      sortContainers(
        filteredContainers.filter(
          (container) => !container.folderId || !folderIds.has(container.folderId)
        )
      ),
    [filteredContainers, folderIds]
  );

  const hasActiveFilters = filters.search !== "" || filters.status !== "all";
  const hasActiveNodeFilter = !fixedNodeId && !!selectedNodeId;
  const isSearchFiltering = filters.search.trim() !== "";
  const canManageSomeFolders = useCanManageSomeFolders("docker:folders:manage");
  const canManageFolders = !fixedNodeId && canManageSomeFolders;
  // Visible only through folder grants: one top-most granted folder works as the root.
  const { limitedToFolders, isGrantedFolder, canManageFolderAt } = useFolderAccess(
    "docker:containers:view",
    "docker:folders:manage"
  );
  const canManageFolder = (folder: { parentId: string | null; isSystem?: boolean }) =>
    canManageFolders && !folder.isSystem && canManageFolderAt(folder.parentId ?? null);
  const shown = fixedNodeId
    ? { folders: folderTree, ungrouped: ungroupedContainers, root: null }
    : applyRootFolderView(folderTree, ungroupedContainers, (folder) => folder.containers, {
        limitedToFolders,
        isGrantedFolder,
      });
  const rootFolderId = shown.root?.id ?? null;
  const defaultOpenId = fixedNodeId
    ? null
    : defaultOpenFolderId(
        shown.folders,
        shown.ungrouped.length,
        hasSavedFolderExpansion("container")
      );
  const canCreateOnVisibleNode =
    !!visibleNodeId &&
    canCreateDockerResourceOnNode(user?.scopes ?? [], "docker:containers:create", visibleNodeId);
  // Without broad node visibility an empty node list means nothing is shared yet, not that no node exists.
  const seesEveryDockerNode =
    hasScope("nodes:details") ||
    hasScope("docker:containers:view") ||
    hasScopedAccess("docker:containers:create");
  const canDragFolders = canManageFolders && !isMobile && !isSearchFiltering;
  const canManageRuntime = hasScopedAccess("docker:containers:manage");
  const canMoveToApps = !fixedNodeId && hasScopedAccess("docker:containers:edit");
  const showActionsColumn = canManageFolders || canManageRuntime || canMoveToApps;
  const showNodeColumn = !fixedNodeId;

  const canViewContainer = useCallback(
    (container: DockerContainerListItem) =>
      !!container.scopeResourceId &&
      hasScope(`docker:containers:view:${container._nodeId}/${container.scopeResourceId}`),
    [hasScope]
  );

  const canManageContainer = useCallback(
    (container: DockerContainerListItem) =>
      !!container.scopeResourceId &&
      hasScope(`docker:containers:manage:${container._nodeId}/${container.scopeResourceId}`),
    [hasScope]
  );

  // Also gates Move to App: the same edit access on the container.
  const canReorganizeContainer = useCallback(
    (container: DockerContainerListItem) =>
      !fixedNodeId &&
      !container.app &&
      !container.folderIsSystem &&
      !!container.scopeResourceId &&
      hasScope(`docker:containers:edit:${container._nodeId}/${container.scopeResourceId}`),
    [fixedNodeId, hasScope]
  );

  const doAction = useCallback(
    async (container: DockerContainerListItem, action: string, fn: () => Promise<unknown>) => {
      const transitionByAction: Record<string, string> = {
        start: "starting",
        stop: "stopping",
        restart: "restarting",
      };
      const transition = transitionByAction[action];
      const containerId = container.id;
      setActionLoading((prev) => ({ ...prev, [containerId]: action }));
      if (transition) {
        setOptimisticContainers((current) =>
          (current ?? containers).map((item) =>
            item._nodeId === container._nodeId && item.id === container.id
              ? { ...item, _transition: transition }
              : item
          )
        );
      }
      try {
        const result = await fn();
        // A stop or restart still running after the request's wait goes on; the list shows its transition.
        if (isPendingContainerOperation(result))
          toast.info(`Container is still ${result.transition}`);
        else toast.success(`Container ${action} successful`);
        await refreshData(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Failed to ${action} container`);
      } finally {
        setActionLoading((prev) => {
          const copy = { ...prev };
          delete copy[containerId];
          return copy;
        });
      }
    },
    [containers, refreshData]
  );

  const handleStart = useCallback(
    (container: DockerContainerListItem) =>
      doAction(container, "start", async () => {
        if (container.kind === "deployment") {
          await api.startDockerDeployment(
            container._nodeId,
            container.deploymentId ?? container.id
          );
          return;
        }
        await api.startContainer(container._nodeId, container.id);
      }),
    [doAction]
  );

  const handleStop = useCallback(
    (container: DockerContainerListItem) =>
      doAction(container, "stop", async () => {
        if (container.kind === "deployment") {
          await api.stopDockerDeployment(container._nodeId, container.deploymentId ?? container.id);
          return;
        }
        return api.stopContainer(container._nodeId, container.id);
      }),
    [doAction]
  );

  const handleRestart = useCallback(
    (container: DockerContainerListItem) =>
      doAction(container, "restart", async () => {
        if (container.kind === "deployment") {
          await api.restartDockerDeployment(
            container._nodeId,
            container.deploymentId ?? container.id
          );
          return;
        }
        return api.restartContainer(container._nodeId, container.id);
      }),
    [doAction]
  );

  const handleCreateFolder = async (name: string) => {
    try {
      await createFolder(name, createFolderParentId ?? rootFolderId ?? undefined);
      toast.success("Folder created");
      setCreateFolderOpen(false);
      setCreateFolderParentId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  const handleRenameFolder = async (id: string, name: string) => {
    try {
      await renameFolder(id, name);
      toast.success("Folder renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename folder");
    }
  };

  const handleMoveFolder = async (id: string, parentId: string | null) => {
    try {
      await moveFolder(id, parentId);
      toast.success("Folder moved");
      await refreshData(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to move folder");
    }
  };

  const handleDeleteFolder = async (id: string) => {
    const ok = await confirm({
      title: "Delete Folder",
      description:
        "Are you sure? Containers inside will be moved to ungrouped. Subfolders will be deleted.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await deleteFolder(id);
      toast.success("Folder deleted");
      await refreshData(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete folder");
    }
  };

  const applyOptimisticMove = useCallback(
    (container: DockerContainerListItem, folderId: string | null) => {
      const targetFolder = folderId ? findFolderTreeNode(folders, folderId) : null;
      setOptimisticContainers((current) => {
        const source = (current ?? containers).map((item) => ({ ...item }));
        const moving = source.find(
          (item) => item._nodeId === container._nodeId && item.name === container.name
        );
        if (!moving) return source;

        const maxSortOrder = source.reduce((max, item) => {
          if ((item.folderId ?? null) !== folderId) return max;
          return Math.max(max, item.folderSortOrder ?? 0);
        }, -1);

        moving.folderId = folderId;
        moving.folderIsSystem = targetFolder?.isSystem ?? false;
        moving.folderSortOrder = maxSortOrder + 1;
        return source;
      });
    },
    [containers, folders]
  );

  const applyOptimisticReorder = useCallback(
    (reordered: DockerContainerListItem[]) => {
      setOptimisticContainers((current) => {
        const source = (current ?? containers).map((container) => ({ ...container }));
        const orderMap = new Map<string, number>(
          reordered.map(
            (container, index) => [`${container._nodeId}:${container.name}`, index] as const
          )
        );
        for (const container of source) {
          const key = `${container._nodeId}:${container.name}`;
          if (orderMap.has(key)) {
            container.folderSortOrder = orderMap.get(key);
          }
        }
        return source;
      });
    },
    [containers]
  );

  const moveContainer = useCallback(
    async (container: DockerContainerListItem, folderId: string | null) => {
      applyOptimisticMove(container, folderId);
      try {
        await moveContainersToFolder(
          [{ nodeId: container._nodeId, containerName: container.name }],
          folderId
        );
        toast.success(container.kind === "deployment" ? "Deployment moved" : "Container moved");
        await refreshData(true);
      } catch (err) {
        setOptimisticContainers(null);
        toast.error(err instanceof Error ? err.message : "Failed to move container");
      }
    },
    [applyOptimisticMove, moveContainersToFolder, refreshData]
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDrag(null);
    if (!canManageFolders || isSearchFiltering) return;
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const dropData = over.data.current;

    if (activeData?.type === "folder") {
      if (dropData?.type !== "folder" || active.id === over.id) return;
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
      const overGroup = findFolderSiblings(folders, dropData.folderId as string);
      if (!activeGroup || !overGroup || activeGroup.parentId !== overGroup.parentId) return;
      if (!canManageFolderAt(activeGroup.parentId)) return;
      const oldIndex = activeGroup.siblings.findIndex(
        (folder) => folder.id === activeData.folderId
      );
      const newIndex = overGroup.siblings.findIndex((folder) => folder.id === dropData.folderId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const reordered = [...activeGroup.siblings];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      try {
        await reorderFolders(
          reordered.map((folder, index) => ({ id: folder.id, sortOrder: index }))
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reorder folders");
      }
      return;
    }

    const source = activeData?.container as DockerContainerListItem | undefined;
    if (!source || source.folderIsSystem || !canManageFolderAt(source.folderId ?? null)) return;

    if (dropData?.type === "folder") {
      const targetFolderId = dropData.folderId as string | null;
      if (dropData.isSystem || source.folderId === targetFolderId) return;
      if (!canManageFolderAt(targetFolderId)) return;
      await moveContainer(source, targetFolderId);
      return;
    }

    const overContainer = dropData?.container as DockerContainerListItem | undefined;
    if (!overContainer || active.id === over.id) return;
    if (overContainer.folderIsSystem) return;

    if (source.folderId !== overContainer.folderId) {
      if (!canManageFolderAt(overContainer.folderId ?? null)) return;
      await moveContainer(source, overContainer.folderId ?? null);
      return;
    }

    const containersInFolder = source.folderId
      ? findContainersInFolder(folderTree, source.folderId)
      : ungroupedContainers;
    const oldIndex = containersInFolder.findIndex(
      (container) => container._nodeId === source._nodeId && container.name === source.name
    );
    const newIndex = containersInFolder.findIndex(
      (container) =>
        container._nodeId === overContainer._nodeId && container.name === overContainer.name
    );
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const reordered = [...containersInFolder];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    applyOptimisticReorder(reordered);

    try {
      await reorderContainers(
        reordered.map((container, index) => ({
          nodeId: container._nodeId,
          containerName: container.name,
          sortOrder: index,
        }))
      );
      await refreshData(true);
    } catch (err) {
      setOptimisticContainers(null);
      toast.error(err instanceof Error ? err.message : "Failed to reorder containers");
    }
  };

  const columns: ResourceListColumn<DockerContainerListItem>[] = [
    {
      id: "name",
      label: "Name",
      width: showNodeColumn ? "28%" : "32%",
      cellContentClassName: "gap-3",
      renderCell: (container) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
            {container.kind === "deployment" ? (
              <GitBranch className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Box className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <TruncateStart
                text={containerDisplayName(container.name)}
                className="text-sm font-medium"
              />
              {container.kind === "deployment" && (
                <Badge variant="outline" size="inline" className="shrink-0">
                  Deployment
                </Badge>
              )}
              {container.app && <AppMemberBadge app={container.app} />}
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {container.kind === "deployment"
                ? `active ${container.activeSlot ?? "-"}`
                : container.id.slice(0, 12)}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "image",
      label: "Image",
      width: showNodeColumn ? "22%" : "28%",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (container) => (
        <Badge variant="secondary" className="max-w-full font-mono">
          {container.pendingSourceBuild
            ? "Awaiting build"
            : formatDisplayImageRef(container.image ?? "")}
        </Badge>
      ),
    },
    ...(showNodeColumn
      ? [
          {
            id: "node",
            label: "Node",
            width: "15%",
            renderCell: (container: DockerContainerListItem) => (
              <Badge variant="secondary" className={nodeBadgeClassName(container._nodeColor)}>
                {container._nodeName || "-"}
              </Badge>
            ),
          },
        ]
      : []),
    {
      id: "status",
      label: "Status",
      width: "8.5rem",
      renderCell: (container) => {
        if (container.availability === "unavailable") {
          return <Badge variant="secondary">Unavailable</Badge>;
        }
        const status =
          container.availabilityPolicyStatus ?? container._transition ?? container.state;
        return (
          <Badge variant={STATUS_BADGE[status] ?? "secondary"}>{status.replaceAll("_", " ")}</Badge>
        );
      },
    },
    {
      id: "health",
      label: "Health",
      width: "7rem",
      renderCell: (container) => {
        const status =
          container.availabilityHealthStatus ??
          (container.healthStatus === "stopped"
            ? "stopped"
            : container.secureLinkDown
              ? "offline"
              : container.healthCheckEnabled
                ? (container.healthStatus ?? "unknown")
                : "disabled");
        return <Badge variant={STATUS_BADGE[status] ?? "secondary"}>{status}</Badge>;
      },
    },
    ...(showActionsColumn
      ? [
          {
            id: "actions",
            label: "Actions",
            width: "7.5rem",
            align: "right" as const,
            cellContentClassName: "gap-1 pl-3 whitespace-nowrap",
            renderCell: (container: DockerContainerListItem) => {
              const loadingAction = actionLoading[container.id];
              const transitioning = !!container._transition;
              const unavailable = container.availability === "unavailable";
              const pending = !!container.pendingSourceBuild;
              // A container waiting for its first build has no runtime to start or stop, but it can move
              // between folders like any other container: it materializes where it sits.
              const manage = !pending && canManageContainer(container);
              const reorganize =
                canReorganizeContainer(container) &&
                canManageFolders &&
                canManageFolderAt(container.folderId ?? null);
              const moveToApp = canMoveToApps && canReorganizeContainer(container);
              const lifecycleActions = pending
                ? { canStart: false, canStop: false, canRestart: false }
                : containerLifecycleActions(container.state);
              if (!manage && !reorganize && !moveToApp) return null;

              return (
                <div
                  className="flex items-center justify-end gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {lifecycleActions.canStop ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        pending={loadingAction === "stop"}
                        disabled={!!loadingAction || transitioning || unavailable}
                        onClick={() => handleStop(container)}
                        title="Stop"
                      >
                        {loadingAction !== "stop" && <Square className="h-3.5 w-3.5" />}
                      </Button>
                      {lifecycleActions.canRestart && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          pending={loadingAction === "restart"}
                          disabled={!!loadingAction || transitioning || unavailable}
                          onClick={() => handleRestart(container)}
                          title="Restart"
                        >
                          {loadingAction !== "restart" && <RefreshCw className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </>
                  ) : lifecycleActions.canStart ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      pending={loadingAction === "start"}
                      disabled={!!loadingAction || transitioning || unavailable}
                      onClick={() => handleStart(container)}
                      title="Start"
                    >
                      {loadingAction !== "start" && <Play className="h-3.5 w-3.5" />}
                    </Button>
                  ) : null}

                  {!container.folderIsSystem && (reorganize || moveToApp) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() =>
                            navigate(
                              container.kind === "deployment"
                                ? dockerDeploymentRoute(container._nodeSlug, container.name)
                                : dockerContainerRoute(container._nodeSlug, container.name),
                              { state: createReturnNavigationState(location) }
                            )
                          }
                        >
                          Open
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {reorganize && (
                          <DropdownMenuItem onClick={() => setMoveDialogContainer(container)}>
                            Move to folder...
                          </DropdownMenuItem>
                        )}
                        {moveToApp && (
                          <DropdownMenuItem onClick={() => setMoveToAppContainer(container)}>
                            Move to app...
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              );
            },
          },
        ]
      : []),
  ];

  const canListDockerResources =
    !!visibleNodeId || useDockerStore.getState().dockerNodes.length > 0 || !!embedded;

  const content = (
    <>
      {!embedded && (
        <PageHeader
          title="Docker Containers"
          description="Manage containers across your Docker nodes"
          badges={
            initialContentReady && !isLoading && visibleNodeId ? (
              <Badge variant="secondary" size="inline">
                {containers.length}
              </Badge>
            ) : null
          }
          actions={
            <ResponsiveHeaderActions
              actions={[
                ...(visibleNodeId
                  ? [
                      {
                        label: "Refresh",
                        icon: <RefreshCw className="h-4 w-4" />,
                        onClick: () => void requestSnapshotRefresh("containers", visibleNodeId),
                        disabled: isLoading || foldersLoading,
                      },
                    ]
                  : []),
                ...(canManageFolders
                  ? [
                      {
                        label: "New Folder",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => {
                          setCreateFolderParentId(null);
                          setCreateFolderOpen(true);
                        },
                      },
                    ]
                  : []),
                ...(canCreateOnVisibleNode
                  ? [
                      {
                        label: "Deploy Container",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => void openDeploy(),
                        disabled: checkingDeployNodes,
                      },
                    ]
                  : []),
              ]}
            >
              {visibleNodeId && (
                <RefreshButton
                  onClick={() => void requestSnapshotRefresh("containers", visibleNodeId)}
                  disabled={isLoading || foldersLoading}
                />
              )}
              {canManageFolders && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreateFolderParentId(null);
                    setCreateFolderOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  New Folder
                </Button>
              )}
              {canCreateOnVisibleNode && (
                <Button onClick={() => void openDeploy()} pending={checkingDeployNodes}>
                  <Plus className="h-4 w-4 mr-1" />
                  Deploy Container
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />
      )}

      <ResourceListForm<DockerFolderTreeNodeWithContainers, DockerContainerListItem>
        columns={columns}
        search={{
          initialFiltersOpen: new URLSearchParams(location.search).get("filters") === "1",
          search: searchInput,
          onSearchChange: (value) => {
            setSearchInput(value);
            setFilters({ search: value });
          },
          onSearchSubmit: handleSearch,
          placeholder: "Search containers by name or image...",
          hasActiveFilters: searchInput !== "" || filters.status !== "all" || hasActiveNodeFilter,
          onReset: () => {
            setSearchInput("");
            resetFilters();
            if (!fixedNodeId) setSelectedNode(null);
          },
          filters: (
            <div className="flex items-center gap-3">
              {!fixedNodeId && (
                <Select
                  value={selectedNodeId ?? "__all__"}
                  onValueChange={(value) => setSelectedNode(value === "__all__" ? null : value)}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="All nodes" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All nodes</SelectItem>
                    {(embedded ? storeDockerNodes : dockerNodes).map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Select
                value={filters.status}
                onValueChange={(value) => setFilters({ status: value })}
              >
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="stopped">Stopped</SelectItem>
                  <SelectItem value="unavailable">Unavailable</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ),
        }}
        afterSearch={
          <>
            {truncatedListMeta && (
              <Notice
                tone="warning"
                role="status"
                title={`Showing the first ${truncatedListMeta._listLimit ?? visibleContainers.length} of ${truncatedListMeta._listTotal ?? "many"} containers`}
              >
                Narrow the node or search filters for more specific data.
              </Notice>
            )}
            {!nodesLoading &&
              !embedded &&
              dockerNodes.length === 0 &&
              useDockerStore.getState().dockerNodes.length === 0 && (
                <EmptyState
                  message={
                    seesEveryDockerNode
                      ? "No Docker nodes registered. Add a Docker node from the Nodes page to get started."
                      : "No containers are shared with you yet. Containers placed in the folders you can access will appear here."
                  }
                />
              )}
          </>
        }
        loading={!initialContentReady || (canListDockerResources && (isLoading || foldersLoading))}
        loadingLabel="Loading containers..."
        hasContent={
          initialContentReady &&
          canListDockerResources &&
          (filteredContainers.length > 0 || folderTree.length > 0)
        }
        emptyState={
          canListDockerResources ? (
            <EmptyState
              message="No containers found on this node."
              hasActiveFilters={hasActiveFilters || hasActiveNodeFilter}
              onReset={() => {
                setSearchInput("");
                resetFilters();
                if (!fixedNodeId) setSelectedNode(null);
              }}
              actionLabel={canCreateOnVisibleNode ? "Deploy a container" : undefined}
              onAction={canCreateOnVisibleNode ? () => void openDeploy() : undefined}
            />
          ) : null
        }
        dnd={{
          sensors,
          active: activeDrag,
          onDragStart: (event) => setActiveDrag(event.active),
          onDragEnd: (event) => void handleDragEnd(event),
          onDragCancel: () => setActiveDrag(null),
        }}
        folders={{
          folders: shown.folders,
          ungroupedItems: shown.ungrouped,
          expandedFolderIds,
          getFolderId: (folder) => folder.id,
          getFolderName: (folder) => folder.name,
          getFolderChildren: (folder) => folder.children,
          getFolderItems: (folder) => folder.containers,
          getFolderSortableId: (folder) => `docker-folder-${folder.id}`,
          getFolderSortableData: (folder) => ({
            type: "folder",
            folderId: folder.id,
            isSystem: folder.isSystem,
            folder,
          }),
          isFolderExpanded: (folder) =>
            fixedNodeId ? true : expandedFolderIds.has(folder.id) || folder.id === defaultOpenId,
          isFolderSystem: (folder) => folder.isSystem,
          isFolderCollapsible: () => !fixedNodeId,
          canManageFolder,
          canReorderFolder: (folder) => canDragFolders && canManageFolder(folder),
          canCreateSubfolder: (folder) => folder.depth < 2,
          onToggleFolder: fixedNodeId
            ? () => {}
            : (id) => {
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
            id: "docker-folder-ungrouped",
            data: { type: "folder", folderId: rootFolderId, isSystem: false },
            disabled: !canDragFolders || !canManageFolderAt(rootFolderId),
          },
        }}
        items={{
          getItemId: (container) => `${container._nodeId}:${container.name}`,
          getItemSortableId: (container) => `${container._nodeId}:${container.name}`,
          getItemSortableData: (container) => ({ type: "container", container }),
          canViewItem: canViewContainer,
          isItemDragDisabled: (container) =>
            !canDragFolders ||
            !canReorganizeContainer(container) ||
            !!container.folderIsSystem ||
            !canManageFolderAt(container.folderId ?? null),
          onItemClick: (container) => {
            if (container.kind === "deployment") {
              navigate(dockerDeploymentRoute(container._nodeSlug, container.name), {
                state: createReturnNavigationState(location),
              });
              return;
            }
            navigate(dockerContainerRoute(container._nodeSlug, container.name), {
              state: createReturnNavigationState(location),
            });
          },
        }}
      />

      {canMoveToApps && (
        <MoveToAppDialog
          open={moveToAppContainer !== null}
          onOpenChange={(open) => {
            if (!open) setMoveToAppContainer(null);
          }}
          members={moveToAppContainer ? [containerAppMember(moveToAppContainer)] : []}
          resourceLabel={
            moveToAppContainer ? containerDisplayName(moveToAppContainer.name) : "the container"
          }
          onMoved={() => void refreshData(true)}
        />
      )}

      <DockerMoveToFolderDialog
        open={!!moveDialogContainer}
        onOpenChange={(open) => {
          if (!open) setMoveDialogContainer(null);
        }}
        folders={folders}
        currentFolderId={moveDialogContainer?.folderId ?? null}
        // Same destination rule as POST /docker/folders/move-containers: container edit access on the
        // destination folder, or on the node (broadly) for the root.
        canMoveTo={(folderId) =>
          canCreateInFolder(
            user?.scopes ?? [],
            "docker:containers:edit",
            folderId,
            moveDialogContainer?._nodeId
          ) && canManageFolderAt(folderId)
        }
        onMove={(folderId) => {
          if (moveDialogContainer) void moveContainer(moveDialogContainer, folderId);
        }}
      />

      <MoveToFolderDialog
        open={moveFolderId !== null}
        onOpenChange={(open) => {
          if (!open) setMoveFolderId(null);
        }}
        title="Move Folder"
        description="Select where to move the folder. Its subfolders and containers move with it."
        folders={shown.folders.filter((folder) => !folder.isSystem)}
        root={
          shown.root
            ? { id: shown.root.id, label: shown.root.name }
            : { id: null, label: "Top level" }
        }
        currentFolderId={
          (moveFolderId ? findFolderTreeNode(folders, moveFolderId)?.parentId : null) ?? null
        }
        canMoveTo={(parentId) =>
          !!moveFolderId &&
          canMoveFolderInto(generalFolders, moveFolderId, parentId) &&
          canManageFolderAt(parentId) &&
          !(parentId && findFolderTreeNode(generalFolders, parentId)?.isSystem)
        }
        onMove={(parentId) => {
          if (moveFolderId) void handleMoveFolder(moveFolderId, parentId);
        }}
      />

      <FolderCreateDialog
        open={createFolderOpen}
        onOpenChange={(open) => {
          setCreateFolderOpen(open);
          if (!open) setCreateFolderParentId(null);
        }}
        title={createFolderParentId ? "Create Subfolder" : "Create Folder"}
        description={
          createFolderParentId
            ? "Enter a name for the new subfolder."
            : "Enter a name for the new folder."
        }
        onCreate={handleCreateFolder}
      />

      <DockerDeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        nodeId={selectedNodeId || undefined}
        dockerNodes={dockerNodes}
        onDeployed={() => void refreshData(true)}
      />
      <Dialog
        open={dockerNodeRequiredOpen}
        onOpenChange={(open) => !open && setDockerNodeRequiredOpen(false)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>No Docker Nodes</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Containers must be deployed to a Docker node. Add and connect a Docker node first, then
            return here to deploy the container.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDockerNodeRequiredOpen(false)}>
              Close
            </Button>
            <Button asChild>
              <Link to="/nodes" onClick={() => setDockerNodeRequiredOpen(false)}>
                Open Nodes <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) {
    return (
      <div className={fixedNodeId ? "flex flex-col flex-1 min-h-0 space-y-4" : "space-y-4"}>
        {content}
      </div>
    );
  }

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">{content}</div>
    </PageTransition>
  );
}
