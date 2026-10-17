import { describe, expect, it } from 'vitest';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import { validateWSCommand, wsCommandFailure } from './ai.ws-commands.js';

// O-9 (stand rc.2): a message without clientCommandId reached the ai_runs insert and answered 500 with the SQL.
describe('assistant WebSocket commands', () => {
  it('refuses a command without its required fields before anything runs', () => {
    const error = validateWSCommand({ type: 'conversation.send_message', content: 'hello' });
    expect(error).toMatchObject({ statusCode: 400, code: 'AI_COMMAND_INVALID' });
    expect(error?.message).toContain('clientCommandId is required');
    expect(
      validateWSCommand({
        type: 'approval.decide',
        conversationId: 'c',
        runId: 'r',
        approvalId: 'a',
        decision: 'maybe',
        clientCommandId: 'x',
      })?.message
    ).toContain('decision must be one of approved, rejected');
    expect(validateWSCommand({ type: 'conversation.send_message', clientCommandId: 'x', content: 'hi' })).toBeNull();
    expect(validateWSCommand({ type: 'conversation.unsubscribe', conversationId: 'c' })).toBeNull();
    expect(validateWSCommand({ type: 'no.such.command' })).toBeNull();
  });

  it('answers a budget refusal, a rate limit and a content filter with their own codes', () => {
    const budget = wsCommandFailure(
      new InferenceProtocolError(502, 'rate_limit_error', 'admission denied: budget_exceeded', {
        retryAfterMs: 61_000,
      }),
      'Failed to send AI message'
    );
    expect(budget).toMatchObject({ code: 'AI_BUDGET_EXCEEDED', statusCode: 402, details: { retryAfterSeconds: 61 } });
    expect(budget.message).toContain('budget is used up');
    expect(wsCommandFailure(new InferenceProtocolError(429, 'rate_limit_exceeded', 'slow down'), 'x')).toMatchObject({
      code: 'AI_RATE_LIMITED',
      statusCode: 429,
    });
    expect(
      wsCommandFailure(
        new InferenceProtocolError(502, 'content_filter', 'Opfield Inference ended the answer early'),
        'x'
      )
    ).toMatchObject({
      code: 'AI_CONTENT_FILTERED',
      statusCode: 422,
      message: expect.stringContaining('content filter'),
    });
    expect(wsCommandFailure(new InferenceProtocolError(502, 'upstream_error', 'boom'), 'x')).toMatchObject({
      code: 'AI_PROVIDER_FAILED',
      statusCode: 502,
    });
  });

  // GF-1 / F-B (stand rc.3): Opfield's own 429 budget refusals came back as AI_RATE_LIMITED "wait a moment".
  it("answers Opfield's own budget refusals as a budget error with the recovery time", () => {
    const recoveryAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const cases = [
      ['api_budget_exhausted', 'monthly', 'monthly Opfield Inference API budget is used up'],
      ['subscription_budget_exhausted', '5h', 'subscription credits for the 5-hour window are used up'],
      ['provider_api_budget_exhausted', undefined, 'Every connection that serves this model'],
    ] as const;
    for (const [code, dimension, text] of cases) {
      const failure = wsCommandFailure(
        new InferenceProtocolError(429, code, 'Inference budget exhausted', {
          recoveryAt,
          ...(dimension ? { dimension } : {}),
        }),
        'Failed to send AI message'
      );
      expect(failure).toMatchObject({
        code: 'AI_BUDGET_EXCEEDED',
        statusCode: 402,
        details: { recoveryAt, ...(dimension ? { dimension } : {}) },
      });
      expect(failure.details?.retryAfterSeconds).toBeGreaterThan(3 * 86_400 - 60);
      expect(failure.message).toContain(text);
      expect(failure.message).toContain(`${recoveryAt.slice(0, 16).replace('T', ' ')} UTC`);
      expect(failure.message).not.toContain('Wait a moment');
    }
  });

  it('never sends an internal error message to the client', () => {
    const failure = wsCommandFailure(
      new Error('insert into "ai_runs" ... null value in column "client_command_id" violates not-null constraint'),
      'Failed to send AI message'
    );
    expect(failure).toMatchObject({ code: 'AI_COMMAND_FAILED', statusCode: 500 });
    expect(failure.message).not.toContain('ai_runs');
    expect(failure.message).toContain(failure.reference!);
  });
});
