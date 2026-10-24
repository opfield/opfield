import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@/db/client.js';
import { hostingOperations, hostingResources, integrationConnectors } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { HostingProxmoxProfile } from './hosting-provider.types.js';
import { parseIpv4Range, parseVmidRange } from './proxmox-pool.js';
import { confirmedDeletedResourceIds } from './proxmox-quota.js';

type CandidateOperation = {
  action: string;
  resourceId: string | null;
  phase: string;
  dispatchStartedAt: Date | null;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
};

function acceptedNumber(request: Record<string, unknown>, key: string): number | undefined {
  const value = request[key];
  return Number.isInteger(value) ? (value as number) : undefined;
}

function acceptedString(request: Record<string, unknown>, key: string): string | undefined {
  return typeof request[key] === 'string' ? request[key] : undefined;
}

/**
 * Pool admission is deliberately database-only: PVE validates the selected VMID immediately before clone.
 * A timeout never frees a reservation; only a confirmed deletion of the recorded incarnation can do that.
 */
export async function allocateProxmoxPool(
  tx: DrizzleTransaction,
  input: {
    allocationAuthority: string;
    profile: HostingProxmoxProfile;
    usedVmids: number[];
    usedIps?: string[];
    requestedIp?: string;
  }
): Promise<{ vmid: number; ipAddress?: string }> {
  if (!input.profile.vmidRange)
    throw new AppError(409, 'HOSTING_POOL_REQUIRED', 'Configure a bounded Proxmox VMID pool before creating a VM');
  const vmids = parseVmidRange(input.profile.vmidRange).ids;
  const ips =
    input.profile.network === 'static'
      ? input.profile.ipRange && input.profile.subnet && input.profile.gateway
        ? parseIpv4Range(input.profile.ipRange, input.profile.subnet, input.profile.gateway).ips
        : (() => {
            throw new AppError(409, 'HOSTING_IP_POOL_REQUIRED', 'Configure a static IP pool before creating a VM');
          })()
      : [];
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hosting-proxmox-pool:${input.allocationAuthority}`}))`);
  const connectors = await tx
    .select({ id: integrationConnectors.id })
    .from(integrationConnectors)
    .where(
      and(
        eq(integrationConnectors.provider, 'proxmox'),
        or(
          sql`${integrationConnectors.settings}->>'proxmoxAllocationAuthority' = ${input.allocationAuthority}`,
          sql`${integrationConnectors.settings}->>'authority' = ${input.allocationAuthority}`
        )
      )
    );
  const connectorIds = connectors.map((connector) => connector.id);
  const [resources, operations] = await Promise.all([
    tx
      .select()
      .from(hostingResources)
      .where(
        and(
          eq(hostingResources.provider, 'proxmox'),
          or(
            eq(hostingResources.authority, input.allocationAuthority),
            ...(connectorIds.length ? [inArray(hostingResources.connectorId, connectorIds)] : [])
          )
        )
      ),
    connectorIds.length
      ? tx
          .select({
            resourceId: hostingOperations.resourceId,
            action: hostingOperations.action,
            phase: hostingOperations.phase,
            dispatchStartedAt: hostingOperations.dispatchStartedAt,
            request: hostingOperations.request,
            result: hostingOperations.result,
          })
          .from(hostingOperations)
          .where(inArray(hostingOperations.connectorId, connectorIds))
      : Promise.resolve([] as CandidateOperation[]),
  ]);
  const activeResources = resources.filter((resource) => !resource.missingSince);
  const reservedVmids = new Set(input.usedVmids);
  const reservedIps = new Set(input.usedIps ?? []);
  for (const resource of activeResources) {
    const remote = Number(resource.remoteId);
    if (Number.isInteger(remote)) reservedVmids.add(remote);
    for (const address of resource.snapshot.addresses) reservedIps.add(address.ip);
  }
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const confirmedDeleted = new Set([
    ...confirmedDeletedResourceIds(resources, operations),
    ...confirmedDeletedResourceIds(
      resources.map((resource) => ({ ...resource, incarnation: resource.snapshot.incarnation ?? null })),
      operations
    ),
  ]);
  for (const operation of operations) {
    if (operation.action !== 'create') continue;
    const vmid = acceptedNumber(operation.request, 'vmid');
    const ip = acceptedString(operation.request, 'ipAddress');
    const resource = operation.resourceId ? resourceById.get(operation.resourceId) : undefined;
    if (resource && confirmedDeleted.has(resource.id)) continue;
    // Failed requests that never crossed the provider dispatch boundary did not reserve an external identity.
    if (operation.phase === 'failed' && !operation.dispatchStartedAt) continue;
    if (vmid !== undefined) reservedVmids.add(vmid);
    if (ip) reservedIps.add(ip);
  }
  const vmid = vmids.find((candidate) => !reservedVmids.has(candidate));
  if (vmid === undefined)
    throw new AppError(
      409,
      'HOSTING_VMID_UNAVAILABLE',
      'Every VMID in the configured Proxmox pool is reserved or in use'
    );
  if (input.profile.network !== 'static') return { vmid };
  if (input.requestedIp && !ips.includes(input.requestedIp))
    throw new AppError(400, 'HOSTING_IP_OUTSIDE_PROFILE', 'Choose an address from the configured static IP pool');
  const ipAddress = input.requestedIp ?? ips.find((candidate) => !reservedIps.has(candidate));
  if (!ipAddress || reservedIps.has(ipAddress))
    throw new AppError(
      409,
      'HOSTING_IP_RESERVED',
      'Every address in the configured static IP pool is reserved or in use'
    );
  return { vmid, ipAddress };
}
