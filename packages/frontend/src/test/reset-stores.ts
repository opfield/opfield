import { clearPageDeploymentsCache } from "@/lib/page-deployments";
import { useAppStatusStore } from "@/stores/app-status";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useCertificatesStore } from "@/stores/certificates";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useNodesStore } from "@/stores/nodes";
import { useSSLStore } from "@/stores/ssl";
import { useUIStore } from "@/stores/ui";

export function resetTestStores() {
  localStorage.clear();
  sessionStorage.clear();

  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: true,
  });
  useDashboardBootstrapStore.getState().clear();
  clearPageDeploymentsCache();

  useAppStatusStore.setState({
    maintenanceActive: false,
    opfieldUpdatingActive: false,
    opfieldUpdatingTargetVersion: null,
    opfieldRestartingActive: false,
    opfieldRestartTargetUrl: null,
    opfieldUpdateError: null,
    rateLimitedUntil: null,
  });

  useUIStore.setState({
    theme: "system",
    resolvedTheme: "light",
    sidebarOpen: true,
    sidebarCollapsed: false,
    isMobile: false,
    mobileMenuOpen: false,
    showUpdateNotifications: true,
    showSystemCertificates: false,
    aiApprovalMode: "normal",
    commandPaletteOpen: false,
    aiPanelOpen: false,
    recentPages: [],
    modal: { type: null },
  });

  useNodesStore.setState({
    nodes: [],
    isLoading: false,
    error: null,
    filters: { search: "", status: "all", type: "all", hosting: "all" },
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
    refreshTick: 0,
  });

  useCAStore.setState({
    cas: [],
    selectedCA: null,
    isLoading: false,
    error: null,
  });

  useCertificatesStore.setState({
    certificates: [],
    selectedCertificate: null,
    isLoading: false,
    isLoadingMore: false,
    error: null,
    filters: { search: "", status: "active", type: "all", caId: "all" },
    limit: 25,
    total: 0,
    hasMore: false,
    nextPage: 1,
  });

  useSSLStore.setState({
    certificates: [],
    selectedCert: null,
    isLoading: false,
    isLoadingMore: false,
    error: null,
    filters: { search: "", type: "all", status: "active" },
    limit: 25,
    total: 0,
    hasMore: false,
    nextPage: 1,
  });
}
