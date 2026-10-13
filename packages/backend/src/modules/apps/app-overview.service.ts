import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnections,
  objectStorageConnections,
  pageDeployments,
  pageProjects,
  pageTags,
  proxyHosts,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { NodeMonitoringService } from '@/modules/nodes/node-monitoring.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { CacheService } from '@/services/cache.service.js';
import { availabilityOverviews } from './app-availability-overview.js';
import { type AppHealthService, combineHealth, type MemberStatus } from './app-health.service.js';
import type { AppMember, AppMembersReader } from './app-members.service.js';
import {
  APP_STORAGE_OBJECTS_KEY_PREFIX,
  type ObjectCountSample,
  readSamples,
  type WorkloadSample,
  workloadSampleKey,
} from './app-workload-sampler.js';
import type { AppsService } from './apps.service.js';

const logger = createChildLogger('AppOverview');

export type OverviewRange = '1h' | '24h';
const RANGE_MS: Record<OverviewRange, number> = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };
/** Points per series. */
export const OVERVIEW_POINTS = 24;
const CACHE_TTL_MS = 15_000;
const DISK_ALERT_PERCENT = 85;
const ERROR_ALERT_PERCENT = 2;

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
 * (the sampler keeps one hour); null once the range is covered or nothing is known.
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
  // Samples are a minute apart and kept for one hour: the first one within a bucket of the range start covers it.
  const covered = earliest <= now - span + span / OVERVIEW_POINTS;
  return covered ? null : new Date(earliest).toISOString();
}

/** Healthy share (percent) of one workload per bucket from its per-minute samples. */
export function healthySeries(
  samples: readonly WorkloadSample[],
  range: OverviewRange,
  now = Date.now()
): Array<number | null> {
  return bucketSeries(
    samples.map((sample) => ({ at: sample.at, value: sample.healthy ? 100 : 0 })),
    range,
    now
  );
}

const THROUGHPUT_METRICS = [
  ['transaction_rate', 'tx'],
  ['instantaneous_ops_per_sec', 'ops'],
  ['query_rate', 'q'],
] as const;

/** A database's throughput: the first of transactions, operations or queries per second its engine reports. */
export function throughputOf(
  latest: Record<string, unknown>,
  points: (metric: string) => Array<number | null>
): {
  transactionsPerSecond: number | null;
  transactionsHistory: Array<number | null>;
  throughputUnit: 'tx' | 'ops' | 'q';
} {
  for (const [metric, unit] of THROUGHPUT_METRICS) {
    const value = num(latest[metric]);
    const history = points(metric);
    if (value !== null || history.some((point) => point !== null)) {
      return { transactionsPerSecond: value, transactionsHistory: history, throughputUnit: unit };
    }
  }
  return { transactionsPerSecond: null, transactionsHistory: [], throughputUnit: 'tx' };
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

function familyOf(member: AppMember): string {
  switch (member.type) {
    case 'container':
    case 'deployment':
      return 'containers';
    case 'compose':
      return 'compose';
    case 'database':
      return 'databases';
    case 'storage':
      return 'storage';
    case 'route':
      return 'routes';
    case 'pages':
      return 'pages';
  }
}

/** Alert tones, the same words the console's Notice uses. */
export const APP_OVERVIEW_ALERT_TONES = ['destructive', 'warning'] as const;
export type AppOverviewAlertTone = (typeof APP_OVERVIEW_ALERT_TONES)[number];
export type AppOverviewAlert = {
  tone: AppOverviewAlertTone;
  title: string;
  detail: string;
  href?: string;
  actionLabel?: string;
};

/**
 * Alerts of one environment: a destructive alert per failing member, a warning per database or storage whose disk
 * is at least DISK_ALERT_PERCENT full, and a warning when at least ERROR_ALERT_PERCENT of route requests fail.
 */
export function environmentAlerts(input: {
  envName: string;
  failing: ReadonlyArray<{ name: string; family: string }>;
  disks: ReadonlyArray<{ name: string; diskPercent: number | null }>;
  routeRps: number | null;
  routeErrors: number | null;
}): AppOverviewAlert[] {
  const alerts: AppOverviewAlert[] = [];
  for (const member of input.failing) {
    alerts.push({
      tone: 'destructive',
      title: `${member.name} is failing`,
      detail: `${member.family} member of ${input.envName}`,
    });
  }
  for (const entry of input.disks) {
    if (entry.diskPercent !== null && entry.diskPercent >= DISK_ALERT_PERCENT) {
      alerts.push({
        tone: 'warning',
        title: `${entry.name} disk is ${Math.round(entry.diskPercent)}% full`,
        detail: 'Free space or grow the volume',
      });
    }
  }
  const { routeRps, routeErrors } = input;
  if (routeRps && routeErrors !== null && (routeErrors / routeRps) * 100 >= ERROR_ALERT_PERCENT) {
    alerts.push({
      tone: 'warning',
      title: `${Math.round((routeErrors / routeRps) * 1000) / 10}% of requests fail with 5xx`,
      detail: `Routes of ${input.envName}`,
    });
  }
  return alerts;
}

/**
 * Monitoring overview of an app: per visible environment, the health of its members, issues and alerts, and
 * 24-point series for containers, databases, storage, routes and Pages, read once per source per request and cached
 * for 15 s per app, range and caller scopes. Only members the caller may view appear. Unknown values are null and
 * unknown series empty.
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
    const statuses = await this.health.memberStatuses(visible);
    const [containerSeries, databases, storages, routes, pages] = await Promise.all([
      this.containerSeries(statuses, range),
      this.databaseSection(visible, range),
      this.storageSection(visible, range),
      this.routeSection(visible, range),
      this.pagesSection(visible),
    ]);

    const environments = envs
      .filter((env) => envIds.includes(env.id))
      .map((env) => {
        const own = statuses.filter((status) => status.member.environmentId === env.id);
        const counted = own.filter((status) => status.health !== 'none');
        const issues = new Map<string, { family: string; state: string; count: number }>();
        for (const status of counted) {
          if (status.health === 'healthy') continue;
          const family = familyOf(status.member);
          const issueKey = `${family}:${status.health}`;
          const entry = issues.get(issueKey) ?? { family, state: status.health, count: 0 };
          entry.count += 1;
          issues.set(issueKey, entry);
        }
        const workloads = own.filter(
          (status) => status.member.type === 'container' || status.member.type === 'deployment'
        );
        const checked = workloads.filter((status) => status.hasHealthCheck === true);
        const sum = (values: Array<number | null>) => {
          const present = values.filter((value): value is number => value !== null);
          return present.length ? Math.round(present.reduce((total, value) => total + value, 0) * 10) / 10 : null;
        };
        const envContainers = containerSeries.filter((entry) => entry.environmentId === env.id);
        const envDatabases = databases.filter((entry) => entry.environmentId === env.id);
        const envStorage = storages.filter((entry) => entry.environmentId === env.id);
        const envRoutes = routes.filter((entry) => entry.environmentId === env.id);
        const envPages = pages.filter((entry) => entry.environmentId === env.id);
        const routeRps = sum(envRoutes.map((entry) => entry.requestsPerSecond));
        const routeErrors = sum(envRoutes.map((entry) => entry.errorsPerSecond));
        const alerts = environmentAlerts({
          envName: env.name,
          failing: counted
            .filter((item) => item.health === 'failing')
            .map((item) => ({ name: item.member.name, family: familyOf(item.member) })),
          disks: [...envDatabases, ...envStorage],
          routeRps,
          routeErrors,
        });
        return {
          environmentId: env.id,
          health: combineHealth(counted.map((status) => status.health)),
          members: own.length,
          issues: [...issues.values()],
          alerts,
          containers: {
            total: workloads.length,
            healthy: workloads.filter((status) => status.health === 'healthy').length,
            // Workloads with an Opfield health check: the Healthy card counts these; the rest only by number.
            checkedHealthy: checked.filter((status) => status.health === 'healthy').length,
            noHealthCheck: workloads.length - checked.length,
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
              range
            ),
            restartsHistory: sumSeries(
              envContainers.map((entry) => entry.restartsHistory),
              { carry: false }
            ),
            healthyHistory: averageSeries(
              envContainers.filter((entry) => entry.hasHealthCheck).map((entry) => entry.healthy)
            ),
            unhealthy: workloads.filter((status) => status.health !== 'healthy').map((status) => status.member.name),
          },
          databases: envDatabases.map(({ environmentId: _env, ...entry }) => entry),
          storage: envStorage.map(({ environmentId: _env, ...entry }) => entry),
          routes: {
            total: own.filter((status) => status.member.type === 'route').length,
            requestsPerSecond: routeRps,
            requestsHistory: sumSeries(envRoutes.map((entry) => entry.requestsHistory)),
            errorsPerSecond: routeErrors,
            errorsHistory: sumSeries(envRoutes.map((entry) => entry.errorsHistory)),
            ...routeLatency(envRoutes),
            trafficBytesPerSecond: sum(envRoutes.map((entry) => entry.trafficBytesPerSecond)),
            trafficHistory: sumSeries(envRoutes.map((entry) => entry.trafficHistory)),
          },
          pages: envPages.map(({ environmentId: _env, ...entry }) => entry),
          nodeIds: [...new Set(own.flatMap((status) => status.member.nodeIds))],
        };
      });

    const value = { range, measuredAt: new Date().toISOString(), environments };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** CPU and memory series of each container and active deployment slot, from the stats the nodes report. */
  private async containerSeries(statuses: readonly MemberStatus[], range: OverviewRange) {
    const workloads = statuses.filter(
      (status) => status.member.type === 'container' || status.member.type === 'deployment'
    );
    if (workloads.length === 0) return [];
    const snapshots = container.isRegistered(DockerSnapshotService) ? container.resolve(DockerSnapshotService) : null;
    const monitoring = container.isRegistered(NodeMonitoringService) ? container.resolve(NodeMonitoringService) : null;
    const cache = container.isRegistered(CacheService) ? container.resolve(CacheService) : null;
    const idsByNode = new Map<string, Map<string, string>>();
    for (const nodeId of new Set(workloads.map((status) => status.member.nodeId!))) {
      if (!snapshots) break;
      const list = await snapshots.getList<Array<Record<string, any>>>(nodeId, 'containers').catch(() => null);
      const byName = new Map<string, string>();
      for (const item of Array.isArray(list?.data) ? list.data : []) {
        const name = String(item.name ?? item.Name ?? '').replace(/^\/+/, '');
        const id = String(item.id ?? item.Id ?? '');
        if (name && id) byName.set(name, id);
      }
      idsByNode.set(nodeId, byName);
    }
    return Promise.all(
      workloads.map(async (status) => {
        const runtimeId = status.runtimeName
          ? idsByNode.get(status.member.nodeId!)?.get(status.runtimeName)
          : undefined;
        const [history, samples] = await Promise.all([
          runtimeId && monitoring ? monitoring.getContainerStatsHourHistory(runtimeId).catch(() => []) : [],
          readSamples<WorkloadSample>(cache, workloadSampleKey(status.member.type, status.member.id)),
        ]);
        const at = (entry: Record<string, unknown>) => num(entry.timestamp) ?? 0;
        const restarts = restartSeries(samples, range);
        return {
          environmentId: status.member.environmentId,
          hasHealthCheck: status.hasHealthCheck === true,
          restarts: restarts.total,
          restartsHistory: restarts.history,
          restartsSince: restarts.since,
          healthy: healthySeries(samples, range),
          cpu: bucketSeries(
            history.map((entry) => ({
              at: at(entry),
              value: num(entry.cpuPercent ?? entry.cpu_percent) ?? Number.NaN,
            })),
            range
          ),
          memory: bucketSeries(
            history.map((entry) => ({
              at: at(entry),
              value: num(entry.memoryUsageBytes ?? entry.memory_usage_bytes) ?? Number.NaN,
            })),
            range
          ),
        };
      })
    );
  }

  private async databaseSection(members: readonly AppMember[], range: OverviewRange) {
    const dbs = members.filter((member) => member.type === 'database');
    if (dbs.length === 0) return [];
    const rows = await this.db
      .select({
        id: databaseConnections.id,
        slug: databaseConnections.slug,
        name: databaseConnections.name,
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
      this.seriesFrom(
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
      const samples = series.get(member.id) ?? [];
      const latest = samples.at(-1)?.metrics ?? {};
      const size = num(latest.database_size_bytes);
      const limit = row.manualSizeLimitMb ? row.manualSizeLimitMb * 1024 * 1024 : null;
      const points = (metric: string) =>
        fillGaps(
          bucketSeries(
            samples.map((sample) => ({
              at: Date.parse(sample.timestamp),
              value: num(sample.metrics[metric]) ?? Number.NaN,
            })),
            range
          )
        );
      return [
        {
          environmentId: member.environmentId,
          id: row.id,
          slug: row.slug,
          name: row.name,
          diskBytes: size,
          diskPercent: size !== null && limit ? Math.round((size / limit) * 1000) / 10 : null,
          diskHistory: points('database_size_bytes'),
          connections: num(latest.total_connections),
          maxConnections: num(latest.max_connections),
          connectionsHistory: points('total_connections'),
          // Throughput: transactions (PostgreSQL), operations (key-value) or queries (ClickHouse) per second.
          ...throughputOf(latest, points),
          cacheHitPercent: num(latest.cache_hit_ratio),
          cacheHitHistory: points('cache_hit_ratio'),
          cpuPercent: num(latest.managed_cpu_percent),
          cpuHistory: points('managed_cpu_percent'),
          // On several servers: the set's state and each member's role and health (degraded is not down).
          availability: availability.get(row.id) ?? null,
        },
      ];
    });
  }

  private async storageSection(members: readonly AppMember[], range: OverviewRange) {
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
      this.seriesFrom(
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
      const samples = series.get(member.id) ?? [];
      const latest = samples.at(-1)?.metrics ?? {};
      const used = num(latest.disk_used_bytes);
      const total = num(latest.disk_total_bytes);
      const points = (metric: string) =>
        fillGaps(
          bucketSeries(
            samples.map((sample) => ({
              at: Date.parse(sample.timestamp),
              value: num(sample.metrics[metric]) ?? Number.NaN,
            })),
            range
          )
        );
      // Network counters are cumulative: rates come from consecutive samples.
      const rate = (metric: string) => {
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
      // The engine reports no object count (SeaweedFS has none per S3 user): the sampler lists the buckets.
      const counted = objectCounts.get(member.id) ?? [];
      const objectsHistory = points('object_count').some((value) => value !== null)
        ? points('object_count')
        : fillGaps(
            bucketSeries(
              counted.map((sample) => ({ at: sample.at, value: sample.count })),
              range
            )
          );
      const rx = rate('network_rx_bytes');
      const tx = rate('network_tx_bytes');
      return [
        {
          environmentId: member.environmentId,
          id: row.id,
          slug: row.slug,
          name: row.name,
          diskBytes: used,
          diskPercent: used !== null && total ? Math.round((used / total) * 1000) / 10 : null,
          diskHistory: points('disk_used_bytes'),
          objects: num(latest.object_count) ?? counted.at(-1)?.count ?? null,
          objectsHistory,
          buckets: num(latest.bucket_count),
          rxBytesPerSecond: rx.at(-1)?.value ?? null,
          rxHistory: fillGaps(bucketSeries(rx, range)),
          txBytesPerSecond: tx.at(-1)?.value ?? null,
          txHistory: fillGaps(bucketSeries(tx, range)),
          // On several servers: the set's state and each member's role and health (degraded is not down).
          availability: availability.get(row.id) ?? null,
        },
      ];
    });
  }

  private async routeSection(members: readonly AppMember[], range: OverviewRange) {
    const routes = members.filter((member) => member.type === 'route');
    const proxy = container.isRegistered(ProxyService) ? container.resolve(ProxyService) : null;
    if (routes.length === 0) return [];
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
        const history = proxy ? await proxy.cachedTrafficHistory(member.id).catch(() => []) : [];
        // Health-check probes: their response time is the latency while the route has no traffic.
        const probe = probes.find((row) => row.id === member.id);
        const start = Date.now() - RANGE_MS[range];
        const probePoints = (probe?.healthCheckEnabled ? (probe.healthHistory ?? []) : [])
          .map((entry) => ({ at: Date.parse(entry.ts), value: entry.responseMs ?? Number.NaN }))
          .filter((point) => Number.isFinite(point.value) && point.at >= start);
        const latest = history.at(-1)?.traffic;
        const errorShare = (traffic: { statusCodes: { s5xx: number }; totalRequests: number }) =>
          traffic.totalRequests > 0 ? traffic.statusCodes.s5xx / traffic.totalRequests : 0;
        const series = (pick: (traffic: NonNullable<typeof latest>) => number) =>
          fillGaps(
            bucketSeries(
              history.map((entry) => ({ at: Date.parse(entry.timestamp), value: pick(entry.traffic) })),
              range
            )
          );
        return {
          environmentId: member.environmentId,
          requestsPerSecond: latest ? latest.requestsPerSecond : null,
          requestsHistory: series((traffic) => traffic.requestsPerSecond),
          errorsPerSecond: latest ? latest.requestsPerSecond * errorShare(latest) : null,
          errorsHistory: series((traffic) => traffic.requestsPerSecond * errorShare(traffic)),
          latencyMs: latest ? latest.p95ResponseTime || latest.avgResponseTime || null : null,
          // No requests in a sample means no latency, not 0 ms.
          latencyHistory: series((traffic) => traffic.p95ResponseTime || traffic.avgResponseTime || Number.NaN),
          probeLatencyMs: probePoints.at(-1)?.value ?? null,
          probeLatencyHistory: fillGaps(bucketSeries(probePoints, range)),
          trafficBytesPerSecond: latest ? latest.bytesPerSecond : null,
          trafficHistory: series((traffic) => traffic.bytesPerSecond),
        };
      })
    );
  }

  private async pagesSection(members: readonly AppMember[]) {
    const projects = members.filter((member) => member.type === 'pages');
    if (projects.length === 0) return [];
    const ids = projects.map((member) => member.id);
    const [rows, tags] = await Promise.all([
      this.db
        .select({ id: pageProjects.id, slug: pageProjects.slug, name: pageProjects.name })
        .from(pageProjects)
        .where(inArray(pageProjects.id, ids)),
      this.db
        .select({
          projectId: pageTags.projectId,
          deploymentId: pageTags.deploymentId,
          createdAt: pageDeployments.createdAt,
        })
        .from(pageTags)
        .innerJoin(pageDeployments, eq(pageDeployments.id, pageTags.deploymentId))
        .where(and(inArray(pageTags.projectId, ids), eq(pageTags.name, 'latest')))
        .orderBy(desc(pageDeployments.createdAt)),
    ]);
    return projects.flatMap((member) => {
      const row = rows.find((item) => item.id === member.id);
      if (!row) return [];
      const tag = tags.find((item) => item.projectId === member.id);
      return [
        {
          environmentId: member.environmentId,
          id: row.id,
          slug: row.slug,
          name: row.name,
          activeDeployment: tag?.deploymentId ? { id: tag.deploymentId, createdAt: tag.createdAt } : null,
          requestsPerSecond: null as number | null,
          requestsHistory: [] as Array<number | null>,
        },
      ];
    });
  }

  /**
   * Samples per resource over the range: the core's overview series when it provides them, else the short live
   * history the monitoring service keeps, else nothing (no commercial core, or monitoring off).
   */
  private async seriesFrom(
    service: typeof DatabaseMonitoringService | typeof ObjectStorageMonitoringService,
    ids: readonly string[],
    range: OverviewRange
  ): Promise<Map<string, Array<{ timestamp: string; metrics: Record<string, number | null> }>>> {
    const result = new Map<string, Array<{ timestamp: string; metrics: Record<string, number | null> }>>();
    const token = service as unknown as typeof DatabaseMonitoringService;
    if (ids.length === 0 || !container.isRegistered(token)) return result;
    const monitoring = container.resolve(token) as unknown as {
      getOverviewSeries(ids: readonly string[], range: OverviewRange): Promise<Record<string, any[]>>;
      getHistory(id: string): Promise<any[]>;
    };
    try {
      const series = await monitoring.getOverviewSeries(ids, range);
      for (const id of ids) result.set(id, Array.isArray(series?.[id]) ? series[id] : []);
      return result;
    } catch (error) {
      logger.debug('Overview series unavailable; using the live history', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const id of ids) {
      result.set(id, await monitoring.getHistory(id).catch(() => []));
    }
    return result;
  }
}
