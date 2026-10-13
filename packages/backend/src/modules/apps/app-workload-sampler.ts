import { inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { appEnvironments, pageRouteTargets, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveIngressNodesForMany } from '@/modules/ingress-groups/ingress-nodes.js';
import { NodeMonitoringService } from '@/modules/nodes/node-monitoring.service.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { AppHealthService, MemberHealth, MemberStatus } from './app-health.service.js';
import type { AppMember, AppMembersReader } from './app-members.service.js';

const logger = createChildLogger('AppWorkloadSampler');

export const APP_WORKLOAD_SAMPLES_KEY_PREFIX = 'app-workload-samples:v1:';
export const APP_STORAGE_OBJECTS_KEY_PREFIX = 'app-storage-objects:v1:';
export const APP_ROUTE_TRAFFIC_KEY_PREFIX = 'app-route-traffic:v1:';
const SAMPLE_INTERVAL_MS = 60_000;
/** A day of per-minute samples (the overview's 24-hour range), plus a margin. */
const SAMPLES_MAX = 24 * 60 + 10;
const SAMPLES_TTL_SECONDS = 25 * 60 * 60;
/** Object counts are listed every OBJECT_COUNT_EVERY samples (S3 listing is not free). */
const OBJECT_COUNT_EVERY = 5;
const OBJECT_COUNT_MAX_PAGES = 100;
const INSPECT_TIMEOUT_MS = 5_000;
/** Access-log lines a traffic sample reads per route and node; beyond them the daemon estimates the rate. */
const TRAFFIC_TAIL_LINES = 2_000;
const TRAFFIC_WINDOW_SECONDS = SAMPLE_INTERVAL_MS / 1000;
const TRAFFIC_CONCURRENCY = 4;
const LOCK_KEY = 'app-workload-sampler:lock';

/**
 * One minute's reading of an app workload, keyed by the member (container or deployment), so it outlives a recreate
 * of its container: its state, Docker restart count, CPU and memory. Samples written before 2.12.2 carry only
 * `healthy`, `restartCount` and `runtime`.
 */
export interface WorkloadSample {
  at: number;
  healthy: boolean;
  /** healthy, degraded, failing, or stopped on request. */
  state?: MemberHealth;
  restartCount: number | null;
  /** Runtime container name: a new runtime (a recreate, a deployment slot switch) restarts its count. */
  runtime: string | null;
  /** CPU percent and memory of the minute (the node's per-minute mean), null when the node reported none. */
  cpuPercent?: number | null;
  memoryBytes?: number | null;
  memoryLimitBytes?: number | null;
}

export interface ObjectCountSample {
  at: number;
  count: number;
}

/** One minute of a route's requests from its access logs, summed over its ingress nodes. */
export interface RouteTrafficSample {
  at: number;
  requests: number;
  /** Responses with status 5xx. */
  errors: number;
  bytes: number;
  /** Seconds the counts cover (the sample window, shorter when the log tail ran out). */
  seconds: number;
  /** p95 upstream response time in milliseconds, null without requests. */
  p95Ms: number | null;
}

export function workloadSampleKey(type: string, id: string): string {
  return `${APP_WORKLOAD_SAMPLES_KEY_PREFIX}${type}:${id}`;
}

export function routeTrafficKey(routeId: string): string {
  return `${APP_ROUTE_TRAFFIC_KEY_PREFIX}${routeId}`;
}

/** Docker RestartCount from a container inspect result (the daemon's JSON detail), or null. */
export function restartCountOf(detail: unknown): number | null {
  let parsed: unknown = detail;
  if (typeof detail === 'string') {
    try {
      parsed = JSON.parse(detail);
    } catch {
      return null;
    }
  }
  const count = (parsed as { RestartCount?: unknown } | null)?.RestartCount;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * CPU and memory of a workload for the minute that just ended: the node's per-minute mean of its current container
 * (the health reports every ~10 s), else the latest reading.
 */
export function minuteUsage(
  status: Pick<MemberStatus, 'cpuPercent' | 'memoryBytes' | 'memoryLimitBytes'>,
  minutePoints: ReadonlyArray<Record<string, unknown>>,
  now: number
): { cpuPercent: number | null; memoryBytes: number | null; memoryLimitBytes: number | null } {
  const lastMinute = Math.floor(now / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS - SAMPLE_INTERVAL_MS;
  const point = minutePoints.find((entry) => finite(entry.timestamp) === lastMinute);
  return {
    cpuPercent: finite(point?.cpuPercent) ?? status.cpuPercent,
    memoryBytes: finite(point?.memoryUsageBytes) ?? status.memoryBytes,
    memoryLimitBytes: finite(point?.memoryLimitBytes) ?? status.memoryLimitBytes,
  };
}

/** Traffic stats of one route from its nodes' replies (the daemon's JSON), summed; null when no node answered. */
export function mergeTrafficReplies(details: ReadonlyArray<string | null | undefined>, routeId: string, at: number) {
  let sample: RouteTrafficSample | null = null;
  for (const detail of details) {
    if (!detail) continue;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(detail);
    } catch {
      continue;
    }
    if (parsed.hostId !== routeId) continue;
    const requests = finite(parsed.totalRequests) ?? 0;
    const p95 = finite(parsed.p95ResponseTime);
    sample ??= { at, requests: 0, errors: 0, bytes: 0, seconds: TRAFFIC_WINDOW_SECONDS, p95Ms: null };
    sample.requests += requests;
    sample.errors += finite(parsed.statusCodes?.s5xx) ?? 0;
    sample.bytes += finite(parsed.totalBytes) ?? 0;
    // A truncated tail covers less than the window: the counts are of that shorter time.
    sample.seconds = Math.min(sample.seconds, finite(parsed.windowSeconds) || TRAFFIC_WINDOW_SECONDS);
    // 0 is "no upstream time in the log" (a log format without $upstream_response_time), not an instant answer.
    if (requests > 0 && p95 !== null && p95 > 0) {
      sample.p95Ms = Math.max(sample.p95Ms ?? 0, Math.round(p95 * 1000 * 10) / 10);
    }
  }
  return sample;
}

/**
 * Once a minute, records in Redis for a day, keyed by the app member so a recreate keeps the history: per app
 * workload (container or deployment) its state, Docker restart count, CPU and memory; per route of an app (and per
 * route serving an app's Pages project) the minute's requests, 5xx, bytes and p95 latency from the access logs of its
 * ingress nodes; every few minutes the object count of app storage. The overview's charts read these. One backend
 * samples at a time (a short Redis lock).
 */
export class AppWorkloadSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticks = 0;

  constructor(
    private readonly db: DrizzleClient,
    private readonly members: AppMembersReader,
    private readonly health: AppHealthService,
    private readonly cache: CacheService,
    private readonly dispatch: Pick<NodeDispatchService, 'sendDockerContainerCommand' | 'requestTrafficStats'>
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const locked = await this.cache
        .getClient()
        .set(LOCK_KEY, '1', 'PX', SAMPLE_INTERVAL_MS - 5_000, 'NX')
        .catch(() => 'OK');
      if (locked !== 'OK') return;
      this.ticks += 1;
      await this.sampleOnce(Date.now(), this.ticks % OBJECT_COUNT_EVERY === 1);
    } catch (error) {
      logger.debug('App workload sampling failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }

  async sampleOnce(now = Date.now(), countObjects = true): Promise<void> {
    const envs = await this.db.select({ id: appEnvironments.id }).from(appEnvironments);
    const members = await this.members.listMembers(envs.map((env) => env.id));
    await Promise.all([
      this.sampleWorkloads(members, now),
      this.sampleRoutes(members, now).catch((error) =>
        logger.debug('App route traffic sampling failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      ),
    ]);
    if (!countObjects) return;
    const storages = members.filter((member) => member.type === 'storage');
    if (storages.length === 0 || !container.isRegistered(ObjectStorageService)) return;
    const service = container.resolve(ObjectStorageService);
    for (const storage of storages) {
      const count = await countStorageObjects(service, storage.id).catch(() => null);
      if (count !== null) await this.push(`${APP_STORAGE_OBJECTS_KEY_PREFIX}${storage.id}`, { at: now, count });
    }
  }

  private async sampleWorkloads(members: readonly AppMember[], now: number): Promise<void> {
    const workloads = members.filter((member) => member.type === 'container' || member.type === 'deployment');
    if (workloads.length === 0) return;
    const monitoring = container.isRegistered(NodeMonitoringService) ? container.resolve(NodeMonitoringService) : null;
    const statuses = await this.health.memberStatuses(workloads);
    await Promise.all(
      statuses.map(async (status) => {
        const runtime = status.runtimeName ?? null;
        const [restartCount, minutePoints] = await Promise.all([
          runtime && status.member.nodeId
            ? this.dispatch
                .sendDockerContainerCommand(
                  status.member.nodeId,
                  'inspect',
                  { containerId: runtime },
                  INSPECT_TIMEOUT_MS
                )
                .then((result) => (result?.success ? restartCountOf(result.detail) : null))
                .catch(() => null)
            : null,
          status.runtimeId && monitoring
            ? monitoring.getContainerStatsHourHistory(status.runtimeId, now).catch(() => [])
            : [],
        ]);
        const sample: WorkloadSample = {
          at: now,
          healthy: status.health === 'healthy',
          state: status.health,
          restartCount,
          runtime,
          ...minuteUsage(status, minutePoints, now),
        };
        await this.push(workloadSampleKey(status.member.type, status.member.id), sample);
      })
    );
  }

  /** Routes of apps and the routes that serve an app's Pages projects, each sampled once. */
  private async sampleRoutes(members: readonly AppMember[], now: number): Promise<void> {
    const routeIds = new Set(members.filter((member) => member.type === 'route').map((member) => member.id));
    const pageIds = members.filter((member) => member.type === 'pages').map((member) => member.id);
    if (pageIds.length > 0) {
      const targets = await this.db
        .select({ routeId: pageRouteTargets.proxyHostId })
        .from(pageRouteTargets)
        .where(inArray(pageRouteTargets.projectId, pageIds));
      for (const target of targets) routeIds.add(target.routeId);
    }
    if (routeIds.size === 0) return;
    const hosts = await this.db
      .select({ id: proxyHosts.id, nodeId: proxyHosts.nodeId, ingressGroupId: proxyHosts.ingressGroupId })
      .from(proxyHosts)
      .where(inArray(proxyHosts.id, [...routeIds]));
    const nodesOf = await resolveIngressNodesForMany(this.db, hosts);
    const queue = [...hosts];
    const worker = async () => {
      for (let host = queue.shift(); host; host = queue.shift()) {
        const replies = await Promise.all(
          (nodesOf.get(host) ?? []).map((nodeId) =>
            this.dispatch
              .requestTrafficStats(nodeId, TRAFFIC_TAIL_LINES, {
                hostId: host!.id,
                windowSeconds: TRAFFIC_WINDOW_SECONDS,
              })
              .then((result) => (result?.success ? result.detail : null))
              .catch(() => null)
          )
        );
        const sample = mergeTrafficReplies(replies, host.id, now);
        if (sample) await this.push(routeTrafficKey(host.id), sample);
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRAFFIC_CONCURRENCY, queue.length) }, worker));
  }

  private async push(key: string, sample: WorkloadSample | ObjectCountSample | RouteTrafficSample): Promise<void> {
    await this.cache
      .getClient()
      .multi()
      .rpush(key, JSON.stringify(sample))
      .ltrim(key, -SAMPLES_MAX, -1)
      .expire(key, SAMPLES_TTL_SECONDS)
      .exec()
      .catch(() => undefined);
  }
}

/** Objects in every bucket of a storage connection, listed flat; null when a bucket is larger than the page budget. */
async function countStorageObjects(
  service: Pick<ObjectStorageService, 'listBuckets' | 'listObjects'>,
  storageId: string
): Promise<number | null> {
  const buckets = await service.listBuckets(storageId);
  let total = 0;
  let pages = 0;
  for (const bucket of buckets) {
    let token: string | undefined;
    do {
      if (pages >= OBJECT_COUNT_MAX_PAGES) return null;
      const listing = await service.listObjects(storageId, {
        bucket: bucket.name,
        continuationToken: token,
        maxKeys: 1000,
      });
      pages += 1;
      total += listing.objects.length;
      token = listing.isTruncated && listing.nextContinuationToken ? listing.nextContinuationToken : undefined;
    } while (token);
  }
  return total;
}

/** Samples of a Redis list written by the sampler, oldest first; `last` keeps only that many of the newest. */
export async function readSamples<T>(cache: CacheService | null, key: string, last?: number): Promise<T[]> {
  if (!cache) return [];
  try {
    const raw = await cache.getClient().lrange(key, last ? -last : 0, -1);
    return raw.flatMap((value) => {
      try {
        return [JSON.parse(value) as T];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
