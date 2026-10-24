import type { DashboardBootstrap, NavigationAttentionSeverity } from "@/types";

export function navigationAttentionForItem(
  snapshot: DashboardBootstrap | null,
  itemId: string
): NavigationAttentionSeverity | null {
  if (
    itemId !== "nodes" &&
    itemId !== "proxy-hosts" &&
    itemId !== "docker" &&
    itemId !== "status-page" &&
    itemId !== "apps"
  ) {
    return null;
  }
  return snapshot?.navigationAttention?.[itemId] ?? null;
}

export function navigationAttentionLabel(
  itemId: string,
  severity: NavigationAttentionSeverity
): string {
  if (itemId === "nodes") {
    return severity === "critical" ? "Some nodes are offline" : "Some nodes have pending updates";
  }
  if (itemId === "status-page") {
    return severity === "critical"
      ? "The status page has a critical incident"
      : "The status page has an active incident";
  }
  if (itemId === "apps") {
    return severity === "critical" ? "Some apps are failing" : "Some apps are degraded";
  }
  if (itemId === "proxy-hosts") {
    return severity === "critical" ? "Some routes are offline" : "Some routes are degraded";
  }
  return severity === "critical"
    ? "Some Docker workloads are offline"
    : "Some Docker workloads are degraded";
}
