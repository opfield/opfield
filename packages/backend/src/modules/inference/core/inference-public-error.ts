import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';

/** What a client is told when the provider behind a model fails; how Opfield reaches providers stays inside. */
export const PROVIDER_FAILURE_MESSAGE = 'The model provider could not serve this request. Try again later.';
export const PROVIDER_RATE_LIMIT_MESSAGE = 'The model provider is limiting requests right now. Try again later.';

/**
 * The answer a client gets for a provider failure: the client's own key was already accepted, so a provider's
 * 401/403 or a server error becomes a neutral 502/503, and a provider's rate limit a neutral 429. The provider's own
 * words (its name, the connection behind it, commands to fix it) stay in the server log and the usage record.
 * Request errors (400, 404, 409, 413) keep their message: they describe the client's request.
 */
export function publicProviderStatus(
  status: number
): { status: 429 | 502 | 503; code: string; message: string } | null {
  if (status === 429) return { status: 429, code: 'rate_limit_exceeded', message: PROVIDER_RATE_LIMIT_MESSAGE };
  if (status === 401 || status === 403 || status >= 500) {
    return { status: status === 503 ? 503 : 502, code: 'provider_unavailable', message: PROVIDER_FAILURE_MESSAGE };
  }
  return null;
}

export function publicProviderError(error: InferenceProtocolError): InferenceProtocolError {
  const mapped = publicProviderStatus(error.status);
  return mapped ? new InferenceProtocolError(mapped.status, mapped.code, mapped.message) : error;
}
