import { create } from "zustand";
import { api } from "@/services/api";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import type { ResourceFolder, ResourceFolderTreeNode, ResourceFolderType } from "@/types";

type FolderResourceMap<T> = Record<ResourceFolderType, T>;

interface ResourceFolderState {
  foldersByType: FolderResourceMap<ResourceFolderTreeNode[]>;
  loadingByType: FolderResourceMap<boolean>;
  errorByType: FolderResourceMap<string | null>;
  expandedFolderIdsByType: FolderResourceMap<Set<string>>;
  savedExpandedFolderIdsByType: FolderResourceMap<Set<string>>;
  fetchFolders: (type: ResourceFolderType) => Promise<void>;
  createFolder: (
    type: ResourceFolderType,
    name: string,
    parentId?: string
  ) => Promise<ResourceFolder>;
  renameFolder: (type: ResourceFolderType, id: string, name: string) => Promise<void>;
  deleteFolder: (type: ResourceFolderType, id: string) => Promise<void>;
  /** Moves a folder with its subfolders and resources under `parentId` (null = top level). */
  moveFolder: (type: ResourceFolderType, id: string, parentId: string | null) => Promise<void>;
  reorderFolders: (
    type: ResourceFolderType,
    items: { id: string; sortOrder: number }[]
  ) => Promise<void>;
  moveResourcesToFolder: (
    type: ResourceFolderType,
    ids: string[],
    folderId: string | null
  ) => Promise<void>;
  reorderResources: (
    type: ResourceFolderType,
    items: { id: string; sortOrder: number }[]
  ) => Promise<void>;
  toggleFolder: (type: ResourceFolderType, id: string) => void;
}

const RESOURCE_TYPES: ResourceFolderType[] = [
  "node",
  "domain",
  "ssl-certificate",
  "pki-ca",
  "pki-certificate",
  "pki-template",
  "nginx-template",
  "database",
  "storage",
  "logging-environment",
  "logging-schema",
  "admin-user",
  "admin-group",
  "pages-project",
  "app",
];
const EXPANDED_STORAGE_KEY = "resource-folder-expanded";

function resourceMap<T>(value: (type: ResourceFolderType) => T): FolderResourceMap<T> {
  return Object.fromEntries(
    RESOURCE_TYPES.map((type) => [type, value(type)])
  ) as FolderResourceMap<T>;
}

function storageKey(type: ResourceFolderType) {
  return `${EXPANDED_STORAGE_KEY}:${type}`;
}

/** Whether the user ever folded a folder in this list (the first toggle saves the set). */
export function hasSavedFolderExpansion(type: ResourceFolderType): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(storageKey(type)) !== null;
  } catch {
    return false;
  }
}

function loadExpandedFolderIds(type: ResourceFolderType): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(type));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function saveExpandedFolderIds(type: ResourceFolderType, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(type), JSON.stringify(Array.from(ids)));
  } catch {}
}

function applyFolderOrder(
  nodes: ResourceFolderTreeNode[],
  items: { id: string; sortOrder: number }[]
): ResourceFolderTreeNode[] {
  const orderMap = new Map(items.map((item) => [item.id, item.sortOrder]));
  const visit = (current: ResourceFolderTreeNode[]): ResourceFolderTreeNode[] => {
    const hasTarget = current.some((node) => orderMap.has(node.id));
    const next = current.map((node) => ({ ...node, children: visit(node.children) }));
    if (!hasTarget) return next;
    return [...next].sort((a, b) => {
      const aOrder = orderMap.get(a.id);
      const bOrder = orderMap.get(b.id);
      if (aOrder == null && bOrder == null) return 0;
      if (aOrder == null) return -1;
      if (bOrder == null) return 1;
      return aOrder - bOrder;
    });
  };
  return visit(nodes);
}

const fetchRequestIds = resourceMap(() => 0);
const folderAuthKeys: Partial<Record<ResourceFolderType, string>> = {};

export const useResourceFolderStore = create<ResourceFolderState>()((set, get) => {
  const initialExpanded = resourceMap((type) => new Set(loadExpandedFolderIds(type)));

  return {
    foldersByType: resourceMap(() => []),
    loadingByType: resourceMap(() => true),
    errorByType: resourceMap(() => null),
    expandedFolderIdsByType: initialExpanded,
    savedExpandedFolderIdsByType: initialExpanded,

    fetchFolders: async (type) => {
      const authKey = accessContextKey(useAuthStore.getState());
      if (folderAuthKeys[type] !== authKey) {
        folderAuthKeys[type] = authKey;
        set((state) => ({ foldersByType: { ...state.foldersByType, [type]: [] } }));
      }
      const requestId = (fetchRequestIds[type] = (fetchRequestIds[type] ?? 0) + 1);
      set((state) => ({
        loadingByType: {
          ...state.loadingByType,
          [type]: !state.foldersByType[type]?.length,
        },
        errorByType: { ...state.errorByType, [type]: null },
      }));
      try {
        const folders = await listFolders(type);
        if (
          requestId !== fetchRequestIds[type] ||
          authKey !== accessContextKey(useAuthStore.getState())
        )
          return;
        set((state) => ({
          foldersByType: { ...state.foldersByType, [type]: folders },
          loadingByType: { ...state.loadingByType, [type]: false },
          expandedFolderIdsByType: {
            ...state.expandedFolderIdsByType,
            [type]: new Set(
              state.savedExpandedFolderIdsByType[type] ?? loadExpandedFolderIds(type)
            ),
          },
        }));
      } catch (err) {
        if (requestId !== fetchRequestIds[type]) return;
        set((state) => ({
          errorByType: {
            ...state.errorByType,
            [type]: err instanceof Error ? err.message : "Failed to fetch folders",
          },
          loadingByType: { ...state.loadingByType, [type]: false },
        }));
      }
    },

    createFolder: async (type, name, parentId) => {
      const folder = await createFolderByType(type, { name, parentId });
      if (parentId) {
        set((state) => {
          const next = new Set(state.savedExpandedFolderIdsByType[type]);
          next.add(parentId);
          saveExpandedFolderIds(type, next);
          return {
            expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(next) },
            savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: next },
          };
        });
      }
      await get().fetchFolders(type);
      return folder;
    },

    renameFolder: async (type, id, name) => {
      await updateFolderByType(type, id, { name });
      await get().fetchFolders(type);
    },

    deleteFolder: async (type, id) => {
      await deleteFolderByType(type, id);
      set((state) => {
        const next = new Set(state.savedExpandedFolderIdsByType[type]);
        next.delete(id);
        saveExpandedFolderIds(type, next);
        return {
          expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(next) },
          savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: next },
        };
      });
      await get().fetchFolders(type);
    },

    moveFolder: async (type, id, parentId) => {
      await api.moveResourceFolder(folderBasePath(type), id, parentId);
      if (parentId) {
        // Open the destination so the moved folder stays in sight.
        set((state) => {
          const next = new Set(state.savedExpandedFolderIdsByType[type]);
          next.add(parentId);
          saveExpandedFolderIds(type, next);
          return {
            expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(next) },
            savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: next },
          };
        });
      }
      await get().fetchFolders(type);
    },

    reorderFolders: async (type, items) => {
      const previous = get().foldersByType[type] ?? [];
      set((state) => ({
        foldersByType: { ...state.foldersByType, [type]: applyFolderOrder(previous, items) },
      }));
      try {
        await reorderFoldersByType(type, items);
        await get().fetchFolders(type);
      } catch (err) {
        set((state) => ({ foldersByType: { ...state.foldersByType, [type]: previous } }));
        throw err;
      }
    },

    moveResourcesToFolder: async (type, ids, folderId) => {
      await moveResourcesToFolderByType(type, ids, folderId);
      await get().fetchFolders(type);
    },

    reorderResources: async (type, items) => {
      await reorderResourcesByType(type, items);
    },

    toggleFolder: (type, id) => {
      set((state) => {
        const next = new Set(state.savedExpandedFolderIdsByType[type]);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveExpandedFolderIds(type, next);
        return {
          expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(next) },
          savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: next },
        };
      });
    },
  };
});

/** Folder routes of each list (`PUT <path>/<id>/move`). Snapshot folders cannot move. */
function folderBasePath(type: ResourceFolderType): string {
  if (isSnapshotType(type)) throw new Error("Snapshot folders cannot be moved");
  switch (type) {
    case "node":
      return "/nodes/folders";
    case "domain":
      return "/domains/folders";
    case "ssl-certificate":
      return "/ssl-certificates/folders";
    case "pki-ca":
      return "/cas/folders";
    case "pki-certificate":
      return "/certificates/folders";
    case "pki-template":
      return "/templates/folders";
    case "nginx-template":
      return "/nginx-templates/folders";
    case "database":
      return "/databases/folders";
    case "storage":
      return "/object-storage/folders";
    case "logging-environment":
      return "/logging/environment-folders";
    case "logging-schema":
      return "/logging/schema-folders";
    case "admin-user":
      return "/admin/user-folders";
    case "admin-group":
      return "/admin/groups/folders";
    case "pages-project":
      return "/pages/folders";
    case "app":
      return "/apps/folders";
  }
}

function listFolders(type: ResourceFolderType): Promise<ResourceFolderTreeNode[]> {
  if (isSnapshotType(type)) return api.getHostingSnapshotFolders(type.slice(17));
  switch (type) {
    case "node":
      return api.listNodeFolders();
    case "domain":
      return api.listDomainFolders();
    case "ssl-certificate":
      return api.listSSLCertificateFolders();
    case "pki-ca":
      return api.listCAFolders();
    case "pki-certificate":
      return api.listCertificateFolders();
    case "pki-template":
      return api.listPkiTemplateFolders();
    case "nginx-template":
      return api.listNginxTemplateFolders();
    case "database":
      return api.listDatabaseFolders();
    case "storage":
      return api.listObjectStorageFolders();
    case "logging-environment":
      return api.listLoggingEnvironmentFolders();
    case "logging-schema":
      return api.listLoggingSchemaFolders();
    case "admin-user":
      return api.listAdminUserFolders();
    case "admin-group":
      return api.listAdminGroupFolders();
    case "pages-project":
      return api.listPageProjectFolders();
    case "app":
      return api.listAppFolders();
  }
}

function createFolderByType(
  type: ResourceFolderType,
  data: { name: string; parentId?: string }
): Promise<ResourceFolder> {
  if (isSnapshotType(type))
    return api.hostingSnapshotFolderAction<ResourceFolder>(type.slice(17), "create", data);
  switch (type) {
    case "node":
      return api.createNodeFolder(data);
    case "domain":
      return api.createDomainFolder(data);
    case "ssl-certificate":
      return api.createSSLCertificateFolder(data);
    case "pki-ca":
      return api.createCAFolder(data);
    case "pki-certificate":
      return api.createCertificateFolder(data);
    case "pki-template":
      return api.createPkiTemplateFolder(data);
    case "nginx-template":
      return api.createNginxTemplateFolder(data);
    case "database":
      return api.createDatabaseFolder(data);
    case "storage":
      return api.createObjectStorageFolder(data);
    case "logging-environment":
      return api.createLoggingEnvironmentFolder(data);
    case "logging-schema":
      return api.createLoggingSchemaFolder(data);
    case "admin-user":
      return api.createAdminUserFolder(data);
    case "admin-group":
      return api.createAdminGroupFolder(data);
    case "pages-project":
      return api.createPageProjectFolder(data);
    case "app":
      return api.createAppFolder(data);
  }
}

function updateFolderByType(
  type: ResourceFolderType,
  id: string,
  data: { name: string }
): Promise<ResourceFolder> {
  if (isSnapshotType(type))
    return api.hostingSnapshotFolderAction<ResourceFolder>(type.slice(17), "rename", data, id);
  switch (type) {
    case "node":
      return api.updateNodeFolder(id, data);
    case "domain":
      return api.updateDomainFolder(id, data);
    case "ssl-certificate":
      return api.updateSSLCertificateFolder(id, data);
    case "pki-ca":
      return api.updateCAFolder(id, data);
    case "pki-certificate":
      return api.updateCertificateFolder(id, data);
    case "pki-template":
      return api.updatePkiTemplateFolder(id, data);
    case "nginx-template":
      return api.updateNginxTemplateFolder(id, data);
    case "database":
      return api.updateDatabaseFolder(id, data);
    case "storage":
      return api.updateObjectStorageFolder(id, data);
    case "logging-environment":
      return api.updateLoggingEnvironmentFolder(id, data);
    case "logging-schema":
      return api.updateLoggingSchemaFolder(id, data);
    case "admin-user":
      return api.updateAdminUserFolder(id, data);
    case "admin-group":
      return api.updateAdminGroupFolder(id, data);
    case "pages-project":
      return api.updatePageProjectFolder(id, data);
    case "app":
      return api.updateAppFolder(id, data);
  }
}

function deleteFolderByType(type: ResourceFolderType, id: string): Promise<void> {
  if (isSnapshotType(type))
    return api.hostingSnapshotFolderAction(type.slice(17), "delete", {}, id);
  switch (type) {
    case "node":
      return api.deleteNodeFolder(id);
    case "domain":
      return api.deleteDomainFolder(id);
    case "ssl-certificate":
      return api.deleteSSLCertificateFolder(id);
    case "pki-ca":
      return api.deleteCAFolder(id);
    case "pki-certificate":
      return api.deleteCertificateFolder(id);
    case "pki-template":
      return api.deletePkiTemplateFolder(id);
    case "nginx-template":
      return api.deleteNginxTemplateFolder(id);
    case "database":
      return api.deleteDatabaseFolder(id);
    case "storage":
      return api.deleteObjectStorageFolder(id);
    case "logging-environment":
      return api.deleteLoggingEnvironmentFolder(id);
    case "logging-schema":
      return api.deleteLoggingSchemaFolder(id);
    case "admin-user":
      return api.deleteAdminUserFolder(id);
    case "admin-group":
      return api.deleteAdminGroupFolder(id);
    case "pages-project":
      return api.deletePageProjectFolder(id);
    case "app":
      return api.deleteAppFolder(id);
  }
}

function reorderFoldersByType(
  type: ResourceFolderType,
  items: { id: string; sortOrder: number }[]
): Promise<void> {
  if (isSnapshotType(type))
    return api.hostingSnapshotFolderAction(type.slice(17), "reorder-folders", { items });
  switch (type) {
    case "node":
      return api.reorderNodeFolders(items);
    case "domain":
      return api.reorderDomainFolders(items);
    case "ssl-certificate":
      return api.reorderSSLCertificateFolders(items);
    case "pki-ca":
      return api.reorderCAFolders(items);
    case "pki-certificate":
      return api.reorderCertificateFolders(items);
    case "pki-template":
      return api.reorderPkiTemplateFolders(items);
    case "nginx-template":
      return api.reorderNginxTemplateFolders(items);
    case "database":
      return api.reorderDatabaseFolders(items);
    case "storage":
      return api.reorderObjectStorageFolders(items);
    case "logging-environment":
      return api.reorderLoggingEnvironmentFolders(items);
    case "logging-schema":
      return api.reorderLoggingSchemaFolders(items);
    case "admin-user":
      return api.reorderAdminUserFolders(items);
    case "admin-group":
      return api.reorderAdminGroupFolders(items);
    case "pages-project":
      return api.reorderPageProjectFolders(items);
    case "app":
      return api.reorderAppFolders(items);
  }
}

function moveResourcesToFolderByType(
  type: ResourceFolderType,
  ids: string[],
  folderId: string | null
): Promise<void> {
  if (isSnapshotType(type))
    return api.hostingSnapshotFolderAction(type.slice(17), "move-resources", { ids, folderId });
  switch (type) {
    case "node":
      return api.moveNodesToFolder(ids, folderId);
    case "domain":
      return api.moveDomainsToFolder(ids, folderId);
    case "ssl-certificate":
      return api.moveSSLCertificatesToFolder(ids, folderId);
    case "pki-ca":
      return api.moveCAsToFolder(ids, folderId);
    case "pki-certificate":
      return api.moveCertificatesToFolder(ids, folderId);
    case "pki-template":
      return api.movePkiTemplatesToFolder(ids, folderId);
    case "nginx-template":
      return api.moveNginxTemplatesToFolder(ids, folderId);
    case "database":
      return api.moveDatabasesToFolder(ids, folderId);
    case "storage":
      return api.moveObjectStoragesToFolder(ids, folderId);
    case "logging-environment":
      return api.moveLoggingEnvironmentsToFolder(ids, folderId);
    case "logging-schema":
      return api.moveLoggingSchemasToFolder(ids, folderId);
    case "admin-user":
      return api.moveAdminUsersToFolder(ids, folderId);
    case "admin-group":
      return api.moveAdminGroupsToFolder(ids, folderId);
    case "pages-project":
      return api.movePageProjectsToFolder(ids, folderId);
    case "app":
      return api.moveAppsToFolder(ids, folderId);
  }
}

function reorderResourcesByType(
  type: ResourceFolderType,
  items: { id: string; sortOrder: number }[]
): Promise<void> {
  if (isSnapshotType(type))
    return api.hostingSnapshotFolderAction(type.slice(17), "reorder-resources", { items });
  switch (type) {
    case "node":
      return api.reorderNodes(items);
    case "domain":
      return api.reorderDomains(items);
    case "ssl-certificate":
      return api.reorderSSLCertificates(items);
    case "pki-ca":
      return api.reorderCAs(items);
    case "pki-certificate":
      return api.reorderCertificates(items);
    case "pki-template":
      return api.reorderPkiTemplates(items);
    case "nginx-template":
      return api.reorderNginxTemplates(items);
    case "database":
      return api.reorderDatabases(items);
    case "storage":
      return api.reorderObjectStorages(items);
    case "logging-environment":
      return api.reorderLoggingEnvironments(items);
    case "logging-schema":
      return api.reorderLoggingSchemas(items);
    case "admin-user":
      return api.reorderAdminUsers(items);
    case "admin-group":
      return api.reorderAdminGroups(items);
    case "pages-project":
      return api.reorderPageProjects(items);
    case "app":
      return api.reorderApps(items);
  }
}
function isSnapshotType(type: ResourceFolderType): type is `hosting-snapshot:${string}` {
  return type.startsWith("hosting-snapshot:");
}
