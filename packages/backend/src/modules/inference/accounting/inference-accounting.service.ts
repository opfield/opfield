import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { injectable } from 'tsyringe';
import type { InferenceModel, InferenceModelSource } from '@/db/schema/index.js';
import {
  type inferencePricingSnapshots,
  type inferenceProviderConnections,
  inferenceRequestAttempts,
  inferenceRequests,
  inferenceUsageLedger,
} from '@/db/schema/index.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { logInferenceFailure, logInferenceSettlement } from '../inference-observability.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceRequest, InferenceUsage } from '../protocol/inference-protocol.types.js';
import {
  capSubscriptionEstimateToBudget,
  capSubscriptionEstimateToCredits,
  conservativeEstimate,
  errorCode,
  hash,
  latestPricingSnapshot,
  reservationAmounts,
  stringExtension,
  tokenPricing,
  unitCharge,
  zeroUsage,
} from './inference-accounting.helpers.js';
import type { InferenceBudgetLockService } from './inference-budget-lock.service.js';
import {
  apiMicrodollars,
  type EffectiveInferenceLimits,
  type InferenceBudgetPolicyService,
  subscriptionCreditsForUsage,
} from './inference-budget-policy.js';
import type {
  BudgetReservation,
  BudgetReservationAmounts,
  InferenceBudgetReservationService,
} from './inference-budget-reservation.service.js';
import { modelPoolBurnMultiplier } from './inference-pool-budget.js';
import { assertProviderApiBudget } from './inference-provider-budget.js';
import { normalizeServiceTier, serviceTierCreditMultiplier } from './inference-service-tier.js';
import { publishInferenceUsageChanged } from './inference-usage-events.js';

export interface InferenceAdmission {
  requestId: string;
  attemptId: string;
  attemptSequence: number;
  userId: string;
  budgetType: 'subscription' | 'api';
  model: InferenceModel;
  source: InferenceModelSource;
  connection: typeof inferenceProviderConnections.$inferSelect;
  pricing: typeof inferencePricingSnapshots.$inferSelect | null;
  /** The API source had no price for this call: it runs uncharged and outside API budget enforcement. */
  costUnknown: boolean;
  modelMultiplier: number;
  burnMultiplier: number;
  serviceTier: string | null;
  serviceTierMultiplier: number;
  reservation: BudgetReservation;
  estimatedUsage: InferenceUsage;
  admittedMaxOutputTokens?: number;
  readonly startedAtMs: number;
  dispatchedAtMs?: number;
  fixedApiMicrodollars?: number;
}

@injectable()
export class InferenceAccountingService {
  constructor(
    private readonly policies: InferenceBudgetPolicyService,
    private readonly reservations: InferenceBudgetReservationService,
    private readonly locks: InferenceBudgetLockService,
    private readonly eventBus?: EventBusService
  ) {}

  async admit(input: {
    userId: string;
    tokenId: string | null;
    protocol: 'responses' | 'chat_completions' | 'messages';
    request: InferenceRequest;
    model: InferenceModel;
    source: InferenceModelSource;
    connection: typeof inferenceProviderConnections.$inferSelect;
    operation?: 'inference' | 'search';
    apiUnitCharge?: { priceKey: string; units: number };
    retryOf?: InferenceAdmission;
  }): Promise<InferenceAdmission> {
    return this.locks.withUserLock(input.userId, async (database) => {
      const limits = await this.policies.effective(input.userId, database);
      if (!limits.enabled) throw new InferenceProtocolError(403, 'inference_disabled', 'Inference usage is disabled');
      const admittedAt = new Date();
      const usage = await this.policies.usage(input.userId, limits, admittedAt, database, {
        startSubscriptionWindows: input.source.sourceType === 'subscription',
      });
      const pricingSnapshot =
        input.source.sourceType === 'api' ? await latestPricingSnapshot(database, input.source.id) : null;
      const pricing = tokenPricing(pricingSnapshot);
      const unitAmount = input.apiUnitCharge
        ? unitCharge(pricingSnapshot, input.apiUnitCharge.priceKey, input.apiUnitCharge.units)
        : 0;
      const costUnknown =
        input.source.sourceType === 'api' && (unitAmount === null || (!input.apiUnitCharge && !pricing));
      const burnMultiplier =
        input.source.sourceType === 'subscription'
          ? await modelPoolBurnMultiplier(database, input.model.id, admittedAt, input.request.isCompaction)
          : 1;
      const modelMultiplier = Number(input.source.subscriptionMultiplierOverride ?? input.model.subscriptionMultiplier);
      const serviceTier = normalizeServiceTier(input.request.extensions.service_tier);
      const serviceTierMultiplier = serviceTierCreditMultiplier(
        input.source.sourceType,
        input.connection.providerId,
        serviceTier
      );
      const conservativeUsage = conservativeEstimate(
        input.request,
        input.model.maxOutputTokens,
        input.model.maxInputTokens
      );
      const preliminaryEstimatedUsage =
        input.source.sourceType === 'subscription'
          ? capSubscriptionEstimateToBudget({
              estimate: conservativeUsage,
              limits,
              usage,
              modelMultiplier,
              burnMultiplier,
              serviceTierMultiplier,
              isCompaction: input.request.isCompaction,
            })
          : conservativeUsage;
      if (!preliminaryEstimatedUsage) {
        throw new InferenceProtocolError(429, 'subscription_budget_exhausted', 'Inference budget exhausted');
      }
      const fixedApiMicrodollars = costUnknown ? 0 : (unitAmount ?? 0);
      const amounts = reservationAmounts(
        input.source.sourceType,
        preliminaryEstimatedUsage,
        modelMultiplier,
        burnMultiplier,
        serviceTierMultiplier,
        pricing,
        fixedApiMicrodollars
      );
      if (input.retryOf && input.retryOf.userId !== input.userId) {
        throw new InferenceProtocolError(400, 'invalid_request_error', 'Retry ownership does not match');
      }
      const requestId = input.retryOf?.requestId ?? randomUUID();
      const attemptId = randomUUID();
      const attemptSequence = (input.retryOf?.attemptSequence ?? 0) + 1;
      if (input.source.sourceType === 'api' && !costUnknown && input.connection.apiMonthlyLimitMicrodollars !== null) {
        await this.locks.lockProviderConnection(database, input.connection.id);
        await assertProviderApiBudget(database, input.connection, amounts.apiMonthlyMicrodollars, requestId);
      }
      const idempotencyKey = input.retryOf ? undefined : stringExtension(input.request.extensions.idempotency_key);
      const idempotencyKeyHash = idempotencyKey ? hash(`${input.userId}:${idempotencyKey}`) : null;
      if (idempotencyKeyHash) {
        const existing = await database.query.inferenceRequests.findFirst({
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

      if (!input.retryOf) {
        await database.insert(inferenceRequests).values({
          id: requestId,
          userId: input.userId,
          tokenId: input.tokenId,
          modelId: input.model.id,
          sourceId: input.source.id,
          connectionId: input.connection.id,
          pricingSnapshotId: pricing?.id,
          idempotencyKeyHash,
          affinityKeyHash: input.request.promptCacheKey ? hash(input.request.promptCacheKey) : null,
          protocol: input.operation === 'search' ? 'search' : input.protocol,
          operation: input.request.isCompaction ? 'compaction' : (input.operation ?? 'inference'),
          publicModelId: input.model.publicId,
          upstreamModelId: input.source.upstreamModelId,
          reasoningEffort: input.request.reasoningEffort ?? null,
          budgetType: input.source.sourceType,
          status: 'reserved',
          startedAt: admittedAt,
          isCompaction: input.request.isCompaction,
          estimatedUsage: true,
          priceVersion: pricing?.version,
          costUnknown,
          serviceTier,
          modelMultiplier: String(modelMultiplier),
          burnMultiplier: String(burnMultiplier),
          serviceTierMultiplier: String(serviceTierMultiplier),
          creditsCharged: String(amounts.credits5h),
          apiMicrodollarsCharged: amounts.apiMonthlyMicrodollars,
          uncachedInputTokens: preliminaryEstimatedUsage.inputTokens,
          cachedInputTokens: preliminaryEstimatedUsage.cachedInputTokens,
          cacheWriteTokens: preliminaryEstimatedUsage.cacheWriteTokens,
          outputTokens: preliminaryEstimatedUsage.outputTokens,
          reasoningTokens: preliminaryEstimatedUsage.reasoningTokens,
        });
      }

      let reservation: BudgetReservation;
      try {
        reservation = await this.reservations.reserve({
          reservationId: requestId,
          userId: input.userId,
          amounts,
          usage,
          limits,
          isCompaction: input.request.isCompaction,
          ...(costUnknown ? { apiBudgetExempt: true } : {}),
        });
      } catch (error) {
        if (!input.retryOf) await database.delete(inferenceRequests).where(eq(inferenceRequests.id, requestId));
        throw error;
      }
      const estimatedUsage =
        input.source.sourceType === 'subscription'
          ? capSubscriptionEstimateToCredits({
              estimate: conservativeUsage,
              maximumCredits: subscriptionReservationAllowance(limits, reservation.admittedAmounts),
              modelMultiplier,
              burnMultiplier,
              serviceTierMultiplier,
            })
          : preliminaryEstimatedUsage;
      if (!estimatedUsage) {
        await this.reservations.release(reservation);
        if (!input.retryOf) await database.delete(inferenceRequests).where(eq(inferenceRequests.id, requestId));
        throw new InferenceProtocolError(429, 'subscription_budget_exhausted', 'Inference budget exhausted');
      }
      const committedAmounts = reservationAmounts(
        input.source.sourceType,
        estimatedUsage,
        modelMultiplier,
        burnMultiplier,
        serviceTierMultiplier,
        pricing,
        fixedApiMicrodollars
      );
      const admittedMaxOutputTokens =
        estimatedUsage.outputTokens < conservativeUsage.outputTokens ? estimatedUsage.outputTokens : undefined;
      try {
        const [claimed] = await database
          .update(inferenceRequests)
          .set({
            sourceId: input.source.id,
            connectionId: input.connection.id,
            pricingSnapshotId: pricing?.id ?? null,
            upstreamModelId: input.source.upstreamModelId,
            reasoningEffort: input.request.reasoningEffort ?? null,
            budgetType: input.source.sourceType,
            errorCode: null,
            completedAt: null,
            priceVersion: pricing?.version ?? null,
            costUnknown,
            serviceTier,
            modelMultiplier: String(modelMultiplier),
            burnMultiplier: String(burnMultiplier),
            serviceTierMultiplier: String(serviceTierMultiplier),
            creditsCharged: String(committedAmounts.credits5h),
            apiMicrodollarsCharged: committedAmounts.apiMonthlyMicrodollars,
            uncachedInputTokens: estimatedUsage.inputTokens,
            cachedInputTokens: estimatedUsage.cachedInputTokens,
            cacheWriteTokens: estimatedUsage.cacheWriteTokens,
            outputTokens: estimatedUsage.outputTokens,
            reasoningTokens: estimatedUsage.reasoningTokens,
          })
          .where(and(eq(inferenceRequests.id, requestId), eq(inferenceRequests.status, 'reserved')))
          .returning({ id: inferenceRequests.id });
        if (!claimed) throw new InferenceProtocolError(409, 'retry_unavailable', 'Inference retry is unavailable');
        await database.insert(inferenceRequestAttempts).values({
          id: attemptId,
          requestId,
          sequence: attemptSequence,
          sourceId: input.source.id,
          connectionId: input.connection.id,
          status: 'pending',
          startedAt: admittedAt,
        });
      } catch (error) {
        await this.reservations.release(reservation);
        throw error;
      }
      return {
        requestId,
        attemptId,
        attemptSequence,
        userId: input.userId,
        budgetType: input.source.sourceType,
        model: input.model,
        source: input.source,
        connection: input.connection,
        pricing,
        costUnknown,
        modelMultiplier,
        burnMultiplier,
        serviceTier,
        serviceTierMultiplier,
        reservation,
        estimatedUsage,
        ...(admittedMaxOutputTokens === undefined ? {} : { admittedMaxOutputTokens }),
        startedAtMs: admittedAt.getTime(),
        ...(fixedApiMicrodollars > 0 ? { fixedApiMicrodollars } : {}),
      };
    });
  }

  async admitExtended(input: {
    userId: string;
    tokenId: string;
    protocol: 'images' | 'search' | 'realtime';
    operation: string;
    model: InferenceModel;
    source: InferenceModelSource;
    connection: typeof inferenceProviderConnections.$inferSelect;
    priceKey: string;
    units: number;
  }): Promise<InferenceAdmission> {
    return this.locks.withUserLock(input.userId, async (database) => {
      if (input.source.sourceType !== 'api') {
        throw new InferenceProtocolError(503, 'api_source_required', 'This operation requires an API-backed source');
      }
      const limits = await this.policies.effective(input.userId, database);
      if (!limits.enabled) throw new InferenceProtocolError(403, 'inference_disabled', 'Inference usage is disabled');
      const admittedAt = new Date();
      const usage = await this.policies.usage(input.userId, limits, admittedAt, database);
      const pricing = await latestPricingSnapshot(database, input.source.id);
      const unitAmount = unitCharge(pricing, input.priceKey, input.units);
      // No price for this call: it still runs, uncharged, with its cost recorded as unknown.
      const costUnknown = unitAmount === null;
      const fixedApiMicrodollars = unitAmount ?? 0;
      const requestId = randomUUID();
      const attemptId = randomUUID();
      const amounts: BudgetReservationAmounts = {
        credits5h: 0,
        credits7d: 0,
        credits30d: 0,
        apiMonthlyMicrodollars: fixedApiMicrodollars,
      };
      if (!costUnknown && input.connection.apiMonthlyLimitMicrodollars !== null) {
        await this.locks.lockProviderConnection(database, input.connection.id);
        await assertProviderApiBudget(database, input.connection, fixedApiMicrodollars, requestId);
      }
      await database.insert(inferenceRequests).values({
        id: requestId,
        userId: input.userId,
        tokenId: input.tokenId,
        modelId: input.model.id,
        sourceId: input.source.id,
        connectionId: input.connection.id,
        pricingSnapshotId: pricing?.id ?? null,
        protocol: input.protocol,
        operation: input.operation.slice(0, 64),
        publicModelId: input.model.publicId,
        upstreamModelId: input.source.upstreamModelId,
        budgetType: 'api',
        status: 'reserved',
        startedAt: admittedAt,
        estimatedUsage: false,
        priceVersion: pricing?.version ?? null,
        apiMicrodollarsCharged: fixedApiMicrodollars,
        costUnknown,
      });
      let reservation: BudgetReservation;
      try {
        reservation = await this.reservations.reserve({
          reservationId: requestId,
          userId: input.userId,
          amounts,
          usage,
          limits,
          isCompaction: false,
          ...(costUnknown ? { apiBudgetExempt: true } : {}),
        });
      } catch (error) {
        await database
          .update(inferenceRequests)
          .set({ status: 'failed', errorCode: errorCode(error), completedAt: new Date() })
          .where(eq(inferenceRequests.id, requestId));
        throw error;
      }
      await database.insert(inferenceRequestAttempts).values({
        id: attemptId,
        requestId,
        sequence: 1,
        sourceId: input.source.id,
        connectionId: input.connection.id,
        status: 'pending',
        costUnknown,
        startedAt: admittedAt,
      });
      return {
        requestId,
        attemptId,
        attemptSequence: 1,
        userId: input.userId,
        budgetType: 'api',
        model: input.model,
        source: input.source,
        connection: input.connection,
        pricing,
        costUnknown,
        modelMultiplier: 1,
        burnMultiplier: 1,
        serviceTier: null,
        serviceTierMultiplier: 1,
        reservation,
        estimatedUsage: zeroUsage(),
        startedAtMs: admittedAt.getTime(),
        fixedApiMicrodollars,
      };
    });
  }

  async markDispatched(admission: InferenceAdmission): Promise<void> {
    await this.locks.withUserLock(admission.userId, async (database) => {
      const startedAt = new Date(admission.startedAtMs);
      const [claimed] = await database
        .update(inferenceRequests)
        .set({ status: 'running', startedAt })
        .where(and(eq(inferenceRequests.id, admission.requestId), eq(inferenceRequests.status, 'reserved')))
        .returning({ id: inferenceRequests.id });
      if (!claimed) throw new InferenceProtocolError(409, 'dispatch_unavailable', 'Inference dispatch is unavailable');
      const [attempt] = await database
        .update(inferenceRequestAttempts)
        .set({ status: 'running', startedAt })
        .where(
          and(eq(inferenceRequestAttempts.id, admission.attemptId), eq(inferenceRequestAttempts.status, 'pending'))
        )
        .returning({ id: inferenceRequestAttempts.id });
      if (!attempt) throw new InferenceProtocolError(409, 'dispatch_unavailable', 'Inference dispatch is unavailable');
      admission.dispatchedAtMs = Date.now();
    });
  }

  async settle(
    admission: InferenceAdmission,
    usage: InferenceUsage,
    emittedOutput: boolean,
    outcome: 'completed' | 'failed' = 'completed'
  ): Promise<void> {
    const latencyMs = Math.max(0, Date.now() - (admission.dispatchedAtMs ?? admission.startedAtMs));
    const credits =
      admission.budgetType === 'subscription'
        ? subscriptionCreditsForUsage(
            usage,
            admission.modelMultiplier,
            admission.burnMultiplier,
            admission.serviceTierMultiplier
          )
        : 0;
    const tokenCost =
      admission.budgetType === 'api' && admission.pricing && admission.estimatedUsage.totalTokens > 0
        ? apiMicrodollars(usage, admission.pricing)
        : 0;
    const costUnknown = admission.budgetType === 'api' && admission.costUnknown;
    const cost = costUnknown ? 0 : (admission.fixedApiMicrodollars ?? 0) + tokenCost;
    const status = outcome;
    const claimed = await this.locks.withUserLock(admission.userId, async (database) => {
      const [row] = await database
        .update(inferenceRequests)
        .set({
          status,
          estimatedUsage: usage.estimated,
          creditsCharged: String(credits),
          apiMicrodollarsCharged: cost,
          costUnknown,
          uncachedInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens),
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          completedAt: new Date(),
        })
        .where(and(eq(inferenceRequests.id, admission.requestId), eq(inferenceRequests.status, 'running')))
        .returning({ id: inferenceRequests.id });
      if (!row) return false;
      await database
        .update(inferenceRequestAttempts)
        .set({
          status,
          emittedOutput,
          uncachedInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          costUnknown,
          latencyMs,
          completedAt: new Date(),
        })
        .where(eq(inferenceRequestAttempts.id, admission.attemptId));
      await database.insert(inferenceUsageLedger).values({
        requestId: admission.requestId,
        userId: admission.userId,
        entryType: 'settlement',
        budgetType: admission.budgetType,
        credits: String(credits),
        apiMicrodollars: cost,
        costUnknown,
        uncachedInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        reason: usage.estimated ? 'estimated_terminal_usage' : 'upstream_terminal_usage',
        occurredAt: new Date(admission.startedAtMs),
        snapshot: {
          priceVersion: admission.pricing?.version ?? null,
          serviceTier: admission.serviceTier,
          modelMultiplier: admission.modelMultiplier,
          burnMultiplier: admission.burnMultiplier,
          serviceTierMultiplier: admission.serviceTierMultiplier,
          sourceId: admission.source.id,
          connectionId: admission.connection.id,
        },
      });
      const didClaim = true;
      await this.reservations.release(admission.reservation);
      return didClaim;
    });
    if (claimed) {
      logInferenceSettlement(admission, usage, status, latencyMs);
      publishInferenceUsageChanged(this.eventBus, {
        targetUserId: admission.userId,
        reason: 'settlement',
      });
    }
  }

  async fail(admission: InferenceAdmission, error: unknown, emittedOutput: boolean): Promise<void> {
    const latencyMs = Math.max(0, Date.now() - (admission.dispatchedAtMs ?? admission.startedAtMs));
    const code = errorCode(error);
    const claimed = await this.locks.withUserLock(admission.userId, async (database) => {
      const [row] = await database
        .update(inferenceRequests)
        .set({ status: 'failed', errorCode: code, completedAt: new Date() })
        .where(
          and(eq(inferenceRequests.id, admission.requestId), inArray(inferenceRequests.status, ['reserved', 'running']))
        )
        .returning({ id: inferenceRequests.id });
      if (!row) return false;
      await database
        .update(inferenceRequestAttempts)
        .set({ status: 'failed', errorCode: code, emittedOutput, latencyMs, completedAt: new Date() })
        .where(eq(inferenceRequestAttempts.id, admission.attemptId));
      const didClaim = true;
      await this.reservations.release(admission.reservation);
      return didClaim;
    });
    if (claimed) logInferenceFailure(admission, code, emittedOutput, latencyMs);
  }

  async failForRetry(admission: InferenceAdmission, error: unknown): Promise<void> {
    const latencyMs = Math.max(0, Date.now() - (admission.dispatchedAtMs ?? admission.startedAtMs));
    const code = errorCode(error);
    await this.locks.withUserLock(admission.userId, async (database) => {
      await database
        .update(inferenceRequests)
        .set({ status: 'reserved', errorCode: code })
        .where(
          and(eq(inferenceRequests.id, admission.requestId), inArray(inferenceRequests.status, ['reserved', 'running']))
        );
      await database
        .update(inferenceRequestAttempts)
        .set({ status: 'failed', errorCode: code, emittedOutput: false, latencyMs, completedAt: new Date() })
        .where(eq(inferenceRequestAttempts.id, admission.attemptId));
      await this.reservations.release(admission.reservation);
    });
    logInferenceFailure(admission, code, false, latencyMs);
  }

  async finishRetry(admission: InferenceAdmission, error: unknown): Promise<void> {
    await this.locks.withUserLock(admission.userId, async (database) => {
      await database
        .update(inferenceRequests)
        .set({ status: 'failed', errorCode: errorCode(error), completedAt: new Date() })
        .where(and(eq(inferenceRequests.id, admission.requestId), eq(inferenceRequests.status, 'reserved')));
    });
  }
}

function subscriptionReservationAllowance(
  limits: EffectiveInferenceLimits,
  amounts: BudgetReservation['admittedAmounts']
): number {
  const admitted = [
    limits.credits5hEnabled ? amounts.credits5h : null,
    limits.credits7dEnabled ? amounts.credits7d : null,
    limits.credits30dEnabled ? amounts.credits30d : null,
  ].filter((amount): amount is number => amount !== null);
  return admitted.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...admitted);
}

export { __testOnly } from './inference-accounting.helpers.js';
