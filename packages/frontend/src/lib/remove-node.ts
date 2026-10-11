import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";

function getProxyHostCount(error: ApiRequestError): number | null {
  if (!error.details || typeof error.details !== "object") return null;
  const count = (error.details as { proxyHostCount?: unknown }).proxyHostCount;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

export async function confirmAndDeleteNode(id: string, hostname: string): Promise<boolean> {
  const confirmed = await confirm({
    title: "Remove Node",
    description: `Are you sure you want to remove "${hostname}"? This cannot be undone.`,
    confirmLabel: "Remove",
  });
  if (!confirmed) return false;

  try {
    await api.deleteNode(id);
    return true;
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.code !== "OFFLINE_NGINX_NODE_HAS_HOSTS") {
      throw error;
    }

    const proxyHostCount = getProxyHostCount(error);
    const proxyLabel =
      proxyHostCount === null
        ? "its assigned routes"
        : `${proxyHostCount} assigned route${proxyHostCount === 1 ? "" : "s"}`;
    const cascadeConfirmed = await confirm({
      title: "Remove Offline Ingress Node",
      description: `This node is offline and still owns ${proxyLabel}. Removing it will also permanently delete those routes from Opfield. The old server may continue serving its local Nginx config until it is wiped or reinstalled.`,
      confirmLabel: "Remove Node and Routes",
    });
    if (!cascadeConfirmed) return false;

    await api.deleteNode(id, { cascadeProxyHosts: true });
    return true;
  }
}
