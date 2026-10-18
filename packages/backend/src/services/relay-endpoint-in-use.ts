import { and, eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { nodes, relayInstances } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { requestedRelayServicePort } from './relay-service-endpoint.js';

/** The API error code of a relay address and port another relay of the pool already uses. */
export const RELAY_ENDPOINT_IN_USE = 'RELAY_ENDPOINT_IN_USE';

/** An advertised relay address as daemons dial it: host names case-insensitive, IPv6 without brackets. */
function normalizedAddress(address: string): string {
  return address
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
}

/** Where daemons dial a relay: the address with the port, IPv6 in brackets. */
export function relayEndpointLabel(address: string, port: number): string {
  const host = address.trim().replace(/^\[(.*)\]$/, '$1');
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export interface RelayEndpointUser {
  name: string;
  /** The address and port it uses, as the error names it. */
  endpoint: string;
  /** A relay instance listens there; otherwise a relay node waits to enroll with it. */
  kind: 'instance' | 'pending_node';
}

/**
 * The relay instance, or relay node that has not enrolled yet, that already uses one of these addresses with this port;
 * null when none does. Two relays on one address and port would be the same listener: daemons could not tell them
 * apart, and the second install would fail to bind.
 */
export async function relayEndpointUser(
  executor: DrizzleExecutor,
  addresses: readonly string[],
  port: number,
  exclude: { instanceId?: string; nodeId?: string | null } = {}
): Promise<RelayEndpointUser | null> {
  const wanted = new Set(addresses.map(normalizedAddress).filter(Boolean));
  if (!wanted.size) return null;
  const instances = await executor
    .select({
      id: relayInstances.id,
      nodeId: relayInstances.nodeId,
      displayName: relayInstances.displayName,
      advertisedAddresses: relayInstances.advertisedAddresses,
      servicePort: relayInstances.servicePort,
    })
    .from(relayInstances);
  for (const instance of instances) {
    if (instance.id === exclude.instanceId || (exclude.nodeId && instance.nodeId === exclude.nodeId)) continue;
    if (instance.servicePort !== port) continue;
    const shared = instance.advertisedAddresses.find((address) => wanted.has(normalizedAddress(address)));
    if (shared) return { name: instance.displayName, endpoint: relayEndpointLabel(shared, port), kind: 'instance' };
  }
  const enrolledNodeIds = new Set(instances.flatMap(({ nodeId }) => (nodeId ? [nodeId] : [])));
  const pending = await executor
    .select({
      id: nodes.id,
      hostname: nodes.hostname,
      displayName: nodes.displayName,
      serviceAddresses: nodes.serviceAddresses,
      metadata: nodes.metadata,
    })
    .from(nodes)
    .where(and(eq(nodes.type, 'relay'), eq(nodes.status, 'pending')));
  for (const node of pending) {
    if (node.id === exclude.nodeId || enrolledNodeIds.has(node.id)) continue;
    if (requestedRelayServicePort(node.metadata) !== port) continue;
    const shared = node.serviceAddresses.find((address) => wanted.has(normalizedAddress(address)));
    if (shared) {
      return {
        name: node.displayName || node.hostname,
        endpoint: relayEndpointLabel(shared, port),
        kind: 'pending_node',
      };
    }
  }
  return null;
}

/** Refuses an address and port another relay instance or pending relay node uses (409 RELAY_ENDPOINT_IN_USE). */
export async function assertRelayEndpointFree(
  executor: DrizzleExecutor,
  addresses: readonly string[],
  port: number,
  exclude: { instanceId?: string; nodeId?: string | null } = {}
): Promise<void> {
  const user = await relayEndpointUser(executor, addresses, port, exclude);
  if (!user) return;
  throw new AppError(
    409,
    RELAY_ENDPOINT_IN_USE,
    user.kind === 'instance'
      ? `${user.name} already listens on ${user.endpoint}.`
      : `${user.name} is already set up for ${user.endpoint} and waits to enroll.`
  );
}
