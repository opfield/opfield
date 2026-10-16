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
