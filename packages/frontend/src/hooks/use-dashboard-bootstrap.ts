import { useEffect, useMemo } from "react";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { usePinnedStorageStore } from "@/stores/pinned-storage";
import { useUIStore } from "@/stores/ui";
import type { DashboardBootstrapRequest, DashboardPinnedDockerResourceRequest } from "@/types";

type PinnedDockerMeta = {
  nodeId: string;
  name?: string;
  kind?: DashboardPinnedDockerResourceRequest["kind"];
  scopeResourceId?: string;
};

export interface DashboardBootstrapInputs {
  userId: string;
  scopes: readonly string[];
  showSystemCertificates: boolean;
  showUpdateNotifications: boolean;
  dashboard: {
    nodeIds: string[];
    proxyHostIds: string[];
    databaseIds: string[];
    dockerIds: string[];
  };
  sidebar: {
    nodeIds: string[];
    proxyHostIds: string[];
    databaseIds: string[];
    storageIds: string[];
    dockerIds: string[];
  };
  dockerMeta: Record<string, PinnedDockerMeta | undefined>;
}

/**
 * The cache key of a dashboard bootstrap snapshot. Every place that loads the
 * snapshot (dashboard, sidebar, lite sidebar) must use this one key: two
 * different keys for the same data make each load replace the other's
 * snapshot, and the loads never settle.
 */
export function dashboardBootstrapKey(inputs: Omit<DashboardBootstrapInputs, "dockerMeta">) {
  return JSON.stringify({
    userId: inputs.userId,
    scopes: [...inputs.scopes].sort(),
    showSystemCertificates: inputs.showSystemCertificates,
    showUpdateNotifications: inputs.showUpdateNotifications,
    dashboard: inputs.dashboard,
    sidebar: inputs.sidebar,
  });
}

function dockerResources(
  ids: string[],
  meta: DashboardBootstrapInputs["dockerMeta"]
): DashboardPinnedDockerResourceRequest[] {
  return ids.flatMap((id) => {
    const item = meta[id];
    const kind = item?.kind ?? "container";
    return item
      ? [
          {
            id,
            nodeId: item.nodeId,
            kind,
            scopeResourceId: item.scopeResourceId,
            // A container pin is keyed by node and name: the server finds the container by its name.
            ...(kind === "container" && item.name ? { name: item.name } : {}),
          },
        ]
      : [];
  });
}

/** The key and request body of the dashboard bootstrap for the given pins and preferences. */
export function buildDashboardBootstrapRequest(inputs: DashboardBootstrapInputs): {
  key: string;
  request: DashboardBootstrapRequest;
} {
  return {
    key: dashboardBootstrapKey(inputs),
    request: {
      showSystemCertificates: inputs.showSystemCertificates,
      showUpdateNotifications: inputs.showUpdateNotifications,
      pins: {
        dashboard: {
          nodeIds: inputs.dashboard.nodeIds,
          proxyHostIds: inputs.dashboard.proxyHostIds,
          databaseIds: inputs.dashboard.databaseIds,
          dockerResources: dockerResources(inputs.dashboard.dockerIds, inputs.dockerMeta),
        },
        sidebar: {
          nodeIds: inputs.sidebar.nodeIds,
          proxyHostIds: inputs.sidebar.proxyHostIds,
          databaseIds: inputs.sidebar.databaseIds,
          storageIds: inputs.sidebar.storageIds,
          dockerResources: dockerResources(inputs.sidebar.dockerIds, inputs.dockerMeta),
        },
      },
    },
  };
}

/** The current user's dashboard bootstrap key and request, or null when signed out. */
export function useDashboardBootstrapRequest() {
  const user = useAuthStore((s) => s.user);
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showUpdateNotifications = useUIStore((s) => s.showUpdateNotifications);
  const dashboardNodeIds = usePinnedNodesStore((s) => s.dashboardNodeIds);
  const sidebarNodeIds = usePinnedNodesStore((s) => s.sidebarNodeIds);
  const dashboardProxyIds = usePinnedProxiesStore((s) => s.dashboardProxyIds);
  const sidebarProxyIds = usePinnedProxiesStore((s) => s.sidebarProxyIds);
  const dashboardDatabaseIds = usePinnedDatabasesStore((s) => s.dashboardDatabaseIds);
  const sidebarDatabaseIds = usePinnedDatabasesStore((s) => s.sidebarDatabaseIds);
  const sidebarStorageIds = usePinnedStorageStore((s) => s.sidebarStorageIds);
  const dashboardContainerIds = usePinnedContainersStore((s) => s.dashboardContainerIds);
  const sidebarContainerIds = usePinnedContainersStore((s) => s.sidebarContainerIds);
  const containerMeta = usePinnedContainersStore((s) => s.containerMeta);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const userId = user?.id ?? null;
  const scopes = user?.scopes;

  return useMemo(
    () =>
      userId
        ? buildDashboardBootstrapRequest({
            userId,
            scopes: scopes ?? [],
            showSystemCertificates,
            showUpdateNotifications,
            dashboard: {
              nodeIds: dashboardNodeIds,
              proxyHostIds: dashboardProxyIds,
              databaseIds: dashboardDatabaseIds,
              dockerIds: dashboardContainerIds,
            },
            sidebar: {
              nodeIds: sidebarNodeIds,
              proxyHostIds: sidebarProxyIds,
              databaseIds: sidebarDatabaseIds,
              storageIds: sidebarStorageIds,
              dockerIds: sidebarContainerIds,
            },
            dockerMeta: containerMeta,
          })
        : null,
    [
      containerMeta,
      dashboardContainerIds,
      dashboardDatabaseIds,
      dashboardNodeIds,
      dashboardProxyIds,
      scopes,
      showSystemCertificates,
      showUpdateNotifications,
      sidebarContainerIds,
      sidebarDatabaseIds,
      sidebarNodeIds,
      sidebarProxyIds,
      sidebarStorageIds,
      userId,
    ]
  );
}

/**
 * Loads the shared dashboard bootstrap snapshot for the current user. Pinned
 * resource metadata can change the request body without changing the key; the
 * store then keeps the snapshot it has instead of fetching again.
 */
export function useLoadDashboardBootstrap(enabled = true) {
  const bootstrap = useDashboardBootstrapRequest();
  const load = useDashboardBootstrapStore((s) => s.load);

  useEffect(() => {
    if (!enabled || !bootstrap) return;
    void load(bootstrap.key, bootstrap.request);
  }, [bootstrap, enabled, load]);
}
