import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { appEnvironments } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { AppHealthService } from './app-health.service.js';
import type { AppMembersReader } from './app-members.service.js';

const logger = createChildLogger('AppWorkloadSampler');

export const APP_WORKLOAD_SAMPLES_KEY_PREFIX = 'app-workload-samples:v1:';
export const APP_STORAGE_OBJECTS_KEY_PREFIX = 'app-storage-objects:v1:';
const SAMPLE_INTERVAL_MS = 60_000;
/** One hour of per-minute samples. */
const SAMPLES_MAX = 60;
const SAMPLES_TTL_SECONDS = 3_700;
/** Object counts are listed every OBJECT_COUNT_EVERY samples (S3 listing is not free). */
const OBJECT_COUNT_EVERY = 5;
const OBJECT_COUNT_MAX_PAGES = 100;
const INSPECT_TIMEOUT_MS = 5_000;
const LOCK_KEY = 'app-workload-sampler:lock';

/** One minute's reading of an app workload: its health and its Docker restart count (null when unknown). */
export interface WorkloadSample {
  at: number;
  healthy: boolean;
  restartCount: number | null;
  /** Runtime container name: a new runtime (a recreate, a deployment slot switch) restarts its count. */
  runtime: string | null;
}

export interface ObjectCountSample {
  at: number;
  count: number;
}

export function workloadSampleKey(type: string, id: string): string {
  return `${APP_WORKLOAD_SAMPLES_KEY_PREFIX}${type}:${id}`;
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

/**
 * Once a minute, records per app workload (container or deployment) its health and Docker restart count, and every
 * few minutes the object count of app storage, in Redis for one hour, for the app overview's Restarts, Healthy and
 * Objects cards. One backend samples at a time (a short Redis lock).
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
    private readonly dispatch: Pick<NodeDispatchService, 'sendDockerContainerCommand'>
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
    const workloads = members.filter((member) => member.type === 'container' || member.type === 'deployment');
    if (workloads.length > 0) {
      const statuses = await this.health.memberStatuses(workloads);
      await Promise.all(
        statuses.map(async (status) => {
          const runtime = status.runtimeName ?? null;
          let restartCount: number | null = null;
          if (runtime && status.member.nodeId) {
            const result = await this.dispatch
              .sendDockerContainerCommand(status.member.nodeId, 'inspect', { containerId: runtime }, INSPECT_TIMEOUT_MS)
              .catch(() => null);
            if (result?.success) restartCount = restartCountOf(result.detail);
          }
          const sample: WorkloadSample = { at: now, healthy: status.health === 'healthy', restartCount, runtime };
          await this.push(workloadSampleKey(status.member.type, status.member.id), sample);
        })
      );
    }
    if (!countObjects) return;
    const storages = members.filter((member) => member.type === 'storage');
    if (storages.length === 0 || !container.isRegistered(ObjectStorageService)) return;
    const service = container.resolve(ObjectStorageService);
    for (const storage of storages) {
      const count = await countStorageObjects(service, storage.id).catch(() => null);
      if (count !== null) await this.push(`${APP_STORAGE_OBJECTS_KEY_PREFIX}${storage.id}`, { at: now, count });
    }
  }

  private async push(key: string, sample: WorkloadSample | ObjectCountSample): Promise<void> {
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

/** Samples of a Redis list written by the sampler, oldest first. */
export async function readSamples<T>(cache: CacheService | null, key: string): Promise<T[]> {
  if (!cache) return [];
  try {
    const raw = await cache.getClient().lrange(key, 0, -1);
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
