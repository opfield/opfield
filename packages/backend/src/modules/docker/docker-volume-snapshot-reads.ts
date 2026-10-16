import { HTTPException } from 'hono/http-exception';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerManagementService } from './docker.service.js';
import { resolveDockerVolumeByName } from './docker-route-resolvers.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';
import { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';

/**
 * Snapshot-backed volume reads shared by the volume routes and the AI/MCP
 * volume tool. They keep working while a node is offline. Callers enforce
 * docker:volumes:view for the volume first.
 */

export function normalizeVolumeDetailItem(volume: Record<string, any>) {
  const usedBy = volume.usedBy ?? volume.UsedBy;
  const normalizedUsedBy = Array.isArray(usedBy) ? usedBy : [];
  return {
    name: volume.name ?? volume.Name,
    driver: volume.driver ?? volume.Driver,
    mountpoint: volume.mountpoint ?? volume.Mountpoint,
    labels: volume.labels ?? volume.Labels ?? {},
    options: volume.options ?? volume.Options ?? {},
    scope: volume.scope ?? volume.Scope,
    managementState: volume.managementState,
    storageKind: volume.storageKind,
    capacityBytes: volume.capacityBytes,
    usedBytes: typeof volume.usedBytes === 'number' ? volume.usedBytes : null,
    adoptable: Boolean(volume.adoptable),
    adoptionReason: volume.adoptionReason,
    availability: volume.availability,
    createdAt: volume.createdAt ?? volume.CreatedAt,
    usedBy: normalizedUsedBy,
    usedByCount: normalizedUsedBy.length,
    usedByTruncated: false,
  };
}

/** Refuse volumes hidden from the user volume list, using the cached inventory. */
export async function assertSnapshotVolumeVisible(nodeId: string, name: string) {
  const snapshots = container.resolve(DockerSnapshotService);
  await snapshots.assertDockerNode(nodeId);
  const [volumes, containers] = await Promise.all([
    snapshots.getList<any[]>(nodeId, 'volumes'),
    snapshots.getList<any[]>(nodeId, 'containers'),
  ]);
  const candidates = (Array.isArray(volumes.data) ? volumes.data : []).filter(
    (volume) => String(volume?.Name ?? volume?.name ?? '') === name
  );
  const decorated = await container
    .resolve(DockerManagementService)
    .decoratePublicVolumeSnapshot(nodeId, candidates, Array.isArray(containers.data) ? containers.data : []);
  if (!decorated.some((volume) => String(volume?.Name ?? volume?.name ?? '') === name)) {
    throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
  }
}

/** Volume detail from the cached inspect, with the public volume visibility applied. */
export async function inspectDockerVolumeSnapshot(nodeId: string, name: string) {
  const snapshots = container.resolve(DockerSnapshotService);
  const detail = await snapshots.getDetail(nodeId, 'volume-detail', name);
  const data = await resolveDockerVolumeByName({ inspectVolume: async () => detail?.data }, nodeId, name);
  const containerSnapshot = await snapshots.getList<any[]>(nodeId, 'containers');
  // The decorated list also carries managed rows it was not given; a hidden volume must not resolve to one of them.
  const decorated = (
    await container
      .resolve(DockerManagementService)
      .decoratePublicVolumeSnapshot(nodeId, [data], Array.isArray(containerSnapshot.data) ? containerSnapshot.data : [])
  ).find((volume) => String(volume?.Name ?? volume?.name ?? '') === name);
  if (!decorated) throw new HTTPException(404, { message: 'Volume not found' });
  const metrics = await snapshots.getDetail<{ usedBytes?: number | null }>(nodeId, 'volume-metrics', name);
  return {
    ...normalizeVolumeDetailItem({ ...decorated, usedBytes: metrics?.data?.usedBytes ?? null }),
    nodeId,
    availability: detail ? snapshots.availability(nodeId, detail) : 'unavailable',
  };
}

/** Cached volume usage; queues a background measurement and answers 503 while none exists. */
export async function getDockerVolumeMetricsSnapshot(nodeId: string, name: string) {
  const snapshots = container.resolve(DockerSnapshotService);
  await snapshots.assertDockerNode(nodeId);
  const volumes = await snapshots.getList<Array<Record<string, unknown>>>(nodeId, 'volumes');
  const exists = volumes.data.some((volume) => String(volume.name ?? volume.Name ?? '') === name);
  if (!exists) throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
  const metrics = await snapshots.getDetail(nodeId, 'volume-metrics', name);
  if (!metrics?.data) {
    container
      .resolve(DockerSnapshotReconciler)
      .enqueue({ nodeId, kind: 'volume-metrics', key: name }, { urgent: true });
    throw new AppError(503, 'DOCKER_VOLUME_METRICS_PENDING', 'Volume metrics are being collected in the background');
  }
  return metrics.data;
}

/**
 * Volumes with the bytes each uses as the node last measured them (`usedBytes`, the volume list's Size column), read
 * from the cached volume metrics; null for a volume not measured yet. A failed cache read leaves the sizes out.
 */
export async function withVolumeUsedBytes<T extends Record<string, any>>(
  nodeId: string,
  volumes: T[]
): Promise<Array<T & { usedBytes: number | null }>> {
  const metrics = await container
    .resolve(DockerSnapshotService)
    .getDetails<{ usedBytes?: number | null }>(nodeId, 'volume-metrics')
    .catch(() => ({}) as Record<string, { data?: { usedBytes?: number | null } }>);
  return volumes.map((volume) => {
    const used = metrics[String(volume.name ?? volume.Name ?? '')]?.data?.usedBytes;
    return { ...volume, usedBytes: typeof used === 'number' ? used : null };
  });
}
