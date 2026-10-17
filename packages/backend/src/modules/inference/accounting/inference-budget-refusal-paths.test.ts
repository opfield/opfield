import { describe, expect, it, vi } from 'vitest';
import { wsCommandFailure } from '@/modules/ai/ai.ws-commands.js';
import { AIProviderRuntimeService } from '@/modules/ai/ai-provider-runtime.service.js';
import { InferenceModelService } from '../models/inference-model.service.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { apiBudgetExhausted } from './inference-admission-denial.js';
import { InferenceBudgetPolicyService } from './inference-budget-policy.js';

const user = { id: 'u1' } as never;
const monthEnd = new Date('2026-11-01T00:00:00Z');

/** A drizzle stand-in: every chain resolves to the next queued rows. */
function fakeDb(results: unknown[][], query?: unknown): never {
  const chain: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'query') return query;
        if (prop === 'then') return (resolve: (rows: unknown) => void) => resolve(results.shift() ?? []);
        return () => chain;
      },
    }
  );
  return chain as never;
}

function modelService(availability: { modelIds: string[]; apiUsageEnabled: boolean; apiBudgetHeldModelIds: string[] }) {
  const db = fakeDb([], {
    inferenceModels: { findFirst: async () => ({ id: 'm-swift', publicId: 'opfield-swift', enabled: true }) },
  });
  const policies = {
    effective: async () => ({ enabled: true, apiMonthlyMicrodollars: 0 }),
    usage: async () => ({ recoveryAt: { apiMonthly: monthEnd } }),
  };
  const service = new InferenceModelService(
    db,
    {} as never,
    { canAccess: async () => true } as never,
    {} as never,
    policies as never
  );
  vi.spyOn(service as unknown as Record<string, () => Promise<unknown>>, 'modelAvailabilityForUser').mockResolvedValue(
    availability
  );
  return service;
}

describe('a model held back by the API budget', () => {
  it('is refused on the data plane with the API budget error, not as an unknown model', async () => {
    await expect(
      modelService({ modelIds: [], apiUsageEnabled: false, apiBudgetHeldModelIds: ['m-swift'] }).resolveForUser(
        user,
        'opfield-swift'
      )
    ).rejects.toMatchObject({
      status: 429,
      code: 'api_budget_exhausted',
      details: { recoveryAt: monthEnd.toISOString(), dimension: 'monthly' },
    });
    await expect(
      modelService({ modelIds: [], apiUsageEnabled: false, apiBudgetHeldModelIds: [] }).resolveForUser(
        user,
        'opfield-swift'
      )
    ).rejects.toMatchObject({ status: 404, code: 'model_not_found' });
  });

  it('answers AI Workspace with the budget refusal instead of AI_MODEL_UNAVAILABLE', async () => {
    const resolveForUser = vi.fn(async () => {
      throw apiBudgetExhausted(monthEnd);
    });
    const runtime = new AIProviderRuntimeService(
      {
        getConfig: async () => ({
          providerType: 'opfield_inference',
          opfieldInferenceModel: 'opfield-swift',
          opfieldInferenceAllowUserModelSelection: true,
        }),
      } as never,
      { isFeatureEnabled: async () => true } as never,
      { listForUser: async () => ({ data: [] }), resolveForUser } as never,
      { isConfigured: () => true } as never,
      {} as never
    );
    const refusal = await runtime.resolveSession(user, { requestedModel: 'opfield-swift' } as never).catch((e) => e);
    expect(refusal).toBeInstanceOf(InferenceProtocolError);
    expect(resolveForUser).toHaveBeenCalledWith(user, 'opfield-swift');
    expect(wsCommandFailure(refusal, 'failed')).toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
      statusCode: 402,
      details: { dimension: 'monthly' },
    });

    resolveForUser.mockRejectedValueOnce(new InferenceProtocolError(404, 'model_not_found', 'gone'));
    await expect(runtime.resolveSession(user, { requestedModel: 'opfield-swift' } as never)).rejects.toMatchObject({
      code: 'AI_MODEL_UNAVAILABLE',
    });
  });
});

describe('a per-user override of a subscription window', () => {
  const row = (policyType: 'default' | 'user', credits5hEnabled: boolean, credits5h: string) => ({
    policyType,
    userId: policyType === 'user' ? 'u1' : null,
    enabled: true,
    credits5hEnabled,
    credits5h,
    credits7dEnabled: false,
    credits7d: '0',
    credits30dEnabled: false,
    credits30d: '0',
    apiMonthlyMicrodollars: 9_000_000,
    billingTimezone: 'UTC',
  });

  it('limits the user with its own value while the default turns the window on', async () => {
    const limits = await new InferenceBudgetPolicyService(
      fakeDb([[row('user', true, '100'), row('default', true, '5000')]])
    ).effective('u1');
    expect(limits).toMatchObject({ credits5hEnabled: true, credits5h: 100, apiMonthlyMicrodollars: 9_000_000 });
  });

  it('is stored but does not apply while the default turns the window off (Disabled globally)', async () => {
    const limits = await new InferenceBudgetPolicyService(
      fakeDb([[row('user', true, '100'), row('default', false, '0')]])
    ).effective('u1');
    expect(limits.credits5hEnabled).toBe(false);
  });
});
