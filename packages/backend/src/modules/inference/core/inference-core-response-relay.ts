import { contentFilterStop } from '../accounting/inference-accounting.helpers.js';
import type { InferenceCoreUsage } from './inference-core.contract.js';
import { chatCompletionUsage } from './inference-core-chat-usage.js';
import type { CoreModelIdRewriter } from './inference-core-model-rewrite.js';
import { PublishedModelJsonBody, ResponsesSseModelRewriter } from './inference-core-published-model.js';
import { CoreResponsesSseObserver, type CoreSseWire } from './inference-core-sse-observer.js';

export type CoreStreamOutcome = 'completed' | 'failed' | 'cancelled';

/** What a relayed Chat Completions answer showed: its usage and whether output reached the client. */
export interface ChatRelayObservation {
  usage: InferenceCoreUsage | null;
  emittedOutput: boolean;
}

/**
 * Relay a core response body to the client. SSE streams are watched for the
 * wire's own terminal event (Responses `response.completed`, Chat Completions
 * `[DONE]`, Messages `message_stop`); a stream that ends without one gets a
 * synthetic failure in the same wire. Every chunk carries the published model
 * id instead of the core's internal one. A non-stream Chat or Responses answer
 * is held so its `model` names the published id (and a Chat `usage` can be
 * read); a Responses stream gets the published id in `response.model`.
 */
export function relayCoreResponseBody(
  body: ReadableStream<Uint8Array>,
  options: {
    requestId: string;
    contentType: string;
    upstreamStatus: number;
    wire: CoreSseWire;
    modelIds: CoreModelIdRewriter | null;
    /** The id the client must see in an answer's `model`; absent where the endpoint model stays (images). */
    publicModelId?: string;
    /** Chat Completions only: where to record what the answer showed. */
    chatObserved?: ChatRelayObservation;
    abortUpstream: (reason?: unknown) => void;
    clientGone: () => boolean;
    finalize: (outcome: CoreStreamOutcome, error?: unknown) => void;
  }
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const isSse = options.contentType.toLowerCase().includes('text/event-stream');
  const encoder = new TextEncoder();
  const sseObserver = new CoreResponsesSseObserver(options.wire);
  const modelIds = options.modelIds;
  const chat = options.chatObserved;
  const publicModelId = options.publicModelId;
  const ok = options.upstreamStatus < 400;
  const heldWire = options.wire === 'chat_completions' || options.wire === 'responses';
  // A successful non-stream Chat or Responses answer: held whole, then relayed with the published model id.
  const heldJson =
    publicModelId && heldWire && !isSse && ok && options.contentType.toLowerCase().includes('json')
      ? new PublishedModelJsonBody(publicModelId)
      : null;
  const responsesModel =
    publicModelId && isSse && options.wire === 'responses' ? new ResponsesSseModelRewriter(publicModelId) : null;
  let terminal: Exclude<CoreStreamOutcome, 'cancelled'> | null = null;
  let settled = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastOutputAt = Date.now();
  const settle = (outcome: CoreStreamOutcome, error?: unknown) => {
    if (settled) return;
    settled = true;
    if (heartbeat) clearInterval(heartbeat);
    sseObserver.clear();
    options.finalize(outcome, error);
  };
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array | null | undefined) => {
    if (!bytes?.byteLength) return;
    if (chat && ok) chat.emittedOutput = true;
    controller.enqueue(bytes);
  };
  const enqueueHeld = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const held = modelIds?.flush();
    if (responsesModel) {
      if (held?.byteLength) send(controller, responsesModel.push(held));
      send(controller, responsesModel.flush());
      return;
    }
    if (!heldJson) {
      send(controller, held);
      return;
    }
    if (held?.byteLength) send(controller, heldJson.push(held));
    const finished = heldJson.finish();
    const usage = chat ? chatCompletionUsage(finished.parsed?.usage) : null;
    if (chat && usage) chat.usage = usage;
    send(controller, finished.body);
  };
  const failedTail = (error?: unknown) => encoder.encode(streamFailureTail(options.wire, options.requestId, error));

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!isSse) return;
      // Native compaction can stay silent for minutes. Keep the public HTTP stream
      // active without inventing model events or letting keepalives count as output.
      const keepalive = encoder.encode(': opfield keepalive\n\n');
      controller.enqueue(keepalive);
      heartbeat = setInterval(() => {
        // Never splice a comment into a fragmented SSE event, or queue unbounded
        // heartbeats behind a slow/disconnected consumer.
        if (settled || sseObserver.hasPendingFrame || (controller.desiredSize ?? 0) <= 0) return;
        if (Date.now() - lastOutputAt < 15_000) return;
        controller.enqueue(keepalive);
        lastOutputAt = Date.now();
      }, 15_000);
      heartbeat.unref();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (settled) return;
        if (!done) {
          if (isSse) {
            terminal = sseObserver.observe(value);
            if (chat && sseObserver.chatUsage) chat.usage = sseObserver.chatUsage;
          }
          const output = modelIds ? modelIds.push(value) : value;
          const relayed = responsesModel ? responsesModel.push(output) : output;
          send(controller, heldJson && relayed.byteLength ? heldJson.push(relayed) : relayed);
          lastOutputAt = Date.now();
          if (terminal) {
            void reader.cancel('Inference stream terminal event received').catch(() => undefined);
            enqueueHeld(controller);
            settle(terminal, sseObserver.contentFiltered ? contentFilterStop() : undefined);
            controller.close();
          }
          return;
        }
        enqueueHeld(controller);
        if (isSse && !terminal) {
          controller.enqueue(failedTail());
          settle('failed', new Error('Inference core stream ended without a terminal event'));
        } else {
          settle(
            terminal ?? (options.upstreamStatus < 400 ? 'completed' : 'failed'),
            sseObserver.contentFiltered ? contentFilterStop() : undefined
          );
        }
        controller.close();
      } catch (error) {
        if (settled) return;
        options.abortUpstream(error);
        void reader.cancel(error).catch(() => undefined);
        if (options.clientGone()) {
          settle('cancelled', error);
          try {
            controller.error(error);
          } catch {
            // Client already disconnected.
          }
          return;
        }
        if (isSse && !terminal) {
          try {
            enqueueHeld(controller);
            controller.enqueue(failedTail(error));
            controller.close();
          } catch {
            // Client disappeared while the synthetic terminal was emitted.
          }
          settle('failed', error);
          return;
        }
        settle(terminal ?? 'failed', error);
        try {
          controller.error(error);
        } catch {
          // Client already disconnected.
        }
      }
    },
    cancel(reason) {
      options.abortUpstream(reason);
      void reader.cancel(reason).catch(() => undefined);
      settle('cancelled', reason);
    },
  });
}

/** A synthetic terminal failure in the client's wire, after any partial frame. */
function streamFailureTail(wire: CoreSseWire, requestId: string, error?: unknown): string {
  const message = `Inference core stream terminated unexpectedly${
    error instanceof Error && error.message ? `: ${error.message}` : ''
  }`.slice(0, 500);
  if (wire === 'chat_completions') {
    // Same shape the core uses for a failed Chat stream: an error frame and no `[DONE]`.
    return `\n\ndata: ${JSON.stringify({
      error: { type: 'upstream_error', code: 'inference_core_stream_reset', message },
    })}\n\n`;
  }
  if (wire === 'messages') {
    return `\n\nevent: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`;
  }
  const failure = { type: 'upstream_error', code: 'inference_core_stream_reset', message };
  return `\n\nevent: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: {
      id: `resp_${requestId}`,
      object: 'response',
      status: 'failed',
      output: [],
      error: failure,
      last_error: failure,
    },
  })}\n\ndata: [DONE]\n\n`;
}
