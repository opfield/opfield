/** Retry-After as delay seconds or an HTTP date, in milliseconds. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Retry-After delay seconds for an error's details: `retryAfterSeconds`, or the
 * time left until `recoveryAt` (at least 1 s, so a client never retries in a loop).
 */
export function retryAfterSecondsFromDetails(
  details: Record<string, unknown> | undefined,
  now = Date.now()
): number | undefined {
  const seconds = details?.retryAfterSeconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const recoveryAt = details?.recoveryAt;
  if (typeof recoveryAt !== 'string') return undefined;
  const at = Date.parse(recoveryAt);
  if (Number.isNaN(at)) return undefined;
  return Math.max(1, Math.ceil((at - now) / 1000));
}
