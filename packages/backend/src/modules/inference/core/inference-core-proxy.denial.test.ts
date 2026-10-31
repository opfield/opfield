import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '@/types.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { newCoreRequestContext } from './inference-core-context.js';
import { InferenceCoreProxyService } from './inference-core-proxy.service.js';

/**
 * Stand rc.2 F-10: a core-admitted request refused by Opfield's budget admission reached the client
 * as the core's `402 {"code":"rate_limit_error"}` with no Retry-After. The proxy answers with
 * Opfield's own refusal instead, on any core version.
 */
const CORE_REFUSAL = JSON.stringify({
  error: { message: 'admission denied: budget_exceeded', type: 'rate_limit_error', code: 'rate_limit_error' },
});

const target = {
  baseUrl: 'http://core.test',
  credential: 'core-credential',
  requestLimitsCapability: 'negotiated-v1' as const,
  outputLimitSupported: true,
  nativeChatAdmission: true,
};

function forwardThrough(denial: InferenceProtocolError | null, allowFailover = false) {
  const finalized: Array<{ outcome: string; error: unknown }> = [];
  const service = new InferenceCoreProxyService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { admissionDenial: async () => denial } as never,
    {} as never
  );
  const { claims } = newCoreRequestContext({
    tenantUserId: 'user-1',
    rootRequestId: 'request-1',
    publicModelId: 'model',
    coreAccountId: 'account',
    coreModelId: 'upstream',
    operation: 'chat_completions',
  });
  let outcome: { kind: string; providerError?: unknown } | undefined;
  const app = new Hono<AppEnv>();
  app.post('/v1/chat/completions', async (c) => {
    const forwarded = await (
      service as unknown as {
        forward: (...args: unknown[]) => Promise<{ kind: string; response?: Response; providerError?: unknown }>;
      }
    ).forward(
      c,
      target,
      claims,
      'request-1',
      '/v1/chat/completions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      allowFailover,
      false,
      async (result: string, error?: unknown) => {
        finalized.push({ outcome: result, error });
      },
      { wire: 'chat_completions', modelIds: null }
    );
    outcome = forwarded;
    return forwarded.response ?? c.body(null, 204);
  });
  return { app, finalized, outcome: () => outcome };
}

describe('core admission refusals reach the client as Opfield refusals', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers 429 with the budget code, recovery time and Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(CORE_REFUSAL, { status: 402, headers: { 'content-type': 'application/json' } }))
    );
    const recoveryAt = new Date(Date.now() + 3_600_000).toISOString();
    const denial = new InferenceProtocolError(429, 'api_budget_exhausted', 'Inference budget exhausted', {
      recoveryAt,
      dimension: 'monthly',
    });
    const { app, finalized } = forwardThrough(denial);
    const response = await app.request('/v1/chat/completions', { method: 'POST', body: '{}' });

    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(3_500);
    expect(retryAfter).toBeLessThanOrEqual(3_600);
    expect(await response.json()).toMatchObject({
      error: { code: 'api_budget_exhausted', details: { recoveryAt, dimension: 'monthly' } },
    });
    await vi.waitFor(() => expect(finalized).toEqual([{ outcome: 'failed', error: denial }]));
  });

  it('fails over on a connection limit when another connection can serve the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(CORE_REFUSAL, { status: 402 }))
    );
    const denial = new InferenceProtocolError(
      429,
      'provider_api_budget_exhausted',
      'Provider monthly API budget exhausted',
      {
        recoveryAt: new Date(Date.now() + 60_000).toISOString(),
      }
    );
    const { app, finalized, outcome } = forwardThrough(denial, true);
    await app.request('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(outcome()).toMatchObject({ kind: 'retry', providerError: denial });
    expect(finalized).toEqual([]);
  });

  it('relays a core error that Opfield did not decide unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'bad' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    const { app } = forwardThrough(null);
    const response = await app.request('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(response.status).toBe(400);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(await response.json()).toEqual({ error: { code: 'invalid_request_error', message: 'bad' } });
  });

  it.each([
    401, 403, 500,
  ])('tells the client a provider %s failed without naming the provider or the fix', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: 'authentication_error',
                code: 'invalid_api_key',
                message: 'Not logged in to anthropic. Run: ocx login anthropic',
              },
            }),
            { status, headers: { 'content-type': 'application/json' } }
          )
      )
    );
    const { app, finalized } = forwardThrough(null);
    const response = await app.request('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('provider_unavailable');
    expect(text).not.toMatch(/anthropic|ocx|invalid_api_key/);
    expect(finalized.length).toBe(1);
  });
});
