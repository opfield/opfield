import { EventEmitter } from 'node:events';
import { createChildLogger } from '@/lib/logger.js';
import type { CacheService } from '@/services/cache.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';

const logger = createChildLogger('NodeMonitoring');
const CONTAINER_STATS_KEY_PREFIX = 'container-stats:';
const CONTAINER_STATS_MAX = 30;
const CONTAINER_STATS_TTL = 600; // 10 minutes
/** One point per minute per container, kept for the charts of the last hour. */
const CONTAINER_STATS_MINUTE_KEY_PREFIX = 'container-stats-1m:';
/** The minute still being aggregated (one overwritable key per container). */
const CONTAINER_STATS_MINUTE_CURRENT_KEY_PREFIX = 'container-stats-1m-current:';
export const CONTAINER_STATS_MINUTE_MS = 60_000;
export const CONTAINER_STATS_MINUTE_MAX = 62; // 60 minutes + margin
export const CONTAINER_STATS_MINUTE_TTL = 3_900; // 65 minutes
const NODE_MONITORING_HISTORY_KEY_PREFIX = 'node-monitoring-history:v1:';
const NODE_MONITORING_HISTORY_TTL = 3_600; // 1 hour
const NODE_MONITORING_HISTORY_MAX = 60;
export const NODE_MONITORING_MAX_KEYS = 512;
export const NODE_MONITORING_IDLE_TTL_MS = 60 * 60 * 1000;

export const NODE_MONITORING_CADENCE_MS = {
  background: 10_000,
  stream: 5_000,
  focused: 2_000,
} as const;

export interface MonitoringSnapshot {
  timestamp: string;
  health: any;
  stats: any;
  traffic: any;
}

export function compactMonitoringHistorySnapshot(snapshot: any): MonitoringSnapshot {
  const health = snapshot?.health ?? {};
  const stats = snapshot?.stats ?? {};
  const traffic = snapshot?.traffic ?? null;
  return {
    timestamp: snapshot?.timestamp,
    health: {
      nginxRunning: health.nginxRunning,
      configValid: health.configValid,
      ...(typeof health.nginxServiceProblem === 'string' && health.nginxServiceProblem
        ? { nginxServiceProblem: health.nginxServiceProblem }
        : {}),
      nginxUptimeSeconds: health.nginxUptimeSeconds,
      workerCount: health.workerCount,
      nginxVersion: health.nginxVersion,
      nginxRssBytes: health.nginxRssBytes,
      cpuPercent: health.cpuPercent,
      loadAverage1m: health.loadAverage1m,
      loadAverage5m: health.loadAverage5m,
      loadAverage15m: health.loadAverage15m,
      systemMemoryUsedBytes: health.systemMemoryUsedBytes,
      systemMemoryTotalBytes: health.systemMemoryTotalBytes,
      systemMemoryAvailableBytes: health.systemMemoryAvailableBytes,
      swapUsedBytes: health.swapUsedBytes,
      swapTotalBytes: health.swapTotalBytes,
      diskReadBytes: health.diskReadBytes,
      diskWriteBytes: health.diskWriteBytes,
      diskMounts: Array.isArray(health.diskMounts)
        ? health.diskMounts.map((mount: any) => ({
            mountPoint: mount.mountPoint,
            filesystem: mount.filesystem,
            device: mount.device,
            totalBytes: mount.totalBytes,
            usedBytes: mount.usedBytes,
            freeBytes: mount.freeBytes,
            usagePercent: mount.usagePercent,
          }))
        : undefined,
      diskUsagePercent: health.diskUsagePercent,
      networkRxBytes: health.networkRxBytes,
      networkTxBytes: health.networkTxBytes,
      networkInterfaces: health.networkInterfaces,
      gpuDevices: Array.isArray(health.gpuDevices) ? health.gpuDevices : undefined,
      containerStats: Array.isArray(health.containerStats) ? health.containerStats : undefined,
    },
    stats: {
      activeConnections: stats.activeConnections,
      accepts: stats.accepts,
      handled: stats.handled,
      requests: stats.requests,
      reading: stats.reading,
      writing: stats.writing,
      waiting: stats.waiting,
    },
    traffic,
  };
}

/** Per-minute aggregate of one container's samples. Counters (network, block I/O) and PIDs keep the last reading. */
export interface ContainerMinuteAggregate {
  minute: number;
  samples: number;
  cpuSum: number;
  cpuCount: number;
  memorySum: number;
  memoryCount: number;
  last: Record<string, number>;
}

const CONTAINER_MINUTE_LAST_FIELDS = [
  'memoryUsageBytes',
  'memoryLimitBytes',
  'networkRxBytes',
  'networkTxBytes',
  'blockReadBytes',
  'blockWriteBytes',
  'pids',
] as const;

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function statField(stat: Record<string, any>, camel: string): number | null {
  const snake = camel.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
  return finiteNumber(stat[camel] ?? stat[snake]);
}

/**
 * Add one sample to the minute aggregate. When the sample opens a new minute, the previous aggregate comes back as
 * `finished` (to be stored as that minute's point) and a fresh aggregate starts.
 */
export function rollContainerMinute(
  current: ContainerMinuteAggregate | null,
  stat: Record<string, any>,
  now: number
): { next: ContainerMinuteAggregate; finished: ContainerMinuteAggregate | null } {
  const minute = Math.floor(now / CONTAINER_STATS_MINUTE_MS) * CONTAINER_STATS_MINUTE_MS;
  const sameMinute = current !== null && current.minute === minute;
  // A clock step back keeps aggregating into the newer minute rather than writing a point out of order.
  const keep = current !== null && current.minute > minute;
  const base: ContainerMinuteAggregate =
    sameMinute || keep
      ? { ...current!, last: { ...current!.last } }
      : { minute, samples: 0, cpuSum: 0, cpuCount: 0, memorySum: 0, memoryCount: 0, last: {} };
  const cpu = statField(stat, 'cpuPercent');
  const memory = statField(stat, 'memoryUsageBytes');
  base.samples += 1;
  if (cpu !== null) {
    base.cpuSum += cpu;
    base.cpuCount += 1;
  }
  if (memory !== null) {
    base.memorySum += memory;
    base.memoryCount += 1;
  }
  for (const field of CONTAINER_MINUTE_LAST_FIELDS) {
    const value = statField(stat, field);
    if (value !== null) base.last[field] = value;
  }
  return { next: base, finished: sameMinute || keep || current === null ? null : current };
}

/** The chart point of a minute aggregate, shaped like a raw sample and stamped at the minute start. */
export function containerMinutePoint(aggregate: ContainerMinuteAggregate): Record<string, unknown> {
  return {
    ...aggregate.last,
    timestamp: aggregate.minute,
    samples: aggregate.samples,
    ...(aggregate.cpuCount ? { cpuPercent: Math.round((aggregate.cpuSum / aggregate.cpuCount) * 100) / 100 } : {}),
    ...(aggregate.memoryCount ? { memoryUsageBytes: Math.round(aggregate.memorySum / aggregate.memoryCount) } : {}),
    ...(aggregate.last.memoryUsageBytes !== undefined ? { memoryLastBytes: aggregate.last.memoryUsageBytes } : {}),
  };
}

type MinuteStoreClient = {
  get(key: string): Promise<string | null>;
  multi(): {
    lpush(key: string, value: string): any;
    ltrim(key: string, start: number, stop: number): any;
    expire(key: string, seconds: number): any;
    set(key: string, value: string, mode: 'EX', seconds: number): any;
    exec(): Promise<unknown>;
  };
};

function parseMinuteAggregate(raw: string | null): ContainerMinuteAggregate | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ContainerMinuteAggregate;
    return Number.isFinite(parsed?.minute) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fold one health-report sample into the container's per-minute series: the in-progress minute lives in one key; when
 * the minute changes its point is pushed to the list (newest first, trimmed to the last hour). TTLs refresh on write.
 */
export async function recordContainerMinuteSample(
  client: MinuteStoreClient,
  containerId: string,
  stat: Record<string, any>,
  now = Date.now()
): Promise<void> {
  const currentKey = CONTAINER_STATS_MINUTE_CURRENT_KEY_PREFIX + containerId;
  const listKey = CONTAINER_STATS_MINUTE_KEY_PREFIX + containerId;
  const { next, finished } = rollContainerMinute(parseMinuteAggregate(await client.get(currentKey)), stat, now);
  const tx = client.multi();
  if (finished) {
    tx.lpush(listKey, JSON.stringify(containerMinutePoint(finished)));
    tx.ltrim(listKey, 0, CONTAINER_STATS_MINUTE_MAX - 1);
    tx.expire(listKey, CONTAINER_STATS_MINUTE_TTL);
  }
  tx.set(currentKey, JSON.stringify(next), 'EX', CONTAINER_STATS_MINUTE_TTL);
  await tx.exec();
}

export class NodeMonitoringService extends EventEmitter {
  private destroyed = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private historyActivity = new Map<string, number>();
  private history = new Map<string, MonitoringSnapshot[]>();
  private clientCounts = new Map<string, number>();
  private focusedClientCounts = new Map<string, number>();
  private pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private pollCadences = new Map<string, number>();
  private backgroundInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_HISTORY = NODE_MONITORING_HISTORY_MAX;
  private readonly BACKGROUND_POLL_INTERVAL = NODE_MONITORING_CADENCE_MS.background;
  private readonly STREAM_POLL_INTERVAL = NODE_MONITORING_CADENCE_MS.stream;
  private readonly ACTIVE_POLL_INTERVAL = NODE_MONITORING_CADENCE_MS.focused;

  constructor(
    private registry: NodeRegistryService,
    private cache?: CacheService
  ) {
    super();
    this.setMaxListeners(100);
    this.startBackgroundPolling();
  }

  /**
   * Background polling: collect health/stats for ALL connected nodes every 10s.
   * This ensures history is pre-populated before a user opens the monitoring page.
   * Stream consumers use 5s polling; an actively viewed Monitoring tab uses 2s.
   */
  private startBackgroundPolling(): void {
    // Delay start to let nodes connect first
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.destroyed) return;
      this.backgroundInterval = setInterval(() => {
        this.pruneHistory();
        const connectedNodes = this.registry.getConnectedNodeIds();
        for (const nodeId of connectedNodes) {
          // Skip nodes that already have stream-driven polling (2s or 5s)
          if (this.pollIntervals.has(nodeId)) continue;
          this.pollOnce(nodeId);
        }
      }, this.BACKGROUND_POLL_INTERVAL);
      logger.info('Background monitoring started for all connected nodes');
    }, 5000);
  }

  private pruneHistory(): void {
    const cutoff = Date.now() - NODE_MONITORING_IDLE_TTL_MS;
    for (const [id, lastWrite] of this.historyActivity) {
      if (lastWrite <= cutoff) {
        this.historyActivity.delete(id);
        this.history.delete(id);
      }
    }
  }

  async getHistory(nodeId: string): Promise<MonitoringSnapshot[]> {
    if (this.destroyed) return [];
    this.pruneHistory();
    let persisted: MonitoringSnapshot[] = [];
    if (this.cache) {
      try {
        const values = await this.cache.getClient().lrange(`${NODE_MONITORING_HISTORY_KEY_PREFIX}${nodeId}`, 0, -1);
        persisted = values.flatMap((value) => {
          try {
            return [JSON.parse(value) as MonitoringSnapshot];
          } catch {
            return [];
          }
        });
      } catch {
        // Redis is a read-model accelerator; retain the process-local fallback.
      }
    }
    if (this.destroyed) return [];
    this.pruneHistory();
    const local = (this.history.get(nodeId) ?? []).map(compactMonitoringHistorySnapshot);
    const byTimestamp = new Map(persisted.map((snapshot) => [snapshot.timestamp, snapshot]));
    for (const snapshot of local) byTimestamp.set(snapshot.timestamp, snapshot);
    return [...byTimestamp.values()]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-this.MAX_HISTORY);
  }

  pushSnapshot(nodeId: string, health: any, stats: any, traffic?: any): void {
    if (this.destroyed) return;
    this.pruneHistory();
    this.historyActivity.delete(nodeId);
    this.historyActivity.set(nodeId, Date.now());
    while (this.historyActivity.size > NODE_MONITORING_MAX_KEYS) {
      const oldest = this.historyActivity.keys().next().value!;
      this.historyActivity.delete(oldest);
      this.history.delete(oldest);
    }
    const snapshot = compactMonitoringHistorySnapshot({
      timestamp: new Date().toISOString(),
      health,
      stats,
      traffic: traffic ?? null,
    });
    let buf = this.history.get(nodeId);
    if (!buf) {
      buf = [];
      this.history.set(nodeId, buf);
    }
    buf.push(snapshot);
    if (buf.length > this.MAX_HISTORY) buf.splice(0, buf.length - this.MAX_HISTORY);
    this.emit('snapshot', { nodeId, snapshot });

    if (this.cache) {
      const key = `${NODE_MONITORING_HISTORY_KEY_PREFIX}${nodeId}`;
      const entry = JSON.stringify(snapshot);
      this.cache
        .getClient()
        .multi()
        .rpush(key, entry)
        .ltrim(key, -this.MAX_HISTORY, -1)
        .expire(key, NODE_MONITORING_HISTORY_TTL)
        .exec()
        .catch(() => {
          /* retain the process-local fallback when Redis is unavailable */
        });
    }

    // Store per-container stats in Redis for sparkline history
    if (this.cache && health?.containerStats) {
      for (const stat of health.containerStats as any[]) {
        if (stat.metricsAvailable === false || stat.metrics_available === false) continue;
        const cid = stat.containerId ?? stat.container_id;
        if (!cid) continue;
        const key = CONTAINER_STATS_KEY_PREFIX + cid;
        const entry = JSON.stringify({ ...stat, timestamp: Date.now() });
        this.cache
          .getClient()
          .lpush(key, entry)
          .then(() => {
            this.cache!.getClient().ltrim(key, 0, CONTAINER_STATS_MAX - 1);
            this.cache!.getClient().expire(key, CONTAINER_STATS_TTL);
          })
          .catch(() => {
            /* ignore redis errors */
          });
        recordContainerMinuteSample(this.cache.getClient(), cid, stat).catch(() => {
          /* ignore redis errors */
        });
      }
    }
  }

  async getContainerStatsHistory(containerId: string): Promise<Record<string, unknown>[]> {
    if (!this.cache) return [];
    try {
      const raw = await this.cache.getClient().lrange(CONTAINER_STATS_KEY_PREFIX + containerId, 0, -1);
      return raw.map((s) => JSON.parse(s)).reverse(); // oldest first
    } catch {
      return [];
    }
  }

  /**
   * One point per minute over the last hour (oldest first), the minute in progress last. For charts of the last hour;
   * the fine-grained recent samples stay in getContainerStatsHistory.
   */
  async getContainerStatsHourHistory(containerId: string, now = Date.now()): Promise<Record<string, unknown>[]> {
    if (!this.cache) return [];
    try {
      const client = this.cache.getClient();
      const [raw, current] = await Promise.all([
        client.lrange(CONTAINER_STATS_MINUTE_KEY_PREFIX + containerId, 0, -1),
        client.get(CONTAINER_STATS_MINUTE_CURRENT_KEY_PREFIX + containerId),
      ]);
      const cutoff = now - CONTAINER_STATS_MINUTE_MAX * CONTAINER_STATS_MINUTE_MS;
      const points = raw
        .flatMap((value) => {
          try {
            return [JSON.parse(value) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .reverse();
      const inProgress = parseMinuteAggregate(current);
      if (inProgress) points.push(containerMinutePoint(inProgress));
      return points.filter((point) => Number(point.timestamp) >= cutoff);
    } catch {
      return [];
    }
  }

  getLatestContainerStats(nodeId: string, containerId: string): Record<string, unknown> | null {
    const report = this.registry.getNode(nodeId)?.lastHealthReport;
    const stats = (report as any)?.containerStats;
    if (!Array.isArray(stats)) return null;
    return (
      (stats.find((item: any) => (item.containerId ?? item.container_id) === containerId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  registerClient(nodeId: string, options: { focused?: boolean } = {}): void {
    if (this.destroyed) return;
    const count = (this.clientCounts.get(nodeId) ?? 0) + 1;
    this.clientCounts.set(nodeId, count);
    if (options.focused) {
      this.focusedClientCounts.set(nodeId, (this.focusedClientCounts.get(nodeId) ?? 0) + 1);
    }
    this.syncPolling(nodeId);
  }

  unregisterClient(nodeId: string, options: { focused?: boolean } = {}): void {
    const count = Math.max(0, (this.clientCounts.get(nodeId) ?? 0) - 1);
    if (count === 0) this.clientCounts.delete(nodeId);
    else this.clientCounts.set(nodeId, count);

    if (options.focused) {
      const focusedCount = Math.max(0, (this.focusedClientCounts.get(nodeId) ?? 0) - 1);
      if (focusedCount === 0) this.focusedClientCounts.delete(nodeId);
      else this.focusedClientCounts.set(nodeId, focusedCount);
    }
    this.syncPolling(nodeId);
  }

  private async pollOnce(nodeId: string): Promise<void> {
    if (this.destroyed) return;
    try {
      const node = this.registry.getNode(nodeId);
      if (!node) return;
      if (this.registry.isNodeUpdateInProgress(nodeId)) return;

      try {
        node.commandStream.write({ commandId: '', requestHealth: {} }, (err: any) => {
          if (err) logger.debug('Health poll write failed', { nodeId, error: err.message });
        });
        node.commandStream.write({ commandId: '', requestStats: {} }, (err: any) => {
          if (err) logger.debug('Stats poll write failed', { nodeId, error: err.message });
        });
      } catch {
        // Stream may be closed
      }

      // Wait for daemon to respond and control.ts to update the registry
      await new Promise((r) => setTimeout(r, 1000));

      if (this.destroyed) return;
      const health = node.lastHealthReport;
      const stats = node.lastStatsReport;
      if (health) {
        // Traffic stats: nginx nodes only
        if (node.type === 'nginx') {
          void this.registry
            .requestTrafficStats(nodeId, { tailLines: 200, hostId: '', windowSeconds: 0 }, 10_000)
            .catch((error) => logger.debug('Traffic stats request failed', { nodeId, error: error.message }));
        }
        const traffic = node.type === 'nginx' ? (node.lastTrafficStats ?? null) : null;
        this.pushSnapshot(nodeId, health, stats, traffic);
      }
    } catch (err) {
      logger.debug('Polling error', { nodeId, error: (err as Error).message });
    }
  }

  private syncPolling(nodeId: string): void {
    if (this.destroyed) return;
    const clientCount = this.clientCounts.get(nodeId) ?? 0;
    if (clientCount === 0) {
      this.stopPolling(nodeId);
      return;
    }

    const cadence =
      (this.focusedClientCounts.get(nodeId) ?? 0) > 0 ? this.ACTIVE_POLL_INTERVAL : this.STREAM_POLL_INTERVAL;
    if (this.pollCadences.get(nodeId) === cadence) return;

    this.stopPolling(nodeId);
    this.startPolling(nodeId, cadence);
  }

  private startPolling(nodeId: string, cadence: number): void {
    if (this.pollIntervals.has(nodeId)) return;
    logger.debug('Starting stream-driven polling for node', { nodeId, cadence });

    this.pollOnce(nodeId);
    this.pollCadences.set(nodeId, cadence);
    this.pollIntervals.set(
      nodeId,
      setInterval(() => this.pollOnce(nodeId), cadence)
    );
  }

  private stopPolling(nodeId: string): void {
    const interval = this.pollIntervals.get(nodeId);
    if (interval) {
      clearInterval(interval);
      this.pollIntervals.delete(nodeId);
      this.pollCadences.delete(nodeId);
      logger.debug('Stopped polling for node', { nodeId });
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.history.clear();
    this.historyActivity.clear();
    this.removeAllListeners();
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
    }
    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }
    this.pollIntervals.clear();
    this.pollCadences.clear();
    this.clientCounts.clear();
    this.focusedClientCounts.clear();
  }
}
