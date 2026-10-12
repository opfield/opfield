import { type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { FolderCreateDialog } from "@/components/common/FolderCreateDialog";
import { MoveToFolderDialog } from "@/components/common/MoveToFolderDialog";
import { ResourceListForm } from "@/components/common/ResourceListForm";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { collectFolderTreeIds, findFolderTreeNode } from "@/lib/folder-tree";
import { applyRootFolderView, canMoveFolderInto, defaultOpenFolderId } from "./folder-view";
import type { ResourceListSearchProps } from "./types";

/** A folder as the folder stores return it. */
export interface FolderedListFolder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  isSystem?: boolean;
  children: FolderedListFolder[];
}

interface FolderedListNode<TItem> extends Omit<FolderedListFolder, "children"> {
  items: TItem[];
  children: FolderedListNode<TItem>[];
}

export interface FolderedListItem {
  folderId?: string | null;
}

/**
 * The folder store operations of one folder scope (one resource type). Keep
 * the object stable per scope (`useMemo`): folders load again whenever
 * `fetchFolders` changes.
 */
export interface FolderedListStore<TRef> {
  /** Prefix of the folder drag ids: `${dndPrefix}-folder-${id}`. */
  dndPrefix: string;
  realtimeChannel: string;
  fetchFolders: () => Promise<void>;
  createFolder: (name: string, parentId?: string) => Promise<unknown>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  /** Moves a folder (with its subfolders and resources) under `parentId`; absent when the list cannot. */
  moveFolder?: (id: string, parentId: string | null) => Promise<void>;
  reorderFolders: (items: { id: string; sortOrder: number }[]) => Promise<void>;
  moveItems: (refs: TRef[], folderId: string | null) => Promise<void>;
  reorderItems: (items: Array<{ ref: TRef; sortOrder: number }>) => Promise<void>;
  toggleFolder: (id: string) => void;
}

export interface FolderedListFolderState {
  folders: FolderedListFolder[];
  loading: boolean;
  expandedFolderIds: Set<string>;
  /** The user has folded a folder in this list before; until then the first folder may start open. */
  expansionTouched?: boolean;
}

/** How list items are identified, ordered and saved. */
export interface FolderedListItemKeys<TItem, TRef> {
  /** Identity of an item in the list, unique across nodes for per-node resources. */
  getItemKey: (item: TItem) => string;
  getItemSortableId: (item: TItem) => string;
  /** What the store needs to move or reorder the item, or null when it cannot be saved. */
  getItemRef: (item: TItem) => TRef | null;
  getSortOrder: (item: TItem) => number | undefined;
  /** Writes a sort order into a copy of the item for the optimistic view. */
  setSortOrder: (item: TItem, sortOrder: number) => void;
  /** Updates a copy of the item after an optimistic move into `folder`. */
  onOptimisticMove?: (item: TItem, folder: FolderedListFolder | null) => void;
  /** Items that can never be dragged, moved or reordered. */
  isItemLocked?: (item: TItem) => boolean;
}

export interface FolderedListSystemFolder<TItem> {
  id: string;
  name: string;
  items: TItem[];
}

export interface FolderedResourceListViewProps<TItem> {
  resources: TItem[];
  /** Read-only folders shown above the stored ones. */
  systemFolders?: FolderedListSystemFolder<TItem>[];
  columns: ResourceListColumn<TItem>[];
  search: ResourceListSearchProps & { placeholder: string };
  loading: boolean;
  loadingLabel: string;
  emptyState: React.ReactNode;
  afterSearch?: React.ReactNode;
  minWidth?: React.CSSProperties["minWidth"];
  /** Embed search and table directly in a PanelShell. */
  embedded?: boolean;
  notifyOnMove?: boolean;
  /** Folder management somewhere in the list (broadly, or inside granted folders). */
  canManageFolders: boolean;
  /**
   * The caller sees these resources only through folder grants: with one top-most granted folder
   * the list works in that folder as the root.
   */
  limitedToFolders?: boolean;
  /** The caller holds a folder grant on this folder (stops the root search at it). */
  isGrantedFolder?: (folderId: string) => boolean;
  /** Folder management inside `parentId` (null = root). Default: `canManageFolders` everywhere. */
  canManageFolderAt?: (parentId: string | null) => boolean;
  canViewItem?: (item: TItem) => boolean;
  canReorganizeItem?: (item: TItem) => boolean;
  getResourceLabel: (item: TItem) => string;
  onItemClick?: (item: TItem) => void;
  onRefresh: (force?: boolean) => Promise<void> | void;
  onCreateFolderRef?: (fn: () => void) => void;
}

interface FolderedResourceListCoreProps<TItem, TRef> extends FolderedResourceListViewProps<TItem> {
  store: FolderedListStore<TRef>;
  folderState: FolderedListFolderState;
  keys: FolderedListItemKeys<TItem, TRef>;
  /**
   * Every folder stays expanded without a collapse control and empty folders
   * are hidden (a list scoped to one node).
   */
  lockExpanded?: boolean;
}

function sortResources<TItem>(
  resources: TItem[],
  getSortOrder: (item: TItem) => number | undefined,
  getResourceLabel: (item: TItem) => string
) {
  return [...resources].sort((a, b) => {
    const aOrder = getSortOrder(a) ?? 0;
    const bOrder = getSortOrder(b) ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return getResourceLabel(a).localeCompare(getResourceLabel(b));
  });
}

function attachResourcesToFolders<TItem extends FolderedListItem>(
  folders: FolderedListFolder[],
  resources: TItem[],
  getSortOrder: (item: TItem) => number | undefined,
  getResourceLabel: (item: TItem) => string
): FolderedListNode<TItem>[] {
  const resourcesByFolder = new Map<string, TItem[]>();
  for (const resource of resources) {
    if (!resource.folderId) continue;
    const current = resourcesByFolder.get(resource.folderId) ?? [];
    current.push(resource);
    resourcesByFolder.set(resource.folderId, current);
  }

  const mapNode = (folder: FolderedListFolder): FolderedListNode<TItem> => ({
    ...folder,
    items: sortResources(resourcesByFolder.get(folder.id) ?? [], getSortOrder, getResourceLabel),
    children: folder.children.map(mapNode),
  });

  return folders.map(mapNode);
}

function buildSystemFolderTree<TItem>(
  folders: FolderedListSystemFolder<TItem>[],
  getSortOrder: (item: TItem) => number | undefined,
  getResourceLabel: (item: TItem) => string
): FolderedListNode<TItem>[] {
  return folders
    .filter((folder) => folder.items.length > 0)
    .map((folder, index) => ({
      id: folder.id,
      name: folder.name,
      parentId: null,
      sortOrder: index,
      depth: 0,
      isSystem: true,
      items: sortResources(folder.items, getSortOrder, getResourceLabel),
      children: [],
    }));
}

function pruneEmptyFolders<TItem>(folders: FolderedListNode<TItem>[]): FolderedListNode<TItem>[] {
  return folders
    .map((folder) => ({ ...folder, children: pruneEmptyFolders(folder.children) }))
    .filter((folder) => folder.items.length > 0 || folder.children.length > 0);
}

function findResourcesInFolder<TItem>(nodes: FolderedListNode<TItem>[], folderId: string): TItem[] {
  for (const node of nodes) {
    if (node.id === folderId) return node.items;
    const found = findResourcesInFolder(node.children, folderId);
    if (found.length > 0) return found;
  }
  return [];
}

function findFolderSiblings(
  nodes: FolderedListFolder[],
  folderId: string,
  parentId: string | null = null
): { siblings: FolderedListFolder[]; parentId: string | null } | null {
  for (const node of nodes) {
    if (node.id === folderId) return { siblings: nodes, parentId };
    const found = findFolderSiblings(node.children, folderId, node.id);
    if (found) return found;
  }
  return null;
}

/**
 * A searchable resource list grouped into folders, with drag and drop,
 * persisted folder collapse and folder management. The folder store and the
 * item keying come from an adapter (`FolderedResourceList` for resource
 * folders, `DockerFolderedResourceList` for per-node Docker resources).
 */
export function FolderedResourceListCore<TItem extends FolderedListItem, TRef>({
  store,
  folderState,
  keys,
  lockExpanded = false,
  resources,
  systemFolders,
  columns,
  search,
  loading,
  loadingLabel,
  emptyState,
  afterSearch,
  minWidth = 900,
  embedded = false,
  notifyOnMove = true,
  canManageFolders,
  limitedToFolders = false,
  isGrantedFolder,
  canManageFolderAt,
  canViewItem,
  canReorganizeItem,
  getResourceLabel,
  onItemClick,
  onRefresh,
  onCreateFolderRef,
}: FolderedResourceListCoreProps<TItem, TRef>) {
  const {
    folders,
    loading: foldersLoading,
    expandedFolderIds,
    expansionTouched = true,
  } = folderState;
  const { fetchFolders, toggleFolder } = store;
  const { getItemKey, getSortOrder } = keys;
  const isMobile = useIsMobile();
  const [activeDrag, setActiveDrag] = useState<DragEndEvent["active"] | null>(null);
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [moveFolderId, setMoveFolderId] = useState<string | null>(null);
  const [optimisticResources, setOptimisticResources] = useState<TItem[] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const openCreateFolder = useCallback(() => {
    setCreateFolderParentId(null);
    setCreateFolderOpen(true);
  }, []);

  useEffect(() => {
    onCreateFolderRef?.(openCreateFolder);
  }, [onCreateFolderRef, openCreateFolder]);

  useEffect(() => {
    void fetchFolders();
  }, [fetchFolders]);

  useRealtime(store.realtimeChannel, () => {
    void fetchFolders();
  });

  const resourceResetKey = resources
    .map(
      (resource) =>
        `${getItemKey(resource)}:${resource.folderId ?? ""}:${getSortOrder(resource) ?? 0}`
    )
    .join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset optimistic overlay when server-provided placement signature changes.
  useEffect(() => {
    setOptimisticResources(null);
  }, [resourceResetKey]);

  const canMoveItem = (item: TItem) =>
    !(keys.isItemLocked?.(item) ?? false) && (canReorganizeItem?.(item) ?? true);

  const visibleResources = optimisticResources ?? resources;
  const folderIds = useMemo(() => collectFolderTreeIds(folders), [folders]);
  const systemFolderTree = useMemo(
    () => buildSystemFolderTree(systemFolders ?? [], getSortOrder, getResourceLabel),
    [getResourceLabel, getSortOrder, systemFolders]
  );
  const rawFolderTree = useMemo(
    () => attachResourcesToFolders(folders, visibleResources, getSortOrder, getResourceLabel),
    [folders, getResourceLabel, getSortOrder, visibleResources]
  );
  const folderTree = useMemo(
    () => [
      ...systemFolderTree,
      ...(lockExpanded || search.search.trim() ? pruneEmptyFolders(rawFolderTree) : rawFolderTree),
    ],
    [lockExpanded, rawFolderTree, search.search, systemFolderTree]
  );
  const ungroupedResources = useMemo(
    () =>
      sortResources(
        visibleResources.filter(
          (resource) => !resource.folderId || !folderIds.has(resource.folderId)
        ),
        getSortOrder,
        getResourceLabel
      ),
    [folderIds, getResourceLabel, getSortOrder, visibleResources]
  );

  const isSearchFiltering = search.search.trim() !== "";
  const canDragFolders = canManageFolders && !isMobile && !isSearchFiltering;
  // The root view stays while searching, so the top level keeps meaning the caller's folder.
  const shown = useMemo(
    () =>
      lockExpanded
        ? { folders: folderTree, ungrouped: ungroupedResources, root: null }
        : applyRootFolderView(folderTree, ungroupedResources, (folder) => folder.items, {
            limitedToFolders,
            isGrantedFolder,
          }),
    [folderTree, isGrantedFolder, limitedToFolders, lockExpanded, ungroupedResources]
  );
  const rootFolderId = shown.root?.id ?? null;
  const canManageAt = (parentId: string | null) =>
    canManageFolders && (canManageFolderAt ? canManageFolderAt(parentId) : true);
  const canManageFolderNode = (folder: { parentId: string | null; isSystem?: boolean }) =>
    !folder.isSystem && canManageAt(folder.parentId ?? null);
  const defaultOpenId = lockExpanded
    ? null
    : defaultOpenFolderId(shown.folders, shown.ungrouped.length, expansionTouched);

  const handleCreateFolder = async (name: string) => {
    try {
      await store.createFolder(name, createFolderParentId ?? rootFolderId ?? undefined);
      toast.success("Folder created");
      setCreateFolderOpen(false);
      setCreateFolderParentId(null);
    } catch (err) {
      toastApiError(err, "Failed to create folder");
    }
  };

  const shownMoveFolderId = useRetainedDialogValue(moveFolderId, moveFolderId !== null);
  const movingFolder = shownMoveFolderId ? findFolderTreeNode(folders, shownMoveFolderId) : null;
  /** Where the server accepts the folder, and where the caller manages folders. */
  const canMoveFolderTo = (parentId: string | null) =>
    !!shownMoveFolderId &&
    canMoveFolderInto(folders, shownMoveFolderId, parentId) &&
    canManageAt(parentId);

  const handleMoveFolder = async (id: string, parentId: string | null) => {
    try {
      await store.moveFolder?.(id, parentId);
      toast.success("Folder moved");
      await onRefresh(true);
    } catch (err) {
      toastApiError(err, "Failed to move folder");
    }
  };

  const handleRenameFolder = async (id: string, name: string) => {
    try {
      await store.renameFolder(id, name);
      toast.success("Folder renamed");
    } catch (err) {
      toastApiError(err, "Failed to rename folder");
    }
  };

  const handleDeleteFolder = async (id: string) => {
    const ok = await confirm({
      title: "Delete Folder",
      description:
        "Are you sure? Resources inside will be moved to ungrouped. Subfolders will be deleted.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await store.deleteFolder(id);
      toast.success("Folder deleted");
      await onRefresh(true);
    } catch (err) {
      toastApiError(err, "Failed to delete folder");
    }
  };

  const applyOptimisticMove = (resource: TItem, folderId: string | null) => {
    const targetFolder = folderId ? findFolderTreeNode(folders, folderId) : null;
    const resourceKey = getItemKey(resource);
    setOptimisticResources((current) => {
      const source = (current ?? resources).map((item) => ({ ...item }));
      const moving = source.find((item) => getItemKey(item) === resourceKey);
      if (!moving) return source;
      const maxSortOrder = source.reduce((max, item) => {
        if ((item.folderId ?? null) !== folderId) return max;
        return Math.max(max, getSortOrder(item) ?? 0);
      }, -1);
      moving.folderId = folderId;
      keys.onOptimisticMove?.(moving, targetFolder);
      keys.setSortOrder(moving, maxSortOrder + 1);
      return source;
    });
  };

  const applyOptimisticReorder = (reordered: TItem[]) => {
    setOptimisticResources((current) => {
      const source = (current ?? resources).map((resource) => ({ ...resource }));
      const orderMap = new Map(reordered.map((resource, index) => [getItemKey(resource), index]));
      for (const resource of source) {
        const order = orderMap.get(getItemKey(resource));
        if (order !== undefined) keys.setSortOrder(resource, order);
      }
      return source;
    });
  };

  const moveResource = async (resource: TItem, folderId: string | null) => {
    const ref = keys.getItemRef(resource);
    if (ref === null) return;
    applyOptimisticMove(resource, folderId);
    try {
      await store.moveItems([ref], folderId);
      if (notifyOnMove) toast.success("Resource moved");
      await onRefresh(true);
    } catch (err) {
      setOptimisticResources(null);
      toastApiError(err, "Failed to move resource");
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDrag(null);
    if (!canManageFolders || isSearchFiltering) return;
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const dropData = over.data.current;

    if (activeData?.type === "folder") {
      if (dropData?.type !== "folder" || active.id === over.id) return;
      const activeGroup = findFolderSiblings(folders, activeData.folderId as string);
      const overGroup = findFolderSiblings(folders, dropData.folderId as string);
      if (!activeGroup || !overGroup || activeGroup.parentId !== overGroup.parentId) return;
      if (!canManageAt(activeGroup.parentId)) return;
      const oldIndex = activeGroup.siblings.findIndex(
        (folder) => folder.id === activeData.folderId
      );
      const newIndex = overGroup.siblings.findIndex((folder) => folder.id === dropData.folderId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const reordered = [...activeGroup.siblings];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      try {
        await store.reorderFolders(
          reordered.map((folder, index) => ({ id: folder.id, sortOrder: index }))
        );
      } catch (err) {
        toastApiError(err, "Failed to reorder folders");
      }
      return;
    }

    const source = activeData?.resource as TItem | undefined;
    if (!source || !canMoveItem(source) || !canManageAt(source.folderId ?? null)) return;

    if (dropData?.type === "folder") {
      const targetFolderId = dropData.folderId as string | null;
      if (dropData.isSystem || source.folderId === targetFolderId) return;
      if (!canManageAt(targetFolderId)) return;
      await moveResource(source, targetFolderId);
      return;
    }

    const overResource = dropData?.resource as TItem | undefined;
    if (!overResource || active.id === over.id || !canMoveItem(overResource)) return;

    if (source.folderId !== overResource.folderId) {
      if (!canManageAt(overResource.folderId ?? null)) return;
      await moveResource(source, overResource.folderId ?? null);
      return;
    }

    const resourcesInFolder = source.folderId
      ? findResourcesInFolder(folderTree, source.folderId)
      : ungroupedResources;
    const sourceKey = getItemKey(source);
    const overKey = getItemKey(overResource);
    const oldIndex = resourcesInFolder.findIndex((resource) => getItemKey(resource) === sourceKey);
    const newIndex = resourcesInFolder.findIndex((resource) => getItemKey(resource) === overKey);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const reordered = [...resourcesInFolder];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    applyOptimisticReorder(reordered);

    try {
      const refs = reordered
        .map((resource) => keys.getItemRef(resource))
        .filter((ref): ref is TRef => ref !== null);
      await store.reorderItems(refs.map((ref, index) => ({ ref, sortOrder: index })));
      await onRefresh(true);
    } catch (err) {
      setOptimisticResources(null);
      toastApiError(err, "Failed to reorder resources");
    }
  };

  return (
    <>
      <ResourceListForm<FolderedListNode<TItem>, TItem>
        embedded={embedded}
        columns={columns}
        search={search}
        afterSearch={afterSearch}
        loading={loading || foldersLoading}
        loadingLabel={loadingLabel}
        hasContent={visibleResources.length > 0 || folderTree.length > 0}
        emptyState={emptyState}
        dnd={{
          sensors,
          active: activeDrag,
          onDragStart: (event) => setActiveDrag(event.active),
          onDragEnd: (event) => void handleDragEnd(event),
          onDragCancel: () => setActiveDrag(null),
        }}
        minWidth={minWidth}
        folders={{
          folders: shown.folders,
          ungroupedItems: shown.ungrouped,
          expandedFolderIds,
          getFolderId: (folder) => folder.id,
          getFolderName: (folder) => folder.name,
          getFolderChildren: (folder) => folder.children,
          getFolderItems: (folder) => folder.items,
          getFolderSortableId: (folder) => `${store.dndPrefix}-folder-${folder.id}`,
          getFolderSortableData: (folder) => ({
            type: "folder",
            folderId: folder.id,
            isSystem: folder.isSystem,
            folder,
          }),
          isFolderExpanded: (folder) =>
            lockExpanded || expandedFolderIds.has(folder.id) || folder.id === defaultOpenId,
          isFolderSystem: (folder) => !!folder.isSystem,
          isFolderCollapsible: () => !lockExpanded,
          canManageFolder: canManageFolderNode,
          canReorderFolder: (folder) => canDragFolders && canManageFolderNode(folder),
          canCreateSubfolder: (folder) => !folder.isSystem && folder.depth < 2,
          onToggleFolder: (id) => {
            if (lockExpanded) return;
            // The first fold saves the folder that started open, so it stays as the user saw it.
            if (defaultOpenId) toggleFolder(defaultOpenId);
            toggleFolder(id);
          },
          onRenameFolder: handleRenameFolder,
          onDeleteFolder: handleDeleteFolder,
          ...(store.moveFolder ? { onRequestMoveFolder: (id: string) => setMoveFolderId(id) } : {}),
          onRequestCreateSubfolder: (parentId) => {
            setCreateFolderParentId(parentId);
            setCreateFolderOpen(true);
          },
          ungroupedDroppable: {
            id: `${store.dndPrefix}-folder-ungrouped`,
            data: { type: "folder", folderId: rootFolderId, isSystem: false },
            disabled: !canDragFolders || !canManageAt(rootFolderId),
          },
        }}
        items={{
          getItemId: getItemKey,
          getItemSortableId: keys.getItemSortableId,
          getItemSortableData: (resource) => ({ type: "resource", resource }),
          canViewItem,
          isItemDragDisabled: (resource) =>
            !canDragFolders || !canMoveItem(resource) || !canManageAt(resource.folderId ?? null),
          onItemClick,
        }}
      />

      {store.moveFolder && (
        <MoveToFolderDialog
          open={moveFolderId !== null}
          onOpenChange={(open) => {
            if (!open) setMoveFolderId(null);
          }}
          title="Move Folder"
          description="Select where to move the folder. Its subfolders and resources move with it."
          folders={shown.folders.filter((folder) => !folder.isSystem)}
          root={
            shown.root
              ? { id: shown.root.id, label: shown.root.name }
              : { id: null, label: "Top level" }
          }
          currentFolderId={movingFolder?.parentId ?? null}
          canMoveTo={canMoveFolderTo}
          onMove={(parentId) => {
            if (shownMoveFolderId) void handleMoveFolder(shownMoveFolderId, parentId);
          }}
        />
      )}

      <FolderCreateDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        onCreate={handleCreateFolder}
        description={
          createFolderParentId
            ? `Create a subfolder inside "${folders.find((folder) => folder.id === createFolderParentId)?.name ?? "folder"}".`
            : "Enter a name for the new folder."
        }
      />
    </>
  );
}
