import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@/db/client.js';
import {
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayInstances,
  relayPoolUpdateRuns,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { parkedDrainedAssignmentIds } from '@/services/relay-topology.js';
import { LEGACY_LOCK_RELAY_POOL_REBALANCE } from '@/lib/legacy-compat.js';

type Instance = typeof relayInstances.$inferSelect;
type Assignment = typeof relayEndpointAssignments.$inferSelect;
type Generation = typeof relayEndpointAssignmentGenerations.$inferSelect;

/** Supervisors report every 5 s; a relay silent this long is offline for removal. */
const OFFLINE_REMOVAL_SILENCE_MS = 90_000;

/**
 * When an offline relay can be removed: once its signed policy has expired, so no daemon or relay still admits a
 * grant for it, and it has been silent for 90 s. Null while it is not offline, or for one that never held a policy,
 * which removal refuses.
 */
export function relayRemovableAfter(instance: Pick<Instance, 'state' | 'policyExpiresAt' | 'lastSeenAt'>): Date | null {
  if (instance.state !== 'offline' || !instance.policyExpiresAt) return null;
  const silentSince = instance.lastSeenAt ? instance.lastSeenAt.getTime() + OFFLINE_REMOVAL_SILENCE_MS : 0;
  return new Date(Math.max(instance.policyExpiresAt.getTime(), silentSince));
}

export function assertOfflineRelayCoverage(
  removed: Instance,
  instances: Instance[],
  assignments: Assignment[],
  generations: Generation[],
  now = Date.now()
) {
  const removableAfter = relayRemovableAfter(removed);
  if (!removableAfter || removableAfter.getTime() > now) {
    throw new AppError(
      409,
      'RELAY_OFFLINE_REMOVAL_UNSAFE',
      removableAfter
        ? `Relay must be offline with an expired policy before removal; it can be removed after ${removableAfter.toISOString()}`
        : 'Relay must be offline with an expired policy before removal',
      {
        removableAfter: removableAfter?.toISOString() ?? null,
        policyExpiresAt: removed.policyExpiresAt?.toISOString() ?? null,
        lastSeenAt: removed.lastSeenAt?.toISOString() ?? null,
      }
    );
  }
  const live = generations.filter((g) => ['active', 'staging', 'draining'].includes(g.state));
  const affected = new Set(
    assignments
      .filter((a) => a.relayInstanceId === removed.id && live.some((g) => g.id === a.assignmentGenerationId))
      .map((a) => live.find((g) => g.id === a.assignmentGenerationId)!.endpointId)
  );
  for (const endpointId of affected) {
    const active = generations.find((g) => g.endpointId === endpointId && g.state === 'active');
    const covered =
      active &&
      assignments.some((a) => {
        if (
          a.assignmentGenerationId !== active.id ||
          a.relayInstanceId === removed.id ||
          a.targetRegistrationState !== 'ready'
        )
          return false;
        const peer = instances.find((i) => i.id === a.relayInstanceId);
        return (
          peer?.state === 'ready' &&
          peer.lastSeenAt &&
          peer.lastSeenAt.getTime() >= now - 30_000 &&
          peer.policyExpiresAt &&
          peer.policyExpiresAt.getTime() > now
        );
      });
    if (!covered)
      throw new AppError(
        409,
        'RELAY_REMOVAL_WOULD_ORPHAN_ENDPOINT',
        'A ready remaining relay must serve every affected workload before removal',
        { endpointId }
      );
  }
}

export async function validateRelayRemoval(tx: DrizzleTransaction, instanceId: string, disconnected: () => boolean) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POOL_REBALANCE}))`);
  const instances = await tx
    .select()
    .from(relayInstances)
    .where(eq(relayInstances.poolId, 'system'))
    .orderBy(asc(relayInstances.id))
    .for('update');
  const removed = instances.find((i) => i.id === instanceId);
  if (!removed) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
  const updates = await tx
    .select({ id: relayPoolUpdateRuns.id })
    .from(relayPoolUpdateRuns)
    .where(
      and(
        eq(relayPoolUpdateRuns.poolId, removed.poolId),
        inArray(relayPoolUpdateRuns.state, ['preflight', 'draining', 'updating', 'verifying', 'paused', 'rolling_back'])
      )
    );
  if (updates.length)
    throw new AppError(409, 'RELAY_UPDATE_IN_PROGRESS', 'Finish the active relay pool update before removal');
  const assignments = await tx
    .select()
    .from(relayEndpointAssignments)
    .where(
      inArray(
        relayEndpointAssignments.relayInstanceId,
        instances.map((i) => i.id)
      )
    );
  const generations = assignments.length
    ? await tx
        .select()
        .from(relayEndpointAssignmentGenerations)
        .where(
          inArray(relayEndpointAssignmentGenerations.id, [...new Set(assignments.map((a) => a.assignmentGenerationId))])
        )
        .orderBy(asc(relayEndpointAssignmentGenerations.id))
        .for('update')
    : [];
  // A drained relay's assignments next to other relays in active generations go with it (parkedDrainedAssignmentIds).
  const parked = parkedDrainedAssignmentIds(removed, assignments, generations);
  const retained = assignments.filter(
    (a) =>
      a.relayInstanceId === instanceId &&
      !parked.has(a.id) &&
      generations.some((g) => g.id === a.assignmentGenerationId && ['active', 'staging', 'draining'].includes(g.state))
  );
  if (removed.state === 'offline') {
    if (!disconnected()) throw new AppError(409, 'NODE_CONNECTED', 'Relay reconnected; drain it before removal');
    assertOfflineRelayCoverage(removed, instances, assignments, generations);
  } else if (
    retained.length ||
    !['draining', 'offline', 'error'].includes(removed.state) ||
    (removed.health?.activeTunnels ?? 0) > 0
  ) {
    throw new AppError(409, 'RELAY_INSTANCE_ASSIGNED', 'Drain and evacuate the relay before removal');
  }
  return removed;
}
