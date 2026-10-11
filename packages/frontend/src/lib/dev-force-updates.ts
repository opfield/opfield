import type { NodeDetail, NodeType, UpdateStatus } from "@/types";

export const DEV_FORCE_UPDATES_STORAGE_KEY = "gateway-dev-force-updates";

const FORCED_GATEWAY_VERSION = "v9.9.9";
const FORCED_RELAY_VERSION = "v9.9.9";
const FORCED_DAEMON_VERSION = "9.9.9";
const DAEMON_NODE_TYPES = new Set<NodeType>([
  "nginx",
  "docker",
  "databases",
  "storage",
  "monitoring",
]);

export type DevForcedUpdateMode = "gateway" | "relay" | "both";

export function setDevForcedUpdateMode(mode: DevForcedUpdateMode): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  window.localStorage.setItem(DEV_FORCE_UPDATES_STORAGE_KEY, mode);
}

export function getDevForcedUpdateMode(): DevForcedUpdateMode | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(DEV_FORCE_UPDATES_STORAGE_KEY);
  if (stored === "0") return null;
  if (stored === "relay" || stored === "both" || stored === "gateway") return stored;
  if (stored === "1") return "gateway";
  return import.meta.env.MODE === "development" ? "gateway" : null;
}

export function isDevForceUpdatesEnabled(): boolean {
  return getDevForcedUpdateMode() !== null;
}

export function applyForcedGatewayUpdateStatus(status: UpdateStatus): UpdateStatus {
  const normalizedStatus: UpdateStatus = {
    ...status,
    relay: status.relay ?? {
      currentVersion: status.currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
      releaseUrl: null,
      operation: null,
    },
  };
  const mode = getDevForcedUpdateMode();
  if (!mode) return normalizedStatus;
  const gatewayUpdateAvailable = mode === "gateway" || mode === "both";
  const relayUpdateAvailable = mode === "relay" || mode === "both";
  return {
    ...normalizedStatus,
    latestVersion: gatewayUpdateAvailable ? FORCED_GATEWAY_VERSION : null,
    updateAvailable: gatewayUpdateAvailable,
    releaseNotes: gatewayUpdateAvailable
      ? (status.releaseNotes ?? "Local Opfield update preview.")
      : null,
    lastCheckedAt: status.lastCheckedAt ?? new Date().toISOString(),
    relay: {
      ...normalizedStatus.relay,
      latestVersion: relayUpdateAvailable ? FORCED_RELAY_VERSION : null,
      updateAvailable: relayUpdateAvailable,
      releaseNotes: relayUpdateAvailable
        ? (normalizedStatus.relay.releaseNotes ?? "Local Relay update preview.")
        : null,
      operation: null,
    },
  };
}

export function getForcedDaemonUpdateForNode(
  node: NodeDetail | null
): { available: boolean; latestVersion: string | null } | null {
  if (!isDevForceUpdatesEnabled() || !node || !DAEMON_NODE_TYPES.has(node.type)) return null;
  return {
    available: true,
    latestVersion: FORCED_DAEMON_VERSION,
  };
}
