import { describe, expect, it, vi } from 'vitest';
import { CoreModelIdRewriter } from './inference-core-model-rewrite.js';
import { type CoreStreamOutcome, relayCoreResponseBody } from './inference-core-response-relay.js';

const encoder = new TextEncoder();

/** One network read per chunk, the way a large frame reaches Opfield from the core. */
function coreBody(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next);
    },
  });
}

function relay(
  chunks: Array<string | Uint8Array>,
  options: Partial<Parameters<typeof relayCoreResponseBody>[1]> & { contentType: string }
) {
  const finalize = vi.fn<(outcome: CoreStreamOutcome, error?: unknown) => void>();
  const stream = relayCoreResponseBody(coreBody(chunks), {
    requestId: 'request-1',
    upstreamStatus: 200,
    wire: 'responses',
    modelIds: null,
    publicModelId: 'published',
    abortUpstream: vi.fn(),
    clientGone: () => false,
    finalize,
    ...options,
  });
  return { text: new Response(stream).text(), finalize };
}

function completedFrame(model: string): Uint8Array {
  return encoder.encode(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { model, output: 'x'.repeat(30_000) },
    })}\n\n`
  );
}

describe('relayCoreResponseBody', () => {
  // Prod: Codex streams froze on this frame, with no keepalive, until something on the path gave up.
  it('relays a Responses frame that arrives across several reads', async () => {
    const completed = completedFrame('core-model');
    const { text, finalize } = relay(
      [
        'event: response.output_item.done\ndata: {"type":"response.output_item.done"}\n\n',
        completed.subarray(0, 10_000),
        completed.subarray(10_000, 20_000),
        completed.subarray(20_000),
      ],
      { contentType: 'text/event-stream' }
    );

    const body = await text;

    expect(body).toContain('"model":"published"');
    expect(body.endsWith('\n\n')).toBe(true);
    expect(finalize).toHaveBeenCalledWith('completed', undefined);
  });

  it('relays a stream whose first read holds no complete frame', async () => {
    const completed = completedFrame('core-model');
    const { text, finalize } = relay([completed.subarray(0, 100), completed.subarray(100)], {
      contentType: 'text/event-stream',
    });

    expect(await text).toContain('"model":"published"');
    expect(finalize).toHaveBeenCalledWith('completed', undefined);
  });

  it('relays a Chat stream when a read ends inside the core model id', async () => {
    const modelIds = CoreModelIdRewriter.create('core-model', 'published');
    const { text, finalize } = relay(['data: {"model":"core-', 'mo', 'del","choices":[]}\n\n', 'data: [DONE]\n\n'], {
      contentType: 'text/event-stream',
      wire: 'chat_completions',
      modelIds,
      publicModelId: undefined,
    });

    expect(await text).toContain('"model":"published"');
    expect(finalize).toHaveBeenCalledWith('completed', undefined);
  });

  it('holds a non-stream answer across several reads and relays it whole', async () => {
    const { text, finalize } = relay(['{"model":"core-model",', '"id":', '"resp_1"}'], {
      contentType: 'application/json',
    });

    expect(JSON.parse(await text)).toEqual({ model: 'published', id: 'resp_1' });
    expect(finalize).toHaveBeenCalledWith('completed', undefined);
  });
});
