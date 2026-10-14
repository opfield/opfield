import { and, eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceLimitPolicies } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { publishInferenceUsageChanged } from '@/modules/inference/accounting/inference-usage-events.js';
import { EventBusService } from '@/services/event-bus.service.js';

const logger = createChildLogger('CloudInference');

/** The tier price an older account does not send (the smallest Opfield Cloud AI tier). */
const DEFAULT_TIER_MONTHLY_USD = 10;

/**
 * Opfield Cloud AI models are API-priced, and a default per-user API budget of 0 hides API-priced models from
 * everyone. When the add-on becomes ready, a default budget of 0 (or no default limits at all) becomes the tier's
 * monthly price. A budget an administrator set is never lowered or replaced; per-user limits are not touched.
 */
export async function ensureCloudDefaultApiBudget(
  db: DrizzleClient,
  adminId: string,
  tierMonthlyUsd: number | null | undefined
): Promise<void> {
  const usd = typeof tierMonthlyUsd === 'number' && tierMonthlyUsd > 0 ? tierMonthlyUsd : DEFAULT_TIER_MONTHLY_USD;
  const apiMonthlyMicrodollars = Math.round(usd * 1_000_000);
  const [raised] = await db
    .update(inferenceLimitPolicies)
    .set({ apiMonthlyMicrodollars, updatedAt: new Date() })
    .where(and(eq(inferenceLimitPolicies.policyType, 'default'), eq(inferenceLimitPolicies.apiMonthlyMicrodollars, 0)))
    .returning({ id: inferenceLimitPolicies.id });
  let changed: { id: string; created: boolean } | null = raised ? { id: raised.id, created: false } : null;
  if (!changed) {
    // No default limits yet: the ones the guided setup creates (inference on, no subscription windows) with the budget.
    const [created] = await db
      .insert(inferenceLimitPolicies)
      .values({
        policyType: 'default',
        userId: null,
        enabled: true,
        credits5hEnabled: false,
        credits5h: '0',
        credits7dEnabled: false,
        credits7d: '0',
        credits30dEnabled: false,
        credits30d: '0',
        apiMonthlyMicrodollars,
        billingTimezone: 'UTC',
        createdBy: adminId,
      })
      .onConflictDoNothing()
      .returning({ id: inferenceLimitPolicies.id });
    changed = created ? { id: created.id, created: true } : null;
  }
  if (!changed) return;
  await container.resolve(AuditService).log({
    userId: adminId,
    action: 'inference.limit.update',
    resourceType: 'inference_limit_policy',
    resourceId: changed.id,
    details: {
      reason: 'Opfield Cloud AI',
      apiMonthlyMicrodollars,
      previousApiMonthlyMicrodollars: changed.created ? null : 0,
    },
  });
  publishInferenceUsageChanged(container.resolve(EventBusService), { targetUserId: null, reason: 'limits' });
  logger.info('Opfield Cloud AI set the default monthly API budget', { usd, created: changed.created });
}
