import { effectiveNodeStatus } from "@/lib/dashboard-attention";
import { isOpfieldVersionNewer } from "@/lib/opfield-update-reload";

export type NodeType =
  | "nginx"
  | "bastion"
  | "monitoring"
  | "docker"
  | "builder"
  | "databases"
  | "storage"
  | "relay";
export type NodeStatus = "pending" | "online" | "offline" | "error";
export type NodeAppearanceColor =
  | "blue"
  | "red"
  | "green"
  | "yellow"
  | "purple"
  | "pink"
  | "orange";

export interface NodeGpuDevice {
  id: string;
  vendor: string;
  model: string;
  pciAddress: string;
  renderNode: string;
  deviceIndex: number;
  attachable: boolean;
  unavailableReason: string;
  partitioned: boolean;
  availableMetrics: string[];
  utilizationPercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  temperatureCelsius?: number;
  powerWatts?: number;
  powerLimitWatts?: number;
  throttled?: boolean;
  eccCorrectedErrors?: number;
  eccUncorrectedErrors?: number;
  health?: string;
}

export function hasGpuMetric(device: NodeGpuDevice, metric: string): boolean {
  return device.availableMetrics.includes(metric);
}

const GPU_MONITORING_METRICS = [
  "utilization_percent",
  "memory_total_bytes",
  "memory_used_bytes",
  "temperature_celsius",
  "power_watts",
  "power_limit_watts",
];

/** A GPU section is useful only when the node actually reported a displayable metric. */
export function hasGpuMonitoringMetrics(device: NodeGpuDevice): boolean {
  return GPU_MONITORING_METRICS.some((metric) => hasGpuMetric(device, metric));
}

export function gpuDeviceLabel(
  device: Pick<NodeGpuDevice, "id" | "vendor" | "model" | "pciAddress">
): string {
  const vendor = device.vendor.trim() ? device.vendor.toUpperCase() : "GPU";
  return `${vendor} · ${device.model || device.pciAddress || device.id}`;
}

export interface NodeHealthReport {
  nginxRunning: boolean;
  configValid: boolean;
  nginxUptimeSeconds: number;
  workerCount: number;
  nginxVersion: string;
  cpuPercent: number;
  memoryBytes: number;
  diskFreeBytes: number;
  timestamp: number;
  // System
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  systemMemoryTotalBytes: number;
  systemMemoryUsedBytes: number;
  systemMemoryAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  systemUptimeSeconds: number;
  openFileDescriptors: number;
  maxFileDescriptors: number;
  // Disk
  diskMounts: Array<{
    mountPoint: string;
    filesystem: string;
    device: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  }>;
  managedStorageCapacity?: {
    storageRoot: string;
    availableBytes: number;
  };
  diskReadBytes: number;
  diskWriteBytes: number;
  // Network
  networkInterfaces: Array<{
    name: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    rxErrors: number;
    txErrors: number;
    ipAddresses?: string[];
  }>;
  localIpAddresses: string[];
  publicIpAddresses?: string[];
  // Nginx
  nginxRssBytes: number;
  errorRate4xx: number;
  errorRate5xx: number;
  gpuDevices?: NodeGpuDevice[];
  /** Docker and nginx daemons: what an update now would keep and cut, and what the last update did. */
  updateConnections?: NodeUpdateConnections;
  /** Nginx daemons: a problem of the host's nginx service only root can fix, ending with the command that fixes it. */
  nginxServiceProblem?: string;
  /** Daemons of 2.12.1 and later: objects on the node still under their previous names, by kind. */
  legacyNames?: Record<string, number>;
  /** Docker daemons that report it: the version of the node's lease watchdog, which updates on its own schedule. */
  leaseWatchdogVersion?: string;
  /** Docker daemons of 2.12.3 and later: whether the Docker Engine can start containers, and what fails if not. */
  dockerEngine?: {
    available: boolean;
    component?: string;
    problem?: string;
    checkedAt?: string;
    unavailableSince?: string;
  };
}

/** Connections across a daemon update, as the daemon reports them; cut classes are an open set. */
export interface NodeUpdateConnections {
  /** An update now hands connections over to the next daemon process. */
  handoverAvailable: boolean;
  kept: number;
  /**
   * Connections an update now would cut, by class (raw_stream, postgres_tls, registry, backup, ...; service_restart
   * when the update would restart the whole service for a newer launcher).
   */
  cut: Record<string, number>;
}

/** A long task on the node that a waiting daemon update waits for. */
export interface NodeUpdateTask {
  kind: string;
  id: string;
  label: string;
}

/** The result of the node's last completed daemon update (metadata.lastUpdate). */
export interface NodeLastUpdate {
  targetVersion: string;
  /** The update was rolled back to this previous daemon version. */
  rolledBackTo: string | null;
  completedAt: string | null;
  warnings: string[];
  /** The daemon's note when its launcher predated self-update: the whole service restarted once, or why not. */
  serviceRestart: string | null;
  /** The daemon's own counts, once it reports them final. */
  connections: {
    handover: boolean;
    handedOver: number;
    kept: number;
    cut: Record<string, number>;
    pauseP50Ms: number;
    pauseP99Ms: number;
    pauseMaxMs: number;
  } | null;
}

/** Daemons whose update hands relay stream sessions over to the next process (live handover). */
export const DAEMON_STREAM_HANDOVER_CAPABILITY = "daemon_stream_handover_v1";

export interface NodeStatsReport {
  activeConnections: number;
  accepts: number;
  handled: number;
  requests: number;
  reading: number;
  writing: number;
  waiting: number;
  timestamp: number;
}

export interface NodeMonitoringSnapshot {
  timestamp: string;
  health: NodeHealthReport | null;
  stats: NodeStatsReport | null;
  traffic: {
    statusCodes: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
    avgResponseTime: number;
    p95ResponseTime: number;
    totalRequests: number;
  } | null;
}

export interface Node {
  id: string;
  slug: string;
  type: NodeType;
  hostname: string;
  displayName: string | null;
  appearanceColor: NodeAppearanceColor | null;
  serviceAddresses?: string[];
  serviceAddress?: string | null;
  secondaryServiceAddress?: string | null;
  effectiveServiceAddress?: string | null;
  publicServiceAddresses?: string[];
  status: NodeStatus;
  serviceCreationLocked: boolean;
  daemonVersion: string | null;
  osInfo: string | null;
  configVersionHash: string | null;
  capabilities: Record<string, unknown>;
  lastSeenAt: string | null;
  lastHealthReport?: NodeHealthReport | null;
  lastStatsReport?: NodeStatsReport | null;
  healthHistory?: Array<{ ts: string; status: string }>;
  metadata: Record<string, unknown>;
  isConnected: boolean;
  /** Away only because the local relay restarts, or restarted moments ago; not its own failure. */
  reconnecting?: boolean;
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeDetail extends Node {
  lastHealthReport: NodeHealthReport | null;
  lastStatsReport: NodeStatsReport | null;
  liveHealthReport: NodeHealthReport | null;
  liveStatsReport: NodeStatsReport | null;
  monitoringHistory?: NodeMonitoringSnapshot[];
}

/** A node setup command for one enrollment target, built by Opfield for its own release. */
export interface NodeInstallCommand {
  target: "public" | "local";
  label: string;
  address: string;
  curl: string;
  wget: string;
}

export interface NodeInstallation {
  /** Opfield release the installers come from; null for an unreleased build, which uses main. */
  installerRelease: string | null;
  installCommands: NodeInstallCommand[];
}

export interface CreateNodeResponse extends NodeInstallation {
  node: Node;
  enrollmentToken: string;
  /** ISO timestamp after which an unused enrollment token is rejected. */
  enrollmentTokenExpiresAt?: string;
  opfieldCertSha256: string;
  opfieldEnrollmentTargets?: {
    public?: {
      label: string;
      address: string | null;
    };
    local?: {
      label: string;
      address: string;
    };
  };
}

/** Check if a node is outside the supported Opfield/daemon minor-version window. */
export function isNodeIncompatible(node: Node | NodeDetail): boolean {
  return !!(node.capabilities as Record<string, unknown>)?.versionMismatch;
}

function nodeUpdateMetadata(node: Node | NodeDetail): Record<string, unknown> {
  return (node.metadata as Record<string, unknown> | undefined) ?? {};
}

/** An update runs (or waits for its lease peers) and its deadline has not passed. */
export function isNodeUpdating(node: Node | NodeDetail): boolean {
  const metadata = nodeUpdateMetadata(node);
  if (metadata.updateInProgress !== true) return false;
  // A deadline that passed while Opfield could not expire the update (a restart) no longer holds the node.
  const deadlineAt =
    typeof metadata.updateDeadlineAt === "string"
      ? Date.parse(metadata.updateDeadlineAt)
      : Number.NaN;
  return !(Number.isFinite(deadlineAt) && Date.now() >= deadlineAt);
}

/**
 * The update has restarted nothing yet: it waits for the long tasks of the node, or until the other members of the
 * node's availability leases settled.
 */
export function isNodeUpdateQueued(node: Node | NodeDetail): boolean {
  const phase = nodeUpdateMetadata(node).updatePhase;
  return (
    isNodeUpdating(node) && (phase === "waiting_for_lease_peers" || phase === "waiting_for_tasks")
  );
}

/** The update waits for the long tasks running on the node (at most 30 minutes, or until "Update now"). */
export function isNodeUpdateWaitingForTasks(node: Node | NodeDetail): boolean {
  return isNodeUpdating(node) && nodeUpdateMetadata(node).updatePhase === "waiting_for_tasks";
}

/** The long tasks a waiting update waits for. */
export function getNodeUpdateWaitingForTasks(node: Node | NodeDetail): NodeUpdateTask[] {
  const tasks = nodeUpdateMetadata(node).updateWaitingForTasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const task = entry as Record<string, unknown>;
    return typeof task.id === "string" && typeof task.label === "string"
      ? [{ kind: String(task.kind ?? ""), id: task.id, label: task.label }]
      : [];
  });
}

/** The result of the node's last completed daemon update, if Opfield kept one. */
export function getNodeLastUpdate(node: Node | NodeDetail): NodeLastUpdate | null {
  const value = nodeUpdateMetadata(node).lastUpdate;
  if (!value || typeof value !== "object") return null;
  const lastUpdate = value as Record<string, unknown>;
  if (typeof lastUpdate.targetVersion !== "string") return null;
  const count = (field: unknown) => (typeof field === "number" && field > 0 ? field : 0);
  const connections =
    lastUpdate.connections && typeof lastUpdate.connections === "object"
      ? (lastUpdate.connections as Record<string, unknown>)
      : null;
  return {
    targetVersion: lastUpdate.targetVersion,
    rolledBackTo:
      typeof lastUpdate.rolledBackTo === "string" && lastUpdate.rolledBackTo
        ? lastUpdate.rolledBackTo
        : null,
    completedAt: typeof lastUpdate.completedAt === "string" ? lastUpdate.completedAt : null,
    warnings: Array.isArray(lastUpdate.warnings)
      ? lastUpdate.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    serviceRestart:
      typeof lastUpdate.serviceRestart === "string" && lastUpdate.serviceRestart
        ? lastUpdate.serviceRestart
        : null,
    connections: connections
      ? {
          handover: connections.handover === true,
          handedOver: count(connections.handedOver),
          kept: count(connections.kept),
          cut: Object.fromEntries(
            Object.entries(
              connections.cut && typeof connections.cut === "object" ? connections.cut : {}
            ).filter((entry): entry is [string, number] => count(entry[1]) > 0)
          ),
          pauseP50Ms: count(connections.pauseP50Ms),
          pauseP99Ms: count(connections.pauseP99Ms),
          pauseMaxMs: count(connections.pauseMaxMs),
        }
      : null,
  };
}

/** The node's last Secure Link connector replacement that cut connections (kept apart from its daemon updates). */
export interface NodeLastConnectorReplacement {
  at: string;
  connectionsCut: number;
}

export function getNodeLastConnectorReplacement(
  node: Node | NodeDetail
): NodeLastConnectorReplacement | null {
  const value = nodeUpdateMetadata(node).lastConnectorReplacement;
  if (!value || typeof value !== "object") return null;
  const { at, connectionsCut } = value as Record<string, unknown>;
  if (typeof at !== "string" || typeof connectionsCut !== "number" || connectionsCut <= 0)
    return null;
  return { at, connectionsCut };
}

/** Whether the node's daemon advertised a capability when it registered. */
export function hasDaemonCapability(node: Node | NodeDetail, capability: string): boolean {
  const advertised = (node.capabilities as Record<string, unknown> | undefined)?.capabilities;
  return Array.isArray(advertised) && advertised.includes(capability);
}

/** Lease members a queued update waits for, with the reason each one blocks it. */
export function getNodeUpdateWaitingFor(
  node: Node | NodeDetail
): Array<{ memberId: string; reason: string }> {
  const waitingFor = nodeUpdateMetadata(node).updateWaitingFor;
  if (!Array.isArray(waitingFor)) return [];
  return waitingFor.flatMap((entry) =>
    entry &&
    typeof entry === "object" &&
    typeof (entry as { memberId?: unknown }).memberId === "string"
      ? [
          {
            memberId: (entry as { memberId: string }).memberId,
            reason: String((entry as { reason?: unknown }).reason ?? ""),
          },
        ]
      : []
  );
}

/** Why the last daemon update of the node did not complete, while no newer update runs. */
export function getNodeUpdateLastError(
  node: Node | NodeDetail
): { message: string; at: string | null } | null {
  const metadata = nodeUpdateMetadata(node);
  if (isNodeUpdating(node) || typeof metadata.updateLastError !== "string") return null;
  // The node runs the release that failed (updated since by other means): the failure is history.
  const target = metadata.updateLastErrorTargetVersion;
  if (
    typeof target === "string" &&
    node.daemonVersion &&
    (target.replace(/^v/, "") === node.daemonVersion.replace(/^v/, "") ||
      isOpfieldVersionNewer(node.daemonVersion, target))
  ) {
    return null;
  }
  return {
    message: metadata.updateLastError,
    at: typeof metadata.updateLastErrorAt === "string" ? metadata.updateLastErrorAt : null,
  };
}

export function getNodeUpdateTargetVersion(node: Node | NodeDetail): string | null {
  const target = (node.metadata as Record<string, unknown> | undefined)?.updateTargetVersion;
  return typeof target === "string" && target.length > 0 ? target : null;
}

/** Effective node status from recent health history; the Dashboard dot uses the same rule. */
export { effectiveNodeStatus };

/**
 * The status a node shows in short lists (Dashboard, pinned sidebar items): `updating` while its update restarts the
 * daemon, which takes it offline for a moment, otherwise its effective status. A queued update has restarted nothing
 * yet, so the node shows its real state.
 */
export function nodeDisplayStatus(node: Node | NodeDetail, now = Date.now()): string {
  if (isNodeUpdating(node) && !isNodeUpdateQueued(node)) return "updating";
  return effectiveNodeStatus(node, now);
}
