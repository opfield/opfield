import type { RelayPolicyRouteEntry } from '@/db/schema/relay.js';

/**
 * While Opfield is up, a relay must apply a policy that revokes a route this soon after the
 * revocation, the same bound Opfield gives a silent relay before it counts it offline. A relay
 * that misses it is stale for the revoked routes: daemons refuse those routes through it.
 */
export const RELAY_REVOCATION_ACK_TIMEOUT_MS = 90_000;

export interface BuiltPolicyRoute {
  routeId: string;
  endpointId: string;
  routeGeneration: number;
  endpointGeneration: number;
}

export interface CurrentPolicyRoute {
  generation: number;
  targetEndpointId: string;
}

export interface RelayRevokedRouteFence {
  relayInstanceId: string;
  endpointId: string;
  routes: Array<{ routeId: string; allowedGeneration: string }>;
}

export interface RelayRevocationStatus {
  state: 'pending' | 'stale';
  message: string;
  /** Revoked routes this relay did not acknowledge in time; daemons refuse them through it. */
  staleRoutes: number;
  /** Revoked routes still inside the acknowledgement deadline. */
  pendingRoutes: number;
  /** The policy revision the relay must apply to clear the state. */
  requiredRevision: number;
  since: string;
}

function entryKey(entry: BuiltPolicyRoute): string {
  return `${entry.routeId}:${entry.endpointId}:${entry.routeGeneration}:${entry.endpointGeneration}`;
}

/**
 * The route tuples a relay may admit after Opfield built a snapshot at `revision` for it: the
 * built tuples, plus earlier ones the relay has not yet acknowledged dropping. A tuple leaves
 * only when the relay acknowledges a revision at or above the one that first dropped it.
 */
export function projectBuiltRoutes(
  previous: RelayPolicyRouteEntry[] | null | undefined,
  built: BuiltPolicyRoute[],
  revision: number
): RelayPolicyRouteEntry[] {
  const current = new Map<string, RelayPolicyRouteEntry>();
  for (const route of built) {
    current.set(entryKey(route), {
      routeId: route.routeId,
      endpointId: route.endpointId,
      routeGeneration: route.routeGeneration,
      endpointGeneration: route.endpointGeneration,
    });
  }
  const retained = new Map<string, RelayPolicyRouteEntry>();
  for (const entry of previous ?? []) {
    const key = entryKey(entry);
    if (current.has(key) || retained.has(key)) continue;
    retained.set(key, entry.removedAtRevision === undefined ? { ...entry, removedAtRevision: revision } : entry);
  }
  return [...current.values(), ...retained.values()].sort((left, right) =>
    entryKey(left).localeCompare(entryKey(right))
  );
}

export interface ReconcileRevocationInput {
  /** A revision the relay applied, trusted only when Opfield has issued it. */
  acknowledgedRevision: number;
  /** The lowest pool revision any snapshot built from now on can carry. */
  nextRevision: number;
  routes: Map<string, CurrentPolicyRoute>;
  endpointGenerations: Map<string, number>;
  now: Date;
  /** Deadlines never run from before this instant: Opfield start, when a relay could not be judged. */
  judgeFrom: number;
}

export interface ReconcileRevocationResult {
  entries: RelayPolicyRouteEntry[];
  changed: boolean;
  newlyStale: RelayPolicyRouteEntry[];
  cleared: RelayPolicyRouteEntry[];
}

/**
 * The revision a relay's report acknowledges. A relay reporting a revision Opfield never issued
 * (Opfield's sequence was restored from a backup) has applied nothing Opfield built since.
 */
export function trustedAcknowledgement(reported: number, issued: number): number {
  return Number.isSafeInteger(reported) && reported > 0 && reported <= issued ? reported : 0;
}

function isAllowed(entry: RelayPolicyRouteEntry, input: ReconcileRevocationInput): boolean {
  const route = input.routes.get(entry.routeId);
  return (
    route !== undefined &&
    route.generation === entry.routeGeneration &&
    route.targetEndpointId === entry.endpointId &&
    input.endpointGenerations.get(entry.endpointId) === entry.endpointGeneration
  );
}

/**
 * Applies the relay's acknowledgement, records revocations Opfield made since the tuple was
 * built and marks revocations stale once their deadline passed. Pure: the caller persists it.
 */
export function reconcileRevocations(
  entries: RelayPolicyRouteEntry[] | null | undefined,
  input: ReconcileRevocationInput
): ReconcileRevocationResult {
  const result: ReconcileRevocationResult = { entries: [], changed: false, newlyStale: [], cleared: [] };
  for (const entry of entries ?? []) {
    if (entry.removedAtRevision !== undefined && entry.removedAtRevision <= input.acknowledgedRevision) {
      result.changed = true;
      if (entry.staleAt) result.cleared.push(entry);
      continue;
    }
    if (isAllowed(entry, input)) {
      result.entries.push(entry);
      continue;
    }
    let next: RelayPolicyRouteEntry = {
      ...entry,
      removedAtRevision: entry.removedAtRevision ?? input.nextRevision,
      revokedAt: entry.revokedAt ?? input.now.toISOString(),
    };
    const deadline = Math.max(Date.parse(next.revokedAt as string), input.judgeFrom) + RELAY_REVOCATION_ACK_TIMEOUT_MS;
    if (!next.staleAt && input.now.getTime() >= deadline) {
      next = { ...next, staleAt: input.now.toISOString() };
      result.newlyStale.push(next);
    }
    if (
      next.removedAtRevision !== entry.removedAtRevision ||
      next.revokedAt !== entry.revokedAt ||
      next.staleAt !== entry.staleAt
    )
      result.changed = true;
    result.entries.push(next);
  }
  return result;
}

/** Routes each stale relay must not deliver: route id to the stale relay instance ids. */
export function staleRelaysByRoute(
  instances: Array<{ id: string; policyRoutes: RelayPolicyRouteEntry[] | null }>
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const instance of instances) {
    for (const entry of instance.policyRoutes ?? []) {
      if (!entry.staleAt) continue;
      const relays = result.get(entry.routeId) ?? new Set<string>();
      relays.add(instance.id);
      result.set(entry.routeId, relays);
    }
  }
  return result;
}

/**
 * The fences an endpoint daemon enforces: per stale relay and endpoint, the revoked routes with
 * the only generation still allowed through that relay (0 when the route no longer targets it).
 */
export function revocationFencesForEndpoints(
  instances: Array<{ id: string; policyRoutes: RelayPolicyRouteEntry[] | null }>,
  endpointIds: Set<string>,
  routes: Map<string, CurrentPolicyRoute>
): RelayRevokedRouteFence[] {
  const fences = new Map<string, RelayRevokedRouteFence>();
  for (const instance of instances) {
    for (const entry of instance.policyRoutes ?? []) {
      if (!entry.staleAt || !endpointIds.has(entry.endpointId)) continue;
      const key = `${instance.id}:${entry.endpointId}`;
      const fence = fences.get(key) ?? { relayInstanceId: instance.id, endpointId: entry.endpointId, routes: [] };
      fences.set(key, fence);
      if (fence.routes.some(({ routeId }) => routeId === entry.routeId)) continue;
      const route = routes.get(entry.routeId);
      fence.routes.push({
        routeId: entry.routeId,
        allowedGeneration: String(route?.targetEndpointId === entry.endpointId ? route.generation : 0),
      });
    }
  }
  return [...fences.values()]
    .map((fence) => ({ ...fence, routes: fence.routes.sort((a, b) => a.routeId.localeCompare(b.routeId)) }))
    .sort((a, b) => `${a.relayInstanceId}:${a.endpointId}`.localeCompare(`${b.relayInstanceId}:${b.endpointId}`));
}

/** The relay's revocation state for health surfaces; null when it holds no revoked route. */
export function describeRelayRevocation(
  entries: RelayPolicyRouteEntry[] | null | undefined
): RelayRevocationStatus | null {
  const revoked = (entries ?? []).filter((entry) => entry.revokedAt);
  if (!revoked.length) return null;
  const staleRoutes = new Set(revoked.filter((entry) => entry.staleAt).map(({ routeId }) => routeId));
  const pendingRoutes = new Set(
    revoked.filter((entry) => !entry.staleAt && !staleRoutes.has(entry.routeId)).map(({ routeId }) => routeId)
  );
  const since = revoked
    .map((entry) => entry.revokedAt as string)
    .sort()
    .at(0) as string;
  const requiredRevision = Math.max(...revoked.map((entry) => entry.removedAtRevision ?? 0));
  // Counts and the start time are separate fields; the message says what it means and what clears it.
  return {
    state: staleRoutes.size ? 'stale' : 'pending',
    message: staleRoutes.size
      ? `The relay did not apply the revoking policy in time. Daemons refuse the revoked routes through it until it applies policy revision ${requiredRevision} or later; its other routes keep working.`
      : `Waiting for the relay to apply policy revision ${requiredRevision}, which revokes these routes.`,
    staleRoutes: staleRoutes.size,
    pendingRoutes: pendingRoutes.size,
    requiredRevision,
    since,
  };
}
