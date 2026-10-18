import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CreateAlertRuleInput, UpdateAlertRuleInput } from './notification-alert-rule.schemas.js';
import type { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import { containerScopeByName } from './notification-container-scope.js';
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
 * A rule may send to a webhook only when its author may view that webhook (broadly, on the webhook or on its folder).
 * Webhooks the rule already sends to stay as they are, so editing a rule never needs access the author lacks.
 */
function assertWebhooksVisible(
  scopes: string[],
  webhookIds: readonly string[] | undefined,
  alreadyOnRule: unknown = []
) {
  if (!webhookIds) return;
  const kept = new Set(Array.isArray(alreadyOnRule) ? alreadyOnRule : []);
  const hidden = [...new Set(webhookIds)].filter(
    (id) => !kept.has(id) && !hasScopeForResource(scopes, 'notifications:webhooks:view', id)
  );
  if (hidden.length > 0) {
    throw new AppError(
      403,
      'FORBIDDEN',
      `Missing notifications:webhooks:view for webhook ${hidden.join(', ')}: a rule can send only to webhooks you can view`
    );
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
  if (input.category === 'container' && input.resourceIds.length > 0) {
    input = { ...input, resourceIds: await containerScopeByName(database(), input.resourceIds) };
  }
  await assertAlertRuleAccess(database, scopes, input);
  assertWebhooksVisible(scopes, input.webhookIds);
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
  if (previous.category === 'container' && input.resourceIds?.length) {
    input = { ...input, resourceIds: await containerScopeByName(database(), input.resourceIds) };
  }
  await assertAlertRuleAccess(database, scopes, { ...previous, ...input });
  assertWebhooksVisible(scopes, input.webhookIds, previous.webhookIds);
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
