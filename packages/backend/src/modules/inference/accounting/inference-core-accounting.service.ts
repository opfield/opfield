import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { injectable } from 'tsyringe';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import {
  type InferenceProtocol,
  inferenceModelSources,
  inferenceModels,
  inferencePricingSnapshots,
  inferenceProviderConnections,
  inferenceQuotaSnapshots,
  inferenceRequestAttempts,
  inferenceRequests,
  inferenceUsageLedger,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { QUOTA_READ_LIMIT } from '@/services/inference-usage-retention.js';
import type {
  InferenceCoreAdmissionRequest,
  InferenceCoreAdmissionResponse,
  InferenceCoreSettlement,
} from '../core/inference-core.contract.js';
import { CORE_ACCOUNT_METADATA_KEY } from '../core/inference-core-provider-map.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceUsage } from '../protocol/inference-protocol.types.js';
import { latestValidQuota, quotaAppliesToModel } from '../providers/inference-provider.service.helpers.js';
import {
  apiCostUnknown,
  capSubscriptionEstimateToBudget,
  capSubscriptionEstimateToCredits,
  errorCode,
  hash,
  hasSpendableSubscriptionBudget,
  latestPricingSnapshot,
  reservationAmounts,
  subscriptionBudgetRecoveryAt,
  tokenPricing,
  unitPriceKeyForOperation,
} from './inference-accounting.helpers.js';
import type { InferenceBudgetLockService } from './inference-budget-lock.service.js';
import {
  apiMicrodollars,
  type EffectiveInferenceLimits,
  type InferenceBudgetPolicyService,
  subscriptionCreditsForUsage,
} from './inference-budget-policy.js';
import type {
  BudgetReservationAmounts,
  InferenceBudgetReservationService,
} from './inference-budget-reservation.service.js';
import { modelPoolBurnMultiplier } from './inference-pool-budget.js';
import { assertProviderApiBudget } from './inference-provider-budget.js';
import { normalizeServiceTier, serviceTierCreditMultiplier } from './inference-service-tier.js';
import { publishInferenceUsageChanged } from './inference-usage-events.js';

type ConnectionRow = typeof inferenceProviderConnections.$inferSelect;
type SourceRow = typeof inferenceModelSources.$inferSelect;
type ModelRow = typeof inferenceModels.$inferSelect;

const deny = (
  reason: 'budget_exceeded' | 'rate_limited' | 'concurrency_limited' | 'model_disabled' | 'tenant_revoked',
  retryAfterSeconds?: number
): InferenceCoreAdmissionResponse => ({
  decision: 'deny',
  reason,
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

/** Maps a thrown budget rejection to an admission deny; anything else propagates as a 5xx callback failure. */
function budgetDeny(error: unknown): InferenceCoreAdmissionResponse | null {
  if (!(error instanceof InferenceProtocolError)) return null;
  if (error.code !== 'subscription_budget_exhausted' && error.code !== 'api_budget_exhausted') return null;
  const recoveryAt = (error.details as { recoveryAt?: unknown } | undefined)?.recoveryAt;
  const retryAfterSeconds =
    typeof recoveryAt === 'string'
      ? Math.max(0, Math.ceil((new Date(recoveryAt).getTime() - Date.now()) / 1000))
      : undefined;
  return deny('budget_exceeded', retryAfterSeconds);
}

function coreEstimateUsage(estimate: InferenceCoreAdmissionRequest['estimate']): InferenceUsage {
  return {
    inputTokens: estimate.inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: estimate.maxOutputTokens,
    reasoningTokens: 0,
    totalTokens: estimate.inputTokens + estimate.maxOutputTokens,
    estimated: true,
  };
}

function coreSettlementUsage(input: InferenceCoreSettlement['usage'], estimated: boolean): InferenceUsage {
  const inputTokens = input.uncachedInputTokens + input.cachedInputTokens + input.cacheWriteTokens;
  return {
    inputTokens,
    cachedInputTokens: input.cachedInputTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    outputTokens: input.outputTokens,
    reasoningTokens: input.reasoningTokens,
    totalTokens: inputTokens + input.outputTokens + input.reasoningTokens,
    estimated,
  };
}

/**
 * Opfield side of the wiolett-core/v1 admission/settlement contract (plan T5).
 * The managed core calls admission before every upstream dispatch — root,
 * retry, compaction, and subagent attempts alike — and settles each attempt
 * exactly once. Both callbacks are idempotent per core attempt id; ledger
 * writes happen inside the same user-locked transaction as the attempt row
 * update, so a redelivered settlement can never double-charge.
 */
@injectable()
export class InferenceCoreAccountingService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly policies: InferenceBudgetPolicyService,
    private readonly reservations: InferenceBudgetReservationService,
    private readonly locks: InferenceBudgetLockService,
    private readonly eventBus: EventBusService | undefined,
    private readonly redis: Redis
  ) {}

  /**
   * Ingress reservation row for a proxied request. The signed context the
   * core receives names this id as rootRequestId; admission correlates back
   * to it. Budget admission itself happens per attempt in admitCoreAttempt.
   */
  async createCoreRequest(input: {
    userId: string;
    tokenId: string | null;
    protocol: InferenceProtocol;
    operation: string;
    model: ModelRow;
    source: SourceRow;
    connection: ConnectionRow;
    serviceTier?: string | null;
    reasoningEffort?: string | null;
    idempotencyKey?: string;
    affinityKey?: string;
    /** Fixed per-call charge (images/search), added on top of metered tokens at settlement. */
    fixedApiMicrodollars?: number;
    isCompaction?: boolean;
  }): Promise<{ requestId: string }> {
    const idempotencyKeyHash = input.idempotencyKey ? hash(`${input.userId}:${input.idempotencyKey}`) : null;
    if (idempotencyKeyHash) {
      const existing = await this.db.query.inferenceRequests.findFirst({
        where: and(
          eq(inferenceRequests.userId, input.userId),
          eq(inferenceRequests.idempotencyKeyHash, idempotencyKeyHash)
        ),
      });
      if (existing) {
        throw new InferenceProtocolError(409, 'duplicate_request', 'This idempotent request was already admitted', {
          requestId: existing.id,
          status: existing.status,
        });
      }
    }
    const requestId = crypto.randomUUID();
    await this.db.insert(inferenceRequests).values({
      id: requestId,
      userId: input.userId,
      tokenId: input.tokenId,
      modelId: input.model.id,
      sourceId: input.source.id,
      connectionId: input.connection.id,
      idempotencyKeyHash,
      affinityKeyHash: input.affinityKey ? hash(input.affinityKey) : null,
      protocol: input.protocol,
      operation: input.operation.slice(0, 64),
      publicModelId: input.model.publicId,
      upstreamModelId: input.source.upstreamModelId,
      reasoningEffort: input.reasoningEffort ?? null,
      budgetType: input.source.sourceType,
      status: 'reserved',
      estimatedUsage: true,
      isCompaction: input.isCompaction === true,
      serviceTier: input.serviceTier ?? null,
      fixedApiMicrodollars: input.fixedApiMicrodollars ?? 0,
    });
    return { requestId };
  }

  /**
   * Authorize the next Opfield-selected route for the same logical request.
   * Called only after a pre-output failure; the next signed context pins this
   * row before the core can admit the new attempt.
   */
  async retargetCoreRequest(
    requestId: string,
    source: SourceRow,
    connection: ConnectionRow,
    fixedApiMicrodollars = 0
  ): Promise<void> {
    const [updated] = await this.db
      .update(inferenceRequests)
      .set({
        sourceId: source.id,
        connectionId: connection.id,
        upstreamModelId: source.upstreamModelId,
        budgetType: source.sourceType,
        fixedApiMicrodollars,
      })
      .where(and(eq(inferenceRequests.id, requestId), inArray(inferenceRequests.status, ['reserved', 'running'])))
      .returning({ id: inferenceRequests.id });
    if (!updated) throw new AppError(409, 'core_request_finalized', 'The root request is already finalized');
  }

  async admitCoreAttempt(input: InferenceCoreAdmissionRequest): Promise<InferenceCoreAdmissionResponse> {
    const request = await this.db.query.inferenceRequests.findFirst({
      where: eq(inferenceRequests.id, input.rootRequestId),
    });
    if (!request) throw new AppError(404, 'core_request_not_found', 'The root request is unknown to Opfield');
    if (!request.userId) throw new AppError(409, 'core_request_incomplete', 'The request has no owning tenant');
    const userId = request.userId;
    return this.locks.withUserLock(userId, async (database) => {
      // Redelivery of an already-admitted attempt acknowledges without side effects.
      const existing = await database.query.inferenceRequestAttempts.findFirst({
        where: eq(inferenceRequestAttempts.coreAttemptId, input.attemptId),
      });
      if (existing) {
        if (existing.requestId !== request.id) {
          throw new AppError(409, 'core_attempt_conflict', 'The attempt belongs to another root request');
        }
        if (
          existing.attemptKind !== input.attemptKind ||
          (existing.parentCoreAttemptId ?? null) !== input.parentAttemptId
        ) {
          throw new AppError(409, 'core_attempt_conflict', 'The admission payload differs from the recorded attempt');
        }
        const existingSource = existing.sourceId
          ? await database.query.inferenceModelSources.findFirst({
              where: eq(inferenceModelSources.id, existing.sourceId),
            })
          : null;
        const existingConnection = existing.connectionId
          ? await database.query.inferenceProviderConnections.findFirst({
              where: eq(inferenceProviderConnections.id, existing.connectionId),
            })
          : null;
        if (!existingSource || !existingConnection) {
          throw new AppError(409, 'core_attempt_source_missing', 'The admitted attempt route is no longer available');
        }
        assertPinnedRoute(input, existingSource, existingConnection);
        return {
          decision: 'allow' as const,
          // Redelivery replays the cap granted by the first admission.
          ...(existing.admittedMaxOutputTokens !== null && existing.admittedMaxOutputTokens !== undefined
            ? { maxOutputTokens: existing.admittedMaxOutputTokens }
            : {}),
        };
      }

      const limits = await this.policies.effective(userId, database);
      if (!limits.enabled) return deny('tenant_revoked');
      const modelId = request.modelId;
      const sourceId = request.sourceId;
      const connectionId = request.connectionId;
      if (!modelId || !sourceId || !connectionId) {
        throw new AppError(409, 'core_request_source_missing', 'The request source binding is no longer available');
      }
      const model = await database.query.inferenceModels.findFirst({
        where: eq(inferenceModels.id, modelId),
      });
      if (!model?.enabled) return deny('model_disabled');
      const source = await database.query.inferenceModelSources.findFirst({
        where: eq(inferenceModelSources.id, sourceId),
      });
      const connection = await database.query.inferenceProviderConnections.findFirst({
        where: eq(inferenceProviderConnections.id, connectionId),
      });
      if (!source || !connection) {
        throw new AppError(409, 'core_request_source_missing', 'The request source binding is no longer available');
      }
      if (!model.enabled || !source.enabled || !connection.enabled || connection.deletedAt) {
        return deny('model_disabled');
      }
      if (!(await this.connectionAllowsNewAttempt(database, connection, source.upstreamModelId))) {
        return deny('model_disabled');
      }

      assertPinnedRoute(input, source, connection);

      return this.admitAttempt(database, input, request, userId, model, source, connection, limits);
    });
  }

  private async connectionAllowsNewAttempt(
    database: DrizzleTransaction,
    connection: ConnectionRow,
    upstreamModelId: string
  ): Promise<boolean> {
    // Redis is authoritative for cooldown lifetime. Check it regardless of the
    // denormalized DB status so admission cannot race markCooldown's two writes,
    // and treat an expired persisted cooldown exactly as routing does.
    const cooldownActive = Boolean(await this.redis.exists(`inference:provider-cooldown:${connection.id}`));
    if (cooldownActive) return false;
    const connectionStatus = connection.status === 'cooldown' ? 'healthy' : connection.status;
    if (['disabled', 'reauth_required'].includes(connectionStatus)) return false;
    // A reasoned unavailable state is a hard provider/auth barrier. Quota
    // availability is derived below from the same current snapshots as routing,
    // rather than trusting a possibly lagging denormalized status.
    if (connectionStatus === 'unavailable' && connection.healthReason !== null) return false;
    const quotas = await database.query.inferenceQuotaSnapshots.findMany({
      where: and(eq(inferenceQuotaSnapshots.connectionId, connection.id), eq(inferenceQuotaSnapshots.status, 'fresh')),
      orderBy: [desc(inferenceQuotaSnapshots.fetchedAt)],
      limit: QUOTA_READ_LIMIT,
    });
    const minimumRemainingFraction = Number(connection.minimumRemainingPercent ?? 1) / 100;
    const exhausted = latestValidQuota(quotas).some(
      (quota) =>
        quotaAppliesToModel(quota, upstreamModelId) &&
        quota.remainingFraction !== null &&
        quota.remainingFraction !== undefined &&
        Number(quota.remainingFraction) <= minimumRemainingFraction
    );
    if (exhausted) return false;
    // A reason-less unavailable state with quota history becomes stale/usable
    // once the latest reading expires or resets. With no history, routing keeps
    // it unavailable because there is no basis for recovery.
    return connectionStatus !== 'unavailable' || quotas.length > 0;
  }

  private async admitAttempt(
    database: DrizzleTransaction,
    input: InferenceCoreAdmissionRequest,
    request: typeof inferenceRequests.$inferSelect,
    userId: string,
    model: ModelRow,
    source: SourceRow,
    connection: ConnectionRow,
    limits: EffectiveInferenceLimits
  ): Promise<InferenceCoreAdmissionResponse> {
    // Use one Opfield admission timestamp for both the window and its ledger
    // entry. The core's earlier callback timestamp can precede a new window.
    const admittedAt = new Date();
    const usage = await this.policies.usage(userId, limits, admittedAt, database, {
      startSubscriptionWindows: source.sourceType === 'subscription',
    });
    const pricingSnapshot = source.sourceType === 'api' ? await latestPricingSnapshot(database, source.id) : null;
    const pricing = tokenPricing(pricingSnapshot);
    // An API source without a price still serves the request: tokens are recorded, the cost is unknown,
    // and the attempt stays outside API budget enforcement (it reserves and is charged nothing).
    const costUnknown = source.sourceType === 'api' && apiCostUnknown(pricingSnapshot, request.operation);
    const burnMultiplier =
      source.sourceType === 'subscription'
        ? await modelPoolBurnMultiplier(database, model.id, admittedAt, request.isCompaction)
        : 1;
    const modelMultiplier = Number(source.subscriptionMultiplierOverride ?? model.subscriptionMultiplier);
    const serviceTier = normalizeServiceTier(request.serviceTier);
    const serviceTierMultiplier = serviceTierCreditMultiplier(source.sourceType, connection.providerId, serviceTier);
    const conservativeUsage = coreEstimateUsage(input.estimate);
    // A turn admitted with a positive balance always runs to completion: admission never
    // truncates its output, and the turn may settle past the window. Only the reservation
    // is bounded by the live tail, so parallel turns cannot stack past the limit. A
    // truncated turn is worse than a small overage: the harness retries it several times
    // and every retry is billed.
    if (source.sourceType === 'subscription' && !hasSpendableSubscriptionBudget(limits, usage)) {
      const recoveryAt = subscriptionBudgetRecoveryAt(limits, usage);
      return deny(
        'budget_exceeded',
        recoveryAt ? Math.max(0, Math.ceil((recoveryAt.getTime() - admittedAt.getTime()) / 1000)) : undefined
      );
    }
    let estimatedUsage =
      source.sourceType === 'subscription'
        ? (capSubscriptionEstimateToBudget({
            estimate: conservativeUsage,
            limits,
            usage,
            modelMultiplier,
            burnMultiplier,
            serviceTierMultiplier,
            isCompaction: request.isCompaction,
          }) ?? conservativeUsage)
        : conservativeUsage;
    // Kept for replaying caps persisted by releases that still truncated turns.
    const admittedMaxOutputTokens: number | null = null;
    const fixedApiMicrodollars = costUnknown ? 0 : Number(request.fixedApiMicrodollars ?? 0);
    let amounts = reservationAmounts(
      source.sourceType,
      estimatedUsage,
      modelMultiplier,
      burnMultiplier,
      serviceTierMultiplier,
      pricing,
      fixedApiMicrodollars
    );
    try {
      if (source.sourceType === 'api' && !costUnknown && connection.apiMonthlyLimitMicrodollars !== null) {
        await this.locks.lockProviderConnection(database, connection.id);
        await assertProviderApiBudget(database, connection, amounts.apiMonthlyMicrodollars);
      }
      const reservationId = `${request.id}:${input.attemptId}`;
      const reservation = await this.reservations.reserve({
        reservationId,
        userId,
        amounts,
        usage,
        limits,
        isCompaction: request.isCompaction,
        ...(costUnknown ? { apiBudgetExempt: true } : {}),
      });
      if (source.sourceType === 'subscription') {
        const committedUsage = capSubscriptionEstimateToCredits({
          estimate: conservativeUsage,
          maximumCredits: subscriptionReservationAllowance(limits, reservation.admittedAmounts),
          modelMultiplier,
          burnMultiplier,
          serviceTierMultiplier,
        });
        // The tail may not even cover the input estimate; the turn still runs, and the
        // admitted reservation stays the recorded estimate until settlement.
        if (committedUsage) {
          estimatedUsage = committedUsage;
          amounts = reservationAmounts(
            source.sourceType,
            committedUsage,
            modelMultiplier,
            burnMultiplier,
            serviceTierMultiplier,
            pricing,
            fixedApiMicrodollars
          );
        }
      }
    } catch (error) {
      const denied = budgetDeny(error);
      if (denied) return denied;
      throw error;
    }
    try {
      // Claim the request first: a late admission retry that arrives after
      // finalization must not leave an orphaned reservation/attempt pair.
      const claimed = await database
        .update(inferenceRequests)
        .set({
          status: 'running',
          startedAt: admittedAt,
          errorCode: null,
          completedAt: null,
          sourceId: source.id,
          connectionId: connection.id,
          upstreamModelId: source.upstreamModelId,
          budgetType: source.sourceType,
          pricingSnapshotId: pricing?.id ?? null,
          priceVersion: pricing?.version ?? null,
          costUnknown,
          modelMultiplier: String(modelMultiplier),
          burnMultiplier: String(burnMultiplier),
          serviceTierMultiplier: String(serviceTierMultiplier),
          creditsCharged: String(amounts.credits5h),
          // Request charge fields are settled aggregates. Attempt-specific
          // admission estimates live on the attempt row below.
          uncachedInputTokens: estimatedUsage.inputTokens,
          cachedInputTokens: estimatedUsage.cachedInputTokens,
          cacheWriteTokens: estimatedUsage.cacheWriteTokens,
          outputTokens: estimatedUsage.outputTokens,
          reasoningTokens: estimatedUsage.reasoningTokens,
        })
        .where(and(eq(inferenceRequests.id, request.id), inArray(inferenceRequests.status, ['reserved', 'running'])))
        .returning({ id: inferenceRequests.id });
      if (!claimed.length) {
        throw new AppError(409, 'core_request_finalized', 'The root request is already finalized');
      }
      const siblings = await database
        .select({ id: inferenceRequestAttempts.id })
        .from(inferenceRequestAttempts)
        .where(eq(inferenceRequestAttempts.requestId, request.id));
      const reservationId = `${request.id}:${input.attemptId}`;
      await database.insert(inferenceRequestAttempts).values({
        requestId: request.id,
        sequence: siblings.length + 1,
        sourceId: source.id,
        connectionId: connection.id,
        status: 'running',
        coreAttemptId: input.attemptId,
        attemptKind: input.attemptKind,
        parentCoreAttemptId: input.parentAttemptId,
        admittedMaxOutputTokens,
        budgetType: source.sourceType,
        pricingSnapshotId: pricing?.id ?? null,
        priceVersion: pricing?.version ?? null,
        modelMultiplier: String(modelMultiplier),
        burnMultiplier: String(burnMultiplier),
        serviceTierMultiplier: String(serviceTierMultiplier),
        fixedApiMicrodollars,
        reservedApiMicrodollars: amounts.apiMonthlyMicrodollars,
        costUnknown,
        reservationId,
        startedAt: admittedAt,
      });
    } catch (error) {
      await this.reservations.release({ id: `${request.id}:${input.attemptId}`, userId });
      throw error;
    }
    return {
      decision: 'allow',
      ...(admittedMaxOutputTokens !== null ? { maxOutputTokens: admittedMaxOutputTokens } : {}),
    };
  }

  async settleCoreAttempt(input: InferenceCoreSettlement): Promise<void> {
    const request = await this.db.query.inferenceRequests.findFirst({
      where: eq(inferenceRequests.id, input.rootRequestId),
    });
    if (!request) throw new AppError(404, 'core_request_not_found', 'The root request is unknown to Opfield');
    if (!request.userId) throw new AppError(409, 'core_request_incomplete', 'The request has no owning tenant');
    const userId = request.userId;
    const settled = await this.locks.withUserLock(userId, async (database) => {
      const attempt = await database.query.inferenceRequestAttempts.findFirst({
        where: eq(inferenceRequestAttempts.coreAttemptId, input.attemptId),
      });
      if (!attempt) throw new AppError(404, 'core_attempt_not_found', 'The attempt is unknown to Opfield');
      if (attempt.requestId !== request.id) {
        throw new AppError(
          409,
          'core_attempt_root_mismatch',
          'The attempt does not belong to the supplied root request'
        );
      }
      if (
        attempt.attemptKind !== input.attemptKind ||
        (attempt.parentCoreAttemptId ?? null) !== input.parentAttemptId
      ) {
        throw new AppError(409, 'core_attempt_lineage_mismatch', 'The settlement lineage differs from admission');
      }
      const attemptSource = attempt.sourceId
        ? await database.query.inferenceModelSources.findFirst({
            where: eq(inferenceModelSources.id, attempt.sourceId),
          })
        : null;
      const attemptConnection = attempt.connectionId
        ? await database.query.inferenceProviderConnections.findFirst({
            where: eq(inferenceProviderConnections.id, attempt.connectionId),
          })
        : null;
      if (!attemptSource || !attemptConnection) {
        throw new AppError(409, 'core_attempt_source_missing', 'The admitted attempt route is no longer available');
      }
      assertPinnedRoute(input, attemptSource, attemptConnection);
      if (attempt.status !== 'pending' && attempt.status !== 'running') {
        // Idempotent redelivery must carry an identical payload (contract).
        const identical =
          attempt.status === input.terminalStatus &&
          (attempt.upstreamStatus ?? null) === input.upstreamStatus &&
          (attempt.errorCode ?? null) === input.errorCode &&
          attempt.emittedOutput === input.emittedOutput &&
          (attempt.usageEstimated === null ||
            attempt.usageEstimated === undefined ||
            attempt.usageEstimated === input.usageEstimated) &&
          attempt.outputTokens === input.usage.outputTokens &&
          attempt.uncachedInputTokens === input.usage.uncachedInputTokens &&
          attempt.cachedInputTokens === input.usage.cachedInputTokens &&
          attempt.cacheWriteTokens === input.usage.cacheWriteTokens &&
          attempt.reasoningTokens === input.usage.reasoningTokens;
        if (!identical) {
          throw new AppError(409, 'core_settlement_conflict', 'Settlement payload differs from the recorded one');
        }
        return false;
      }
      const usage = coreSettlementUsage(input.usage, input.usageEstimated);
      const pricing = attempt.pricingSnapshotId
        ? await database.query.inferencePricingSnapshots.findFirst({
            where: eq(inferencePricingSnapshots.id, attempt.pricingSnapshotId),
          })
        : null;
      const budgetType = attempt.budgetType;
      if (!budgetType) throw new AppError(409, 'core_request_incomplete', 'The request was never admitted');
      const fixedApiMicrodollars = budgetType === 'api' ? Number(attempt.fixedApiMicrodollars ?? 0) : 0;
      // Unknown when admitted without a price, or when the token price it was admitted with is gone.
      const costUnknown =
        budgetType === 'api' &&
        (attempt.costUnknown || (!pricing && unitPriceKeyForOperation(request.operation) === undefined));
      const credits =
        budgetType === 'subscription'
          ? subscriptionCreditsForUsage(
              usage,
              Number(attempt.modelMultiplier ?? 1),
              Number(attempt.burnMultiplier ?? 1),
              Number(attempt.serviceTierMultiplier ?? 1)
            )
          : 0;
      const tokenCost =
        budgetType === 'api' && pricing && tokenPricing(pricing) && usage.totalTokens > 0
          ? apiMicrodollars(usage, pricing)
          : 0;
      const cost = costUnknown ? 0 : fixedApiMicrodollars + tokenCost;
      const latencyMs = Math.max(0, new Date(input.completedAt).getTime() - new Date(input.startedAt).getTime());
      await database
        .update(inferenceRequestAttempts)
        .set({
          status: input.terminalStatus,
          emittedOutput: input.emittedOutput,
          upstreamStatus: input.upstreamStatus,
          errorCode: input.errorCode,
          usageEstimated: input.usageEstimated,
          uncachedInputTokens: input.usage.uncachedInputTokens,
          cachedInputTokens: input.usage.cachedInputTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          outputTokens: input.usage.outputTokens,
          reasoningTokens: input.usage.reasoningTokens,
          costUnknown,
          latencyMs,
          completedAt: new Date(input.completedAt),
        })
        .where(eq(inferenceRequestAttempts.id, attempt.id));
      // Charge completed work and anything that reached the client; silent
      // failures release without a ledger effect, matching the legacy engine.
      if (input.terminalStatus === 'completed' || input.emittedOutput) {
        await database.insert(inferenceUsageLedger).values({
          requestId: request.id,
          attemptId: attempt.id,
          userId,
          entryType: 'settlement',
          budgetType,
          credits: String(credits),
          apiMicrodollars: cost,
          costUnknown,
          uncachedInputTokens: input.usage.uncachedInputTokens,
          cachedInputTokens: input.usage.cachedInputTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          outputTokens: input.usage.outputTokens,
          reasoningTokens: input.usage.reasoningTokens,
          reason: input.usageEstimated ? 'estimated_terminal_usage' : 'upstream_terminal_usage',
          occurredAt: attempt.startedAt,
          snapshot: {
            priceVersion: attempt.priceVersion ?? null,
            serviceTier: request.serviceTier ?? null,
            modelMultiplier: Number(attempt.modelMultiplier ?? 1),
            burnMultiplier: Number(attempt.burnMultiplier ?? 1),
            serviceTierMultiplier: Number(attempt.serviceTierMultiplier ?? 1),
            sourceId: attempt.sourceId,
            connectionId: attempt.connectionId,
            coreAttemptId: input.attemptId,
            attemptKind: input.attemptKind,
            ...(costUnknown ? { priceMissing: true } : {}),
          },
        });
      }
      await this.refreshRequestAggregates(database, request.id);
      // The proxy can observe a clean HTTP stream close just after Core has
      // settled the top-level attempt as failed. Never let that transport-level
      // completion leave the request recorded as successful. A completed
      // sibling top-level attempt still wins for legitimate provider failover.
      if (input.parentAttemptId === null && input.terminalStatus !== 'completed') {
        const completedTopLevelAttempt = await database.query.inferenceRequestAttempts.findFirst({
          where: and(
            eq(inferenceRequestAttempts.requestId, request.id),
            isNull(inferenceRequestAttempts.parentCoreAttemptId),
            eq(inferenceRequestAttempts.status, 'completed'),
            ne(inferenceRequestAttempts.id, attempt.id)
          ),
        });
        if (!completedTopLevelAttempt) {
          await database
            .update(inferenceRequests)
            .set({
              status: input.terminalStatus,
              errorCode: input.terminalStatus === 'failed' ? (input.errorCode ?? 'upstream_error') : 'client_cancelled',
            })
            .where(
              and(
                eq(inferenceRequests.id, request.id),
                // A client cancellation is authoritative: a later upstream
                // failure must not rewrite it as a provider failure.
                inArray(inferenceRequests.status, ['completed', 'failed'])
              )
            );
        }
      }
      return { reservationId: attempt.reservationId, settled: true };
    });
    if (settled && typeof settled === 'object' && settled.reservationId) {
      await this.reservations.release({ id: settled.reservationId, userId });
    }
    if (settled && typeof settled === 'object' && settled.settled) {
      publishInferenceUsageChanged(this.eventBus, { targetUserId: userId, reason: 'settlement' });
    }
  }

  /**
   * Forget an attempt that will never settle and free its reservation: an
   * attempt Opfield admitted itself for a request it then moved to another
   * route, or one the core admitted on its own.
   */
  async dropUnsettledAttempt(rootRequestId: string, attemptId: string): Promise<void> {
    const request = await this.db.query.inferenceRequests.findFirst({
      where: eq(inferenceRequests.id, rootRequestId),
    });
    if (!request?.userId) return;
    const userId = request.userId;
    const reservationId = await this.locks.withUserLock(userId, async (database) => {
      const [dropped] = await database
        .delete(inferenceRequestAttempts)
        .where(
          and(
            eq(inferenceRequestAttempts.requestId, rootRequestId),
            eq(inferenceRequestAttempts.coreAttemptId, attemptId),
            inArray(inferenceRequestAttempts.status, ['pending', 'running'])
          )
        )
        .returning({ reservationId: inferenceRequestAttempts.reservationId });
      return dropped?.reservationId ?? null;
    });
    if (reservationId) await this.reservations.release({ id: reservationId, userId });
  }

  /**
   * Terminal request state from the proxy's point of view: the proxied
   * response ended, errored, or the client went away. Attempt-level accounting
   * arrives independently: unsettled reservations must remain held until the
   * ledger commits (or the bounded abandoned-reservation TTL expires).
   */
  async finalizeCoreRequest(
    requestId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    error?: unknown
  ): Promise<void> {
    const request = await this.db.query.inferenceRequests.findFirst({
      where: eq(inferenceRequests.id, requestId),
    });
    if (!request?.userId) return;
    const userId = request.userId;
    await this.locks.withUserLock(userId, async (database) => {
      const priorAttempts = await database.query.inferenceRequestAttempts.findMany({
        where: eq(inferenceRequestAttempts.requestId, requestId),
      });
      const topLevelAttempts = priorAttempts.filter((attempt) => attempt.parentCoreAttemptId === null);
      const completedAttempt = topLevelAttempts.find((attempt) => attempt.status === 'completed');
      const failedAttempt = topLevelAttempts.find((attempt) => attempt.status === 'failed');
      const cancelledAttempt = topLevelAttempts.find((attempt) => attempt.status === 'cancelled');
      const effectiveOutcome =
        outcome === 'completed' && !completedAttempt
          ? failedAttempt
            ? 'failed'
            : cancelledAttempt
              ? 'cancelled'
              : outcome
          : outcome;
      const [claimed] = await database
        .update(inferenceRequests)
        .set({
          status: effectiveOutcome,
          errorCode:
            effectiveOutcome === 'failed'
              ? (failedAttempt?.errorCode ?? errorCode(error))
              : effectiveOutcome === 'cancelled'
                ? 'client_cancelled'
                : null,
          // A failure before core admission did not contact a provider and may
          // be retried safely with the same client idempotency key.
          ...(effectiveOutcome !== 'completed' && priorAttempts.length === 0 ? { idempotencyKeyHash: null } : {}),
          completedAt: new Date(),
        })
        .where(and(eq(inferenceRequests.id, requestId), inArray(inferenceRequests.status, ['reserved', 'running'])))
        .returning({ id: inferenceRequests.id });
      if (!claimed) return;
      await this.refreshRequestAggregates(database, requestId);
      const attempts = priorAttempts.filter((attempt) => attempt.status === 'pending' || attempt.status === 'running');
      for (const attempt of attempts) {
        if (attempt.reservationId) this.reservations.awaitSettlement({ id: attempt.reservationId, userId });
      }
      // Compatibility with reservations created before attempt-scoped ids.
      if (attempts.length > 0) this.reservations.awaitSettlement({ id: requestId, userId });
      else await this.reservations.release({ id: requestId, userId });
    });
  }

  /** Request row totals track the sum of settled attempts and ledger charges. */
  private async refreshRequestAggregates(database: DrizzleTransaction, requestId: string): Promise<void> {
    const [attemptTotals] = await database
      .select({
        uncachedInputTokens: sql<number>`coalesce(sum(${inferenceRequestAttempts.uncachedInputTokens}), 0)`,
        cachedInputTokens: sql<number>`coalesce(sum(${inferenceRequestAttempts.cachedInputTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${inferenceRequestAttempts.cacheWriteTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${inferenceRequestAttempts.outputTokens}), 0)`,
        reasoningTokens: sql<number>`coalesce(sum(${inferenceRequestAttempts.reasoningTokens}), 0)`,
        // Every attempt, settled or not: a running unpriced attempt marks the request until its settlement arrives.
        costUnknown: sql<boolean>`coalesce((SELECT bool_or(pending.cost_unknown) FROM ${inferenceRequestAttempts} pending WHERE pending.request_id = ${requestId}), false)`,
      })
      .from(inferenceRequestAttempts)
      .where(
        and(
          eq(inferenceRequestAttempts.requestId, requestId),
          inArray(inferenceRequestAttempts.status, ['completed', 'failed', 'cancelled'])
        )
      );
    const [chargeTotals] = await database
      .select({
        credits: sql<string>`coalesce(sum(${inferenceUsageLedger.credits}::numeric), 0)::text`,
        apiMicrodollars: sql<number>`coalesce(sum(${inferenceUsageLedger.apiMicrodollars}), 0)`,
        estimatedUsage: sql<boolean>`coalesce(bool_or(${inferenceUsageLedger.reason} = 'estimated_terminal_usage'), false)`,
        costUnknown: sql<boolean>`coalesce(bool_or(${inferenceUsageLedger.costUnknown}), false)`,
        settlements: sql<number>`count(*)::int`,
      })
      .from(inferenceUsageLedger)
      .where(and(eq(inferenceUsageLedger.requestId, requestId), eq(inferenceUsageLedger.entryType, 'settlement')));
    await database
      .update(inferenceRequests)
      .set({
        uncachedInputTokens: Number(attemptTotals?.uncachedInputTokens ?? 0),
        cachedInputTokens: Number(attemptTotals?.cachedInputTokens ?? 0),
        cacheWriteTokens: Number(attemptTotals?.cacheWriteTokens ?? 0),
        outputTokens: Number(attemptTotals?.outputTokens ?? 0),
        reasoningTokens: Number(attemptTotals?.reasoningTokens ?? 0),
        creditsCharged: String(chargeTotals?.credits ?? '0'),
        apiMicrodollarsCharged: Number(chargeTotals?.apiMicrodollars ?? 0),
        estimatedUsage: Boolean(chargeTotals?.estimatedUsage),
        // Charged work decides; with nothing charged yet, an unpriced attempt still marks the request.
        costUnknown:
          Number(chargeTotals?.settlements ?? 0) > 0
            ? Boolean(chargeTotals?.costUnknown)
            : Boolean(attemptTotals?.costUnknown),
      })
      .where(eq(inferenceRequests.id, requestId));
  }
}

function subscriptionReservationAllowance(limits: EffectiveInferenceLimits, amounts: BudgetReservationAmounts): number {
  const admitted = [
    limits.credits5hEnabled ? amounts.credits5h : null,
    limits.credits7dEnabled ? amounts.credits7d : null,
    limits.credits30dEnabled ? amounts.credits30d : null,
  ].filter((amount): amount is number => amount !== null);
  return admitted.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...admitted);
}

function assertPinnedRoute(
  input: Pick<InferenceCoreAdmissionRequest, 'coreAccountId' | 'coreModelId' | 'sourceType'>,
  source: SourceRow,
  connection: ConnectionRow
): void {
  const metadataAccountId = connection.metadata?.[CORE_ACCOUNT_METADATA_KEY];
  const expectedAccountId =
    connection.authType === 'oauth' && typeof metadataAccountId === 'string' && metadataAccountId
      ? metadataAccountId
      : source.coreAccountId;
  // Authentication mode is not a billing authority: API keys may represent
  // subscription plans (for example Alibaba Token Plan). The persisted source
  // owns accounting classification; the core only has to preserve the exact
  // Opfield-selected account and model route.
  if (!expectedAccountId || input.coreAccountId !== expectedAccountId || input.coreModelId !== source.coreModelId) {
    throw new AppError(409, 'core_route_mismatch', 'The core attempted a route not selected by Opfield');
  }
}
