import { randomUUID } from 'node:crypto';
import type { CacheService } from '@/services/cache.service.js';

export type ResourceSnapshotAvailability = 'available' | 'unavailable' | 'unknown';
export type ResourceSnapshotRefreshStatus = 'never' | 'refreshing' | 'success' | 'error';

/**
 * A sanitized, last-known-good projection of a resource or a resource list.
 * Redis is an acceleration layer: callers must never treat this as the
 * authoritative source for mutations.
 */
export interface ResourceSnapshotEnvelope<T> {
  data: T;
  revision: number;
  observedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  refreshStatus: ResourceSnapshotRefreshStatus;
  availability: ResourceSnapshotAvailability;
}

export interface ResourceSnapshotReplaceOptions {
  availability?: ResourceSnapshotAvailability;
  lease?: ResourceSnapshotLease | null;
}

export interface ResourceSnapshotLease {
  kind: string;
  id: string;
  token: string;
}

export const RESOURCE_SNAPSHOT_PREFIX = 'opfield:read-model:v1';
const PREFIX = RESOURCE_SNAPSHOT_PREFIX;
const DEFAULT_LEASE_MS = 15_000;

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Low-level storage for read models. Refresh ownership belongs to a
 * coordinator; keeping the store free of source-specific logic guarantees
 * that a cache miss cannot accidentally turn into a live daemon request.
 */
export class ResourceSnapshotStore {
  constructor(
    private readonly cache: CacheService,
    private readonly prefix = PREFIX
  ) {}

  private dataKey(kind: string, id: string): string {
    return `${this.prefix}:${keyPart(kind)}:${keyPart(id)}`;
  }

  private leaseKey(kind: string, id: string): string {
    return `${this.dataKey(kind, id)}:lease`;
  }

  async get<T>(kind: string, id: string): Promise<ResourceSnapshotEnvelope<T> | null> {
    try {
      return await this.cache.get<ResourceSnapshotEnvelope<T>>(this.dataKey(kind, id));
    } catch {
      return null;
    }
  }

  async getMany<T>(kind: string, ids: string[]): Promise<Map<string, ResourceSnapshotEnvelope<T>>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Map();
    let values: Array<string | null>;
    try {
      values = await this.cache.getClient().mget(uniqueIds.map((id) => this.dataKey(kind, id)));
    } catch {
      return new Map();
    }
    const result = new Map<string, ResourceSnapshotEnvelope<T>>();
    values.forEach((value, index) => {
      if (!value) return;
      try {
        result.set(uniqueIds[index]!, JSON.parse(value) as ResourceSnapshotEnvelope<T>);
      } catch {
        // A malformed cache entry is a miss. The coordinator will rebuild it.
      }
    });
    return result;
  }

  async markRefreshing<T>(
    kind: string,
    id: string,
    fallbackData: T,
    availability: ResourceSnapshotAvailability = 'unknown',
    lease?: ResourceSnapshotLease | null
  ): Promise<ResourceSnapshotEnvelope<T>> {
    const current = await this.get<T>(kind, id);
    const next: ResourceSnapshotEnvelope<T> = {
      data: current?.data ?? fallbackData,
      revision: current?.revision ?? 0,
      observedAt: current?.observedAt ?? null,
      lastAttemptAt: new Date().toISOString(),
      lastError: current?.lastError ?? null,
      refreshStatus: 'refreshing',
      availability: current?.availability ?? availability,
    };
    return this.write(kind, id, next, lease);
  }

  /** Replace the old payload only after a source successfully produced a complete new one. */
  async replace<T>(
    kind: string,
    id: string,
    data: T,
    options: ResourceSnapshotReplaceOptions = {}
  ): Promise<ResourceSnapshotEnvelope<T>> {
    const current = await this.get<T>(kind, id);
    const now = new Date().toISOString();
    const next: ResourceSnapshotEnvelope<T> = {
      data,
      revision: (current?.revision ?? 0) + 1,
      observedAt: now,
      lastAttemptAt: now,
      lastError: null,
      refreshStatus: 'success',
      availability: options.availability ?? current?.availability ?? 'available',
    };
    return this.write(kind, id, next, options.lease);
  }

  async markError<T>(
    kind: string,
    id: string,
    fallbackData: T,
    error: unknown,
    availability?: ResourceSnapshotAvailability,
    lease?: ResourceSnapshotLease | null
  ): Promise<ResourceSnapshotEnvelope<T>> {
    const current = await this.get<T>(kind, id);
    const next: ResourceSnapshotEnvelope<T> = {
      data: current?.data ?? fallbackData,
      revision: current?.revision ?? 0,
      observedAt: current?.observedAt ?? null,
      lastAttemptAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      refreshStatus: 'error',
      availability: availability ?? current?.availability ?? 'unknown',
    };
    return this.write(kind, id, next, lease);
  }

  async remove(kind: string, id: string): Promise<void> {
    await this.cache
      .getClient()
      .del(this.dataKey(kind, id), this.leaseKey(kind, id))
      .catch(() => {});
  }

  /**
   * One refresh owner per resource prevents a slow source from replacing a
   * newer snapshot with stale data. The compare-and-delete release means a
   * timed-out owner cannot remove a successor's lease.
   */
  async withLease<T>(
    kind: string,
    id: string,
    work: (lease: ResourceSnapshotLease | null) => Promise<T>,
    leaseMs = DEFAULT_LEASE_MS
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const token = randomUUID();
    const key = this.leaseKey(kind, id);
    let acquired: string | null;
    try {
      acquired = await this.cache.getClient().set(key, token, 'PX', leaseMs, 'NX');
    } catch {
      // Redis is an accelerator. The coordinator still coalesces refreshes in
      // this process, and callers retain their safe persisted-source fallback.
      return { acquired: true, value: await work(null) };
    }
    if (acquired !== 'OK') return { acquired: false };
    const lease: ResourceSnapshotLease = { kind, id, token };
    const renewalMs = Math.max(1_000, Math.floor(leaseMs / 3));
    const renewal = setInterval(() => {
      void this.cache
        .getClient()
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0",
          1,
          key,
          token,
          String(leaseMs)
        )
        .catch(() => {});
    }, renewalMs);
    try {
      return { acquired: true, value: await work(lease) };
    } finally {
      clearInterval(renewal);
      await this.cache
        .getClient()
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
          1,
          key,
          token
        )
        .catch(() => {
          // The short lease expires naturally if Redis is unavailable here.
        });
    }
  }

  private async write<T>(
    kind: string,
    id: string,
    next: ResourceSnapshotEnvelope<T>,
    lease?: ResourceSnapshotLease | null
  ): Promise<ResourceSnapshotEnvelope<T>> {
    try {
      if (!lease) {
        await this.cache.set(this.dataKey(kind, id), next);
        return next;
      }
      const written = await this.cache
        .getClient()
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], ARGV[2]); return 1 end return 0",
          2,
          this.leaseKey(kind, id),
          this.dataKey(kind, id),
          lease.token,
          JSON.stringify(next)
        );
      if (written === 1) return next;
      return (await this.get<T>(kind, id)) ?? next;
    } catch {
      return next;
    }
  }
}
