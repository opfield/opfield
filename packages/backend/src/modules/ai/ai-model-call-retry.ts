import { createChildLogger } from '@/lib/logger.js';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type { ModelProviderEvent } from './ai.provider-adapter.js';

const logger = createChildLogger('AIModelCallRetry');

/** One model call is tried at most this many times: the first try plus two retries. */
export const MODEL_CALL_MAX_ATTEMPTS = 3;
/** Backoff before retry 1 and retry 2; a jitter of up to MODEL_CALL_RETRY_JITTER_MS is added. */
const MODEL_CALL_RETRY_BACKOFF_MS = [1_000, 3_000] as const;
const MODEL_CALL_RETRY_JITTER_MS = 500;
/** A Retry-After above this is not worth holding the run for; the run fails and the user can press Retry. */
const MODEL_CALL_MAX_RETRY_AFTER_MS = 20_000;

/**
 * Provider failures that say nothing about the request itself: a server error, an overloaded provider,
 * or a stream that broke. The same model call usually succeeds a moment later.
 */
const TRANSIENT_MODEL_CALL_CODES = new Set([
  'provider_request_failed',
  'provider_unavailable',
  'upstream_error',
  'upstream_server_error',
  'upstream_stream_incomplete',
  'server_error',
  'server_is_overloaded',
  'overloaded_error',
  'api_error',
  'internal_server_error',
  'inference_core_stream_failed',
]);

export interface ModelCallRetryInput {
  createAttempt: () => AsyncGenerator<ModelProviderEvent>;
  requestId: string;
  conversationId?: string;
  model: string;
  signal: AbortSignal;
  /** Test seam: waits between attempts. */
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * Runs one model call and retries it on a transient provider failure, up to MODEL_CALL_MAX_ATTEMPTS tries.
 * Only the model call is repeated, and only before its final response (tool calls come only with it): when
 * the stream broke after some text, a `text_reset` first tells the caller to drop that text, so the retried
 * answer replaces it instead of following it.
 */
export async function* streamModelCallWithRetry(input: ModelCallRetryInput): AsyncGenerator<ModelProviderEvent> {
  const wait = input.wait ?? waitForModelCallRetry;
  const random = input.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    let streamedChars = 0;
    let responded = false;
    try {
      for await (const event of input.createAttempt()) {
        if (event.type === 'text_delta') streamedChars += event.content.length;
        if (event.type === 'model_response') responded = true;
        yield event;
      }
      return;
    } catch (error) {
      const delayMs = retryDelayMs(error, attempt, random);
      if (input.signal.aborted || responded || delayMs === null) {
        throw attempt > 1 ? withAttempts(error, attempt) : error;
      }
      logger.warn('Retrying a model call after a transient provider failure', {
        requestId: input.requestId,
        conversationId: input.conversationId,
        model: input.model,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        code: error instanceof InferenceProtocolError ? error.code : undefined,
        status: error instanceof InferenceProtocolError ? error.status : undefined,
        discardedChars: streamedChars,
      });
      await wait(delayMs, input.signal);
      if (streamedChars > 0) yield { type: 'text_reset', discardedChars: streamedChars };
    }
  }
}

/** The wait before the next attempt, or null when the failure must not be retried. */
export function retryDelayMs(error: unknown, attempt: number, random: () => number = Math.random): number | null {
  if (attempt >= MODEL_CALL_MAX_ATTEMPTS || !isTransientModelCallError(error)) return null;
  const backoff =
    (MODEL_CALL_RETRY_BACKOFF_MS[attempt - 1] ?? MODEL_CALL_RETRY_BACKOFF_MS.at(-1)!) +
    Math.floor(random() * (MODEL_CALL_RETRY_JITTER_MS + 1));
  const retryAfterMs = error.details?.retryAfterMs;
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs)) return backoff;
  if (retryAfterMs > MODEL_CALL_MAX_RETRY_AFTER_MS) return null;
  return Math.max(backoff, retryAfterMs);
}

export function isTransientModelCallError(error: unknown): error is InferenceProtocolError {
  return error instanceof InferenceProtocolError && TRANSIENT_MODEL_CALL_CODES.has(error.code);
}

function withAttempts(error: unknown, attempts: number): unknown {
  if (!(error instanceof InferenceProtocolError)) return error;
  return new InferenceProtocolError(error.status, error.code, error.message, { ...error.details, attempts });
}

function waitForModelCallRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

const SERVER_ERROR_CODES = new Set([
  'upstream_error',
  'upstream_server_error',
  'server_error',
  'api_error',
  'internal_server_error',
  'provider_request_failed',
]);
const OVERLOADED_CODES = new Set(['server_is_overloaded', 'overloaded_error']);
const BROKEN_STREAM_CODES = new Set(['upstream_stream_incomplete', 'inference_core_stream_failed']);

/**
 * What went wrong with a model call, in words a user understands: who failed and how, not only
 * "Upstream inference request failed". Errors that already explain themselves keep their message.
 */
export function describeModelCallError(error: unknown): string {
  const fallback = error instanceof Error && error.message.trim() ? error.message.trim() : 'The AI request failed';
  if (!(error instanceof InferenceProtocolError)) return fallback;
  const provider =
    typeof error.details?.provider === 'string' && error.details.provider ? error.details.provider : 'The AI provider';
  const attempts = typeof error.details?.attempts === 'number' ? error.details.attempts : 1;
  const tried = attempts > 1 ? ` Opfield tried ${attempts} times.` : '';
  if (OVERLOADED_CODES.has(error.code)) return `${provider} is overloaded right now.${tried}`;
  if (SERVER_ERROR_CODES.has(error.code)) return `${provider} returned a server error.${tried}`;
  if (BROKEN_STREAM_CODES.has(error.code)) {
    return `The connection to ${lowerFirst(provider)} broke before the answer finished.${tried}`;
  }
  if (error.code === 'provider_unavailable') return `${provider} is unavailable right now.${tried}`;
  if (error.code === 'inference_core_unavailable') return 'Opfield Inference is unavailable right now.';
  return fallback;
}

function lowerFirst(value: string): string {
  return value.startsWith('The ') ? `the ${value.slice(4)}` : value;
}
