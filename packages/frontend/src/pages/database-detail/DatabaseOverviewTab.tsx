import { Activity } from "lucide-react";
import { useMemo } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { ManagedCertificateDetailRow } from "@/components/common/ManagedCertificateStatus";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { databaseTypeLabel } from "@/lib/database-type";
import type { DatabaseConnection, DatabaseMetricSnapshot, ManagedCertificateStatus } from "@/types";
import { hasUnverifiedTls } from "./DatabaseTlsVerificationNotice";
import { formatHealthStatusLabel, formatMetricValue, HEALTH_BADGE, METRIC_COLORS } from "./shared";

interface DatabaseOverviewTabProps {
  database: DatabaseConnection;
  canViewMonitoring: boolean;
  healthStatus: DatabaseConnection["healthStatus"] | "paused";
  history: DatabaseMetricSnapshot[];
  monitoringLoading: boolean;
  /** TLS certificate of a managed database, shown as a detail row. */
  certificateStatus?: ManagedCertificateStatus | null;
}

type OverviewMetric = {
  key: string;
  label: string;
  value: string;
  history: number[];
  progress?: { percent: number; color?: string };
  sparklineMax?: number;
  subtitle?: string;
};

function managedRuntimeMetrics(
  database: DatabaseConnection,
  latest: DatabaseMetricSnapshot,
  history: DatabaseMetricSnapshot[]
): OverviewMetric[] {
  if (!database.managed) return [];
  const memoryUsage = latest.metrics.managed_memory_usage_bytes ?? null;
  const memoryLimit = latest.metrics.managed_memory_limit_bytes ?? null;
  const swapUsage = latest.metrics.managed_swap_usage_bytes ?? null;
  const swapLimit = latest.metrics.managed_swap_limit_bytes ?? null;
  const swapDisabled = swapLimit === 0;
  const memoryPercent =
    memoryUsage != null && memoryLimit != null && memoryLimit > 0
      ? (memoryUsage / memoryLimit) * 100
      : null;
  const swapPercent =
    swapUsage != null && swapLimit != null && swapLimit > 0 ? (swapUsage / swapLimit) * 100 : null;
  // The data disk of the managed instance, reported by its node's Docker daemon (2.12.2 and later).
  const diskUsed = latest.metrics.managed_disk_used_bytes ?? null;
  const diskTotal = latest.metrics.managed_disk_total_bytes ?? null;
  const diskPercent =
    diskUsed != null && diskTotal != null && diskTotal > 0 ? (diskUsed / diskTotal) * 100 : null;
  return [
    ...(diskUsed == null
      ? []
      : [
          {
            key: "managed_disk_used_bytes",
            label: "Data Disk",
            value:
              diskTotal && diskTotal > 0
                ? `${formatMetricValue("managed_disk_used_bytes", diskUsed)} / ${formatMetricValue("managed_disk_total_bytes", diskTotal)}`
                : formatMetricValue("managed_disk_used_bytes", diskUsed),
            history: history.map((item) => item.metrics.managed_disk_used_bytes ?? 0),
            progress: diskPercent == null ? undefined : { percent: diskPercent },
            subtitle: diskPercent == null ? undefined : `${diskPercent.toFixed(1)}% used`,
          },
        ]),
    {
      key: "managed_cpu_percent",
      label: "CPU",
      value:
        latest.metrics.managed_cpu_percent == null
          ? "-"
          : `${latest.metrics.managed_cpu_percent.toFixed(1)}%`,
      history: history.map((item) => item.metrics.managed_cpu_percent ?? 0),
      progress:
        latest.metrics.managed_cpu_percent == null
          ? undefined
          : { percent: latest.metrics.managed_cpu_percent },
      sparklineMax: 100,
    },
    {
      key: "managed_memory_usage_bytes",
      label: "Memory",
      value:
        memoryUsage == null
          ? "-"
          : memoryLimit && memoryLimit > 0
            ? `${formatMetricValue("managed_memory_usage_bytes", memoryUsage)} / ${formatMetricValue("managed_memory_limit_bytes", memoryLimit)}`
            : formatMetricValue("managed_memory_usage_bytes", memoryUsage),
      history: history.map((item) => item.metrics.managed_memory_usage_bytes ?? 0),
      progress: memoryPercent == null ? undefined : { percent: memoryPercent },
      subtitle: memoryPercent == null ? undefined : `${memoryPercent.toFixed(1)}% used`,
    },
    {
      key: "managed_swap_usage_bytes",
      label: "Swap",
      value: swapDisabled
        ? "Disabled"
        : swapUsage == null
          ? "-"
          : swapLimit === -1
            ? `${formatMetricValue("managed_swap_usage_bytes", swapUsage)} / unlimited`
            : swapLimit && swapLimit > 0
              ? `${formatMetricValue("managed_swap_usage_bytes", swapUsage)} / ${formatMetricValue("managed_swap_limit_bytes", swapLimit)}`
              : formatMetricValue("managed_swap_usage_bytes", swapUsage),
      history: swapDisabled
        ? []
        : history.map((item) => item.metrics.managed_swap_usage_bytes ?? 0),
      progress: swapDisabled || swapPercent == null ? undefined : { percent: swapPercent },
      subtitle: swapDisabled || swapPercent == null ? undefined : `${swapPercent.toFixed(1)}% used`,
    },
    {
      key: "managed_pids",
      label: "PIDs",
      value: formatMetricValue("managed_pids", latest.metrics.managed_pids ?? null),
      history: history.map((item) => item.metrics.managed_pids ?? 0),
    },
  ];
}

export function DatabaseOverviewTab({
  database,
  canViewMonitoring,
  healthStatus,
  history,
  monitoringLoading,
  certificateStatus,
}: DatabaseOverviewTabProps) {
  const latest = history.at(-1);
  const showMonitoring =
    canViewMonitoring && healthStatus !== "offline" && database.managed?.status !== "paused";
  // The metric cards wait for the stream's saved history.
  useContentLoading(showMonitoring && monitoringLoading && !latest);
  const connectionTLSEnabled = database.managed?.tlsEnabled ?? database.tlsEnabled;
  const connectionTLSUnverified = hasUnverifiedTls(database);
  const overviewMetrics = useMemo<OverviewMetric[]>(() => {
    if (!latest) return [];
    const appendManaged = (metrics: OverviewMetric[]) => {
      if (!database.managed) return metrics;

      const managedMetrics = managedRuntimeMetrics(database, latest, history);
      const diskMetricKey =
        database.type === "clickhouse" ? "disk_used_pct" : "database_size_bytes";
      const diskMetric = metrics.find((metric) => metric.key === diskMetricKey);
      const engineMetricKeysToHide =
        database.type === "redis" ? new Set(["used_memory_bytes"]) : new Set<string>();
      const runtimeByKey = new Map(managedMetrics.map((metric) => [metric.key, metric]));
      const resourceMetrics = [
        runtimeByKey.get("managed_disk_used_bytes"),
        runtimeByKey.get("managed_memory_usage_bytes"),
        runtimeByKey.get("managed_cpu_percent"),
        runtimeByKey.get("managed_swap_usage_bytes"),
      ].filter((metric): metric is OverviewMetric => metric != null);

      return [
        ...(diskMetric ? [diskMetric] : []),
        ...resourceMetrics,
        ...metrics.filter(
          (metric) => metric.key !== diskMetricKey && !engineMetricKeysToHide.has(metric.key)
        ),
        ...managedMetrics.filter(
          (metric) =>
            metric.key !== "managed_disk_used_bytes" &&
            metric.key !== "managed_memory_usage_bytes" &&
            metric.key !== "managed_cpu_percent" &&
            metric.key !== "managed_swap_usage_bytes"
        ),
      ];
    };

    if (database.type === "postgres") {
      const active = latest.metrics.active_connections ?? null;
      const total = latest.metrics.total_connections ?? null;
      const max = latest.metrics.max_connections ?? null;
      const pct = latest.metrics.total_connections_pct ?? null;
      const lockCount = latest.metrics.lock_count ?? null;
      const longRunning = latest.metrics.long_running_queries ?? null;
      const transactionRate = latest.metrics.transaction_rate ?? null;
      const cacheHitRatio = latest.metrics.cache_hit_ratio ?? null;
      const readBlocksPerSec = latest.metrics.read_blocks_per_sec ?? null;
      const writeBlocksPerSec = latest.metrics.write_blocks_per_sec ?? null;
      const databaseSizeBytes = latest.metrics.database_size_bytes ?? null;
      const sizeLimitBytes =
        database.managed?.storageSizeBytes ??
        (database.manualSizeLimitMb != null ? database.manualSizeLimitMb * 1024 * 1024 : null);
      const databaseSizePct =
        databaseSizeBytes != null && sizeLimitBytes && sizeLimitBytes > 0
          ? (databaseSizeBytes / sizeLimitBytes) * 100
          : null;

      return appendManaged([
        {
          key: "latency_ms",
          label: "Latency",
          value: formatMetricValue("latency_ms", latest.metrics.latency_ms ?? null),
          history: history.map((item) => item.metrics.latency_ms ?? 0),
        },
        {
          key: "total_connections",
          label: "Connections",
          value: total == null ? "-" : max && max > 0 ? `${total} / ${max}` : `${total}`,
          history: history.map((item) => item.metrics.total_connections_pct ?? 0),
          progress: pct == null ? undefined : { percent: pct },
          sparklineMax: 100,
          subtitle:
            pct == null
              ? active == null
                ? undefined
                : `${active} active`
              : `${pct.toFixed(1)}% used${active == null ? "" : `, ${active} active`}`,
        },
        {
          key: "database_size_bytes",
          label: "Database Size",
          value:
            databaseSizeBytes == null
              ? "-"
              : sizeLimitBytes && sizeLimitBytes > 0
                ? `${formatMetricValue("database_size_bytes", databaseSizeBytes)} / ${formatMetricValue("database_size_bytes", sizeLimitBytes)}`
                : formatMetricValue("database_size_bytes", databaseSizeBytes),
          history: history.map((item) => item.metrics.database_size_bytes ?? 0),
          progress: databaseSizePct == null ? undefined : { percent: databaseSizePct },
          subtitle: databaseSizePct == null ? undefined : `${databaseSizePct.toFixed(1)}% used`,
        },
        {
          key: "lock_count",
          label: "Lock Count",
          value: formatMetricValue("lock_count", lockCount),
          history: history.map((item) => item.metrics.lock_count ?? 0),
        },
        {
          key: "long_running_queries",
          label: "Long-Running Queries",
          value: formatMetricValue("long_running_queries", longRunning),
          history: history.map((item) => item.metrics.long_running_queries ?? 0),
        },
        {
          key: "transaction_rate",
          label: "Transaction Rate",
          value: formatMetricValue("transaction_rate", transactionRate),
          history: history.map((item) => item.metrics.transaction_rate ?? 0),
        },
        {
          key: "cache_hit_ratio",
          label: "Cache Hit Ratio",
          value: formatMetricValue("cache_hit_ratio", cacheHitRatio),
          history: history.map((item) => item.metrics.cache_hit_ratio ?? 0),
          progress: cacheHitRatio == null ? undefined : { percent: cacheHitRatio },
          sparklineMax: 100,
        },
        {
          key: "read_blocks_per_sec",
          label: "Read vs Write Blocks",
          value:
            readBlocksPerSec == null && writeBlocksPerSec == null
              ? "-"
              : `${formatMetricValue("read_blocks_per_sec", readBlocksPerSec)} / ${formatMetricValue("write_blocks_per_sec", writeBlocksPerSec)}`,
          history: history.map(
            (item) =>
              (item.metrics.read_blocks_per_sec ?? 0) + (item.metrics.write_blocks_per_sec ?? 0)
          ),
          subtitle: "read / write per sec",
        },
      ]);
    }

    if (database.type === "clickhouse") {
      const databaseSize = latest.metrics.database_size_bytes ?? null;
      const diskTotal = latest.metrics.disk_total_bytes ?? null;
      const diskFree = latest.metrics.disk_free_bytes ?? null;
      const diskAvailable = latest.metrics.disk_unreserved_bytes ?? diskFree;
      const diskUsedPercent = latest.metrics.disk_used_pct ?? null;

      return appendManaged([
        {
          key: "latency_ms",
          label: "Latency",
          value: formatMetricValue("latency_ms", latest.metrics.latency_ms ?? null),
          history: history.map((item) => item.metrics.latency_ms ?? 0),
        },
        {
          key: "database_size_bytes",
          label: "Database Size",
          value: formatMetricValue("database_size_bytes", databaseSize),
          history: history.map((item) => item.metrics.database_size_bytes ?? 0),
        },
        {
          key: "row_count",
          label: "Rows in Active Parts",
          value: latest.metrics.row_count == null ? "-" : latest.metrics.row_count.toLocaleString(),
          history: history.map((item) => item.metrics.row_count ?? 0),
        },
        {
          key: "active_parts",
          label: "Active Parts",
          value: formatMetricValue("active_parts", latest.metrics.active_parts ?? null),
          history: history.map((item) => item.metrics.active_parts ?? 0),
        },
        {
          key: "running_queries",
          label: "Running Queries",
          value: formatMetricValue("running_queries", latest.metrics.running_queries ?? null),
          history: history.map((item) => item.metrics.running_queries ?? 0),
        },
        {
          key: "query_rate",
          label: "Query Rate",
          value:
            latest.metrics.query_rate == null ? "-" : `${latest.metrics.query_rate.toFixed(1)}/s`,
          history: history.map((item) => item.metrics.query_rate ?? 0),
        },
        {
          key: "memory_usage_bytes",
          label: "Query Memory",
          value: formatMetricValue("memory_usage_bytes", latest.metrics.memory_usage_bytes ?? null),
          history: history.map((item) => item.metrics.memory_usage_bytes ?? 0),
        },
        {
          key: "disk_used_pct",
          label: "Server Disk",
          value:
            diskTotal == null || diskFree == null
              ? "-"
              : `${formatMetricValue("disk_total_bytes", diskTotal - diskFree)} / ${formatMetricValue("disk_total_bytes", diskTotal)}`,
          history: history.map((item) => item.metrics.disk_used_pct ?? 0),
          progress: diskUsedPercent == null ? undefined : { percent: diskUsedPercent },
          sparklineMax: 100,
          subtitle:
            diskUsedPercent == null
              ? undefined
              : `${diskUsedPercent.toFixed(1)}% used${
                  diskAvailable == null
                    ? ""
                    : ` · ${formatMetricValue("disk_total_bytes", diskAvailable)} available`
                } · ${latest.metrics.active_merges ?? 0} merges · ${latest.metrics.pending_mutations ?? 0} mutations`,
        },
      ]);
    }

    const usedMemory = latest.metrics.used_memory_bytes ?? null;
    const maxMemory = latest.metrics.maxmemory_bytes ?? null;
    const memoryPct = latest.metrics.memory_pct ?? null;
    const databaseSizeBytes = latest.metrics.database_size_bytes ?? null;
    const sizeLimitBytes =
      database.managed?.storageSizeBytes ??
      (database.manualSizeLimitMb != null ? database.manualSizeLimitMb * 1024 * 1024 : null);
    const databaseSizePct =
      databaseSizeBytes != null && sizeLimitBytes && sizeLimitBytes > 0
        ? (databaseSizeBytes / sizeLimitBytes) * 100
        : null;

    return appendManaged([
      {
        key: "latency_ms",
        label: "Latency",
        value: formatMetricValue("latency_ms", latest.metrics.latency_ms ?? null),
        history: history.map((item) => item.metrics.latency_ms ?? 0),
      },
      {
        key: "database_size_bytes",
        label: "Database Size",
        value:
          databaseSizeBytes == null
            ? "-"
            : sizeLimitBytes && sizeLimitBytes > 0
              ? `${formatMetricValue("database_size_bytes", databaseSizeBytes)} / ${formatMetricValue("database_size_bytes", sizeLimitBytes)}`
              : formatMetricValue("database_size_bytes", databaseSizeBytes),
        history: history.map((item) => item.metrics.database_size_bytes ?? 0),
        progress: databaseSizePct == null ? undefined : { percent: databaseSizePct },
        subtitle: databaseSizePct == null ? undefined : `${databaseSizePct.toFixed(1)}% used`,
      },
      {
        key: "used_memory_bytes",
        label: "Memory",
        value:
          usedMemory == null
            ? "-"
            : maxMemory && maxMemory > 0
              ? `${formatMetricValue("used_memory_bytes", usedMemory)} / ${formatMetricValue("maxmemory_bytes", maxMemory)}`
              : formatMetricValue("used_memory_bytes", usedMemory),
        history: history.map((item) => item.metrics.memory_pct ?? 0),
        progress: memoryPct == null ? undefined : { percent: memoryPct },
        sparklineMax: 100,
        subtitle: memoryPct == null ? undefined : `${memoryPct.toFixed(1)}% used`,
      },
      {
        key: "connected_clients",
        label: "Connected Clients",
        value: formatMetricValue("connected_clients", latest.metrics.connected_clients ?? null),
        history: history.map((item) => item.metrics.connected_clients ?? 0),
      },
      {
        key: "instantaneous_ops_per_sec",
        label: "Ops / Sec",
        value: formatMetricValue(
          "instantaneous_ops_per_sec",
          latest.metrics.instantaneous_ops_per_sec ?? null
        ),
        history: history.map((item) => item.metrics.instantaneous_ops_per_sec ?? 0),
      },
    ]);
  }, [database, history, latest]);

  return (
    <div className="space-y-4">
      {showMonitoring &&
        (monitoringLoading && !latest ? null : latest ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {overviewMetrics.map((metric) => (
              <StatCard
                key={metric.key}
                label={metric.label}
                value={metric.value}
                icon={Activity}
                history={metric.history}
                sparklineMax={metric.sparklineMax}
                progress={metric.progress}
                subtitle={metric.subtitle}
                color={METRIC_COLORS[metric.key] ?? "var(--color-primary)"}
              />
            ))}
          </div>
        ) : (
          <div className="border border-border bg-card p-4 text-sm text-muted-foreground">
            Waiting for monitoring data...
          </div>
        ))}

      <div className="grid gap-4 lg:grid-cols-2">
        <PanelShell
          title="Connection Details"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          {database.managed ? (
            <DetailRow
              label="Connection"
              value={
                database.managed.publishedPort == null
                  ? "Secure managed link"
                  : "Secure managed link + direct TCP"
              }
            />
          ) : (
            <DetailRow
              label="Endpoint"
              value={
                <span className="block break-all font-mono">
                  {database.host}:{database.port}
                </span>
              }
            />
          )}
          {database.managed?.publishedPort != null && database.managed.endpointHost && (
            <>
              <DetailRow
                label="Host"
                value={
                  <span className="block break-all font-mono">{database.managed.endpointHost}</span>
                }
              />
              <DetailRow
                label="Published TCP Port"
                value={<span className="font-mono">{database.managed.publishedPort}</span>}
              />
              {database.type === "clickhouse" && database.managed.publishedNativePort != null && (
                <DetailRow
                  label="Published Native TCP Port"
                  value={<span className="font-mono">{database.managed.publishedNativePort}</span>}
                />
              )}
            </>
          )}
          <DetailRow
            label="Target"
            value={<span className="font-mono">{database.databaseName || "-"}</span>}
          />
          <DetailRow
            label="TLS"
            value={
              connectionTLSUnverified ? (
                <Badge variant="warning">Enabled, not verified</Badge>
              ) : (
                <Badge variant={connectionTLSEnabled ? "success" : "secondary"}>
                  {connectionTLSEnabled ? "Enabled" : "Disabled"}
                </Badge>
              )
            }
          />
          <ManagedCertificateDetailRow status={certificateStatus ?? null} />
          <DetailRow
            label="Username"
            value={<span className="font-mono">{database.username || "-"}</span>}
          />
        </PanelShell>

        <PanelShell
          title="Database Information"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Status"
            value={
              <Badge variant={HEALTH_BADGE[healthStatus] ?? "secondary"}>
                {formatHealthStatusLabel(healthStatus)}
              </Badge>
            }
          />
          <DetailRow label="Provider" value={databaseTypeLabel(database.type)} />
          {(database.managed?.unavailableModules ?? []).length > 0 && (
            <DetailRow
              label="Modules"
              value={
                <span className="block max-w-[24rem] break-words text-right">
                  JSON and Bloom. Search is unavailable: this node&apos;s CPU has no AVX2
                  (x86-64-v3).
                </span>
              }
            />
          )}
          <DetailRow
            label="Last Check"
            value={<RelativeTime value={database.lastHealthCheckAt} fallback="Never" />}
          />
          {database.lastError && (
            <DetailRow
              label="Last Error"
              value={
                <span className="block max-w-[24rem] break-words text-right">
                  {database.lastError}
                </span>
              }
            />
          )}
        </PanelShell>
      </div>
    </div>
  );
}
