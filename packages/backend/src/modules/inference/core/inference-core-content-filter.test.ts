import { describe, expect, it } from 'vitest';
import { contentFilterStop, failedRequestErrorCode } from '../accounting/inference-accounting.helpers.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { CoreResponsesSseObserver } from './inference-core-sse-observer.js';

// Stand rc.3 O-D: an answer the provider's content filter stopped was stored in Activity as
// `upstream_server_error` (the core's HTTP-mapped attempt code), pointing at a provider server error.
describe('content-filter stop in Activity', () => {
  const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

  it('sees a content-filter stop on the Responses and Chat Completions streams', () => {
    const responses = new CoreResponsesSseObserver('responses');
    expect(
      responses.observe(
        frame({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } })
      )
    ).toBe('failed');
    expect(responses.contentFiltered).toBe(true);

    const chat = new CoreResponsesSseObserver('chat_completions');
    chat.observe(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }));
    expect(chat.contentFiltered).toBe(true);

    const length = new CoreResponsesSseObserver('responses');
    length.observe(
      frame({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })
    );
    expect(length.contentFiltered).toBe(false);
  });

  it('records content_filter over the attempt code, but never over an Opfield refusal', () => {
    expect(failedRequestErrorCode(null, 'upstream_server_error', contentFilterStop())).toBe('content_filter');
    expect(failedRequestErrorCode('api_budget_exhausted', 'upstream_server_error', contentFilterStop())).toBe(
      'api_budget_exhausted'
    );
    expect(failedRequestErrorCode(null, 'upstream_server_error', undefined)).toBe('upstream_server_error');
    expect(failedRequestErrorCode(null, null, new InferenceProtocolError(502, 'upstream_incomplete', 'x'))).toBe(
      'upstream_incomplete'
    );
  });
});
