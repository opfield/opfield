import { eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { dockerAvailabilityPolicies, type LeasePolicyKind, leasePolicies } from '@/db/schema/index.js';

export type LeasePolicyRow = typeof leasePolicies.$inferSelect;

export interface LeasePolicyRegistration {
  leasePolicyId: string;
  kind: LeasePolicyKind;
  resourceId: string;
  stateful: boolean;
}

/** The owner column of a kind: deleting the resource deletes the lease policy and its state. */
function ownerColumns(registration: LeasePolicyRegistration) {
  switch (registration.kind) {
    case 'docker_availability':
      return { dockerAvailabilityPolicyId: registration.resourceId };
    case 'managed_availability_set':
      return { managedAvailabilitySetId: registration.resourceId };
  }
}

/** Why a registration conflicts with the registered row of the same id; null when it matches. */
export function leasePolicyRegistrationConflict(
  row: Pick<LeasePolicyRow, 'kind' | 'resourceId' | 'stateful'>,
  registration: LeasePolicyRegistration
): string | null {
  if (row.kind !== registration.kind) return `registered as ${row.kind}`;
  if (row.resourceId !== registration.resourceId) return 'registered for another resource';
  // A policy id never changes between stateless and stateful: acceptors keep per-key memory for stateful keys only.
  if (row.stateful !== registration.stateful)
    return row.stateful ? 'registered as stateful' : 'registered as stateless';
  return null;
}

/**
 * Registers lease policies (idempotent) and returns the registered rows of the given ids. A registration whose id is
 * already registered with another kind, resource or statefulness keeps the registered row; the caller compares.
 */
export async function registerLeasePolicies(
  db: DrizzleExecutor,
  registrations: LeasePolicyRegistration[]
): Promise<Map<string, LeasePolicyRow>> {
  if (registrations.length === 0) return new Map();
  const rowOf = (registration: LeasePolicyRegistration) => ({
    id: registration.leasePolicyId,
    kind: registration.kind,
    resourceId: registration.resourceId,
    stateful: registration.stateful,
    ...ownerColumns(registration),
  });
  try {
    await db.insert(leasePolicies).values(registrations.map(rowOf)).onConflictDoNothing();
  } catch {
    // One bad registration (its resource was just deleted) must not keep every other policy from being published:
    // register one by one and leave the failing ones unregistered (the caller skips them).
    for (const registration of registrations) {
      await db
        .insert(leasePolicies)
        .values(rowOf(registration))
        .onConflictDoNothing()
        .catch(() => undefined);
    }
  }
  const rows = await db
    .select()
    .from(leasePolicies)
    .where(
      inArray(
        leasePolicies.id,
        registrations.map((registration) => registration.leasePolicyId)
      )
    );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * An Availability policy is its own lease policy (same id), stateless. The migration registered the ones that existed
 * then; a later one is registered on first use. A no-op for registered ids and for ids that are no Availability policy.
 */
export async function registerAvailabilityLeasePolicy(db: DrizzleExecutor, policyId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${leasePolicies} (id, kind, resource_id, stateful, docker_availability_policy_id, created_at)
    SELECT ${dockerAvailabilityPolicies.id}, 'docker_availability', ${dockerAvailabilityPolicies.id}, false,
      ${dockerAvailabilityPolicies.id}, ${dockerAvailabilityPolicies.createdAt}
    FROM ${dockerAvailabilityPolicies}
    WHERE ${dockerAvailabilityPolicies.id} = ${policyId}
    ON CONFLICT (id) DO NOTHING`);
}

export async function loadLeasePolicy(db: DrizzleExecutor, leasePolicyId: string): Promise<LeasePolicyRow | null> {
  const [row] = await db.select().from(leasePolicies).where(eq(leasePolicies.id, leasePolicyId)).limit(1);
  return row ?? null;
}
