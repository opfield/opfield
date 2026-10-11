import { Box, Boxes, Database, GitBranch, Globe, Server } from "lucide-react";
import { useCallback, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  databaseHealthTone,
  dockerStateTone,
  isDockerStateTransitional,
  nodeStatusTone,
  proxyHealthTone,
  type StatusTone,
  statusDotClass,
} from "@/components/common/resource-status";
import { Separator } from "@/components/ui/separator";
import { useLoadDashboardBootstrap } from "@/hooks/use-dashboard-bootstrap";
import {
  databaseRoute,
  dockerComposeProjectRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  nodeRoute,
  proxyHostRoute,
  storageRoute,
} from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";
import { usePinnedStorageStore } from "@/stores/pinned-storage";
import { effectiveNodeStatus } from "@/types";
import { SIDEBAR_ITEM_FADE, SIDEBAR_ITEM_FILL, SIDEBAR_ITEM_HOVER_FILL } from "./sidebar-item-fill";

/**
 * A pinned node's dot: any state that is not settled (pending, enrolling,
 * updating and so on) shows the solid warning colour, as it always did here.
 */
function pinnedNodeTone(status: string | null | undefined): StatusTone {
  const tone = nodeStatusTone(status);
  return tone === "secondary" ? "warning" : tone;
}

interface SidebarPinnedResourcesProps {
  onNavigate?: () => void;
  /** Lite mode has no SidebarContent to request the shared snapshot. */
  loadBootstrap?: boolean;
}

export function SidebarPinnedResources({
  onNavigate,
  loadBootstrap = false,
}: SidebarPinnedResourcesProps) {
  const location = useLocation();
  const { hasScope } = useAuthStore();
  const sidebarPinnedNodeIds = usePinnedNodesStore((s) => s.sidebarNodeIds);
  const sidebarPinnedProxyIds = usePinnedProxiesStore((s) => s.sidebarProxyIds);
  const sidebarPinnedDatabaseIds = usePinnedDatabasesStore((s) => s.sidebarDatabaseIds);
  const sidebarPinnedStorageIds = usePinnedStorageStore((s) => s.sidebarStorageIds);
  const pinnedDatabaseMeta = usePinnedDatabasesStore((s) => s.databaseMeta);
  const sidebarPinnedContainerIds = usePinnedContainersStore((s) => s.sidebarContainerIds);
  const pinnedContainerMeta = usePinnedContainersStore((s) => s.containerMeta);
  const dashboardBootstrap = useDashboardBootstrapStore((s) => s.snapshot);
  const canViewDockerResource = useCallback(
    (
      nodeId: string,
      scopeResourceId?: string,
      scopeBase: "docker:containers:view" | "docker:compose:view" = "docker:containers:view"
    ) =>
      hasScope(scopeBase) ||
      hasScope(`${scopeBase}:${nodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`),
    [hasScope]
  );
  const canViewDatabaseDetails = useCallback(
    (databaseId: string) => hasScope("databases:view") || hasScope(`databases:view:${databaseId}`),
    [hasScope]
  );
  useLoadDashboardBootstrap(loadBootstrap);

  useEffect(() => {
    for (const database of dashboardBootstrap?.pinned.sidebar.databases ?? []) {
      usePinnedDatabasesStore.getState().updateMeta(database.id, {
        slug: database.slug,
        name: database.name,
        type: database.type,
        healthStatus: database.healthStatus ?? undefined,
      });
    }
    for (const resource of dashboardBootstrap?.pinned.sidebar.dockerResources ?? []) {
      usePinnedContainersStore.getState().updateMeta(resource.id, resource);
    }
  }, [dashboardBootstrap]);

  const pinnedNodes = dashboardBootstrap?.pinned.sidebar.nodes ?? [];
  const pinnedProxies = dashboardBootstrap?.pinned.sidebar.proxies ?? [];
  const sidebarPinCount =
    sidebarPinnedNodeIds.length +
    sidebarPinnedProxyIds.length +
    sidebarPinnedDatabaseIds.length +
    sidebarPinnedStorageIds.length +
    sidebarPinnedContainerIds.length;
  const canPotentiallyViewPinned =
    sidebarPinnedNodeIds.some(
      (id) => hasScope("nodes:details") || hasScope(`nodes:details:${id}`)
    ) ||
    sidebarPinnedProxyIds.some((id) => hasScope("proxy:view") || hasScope(`proxy:view:${id}`)) ||
    sidebarPinnedDatabaseIds.some((id) => canViewDatabaseDetails(id)) ||
    sidebarPinnedStorageIds.some((id) => hasScope(`storage:view:${id}`)) ||
    sidebarPinnedContainerIds.some((id) => {
      const meta = pinnedContainerMeta[id];
      return meta
        ? canViewDockerResource(meta.nodeId, meta.scopeResourceId, meta.scopeBase)
        : hasScope("docker:containers:view");
    });
  // Pin placement is local, while resource visibility is server-authoritative.
  // Keep only a neutral, permission-gated structure until the sidebar
  // projection arrives; names and statuses never appear optimistically.
  if (!dashboardBootstrap) {
    if (sidebarPinCount === 0 || !canPotentiallyViewPinned) return null;
    return (
      <>
        <nav
          className="space-y-0.5 px-2 py-2"
          aria-busy="true"
          aria-label="Loading pinned resources"
        >
          <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Pinned Items
          </p>
          {/* Rows keep the height of the pinned links they stand in for. */}
          {Array.from({ length: sidebarPinCount }, (_, index) => (
            <div key={index} className="h-9" />
          ))}
        </nav>
        <Separator />
      </>
    );
  }

  const hasPinnedResources =
    pinnedNodes.length > 0 ||
    pinnedProxies.length > 0 ||
    sidebarPinnedDatabaseIds.length > 0 ||
    (dashboardBootstrap?.pinned.sidebar.storages?.length ?? 0) > 0 ||
    sidebarPinnedContainerIds.length > 0;

  if (!hasPinnedResources) return null;

  const linkClass = (active: boolean) =>
    cn(
      "flex items-center gap-3 overflow-hidden whitespace-nowrap px-3 py-2 text-sm",
      SIDEBAR_ITEM_FADE,
      active
        ? cn(SIDEBAR_ITEM_FILL, "font-medium text-sidebar-accent-foreground")
        : cn(
            SIDEBAR_ITEM_HOVER_FILL,
            "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
          )
    );
  const statusDot = (
    status: string | null | undefined,
    kind: "proxy" | "node" | "database" | "docker"
  ) => {
    const tone =
      kind === "proxy"
        ? proxyHealthTone(status)
        : kind === "node"
          ? pinnedNodeTone(status)
          : kind === "database"
            ? databaseHealthTone(status)
            : dockerStateTone(status);
    return cn(
      "ml-auto h-2 w-2 shrink-0",
      statusDotClass(tone),
      kind === "docker" && isDockerStateTransitional(status) && "animate-pulse"
    );
  };

  return (
    <>
      <nav className="space-y-0.5 px-2 py-2" aria-label="Pinned resources">
        <p className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pinned Items
        </p>
        {pinnedProxies.map((proxy) => {
          const path = proxyHostRoute(proxy.slug);
          const health = (proxy as any).effectiveHealthStatus ?? proxy.healthStatus;
          return (
            <Link
              key={proxy.id}
              to={path}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Globe className="h-4 w-4 shrink-0" />
              <span className="truncate">{proxy.domainNames[0]}</span>
              <span className={statusDot(health, "proxy")} />
            </Link>
          );
        })}
        {pinnedNodes.map((node) => {
          const path = nodeRoute(node.slug);
          return (
            <Link
              key={node.id}
              to={path}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Server className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.displayName || node.hostname}</span>
              <span className={statusDot(effectiveNodeStatus(node), "node")} />
            </Link>
          );
        })}
        {sidebarPinnedDatabaseIds.map((databaseId) => {
          const meta = pinnedDatabaseMeta[databaseId];
          if (!meta?.slug || !canViewDatabaseDetails(databaseId)) return null;
          const path = databaseRoute(meta.slug);
          return (
            <Link
              key={databaseId}
              to={databaseRoute(meta.slug, "overview")}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Database className="h-4 w-4 shrink-0" />
              <span className="truncate">{meta.name}</span>
              <span className={statusDot(meta.healthStatus, "database")} />
            </Link>
          );
        })}
        {(dashboardBootstrap.pinned.sidebar.storages ?? []).map((storage) => {
          const path = storageRoute(storage);
          if (!hasScope(`storage:view:${storage.id}`)) return null;
          return (
            <Link
              key={`storage:${storage.id}`}
              to={path}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Database className="h-4 w-4 shrink-0" />
              <span className="truncate">{storage.name}</span>
              <span className={statusDot(storage.healthStatus, "database")} />
            </Link>
          );
        })}
        {sidebarPinnedContainerIds.map((id) => {
          const meta = pinnedContainerMeta[id];
          if (
            !meta?.nodeSlug ||
            !canViewDockerResource(meta.nodeId, meta.scopeResourceId, meta.scopeBase)
          )
            return null;
          const path =
            meta.kind === "deployment"
              ? dockerDeploymentRoute(meta.nodeSlug, meta.name)
              : meta.kind === "compose"
                ? dockerComposeProjectRoute(id)
                : dockerContainerRoute(meta.nodeSlug, meta.name);
          const Icon =
            meta.kind === "deployment" ? GitBranch : meta.kind === "compose" ? Boxes : Box;
          return (
            <Link
              key={id}
              to={path}
              onClick={onNavigate}
              className={linkClass(
                location.pathname === path || location.pathname.startsWith(`${path}/`)
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{meta.name}</span>
              <span className={statusDot(meta.state, "docker")} />
            </Link>
          );
        })}
      </nav>
      <Separator />
    </>
  );
}
