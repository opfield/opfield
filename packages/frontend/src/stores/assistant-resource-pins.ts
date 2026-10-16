import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { containerPinKey, usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { usePinnedProxiesStore } from "@/stores/pinned-proxies";

type PinTarget = "dashboard" | "sidebar";
type PinResourceType =
  | "node"
  | "proxy_host"
  | "database"
  | "docker_container"
  | "docker_deployment";

type ResourcePinAction = {
  type: "set_resource_pin";
  resourceType: PinResourceType;
  resourceId: string;
  target: PinTarget;
  pinned: boolean;
  nodeId?: string;
  nodeSlug?: string;
  name?: string;
  scopeResourceId?: string;
};

function isResourcePinAction(value: unknown): value is ResourcePinAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<ResourcePinAction>;
  return (
    action.type === "set_resource_pin" &&
    typeof action.resourceId === "string" &&
    ["node", "proxy_host", "database", "docker_container", "docker_deployment"].includes(
      action.resourceType ?? ""
    ) &&
    (action.target === "dashboard" || action.target === "sidebar") &&
    typeof action.pinned === "boolean"
  );
}

function setId(ids: string[], id: string, pinned: boolean) {
  if (pinned) return ids.includes(id) ? ids : [...ids, id];
  return ids.filter((value) => value !== id);
}

/** Applies the embedded Assistant's local-only resource pin directive. */
export function applyAssistantResourcePinAction(result: unknown): boolean {
  const action = (result as { clientAction?: unknown } | null)?.clientAction;
  if (!isResourcePinAction(action)) return false;

  if (action.resourceType === "node") {
    usePinnedNodesStore.setState((state) => ({
      dashboardNodeIds:
        action.target === "dashboard"
          ? setId(state.dashboardNodeIds, action.resourceId, action.pinned)
          : state.dashboardNodeIds,
      sidebarNodeIds:
        action.target === "sidebar"
          ? setId(state.sidebarNodeIds, action.resourceId, action.pinned)
          : state.sidebarNodeIds,
    }));
  } else if (action.resourceType === "proxy_host") {
    usePinnedProxiesStore.setState((state) => ({
      dashboardProxyIds:
        action.target === "dashboard"
          ? setId(state.dashboardProxyIds, action.resourceId, action.pinned)
          : state.dashboardProxyIds,
      sidebarProxyIds:
        action.target === "sidebar"
          ? setId(state.sidebarProxyIds, action.resourceId, action.pinned)
          : state.sidebarProxyIds,
    }));
  } else if (action.resourceType === "database") {
    usePinnedDatabasesStore.setState((state) => ({
      dashboardDatabaseIds:
        action.target === "dashboard"
          ? setId(state.dashboardDatabaseIds, action.resourceId, action.pinned)
          : state.dashboardDatabaseIds,
      sidebarDatabaseIds:
        action.target === "sidebar"
          ? setId(state.sidebarDatabaseIds, action.resourceId, action.pinned)
          : state.sidebarDatabaseIds,
    }));
  } else {
    if (action.pinned && (!action.nodeId || !action.nodeSlug || !action.name)) return false;
    // A container is pinned by node and name (its Docker ID changes on every recreate).
    const key =
      action.resourceType === "docker_container" && action.nodeId && action.name
        ? containerPinKey(action.nodeId, action.name)
        : action.resourceId;
    usePinnedContainersStore.setState((state) => {
      const dashboardContainerIds =
        action.target === "dashboard"
          ? setId(state.dashboardContainerIds, key, action.pinned)
          : state.dashboardContainerIds;
      const sidebarContainerIds =
        action.target === "sidebar"
          ? setId(state.sidebarContainerIds, key, action.pinned)
          : state.sidebarContainerIds;
      const stillPinned = dashboardContainerIds.includes(key) || sidebarContainerIds.includes(key);
      const containerMeta = { ...state.containerMeta };
      if (action.pinned) {
        containerMeta[key] = {
          nodeId: action.nodeId!,
          nodeSlug: action.nodeSlug!,
          name: action.name!,
          scopeResourceId: action.scopeResourceId,
          kind: action.resourceType === "docker_deployment" ? "deployment" : "container",
        };
      } else if (!stillPinned) {
        delete containerMeta[key];
      }
      return { dashboardContainerIds, sidebarContainerIds, containerMeta };
    });
  }

  useDashboardBootstrapStore.getState().invalidate();
  return true;
}
