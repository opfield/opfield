import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { dockerScopedNodeIds } from './docker-access-resource.service.js';

export const DOCKER_SNAPSHOT_KINDS = ['containers', 'images', 'volumes', 'networks'] as const;
export type DockerSnapshotKind = (typeof DOCKER_SNAPSHOT_KINDS)[number];
export type DockerDetailKind = 'container-detail' | 'volume-detail' | 'volume-metrics';
export type DockerRefreshKind = DockerSnapshotKind | DockerDetailKind;
export type DockerAvailability = 'available' | 'unavailable';

export interface DockerSnapshotEnvelope<T = unknown[]> {
  data: T;
  revision: number;
  observedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  refreshStatus: 'never' | 'refreshing' | 'success' | 'error';
}

export interface DockerSnapshotNodeMetadata {
  id: string;
  slug: string;
  hostname: string;
  displayName: string | null;
  appearanceColor: string | null;
  availability: DockerAvailability;
  revision: number;
  observedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export const DOCKER_SNAPSHOT_PREFIX = 'opfield:docker:snapshot:v1';
const PREFIX = DOCKER_SNAPSHOT_PREFIX;
const NODE_INDEX_KEY = `${PREFIX}:nodes`;
const VIEW_SCOPES: Record<DockerSnapshotKind, string> = {
  containers: 'docker:containers:view',
  images: 'docker:images:view',
  volumes: 'docker:volumes:view',
  networks: 'docker:networks:view',
};

const SECRET_SHAPED_KEY =
  /(?:password|passwd|secret|credential|privatekey|access[_-]?token|refresh[_-]?token|registry[_-]?auth|authorization|(?:^|[._-])auth(?:$|[._-]))/i;

function emptyEnvelope<T>(data: T): DockerSnapshotEnvelope<T> {
  return {
    data,
    revision: 0,
    observedAt: null,
    lastAttemptAt: null,
    lastError: null,
    refreshStatus: 'never',
  };
}

function normalizeCachedValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? null : JSON.parse(serialized)) as T;
}

function sortMaterialArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const normalized = sortMaterialArrays(item);
        return { normalized, key: JSON.stringify(normalized) };
      })
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ normalized }) => normalized);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, sortMaterialArrays(nested)])
  );
}

function materialListValue(kind: DockerSnapshotKind, value: unknown): unknown {
  const stableValue =
    kind !== 'containers' || !Array.isArray(value)
      ? value
      : value.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
          const { status, ...stable } = item as Record<string, unknown>;
          const health =
            typeof status === 'string'
              ? status.match(/\((?:health:\s*)?(starting|healthy|unhealthy)\)/i)?.[1]?.toLowerCase()
              : undefined;
          return health ? { ...stable, __dockerHealth: health } : stable;
        });
  return sortMaterialArrays(stableValue);
}

export function sanitizeContainerInspect(value: unknown): unknown {
  const visit = (input: unknown, parentKey = ''): unknown => {
    if (Array.isArray(input)) return input.map((item) => visit(item, parentKey));
    if (!input || typeof input !== 'object') return input;

    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (parentKey.toLowerCase() === 'config' && normalized === 'env') continue;
      if (
        normalized === 'registryauth' ||
        normalized === 'registryauthjson' ||
        normalized === 'authconfig' ||
        SECRET_SHAPED_KEY.test(key)
      ) {
        continue;
      }
      result[key] = visit(nested, key);
    }
    return result;
  };
  return visit(value);
}

function observedAtOrZero(envelope: { observedAt: string | null }): number {
  const observedAt = envelope.observedAt ? Date.parse(envelope.observedAt) : Number.NaN;
  return Number.isFinite(observedAt) ? observedAt : 0;
}

function readString(record: Record<string, unknown>, camel: string, docker: string): string | undefined {
  const value = record[camel] ?? record[docker];
  return typeof value === 'string' ? value : undefined;
}

function sanitizeVolumeLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const labels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(value as Record<string, unknown>)) {
    if (!SECRET_SHAPED_KEY.test(key) && typeof labelValue === 'string') labels[key] = labelValue;
  }
  return labels;
}

/** Persist only fields consumed by the volume list/detail API. Docker Options/Status never enter Redis. */
export function sanitizeVolumeSnapshot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const usedBy = record.usedBy ?? record.UsedBy;
  const labels = sanitizeVolumeLabels(record.labels ?? record.Labels);
  return {
    name: readString(record, 'name', 'Name') ?? '',
    driver: readString(record, 'driver', 'Driver') ?? '',
    mountpoint: readString(record, 'mountpoint', 'Mountpoint') ?? '',
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    scope: readString(record, 'scope', 'Scope') ?? '',
    ...(readString(record, 'createdAt', 'CreatedAt')
      ? { createdAt: readString(record, 'createdAt', 'CreatedAt') }
      : {}),
    usedBy: Array.isArray(usedBy) ? usedBy.filter((item): item is string => typeof item === 'string') : [],
  };
}

function nullableMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Persist only the stable metrics contract returned by the Docker daemon. */
export function sanitizeVolumeMetricsSnapshot(value: unknown): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    storageKind: record.storageKind === 'disk-image' ? 'disk-image' : 'regular',
    usedBytes: nullableMetric(record.usedBytes),
    capacityBytes: nullableMetric(record.capacityBytes),
    availableBytes: nullableMetric(record.availableBytes),
    usedInodes: nullableMetric(record.usedInodes),
    totalInodes: nullableMetric(record.totalInodes),
    runningAttachmentCount: nullableMetric(record.runningAttachmentCount) ?? 0,
    collectedAt: typeof record.collectedAt === 'string' ? record.collectedAt : '',
  };
}

export class DockerSnapshotService {
  private readonly deletedNodes = new Set<string>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly cache: CacheService,
    private readonly registry: NodeRegistryService,
    private readonly eventBus: EventBusService
  ) {}

  private listKey(nodeId: string, kind: DockerSnapshotKind) {
    return `${PREFIX}:${nodeId}:list:${kind}`;
  }

  private detailKey(nodeId: string, kind: DockerDetailKind) {
    return `${PREFIX}:${nodeId}:details:${kind}`;
  }

  private async trackNode(nodeId: string) {
    if (this.deletedNodes.has(nodeId)) return;
    await this.cache.sadd(NODE_INDEX_KEY, nodeId);
  }

  markNodeDeleted(nodeId: string): void {
    this.deletedNodes.add(nodeId);
  }

  reviveNode(nodeId: string): void {
    this.deletedNodes.delete(nodeId);
  }

  isNodeDeleted(nodeId: string): boolean {
    return this.deletedNodes.has(nodeId);
  }

  async assertDockerNode(nodeId: string) {
    const [node] = await this.db
      .select({ id: nodes.id, type: nodes.type })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NOT_FOUND', 'Node not found');
    if (node.type !== 'docker') throw new AppError(400, 'NOT_DOCKER', 'Node is not a Docker node');
  }

  async getList<T = unknown[]>(nodeId: string, kind: DockerSnapshotKind): Promise<DockerSnapshotEnvelope<T>> {
    return (await this.cache.get<DockerSnapshotEnvelope<T>>(this.listKey(nodeId, kind))) ?? emptyEnvelope([] as T);
  }

  async markListRefreshing(nodeId: string, kind: DockerSnapshotKind): Promise<void> {
    if (this.isNodeDeleted(nodeId)) return;
    const current = await this.getList(nodeId, kind);
    if (this.isNodeDeleted(nodeId)) return;
    await this.trackNode(nodeId);
    if (this.isNodeDeleted(nodeId)) return;
    await this.cache.set(this.listKey(nodeId, kind), {
      ...current,
      lastAttemptAt: new Date().toISOString(),
      refreshStatus: 'refreshing',
    });
  }

  async replaceList(nodeId: string, kind: DockerSnapshotKind, data: unknown[]): Promise<DockerSnapshotEnvelope> {
    const current = await this.getList(nodeId, kind);
    if (this.isNodeDeleted(nodeId)) return current;
    const now = new Date().toISOString();
    const sanitizedData = normalizeCachedValue(kind === 'volumes' ? data.map(sanitizeVolumeSnapshot) : data);
    const materiallyChanged =
      !isDeepStrictEqual(materialListValue(kind, current.data), materialListValue(kind, sanitizedData)) ||
      current.observedAt === null ||
      current.lastError !== null;
    const next: DockerSnapshotEnvelope = {
      data: sanitizedData,
      revision: current.revision + (materiallyChanged ? 1 : 0),
      observedAt: now,
      lastAttemptAt: now,
      lastError: null,
      refreshStatus: 'success',
    };
    await this.trackNode(nodeId);
    if (this.isNodeDeleted(nodeId)) return current;
    await this.cache.set(this.listKey(nodeId, kind), next);
    if (this.isNodeDeleted(nodeId)) return current;
    if (kind === 'volumes') {
      const liveNames = new Set(
        sanitizedData
          .map((item) => String((item as Record<string, unknown>).name ?? ''))
          .filter((name) => name.length > 0)
      );
      // Details and size readings of removed volumes are dropped with them, or they stay in Redis for good.
      for (const detailKind of ['volume-detail', 'volume-metrics'] as const) {
        const detailKey = this.detailKey(nodeId, detailKind);
        const staleNames = (await this.cache.getClient().hkeys(detailKey)).filter((name) => !liveNames.has(name));
        if (staleNames.length > 0) await this.cache.getClient().hdel(detailKey, ...staleNames);
      }
    }
    if (kind === 'containers') {
      const liveKeys = new Set<string>();
      for (const item of sanitizedData as Array<Record<string, unknown>>) {
        const id = String(item.id ?? item.Id ?? '');
        if (id) {
          liveKeys.add(id);
          liveKeys.add(id.slice(0, 12));
        }
        const names = Array.isArray(item.names ?? item.Names) ? ((item.names ?? item.Names) as unknown[]) : [];
        for (const name of [item.name, item.Name, ...names]) {
          if (typeof name !== 'string' || !name) continue;
          liveKeys.add(name);
          liveKeys.add(name.replace(/^\//, ''));
        }
      }
      if (liveKeys.size > 0 || sanitizedData.length === 0) {
        const detailKey = this.detailKey(nodeId, 'container-detail');
        const staleKeys = (await this.cache.getClient().hkeys(detailKey)).filter((key) => !liveKeys.has(key));
        if (staleKeys.length > 0) await this.cache.getClient().hdel(detailKey, ...staleKeys);
      }
    }
    if (this.isNodeDeleted(nodeId)) return current;
    if (materiallyChanged) {
      this.eventBus.publish('docker.snapshot.changed', { nodeId, kind, revision: next.revision });
    }
    return next;
  }

  async reconcileComposeProjects(nodeId: string): Promise<void> {
    const { reconcileExternalComposeProjects } = await import('./compose/compose-discovery.service.js');
    const [containers, volumes, networks] = await Promise.all([
      this.getList<Record<string, unknown>[]>(nodeId, 'containers'),
      this.getList<Record<string, unknown>[]>(nodeId, 'volumes'),
      this.getList<Record<string, unknown>[]>(nodeId, 'networks'),
    ]);
    await reconcileExternalComposeProjects(
      this.db,
      nodeId,
      {
        containers: Array.isArray(containers.data) ? containers.data : [],
        volumes: Array.isArray(volumes.data) ? volumes.data : [],
        networks: Array.isArray(networks.data) ? networks.data : [],
      },
      new Date(),
      (change) => this.eventBus.publish('docker.compose.changed', { nodeId, ...change })
    );
  }

  async markListError(nodeId: string, kind: DockerSnapshotKind, error: unknown): Promise<void> {
    if (this.isNodeDeleted(nodeId)) return;
    const current = await this.getList(nodeId, kind);
    if (this.isNodeDeleted(nodeId)) return;
    await this.trackNode(nodeId);
    if (this.isNodeDeleted(nodeId)) return;
    await this.cache.set(this.listKey(nodeId, kind), {
      ...current,
      lastAttemptAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      refreshStatus: 'error',
    });
  }

  async getDetail<T = unknown>(nodeId: string, kind: DockerDetailKind, key: string) {
    const value = await this.cache.getClient().hget(this.detailKey(nodeId, kind), key);
    if (!value) return null;
    return JSON.parse(value) as DockerSnapshotEnvelope<T>;
  }

  async getDetails<T = unknown>(nodeId: string, kind: DockerDetailKind) {
    const values = await this.cache.getClient().hgetall(this.detailKey(nodeId, kind));
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, JSON.parse(value) as DockerSnapshotEnvelope<T>])
    );
  }

  async getContainerDetailSnapshot(nodeId: string, key: string): Promise<DockerSnapshotEnvelope<any>> {
    await this.assertDockerNode(nodeId);
    const direct = await this.getDetail<any>(nodeId, 'container-detail', key);
    const list = await this.getList<Record<string, unknown>[]>(nodeId, 'containers');
    let match = Array.isArray(list.data)
      ? list.data.find(
          (item) =>
            String(item.id ?? item.Id ?? '') === key || String(item.name ?? item.Name ?? '').replace(/^\/+/, '') === key
        )
      : undefined;
    if (!match && direct && Array.isArray(list.data)) {
      const directName = String(direct.data?.name ?? direct.data?.Name ?? '').replace(/^\/+/, '');
      if (directName) {
        match = list.data.find((item) => String(item.name ?? item.Name ?? '').replace(/^\/+/, '') === directName);
      }
    }
    // A container the list, read after its cached inspect, no longer has was removed: its inspect is not the
    // container's state anymore. A cached inspect newer than the list is a container created since.
    if (!match && direct && observedAtOrZero(list) > observedAtOrZero(direct)) {
      throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Container snapshot not found');
    }
    const liveId = String(match?.id ?? match?.Id ?? '');
    const directId = String(direct?.data?.id ?? direct?.data?.Id ?? '');
    if (direct && (!liveId || !directId || liveId === directId)) return direct;
    // The list and the cached inspect name different runtimes of the container (a recreate): the one observed
    // last is the current one.
    if (direct && observedAtOrZero(direct) >= observedAtOrZero(list)) return direct;

    const name = String(match?.name ?? match?.Name ?? '').replace(/^\/+/, '');
    if (liveId && liveId !== key) {
      const byId = await this.getDetail<any>(nodeId, 'container-detail', liveId);
      if (byId) return byId;
    }
    if (name && name !== key) {
      const byName = await this.getDetail<any>(nodeId, 'container-detail', name);
      const byNameId = String(byName?.data?.id ?? byName?.data?.Id ?? '');
      if (byName && (!liveId || !byNameId || liveId === byNameId)) return byName;
    }
    throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Container snapshot not found');
  }

  /** Drops cached details, as when their resource was removed. */
  async deleteDetails(nodeId: string, kind: DockerDetailKind, keys: readonly string[]): Promise<void> {
    const fields = [...new Set(keys.filter(Boolean))];
    if (fields.length > 0) await this.cache.getClient().hdel(this.detailKey(nodeId, kind), ...fields);
  }

  async getContainerDetail(nodeId: string, key: string): Promise<any> {
    return (await this.getContainerDetailSnapshot(nodeId, key)).data;
  }

  async replaceDetail(nodeId: string, kind: DockerDetailKind, key: string, data: unknown) {
    const current = await this.getDetail(nodeId, kind, key);
    if (this.isNodeDeleted(nodeId)) return current;
    const now = new Date().toISOString();
    const sanitizedData = normalizeCachedValue(
      kind === 'container-detail'
        ? sanitizeContainerInspect(data)
        : kind === 'volume-metrics'
          ? sanitizeVolumeMetricsSnapshot(data)
          : sanitizeVolumeSnapshot(data)
    );
    const materiallyChanged =
      !current ||
      !isDeepStrictEqual(current.data, sanitizedData) ||
      current.observedAt === null ||
      current.lastError !== null;
    const next: DockerSnapshotEnvelope<unknown> = {
      data: sanitizedData,
      revision: (current?.revision ?? 0) + (materiallyChanged ? 1 : 0),
      observedAt: now,
      lastAttemptAt: now,
      lastError: null,
      refreshStatus: 'success',
    };
    await this.trackNode(nodeId);
    if (this.isNodeDeleted(nodeId)) return current;
    await this.cache.getClient().hset(this.detailKey(nodeId, kind), key, JSON.stringify(next));
    if (this.isNodeDeleted(nodeId)) return current;
    if (materiallyChanged) {
      this.eventBus.publish('docker.snapshot.changed', { nodeId, kind, key, revision: next.revision });
    }
    return next;
  }

  async markDetailError(nodeId: string, kind: DockerDetailKind, key: string, error: unknown) {
    if (this.isNodeDeleted(nodeId)) return;
    const current = (await this.getDetail(nodeId, kind, key)) ?? emptyEnvelope(null);
    if (this.isNodeDeleted(nodeId)) return;
    const next = {
      ...current,
      lastAttemptAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      refreshStatus: 'error' as const,
    };
    await this.trackNode(nodeId);
    if (this.isNodeDeleted(nodeId)) return;
    await this.cache.getClient().hset(this.detailKey(nodeId, kind), key, JSON.stringify(next));
  }

  availability(nodeId: string, envelope: DockerSnapshotEnvelope<unknown>): DockerAvailability {
    return this.registry.getNode(nodeId) && envelope.observedAt !== null && envelope.lastError === null
      ? 'available'
      : 'unavailable';
  }

  async listVisibleNodes(kind: DockerSnapshotKind, scopes: string[], nodeId?: string) {
    const rows = await this.db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        appearanceColor: nodes.appearanceColor,
      })
      .from(nodes)
      .where(eq(nodes.type, 'docker'));
    const scope = VIEW_SCOPES[kind];
    const childNodeIds = new Set(dockerScopedNodeIds(scopes, [scope]));
    return rows.filter(
      (node) =>
        (!nodeId || node.id === nodeId) &&
        (TokensService.hasScope(scopes, `${scope}:${node.id}`) || childNodeIds.has(node.id))
    );
  }

  toNodeMetadata(
    node: { id: string; slug: string; hostname: string; displayName: string | null; appearanceColor: string | null },
    envelope: DockerSnapshotEnvelope
  ): DockerSnapshotNodeMetadata {
    return {
      ...node,
      availability: this.availability(node.id, envelope),
      revision: envelope.revision,
      observedAt: envelope.observedAt,
      lastAttemptAt: envelope.lastAttemptAt,
      lastError: envelope.lastError,
    };
  }

  async publishNodeAvailability(nodeId: string): Promise<void> {
    await this.assertDockerNode(nodeId);
    await Promise.all(
      DOCKER_SNAPSHOT_KINDS.map(async (kind) => {
        const snapshot = await this.getList(nodeId, kind);
        this.eventBus.publish('docker.snapshot.changed', {
          nodeId,
          kind,
          revision: snapshot.revision,
          availability: this.availability(nodeId, snapshot),
        });
      })
    );
  }

  async purgeNode(nodeId: string): Promise<void> {
    this.markNodeDeleted(nodeId);
    const keys = [
      ...DOCKER_SNAPSHOT_KINDS.map((kind) => this.listKey(nodeId, kind)),
      this.detailKey(nodeId, 'container-detail'),
      this.detailKey(nodeId, 'volume-detail'),
      this.detailKey(nodeId, 'volume-metrics'),
    ];
    await this.cache.getClient().del(...keys);
    await this.cache.srem(NODE_INDEX_KEY, nodeId);
  }

  async purgeOrphans(): Promise<void> {
    const tracked = await this.cache.smembers(NODE_INDEX_KEY);
    if (tracked.length === 0) return;
    const existing = new Set(
      (await this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.type, 'docker'))).map((node) => node.id)
    );
    await Promise.all(tracked.filter((nodeId) => !existing.has(nodeId)).map((nodeId) => this.purgeNode(nodeId)));
  }
}
