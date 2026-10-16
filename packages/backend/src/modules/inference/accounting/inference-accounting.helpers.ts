import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { inferencePricingSnapshots, inferenceQuotaSnapshots } from '@/db/schema/index.js';
import { QUOTA_READ_LIMIT } from '@/services/inference-usage-retention.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { InferenceRequest, InferenceUsage } from '../protocol/inference-protocol.types.js';
import { estimateInputTokens } from '../protocol/inference-usage.js';
import {
  apiMicrodollars,
  type EffectiveInferenceLimits,
  type InferenceBudgetUsage,
  SUBSCRIPTION_ADMISSION_OVERAGE_CREDITS,
  SUBSCRIPTION_CHAT_BUDGET_FRACTION,
  subscriptionCreditsForUsage,
} from './inference-budget-policy.js';
import type { BudgetReservationAmounts } from './inference-budget-reservation.service.js';

const DEFAULT_UNKNOWN_MAX_OUTPUT_TOKENS = 8_192;

// Cache disposition is unknown at admission. Reserve the most expensive
// input class using the same tariff as settlement, without inflating token counts.
function subscriptionEstimateCredits(
  usage: InferenceUsage,
  modelMultiplier: number,
  burnMultiplier: number,
  serviceTierMultiplier: number
): number {
  return subscriptionCreditsForUsage(
    { ...usage, cachedInputTokens: 0, cacheWriteTokens: usage.inputTokens },
    modelMultiplier,
    burnMultiplier,
    serviceTierMultiplier
  );
}

export function conservativeEstimate(
  request: InferenceRequest,
  modelMaxOutput: number | null,
  modelMaxInput: number
): InferenceUsage {
  const inputTokens = estimateInputTokens(request.messages);
  const outputCeiling = modelMaxOutput ?? Math.min(modelMaxInput, DEFAULT_UNKNOWN_MAX_OUTPUT_TOKENS);
  const outputTokens = Math.min(request.maxOutputTokens ?? outputCeiling, outputCeiling);
  return {
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}

export function zeroUsage(): InferenceUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimated: false,
  };
}

export function reservationAmounts(
  sourceType: 'subscription' | 'api',
  usage: InferenceUsage,
  modelMultiplier: number,
  burnMultiplier: number,
  serviceTierMultiplier: number,
  pricing: typeof inferencePricingSnapshots.$inferSelect | null,
  fixedApiMicrodollars = 0
): BudgetReservationAmounts {
  if (sourceType === 'subscription') {
    const credits = subscriptionEstimateCredits(usage, modelMultiplier, burnMultiplier, serviceTierMultiplier);
    return { credits5h: credits, credits7d: credits, credits30d: credits, apiMonthlyMicrodollars: 0 };
  }
  if (!pricing) throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  return {
    credits5h: 0,
    credits7d: 0,
    credits30d: 0,
    apiMonthlyMicrodollars: apiMicrodollars(usage, pricing) + fixedApiMicrodollars,
  };
}

export function capSubscriptionEstimateToBudget(input: {
  estimate: InferenceUsage;
  limits: EffectiveInferenceLimits;
  usage: InferenceBudgetUsage;
  modelMultiplier: number;
  burnMultiplier: number;
  serviceTierMultiplier: number;
  isCompaction: boolean;
}): InferenceUsage | null {
  const enabledHeadroom = [
    input.limits.credits5hEnabled
      ? input.limits.credits5h * SUBSCRIPTION_CHAT_BUDGET_FRACTION - input.usage.credits5h
      : null,
    input.limits.credits7dEnabled
      ? input.limits.credits7d * SUBSCRIPTION_CHAT_BUDGET_FRACTION - input.usage.credits7d
      : null,
    input.limits.credits30dEnabled
      ? input.limits.credits30d * SUBSCRIPTION_CHAT_BUDGET_FRACTION - input.usage.credits30d
      : null,
  ].filter((value): value is number => value !== null);

  if (enabledHeadroom.length === 0) return input.estimate;
  const headroomCredits = Math.max(0, Math.min(...enabledHeadroom));
  if (headroomCredits <= 0) return null;
  return capSubscriptionEstimateToCredits({
    estimate: input.estimate,
    maximumCredits: headroomCredits + SUBSCRIPTION_ADMISSION_OVERAGE_CREDITS,
    modelMultiplier: input.modelMultiplier,
    burnMultiplier: input.burnMultiplier,
    serviceTierMultiplier: input.serviceTierMultiplier,
  });
}

/**
 * Reapply the output cap after Redis atomically allocated the live tail.
 * The reservation covers real remaining credits; this adds the one-credit
 * already-admitted-turn allowance without creating a second reservation.
 */
export function capSubscriptionEstimateToCredits(input: {
  estimate: InferenceUsage;
  maximumCredits: number;
  modelMultiplier: number;
  burnMultiplier: number;
  serviceTierMultiplier: number;
}): InferenceUsage | null {
  const multiplier = input.modelMultiplier * input.burnMultiplier * input.serviceTierMultiplier;
  const desiredCredits = subscriptionEstimateCredits(input.estimate, multiplier, 1, 1);
  if (desiredCredits <= input.maximumCredits || multiplier <= 0) return input.estimate;

  const inputCredits = subscriptionEstimateCredits({ ...input.estimate, outputTokens: 0 }, multiplier, 1, 1);
  const outputTokenCapacity = Math.floor(((input.maximumCredits - inputCredits) * 1_000) / multiplier);
  const outputTokens = Math.min(input.estimate.outputTokens, Math.max(0, outputTokenCapacity));
  if (outputTokens < 1) return null;

  return {
    ...input.estimate,
    outputTokens,
    totalTokens: input.estimate.inputTokens + outputTokens,
  };
}

export function hasSpendableSubscriptionBudget(limits: EffectiveInferenceLimits, usage: InferenceBudgetUsage): boolean {
  const enabledWindows = [
    limits.credits5hEnabled
      ? { used: usage.credits5h, limit: limits.credits5h * SUBSCRIPTION_CHAT_BUDGET_FRACTION }
      : null,
    limits.credits7dEnabled
      ? { used: usage.credits7d, limit: limits.credits7d * SUBSCRIPTION_CHAT_BUDGET_FRACTION }
      : null,
    limits.credits30dEnabled
      ? { used: usage.credits30d, limit: limits.credits30d * SUBSCRIPTION_CHAT_BUDGET_FRACTION }
      : null,
  ].filter((window): window is { used: number; limit: number } => window !== null);

  return enabledWindows.length === 0 || enabledWindows.every((window) => window.used < window.limit);
}

/**
 * When a user with no spendable subscription budget can spend again: every exhausted window
 * has to recover, so this is the latest recovery among them.
 */
export function subscriptionBudgetRecoveryAt(
  limits: EffectiveInferenceLimits,
  usage: InferenceBudgetUsage
): Date | null {
  const exhausted = [
    limits.credits5hEnabled && usage.credits5h >= limits.credits5h * SUBSCRIPTION_CHAT_BUDGET_FRACTION
      ? usage.recoveryAt.credits5h
      : null,
    limits.credits7dEnabled && usage.credits7d >= limits.credits7d * SUBSCRIPTION_CHAT_BUDGET_FRACTION
      ? usage.recoveryAt.credits7d
      : null,
    limits.credits30dEnabled && usage.credits30d >= limits.credits30d * SUBSCRIPTION_CHAT_BUDGET_FRACTION
      ? usage.recoveryAt.credits30d
      : null,
  ].filter((value): value is Date => value instanceof Date);
  return exhausted.length === 0 ? null : new Date(Math.max(...exhausted.map((value) => value.getTime())));
}

export function unitCharge(
  pricing: typeof inferencePricingSnapshots.$inferSelect | null,
  priceKey: string,
  rawUnits: number
): number {
  if (!pricing) throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  const price = pricing.otherUnitPrices[priceKey];
  const units = Math.max(1, Math.floor(rawUnits));
  const total = price * units;
  if (!Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(total)) {
    throw new InferenceProtocolError(503, 'pricing_unavailable', `API pricing for ${priceKey} is unavailable`);
  }
  return total;
}

export function stringExtension(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 512 ? value : undefined;
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function errorCode(error: unknown): string {
  return error instanceof InferenceProtocolError ? error.code.slice(0, 128) : 'upstream_error';
}

export async function latestPricing(database: DrizzleExecutor, sourceId: string) {
  const pricing = await database.query.inferencePricingSnapshots.findFirst({
    where: eq(inferencePricingSnapshots.sourceId, sourceId),
    orderBy: [desc(inferencePricingSnapshots.effectiveAt)],
  });
  if (!pricing || pricing.inputMicrodollarsPerMillion === null || pricing.outputMicrodollarsPerMillion === null) {
    throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  }
  return pricing;
}

export async function latestQuota(database: DrizzleExecutor, connectionId: string) {
  const rows = await database
    .select()
    .from(inferenceQuotaSnapshots)
    .where(eq(inferenceQuotaSnapshots.connectionId, connectionId))
    .orderBy(desc(inferenceQuotaSnapshots.fetchedAt))
    .limit(QUOTA_READ_LIMIT);
  return latestQuotaRows(rows);
}

function latestQuotaRows(rows: Array<typeof inferenceQuotaSnapshots.$inferSelect>) {
  const latestFetchedAt = rows.reduce(
    (latest, row) => Math.max(latest, row.fetchedAt.getTime()),
    Number.NEGATIVE_INFINITY
  );
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (row.fetchedAt.getTime() !== latestFetchedAt) return [];
    const key = `${row.dimension}:${row.modelBucket ?? ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        dimension: row.dimension,
        remainingFraction: row.remainingFraction === null ? null : Number(row.remainingFraction),
        resetAt: row.resetAt,
        validUntil: row.validUntil,
      },
    ];
  });
}

export const __testOnly = {
  capSubscriptionEstimateToCredits,
  capSubscriptionEstimateToBudget,
  conservativeEstimate,
  hasSpendableSubscriptionBudget,
  reservationAmounts,
  latestQuotaRows,
};
