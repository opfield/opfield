import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CreateAlertRuleInput, UpdateAlertRuleInput } from './notification-alert-rule.schemas.js';
import type { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';
import { assertAlertRuleAccess } from './notification-rule-access.js';

const logger = createChildLogger('AlertRuleRoutes');

type RuleService = Pick<NotificationAlertRuleService, 'create' | 'update' | 'getById' | 'delete'>;

function database(): DrizzleClient {
  return container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
}

function invalidateCache() {
  try {
    container.resolve(NotificationEvaluatorService).invalidateRuleCache();
  } catch {
    /* not yet registered */
  }
}

/** Disabled, re-scoped or re-targeted rules must not leave firing states behind (they block later alerts). */
async function reconcileRuleStates(previous: unknown, next: unknown) {
  try {
    await container.resolve(NotificationEvaluatorService).reconcileRuleUpdate(previous, next);
  } catch (error) {
    // The periodic sweep retries; the rule update itself already succeeded.
    logger.warn('Failed to reconcile alert states after rule update', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function triggerCertificateExpiryEvaluation(rule: { category: string; type: string; metric: string | null }) {
  if (rule.category !== 'certificate' || rule.type !== 'threshold' || rule.metric !== 'days_until_expiry') return;
  try {
    const evaluator = container.resolve(NotificationEvaluatorService);
    void evaluator.evaluateCertificateExpiry().catch(() => {});
  } catch {
    /* not yet registered */
  }
}

function triggerMaintenanceEvaluation(rule: { category: string; type: string; eventPattern: string | null }) {
  if (rule.category !== 'proxy' || rule.type !== 'event' || rule.eventPattern !== 'maintenance.active') return;
  try {
    const evaluator = container.resolve(NotificationEvaluatorService);
    void evaluator.reconcileProxyMaintenance().catch(() => {});
  } catch {
    /* not yet registered */
  }
}

/**
 * Alert rule mutations shared by the alert rule routes and the AI tools:
 * hosting source access, the hosting evaluator barrier, firing-state
 * reconciliation, rule cache invalidation, and immediate re-evaluation.
 */
export async function createAlertRuleWithEffects(
  service: RuleService,
  input: CreateAlertRuleInput,
  scopes: string[],
  userId: string
) {
  await assertAlertRuleAccess(database, scopes, input);
  const rule = await service.create(input, userId);
  invalidateCache();
  triggerCertificateExpiryEvaluation(rule);
  triggerMaintenanceEvaluation(rule);
  return rule;
}

export async function updateAlertRuleWithEffects(
  service: RuleService,
  id: string,
  input: UpdateAlertRuleInput,
  scopes: string[],
  userId: string
) {
  const previous = await service.getById(id);
  await assertAlertRuleAccess(database, scopes, { ...previous, ...input });
  const update = () => service.update(id, input, userId);
  const hostingRule = previous.category === 'hosting_account' || previous.category === 'hosting_vm';
  const rule = hostingRule
    ? await container.resolve(NotificationEvaluatorService).updateHostingRule(previous, update)
    : await update();
  invalidateCache();
  if (!hostingRule) await reconcileRuleStates(previous, rule);
  triggerCertificateExpiryEvaluation(rule);
  triggerMaintenanceEvaluation(rule);
  return rule;
}

export async function deleteAlertRuleWithEffects(service: RuleService, id: string, userId: string) {
  await service.delete(id, userId);
  invalidateCache();
}
