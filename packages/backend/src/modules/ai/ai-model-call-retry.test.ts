import { describe, expect, it } from 'vitest';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type { ModelProviderEvent } from './ai.provider-adapter.js';
import { describeModelCallError, retryDelayMs, streamModelCallWithRetry } from './ai-model-call-retry.js';

const upstream5xx = () =>
  new InferenceProtocolError(502, 'upstream_server_error', 'Upstream inference request failed', {
    provider: 'Anthropic',
  });

/** A provider whose model calls play a script: each entry answers one attempt. */
function scriptedProvider(script: Array<ModelProviderEvent[] | Error | { partial: string; error: Error }>) {
  let attempts = 0;
  const waits: number[] = [];
  const session = (signal = new AbortController().signal) =>
    streamModelCallWithRetry({
      createAttempt: async function* () {
        const step = script[attempts++];
        if (!step) throw new Error('script exhausted');
        if (step instanceof Error) throw step;
        if ('partial' in step) {
          yield { type: 'text_delta', content: step.partial };
          throw step.error;
        }
        yield* step;
      },
      requestId: 'run-1',
      conversationId: 'conversation-1',
      model: 'claude-sonnet-5.5',
      signal,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      random: () => 0,
    });
  return { session, waits, attempts: () => attempts };
}

async function collect(stream: AsyncGenerator<ModelProviderEvent>): Promise<ModelProviderEvent[]> {
  const events: ModelProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const toolCallResponse: ModelProviderEvent = {
  type: 'model_response',
  response: { content: '', toolCalls: [{ id: 'call-1', name: 'remove_docker_image', arguments: '{"id":"a"}' }] },
};
const finalResponse: ModelProviderEvent[] = [
  { type: 'text_delta', content: 'Removed 3 images.' },
  { type: 'model_response', response: { content: 'Removed 3 images.', toolCalls: [] } },
];

describe('model call retry', () => {
  it('retries a provider 5xx in the middle of a tool-using turn without repeating the tool', async () => {
    const provider = scriptedProvider([[toolCallResponse], upstream5xx(), upstream5xx(), finalResponse]);
    const executedTools: string[] = [];

    // Model call 1 asks for a tool; the run executes it once.
    for (const event of await collect(provider.session())) {
      if (event.type === 'model_response') executedTools.push(...event.response.toolCalls.map((call) => call.id));
    }
    // Model call 2 fails twice upstream before the provider answers.
    const second = await collect(provider.session());

    expect(executedTools).toEqual(['call-1']);
    expect(second).toEqual(finalResponse);
    expect(provider.attempts()).toBe(4);
    expect(provider.waits).toEqual([1_000, 3_000]);
  });

  it('gives up after three tries and says what happened', async () => {
    const provider = scriptedProvider([upstream5xx(), upstream5xx(), upstream5xx()]);

    const error = await collect(provider.session()).catch((caught: unknown) => caught);

    expect(provider.attempts()).toBe(3);
    expect(error).toBeInstanceOf(InferenceProtocolError);
    expect(describeModelCallError(error)).toBe('Anthropic returned a server error. Opfield tried 3 times.');
  });

  it('does not retry once text reached the user', async () => {
    const provider = scriptedProvider([{ partial: 'Removing', error: upstream5xx() }, finalResponse]);

    await expect(collect(provider.session())).rejects.toThrow('Upstream inference request failed');
    expect(provider.attempts()).toBe(1);
  });

  it('does not retry a request the provider rejected', async () => {
    const provider = scriptedProvider([
      new InferenceProtocolError(400, 'invalid_request_error', 'Bad request'),
      finalResponse,
    ]);

    await expect(collect(provider.session())).rejects.toThrow('Bad request');
    expect(provider.attempts()).toBe(1);
  });

  it('does not retry after the run was stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = scriptedProvider([upstream5xx(), finalResponse]);

    await expect(collect(provider.session(controller.signal))).rejects.toThrow();
    expect(provider.attempts()).toBe(1);
  });

  it('waits as long as Retry-After asks, within a bound', () => {
    const overloaded = (retryAfterMs: number) =>
      new InferenceProtocolError(503, 'server_is_overloaded', 'Overloaded', { retryAfterMs });

    expect(retryDelayMs(overloaded(7_000), 1, () => 0)).toBe(7_000);
    expect(retryDelayMs(overloaded(200), 1, () => 0)).toBe(1_000);
    expect(retryDelayMs(overloaded(120_000), 1, () => 0)).toBeNull();
    expect(retryDelayMs(overloaded(7_000), 3, () => 0)).toBeNull();
  });
});

describe('model call error text', () => {
  it('names the provider and the failure', () => {
    expect(describeModelCallError(upstream5xx())).toBe('Anthropic returned a server error.');
    expect(
      describeModelCallError(new InferenceProtocolError(503, 'server_is_overloaded', 'Overloaded', { attempts: 3 }))
    ).toBe('The AI provider is overloaded right now. Opfield tried 3 times.');
    expect(
      describeModelCallError(
        new InferenceProtocolError(502, 'upstream_stream_incomplete', 'ended early', { provider: 'OpenAI' })
      )
    ).toBe('The connection to OpenAI broke before the answer finished.');
    expect(describeModelCallError(new InferenceProtocolError(400, 'context_length_exceeded', 'Too long'))).toBe(
      'Too long'
    );
  });
});
