import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  type DockerAvailabilityPartitionMode,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPolicies,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { PLANNED_HANDOFF_TTL_MS } from './lease-constants.js';
import { loadLeasePolicy } from './lease-policy-registry.js';
import { ensureAvailabilityLeaseState, ensureLeaseState } from './lease-store.js';
import { validateLeaseWitness } from './lease-witness.js';

/**
 * Lease state of a registered lease policy of any kind; an id that is not registered yet is an Availability policy
 * (registered on first use).
 */
async function ensureStateOf(db: DrizzleExecutor, leasePolicyId: string) {
  return (await loadLeasePolicy(db, leasePolicyId))
    ? ensureLeaseState(db, leasePolicyId)
    : ensureAvailabilityLeaseState(db, leasePolicyId);
}

/** Writes the partition mode of an Availability policy (D11, A7). The caller authorized the policy mutation. */
export async function setAvailabilityPartitionMode(
  db: DrizzleClient,
  policyId: string,
  partitionMode: DockerAvailabilityPartitionMode
): Promise<void> {
  const updated = await db
    .update(dockerAvailabilityPolicies)
    .set({ partitionMode, updatedAt: new Date() })
    .where(eq(dockerAvailabilityPolicies.id, policyId))
    .returning({ id: dockerAvailabilityPolicies.id });
  if (updated.length === 0) throw new AppError(404, 'AVAILABILITY_NOT_FOUND', 'Availability policy not found');
}

/** A19: sets an Availability policy's witness, or null for the automatic choice. */
export async function setAvailabilityWitness(
  db: DrizzleClient,
  policyId: string,
  witness: string | null
): Promise<void> {
  if (witness) await validateLeaseWitness(db, witness, { policyId });
  const updated = await db
    .update(dockerAvailabilityPolicies)
    .set({ witness, updatedAt: new Date() })
    .where(eq(dockerAvailabilityPolicies.id, policyId))
    .returning({ id: dockerAvailabilityPolicies.id });
  if (updated.length === 0) throw new AppError(404, 'AVAILABILITY_NOT_FOUND', 'Availability policy not found');
}

/** Holds an Availability policy on the legacy path (true) or releases it to the capability gate again (false). */
export async function setAvailabilityLegacyRequested(db: DrizzleClient, policyId: string, requested: boolean) {
  await ensureAvailabilityLeaseState(db, policyId);
  await db
    .update(dockerAvailabilityLeaseState)
    .set({ legacyRequested: requested, updatedAt: new Date() })
    .where(eq(dockerAvailabilityLeaseState.policyId, policyId));
}

/**
 * Replaces the bootstrap reservation of a lease policy that is still bootstrapping, with a new bootstrap_id (A5). Only
 * for the stuck state where a reserved holder died before it acquired and no holder was observed since.
 */
export async function reissueLeaseBootstrap(
  db: DrizzleClient,
  leasePolicyId: string,
  bootstrap: Array<{ slot: number; holderNodeId: string }>
): Promise<void> {
  const updated = await db
    .update(dockerAvailabilityLeaseState)
    .set({
      bootstrapId: randomInt(1, 2 ** 47),
      bootstrap: bootstrap.map((entry) => ({ slot: entry.slot, holderId: entry.holderNodeId })),
      copiesStoppedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dockerAvailabilityLeaseState.policyId, leasePolicyId),
        eq(dockerAvailabilityLeaseState.mode, 'bootstrapping')
      )
    )
    .returning({ policyId: dockerAvailabilityLeaseState.policyId });
  if (updated.length === 0) {
    throw new AppError(409, 'AVAILABILITY_LEASE_NOT_BOOTSTRAPPING', 'The policy is not waiting for a bootstrap holder');
  }
}

/**
 * D9: temporary extra lease slots for a replicated Availability rollout (surge). Failover policies have exactly one
 * slot and reject any surge.
 */
export async function setAvailabilitySurgeSlots(db: DrizzleClient, policyId: string, count: number): Promise<void> {
  const [policy] = await db
    .select({
      mode: dockerAvailabilityPolicies.mode,
      desiredReplicaCount: dockerAvailabilityPolicies.desiredReplicaCount,
      rolloutPolicy: dockerAvailabilityPolicies.rolloutPolicy,
    })
    .from(dockerAvailabilityPolicies)
    .where(eq(dockerAvailabilityPolicies.id, policyId))
    .limit(1);
  if (!policy) throw new AppError(404, 'AVAILABILITY_NOT_FOUND', 'Availability policy not found');
  if (!Number.isInteger(count) || count < 0) {
    throw new AppError(400, 'AVAILABILITY_LEASE_SURGE_INVALID', 'Surge slots must be a non-negative integer');
  }
  if (count > 0 && policy.mode !== 'replicated') {
    throw new AppError(409, 'AVAILABILITY_LEASE_SURGE_UNSUPPORTED', 'Only replicated policies can surge lease slots');
  }
  if (count > policy.rolloutPolicy.maxSurge || policy.desiredReplicaCount + count > 32) {
    throw new AppError(
      400,
      'AVAILABILITY_LEASE_SURGE_INVALID',
      'Surge slots exceed the rollout policy maxSurge or the 32 slot limit'
    );
  }
  await ensureAvailabilityLeaseState(db, policyId);
  await db
    .update(dockerAvailabilityLeaseState)
    .set({ surgeSlots: count, updatedAt: new Date() })
    .where(eq(dockerAvailabilityLeaseState.policyId, policyId));
}

/** Marks the next holder change of a key of any lease policy as planned, so it is audited as a handoff (D9). */
export async function registerPlannedLeaseHandoff(
  db: DrizzleClient,
  leasePolicyId: string,
  input: { slot: number; fromHolderId: string | null; toHolderId: string; operationId?: string | null; ttlMs?: number }
): Promise<void> {
  await db.transaction(async (tx) => {
    await ensureStateOf(tx, leasePolicyId);
    const [state] = await tx
      .select({ plannedHandoffs: dockerAvailabilityLeaseState.plannedHandoffs })
      .from(dockerAvailabilityLeaseState)
      .where(eq(dockerAvailabilityLeaseState.policyId, leasePolicyId))
      .for('update');
    const now = Date.now();
    const kept = (state?.plannedHandoffs ?? []).filter(
      (handoff) => Date.parse(handoff.expiresAt) > now && handoff.slot !== input.slot
    );
    kept.push({
      slot: input.slot,
      fromHolderId: input.fromHolderId,
      toHolderId: input.toHolderId,
      operationId: input.operationId ?? null,
      expiresAt: new Date(now + (input.ttlMs ?? PLANNED_HANDOFF_TTL_MS)).toISOString(),
    });
    await tx
      .update(dockerAvailabilityLeaseState)
      .set({ plannedHandoffs: kept, updatedAt: new Date() })
      .where(eq(dockerAvailabilityLeaseState.policyId, leasePolicyId));
  });
}
