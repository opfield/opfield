import { create } from "zustand";
import { isAppMember, NORMAL_LIST_FILTER, withoutAppMembers } from "@/lib/app-members";
import { api } from "@/services/api";
import type {
  FolderTreeNode,
  GroupedProxyHostsResponse,
  HealthStatus,
  ProxyHost,
  ProxyHostFolder,
  ProxyHostType,
} from "@/types";

interface FolderFilters {
  search: string;
  type: ProxyHostType | "all";
  healthStatus: HealthStatus | "all";
}

interface FolderState {
  // Data
  folders: FolderTreeNode[];
  ungroupedHosts: ProxyHost[];
  totalHosts: number;
  isLoading: boolean;
  error: string | null;

  // Filters
  filters: FolderFilters;

  // Expansion state
  expandedFolderIds: Set<string>;
  savedExpandedFolderIds: Set<string>;

  // Actions
  fetchGroupedHosts: () => Promise<void>;
  removeHost: (id: string) => void;
  setFilters: (filters: Partial<FolderFilters>) => void;
  resetFilters: () => void;

  // Folder CRUD
  createFolder: (name: string, parentId?: string) => Promise<ProxyHostFolder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  reorderFolders: (items: { id: string; sortOrder: number }[]) => Promise<void>;

  // Host movement
  moveHostsToFolder: (hostIds: string[], folderId: string | null) => Promise<void>;
  /** Moves a folder with its subfolders and routes under `parentId` (null = top level). */
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  reorderHosts: (items: { id: string; sortOrder: number }[]) => Promise<void>;

  // Expansion
  toggleFolder: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
}

const defaultFilters: FolderFilters = {
  search: "",
  type: "all",
  healthStatus: "all",
};

const EXPANDED_FOLDERS_STORAGE_KEY = "proxy-folder-expanded";

function loadExpandedFolderIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(EXPANDED_FOLDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Whether the user ever folded a route folder (the first toggle saves the set). */
export function hasSavedProxyFolderExpansion(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(EXPANDED_FOLDERS_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function saveExpandedFolderIds(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {}
}

/** Collect all folder IDs from a tree */
function collectFolderIds(nodes: FolderTreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    ids.push(...collectFolderIds(node.children));
  }
  return ids;
}

/** Collect IDs of folders that contain matching hosts (recursively) */
function collectFoldersWithHosts(nodes: FolderTreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    const childIds = collectFoldersWithHosts(node.children);
    if (node.hosts.length > 0 || childIds.length > 0) {
      ids.push(node.id);
    }
    ids.push(...childIds);
  }
  return ids;
}

function applyFolderOrder(
  nodes: FolderTreeNode[],
  items: { id: string; sortOrder: number }[]
): FolderTreeNode[] {
  const orderMap = new Map(items.map((item) => [item.id, item.sortOrder]));

  const visit = (current: FolderTreeNode[]): FolderTreeNode[] => {
    const hasTarget = current.some((node) => orderMap.has(node.id));
    const next = current.map((node) => ({
      ...node,
      children: visit(node.children),
    }));

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

function removeHostFromFolders(nodes: FolderTreeNode[], id: string): FolderTreeNode[] {
  return nodes.map((folder) => ({
    ...folder,
    hosts: folder.hosts.filter((host) => host.id !== id),
    children: removeHostFromFolders(folder.children, id),
  }));
}

function folderTreeHasHost(nodes: FolderTreeNode[], id: string): boolean {
  return nodes.some(
    (folder) =>
      folder.hosts.some((host) => host.id === id) || folderTreeHasHost(folder.children, id)
  );
}

let fetchGroupedHostsRequestId = 0;

function hasGroupedAppMembers(folders: FolderTreeNode[]): boolean {
  return folders.some(
    (folder) => folder.hosts.some(isAppMember) || hasGroupedAppMembers(folder.children)
  );
}

function withoutFolderAppMembers(folders: FolderTreeNode[]): FolderTreeNode[] {
  return folders.map((folder) => ({
    ...folder,
    hosts: withoutAppMembers(folder.hosts),
    children: withoutFolderAppMembers(folder.children),
  }));
}

/** Routes in apps show on their app's page, not here (the server already leaves them out). */
export function withoutGroupedAppMembers(
  response: GroupedProxyHostsResponse
): GroupedProxyHostsResponse {
  if (!response.ungroupedHosts.some(isAppMember) && !hasGroupedAppMembers(response.folders)) {
    return response;
  }
  const ungroupedHosts = withoutAppMembers(response.ungroupedHosts);
  const folders = withoutFolderAppMembers(response.folders);
  const count = (nodes: FolderTreeNode[]): number =>
    nodes.reduce((total, folder) => total + folder.hosts.length + count(folder.children), 0);
  return { folders, ungroupedHosts, totalHosts: ungroupedHosts.length + count(folders) };
}

export const useFolderStore = create<FolderState>()((set, get) => ({
  ...(() => {
    const initialExpanded = new Set(loadExpandedFolderIds());
    return {
      expandedFolderIds: initialExpanded,
      savedExpandedFolderIds: initialExpanded,
    };
  })(),
  folders: [],
  ungroupedHosts: [],
  totalHosts: 0,
  isLoading: true,
  error: null,
  filters: { ...defaultFilters },

  fetchGroupedHosts: async () => {
    const requestId = ++fetchGroupedHostsRequestId;
    const { filters } = get();
    const isDefaultFilters =
      !filters.search && filters.type === "all" && filters.healthStatus === "all";

    // Show cached data instantly for default filters
    if (isDefaultFilters && get().folders.length === 0) {
      const cachedResponse = api.getCached<GroupedProxyHostsResponse>("proxy:grouped");
      const cached = cachedResponse ? withoutGroupedAppMembers(cachedResponse) : undefined;
      if (cached)
        set({
          folders: cached.folders,
          ungroupedHosts: cached.ungroupedHosts,
          totalHosts: cached.totalHosts,
        });
    }

    const hasData = get().folders.length > 0 || get().ungroupedHosts.length > 0;
    set({ isLoading: !hasData, error: null });
    try {
      const response = withoutGroupedAppMembers(
        await api.getGroupedProxyHosts({
          search: filters.search || undefined,
          type: filters.type !== "all" ? filters.type : undefined,
          healthStatus: filters.healthStatus !== "all" ? filters.healthStatus : undefined,
          ...NORMAL_LIST_FILTER,
        })
      );
      if (requestId !== fetchGroupedHostsRequestId) return;
      if (isDefaultFilters) api.setCache("proxy:grouped", response);
      set((state) => {
        let expandedFolderIds = state.expandedFolderIds;

        // When searching, auto-expand folders with matches
        if (filters.search) {
          const matchingFolderIds = collectFoldersWithHosts(response.folders);
          expandedFolderIds = new Set([...state.savedExpandedFolderIds, ...matchingFolderIds]);
        } else {
          expandedFolderIds = new Set(state.savedExpandedFolderIds);
        }

        return {
          folders: response.folders,
          ungroupedHosts: response.ungroupedHosts,
          totalHosts: response.totalHosts,
          isLoading: false,
          expandedFolderIds,
        };
      });
    } catch (err) {
      if (requestId !== fetchGroupedHostsRequestId) return;
      const message = err instanceof Error ? err.message : "Failed to fetch routes";
      set({ error: message, isLoading: false });
    }
  },

  removeHost: (id) =>
    set((state) => {
      const existed =
        state.ungroupedHosts.some((host) => host.id === id) || folderTreeHasHost(state.folders, id);
      return {
        folders: removeHostFromFolders(state.folders, id),
        ungroupedHosts: state.ungroupedHosts.filter((host) => host.id !== id),
        totalHosts: existed ? Math.max(0, state.totalHosts - 1) : state.totalHosts,
      };
    }),

  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    }));
    get().fetchGroupedHosts();
  },

  resetFilters: () => {
    set({ filters: { ...defaultFilters } });
    get().fetchGroupedHosts();
  },

  createFolder: async (name, parentId) => {
    const folder = await api.createFolder({ name, parentId });
    // Auto-expand parent so the new folder is visible
    if (parentId) {
      set((state) => {
        const next = new Set(state.savedExpandedFolderIds);
        next.add(parentId);
        saveExpandedFolderIds(next);
        return { expandedFolderIds: new Set(next), savedExpandedFolderIds: next };
      });
    }
    await get().fetchGroupedHosts();
    return folder;
  },

  renameFolder: async (id, name) => {
    await api.updateFolder(id, { name });
    await get().fetchGroupedHosts();
  },

  deleteFolder: async (id) => {
    await api.deleteFolder(id);
    set((state) => {
      const next = new Set(state.savedExpandedFolderIds);
      next.delete(id);
      saveExpandedFolderIds(next);
      return { expandedFolderIds: new Set(next), savedExpandedFolderIds: next };
    });
    await get().fetchGroupedHosts();
  },

  reorderFolders: async (items) => {
    const previousFolders = get().folders;
    set({ folders: applyFolderOrder(previousFolders, items) });
    try {
      await api.reorderFolders(items);
      await get().fetchGroupedHosts();
    } catch (err) {
      set({ folders: previousFolders });
      throw err;
    }
  },

  moveFolder: async (id, parentId) => {
    await api.moveFolder(id, parentId);
    await get().fetchGroupedHosts();
  },

  moveHostsToFolder: async (hostIds, folderId) => {
    await api.moveHostsToFolder(hostIds, folderId);
    await get().fetchGroupedHosts();
  },

  reorderHosts: async (items) => {
    await api.reorderHosts(items);
    await get().fetchGroupedHosts();
  },

  toggleFolder: (id) => {
    set((state) => {
      const next = new Set(state.savedExpandedFolderIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      saveExpandedFolderIds(next);
      return { expandedFolderIds: new Set(next), savedExpandedFolderIds: next };
    });
  },

  expandAll: () => {
    const { folders } = get();
    const next = new Set(collectFolderIds(folders));
    saveExpandedFolderIds(next);
    set({ expandedFolderIds: new Set(next), savedExpandedFolderIds: next });
  },

  collapseAll: () => {
    const next = new Set<string>();
    saveExpandedFolderIds(next);
    set({ expandedFolderIds: next, savedExpandedFolderIds: next });
  },
}));
