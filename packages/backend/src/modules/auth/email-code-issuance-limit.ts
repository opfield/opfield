import { nanoid } from 'nanoid';
import { AppError } from '@/middleware/error-handler.js';
import type { CacheService } from '@/services/cache.service.js';
import {
  clientCounterKey,
  isKnownDeviceOf,
  type SignInClient,
  type SignInSubject,
  subjectKey,
} from './account-sign-in-throttle.js';

/** Codes one client (address, IPv6 /64, or known-device token) may have sent to one account per hour. */
export const EMAIL_CODES_PER_CLIENT = 5;
/** Codes one account may be sent per hour from all clients together; a known device of the account is not held. */
export const EMAIL_CODES_PER_ACCOUNT = 30;
const WINDOW_SECONDS = 60 * 60;

// Sliding windows (sorted sets), all or nothing: KEYS are the windows to count in, ARGV[4 + i] the limit of KEYS[i].
// Returns {1, 0} when a slot was taken in every window, else {0, ms until the fullest window frees one}.
const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[3]) * 1000
local retryMs = 0
for i, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
  if redis.call('ZCARD', key) >= tonumber(ARGV[3 + i]) then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local waitMs = tonumber(oldest[2]) + windowMs - now
    if waitMs > retryMs then retryMs = waitMs end
  end
end
if retryMs > 0 then
  if retryMs < 1000 then retryMs = 1000 end
  return {0, retryMs}
end
for _, key in ipairs(KEYS) do
  redis.call('ZADD', key, now, ARGV[2])
  redis.call('EXPIRE', key, ARGV[3])
end
return {1, 0}
`;

/**
 * Limits unauthenticated sign-in code emails. Counted per account and client, so one client cannot use up an
 * account's codes for everybody: 5 per hour per client, and 30 per hour per account from all clients, which a known
 * device of the account does not count against. Over a limit the request is refused with 429 and Retry-After, for
 * unknown addresses the same way (they are counted under their normalized email), so the answer reveals nothing.
 */
export class EmailCodeIssuanceLimit {
  constructor(private readonly cache: Pick<CacheService, 'getClient'>) {}

  async reserve(subject: SignInSubject, client: SignInClient = {}): Promise<void> {
    const account = subjectKey(subject);
    const clientKey = clientCounterKey(subject, client);
    const windows: Array<[string, number]> = [
      ...(clientKey ? [[`auth:email-code:${account}:${clientKey}`, EMAIL_CODES_PER_CLIENT] as [string, number]] : []),
      ...(isKnownDeviceOf(subject, client)
        ? []
        : [[`auth:email-code:${account}`, EMAIL_CODES_PER_ACCOUNT] as [string, number]]),
    ];
    if (windows.length === 0) return;
    const result = await this.cache
      .getClient()
      .eval(
        RESERVE_SCRIPT,
        windows.length,
        ...windows.map(([key]) => key),
        Date.now(),
        nanoid(12),
        WINDOW_SECONDS,
        ...windows.map(([, limit]) => limit)
      );
    const [allowed, retryAfterMs] = Array.isArray(result) ? result.map(Number) : [0, WINDOW_SECONDS * 1000];
    if (allowed === 1) return;
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAfterMs || WINDOW_SECONDS * 1000) / 1000));
    const minutes = Math.ceil(retryAfterSeconds / 60);
    throw new AppError(
      429,
      'EMAIL_CODE_RATE_LIMITED',
      `Too many sign-in codes were requested for this address. Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
      { retryAfterSeconds }
    );
  }
}
