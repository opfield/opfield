import type { InferenceCoreAdmissionResponse } from '../core/inference-core.contract.js';
import { retryAfterSecondsFromDetails } from '../core/inference-retry-after.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';

/**
 * Error codes of a budget refusal. Every inference path answers an exhausted budget with
 * HTTP 429, one of these codes, `details.recoveryAt` / `details.dimension`, and Retry-After.
 */
export const BUDGET_EXHAUSTED_CODES: ReadonlySet<string> = new Set([
  'subscription_budget_exhausted',
  'api_budget_exhausted',
  'provider_api_budget_exhausted',
]);

export function isBudgetExhausted(error: unknown): error is InferenceProtocolError {
  return error instanceof InferenceProtocolError && BUDGET_EXHAUSTED_CODES.has(error.code);
}

/** The refusal the client sees: when and which window recovers, never a connection's spend or limit. */
export function clientBudgetDenial(error: InferenceProtocolError): InferenceProtocolError {
  const details: Record<string, unknown> = {};
  for (const key of ['recoveryAt', 'dimension']) {
    if (error.details?.[key] !== undefined) details[key] = error.details[key];
  }
  return new InferenceProtocolError(error.status, error.code, error.message, details);
}

/**
 * A refusal that belongs to the selected connection (its monthly API limit), not to the user:
 * another connection of the model may still serve the request.
 */
export function connectionScopedDenial(denial: InferenceProtocolError): boolean {
  return denial.code === 'provider_api_budget_exhausted';
}

export function subscriptionBudgetExhausted(recoveryAt: Date | null, dimension: string | null): InferenceProtocolError {
  return new InferenceProtocolError(429, 'subscription_budget_exhausted', 'Inference budget exhausted', {
    ...(recoveryAt ? { recoveryAt: recoveryAt.toISOString() } : {}),
    ...(dimension ? { dimension } : {}),
  });
}

export function modelDisabledDenial(): InferenceProtocolError {
  return new InferenceProtocolError(403, 'model_disabled', 'The model is currently unavailable');
}

export function tenantRevokedDenial(): InferenceProtocolError {
  return new InferenceProtocolError(403, 'permission_denied', 'Inference is disabled for this user');
}

/** The admission verdict the core receives for a refusal Opfield answers with `denial`. */
export function coreDenyResponse(denial: InferenceProtocolError): InferenceCoreAdmissionResponse {
  if (denial.code === 'model_disabled') return { decision: 'deny', reason: 'model_disabled' };
  if (!BUDGET_EXHAUSTED_CODES.has(denial.code)) return { decision: 'deny', reason: 'tenant_revoked' };
  const retryAfterSeconds = retryAfterSecondsFromDetails(denial.details);
  return {
    decision: 'deny',
    reason: 'budget_exceeded',
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

/**
 * The core answers its own admission refusal in its own terms (an old core: 402
 * `rate_limit_error`, no Retry-After reaching the client). Opfield keeps the refusal it
 * decided for the root request a little while, so the proxy can answer the client with it.
 */
export const ADMISSION_DENIAL_TTL_SECONDS = 600;

export function admissionDenialKey(requestId: string): string {
  return `inference:admission-denial:${requestId}`;
}

export function serializeDenial(denial: InferenceProtocolError): string {
  return JSON.stringify({
    status: denial.status,
    code: denial.code,
    message: denial.message,
    ...(denial.details ? { details: denial.details } : {}),
  });
}

export function parseDenial(raw: string | null): InferenceProtocolError | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
    if (
      (value.status !== 429 && value.status !== 403) ||
      typeof value.code !== 'string' ||
      typeof value.message !== 'string'
    ) {
      return null;
    }
    const details =
      value.details && typeof value.details === 'object' && !Array.isArray(value.details)
        ? (value.details as Record<string, unknown>)
        : undefined;
    return new InferenceProtocolError(value.status, value.code, value.message, details);
  } catch {
    return null;
  }
}
