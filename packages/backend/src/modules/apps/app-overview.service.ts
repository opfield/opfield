import { createHash } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnections,
  objectStorageConnections,
  pageDeployments,
  pageProjects,
  pageRouteTargets,
  proxyHosts,
} from '@/db/schema/index.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { NodeMonitoringService } from '@/modules/nodes/node-monitoring.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { CacheService } from '@/services/cache.service.js';
import { availabilityOverviews } from './app-availability-overview.js';
import { assessEnvironment } from './app-environment-health.js';
import {
  type AppHealthService,
  databaseDiskPercent,
  type MemberStatus,
  storageDiskPercent,
} from './app-health.service.js';
import type { AppMember, AppMembersReader } from './app-members.service.js';
import type { AppOverviewDatabaseMetric, AppOverviewStorageMetric } from './app-overview-metrics.js';
import { latestOf, type OverviewRange, type OverviewSample, overviewSamples } from './app-overview-sources.js';
import {
  APP_STORAGE_OBJECTS_KEY_PREFIX,
  type ObjectCountSample,
  type RouteTrafficSample,
  readSamples,
  routeTrafficKey,
  type WorkloadSample,
  workloadSampleKey,
} from './app-workload-sampler.js';
import type { AppsService } from './apps.service.js';

export {
  APP_OVERVIEW_ALERT_TONES,
  type AppOverviewAlert,
  type AppOverviewAlertTone,
  environmentAlerts,
} from './app-environment-health.js';
export type { OverviewRange } from './app-overview-sources.js';

const RANGE_MS: Record<OverviewRange, number> = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };
/** Points per series. */
export const OVERVIEW_POINTS = 24;
const CACHE_TTL_MS = 15_000;
/** A route sample older than this is no current rate (the sampler writes one a minute). */
const CURRENT_SAMPLE_MAX_AGE_MS = 3 * 60 * 1000;

type Point = { at: number; value: number };

/**
 * Bucket samples into OVERVIEW_POINTS points over the range ending now (mean per bucket); empty buckets are null.
 * An empty input gives an empty series (unknown), never a row of zeros.
 */
export function bucketSeries(points: readonly Point[], range: OverviewRange, now = Date.now()): Array<number | null> {
  if (points.length === 0) return [];
  const span = RANGE_MS[range];
  const start = now - span;
  const width = span / OVERVIEW_POINTS;
  const sums = new Array<number>(OVERVIEW_POINTS).fill(0);
  const counts = new Array<number>(OVERVIEW_POINTS).fill(0);
  for (const point of points) {
    if (point.at < start || point.at > now || !Number.isFinite(point.value)) continue;
    const index = Math.min(OVERVIEW_POINTS - 1, Math.floor((point.at - start) / width));
    sums[index] += point.value;
    counts[index] += 1;
  }
  if (counts.every((count) => count === 0)) return [];
  return sums.map((sum, index) => (counts[index] ? Math.round((sum / counts[index]) * 100) / 100 : null));
}

/**
 * A bucket without samples carries the last known value (samples sparser than the buckets, a missed poll), so a gap
 * is never drawn or summed as 0. Buckets before the first sample stay null (no data yet).
 */
export function fillGaps(series: ReadonlyArray<number | null>): Array<number | null> {
  let last: number | null = null;
  return series.map((value) => {
    if (value !== null && value !== undefined) last = value;
    return last;
  });
}

/** Element-wise mean of series; each series' gaps carry its last value, a point no series knows stays null. */
export function averageSeries(series: ReadonlyArray<Array<number | null>>): Array<number | null> {
  const present = series.filter((item) => item.length > 0).map(fillGaps);
  if (present.length === 0) return [];
  return Array.from({ length: OVERVIEW_POINTS }, (_, index) => {
    const values = present.map((item) => item[index]).filter((value): value is number => value != null);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  });
}

/**
 * Element-wise sum of series; each series' gaps carry its last value (so a missed sample of one member is no dip),
 * a point no series knows stays null. `carry: false` for per-bucket counts (restarts), where a gap adds nothing.
 */
export function sumSeries(
  series: ReadonlyArray<Array<number | null>>,
  options: { carry?: boolean } = {}
): Array<number | null> {
  const carry = options.carry ?? true;
  const present = series.filter((item) => item.length > 0).map((item) => (carry ? fillGaps(item) : item));
  if (present.length === 0) return [];
  return Array.from({ length: OVERVIEW_POINTS }, (_, index) => {
    const values = present.map((item) => item[index]).filter((value): value is number => value != null);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100 : null;
  });
}

/**
 * Restarts of one workload from its per-minute samples: the increase of Docker's RestartCount between consecutive
 * samples (a new runtime counts its own restarts from 0), summed over the range and per bucket. Unknown (null total,
 * empty series, null since) until a sample with a count falls in the range; from the first such sample (`since`) on
 * the total starts at 0, and a bucket with samples but no restart is 0.
 */
export function restartSeries(
  samples: readonly WorkloadSample[],
  range: OverviewRange,
  now = Date.now()
): { total: number | null; history: Array<number | null>; since: number | null } {
  const span = RANGE_MS[range];
  const start = now - span;
  const width = span / OVERVIEW_POINTS;
  const sorted = [...samples].sort((left, right) => left.at - right.at);
  const buckets = new Array<number | null>(OVERVIEW_POINTS).fill(null);
  let total: number | null = null;
  let since: number | null = null;
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    if (current.at < start || current.at > now) continue;
    const bucket = Math.min(OVERVIEW_POINTS - 1, Math.floor((current.at - start) / width));
    buckets[bucket] = buckets[bucket] ?? 0;
    if (current.restartCount !== null && since === null) {
      since = current.at;
      total = 0;
    }
    const previous = sorted[index - 1];
    if (!previous || previous.restartCount === null || current.restartCount === null) continue;
    const increase =
      previous.runtime === current.runtime
        ? Math.max(0, current.restartCount - previous.restartCount)
        : current.restartCount;
    buckets[bucket] = (buckets[bucket] ?? 0) + increase;
    total = (total ?? 0) + increase;
  }
  if (total === null) return { total: null, history: [], since: null };
  return { total, history: buckets, since };
}

/**
 * When the restart samples of an environment's workloads start (ISO), while they do not yet cover the whole range
 * (the sampler keeps a day); null once the range is covered or nothing is known.
 */
export function restartsSince(
  sinces: ReadonlyArray<number | null>,
  range: OverviewRange,
  now = Date.now()
): string | null {
  const known = sinces.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  const earliest = Math.min(...known);
  const span = RANGE_MS[range];
  // Samples are a minute apart: the first one within a bucket of the range start covers it.
  const covered = earliest <= now - span + span / OVERVIEW_POINTS;
  return covered ? null : new Date(earliest).toISOString();
}

/**
 * Healthy share (percent) of one workload per bucket from its per-minute samples; minutes it was stopped on request
 * or its health check had not reported do not count either way.
 */
export function healthySeries(
  samples: readonly WorkloadSample[],
  range: OverviewRange,
  now = Date.now()
): Array<number | null> {
  return bucketSeries(
    samples.flatMap((sample) =>
      sample.state === 'stopped' || sample.state === 'none' ? [] : [{ at: sample.at, value: sample.healthy ? 100 : 0 }]
    ),
    range,
    now
  );
}

/**
 * A database's throughput by engine: transactions (PostgreSQL), operations (key-value) or queries (ClickHouse) per
 * second. Samples written before 2.12.2 stored the key-value and ClickHouse rates under transaction_rate.
 */
export function throughputOf(
  type: string,
  latest: (metric: AppOverviewDatabaseMetric) => number | null,
  points: (metric: AppOverviewDatabaseMetric) => Array<number | null>
): {
  transactionsPerSecond: number | null;
  transactionsHistory: Array<number | null>;
  throughputUnit: 'tx' | 'ops' | 'q';
} {
  const [metric, unit] =
    type === 'redis'
      ? (['instantaneous_ops_per_sec', 'ops'] as const)
      : type === 'clickhouse'
        ? (['query_rate', 'q'] as const)
        : (['transaction_rate', 'tx'] as const);
  const own = points(metric);
  const legacy = metric === 'transaction_rate' ? own : points('transaction_rate');
  const history = own.length ? own.map((value, index) => value ?? legacy[index] ?? null) : legacy;
  return {
    transactionsPerSecond: latest(metric) ?? (metric === 'transaction_rate' ? null : latest('transaction_rate')),
    transactionsHistory: history.some((value) => value !== null) ? history : [],
    throughputUnit: unit,
  };
}

/** Where the routes' latency comes from: requests (p95), health-check probes when idle, or nothing. */
export type RouteLatencySource = 'traffic' | 'probe' | null;

/**
 * Routes latency of an environment: the request p95 while there is traffic, else the health-check probe response
 * time (mean of the routes' latest probes, and its history), else unknown.
 */
export function routeLatency(
  routes: ReadonlyArray<{
    requestsPerSecond: number | null;
    latencyMs: number | null;
    latencyHistory: Array<number | null>;
    probeLatencyMs: number | null;
    probeLatencyHistory: Array<number | null>;
  }>
): { latencyMs: number | null; latencyHistory: Array<number | null>; latencySource: RouteLatencySource } {
  const busy = routes.filter((route) => (route.requestsPerSecond ?? 0) > 0 && route.latencyMs !== null);
  if (busy.length > 0) {
    return {
      latencyMs: average(busy.map((route) => route.latencyMs)),
      latencyHistory: averageSeries(routes.map((route) => route.latencyHistory)),
      latencySource: 'traffic',
    };
  }
  const probed = routes.filter((route) => route.probeLatencyMs !== null);
  if (probed.length > 0) {
    return {
      latencyMs: average(probed.map((route) => route.probeLatencyMs)),
      latencyHistory: averageSeries(routes.map((route) => route.probeLatencyHistory)),
      latencySource: 'probe',
    };
  }
  return { latencyMs: null, latencyHistory: [], latencySource: null };
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.round(present.reduce((total, value) => total + value, 0) / present.length) : null;
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** The bucketed series of a metric over overview samples, gaps carrying the last value. */
function samplePoints<T extends string>(
  samples: readonly OverviewSample[],
  range: OverviewRange,
  now: number
): (metric: T) => Array<number | null> {
  return (metric) =>
    fillGaps(
      bucketSeries(
        samples.map((sample) => ({
          at: Date.parse(sample.timestamp),
          value: num(sample.metrics[metric]) ?? Number.NaN,
        })),
        range,
        now
      )
    );
}

/**
 * The cards of one database from its overview samples. Reads only metrics of the overview contract
 * (APP_OVERVIEW_DATABASE_METRICS), which the core's writer stores.
 */
export function databaseCards(
  row: { type: string; manualSizeLimitMb: number | null },
  samples: readonly OverviewSample[],
  range: OverviewRange,
  now = Date.now()
) {
  const latest = (metric: AppOverviewDatabaseMetric) => latestOf(samples, metric);
  const points = samplePoints<AppOverviewDatabaseMetric>(samples, range, now);
  // PostgreSQL connections, key-value clients, ClickHouse running queries.
  const connectionsMetric: AppOverviewDatabaseMetric =
    row.type === 'redis' ? 'connected_clients' : row.type === 'clickhouse' ? 'running_queries' : 'total_connections';
  const legacyConnections = row.type === 'postgres' ? [] : points('total_connections');
  const connectionsHistory = points(connectionsMetric);
  const size = latest('database_size_bytes');
  return {
    diskBytes: size,
    /** The database's size limit; null without one. */
    diskLimitBytes: row.manualSizeLimitMb ? row.manualSizeLimitMb * 1024 * 1024 : null,
    diskPercent: databaseDiskPercent(size, row.manualSizeLimitMb),
    diskHistory: points('database_size_bytes'),
    connections: latest(connectionsMetric) ?? (row.type === 'postgres' ? null : latest('total_connections')),
    maxConnections: latest('max_connections'),
    connectionsHistory: connectionsHistory.length ? connectionsHistory : legacyConnections,
    ...throughputOf(row.type, latest, points),
    cacheHitPercent: latest('cache_hit_ratio'),
    cacheHitHistory: points('cache_hit_ratio'),
    cpuPercent: latest('managed_cpu_percent'),
    cpuHistory: points('managed_cpu_percent'),
  };
}

/**
 * The cards of one storage from its overview samples (APP_OVERVIEW_STORAGE_METRICS only), and the object counts the
 * sampler lists when the engine reports none.
 */
export function storageCards(
  samples: readonly OverviewSample[],
  counted: readonly ObjectCountSample[],
  range: OverviewRange,
  now = Date.now()
) {
  const latest = (metric: AppOverviewStorageMetric) => latestOf(samples, metric);
  const points = samplePoints<AppOverviewStorageMetric>(samples, range, now);
  // Network counters are cumulative: rates come from consecutive samples (a reset, such as a restart, is skipped).
  const rate = (metric: AppOverviewStorageMetric) => {
    const out: Point[] = [];
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      const delta = (num(current.metrics[metric]) ?? Number.NaN) - (num(previous.metrics[metric]) ?? Number.NaN);
      const seconds = (Date.parse(current.timestamp) - Date.parse(previous.timestamp)) / 1000;
      if (Number.isFinite(delta) && delta >= 0 && seconds > 0)
        out.push({ at: Date.parse(current.timestamp), value: delta / seconds });
    }
    return out;
  };
  const used = latest('disk_used_bytes');
  const reported = points('object_count');
  const objectsHistory = reported.some((value) => value !== null)
    ? reported
    : fillGaps(
        bucketSeries(
          counted.map((sample) => ({ at: sample.at, value: sample.count })),
          range,
          now
        )
      );
  const rx = rate('network_rx_bytes');
  const tx = rate('network_tx_bytes');
  return {
    diskBytes: used,
    /** The storage's quota (its disk); null when the engine reports none. */
    diskTotalBytes: latest('disk_total_bytes'),
    diskPercent: storageDiskPercent(used, latest('disk_total_bytes')),
    diskHistory: points('disk_used_bytes'),
    objects: latest('object_count') ?? counted.at(-1)?.count ?? null,
    objectsHistory,
    buckets: latest('bucket_count'),
    rxBytesPerSecond: rx.at(-1)?.value ?? null,
    rxHistory: fillGaps(bucketSeries(rx, range, now)),
    txBytesPerSecond: tx.at(-1)?.value ?? null,
    txHistory: fillGaps(bucketSeries(tx, range, now)),
  };
}

/**
 * A route's traffic from its per-minute access-log samples: the latest minute's rates (null when the newest sample is
 * older than three minutes or there is none) and per-bucket means of requests, 5xx and bytes per second and the p95
 * latency of the minutes with requests.
 */
export function routeTraffic(samples: readonly RouteTrafficSample[], range: OverviewRange, now = Date.now()) {
  const perSecond = (pick: (sample: RouteTrafficSample) => number) =>
    fillGaps(
      bucketSeries(
        samples.map((sample) => ({
          at: sample.at,
          value: sample.seconds > 0 ? pick(sample) / sample.seconds : Number.NaN,
        })),
        range,
        now
      )
    );
  const latest = samples.at(-1);
  const current = latest && now - latest.at <= CURRENT_SAMPLE_MAX_AGE_MS && latest.seconds > 0 ? latest : null;
  return {
    requestsPerSecond: current ? current.requests / current.seconds : null,
    requestsHistory: perSecond((sample) => sample.requests),
    errorsPerSecond: current ? current.errors / current.seconds : null,
    errorsHistory: perSecond((sample) => sample.errors),
    latencyMs: current?.p95Ms ?? null,
    latencyHistory: bucketSeries(
      samples.map((sample) => ({ at: sample.at, value: sample.p95Ms ?? Number.NaN })),
      range,
      now
    ),
    trafficBytesPerSecond: current ? current.bytes / current.seconds : null,
    trafficHistory: perSecond((sample) => sample.bytes),
  };
}

/**
 * CPU and memory points of a workload: its per-minute samples (kept a day under the member, so a recreate keeps them),
 * and for the time before its first sample with usage the node's minute history of its current container (one hour).
 */
export function workloadUsagePoints(
  samples: readonly WorkloadSample[],
  minuteHistory: ReadonlyArray<Record<string, unknown>>,
  pick: 'cpuPercent' | 'memoryBytes'
): Point[] {
  const own = samples.flatMap((sample) => {
    const value = sample[pick];
    return typeof value === 'number' && Number.isFinite(value) ? [{ at: sample.at, value }] : [];
  });
  const first = own[0]?.at ?? Number.POSITIVE_INFINITY;
  const field = pick === 'cpuPercent' ? 'cpuPercent' : 'memoryUsageBytes';
  const earlier = minuteHistory.flatMap((entry) => {
    const at = num(entry.timestamp);
    const value = num(entry[field]);
    return at !== null && value !== null && at < first - 30_000 ? [{ at, value }] : [];
  });
  return [...earlier, ...own];
}

/**
 * Monitoring overview of an app: per visible environment, the health of its members, issues and alerts (the same
 * assessment the Apps list uses), and 24-point series for containers, databases, storage, routes and Pages over 1 or
 * 24 hours, read once per source per request and cached for 15 s per app, range and caller scopes. Only members the
 * caller may view appear. Unknown values are null and unknown series empty; a series that starts later than the range
 * has leading nulls.
 */
export class AppOverviewService {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly apps: AppsService,
    private readonly members: AppMembersReader,
    private readonly health: AppHealthService
  ) {}

  async overview(scopes: readonly string[], appId: string, range: OverviewRange = '1h') {
    // Environments seen only through members count only those members, like every other environment here.
    const { app, envs, environmentIds: envIds } = await this.apps.resolveVisible(scopes, appId);
    const scopeHash = createHash('sha256')
      .update([...scopes].sort().join('\n'))
      .digest('base64url');
    const key = `${app.id}:${range}:${scopeHash}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    if (this.cache.size > 500) this.cache.clear();

    const visible = await this.members.listVisibleMembers(scopes, envIds);
    const now = Date.now();
    const [statuses, signals] = await Promise.all([
      this.health.memberStatuses(visible),
      this.health.memberSignals(visible, now),
    ]);
    const [containerSeries, databases, storages, routes, pages] = await Promise.all([
      this.containerSeries(statuses, range, now),
      this.databaseSection(visible, range, now),
      this.storageSection(visible, range, now),
      this.routeSection(visible, range, now),
      this.pagesSection(visible, range, now),
    ]);

    const environments = envs
      .filter((env) => envIds.includes(env.id))
      .map((env) => {
        const own = statuses.filter((status) => status.member.environmentId === env.id);
        const assessment = assessEnvironment({ envName: env.name, statuses: own, signals });
        const workloads = own.filter(
          (status) => status.member.type === 'container' || status.member.type === 'deployment'
        );
        // Stopped on request, or a health check that has not reported: neither healthy nor unhealthy, and the
        // Healthy card leaves them out.
        const running = workloads.filter((status) => status.health !== 'stopped' && status.health !== 'none');
        const checked = running.filter((status) => status.hasHealthCheck === true);
        const sum = (values: Array<number | null>) => {
          const present = values.filter((value): value is number => value !== null);
          return present.length ? Math.round(present.reduce((total, value) => total + value, 0) * 10) / 10 : null;
        };
        const envContainers = containerSeries.filter((entry) => entry.environmentId === env.id);
        const envDatabases = databases.filter((entry) => entry.environmentId === env.id);
        const envStorage = storages.filter((entry) => entry.environmentId === env.id);
        const envRoutes = routes.filter((entry) => entry.environmentId === env.id);
        const envPages = pages.filter((entry) => entry.environmentId === env.id);
        return {
          environmentId: env.id,
          health: assessment.health,
          members: own.length,
          issues: assessment.issues,
          alerts: assessment.alerts,
          containers: {
            total: workloads.length,
            healthy: workloads.filter((status) => status.health === 'healthy').length,
            // Workloads with an Opfield health check: the Healthy card counts these; the rest only by number.
            checkedHealthy: checked.filter((status) => status.health === 'healthy').length,
            checked: checked.length,
            noHealthCheck: running.length - checked.length,
            stopped: workloads.filter((status) => status.health === 'stopped').length,
            cpuPercent: sum(workloads.map((status) => status.cpuPercent)),
            cpuHistory: sumSeries(envContainers.map((entry) => entry.cpu)),
            memoryBytes: sum(workloads.map((status) => status.memoryBytes)),
            memoryLimitBytes: sum(workloads.map((status) => status.memoryLimitBytes)),
            memoryHistory: sumSeries(envContainers.map((entry) => entry.memory)),
            // Increase of Docker restart counts since sampling began (null until the sampler has a reading);
            // restartsSince is when that began while the samples do not yet cover the range.
            restarts: sum(envContainers.map((entry) => entry.restarts)),
            restartsSince: restartsSince(
              envContainers.map((entry) => entry.restartsSince),
              range,
              now
            ),
            restartsHistory: sumSeries(
              envContainers.map((entry) => entry.restartsHistory),
              { carry: false }
            ),
            healthyHistory: averageSeries(
              envContainers.filter((entry) => entry.hasHealthCheck).map((entry) => entry.healthy)
            ),
            // Workloads that are not healthy; one stopped on request is not unhealthy.
            unhealthy: running.filter((status) => status.health !== 'healthy').map((status) => status.member.name),
          },
          databases: envDatabases.map(({ environmentId: _env, ...entry }) => entry),
          storage: envStorage.map(({ environmentId: _env, ...entry }) => entry),
          routes: {
            total: own.filter((status) => status.member.type === 'route').length,
            requestsPerSecond: sum(envRoutes.map((entry) => entry.requestsPerSecond)),
            requestsHistory: sumSeries(envRoutes.map((entry) => entry.requestsHistory)),
            errorsPerSecond: sum(envRoutes.map((entry) => entry.errorsPerSecond)),
            errorsHistory: sumSeries(envRoutes.map((entry) => entry.errorsHistory)),
            ...routeLatency(envRoutes),
            trafficBytesPerSecond: sum(envRoutes.map((entry) => entry.trafficBytesPerSecond)),
            trafficHistory: sumSeries(envRoutes.map((entry) => entry.trafficHistory)),
          },
          pages: envPages.map(({ environmentId: _env, ...entry }) => entry),
          nodeIds: [...new Set(own.flatMap((status) => status.member.nodeIds))],
        };
      });

    const value = { range, measuredAt: new Date(now).toISOString(), environments };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Per container and deployment: CPU, memory, restarts and health from its per-minute samples. */
  private async containerSeries(statuses: readonly MemberStatus[], range: OverviewRange, now: number) {
    const workloads = statuses.filter(
      (status) => status.member.type === 'container' || status.member.type === 'deployment'
    );
    if (workloads.length === 0) return [];
    const monitoring = container.isRegistered(NodeMonitoringService) ? container.resolve(NodeMonitoringService) : null;
    const cache = container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
    return Promise.all(
      workloads.map(async (status) => {
        const [samples, minuteHistory] = await Promise.all([
          readSamples<WorkloadSample>(cache, workloadSampleKey(status.member.type, status.member.id)),
          status.runtimeId && monitoring
            ? monitoring.getContainerStatsHourHistory(status.runtimeId, now).catch(() => [])
            : [],
        ]);
        const restarts = restartSeries(samples, range, now);
        return {
          environmentId: status.member.environmentId,
          hasHealthCheck: status.hasHealthCheck === true,
          restarts: restarts.total,
          restartsHistory: restarts.history,
          restartsSince: restarts.since,
          healthy: healthySeries(samples, range, now),
          cpu: bucketSeries(workloadUsagePoints(samples, minuteHistory, 'cpuPercent'), range, now),
          memory: bucketSeries(workloadUsagePoints(samples, minuteHistory, 'memoryBytes'), range, now),
        };
      })
    );
  }

  private async databaseSection(members: readonly AppMember[], range: OverviewRange, now: number) {
    const dbs = members.filter((member) => member.type === 'database');
    if (dbs.length === 0) return [];
    const rows = await this.db
      .select({
        id: databaseConnections.id,
        slug: databaseConnections.slug,
        name: databaseConnections.name,
        type: databaseConnections.type,
        manualSizeLimitMb: databaseConnections.manualSizeLimitMb,
      })
      .from(databaseConnections)
      .where(
        inArray(
          databaseConnections.id,
          dbs.map((member) => member.id)
        )
      );
    const [series, availability] = await Promise.all([
      overviewSamples(
        DatabaseMonitoringService,
        rows.map((row) => row.id),
        range
      ),
      availabilityOverviews(
        this.db,
        'database',
        rows.map((row) => row.id)
      ),
    ]);
    return dbs.flatMap((member) => {
      const row = rows.find((item) => item.id === member.id);
      if (!row) return [];
      return [
        {
          environmentId: member.environmentId,
          id: row.id,
          slug: row.slug,
          name: row.name,
          type: row.type,
          ...databaseCards(row, series.get(member.id) ?? [], range, now),
          // On several servers: the set's state and each member's role and health (degraded is not down).
          availability: availability.get(row.id) ?? null,
        },
      ];
    });
  }

  private async storageSection(members: readonly AppMember[], range: OverviewRange, now: number) {
    const storages = members.filter((member) => member.type === 'storage');
    if (storages.length === 0) return [];
    const rows = await this.db
      .select({
        id: objectStorageConnections.id,
        slug: objectStorageConnections.slug,
        name: objectStorageConnections.name,
      })
      .from(objectStorageConnections)
      .where(
        inArray(
          objectStorageConnections.id,
          storages.map((member) => member.id)
        )
      );
    const cache = container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
    const [series, availability, objectCounts] = await Promise.all([
      overviewSamples(
        ObjectStorageMonitoringService,
        rows.map((row) => row.id),
        range
      ),
      availabilityOverviews(
        this.db,
        'storage',
        rows.map((row) => row.id)
      ),
      Promise.all(
        rows.map(
          async (row) =>
            [row.id, await readSamples<ObjectCountSample>(cache, `${APP_STORAGE_OBJECTS_KEY_PREFIX}${row.id}`)] as const
        )
      ).then((entries) => new Map(entries)),
    ]);
    return storages.flatMap((member) => {
      const row = rows.find((item) => item.id === member.id);
      if (!row) return [];
      return [
        {
          environmentId: member.environmentId,
          id: row.id,
          slug: row.slug,
          name: row.name,
          ...storageCards(series.get(member.id) ?? [], objectCounts.get(member.id) ?? [], range, now),
          // On several servers: the set's state and each member's role and health (degraded is not down).
          availability: availability.get(row.id) ?? null,
        },
      ];
    });
  }

  private async routeSection(members: readonly AppMember[], range: OverviewRange, now: number) {
    const routes = members.filter((member) => member.type === 'route');
    if (routes.length === 0) return [];
    const cache = container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
    const probes = await this.db
      .select({
        id: proxyHosts.id,
        healthCheckEnabled: proxyHosts.healthCheckEnabled,
        healthHistory: proxyHosts.healthHistory,
      })
      .from(proxyHosts)
      .where(
        inArray(
          proxyHosts.id,
          routes.map((member) => member.id)
        )
      );
    return Promise.all(
      routes.map(async (member) => {
        const samples = await readSamples<RouteTrafficSample>(cache, routeTrafficKey(member.id));
        // Health-check probes: their response time is the latency while the route has no traffic.
        const probe = probes.find((row) => row.id === member.id);
        const start = now - RANGE_MS[range];
        const probePoints = (probe?.healthCheckEnabled ? (probe.healthHistory ?? []) : [])
          .map((entry) => ({ at: Date.parse(entry.ts), value: entry.responseMs ?? Number.NaN }))
          .filter((point) => Number.isFinite(point.value) && point.at >= start);
        return {
          environmentId: member.environmentId,
          ...routeTraffic(samples, range, now),
          probeLatencyMs: probePoints.at(-1)?.value ?? null,
          probeLatencyHistory: fillGaps(bucketSeries(probePoints, range, now)),
        };
      })
    );
  }

  /** Per Pages project: the deployment its routes serve and the requests of those routes. */
  private async pagesSection(members: readonly AppMember[], range: OverviewRange, now: number) {
    const projects = members.filter((member) => member.type === 'pages');
    if (projects.length === 0) return [];
    const ids = projects.map((member) => member.id);
    const cache = container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
    const [rows, targets] = await Promise.all([
      this.db
        .select({ id: pageProjects.id, slug: pageProjects.slug, name: pageProjects.name })
        .from(pageProjects)
        .where(inArray(pageProjects.id, ids)),
      this.db
        .select({
          projectId: pageRouteTargets.projectId,
          routeId: pageRouteTargets.proxyHostId,
          status: pageRouteTargets.status,
          deploymentId: pageRouteTargets.activeDeploymentId,
          createdAt: pageDeployments.createdAt,
          routeEnabled: proxyHosts.enabled,
        })
        .from(pageRouteTargets)
        .innerJoin(proxyHosts, eq(proxyHosts.id, pageRouteTargets.proxyHostId))
        .leftJoin(pageDeployments, eq(pageDeployments.id, pageRouteTargets.activeDeploymentId))
        .where(inArray(pageRouteTargets.projectId, ids))
        .orderBy(desc(pageDeployments.createdAt)),
    ]);
    const traffic = new Map(
      await Promise.all(
        targets.map(
          async (target) =>
            [
              target.routeId,
              routeTraffic(await readSamples<RouteTrafficSample>(cache, routeTrafficKey(target.routeId)), range, now),
            ] as const
        )
      )
    );
    return projects.flatMap((member) => {
      const row = rows.find((item) => item.id === member.id);
      if (!row) return [];
      // The deployment an enabled route serves (the newest when several do): what visitors get.
      const active = targets.find(
        (target) =>
          target.projectId === member.id && target.routeEnabled && target.status === 'ready' && target.deploymentId
      );
      const served = targets
        .filter((target) => target.projectId === member.id)
        .map((target) => traffic.get(target.routeId)!);
      const rates = served.map((entry) => entry.requestsPerSecond).filter((value): value is number => value !== null);
      return [
        {
          environmentId: member.environmentId,
          id: row.id,
          slug: row.slug,
          name: row.name,
          activeDeployment: active?.deploymentId ? { id: active.deploymentId, createdAt: active.createdAt } : null,
          /** Routes that serve the project (its requests are theirs). */
          routes: served.length,
          requestsPerSecond: rates.length ? rates.reduce((total, value) => total + value, 0) : null,
          requestsHistory: sumSeries(served.map((entry) => entry.requestsHistory)),
        },
      ];
    });
  }
}
