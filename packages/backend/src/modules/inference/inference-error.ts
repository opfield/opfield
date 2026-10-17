import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '@/types.js';
import { retryAfterSecondsFromDetails } from './core/inference-retry-after.js';
import { LEGACY_INFERENCE_ERROR_TYPE } from '@/lib/legacy-compat.js';

export type InferenceErrorCode =
  | 'invalid_api_key'
  | 'permission_denied'
  | 'rate_limit_exceeded'
  | 'budget_exhausted'
  | 'service_unavailable'
  | 'not_found'
  | 'not_implemented';

function isAnthropicPath(path: string): boolean {
  return path.endsWith('/messages') || path.endsWith('/messages/count_tokens');
}

export function inferenceErrorResponse(
  c: Context<AppEnv>,
  status: ContentfulStatusCode | 499,
  code: InferenceErrorCode | string,
  message: string,
  details?: Record<string, unknown>
) {
  // A refusal that knows when it lifts (an exhausted budget) tells the client when to come back.
  const retryAfter = retryAfterSecondsFromDetails(details);
  if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
  if (c.get('inferenceAdapter') === 'anthropic' || isAnthropicPath(c.req.path)) {
    const type =
      status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error';
    return c.json(
      { type: 'error', error: { type, message, ...(details ? { details } : {}) }, request_id: c.get('requestId') },
      status as ContentfulStatusCode
    );
  }

  return c.json(
    {
      error: {
        message,
        type: status === 401 ? 'invalid_request_error' : LEGACY_INFERENCE_ERROR_TYPE,
        param: null,
        code,
        ...(details ? { details } : {}),
      },
    },
    status as ContentfulStatusCode
  );
}
