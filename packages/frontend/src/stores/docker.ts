import { create } from "zustand";
import { type AppMemberListFilter, NORMAL_LIST_FILTER } from "@/lib/app-members";
import { filterUserDockerNetworks } from "@/lib/docker-networks";
import { api } from "@/services/api";
import type {
  DockerComposeProjectSummary,
  DockerContainer,
  DockerFolderResourceType,
  DockerImage,
  DockerNetwork,
  DockerRegistry,
  DockerTask,
  DockerVolume,
  Node,
  NodeAppearanceColor,
} from "@/types";
import { isNodeIncompatible } from "@/types";

async function attachFolderPlacements<T extends object>(
  resourceType: Exclude<DockerFolderResourceType, "container">,
  items: T[],
  getResourceKey: (item: T) => string | undefined
): Promise<T[]> {
  const refs = items
    .map((item) => ({
      nodeId: (item as { _nodeId?: string })._nodeId,
      resourceKey: getResourceKey(item),
    }))
    .filter(
      (item): item is { nodeId: string; resourceKey: string } => !!item.nodeId && !!item.resourceKey
    );
  if (refs.length === 0) return items;

  const placements = await api.getDockerFolderPlacements(resourceType, refs);
  const placementByRef = new Map(
    placements.map((placement) => [`${placement.nodeId}:${placement.resourceKey}`, placement])
  );

  return items.map((item) => {
    const nodeId = (item as { _nodeId?: string })._nodeId;
    const resourceKey = getResourceKey(item);
    const placement = nodeId && resourceKey ? placementByRef.get(`${nodeId}:${resourceKey}`) : null;
    return {
      ...item,
      folderId: placement?.folderId ?? null,
      folderIsSystem: placement?.folderIsSystem ?? false,
      folderSortOrder: placement?.sortOrder ?? 0,
    };
  });
}

const dockerImageResourceKey = (image: DockerImage) => image.id;
const dockerVolumeResourceKey = (volume: DockerVolume) => volume.name;
const dockerNetworkResourceKey = (network: DockerNetwork) => network.id;
const dockerComposeResourceKey = (project: DockerComposeProjectSummary) => project.id;

interface DockerFilters {
  search: string;
  status: string;
}

type DockerResource =
  | "containers"
  | "images"
  | "volumes"
  | "networks"
  | "compose"
  | "tasks"
  | "registries";

interface DockerState {
  containers: DockerContainer[];
  containersByScope: Record<string, DockerContainer[]>;
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  composeProjects: DockerComposeProjectSummary[];
  tasks: DockerTask[];
  registries: DockerRegistry[];
  /** null = all nodes */
  selectedNodeId: string | null;
  /** Cached docker nodes for multi-node fetching */
  dockerNodes: Node[];
  dockerNodesLoaded: boolean;
  filters: DockerFilters;
  loading: Record<DockerResource, boolean>;
  /** Deprecated aggregate loading state kept for older selectors. */
  isLoading: boolean;

  setSelectedNode: (nodeId: string | null) => void;
  setDockerNodes: (nodes: Node[]) => void;
  syncNodeAppearance: (
    node: Pick<Node, "id" | "slug"> &
      Partial<Pick<Node, "displayName" | "hostname" | "appearanceColor">>
  ) => void;
  setFilters: (filters: Partial<DockerFilters>) => void;
  resetFilters: () => void;

  fetchContainers: (
    nodeIdOverride?: string | null,
    searchOverride?: string,
    nodesOverride?: Node[]
  ) => Promise<void>;
  /** Fetch containers bypassing API cache — use during transitions */
  forceFetchContainers: (nodeIdOverride?: string | null, searchOverride?: string) => Promise<void>;
  fetchImages: (
    nodeIdOverride?: string | null,
    searchOverride?: string,
    nodesOverride?: Node[]
  ) => Promise<void>;
  fetchVolumes: (
    nodeIdOverride?: string | null,
    searchOverride?: string,
    nodesOverride?: Node[]
  ) => Promise<void>;
  fetchNetworks: (
    nodeIdOverride?: string | null,
    searchOverride?: string,
    nodesOverride?: Node[]
  ) => Promise<void>;
  /** `filter` defaults to the normal list's (no app members); a node's view passes `{}`. */
  fetchComposeProjects: (
    nodeIdOverride?: string | null,
    filter?: AppMemberListFilter
  ) => Promise<void>;
  fetchTasks: (nodeIdOverride?: string | null) => Promise<void>;
  fetchRegistries: () => Promise<void>;
  requestSnapshotRefresh: (
    resource: "containers" | "images" | "volumes" | "networks",
    nodeId?: string | null
  ) => Promise<void>;

  invalidate: (...resources: DockerResource[]) => Promise<void>;
}

const GLOBAL_DOCKER_SCOPE = "__global__";

function dockerContainerScope(nodeId: string | null | undefined, search?: string) {
  const base = nodeId ?? GLOBAL_DOCKER_SCOPE;
  const q = search?.trim();
  return q ? `${base}:search:${q}` : base;
}

function dockerSnapshotCacheKey(
  resource: "containers" | "images" | "volumes" | "networks" | "tasks",
  nodeId: string | null | undefined,
  search?: string
) {
  return `docker:snapshots:${resource}:${dockerContainerScope(nodeId, search)}`;
}

function filterCachedContainers(items: DockerContainer[], nodeId?: string | null, search?: string) {
  const query = search?.trim().toLowerCase();
  return items.filter((container) => {
    const tagged = container as DockerContainer & { _nodeId?: string };
    if (nodeId && tagged._nodeId !== nodeId) return false;
    if (!query) return true;
    return (
      container.name.toLowerCase().includes(query) ||
      (container.image ?? "").toLowerCase().includes(query) ||
      container.id.toLowerCase().includes(query)
    );
  });
}

function cachedContainersForScope(
  state: Pick<DockerState, "containers" | "containersByScope" | "selectedNodeId">,
  nodeId?: string | null,
  search?: string
) {
  const direct = state.containersByScope[dockerContainerScope(nodeId, search)];
  if (direct) return direct;

  const searchedGlobal = state.containersByScope[dockerContainerScope(null, search)];
  const global =
    searchedGlobal ??
    state.containersByScope[GLOBAL_DOCKER_SCOPE] ??
    (state.selectedNodeId === null ? state.containers : undefined);
  if (!global) return undefined;

  return filterCachedContainers(global, nodeId, searchedGlobal ? undefined : search);
}

const dockerRequestIds = {
  containers: 0,
  images: 0,
  volumes: 0,
  networks: 0,
  compose: 0,
  tasks: 0,
  registries: 0,
};
const inFlightContainerRequests = new Map<string, Promise<void>>();

const initialLoading: Record<DockerResource, boolean> = {
  containers: false,
  images: false,
  volumes: false,
  networks: false,
  compose: false,
  tasks: false,
  registries: false,
};

function loadingState(
  current: Record<DockerResource, boolean>,
  resource: DockerResource,
  value: boolean
) {
  const loading = { ...current, [resource]: value };
  return {
    loading,
    isLoading: Object.values(loading).some(Boolean),
  };
}

export const useDockerStore = create<DockerState>()((set, get) => ({
  containers: [],
  containersByScope: {},
  images: [],
  volumes: [],
  networks: [],
  composeProjects: [],
  tasks: [],
  registries: [],
  selectedNodeId: null,
  dockerNodes: [],
  dockerNodesLoaded: false,
  filters: { search: "", status: "all" },
  loading: initialLoading,
  isLoading: false,

  setSelectedNode: (nodeId) => {
    set((state) => {
      const cached = cachedContainersForScope(state, nodeId, state.filters.search);
      return {
        selectedNodeId: nodeId,
        containers: cached ?? (nodeId === state.selectedNodeId ? state.containers : []),
      };
    });
  },

  setDockerNodes: (nodes) =>
    set((state) => {
      const dockerNodes = nodes.filter(
        (n) => n.status === "online" && n.isConnected && !isNodeIncompatible(n)
      );
      return {
        dockerNodes,
        selectedNodeId: dockerNodes.some((node) => node.id === state.selectedNodeId)
          ? state.selectedNodeId
          : null,
        dockerNodesLoaded: true,
      };
    }),

  syncNodeAppearance: (node) =>
    set((state) => {
      type NodeTaggedRow = {
        _nodeId?: string;
        _nodeSlug?: string;
        _nodeName?: string;
        _nodeColor?: NodeAppearanceColor | null;
      };
      const hasNodeName = node.displayName !== undefined || node.hostname !== undefined;
      const nodeName = hasNodeName ? node.displayName || node.hostname || "" : undefined;
      const hasAppearanceColor = node.appearanceColor !== undefined;
      const patchNodeRow = <T extends object>(item: T): T => {
        const tagged = item as T & NodeTaggedRow;
        return tagged._nodeId === node.id
          ? {
              ...tagged,
              _nodeSlug: node.slug,
              ...(hasNodeName ? { _nodeName: nodeName } : {}),
              ...(hasAppearanceColor ? { _nodeColor: node.appearanceColor } : {}),
            }
          : item;
      };

      return {
        dockerNodes: state.dockerNodes.map((dockerNode) =>
          dockerNode.id === node.id ? { ...dockerNode, ...node, slug: node.slug } : dockerNode
        ),
        containers: state.containers.map(patchNodeRow),
        containersByScope: Object.fromEntries(
          Object.entries(state.containersByScope).map(([scope, containers]) => [
            scope,
            containers.map(patchNodeRow),
          ])
        ),
        images: state.images.map(patchNodeRow),
        volumes: state.volumes.map(patchNodeRow),
        networks: state.networks.map(patchNodeRow),
      };
    }),

  setFilters: (newFilters) => {
    set((state) => ({ filters: { ...state.filters, ...newFilters } }));
  },

  resetFilters: () => {
    set({ filters: { search: "", status: "all" } });
  },

  fetchContainers: async (nodeIdOverride, searchOverride, _nodesOverride) => {
    const { selectedNodeId, filters } = get();
    const effectiveNodeId = nodeIdOverride ?? selectedNodeId;
    const search = searchOverride ?? filters.search;
    const scope = dockerContainerScope(effectiveNodeId, search);
    const existingRequest = inFlightContainerRequests.get(scope);
    if (existingRequest) return existingRequest;

    const request = (async () => {
      const requestId = ++dockerRequestIds.containers;
      const cacheKey = dockerSnapshotCacheKey("containers", effectiveNodeId, search);
      const cached =
        cachedContainersForScope(get(), effectiveNodeId, search) ??
        api.getCached<DockerContainer[]>(cacheKey, Number.POSITIVE_INFINITY);
      set((state) => ({
        containers: cached ?? [],
        ...loadingState(state.loading, "containers", !cached),
      }));
      try {
        // The Docker lists leave app members to their app's page.
        const items = await api.listDockerContainerSnapshots({
          nodeId: effectiveNodeId ?? undefined,
          search,
          ...NORMAL_LIST_FILTER,
        });
        if (requestId !== dockerRequestIds.containers) return;
        api.setCache(cacheKey, items);
        set((state) => ({
          containers: items,
          containersByScope: { ...state.containersByScope, [scope]: items },
          ...loadingState(state.loading, "containers", false),
        }));
      } catch {
        if (requestId !== dockerRequestIds.containers) return;
        set((state) => loadingState(state.loading, "containers", false));
      }
    })();
    inFlightContainerRequests.set(scope, request);
    try {
      await request;
    } finally {
      if (inFlightContainerRequests.get(scope) === request) {
        inFlightContainerRequests.delete(scope);
      }
    }
  },

  forceFetchContainers: async (nodeIdOverride, searchOverride) => {
    const { selectedNodeId, filters } = get();
    const effectiveNodeId = nodeIdOverride ?? selectedNodeId;
    const search = searchOverride ?? filters.search;
    const scope = dockerContainerScope(effectiveNodeId, search);
    const existingRequest = inFlightContainerRequests.get(scope);
    if (existingRequest) return existingRequest;

    const request = (async () => {
      const requestId = ++dockerRequestIds.containers;
      const cacheKey = dockerSnapshotCacheKey("containers", effectiveNodeId, search);
      const cached = cachedContainersForScope(get(), effectiveNodeId, search);
      set((state) => ({
        containers: cached ?? [],
        ...loadingState(state.loading, "containers", !cached),
      }));
      try {
        // The Docker lists leave app members to their app's page.
        const items = await api.listDockerContainerSnapshots({
          nodeId: effectiveNodeId ?? undefined,
          search,
          ...NORMAL_LIST_FILTER,
        });
        if (requestId !== dockerRequestIds.containers) return;
        api.setCache(cacheKey, items);
        set((state) => ({
          containers: items,
          containersByScope: { ...state.containersByScope, [scope]: items },
          ...loadingState(state.loading, "containers", false),
        }));
      } catch {
        if (requestId !== dockerRequestIds.containers) return;
        set((state) => loadingState(state.loading, "containers", false));
      }
    })();
    inFlightContainerRequests.set(scope, request);
    try {
      await request;
    } finally {
      if (inFlightContainerRequests.get(scope) === request) {
        inFlightContainerRequests.delete(scope);
      }
    }
  },

  fetchImages: async (nodeIdOverride, searchOverride, _nodesOverride) => {
    const requestId = ++dockerRequestIds.images;
    const { selectedNodeId, filters } = get();
    const effectiveNodeId = nodeIdOverride ?? selectedNodeId;
    const search = searchOverride ?? filters.search;
    const cacheKey = dockerSnapshotCacheKey("images", effectiveNodeId, search);
    const cached = api.getCached<DockerImage[]>(cacheKey, Number.POSITIVE_INFINITY);
    if (cached) set({ images: cached });
    set((state) => loadingState(state.loading, "images", !cached && get().images.length === 0));
    try {
      const tagged = await api.listDockerImageSnapshots({
        nodeId: effectiveNodeId ?? undefined,
        search,
      });
      const items = await attachFolderPlacements("image", tagged, dockerImageResourceKey);
      if (requestId !== dockerRequestIds.images) return;
      api.setCache(cacheKey, items);
      set((state) => ({ images: items, ...loadingState(state.loading, "images", false) }));
    } catch {
      if (requestId !== dockerRequestIds.images) return;
      set((state) => loadingState(state.loading, "images", false));
    }
  },

  fetchVolumes: async (nodeIdOverride, searchOverride, _nodesOverride) => {
    const requestId = ++dockerRequestIds.volumes;
    const { selectedNodeId, filters } = get();
    const effectiveNodeId = nodeIdOverride ?? selectedNodeId;
    const search = searchOverride ?? filters.search;
    const cacheKey = dockerSnapshotCacheKey("volumes", effectiveNodeId, search);
    const cached = api.getCached<DockerVolume[]>(cacheKey, Number.POSITIVE_INFINITY);
    if (cached) set({ volumes: cached });
    set((state) => loadingState(state.loading, "volumes", !cached && get().volumes.length === 0));
    try {
      const tagged = await api.listDockerVolumeSnapshots({
        nodeId: effectiveNodeId ?? undefined,
        search,
      });
      const items = await attachFolderPlacements("volume", tagged, dockerVolumeResourceKey);
      if (requestId !== dockerRequestIds.volumes) return;
      api.setCache(cacheKey, items);
      set((state) => ({ volumes: items, ...loadingState(state.loading, "volumes", false) }));
    } catch {
      if (requestId !== dockerRequestIds.volumes) return;
      set((state) => loadingState(state.loading, "volumes", false));
    }
  },

  fetchNetworks: async (nodeIdOverride, searchOverride, _nodesOverride) => {
    const requestId = ++dockerRequestIds.networks;
    const { selectedNodeId, filters } = get();
    const effectiveNodeId = nodeIdOverride ?? selectedNodeId;
    const search = searchOverride ?? filters.search;
    const cacheKey = dockerSnapshotCacheKey("networks", effectiveNodeId, search);
    const cachedRaw = api.getCached<DockerNetwork[]>(cacheKey, Number.POSITIVE_INFINITY);
    const cached = cachedRaw ? filterUserDockerNetworks(cachedRaw) : undefined;
    if (cached) set({ networks: cached });
    set((state) => loadingState(state.loading, "networks", !cached && get().networks.length === 0));
    try {
      const tagged = filterUserDockerNetworks(
        await api.listDockerNetworkSnapshots({
          nodeId: effectiveNodeId ?? undefined,
          search,
        })
      );
      const items = await attachFolderPlacements("network", tagged, dockerNetworkResourceKey);
      if (requestId !== dockerRequestIds.networks) return;
      api.setCache(cacheKey, items);
      set((state) => ({ networks: items, ...loadingState(state.loading, "networks", false) }));
    } catch {
      if (requestId !== dockerRequestIds.networks) return;
      set((state) => loadingState(state.loading, "networks", false));
    }
  },

  fetchComposeProjects: async (nodeIdOverride, filter = NORMAL_LIST_FILTER) => {
    const requestId = ++dockerRequestIds.compose;
    const effectiveNodeId = nodeIdOverride ?? get().selectedNodeId;
    set((state) => loadingState(state.loading, "compose", get().composeProjects.length === 0));
    try {
      const projects = await api.listDockerComposeProjects(effectiveNodeId ?? undefined, filter);
      const placements = await attachFolderPlacements(
        "compose",
        projects.map((project) => ({ ...project, _nodeId: project.nodeId })),
        dockerComposeResourceKey
      );
      if (requestId !== dockerRequestIds.compose) return;
      const nodesById = new Map(get().dockerNodes.map((node) => [node.id, node]));
      const items = placements.map((project) => {
        const node = nodesById.get(project.nodeId);
        return {
          ...project,
          _nodeId: project.nodeId,
          _nodeSlug: node?.slug ?? project.nodeId,
          _nodeName: node?.displayName || node?.hostname || project.nodeId,
          _nodeColor: node?.appearanceColor ?? null,
        };
      });
      set((state) => ({
        composeProjects: items,
        ...loadingState(state.loading, "compose", false),
      }));
    } catch {
      if (requestId !== dockerRequestIds.compose) return;
      set((state) => loadingState(state.loading, "compose", false));
    }
  },

  fetchTasks: async (nodeIdOverride) => {
    const requestId = ++dockerRequestIds.tasks;
    const effectiveNodeId = nodeIdOverride ?? get().selectedNodeId;
    const cacheKey = dockerSnapshotCacheKey("tasks", effectiveNodeId);
    const cached = api.getCached<DockerTask[]>(cacheKey, Number.POSITIVE_INFINITY);
    if (cached) set({ tasks: cached });
    set((state) => loadingState(state.loading, "tasks", !cached && get().tasks.length === 0));
    try {
      const data = await api.listDockerTasks(
        effectiveNodeId ? { nodeId: effectiveNodeId } : undefined
      );
      if (requestId !== dockerRequestIds.tasks) return;
      api.setCache(cacheKey, data ?? []);
      set((state) => ({
        tasks: data ?? [],
        ...loadingState(state.loading, "tasks", false),
      }));
    } catch {
      if (requestId !== dockerRequestIds.tasks) return;
      set((state) => loadingState(state.loading, "tasks", false));
    }
  },

  fetchRegistries: async () => {
    const requestId = ++dockerRequestIds.registries;
    set((state) => loadingState(state.loading, "registries", get().registries.length === 0));
    try {
      const data = await api.listDockerRegistries();
      if (requestId !== dockerRequestIds.registries) return;
      set((state) => ({
        registries: data ?? [],
        ...loadingState(state.loading, "registries", false),
      }));
    } catch {
      if (requestId !== dockerRequestIds.registries) return;
      set((state) => loadingState(state.loading, "registries", false));
    }
  },

  requestSnapshotRefresh: async (resource, nodeId) => {
    await api.refreshDockerSnapshots({ resource, nodeId: nodeId ?? undefined });
  },

  invalidate: async (...resources) => {
    const s = get();
    const map: Record<string, () => Promise<void>> = {
      containers: s.fetchContainers,
      images: s.fetchImages,
      volumes: s.fetchVolumes,
      networks: s.fetchNetworks,
      compose: s.fetchComposeProjects,
      tasks: s.fetchTasks,
      registries: s.fetchRegistries,
    };
    await Promise.all(resources.map((r) => map[r]?.()));
  },
}));
