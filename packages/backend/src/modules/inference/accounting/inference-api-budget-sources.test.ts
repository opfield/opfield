import { describe, expect, it, vi } from 'vitest';
import { sourcesWithinBudgets } from '../models/inference-model.helpers.js';
import type { EffectiveInferenceLimits, InferenceBudgetUsage } from './inference-budget-policy.js';
import { InferenceBudgetReservationService } from './inference-budget-reservation.service.js';

const limits: EffectiveInferenceLimits = {
  enabled: true,
  credits5hEnabled: false,
  credits5h: 0,
  credits7dEnabled: false,
  credits7d: 0,
  credits30dEnabled: false,
  credits30d: 0,
  apiMonthlyMicrodollars: 0,
  billingTimezone: 'UTC',
};
const recovery = new Date('2026-11-01T00:00:00Z');
// API budget 0 with API usage this month: the stand's case.
const usage: InferenceBudgetUsage = {
  credits5h: 0,
  credits7d: 0,
  credits30d: 0,
  apiMonthlyMicrodollars: 2_500_000,
  recoveryAt: { credits5h: recovery, credits7d: recovery, credits30d: recovery, apiMonthly: recovery },
};
const amounts = { credits5h: 1, credits7d: 1, credits30d: 1, apiMonthlyMicrodollars: 0 };
/** The limits the reservation script receives: 5h, 7d, 30d credits, then the monthly API limit. */
const CREDIT_LIMIT_ARGS = [20, 21, 22];
const API_LIMIT_ARG = 23;
/** A 5-hour subscription window of 100 credits, overspent. */
const spentWindow = { ...limits, credits5hEnabled: true, credits5h: 100 };
const spentUsage = { ...usage, credits5h: 140 };

function reservations(answer: unknown) {
  const redis = { eval: vi.fn(async (..._args: unknown[]) => answer) };
  return { redis, service: new InferenceBudgetReservationService(redis as never) };
}

describe('monthly API budget and the source a request runs on', () => {
  it('never holds a subscription request to a spent API budget', async () => {
    const { redis, service } = reservations([0, '1', '1', '1', '0', '0', '0', '0', '0']);
    const reservation = await service.reserve({
      reservationId: 'r1',
      userId: 'u1',
      amounts,
      usage,
      limits,
      isCompaction: false,
      sourceType: 'subscription',
    });
    expect(redis.eval.mock.calls[0]![API_LIMIT_ARG]).toBe(Number.MAX_SAFE_INTEGER);
    await service.release(reservation);
  });

  it('refuses an API request when the API budget is spent', async () => {
    const { redis, service } = reservations([4]);
    await expect(
      service.reserve({
        reservationId: 'r2',
        userId: 'u1',
        amounts: { ...amounts, apiMonthlyMicrodollars: 10 },
        usage,
        limits,
        isCompaction: false,
        sourceType: 'api',
      })
    ).rejects.toMatchObject({ status: 429, code: 'api_budget_exhausted', details: { dimension: 'monthly' } });
    expect(redis.eval.mock.calls[0]![API_LIMIT_ARG]).toBe(0);
  });

  it('never holds an API request to an overspent subscription window', async () => {
    const { redis, service } = reservations([0, '0', '0', '0', '10', '0', '0', '0', '0']);
    const reservation = await service.reserve({
      reservationId: 'r3',
      userId: 'u1',
      amounts: { credits5h: 0, credits7d: 0, credits30d: 0, apiMonthlyMicrodollars: 10 },
      usage: spentUsage,
      limits: { ...spentWindow, apiMonthlyMicrodollars: 1_000_000_000 },
      isCompaction: false,
      sourceType: 'api',
    });
    for (const index of CREDIT_LIMIT_ARGS) expect(redis.eval.mock.calls[0]![index]).toBe(Number.MAX_SAFE_INTEGER);
    expect(redis.eval.mock.calls[0]![API_LIMIT_ARG]).toBe(1_000_000_000);
    await service.release(reservation);
  });

  it('keeps holding a subscription request to its credit windows', async () => {
    const { redis, service } = reservations([1]);
    await expect(
      service.reserve({
        reservationId: 'r4',
        userId: 'u1',
        amounts,
        usage: spentUsage,
        limits: spentWindow,
        isCompaction: false,
        sourceType: 'subscription',
      })
    ).rejects.toMatchObject({ status: 429, code: 'subscription_budget_exhausted' });
    expect(redis.eval.mock.calls[0]![CREDIT_LIMIT_ARGS[0]!]).toBe(100);
  });

  it('routes around a spent budget only to the sources it does not cap', () => {
    const subscription = { id: 's', sourceType: 'subscription', priceMissing: false };
    const priced = { id: 'a', sourceType: 'api', priceMissing: false };
    const unpriced = { id: 'u', sourceType: 'api', priceMissing: true };
    const apiSpent = { api: true, subscription: false };
    expect(sourcesWithinBudgets([subscription], apiSpent)).toEqual([subscription]);
    expect(sourcesWithinBudgets([priced], apiSpent)).toBeNull();
    expect(sourcesWithinBudgets([priced, subscription], apiSpent)).toEqual([subscription]);
    expect(sourcesWithinBudgets([priced, unpriced], apiSpent)).toEqual([unpriced]);
    const subscriptionSpent = { api: false, subscription: true };
    expect(sourcesWithinBudgets([priced], subscriptionSpent)).toEqual([priced]);
    expect(sourcesWithinBudgets([subscription], subscriptionSpent)).toBeNull();
    expect(sourcesWithinBudgets([priced, subscription], subscriptionSpent)).toEqual([priced]);
    expect(sourcesWithinBudgets([priced, subscription], { api: true, subscription: true })).toBeNull();
  });
});
