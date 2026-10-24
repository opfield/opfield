import { eq, sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@/db/client.js';
import { hostingOperations, hostingResources, integrationConnectors } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { HostingProxmoxProfile } from './hosting-provider.types.js';

type Vector = { cpu?: number | null; memoryMb?: number | null; diskGb?: number | null };
type Resource = {
  id: string;
  remoteId: string;
  origin?: string;
  missingSince: Date | null;
  incarnation?: string | null;
  snapshot: Vector;
};
type Operation = {
  action: string;
  phase: string;
  resourceId: string | null;
  dispatchStartedAt: Date | null;
  request: Record<string, unknown>;
  result?: Record<string, unknown> | null;
};
const dimensions = [
  ['cpu', 'maxCpu'],
  ['memoryMb', 'maxMemoryMb'],
  ['diskGb', 'maxDiskGb'],
] as const;

const LIMIT_KEYS = dimensions.map(([, key]) => key);

/** Settings without the Proxmox resource limits: limits are policy read at reservation, not connection identity. */
export function withoutProxmoxLimits<T extends { proxmox?: HostingProxmoxProfile | null }>(settings: T): T {
  if (!settings.proxmox) return settings;
  const proxmox = Object.fromEntries(
    Object.entries(settings.proxmox).filter(([key]) => !(LIMIT_KEYS as readonly string[]).includes(key))
  ) as HostingProxmoxProfile;
  return { ...settings, proxmox };
}

/**
 * Managed resources the provider confirmed destroyed: absent from the inventory (missingSince) after a delete of this
 * exact incarnation reported providerDeleted. The delete operation may still be waiting to remove the node records
 * (phase unknown): the VM is gone either way and holds no allocation.
 */
export function confirmedDeletedResourceIds(
  resources: Pick<Resource, 'id' | 'missingSince' | 'incarnation'>[],
  operations: Pick<Operation, 'action' | 'phase' | 'resourceId' | 'result'>[]
): Set<string> {
  const deleted = new Set<string>();
  for (const resource of resources) {
    if (!resource.missingSince || !resource.incarnation) continue;
    if (
      operations.some(
        (operation) =>
          operation.action === 'delete' &&
          operation.phase !== 'failed' &&
          operation.resourceId === resource.id &&
          operation.result?.providerDeleted === true &&
          operation.result.deletedIncarnation === resource.incarnation
      )
    )
      deleted.add(resource.id);
  }
  return deleted;
}

export function assertProxmoxQuota(
  profile: HostingProxmoxProfile,
  resources: Resource[],
  operations: Operation[],
  candidate: Vector,
  resizingId?: string
) {
  const deleted = confirmedDeletedResourceIds(resources, operations);
  for (const [dimension, limitKey] of dimensions) {
    const limit = profile[limitKey];
    if (limit === undefined) continue;
    const allocations = new Map<string, number | null>();
    for (const resource of resources) {
      // Discovery is inventory, not an allocation managed by this connector.
      if (resource.origin === 'discovered') continue;
      if (deleted.has(resource.id)) continue;
      const value = resource.snapshot[dimension];
      allocations.set(resource.id, typeof value === 'number' && Number.isFinite(value) ? value : null);
    }
    for (const [index, operation] of operations.entries()) {
      if (!['create', 'resize', 'install'].includes(operation.action)) continue;
      if (
        operation.phase === 'ready' ||
        (operation.phase === 'failed' && (operation.action === 'install' || !operation.dispatchStartedAt))
      )
        continue;
      // A create or resize of a VM the provider has since destroyed holds nothing, whatever phase it ended in.
      if (operation.resourceId && deleted.has(operation.resourceId)) continue;
      const value = operation.request[dimension];
      if (typeof value !== 'number') continue;
      const key =
        operation.resourceId ??
        resources.find((item) => !item.missingSince && item.remoteId === String(operation.request.vmid))?.id ??
        `pending-${index}`;
      // Never spend a requested reduction before the provider confirms it; tracked creates count once.
      allocations.set(key, Math.max(allocations.get(key) ?? 0, value));
    }
    const key = resizingId ?? 'candidate';
    const value = candidate[dimension];
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new AppError(409, 'HOSTING_QUOTA_UNKNOWN', 'Choose explicit VM resources before provisioning');
    allocations.set(key, Math.max(allocations.get(key) ?? 0, value));
    const values = [...allocations.values()];
    if (values.some((value) => value === null))
      throw new AppError(409, 'HOSTING_QUOTA_UNKNOWN', 'Refresh inventory before allocating against resource limits');
    if (values.reduce<number>((sum, allocation) => sum + (allocation ?? 0), 0) > limit)
      throw new AppError(
        409,
        'HOSTING_RESOURCE_LIMIT',
        `The connector's managed ${dimension} limit is ${limit}; this request would allocate ${values.reduce<number>((sum, allocation) => sum + (allocation ?? 0), 0)}, including pending operations`
      );
  }
}

/** Called inside intent reservation, before insertion. Creation and resize share the same cluster lock. */
export async function reserveProxmoxQuota(
  tx: DrizzleTransaction,
  connectorId: string,
  candidate: Vector,
  resizingId?: string
) {
  const [connector] = await tx.select().from(integrationConnectors).where(eq(integrationConnectors.id, connectorId));
  const settings = connector?.settings as
    | { proxmox?: HostingProxmoxProfile; proxmoxAllocationAuthority?: string }
    | undefined;
  const profile = settings?.proxmox;
  if (!profile || dimensions.every(([, key]) => profile[key] === undefined)) return;
  if (!settings?.proxmoxAllocationAuthority)
    throw new AppError(409, 'HOSTING_QUOTA_UNKNOWN', 'Reconnect Proxmox before using aggregate resource limits');
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`hosting-proxmox-pool:${settings.proxmoxAllocationAuthority}`}))`
  );
  const resources = await tx.select().from(hostingResources).where(eq(hostingResources.connectorId, connectorId));
  const operations = await tx.select().from(hostingOperations).where(eq(hostingOperations.connectorId, connectorId));
  assertProxmoxQuota(profile, resources, operations, candidate, resizingId);
}
