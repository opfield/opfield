import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { GpuMonitoringSection } from "@/components/docker/GpuMonitoringSection";
import { StatCard } from "@/components/ui/stat-card";
import { api } from "@/services/api";
import { hasGpuMetric, hasGpuMonitoringMetrics, type NodeGpuDevice } from "@/types";
import { formatBytes, type InspectData } from "./helpers";

const MAX_HISTORY = 30;
type ProcessLoadStatus = "loading" | "ready" | "error";

interface ContainerStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

function hasAvailableMetrics(raw: Record<string, any>) {
  return raw.metricsAvailable !== false && raw.metrics_available !== false;
}

function normalizeStats(raw: Record<string, any>): ContainerStats {
  return {
    cpuPercent: raw.cpuPercent ?? raw.cpu_percent ?? 0,
    memoryUsageBytes: raw.memoryUsageBytes ?? raw.memory_usage_bytes ?? 0,
    memoryLimitBytes: raw.memoryLimitBytes ?? raw.memory_limit_bytes ?? 0,
    networkRxBytes: raw.networkRxBytes ?? raw.network_rx_bytes ?? 0,
    networkTxBytes: raw.networkTxBytes ?? raw.network_tx_bytes ?? 0,
    blockReadBytes: raw.blockReadBytes ?? raw.block_read_bytes ?? 0,
    blockWriteBytes: raw.blockWriteBytes ?? raw.block_write_bytes ?? 0,
    pids: raw.pids ?? 0,
  };
}

function hasMemoryStats(stats: ContainerStats | null): stats is ContainerStats {
  return !!stats && (stats.memoryUsageBytes > 0 || stats.memoryLimitBytes > 0);
}

function positiveLimit(value: unknown): number | null {
  const limit = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isMonitoringSampleForRuntime(
  sample: Record<string, unknown>,
  runtimeStartedAtMs: number | null
) {
  if (runtimeStartedAtMs === null) return true;
  const sampleAt = timestampMs(sample.timestamp);
  return sampleAt !== null && sampleAt >= runtimeStartedAtMs;
}

function attachedGpuDevices(data: InspectData, gpuDevices: NodeGpuDevice[]) {
  if (data.gpuAttachment?.mode !== "managed") return [];
  const attachedIds = new Set(data.gpuAttachment.deviceIds);
  return gpuDevices.filter(
    (device) => attachedIds.has(device.id) && hasGpuMonitoringMetrics(device)
  );
}

function gpuMetricHistory(
  snapshots: NodeGpuDevice[][],
  deviceId: string,
  metric: string,
  value: (device: NodeGpuDevice) => number | undefined
) {
  return snapshots.flatMap((devices) => {
    const device = devices.find((candidate) => candidate.id === deviceId);
    const current = device && hasGpuMetric(device, metric) ? value(device) : undefined;
    return typeof current === "number" && Number.isFinite(current) ? [current] : [];
  });
}

export function StatsTab({
  nodeId,
  containerId,
  data,
  showProcesses = true,
  className = "pb-6",
  onInitialLoadComplete,
}: {
  nodeId: string;
  containerId: string;
  data: InspectData;
  showProcesses?: boolean;
  className?: string;
  onInitialLoadComplete?: () => void;
}) {
  const [current, setCurrent] = useState<ContainerStats | null>(null);
  const [gpuDevices, setGpuDevices] = useState<NodeGpuDevice[]>([]);
  const [gpuHistory, setGpuHistory] = useState<NodeGpuDevice[][]>([]);
  const [processes, setProcesses] = useState<{
    Titles: string[];
    Processes: string[][];
    truncated?: boolean;
    totalProcesses?: number;
    limit?: number;
  } | null>(null);
  const [processStatus, setProcessStatus] = useState<ProcessLoadStatus>("loading");
  const [statsBootstrapLoading, setStatsBootstrapLoading] = useState(true);

  useEffect(() => {
    if (!statsBootstrapLoading) onInitialLoadComplete?.();
  }, [statsBootstrapLoading, onInitialLoadComplete]);

  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const [netRxHist, setNetRxHist] = useState<number[]>([]);
  const [netTxHist, setNetTxHist] = useState<number[]>([]);
  const [diskReadHist, setDiskReadHist] = useState<number[]>([]);
  const [diskWriteHist, setDiskWriteHist] = useState<number[]>([]);
  const [pidsHist, setPidsHist] = useState<number[]>([]);
  const prevCountersRef = useRef<{
    netRx: number;
    netTx: number;
    diskR: number;
    diskW: number;
  } | null>(null);
  const runtimeStartedAtMs = timestampMs(data.State?.StartedAt);
  const inspectedRuntimeId = String(data.Id ?? data.ID ?? "");
  const inspectedRuntimeName = String(data.Name ?? data.name ?? "").replace(/^\/+/, "");
  const monitoringIdentity = `${nodeId}:${containerId}:${inspectedRuntimeId}:${runtimeStartedAtMs ?? "unknown"}`;
  const monitoringIdentityRef = useRef(monitoringIdentity);
  monitoringIdentityRef.current = monitoringIdentity;

  const pushStats = useCallback((s: ContainerStats) => {
    setCurrent(s);
    setCpuHist((prev) => [...prev.slice(-(MAX_HISTORY - 1)), s.cpuPercent]);
    if (hasMemoryStats(s)) {
      setMemHist((prev) => [...prev.slice(-(MAX_HISTORY - 1)), s.memoryUsageBytes]);
    }
    setPidsHist((prev) => [...prev.slice(-(MAX_HISTORY - 1)), s.pids]);

    const pc = prevCountersRef.current;
    if (pc) {
      setNetRxHist((h) => [
        ...h.slice(-(MAX_HISTORY - 1)),
        Math.max(0, s.networkRxBytes - pc.netRx),
      ]);
      setNetTxHist((h) => [
        ...h.slice(-(MAX_HISTORY - 1)),
        Math.max(0, s.networkTxBytes - pc.netTx),
      ]);
      setDiskReadHist((h) => [
        ...h.slice(-(MAX_HISTORY - 1)),
        Math.max(0, s.blockReadBytes - pc.diskR),
      ]);
      setDiskWriteHist((h) => [
        ...h.slice(-(MAX_HISTORY - 1)),
        Math.max(0, s.blockWriteBytes - pc.diskW),
      ]);
    }
    prevCountersRef.current = {
      netRx: s.networkRxBytes,
      netTx: s.networkTxBytes,
      diskR: s.blockReadBytes,
      diskW: s.blockWriteBytes,
    };
  }, []);

  useEffect(() => {
    monitoringIdentityRef.current = monitoringIdentity;
    setCurrent(null);
    setGpuDevices([]);
    setGpuHistory([]);
    setProcesses(null);
    setProcessStatus("loading");
    setStatsBootstrapLoading(true);
    setCpuHist([]);
    setMemHist([]);
    setNetRxHist([]);
    setNetTxHist([]);
    setDiskReadHist([]);
    setDiskWriteHist([]);
    setPidsHist([]);
    prevCountersRef.current = null;
  }, [monitoringIdentity]);

  // Load history from Redis on mount, then connect to SSE
  useEffect(() => {
    const identity = monitoringIdentity;
    // 1. Load saved history
    api
      .getContainerStatsHistory(nodeId, containerId)
      .then((history) => {
        if (monitoringIdentityRef.current !== identity) return;
        const runtimeHistory = (history ?? []).filter((entry) =>
          isMonitoringSampleForRuntime(entry, runtimeStartedAtMs)
        );
        if (runtimeHistory.length === 0) return;
        const cpus: number[] = [],
          mems: number[] = [],
          pidsList: number[] = [];
        const rxD: number[] = [],
          txD: number[] = [],
          drD: number[] = [],
          dwD: number[] = [];
        let pRx = 0,
          pTx = 0,
          pDR = 0,
          pDW = 0;
        for (let i = 0; i < runtimeHistory.length; i++) {
          const s = normalizeStats(runtimeHistory[i] as any);
          cpus.push(s.cpuPercent);
          if (hasMemoryStats(s)) mems.push(s.memoryUsageBytes);
          pidsList.push(s.pids);
          if (i > 0) {
            rxD.push(Math.max(0, s.networkRxBytes - pRx));
            txD.push(Math.max(0, s.networkTxBytes - pTx));
            drD.push(Math.max(0, s.blockReadBytes - pDR));
            dwD.push(Math.max(0, s.blockWriteBytes - pDW));
          }
          pRx = s.networkRxBytes;
          pTx = s.networkTxBytes;
          pDR = s.blockReadBytes;
          pDW = s.blockWriteBytes;
        }
        setCpuHist(cpus);
        setMemHist(mems);
        setPidsHist(pidsList);
        setNetRxHist(rxD);
        setNetTxHist(txD);
        setDiskReadHist(drD);
        setDiskWriteHist(dwD);
        prevCountersRef.current = { netRx: pRx, netTx: pTx, diskR: pDR, diskW: pDW };
        const last = normalizeStats(runtimeHistory[runtimeHistory.length - 1] as any);
        setCurrent(last);
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => {
        if (monitoringIdentityRef.current === identity) setStatsBootstrapLoading(false);
      });

    // 2. Connect to node monitoring SSE (reuse existing stream)
    const es = api.createNodeMonitoringStream(nodeId);

    const findContainerStats = (snapshot: any): ContainerStats | null => {
      if (
        monitoringIdentityRef.current !== identity ||
        !isMonitoringSampleForRuntime(snapshot ?? {}, runtimeStartedAtMs)
      ) {
        return null;
      }
      const stats = snapshot?.health?.containerStats as any[] | undefined;
      if (!stats) return null;
      const requestedName = containerId.replace(/^\/+/, "");
      const match = stats.find((s: any) => {
        const sampleId = String(s.containerId ?? s.container_id ?? "");
        const sampleName = String(s.name ?? s.containerName ?? s.container_name ?? "").replace(
          /^\/+/,
          ""
        );
        return (
          hasAvailableMetrics(s) &&
          (sampleId === containerId ||
            (inspectedRuntimeId && sampleId === inspectedRuntimeId) ||
            sampleName === requestedName ||
            (inspectedRuntimeName && sampleName === inspectedRuntimeName))
        );
      });
      return match ? normalizeStats(match) : null;
    };
    const updateGpuDevices = (snapshot: any) => {
      const devices = snapshot?.health?.gpuDevices;
      if (!Array.isArray(devices)) return;
      const next = devices as NodeGpuDevice[];
      setGpuDevices(next);
      setGpuHistory((previous) => [...previous.slice(-(MAX_HISTORY - 1)), next]);
    };
    const updateGpuDevicesFromHistory = (snapshots: any[]) => {
      const samples = snapshots.flatMap((snapshot) => {
        const devices = snapshot?.health?.gpuDevices;
        return Array.isArray(devices) ? [devices as NodeGpuDevice[]] : [];
      });
      setGpuHistory(samples.slice(-MAX_HISTORY));
      setGpuDevices(samples.at(-1) ?? []);
    };

    es.addEventListener("connected", (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      // Extract container stats from history snapshots
      if (msg.history) {
        const snapshots = msg.history as any[];
        for (const snap of snapshots) {
          const s = findContainerStats(snap);
          if (s) pushStats(s);
        }
        updateGpuDevicesFromHistory(snapshots);
      }
    });

    es.addEventListener("snapshot", (e: MessageEvent) => {
      const snapshot = JSON.parse(e.data);
      const s = findContainerStats(snapshot);
      if (s) pushStats(s);
      updateGpuDevices(snapshot);
    });

    return () => es.close();
  }, [
    nodeId,
    containerId,
    inspectedRuntimeId,
    inspectedRuntimeName,
    monitoringIdentity,
    pushStats,
    runtimeStartedAtMs,
  ]);

  // Fetch process list (separate from SSE — needs direct call)
  useEffect(() => {
    if (!showProcesses) {
      setProcesses(null);
      setProcessStatus("ready");
      return;
    }
    const identity = monitoringIdentity;
    let cancelled = false;
    const fetchTop = async () => {
      try {
        const p = await api.getContainerTop(nodeId, containerId);
        if (cancelled || monitoringIdentityRef.current !== identity) return;
        setProcesses(p as any);
        setProcessStatus("ready");
      } catch {
        if (cancelled || monitoringIdentityRef.current !== identity) return;
        setProcessStatus("error");
      }
    };
    void fetchTop();
    const interval = setInterval(fetchTop, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [nodeId, containerId, monitoringIdentity, showProcesses]);

  // Uptime — ticks every second
  const state = data.State ?? {};
  const isRunning = state.Running === true || state.Status === "running";
  const startedAt = state.StartedAt ? new Date(state.StartedAt).getTime() : 0;

  const formatUptime = useCallback(() => {
    if (!startedAt || !isRunning) return "-";
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    if (secs < 0) return "-";
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }, [startedAt, isRunning]);

  const [uptime, setUptime] = useState(formatUptime);
  useEffect(() => {
    setUptime(formatUptime());
    const tick = setInterval(() => setUptime(formatUptime()), 1000);
    return () => clearInterval(tick);
  }, [formatUptime]);

  const cpuPercent = current?.cpuPercent ?? 0;
  const memUsage = current?.memoryUsageBytes ?? 0;
  const configuredMemoryLimit = positiveLimit(data.HostConfig?.Memory);
  const sampledMemoryLimit = positiveLimit(current?.memoryLimitBytes);
  // Old daemon samples can contain host RAM even when Docker inspect has a
  // container quota. Keep a smaller effective cgroup limit when one is reported.
  const memLimit =
    configuredMemoryLimit && sampledMemoryLimit
      ? Math.min(configuredMemoryLimit, sampledMemoryLimit)
      : (configuredMemoryLimit ?? sampledMemoryLimit ?? 0);
  const netRx = current?.networkRxBytes ?? 0;
  const netTx = current?.networkTxBytes ?? 0;
  const blockRead = current?.blockReadBytes ?? 0;
  const blockWrite = current?.blockWriteBytes ?? 0;
  const pids = current?.pids ?? 0;
  const pidsLimit = positiveLimit(data.HostConfig?.PidsLimit);
  const pidsPercent = pidsLimit ? (pids / pidsLimit) * 100 : 0;
  const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
  const memoryAvailable = hasMemoryStats(current);
  const sharedGpuDevices = attachedGpuDevices(data, gpuDevices);
  const initialStatsPending = !showProcesses && statsBootstrapLoading && current === null;
  useContentLoading(initialStatsPending || (showProcesses && processStatus === "loading"));

  // Filter out TTY column from process list
  const ttIdx = processes?.Titles?.findIndex((t) => t === "TTY" || t === "TT") ?? -1;
  const filteredTitles = processes?.Titles?.filter((_, i) => i !== ttIdx) ?? [];
  const filteredProcesses =
    processes?.Processes?.map((row) => row.filter((_, i) => i !== ttIdx)) ?? [];

  return (
    <div className={`space-y-6 ${className}`}>
      {!isRunning && (
        <div className="py-8 text-center text-muted-foreground">
          Container is not running. Start it to see monitoring data.
        </div>
      )}

      {isRunning && !initialStatsPending && (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard
              label="CPU"
              value={current ? `${cpuPercent.toFixed(1)}%` : "N/A"}
              icon={Cpu}
              history={cpuHist}
              sparklineMax={100}
              color="var(--color-hue-blue)"
              progress={current ? { percent: cpuPercent } : undefined}
            />
            <StatCard
              label="Memory"
              value={memoryAvailable ? formatBytes(memUsage) : "N/A"}
              icon={MemoryStick}
              history={memHist}
              sparklineMax={memoryAvailable ? memLimit || undefined : undefined}
              color="var(--color-hue-violet)"
              progress={memoryAvailable && memLimit > 0 ? { percent: memPercent } : undefined}
              subtitle={
                memoryAvailable
                  ? memLimit > 0
                    ? `${memPercent.toFixed(0)}% of ${formatBytes(memLimit)}`
                    : "Memory limit unavailable"
                  : "Unavailable from Docker stats"
              }
            />
            <StatCard
              label="Network RX"
              value={current ? formatBytes(netRx) : "N/A"}
              icon={ArrowDownToLine}
              history={netRxHist}
              color="var(--color-hue-green)"
            />
            <StatCard
              label="Network TX"
              value={current ? formatBytes(netTx) : "N/A"}
              icon={ArrowUpFromLine}
              history={netTxHist}
              color="var(--color-hue-amber)"
            />
            <StatCard
              label="Disk Read"
              value={current ? formatBytes(blockRead) : "N/A"}
              icon={HardDrive}
              history={diskReadHist}
              color="var(--color-hue-cyan)"
            />
            <StatCard
              label="Disk Write"
              value={current ? formatBytes(blockWrite) : "N/A"}
              icon={HardDrive}
              history={diskWriteHist}
              color="var(--color-hue-pink)"
            />
            <StatCard
              label="PIDs"
              value={current ? String(pids) : "N/A"}
              icon={Users}
              history={pidsHist}
              sparklineMax={pidsLimit ?? undefined}
              progress={current && pidsLimit ? { percent: pidsPercent } : undefined}
              subtitle={
                current && pidsLimit ? `${pidsPercent.toFixed(0)}% of ${pidsLimit}` : undefined
              }
              color="var(--color-hue-slate)"
            />
            <StatCard label="Uptime" value={uptime} icon={Clock} color="var(--color-hue-violet)" />
          </div>

          {sharedGpuDevices.map((gpu, index) => (
            <GpuMonitoringSection
              key={gpu.id}
              gpu={gpu}
              index={index}
              history={(metric, value) => gpuMetricHistory(gpuHistory, gpu.id, metric, value)}
            />
          ))}

          {/* Process List */}
          {showProcesses && (
            <PanelShell
              title="Process List"
              description={
                processes?.truncated
                  ? `Showing first ${processes.limit ?? filteredProcesses.length} of ${
                      processes.totalProcesses ?? "many"
                    } processes.`
                  : undefined
              }
            >
              {filteredProcesses.length > 0 ? (
                <div className="overflow-x-auto">
                  <div className="max-h-[calc(2rem*9+2.25rem+4px)] overflow-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 z-10 bg-header">
                        <tr className="text-left border-b border-border">
                          {filteredTitles.map((title) => (
                            <th
                              key={title}
                              className="p-2 px-4 text-xs font-medium text-muted-foreground uppercase"
                            >
                              {title}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {filteredProcesses.map((proc, i) => (
                          <tr key={i} className="hover:bg-muted/50">
                            {proc.map((val, j) => (
                              <td key={j} className="p-2 px-4 text-xs font-mono">
                                {val}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {processStatus === "loading"
                    ? "Loading processes..."
                    : processStatus === "error"
                      ? "Process list is temporarily unavailable. Retrying automatically."
                      : "No running processes reported. Retrying automatically."}
                </div>
              )}
            </PanelShell>
          )}
        </>
      )}
    </div>
  );
}
