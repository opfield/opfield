import { createHash } from 'node:crypto';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import type { CacheService } from '@/services/cache.service.js';

const logger = createChildLogger('AccountSignInThrottle');

/** Failed sign-in checks one account may have from one client address within the window before that pair is locked. */
export const CLIENT_SIGN_IN_FAILURE_LIMIT = 10;
/** Failed checks of one account from all addresses together before the whole account is locked. */
export const ACCOUNT_SIGN_IN_FAILURE_LIMIT = 100;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;

// Takes one attempt before the credential is checked, so parallel guesses cannot all pass the limits at once.
// KEYS: account attempts, account lock, then (when the client address tells clients apart) client attempts and
// client lock. Returns {state, ms}: 0 = go ahead, 1 = already locked (ms left), 2 = the client lock starts now,
// 3 = the account lock starts now.
const BEGIN_ATTEMPT_SCRIPT = `
local withClient = #KEYS == 4
local locks = withClient and {KEYS[2], KEYS[4]} or {KEYS[2]}
for _, lockKey in ipairs(locks) do
  local lockTtl = redis.call('PTTL', lockKey)
  if lockTtl > 0 then return {1, lockTtl} end
  if lockTtl == -1 then return {1, tonumber(ARGV[4]) * 1000} end
end
if withClient then
  local clientAttempts = redis.call('INCR', KEYS[3])
  if clientAttempts == 1 then redis.call('EXPIRE', KEYS[3], ARGV[3]) end
  if clientAttempts > tonumber(ARGV[1]) then
    redis.call('DEL', KEYS[3])
    redis.call('SET', KEYS[4], '1', 'EX', ARGV[4])
    return {2, tonumber(ARGV[4]) * 1000}
  end
end
local accountAttempts = redis.call('INCR', KEYS[1])
if accountAttempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
if accountAttempts > tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  if withClient then redis.call('DECR', KEYS[3]) end
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[4])
  return {3, tonumber(ARGV[4]) * 1000}
end
return {0, 0}
`;

// A correct credential gives its attempt back: only failures count towards the locks.
const RELEASE_ATTEMPT_SCRIPT = `
for _, key in ipairs(KEYS) do
  local attempts = tonumber(redis.call('GET', key) or '0')
  if attempts > 0 then redis.call('DECR', key) end
end
return 0
`;

/** The account a sign-in is for: its user, or the normalized email entered when no user has it. */
export type SignInSubject = { userId: string } | { email: string };

export type SignInFactor = 'password' | 'email_otp' | 'mfa';

function subjectKey(subject: SignInSubject): string {
  if ('userId' in subject) return `user:${subject.userId}`;
  return `email:${createHash('sha256').update(subject.email.trim().toLowerCase()).digest('hex')}`;
}

/** Account keys, then client keys when the address tells clients apart (undefined: account-wide limit only). */
function attemptKeys(subject: SignInSubject, clientIp: string | undefined): string[] {
  const account = subjectKey(subject);
  const keys = [`auth:sign-in:attempts:${account}`, `auth:sign-in:locked:${account}`];
  if (!clientIp) return keys;
  const client = `${account}:ip:${clientIp}`;
  return [...keys, `auth:sign-in:attempts:${client}`, `auth:sign-in:locked:${client}`];
}

function signInLocked(retryAfterMs: number): AppError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return new AppError(
    429,
    'SIGN_IN_LOCKED',
    `Too many failed sign-in attempts for this account. Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    { retryAfterSeconds }
  );
}

/**
 * Per-account limit on password, email code and second-factor checks, on top of the per-address request limit.
 * 10 failures of one account from one client address within 15 minutes lock that account for that address for 15
 * minutes (429), so a guesser cannot lock its owner out from elsewhere; 100 failures from all addresses together lock
 * the account everywhere for 15 minutes, which still bounds guessing spread over many addresses. Without a client
 * address that tells clients apart (behind an untrusted proxy every client has the proxy's), only the account-wide
 * limit applies, so one client cannot lock everybody else out at 10.
 */
export class AccountSignInThrottle {
  constructor(private readonly cache: Pick<CacheService, 'getClient'>) {}

  /**
   * Takes an attempt before the credential is checked; throws 429 while the account is locked for this client.
   * `clientIp` is the client address only when it tells clients apart (getDistinctClientIpForContext).
   */
  async beginAttempt(subject: SignInSubject, factor: SignInFactor, clientIp: string | undefined): Promise<void> {
    const keys = attemptKeys(subject, clientIp);
    const result = await this.cache
      .getClient()
      .eval(
        BEGIN_ATTEMPT_SCRIPT,
        keys.length,
        ...keys,
        CLIENT_SIGN_IN_FAILURE_LIMIT,
        ACCOUNT_SIGN_IN_FAILURE_LIMIT,
        FAILURE_WINDOW_SECONDS,
        LOCK_SECONDS
      );
    const [state, retryAfterMs] = Array.isArray(result) ? result.map(Number) : [0, 0];
    if (!state) return;
    if (state === 2 || state === 3) await this.auditLock(subject, factor, state === 3 ? 'account' : 'client');
    throw signInLocked(retryAfterMs || LOCK_SECONDS * 1000);
  }

  /** The credential was correct: its attempt does not count as a failure. */
  async attemptSucceeded(subject: SignInSubject, clientIp: string | undefined): Promise<void> {
    const attemptCounters = attemptKeys(subject, clientIp).filter((key) => key.startsWith('auth:sign-in:attempts:'));
    await this.cache.getClient().eval(RELEASE_ATTEMPT_SCRIPT, attemptCounters.length, ...attemptCounters);
  }

  private async auditLock(subject: SignInSubject, factor: SignInFactor, scope: 'client' | 'account'): Promise<void> {
    logger.warn('Sign-in locked after repeated failures', { subject: subjectKey(subject), factor, scope });
    if (!container.isRegistered(AuditService)) return;
    await container
      .resolve(AuditService)
      .log({
        userId: 'userId' in subject ? subject.userId : null,
        action: 'auth.login_failed',
        resourceType: 'session',
        details: {
          method: factor,
          reason: scope === 'account' ? 'account_locked' : 'account_locked_for_client',
          failures: scope === 'account' ? ACCOUNT_SIGN_IN_FAILURE_LIMIT : CLIENT_SIGN_IN_FAILURE_LIMIT,
          lockSeconds: LOCK_SECONDS,
          ...('email' in subject ? { email: subject.email.trim().toLowerCase().slice(0, 320) } : {}),
        },
      })
      .catch(() => undefined);
  }
}
