import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleCheckBig,
  Clock3,
  Cpu,
  HardDrive,
  MemoryStick,
  Server,
  ShieldAlert,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "@/components/common/Notice";
import { useContentLoading } from "@/components/common/reveal-gate";
import { GpuMonitoringSection } from "@/components/docker/GpuMonitoringSection";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { useRealtime } from "@/hooks/use-realtime";
import { DATABASE_TYPE_LABELS } from "@/lib/database-type";
import { RELAY_LEGACY_HOST_NAMES_HINT, relayLegacyHostNameCount } from "@/lib/node-host-access";
import { formatBytes, formatDateTime, formatUptime } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import {
  type DockerBuild,
  hasGpuMetric,
  hasGpuMonitoringMetrics,
  type NodeGpuDevice,
  type NodeHealthReport,
  type NodeMonitoringSnapshot,
} from "@/types";
import { ACTIVE_DOCKER_BUILD_STATUSES } from "../docker-detail/docker-build-status";
import { MANAGED_STORAGE_ENGINE_LABELS } from "../storage-detail/managed-storage-engine";

/** How long the tab waits for the stream's first sample before showing without it. */
const MONITORING_FIRST_SAMPLE_WAIT_MS = 8000;

type Snapshot = NodeMonitoringSnapshot;

function toRollingDelta(values: number[]): number[] {
  if (values.length < 2) return values;
  return values.slice(1).map((val, i) => Math.max(0, val - values[i]));
}

const MAX_HISTORY = 60;
const EMPTY_MONITORING_HISTORY: NodeMonitoringSnapshot[] = [];

function mergeSnapshotHistory(current: Snapshot[], incoming: Snapshot[]): Snapshot[] {
  const byTimestamp = new Map(current.map((snapshot) => [snapshot.timestamp, snapshot]));
  for (const snapshot of incoming) byTimestamp.set(snapshot.timestamp, snapshot);
  return [...byTimestamp.values()]
    .sort((left, right) => snapshotTime(left) - snapshotTime(right))
    .slice(-MAX_HISTORY);
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fixed(value: unknown, digits: number, fallback = "0") {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : fallback;
}

function formatDurationSeconds(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

function summarizeBuildActivity(rows: DockerBuild[]) {
  const recent = rows.slice(0, 50);
  const chronological = [...recent].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
  );
  const completedDurations = recent.flatMap((build) => {
    if (!build.startedAt || !build.completedAt) return [];
    const elapsed = Date.parse(build.completedAt) - Date.parse(build.startedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 ? [elapsed / 1000] : [];
  });
  const outcomes = recent.filter(
    (build) => build.status === "succeeded" || build.status === "failed"
  );
  const succeeded = outcomes.filter((build) => build.status === "succeeded").length;
  const vulnerabilities = recent.reduce((total, build) => {
    const summary = build.artifact?.scanSummary;
    if (!summary) return total;
    return total + summary.critical + summary.high + summary.medium + summary.low + summary.unknown;
  }, 0);
  const durationHistory = chronological.flatMap((build) => {
    if (!build.startedAt || !build.completedAt) return [];
    const elapsed = Date.parse(build.completedAt) - Date.parse(build.startedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 ? [elapsed / 1000] : [];
  });
  const outcomeHistory: number[] = [];
  let historicalSucceeded = 0;
  let historicalOutcomes = 0;
  for (const build of chronological) {
    if (build.status !== "succeeded" && build.status !== "failed") continue;
    historicalOutcomes += 1;
    if (build.status === "succeeded") historicalSucceeded += 1;
    outcomeHistory.push((historicalSucceeded / historicalOutcomes) * 100);
  }

  return {
    recentCount: recent.length,
    running: recent.filter((build) => ACTIVE_DOCKER_BUILD_STATUSES.has(build.status)).length,
    averageDuration:
      completedDurations.length > 0
        ? completedDurations.reduce((total, value) => total + value, 0) / completedDurations.length
        : null,
    successRate: outcomes.length > 0 ? (succeeded / outcomes.length) * 100 : null,
    vulnerabilities,
    runningHistory: chronological.map((build) =>
      ACTIVE_DOCKER_BUILD_STATUSES.has(build.status) ? 1 : 0
    ),
    durationHistory,
    successRateHistory: outcomeHistory,
    vulnerabilityHistory: chronological.map((build) => {
      const summary = build.artifact?.scanSummary;
      return summary
        ? summary.critical + summary.high + summary.medium + summary.low + summary.unknown
        : 0;
    }),
  };
}

function gpuMetricHistory(
  snapshots: Snapshot[],
  deviceId: string,
  metric: string,
  value: (device: NodeGpuDevice) => number | undefined
) {
  return snapshots.flatMap((snapshot) => {
    const device = snapshot.health?.gpuDevices?.find((candidate) => candidate.id === deviceId);
    const current = device && hasGpuMetric(device, metric) ? value(device) : undefined;
    return typeof current === "number" && Number.isFinite(current) ? [current] : [];
  });
}

interface NodeMonitoringTabProps {
  nodeId: string;
  nodeStatus: string;
  nodeType?: string;
  initialHealthReport?: NodeHealthReport | null;
  initialMonitoringHistory?: NodeMonitoringSnapshot[];
}

function buildDiskMountSeed(health: NodeHealthReport | null | undefined): Snapshot | null {
  if (!health) return null;
  return {
    timestamp:
      typeof health.timestamp === "number" && Number.isFinite(health.timestamp)
        ? new Date(health.timestamp * 1000).toISOString()
        : "",
    health,
    stats: null,
    traffic: null,
  };
}

function snapshotTime(snapshot: Snapshot | null): number {
  if (!snapshot) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(snapshot.timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function mergeSeededDiskMounts(snapshot: Snapshot, seededSnapshot: Snapshot | null): Snapshot {
  const seedMounts = seededSnapshot?.health?.diskMounts;
  const seedHealth = seededSnapshot?.health;
  if (!seedHealth || !seedMounts?.length || snapshot.health?.diskMounts?.length) return snapshot;
  return {
    ...snapshot,
    health: {
      ...(snapshot.health ?? seedHealth),
      diskMounts: seedMounts,
    } as NodeHealthReport,
  };
}

function buildMonitoringBootstrap(
  history: NodeMonitoringSnapshot[],
  health: NodeHealthReport | null | undefined
) {
  const seededSnapshot = buildDiskMountSeed(health);
  const normalizedHistory = history.map((snapshot) =>
    mergeSeededDiskMounts(snapshot, seededSnapshot)
  );
  return {
    history: normalizedHistory,
    latest: normalizedHistory.at(-1) ?? seededSnapshot,
  };
}

const MANAGED_DATABASE_MOUNT = /\/databases\/mounts\/([^/]+)$/;
// Managed storage member mounts are named <storage id>-<member index>.
const MANAGED_STORAGE_MOUNT = /\/databases\/storage\/mounts\/([^/]+)-\d+$/;

/**
 * Names the disk mounts of managed databases and storage on the node ("orders (Postgres)"), from the managed
 * resource lists the user may view. Mounts it cannot name keep their path.
 */
function useManagedDiskMountLabels(mountPoints: string[]): Record<string, string> {
  const canViewDatabases = useAuthStore((state) => state.hasScopedAccess("databases:view"));
  const canViewStorage = useAuthStore((state) => state.hasScopedAccess("storage:view"));
  const needsDatabases = mountPoints.some((mountPoint) => MANAGED_DATABASE_MOUNT.test(mountPoint));
  const needsStorage = mountPoints.some((mountPoint) => MANAGED_STORAGE_MOUNT.test(mountPoint));
  const [databaseLabels, setDatabaseLabels] = useState<Record<string, string>>({});
  const [storageLabels, setStorageLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!needsDatabases || !canViewDatabases) return;
    let cancelled = false;
    api
      .listManagedDatabases()
      .then((databases) => {
        if (cancelled) return;
        setDatabaseLabels(
          Object.fromEntries(
            databases.map((database) => [
              database.id,
              `${database.name} (${DATABASE_TYPE_LABELS[database.type] ?? database.type})`,
            ])
          )
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canViewDatabases, needsDatabases]);

  useEffect(() => {
    if (!needsStorage || !canViewStorage) return;
    let cancelled = false;
    api
      .listManagedObjectStorages()
      .then((storages) => {
        if (cancelled) return;
        setStorageLabels(
          Object.fromEntries(
            storages.map((storage) => [
              storage.id,
              `${storage.name} (${MANAGED_STORAGE_ENGINE_LABELS[storage.engine ?? "minio"]} storage)`,
            ])
          )
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canViewStorage, needsStorage]);

  const labels: Record<string, string> = {};
  for (const mountPoint of mountPoints) {
    const databaseId = MANAGED_DATABASE_MOUNT.exec(mountPoint)?.[1];
    const storageId = MANAGED_STORAGE_MOUNT.exec(mountPoint)?.[1];
    const label = databaseId
      ? databaseLabels[databaseId]
      : storageId
        ? storageLabels[storageId]
        : undefined;
    if (label) labels[mountPoint] = label;
  }
  return labels;
}

export function NodeMonitoringTab({
  nodeId,
  nodeStatus,
  nodeType,
  initialHealthReport,
  initialMonitoringHistory = EMPTY_MONITORING_HISTORY,
}: NodeMonitoringTabProps) {
  const initialHealthRef = useRef(initialHealthReport);
  initialHealthRef.current = initialHealthReport;
  const monitoringBootstrapRef = useRef({
    nodeId,
    ...buildMonitoringBootstrap(initialMonitoringHistory, initialHealthReport),
  });
  if (monitoringBootstrapRef.current.nodeId !== nodeId) {
    monitoringBootstrapRef.current = {
      nodeId,
      ...buildMonitoringBootstrap(initialMonitoringHistory, initialHealthReport),
    };
  }
  const [history, setHistory] = useState<Snapshot[]>(() => monitoringBootstrapRef.current.history);
  const [streamStalled, setStreamStalled] = useState(false);
  const [latest, setLatest] = useState<Snapshot | null>(
    () => monitoringBootstrapRef.current.latest
  );
  const [recentBuilds, setRecentBuilds] = useState<DockerBuild[] | null>(null);
  const buildRequestId = useRef(0);

  const refreshBuildActivity = useCallback(async () => {
    if (nodeType !== "builder") return;
    const currentRequest = ++buildRequestId.current;
    try {
      const page = await api.listDockerBuildPage({ builderNodeId: nodeId, limit: 50 });
      if (currentRequest === buildRequestId.current) setRecentBuilds(page.data);
    } catch {
      if (currentRequest === buildRequestId.current) {
        setRecentBuilds((current) => current ?? []);
      }
    }
  }, [nodeId, nodeType]);

  useEffect(() => {
    if (nodeType !== "builder") {
      setRecentBuilds(null);
      return;
    }
    void refreshBuildActivity();
    const interval = window.setInterval(() => void refreshBuildActivity(), 15_000);
    return () => {
      window.clearInterval(interval);
      buildRequestId.current += 1;
    };
  }, [nodeType, refreshBuildActivity]);

  useRealtime("docker.build.changed", (payload) => {
    const event = payload as { builderNodeId?: string } | undefined;
    if (nodeType === "builder" && (!event?.builderNodeId || event.builderNodeId === nodeId)) {
      void refreshBuildActivity();
    }
  });
  useRealtime("docker.build.artifact.changed", (payload) => {
    const event = payload as { builderNodeId?: string } | undefined;
    if (nodeType === "builder" && (!event?.builderNodeId || event.builderNodeId === nodeId)) {
      void refreshBuildActivity();
    }
  });

  const buildActivity = useMemo(() => summarizeBuildActivity(recentBuilds ?? []), [recentBuilds]);

  useEffect(() => {
    const seededSnapshot = buildDiskMountSeed(initialHealthRef.current);
    const bootstrap = monitoringBootstrapRef.current;
    setHistory(bootstrap.history);
    setLatest(bootstrap.latest);

    if (nodeStatus !== "online") return;
    const es = api.createNodeMonitoringStream(nodeId, { focused: true });

    es.addEventListener("connected", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      const streamHistory = ((data.history ?? []) as Snapshot[]).map((snapshot) =>
        mergeSeededDiskMounts(snapshot, seededSnapshot)
      );
      setHistory((current) => mergeSnapshotHistory(current, streamHistory));
      const streamLatest = streamHistory.at(-1) ?? null;
      setLatest((current) =>
        snapshotTime(streamLatest) >= snapshotTime(current) ? streamLatest : current
      );
    });

    // A stream that errors or stays quiet must not keep the tab hidden.
    es.addEventListener("error", () => setStreamStalled(true));
    const stallTimer = window.setTimeout(
      () => setStreamStalled(true),
      MONITORING_FIRST_SAMPLE_WAIT_MS
    );

    es.addEventListener("snapshot", (e: MessageEvent) => {
      const snapshot = mergeSeededDiskMounts(JSON.parse(e.data) as Snapshot, seededSnapshot);
      setHistory((prev) => {
        return mergeSnapshotHistory(prev, [snapshot]);
      });
      setLatest(snapshot);
    });

    return () => {
      window.clearTimeout(stallTimer);
      es.close();
    };
  }, [nodeId, nodeStatus]);

  // The first snapshot arrives with the stream; a Build Worker also waits for its job summary.
  useContentLoading(
    nodeStatus === "online" &&
      !streamStalled &&
      (!latest || (nodeType === "builder" && recentBuilds === null))
  );

  const managedMountLabels = useManagedDiskMountLabels(
    latest?.health?.diskMounts?.map((mount) => mount.mountPoint) ?? []
  );

  if (nodeStatus !== "online") {
    return (
      <div className="flex flex-col items-center gap-2 py-16 border border-border bg-card">
        <p className="text-muted-foreground">Node is offline — monitoring unavailable</p>
      </div>
    );
  }

  if (!latest) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 border border-border bg-card">
        <p className="text-muted-foreground">
          Waiting for the first monitoring sample from this node
        </p>
      </div>
    );
  }

  const health = latest.health;
  const stats = latest.stats;
  const legacyNameCount = Object.values(health?.legacyNames ?? {}).reduce(
    (total, count) => total + count,
    0
  );

  // Build sparkline data
  const cpuHist = history.map((h) => h.health?.cpuPercent ?? 0);
  const memHist = history.map((h) => h.health?.systemMemoryUsedBytes ?? 0);
  const activeConnHist = history.map((h) => h.stats?.activeConnections ?? 0);
  const readingHist = history.map((h) => h.stats?.reading ?? 0);
  const writingHist = history.map((h) => h.stats?.writing ?? 0);
  const waitingHist = history.map((h) => h.stats?.waiting ?? 0);
  const diskReadHist = history.map((h) => h.health?.diskReadBytes ?? 0);

  const primaryIface = health?.networkInterfaces?.find((i) => i.name !== "lo");
  const rxHist = history.map(
    (h) => h.health?.networkInterfaces?.find((i) => i.name === primaryIface?.name)?.rxBytes ?? 0
  );

  const memPercent =
    health && health.systemMemoryTotalBytes > 0
      ? `${((health.systemMemoryUsedBytes / health.systemMemoryTotalBytes) * 100).toFixed(1)}%`
      : "0%";

  // Split root mount from other mounts
  const rootMount = health?.diskMounts?.find((m) => m.mountPoint === "/");
  const otherMounts = health?.diskMounts?.filter((m) => m.mountPoint !== "/") ?? [];
  const gpuDevices = (health?.gpuDevices ?? []).filter(hasGpuMonitoringMetrics);

  return (
    <div className="space-y-4">
      {/* Nginx Process Info Bar — nginx nodes only */}
      {nodeType === "nginx" && health && (
        <div className="flex flex-wrap items-center gap-3 p-3 border border-border bg-card text-sm">
          <span className="font-medium">nginx/{health.nginxVersion || "unknown"}</span>
          <Badge variant={health.nginxRunning ? "success" : "destructive"}>
            {health.nginxRunning ? "Running" : "Stopped"}
          </Badge>
          <Badge variant="secondary">{health.workerCount} workers</Badge>
          <Badge variant="secondary">Up {formatUptime(health.nginxUptimeSeconds)}</Badge>
          <Badge variant={health.configValid ? "success" : "destructive"}>
            {health.configValid ? "Config valid" : "Config invalid"}
          </Badge>
          <Badge variant="secondary">RSS {formatBytes(health.nginxRssBytes)}</Badge>
        </div>
      )}
      {legacyNameCount > 0 && (
        <Notice
          tone="info"
          title={`${legacyNameCount} ${legacyNameCount === 1 ? "object" : "objects"} on this node still use the previous names`}
        >
          {nodeType === "relay" && relayLegacyHostNameCount(health?.legacyNames) > 0
            ? RELAY_LEGACY_HOST_NAMES_HINT
            : "They are renamed when they are next recreated. Nothing needs to be done."}
        </Notice>
      )}
      {health?.dockerEngine?.available === false && (
        <Notice tone="destructive" title="Docker cannot start containers on this node">
          <span className="break-words">
            {health.dockerEngine.problem || "The Docker Engine does not answer."}
            {health.dockerEngine.unavailableSince
              ? ` Since ${formatDateTime(health.dockerEngine.unavailableSince)}.`
              : ""}{" "}
            Running containers keep running; new containers, deploys, restarts and builds fail until
            it is fixed on the node.
          </span>
        </Notice>
      )}
      {nodeType === "nginx" && health?.nginxServiceProblem && (
        <Notice tone="destructive" title="nginx needs a fix as root on the host">
          <span className="break-words">{health.nginxServiceProblem}</span>
        </Notice>
      )}
      {nodeType === "nginx" && health?.nginxVersionNotice && (
        <Notice
          tone={
            health.nginxUpgrade?.state === "failed" || health.nginxUpgrade?.state === "manual"
              ? "destructive"
              : "warning"
          }
          title="nginx is older than Opfield supports"
        >
          <span className="break-words">{health.nginxVersionNotice}</span>
        </Notice>
      )}

      {/* System Resources */}
      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">System Resources</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard
            label="CPU"
            value={`${fixed(health?.cpuPercent, 1)}%`}
            icon={Cpu}
            history={cpuHist}
            sparklineMax={100}
            color="var(--color-hue-blue)"
            progress={{ percent: health?.cpuPercent ?? 0 }}
            subtitle={`Load: ${fixed(health?.loadAverage1m, 2)} / ${fixed(health?.loadAverage5m, 2)} / ${fixed(health?.loadAverage15m, 2)}`}
          />
          <StatCard
            label="Memory"
            value={health ? formatBytes(health.systemMemoryUsedBytes) : "0 B"}
            icon={MemoryStick}
            history={memHist}
            sparklineMax={health?.systemMemoryTotalBytes}
            color="var(--color-hue-violet)"
            progress={{
              percent:
                health && health.systemMemoryTotalBytes > 0
                  ? (health.systemMemoryUsedBytes / health.systemMemoryTotalBytes) * 100
                  : 0,
            }}
            subtitle={`${memPercent} of ${formatBytes(health?.systemMemoryTotalBytes ?? 0)}`}
          />
          <StatCard
            label="Swap"
            value={
              health && health.swapTotalBytes > 0 ? formatBytes(health.swapUsedBytes) : "Disabled"
            }
            icon={MemoryStick}
            history={history.map((h) => h.health?.swapUsedBytes ?? 0)}
            sparklineMax={health?.swapTotalBytes}
            color="var(--color-hue-pink)"
            progress={{
              percent:
                health && health.swapTotalBytes > 0
                  ? (health.swapUsedBytes / health.swapTotalBytes) * 100
                  : 0,
              color: "var(--color-hue-pink)",
            }}
            subtitle={
              health && health.swapTotalBytes > 0
                ? `of ${formatBytes(health.swapTotalBytes)}`
                : "No swap configured"
            }
          />
          {rootMount && (
            <StatCard
              label="Root Disk"
              value={`${fixed(rootMount.usagePercent, 1)}%`}
              icon={HardDrive}
              history={history.map((h) => {
                const rm = h.health?.diskMounts?.find((m) => m.mountPoint === "/");
                return rm?.usagePercent ?? 0;
              })}
              sparklineMax={100}
              color="var(--color-hue-orange)"
              progress={{ percent: finiteNumber(rootMount.usagePercent) }}
              subtitle={`${formatBytes(rootMount.usedBytes)} / ${formatBytes(rootMount.totalBytes)}`}
            />
          )}
        </div>
      </div>

      {nodeType === "builder" && (
        <section aria-labelledby="build-activity-heading">
          <h3
            id="build-activity-heading"
            className="mb-2 text-sm font-semibold text-muted-foreground"
          >
            Build activity
          </h3>
          {recentBuilds === null ? null : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Running jobs"
                value={String(buildActivity.running)}
                icon={Activity}
                history={buildActivity.runningHistory}
                color="var(--color-hue-blue)"
                subtitle={`Across ${buildActivity.recentCount} recent jobs`}
              />
              <StatCard
                label="Average duration"
                value={
                  buildActivity.averageDuration === null
                    ? "—"
                    : formatDurationSeconds(buildActivity.averageDuration)
                }
                icon={Clock3}
                history={buildActivity.durationHistory}
                color="var(--color-hue-violet)"
                subtitle="Recent completed jobs"
              />
              <StatCard
                label="Success rate"
                value={
                  buildActivity.successRate === null
                    ? "—"
                    : `${buildActivity.successRate.toFixed(0)}%`
                }
                icon={CircleCheckBig}
                history={buildActivity.successRateHistory}
                sparklineMax={100}
                color="var(--color-hue-green)"
                progress={{ percent: buildActivity.successRate ?? 0 }}
                subtitle="Succeeded vs failed"
              />
              <StatCard
                label="Vulnerabilities"
                value={buildActivity.vulnerabilities.toLocaleString()}
                icon={ShieldAlert}
                history={buildActivity.vulnerabilityHistory}
                color="var(--color-hue-amber)"
                subtitle="Recent scan results"
              />
            </div>
          )}
        </section>
      )}

      {gpuDevices.map((gpu, index) => (
        <GpuMonitoringSection
          key={gpu.id}
          gpu={gpu}
          index={index}
          history={(metric, value) => gpuMetricHistory(history, gpu.id, metric, value)}
        />
      ))}

      {/* Traffic — Status Codes & Response Times (nginx only) */}
      {nodeType === "nginx" && latest?.traffic && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Traffic</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard
              label="2xx Success"
              value={String(latest.traffic.statusCodes.s2xx)}
              icon={Check}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s2xx ?? 0))}
              color="var(--color-hue-green)"
            />
            <StatCard
              label="3xx Redirect"
              value={String(latest.traffic.statusCodes.s3xx)}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s3xx ?? 0))}
              color="var(--color-hue-blue)"
            />
            <StatCard
              label="4xx Client Err"
              value={String(latest.traffic.statusCodes.s4xx)}
              icon={X}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s4xx ?? 0))}
              color="var(--color-hue-amber)"
            />
            <StatCard
              label="5xx Server Err"
              value={String(latest.traffic.statusCodes.s5xx)}
              icon={X}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s5xx ?? 0))}
              color="var(--color-hue-red)"
            />
            <StatCard
              label="Avg Response"
              value={`${fixed(finiteNumber(latest.traffic.avgResponseTime) * 1000, 0)}ms`}
              icon={Activity}
              history={history.map((h) => (h.traffic?.avgResponseTime ?? 0) * 1000)}
              color="var(--color-hue-violet)"
            />
            <StatCard
              label="p95 Response"
              value={`${fixed(finiteNumber(latest.traffic.p95ResponseTime) * 1000, 0)}ms`}
              icon={Activity}
              history={history.map((h) => (h.traffic?.p95ResponseTime ?? 0) * 1000)}
              color="var(--color-hue-pink)"
            />
          </div>
        </div>
      )}

      {/* Connections (nginx only) */}
      {nodeType === "nginx" && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Connections</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard
              label="Active"
              value={String(stats?.activeConnections ?? 0)}
              icon={Activity}
              history={activeConnHist}
              color="var(--color-hue-blue)"
            />
            <StatCard
              label="Reading"
              value={String(stats?.reading ?? 0)}
              icon={ArrowDownToLine}
              history={readingHist}
              color="var(--color-hue-green)"
            />
            <StatCard
              label="Writing"
              value={String(stats?.writing ?? 0)}
              icon={ArrowUpFromLine}
              history={writingHist}
              color="var(--color-hue-amber)"
            />
            <StatCard
              label="Waiting"
              value={String(stats?.waiting ?? 0)}
              icon={Server}
              history={waitingHist}
              color="var(--color-hue-slate)"
            />
          </div>
        </div>
      )}

      {/* I/O (all node types) */}
      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">I/O</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard
            label="Disk I/O"
            value={`${formatBytes(health?.diskReadBytes ?? 0)} / ${formatBytes(health?.diskWriteBytes ?? 0)}`}
            icon={HardDrive}
            history={diskReadHist}
            color="var(--color-hue-orange)"
            subtitle="Read / Write delta"
          />
          {primaryIface ? (
            <StatCard
              label="Network I/O"
              value={`${formatBytes(primaryIface.rxBytes)} / ${formatBytes(primaryIface.txBytes)}`}
              icon={Wifi}
              history={rxHist}
              color="var(--color-hue-cyan)"
              subtitle={`${primaryIface.name} Rx / Tx`}
            />
          ) : (
            <StatCard
              label="Network I/O"
              value="N/A"
              icon={Wifi}
              history={[]}
              color="var(--color-hue-slate)"
            />
          )}
        </div>
      </div>

      {/* Totals (nginx only) */}
      {nodeType === "nginx" && stats && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Totals</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatCard
              label="Accepts"
              value={(stats.accepts ?? 0).toLocaleString()}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.stats?.accepts ?? 0))}
              color="var(--color-hue-green)"
              subtitle="delta per poll"
            />
            <StatCard
              label="Handled"
              value={(stats.handled ?? 0).toLocaleString()}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.stats?.handled ?? 0))}
              color="var(--color-hue-blue)"
              subtitle="delta per poll"
            />
            <StatCard
              label="Requests"
              value={(stats.requests ?? 0).toLocaleString()}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.stats?.requests ?? 0))}
              color="var(--color-hue-violet)"
              subtitle="delta per poll"
            />
          </div>
        </div>
      )}

      {/* Additional Disk Mounts (non-root) */}
      {otherMounts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Disk Mounts</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {otherMounts.map((mount) => {
              const managedLabel = managedMountLabels[mount.mountPoint];
              const usage = `${formatBytes(mount.usedBytes)} / ${formatBytes(mount.totalBytes)}`;
              return (
                <StatCard
                  key={mount.mountPoint}
                  label={managedLabel ?? mount.mountPoint}
                  value={`${fixed(mount.usagePercent, 1)}%`}
                  icon={HardDrive}
                  history={[]}
                  color="var(--color-hue-orange)"
                  progress={{ percent: finiteNumber(mount.usagePercent) }}
                  subtitle={managedLabel ? usage : `${usage} (${mount.device})`}
                  footnote={managedLabel ? `${mount.mountPoint} (${mount.device})` : undefined}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
