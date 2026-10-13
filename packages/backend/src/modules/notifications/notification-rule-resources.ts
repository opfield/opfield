import { ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAvailabilityPolicies, relayInstances, relayPools } from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';

/** Categories whose resources have no list of their own to pick from in an alert rule. */
export const ALERT_RESOURCE_CATEGORIES = ['relay_pool', 'docker_availability'] as const;
export type AlertResourceCategory = (typeof ALERT_RESOURCE_CATEGORIES)[number];

/**
 * What a rule of these categories can be scoped to, for its author: relays and pools (the pool key is
 * `pool:<pool id>`), and Docker Availability workloads. Empty without the category's view.
 */
export async function listAlertCategoryResources(
  db: DrizzleClient,
  category: AlertResourceCategory,
  scopes: readonly string[]
): Promise<Array<{ id: string; label: string }>> {
  if (category === 'relay_pool') {
    if (!hasScope([...scopes], 'settings:opfield:view')) return [];
    const [pools, instances] = await Promise.all([
      db.select({ id: relayPools.id }).from(relayPools),
      db.select({ id: relayInstances.id, name: relayInstances.displayName }).from(relayInstances),
    ]);
    return [
      ...pools.map((pool) => ({
        id: `pool:${pool.id}`,
        label: pool.id === 'system' ? 'Relay pool' : `Relay pool ${pool.id}`,
      })),
      ...instances.map((instance) => ({ id: instance.id, label: instance.name })),
    ];
  }
  if (!hasScope([...scopes], 'docker:containers:view')) return [];
  const policies = await db
    .select({
      id: dockerAvailabilityPolicies.id,
      name: dockerAvailabilityPolicies.displayName,
      containerName: dockerAvailabilityPolicies.containerName,
      kind: dockerAvailabilityPolicies.resourceKind,
    })
    .from(dockerAvailabilityPolicies)
    .where(ne(dockerAvailabilityPolicies.mode, 'single'));
  return policies.map((policy) => ({
    id: policy.id,
    label: `${policy.name || policy.containerName || 'Workload'} · ${policy.kind}`,
  }));
}
