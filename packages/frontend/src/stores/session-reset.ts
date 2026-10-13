import { clearPageDeploymentsCache } from "@/lib/page-deployments";
import { api } from "@/services/api";
import { useAccessListsStore } from "@/stores/access-lists";
import { resetAIStateForAuthChange } from "@/stores/ai";
import type { AuthContextResetOptions } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useCertificatesStore } from "@/stores/certificates";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useDockerStore } from "@/stores/docker";
import { useDockerFolderStore } from "@/stores/docker-folders";
import { useFolderStore } from "@/stores/folders";
import { useNodesStore } from "@/stores/nodes";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { useProxyStore } from "@/stores/proxy";
import { useSSLStore } from "@/stores/ssl";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";

export function resetClientSessionState({ preserveShell = false }: AuthContextResetOptions = {}) {
  api.resetSessionState();
  clearPageDeploymentsCache();
  resetAIStateForAuthChange();
  useDashboardBootstrapStore.getState().clear();
  useUIBootstrapStore.getState().clear();
  if (!preserveShell) useUIStore.getState().beginInterfacePreferenceLoad();
  useUIStore.setState({ aiPanelOpen: false });

  useCAStore.setState({ cas: [], selectedCA: null, isLoading: true, error: null });
  useCertificatesStore.setState({
    certificates: [],
    selectedCertificate: null,
    isLoading: true,
    isLoadingMore: false,
    error: null,
    filters: { search: "", status: "active", type: "all", caId: "all" },
    total: 0,
    hasMore: false,
    nextPage: 1,
  });
  useSSLStore.setState({
    certificates: [],
    selectedCert: null,
    isLoading: true,
    isLoadingMore: false,
    error: null,
    filters: { search: "", type: "all", status: "active" },
    total: 0,
    hasMore: false,
    nextPage: 1,
  });
  useProxyStore.setState({
    proxyHosts: [],
    selectedProxyHost: null,
    isLoading: false,
    error: null,
    filters: { search: "", type: "all", healthStatus: "all", enabled: "all" },
    page: 1,
    total: 0,
    totalPages: 0,
  });
  useFolderStore.setState({
    folders: [],
    ungroupedHosts: [],
    totalHosts: 0,
    isLoading: true,
    error: null,
    filters: { search: "", type: "all", healthStatus: "all" },
  });
  useAccessListsStore.setState({
    accessLists: [],
    selectedAccessList: null,
    isLoading: true,
    error: null,
  });
  useDockerStore.setState({
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
    loading: {
      containers: false,
      images: false,
      volumes: false,
      networks: false,
      compose: false,
      tasks: false,
      registries: false,
    },
    isLoading: false,
  });
  useDockerFolderStore.setState({
    folders: [],
    foldersByType: { container: [], image: [], network: [], volume: [], compose: [] },
    isLoading: true,
    loadingByType: { container: true, image: true, network: true, volume: true, compose: true },
    error: null,
    errorByType: { container: null, image: null, network: null, volume: null, compose: null },
  });
  useNodesStore.setState((state) => ({
    nodes: [],
    isLoading: true,
    error: null,
    filters: { search: "", status: "all", type: "all", hosting: "all" },
    page: 1,
    total: 0,
    totalPages: 0,
    refreshTick: state.refreshTick + 1,
  }));
  usePinnedDatabasesStore.setState({
    dashboardDatabaseIds: [],
    sidebarDatabaseIds: [],
    databaseMeta: {},
  });
  usePinnedNodesStore.setState({ dashboardNodeIds: [], sidebarNodeIds: [] });
  usePinnedProxiesStore.setState({ dashboardProxyIds: [], sidebarProxyIds: [] });
  usePinnedContainersStore.setState({
    dashboardContainerIds: [],
    sidebarContainerIds: [],
    containerMeta: {},
  });
  // System feature flags/upload limits are Opfield-wide, not user-private data.
  if (!preserveShell) useSystemConfigStore.getState().reset();
}
