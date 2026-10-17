import { describe, expect, it, vi } from 'vitest';
import { sourcesWithinSpentApiBudget } from '../models/inference-model.helpers.js';
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
/** The monthly API limit the reservation script receives (the last of the four limits). */
const API_LIMIT_ARG = 2 + 8 + 2 + 4 + 4 + 3;

function reservations(answer: unknown) {
  const redis = { eval: vi.fn(async () => answer) };
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

  it('routes around a spent API budget only to sources it does not cap', () => {
    const subscription = { id: 's', sourceType: 'subscription', priceMissing: false };
    const priced = { id: 'a', sourceType: 'api', priceMissing: false };
    const unpriced = { id: 'u', sourceType: 'api', priceMissing: true };
    expect(sourcesWithinSpentApiBudget([subscription])).toEqual([subscription]);
    expect(sourcesWithinSpentApiBudget([priced])).toBeNull();
    expect(sourcesWithinSpentApiBudget([priced, subscription])).toEqual([subscription]);
    expect(sourcesWithinSpentApiBudget([priced, unpriced])).toEqual([unpriced]);
  });
});
