import { useMemo } from "react";
import {
  type FolderedListItemKeys,
  type FolderedListStore,
  FolderedResourceListCore,
  type FolderedResourceListViewProps,
} from "@/components/common/resource-list/FolderedResourceListCore";
import { useFolderAccess } from "@/hooks/use-folder-access";
import { hasSavedFolderExpansion, useResourceFolderStore } from "@/stores/resource-folders";
import type { ResourceFolderTreeNode, ResourceFolderType } from "@/types";

export interface FolderedResourceListItem {
  id: string;
  folderId?: string | null;
  sortOrder?: number;
}

interface FolderedResourceListProps<TItem extends FolderedResourceListItem>
  extends Omit<FolderedResourceListViewProps<TItem>, "afterSearch"> {
  resourceType: ResourceFolderType;
  realtimeChannel: string;
}

const EMPTY_FOLDERS: ResourceFolderTreeNode[] = [];
const EMPTY_EXPANDED = new Set<string>();

type StoredFolderType = Exclude<ResourceFolderType, `hosting-snapshot:${string}`>;

/** The view scope of each list; held broadly it shows every folder. */
const VIEW_SCOPE: Record<StoredFolderType, string> = {
  node: "nodes:details",
  domain: "domains:view",
  "ssl-certificate": "ssl:cert:view",
  "pki-ca": "pki:ca:view",
  "pki-certificate": "pki:cert:view",
  "pki-template": "pki:templates:view",
  "nginx-template": "proxy:templates:view",
  database: "databases:view",
  storage: "storage:view",
  "logging-environment": "logs:environments:view",
  "logging-schema": "logs:schemas:view",
  "admin-user": "admin:users",
  "admin-group": "admin:groups",
  "pages-project": "pages:view",
  app: "apps:view",
  "notification-alert-rule": "notifications:alerts:view",
  "notification-webhook": "notifications:webhooks:view",
  "access-list": "acl:view",
};

/** Folder management scope of each list (a folder grant manages that folder's subfolders), then broad alternatives. */
const MANAGE_SCOPES: Record<StoredFolderType, string[]> = {
  node: ["nodes:folders:manage"],
  domain: ["domains:folders:manage"],
  "ssl-certificate": ["ssl:cert:folders:manage"],
  "pki-ca": ["pki:ca:folders:manage"],
  "pki-certificate": ["pki:cert:folders:manage"],
  "pki-template": ["pki:templates:folders:manage"],
  "nginx-template": ["proxy:templates:folders:manage"],
  database: ["databases:folders:manage"],
  storage: ["storage:folders:manage"],
  "logging-environment": ["logs:environments:folders:manage"],
  "logging-schema": ["logs:schemas:folders:manage"],
  "admin-user": ["admin:users:folders:manage", "admin:system"],
  "admin-group": ["admin:groups:folders:manage", "admin:system"],
  "pages-project": ["pages:folders:manage"],
  app: ["apps:folders:manage"],
  "notification-alert-rule": ["notifications:alerts:folders:manage"],
  "notification-webhook": ["notifications:webhooks:folders:manage"],
  "access-list": ["acl:folders:manage"],
};

/**
 * Snapshot folders are decided by the server per hosting resource (`view.canManageFolders`), and
 * their grants name the hosting resource, which shows all of its snapshot folders.
 */
function isSnapshotType(type: ResourceFolderType): boolean {
  return type.startsWith("hosting-snapshot:");
}

const getSortOrder = (item: FolderedResourceListItem) => item.sortOrder;
const setSortOrder = (item: FolderedResourceListItem, sortOrder: number) => {
  item.sortOrder = sortOrder;
};
const getItemKey = (item: FolderedResourceListItem) => item.id;

/** A resource list grouped into resource folders (`useResourceFolderStore`), keyed by item id. */
export function FolderedResourceList<TItem extends FolderedResourceListItem>({
  resourceType,
  realtimeChannel,
  ...props
}: FolderedResourceListProps<TItem>) {
  const {
    foldersByType,
    loadingByType,
    expandedFolderIdsByType,
    fetchFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    reorderFolders,
    moveResourcesToFolder,
    reorderResources,
    toggleFolder,
    moveFolder,
  } = useResourceFolderStore();

  const snapshot = isSnapshotType(resourceType);
  // Visible only through folder grants: one top-most granted folder works as the root.
  const access = useFolderAccess(
    snapshot ? null : VIEW_SCOPE[resourceType as StoredFolderType],
    ...(snapshot ? [] : MANAGE_SCOPES[resourceType as StoredFolderType])
  );

  const store = useMemo<FolderedListStore<string>>(
    () => ({
      dndPrefix: resourceType,
      realtimeChannel,
      fetchFolders: () => fetchFolders(resourceType),
      createFolder: (name, parentId) => createFolder(resourceType, name, parentId),
      renameFolder: (id, name) => renameFolder(resourceType, id, name),
      deleteFolder: (id) => deleteFolder(resourceType, id),
      ...(snapshot
        ? {}
        : {
            moveFolder: (id: string, parentId: string | null) =>
              moveFolder(resourceType, id, parentId),
          }),
      reorderFolders: (items) => reorderFolders(resourceType, items),
      moveItems: (ids, folderId) => moveResourcesToFolder(resourceType, ids, folderId),
      reorderItems: (items) =>
        reorderResources(
          resourceType,
          items.map(({ ref, sortOrder }) => ({ id: ref, sortOrder }))
        ),
      toggleFolder: (id) => toggleFolder(resourceType, id),
    }),
    [
      createFolder,
      deleteFolder,
      fetchFolders,
      moveFolder,
      moveResourcesToFolder,
      realtimeChannel,
      snapshot,
      renameFolder,
      reorderFolders,
      reorderResources,
      resourceType,
      toggleFolder,
    ]
  );

  const keys = useMemo<FolderedListItemKeys<TItem, string>>(
    () => ({
      getItemKey,
      getItemSortableId: (item) => `${resourceType}:${item.id}`,
      getItemRef: getItemKey,
      getSortOrder,
      setSortOrder,
    }),
    [resourceType]
  );

  return (
    <FolderedResourceListCore<TItem, string>
      {...props}
      store={store}
      folderState={{
        folders: foldersByType[resourceType] ?? EMPTY_FOLDERS,
        loading: loadingByType[resourceType],
        expandedFolderIds: expandedFolderIdsByType[resourceType] ?? EMPTY_EXPANDED,
        expansionTouched: hasSavedFolderExpansion(resourceType),
      }}
      keys={keys}
      limitedToFolders={access.limitedToFolders}
      isGrantedFolder={access.isGrantedFolder}
      {...(snapshot ? {} : { canManageFolderAt: access.canManageFolderAt })}
    />
  );
}
