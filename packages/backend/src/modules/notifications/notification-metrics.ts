import { isPerDeviceNodeMetric, ROUTE_SHARE_MIN_REQUESTS } from './notification-catalog.js';

// ── Threshold Metric Extraction ───────────────────────────────────────

/** Given a category + metric, extract its value from a health report */
export function extractMetricFromHealthReport(
  category: string,
  metric: string,
  healthData: any,
  metricTarget?: string | null
): { values: Array<{ resourceId: string; value: number }> } | null {
  if (category === 'node') {
    switch (metric) {
      case 'cpu': {
        const cpu = healthData.cpuPercent ?? healthData.cpu_percent;
        if (typeof cpu !== 'number') return null;
        return { values: [{ resourceId: 'system', value: cpu }] };
      }
      case 'memory': {
        const total = healthData.systemMemoryTotalBytes ?? healthData.system_memory_total_bytes ?? 0;
        const used = healthData.systemMemoryUsedBytes ?? healthData.system_memory_used_bytes ?? 0;
        if (!total) return null;
        return { values: [{ resourceId: 'system', value: (used / total) * 100 }] };
      }
      case 'disk': {
        const mounts: any[] = healthData.diskMounts ?? healthData.disk_mounts ?? [];
        if (!Array.isArray(mounts) || mounts.length === 0) {
          const free = healthData.diskFreeBytes ?? healthData.disk_free_bytes;
          const total = healthData.diskTotalBytes ?? healthData.disk_total_bytes;
          if (typeof free !== 'number' || typeof total !== 'number' || total === 0) return null;
          if (metricTarget && metricTarget !== '/') return null;
          return { values: [{ resourceId: '/', value: ((total - free) / total) * 100 }] };
        }
        const normalizedTarget = metricTarget?.trim() || null;
        const filteredMounts = normalizedTarget
          ? mounts.filter((m: any) => (m.mountPoint ?? m.mount_point ?? '/') === normalizedTarget)
          : mounts;
        if (filteredMounts.length === 0) return null;
        return {
          values: filteredMounts.map((m: any) => ({
            resourceId: m.mountPoint ?? m.mount_point ?? '/',
            value: m.usagePercent ?? m.usage_percent ?? 0,
          })),
        };
      }
    }

    if (isPerDeviceNodeMetric(metric)) {
      return extractGpuMetricFromHealthReport(metric, healthData, metricTarget);
    }
  }

  if (category === 'container') {
    const stats: any[] = healthData.containerStats ?? healthData.container_stats ?? [];
    if (!Array.isArray(stats)) return null;
    const metricStats = stats.filter((s: any) => s.metricsAvailable !== false && s.metrics_available !== false);
    switch (metric) {
      case 'cpu':
        return {
          values: metricStats.map((s: any) => ({
            resourceId: s.name ?? s.containerId ?? '',
            value: s.cpuPercent ?? s.cpu_percent ?? 0,
          })),
        };
      case 'memory':
        return {
          values: metricStats.map((s: any) => {
            const used = s.memoryUsageBytes ?? s.memory_usage_bytes ?? 0;
            const limit = s.memoryLimitBytes ?? s.memory_limit_bytes ?? 0;
            return {
              resourceId: s.name ?? s.containerId ?? '',
              value: limit > 0 ? (used / limit) * 100 : 0,
            };
          }),
        };
      case 'log_size':
        // Containers whose log size is unknown (no readable files, or an older daemon) are
        // left out rather than reported as empty.
        return {
          values: metricStats
            .filter((s: any) => s.logBytesAvailable === true || s.log_bytes_available === true)
            .map((s: any) => ({
              resourceId: s.name ?? s.containerId ?? '',
              value: Number(s.logBytes ?? s.log_bytes ?? 0) / (1024 * 1024),
            })),
        };
    }
  }

  return null;
}

function gpuMetricIsAvailable(device: Record<string, unknown>, metric: string): boolean {
  const availableMetrics = device.availableMetrics ?? device.available_metrics;
  return (
    Array.isArray(availableMetrics) &&
    availableMetrics.some((candidate) => typeof candidate === 'string' && candidate.trim() === metric)
  );
}

function gpuNumberMetric(device: Record<string, unknown>, availability: string, ...fields: string[]): number | null {
  if (!gpuMetricIsAvailable(device, availability)) return null;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function gpuBooleanMetric(device: Record<string, unknown>, availability: string, ...fields: string[]): boolean | null {
  if (!gpuMetricIsAvailable(device, availability)) return null;
  const raw = fields.map((field) => device[field]).find((value) => value !== undefined && value !== null);
  return typeof raw === 'boolean' ? raw : null;
}

function gpuHealthMetric(device: Record<string, unknown>): string | null {
  if (!gpuMetricIsAvailable(device, 'health')) return null;
  const raw = device.health;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

/**
 * GPU telemetry is capability-aware. Unlike legacy host metrics, each field
 * is unavailable until the daemon explicitly reports it in availableMetrics.
 */
function extractGpuMetricFromHealthReport(
  metric: string,
  healthData: any,
  metricTarget?: string | null
): { values: Array<{ resourceId: string; value: number }> } | null {
  const devices = healthData.gpuDevices ?? healthData.gpu_devices;
  if (!Array.isArray(devices)) return null;

  const target = metricTarget?.trim() || null;
  const values = devices.flatMap((rawDevice: unknown) => {
    if (!rawDevice || typeof rawDevice !== 'object') return [];
    const device = rawDevice as Record<string, unknown>;
    const idValue = device.id ?? device.Id;
    const resourceId = typeof idValue === 'string' ? idValue.trim() : '';
    if (!resourceId || (target && resourceId !== target)) return [];

    let value: number | null = null;
    switch (metric) {
      case 'gpu_utilization_percent':
        value = gpuNumberMetric(device, 'utilization_percent', 'utilizationPercent', 'utilization_percent');
        break;
      case 'gpu_memory_used_percent': {
        const total = gpuNumberMetric(device, 'memory_total_bytes', 'memoryTotalBytes', 'memory_total_bytes');
        const used = gpuNumberMetric(device, 'memory_used_bytes', 'memoryUsedBytes', 'memory_used_bytes');
        value = total !== null && total > 0 && used !== null ? (used / total) * 100 : null;
        break;
      }
      case 'gpu_temperature_celsius':
        value = gpuNumberMetric(device, 'temperature_celsius', 'temperatureCelsius', 'temperature_celsius');
        break;
      case 'gpu_power_percent_of_limit': {
        const power = gpuNumberMetric(device, 'power_watts', 'powerWatts', 'power_watts');
        const limit = gpuNumberMetric(device, 'power_limit_watts', 'powerLimitWatts', 'power_limit_watts');
        value = power !== null && limit !== null && limit > 0 ? (power / limit) * 100 : null;
        break;
      }
      case 'gpu_throttled': {
        const throttled = gpuBooleanMetric(device, 'throttled', 'throttled');
        value = throttled === null ? null : throttled ? 1 : 0;
        break;
      }
      case 'gpu_health_degraded': {
        const health = gpuHealthMetric(device);
        value = health === null ? null : health === 'healthy' ? 0 : 1;
        break;
      }
      case 'gpu_ecc_corrected_errors':
        value = gpuNumberMetric(device, 'ecc_corrected_errors', 'eccCorrectedErrors', 'ecc_corrected_errors');
        break;
      case 'gpu_ecc_uncorrected_errors':
        value = gpuNumberMetric(device, 'ecc_uncorrected_errors', 'eccUncorrectedErrors', 'ecc_uncorrected_errors');
        break;
    }

    return value !== null && Number.isFinite(value) ? [{ resourceId, value }] : [];
  });

  return values.length > 0 ? { values } : null;
}

export function extractMetricFromDatabaseSnapshot(
  category: string,
  metric: string,
  snapshot: { databaseId: string; metrics: Record<string, number | null> }
): { values: Array<{ resourceId: string; value: number }> } | null {
  if (category !== 'database_postgres' && category !== 'database_clickhouse' && category !== 'database_redis') {
    return null;
  }
  const value =
    metric === 'managed_memory_pct'
      ? managedMemoryPercent(snapshot.metrics)
      : metric === 'managed_disk_pct'
        ? managedDiskPercent(snapshot.metrics)
        : snapshot.metrics[metric];
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return { values: [{ resourceId: snapshot.databaseId, value }] };
}

/** Memory of a managed database's container as a share of its limit; null without a limit (or not managed). */
function managedMemoryPercent(metrics: Record<string, number | null>): number | null {
  const used = metrics.managed_memory_usage_bytes;
  const limit = metrics.managed_memory_limit_bytes;
  if (typeof used !== 'number' || typeof limit !== 'number' || !(limit > 0)) return null;
  return (used / limit) * 100;
}

/** The data disk of a managed database as a share of its size; null when its node does not report it. */
function managedDiskPercent(metrics: Record<string, number | null>): number | null {
  const used = metrics.managed_disk_used_bytes;
  const total = metrics.managed_disk_total_bytes;
  if (typeof used !== 'number' || typeof total !== 'number' || !(total > 0)) return null;
  return (used / total) * 100;
}

/** HTTP numbers of a route over a window, as the nginx daemon reports them (summed over the nodes serving it). */
export interface RouteTrafficSample {
  totalRequests: number;
  statusCodes: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
  requestsPerSecond: number;
  p95ResponseTime: number;
}

/**
 * Request metrics of a route or an app environment from its traffic (see ROUTE_TRAFFIC_METRICS): 4xx/5xx shares in
 * percent (0 below ROUTE_SHARE_MIN_REQUESTS requests), requests per second, and the worst p95 in milliseconds (the
 * daemon reports seconds; 0 without requests).
 */
export function routeTrafficMetrics(samples: readonly RouteTrafficSample[]): Record<string, number | null> {
  const total = samples.reduce((sum, sample) => sum + (Number(sample.totalRequests) || 0), 0);
  const count = (pick: (sample: RouteTrafficSample) => number) =>
    samples.reduce((sum, sample) => sum + (Number(pick(sample)) || 0), 0);
  const share = (errors: number) => (total >= ROUTE_SHARE_MIN_REQUESTS ? (errors / total) * 100 : 0);
  const p95 = samples.reduce((worst, sample) => Math.max(worst, Number(sample.p95ResponseTime) || 0), 0);
  return {
    error_5xx_percent: share(count((sample) => sample.statusCodes?.s5xx ?? 0)),
    error_4xx_percent: share(count((sample) => sample.statusCodes?.s4xx ?? 0)),
    requests_per_second: count((sample) => sample.requestsPerSecond),
    // No requests is no latency: 0, so a firing p95 alert resolves once traffic stops.
    latency_p95_ms: total > 0 ? p95 * 1000 : 0,
    requests: total,
    errors_5xx: count((sample) => sample.statusCodes?.s5xx ?? 0),
    errors_4xx: count((sample) => sample.statusCodes?.s4xx ?? 0),
  };
}

/**
 * Managed storage metrics from a monitoring sample of its storage connection: disk_used_pct from the disk its node
 * reports (disk_used_bytes / disk_total_bytes). A sample without them (a provider storage, a stale node report) has none.
 */
export function extractMetricFromStorageSnapshot(
  category: string,
  metric: string,
  snapshot: { storageId: string; metrics: Record<string, number | null> }
): { values: Array<{ resourceId: string; value: number }> } | null {
  if (category !== 'managed_storage' || metric !== 'disk_used_pct') return null;
  const used = snapshot.metrics.disk_used_bytes;
  const total = snapshot.metrics.disk_total_bytes;
  if (typeof used !== 'number' || typeof total !== 'number' || !Number.isFinite(used) || !(total > 0)) return null;
  return { values: [{ resourceId: snapshot.storageId, value: (used / total) * 100 }] };
}

/** Evaluate a threshold condition */
export function evaluateThreshold(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    default:
      return false;
  }
}

export interface WindowProbeSample {
  timestamp: number;
  breached: boolean;
}

export interface WindowRatioEvaluation {
  hasCoverage: boolean;
  sampleCount: number;
  matchingSamples: number;
  ratioPercent: number;
  thresholdMet: boolean;
  /**
   * Start of the trailing run of samples in the target state (when the resource got back to normal, for 'clear'):
   * an alert's duration ends there, not when its resolve window was covered.
   */
  targetSince: number | null;
}

export function evaluateWindowRatio(
  samples: WindowProbeSample[],
  targetState: 'breach' | 'clear',
  thresholdPercent: number,
  windowMs: number,
  now = Date.now()
): WindowRatioEvaluation {
  if (samples.length === 0) {
    return {
      hasCoverage: windowMs === 0,
      sampleCount: 0,
      matchingSamples: 0,
      ratioPercent: 0,
      thresholdMet: false,
      targetSince: null,
    };
  }

  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp);
  const oldestTimestamp = sorted[0]?.timestamp ?? now;
  const hasCoverage = windowMs === 0 || oldestTimestamp <= now - windowMs;
  const matchingSamples = sorted.filter((sample) =>
    targetState === 'breach' ? sample.breached : !sample.breached
  ).length;
  const ratioPercent = (matchingSamples / sorted.length) * 100;
  let targetSince: number | null = null;
  for (const sample of sorted) {
    const matches = targetState === 'breach' ? sample.breached : !sample.breached;
    if (!matches) targetSince = null;
    else targetSince ??= sample.timestamp;
  }

  return {
    hasCoverage,
    sampleCount: sorted.length,
    matchingSamples,
    ratioPercent,
    thresholdMet: hasCoverage && ratioPercent >= thresholdPercent,
    targetSince,
  };
}
