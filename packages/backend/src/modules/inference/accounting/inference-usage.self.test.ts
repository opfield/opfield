import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { User } from '@/types.js';
import type { EffectiveInferenceLimits, InferenceBudgetUsage } from './inference-budget-policy.js';
import { InferenceUsageService } from './inference-usage.service.js';

/** Stand rc.2 INF-O-5: a window that does not limit the user showed 100 % once anything was used. */
describe('self usage windows', () => {
  const limits: EffectiveInferenceLimits = {
    enabled: true,
    credits5hEnabled: true,
    credits5h: 100,
    credits7dEnabled: false,
    credits7d: 0,
    credits30dEnabled: false,
    credits30d: 0,
    apiMonthlyMicrodollars: 0,
    billingTimezone: 'UTC',
  };
  const now = new Date('2026-10-17T12:00:00Z');
  const usage: InferenceBudgetUsage = {
    credits5h: 10,
    credits7d: 10,
    credits30d: 10,
    apiMonthlyMicrodollars: 2_520,
    recoveryAt: { credits5h: now, credits7d: now, credits30d: now, apiMonthly: now },
  };
  // Subscription models are available; the user has no API models.
  const db = {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{ sourceType: 'subscription' }] }) }) }),
  };
  const service = new InferenceUsageService(
    db as never,
    { effective: async () => limits, usage: async () => usage } as never,
    {} as never,
    undefined,
    { allowedModelIds: async () => new Set(['model-1']) } as never
  );

  it('reports windows that do not limit the user as unconfigured at 0 %', async () => {
    const self = await service.self({ id: 'user-1' } as User, now);
    expect(self.subscription['7d']).toMatchObject({ configured: false, percentage: 0 });
    expect(self.subscription['30d']).toMatchObject({ configured: false, percentage: 0 });
    expect(self.api).toMatchObject({ configured: false, percentage: 0 });
    expect(self.subscription['5h'].configured).toBe(true);
    expect(self.subscription['5h'].percentage).toBeGreaterThan(0);
    expect(self.subscription['5h'].percentage).toBeLessThan(100);
  });
});
