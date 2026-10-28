import { createHash } from 'node:crypto';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import type { CacheService } from '@/services/cache.service.js';

const logger = createChildLogger('AccountSignInThrottle');

/** Failed sign-in checks one account may have within the window before it is locked. */
export const ACCOUNT_SIGN_IN_FAILURE_LIMIT = 10;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;

// Takes one attempt before the credential is checked, so parallel guesses cannot all pass the limit at once.
// Returns 0 when the attempt may go ahead, otherwise the lock's remaining milliseconds (negative: the lock starts now).
const BEGIN_ATTEMPT_SCRIPT = `
local lockTtl = redis.call('PTTL', KEYS[2])
if lockTtl > 0 then return lockTtl end
if lockTtl == -1 then return tonumber(ARGV[3]) * 1000 end
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if attempts > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
  return -tonumber(ARGV[3]) * 1000
end
return 0
`;

// A correct credential gives its attempt back: only failures count towards the lock.
const RELEASE_ATTEMPT_SCRIPT = `
local attempts = tonumber(redis.call('GET', KEYS[1]) or '0')
if attempts > 0 then redis.call('DECR', KEYS[1]) end
return 0
`;

/** The account a sign-in is for: its user, or the normalized email entered when no user has it. */
export type SignInSubject = { userId: string } | { email: string };

export type SignInFactor = 'password' | 'email_otp' | 'mfa';

function subjectKey(subject: SignInSubject): string {
  if ('userId' in subject) return `user:${subject.userId}`;
  return `email:${createHash('sha256').update(subject.email.trim().toLowerCase()).digest('hex')}`;
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
 * Per-account limit on password, email code and second-factor checks, on top of the per-address request limit:
 * 10 failures within 15 minutes lock the account's sign-in checks for 15 minutes (429), from any address.
 */
export class AccountSignInThrottle {
  constructor(private readonly cache: Pick<CacheService, 'getClient'>) {}

  /** Takes an attempt for the account before its credential is checked; throws 429 while the account is locked. */
  async beginAttempt(subject: SignInSubject, factor: SignInFactor): Promise<void> {
    const key = subjectKey(subject);
    const result = Number(
      await this.cache
        .getClient()
        .eval(
          BEGIN_ATTEMPT_SCRIPT,
          2,
          `auth:sign-in:attempts:${key}`,
          `auth:sign-in:locked:${key}`,
          ACCOUNT_SIGN_IN_FAILURE_LIMIT,
          FAILURE_WINDOW_SECONDS,
          LOCK_SECONDS
        )
    );
    if (result === 0) return;
    if (result < 0) await this.auditLock(subject, factor);
    throw signInLocked(Math.abs(result));
  }

  /** The credential was correct: its attempt does not count as a failure. */
  async attemptSucceeded(subject: SignInSubject): Promise<void> {
    await this.cache.getClient().eval(RELEASE_ATTEMPT_SCRIPT, 1, `auth:sign-in:attempts:${subjectKey(subject)}`);
  }

  private async auditLock(subject: SignInSubject, factor: SignInFactor): Promise<void> {
    logger.warn('Sign-in locked after repeated failures', { subject: subjectKey(subject), factor });
    if (!container.isRegistered(AuditService)) return;
    await container
      .resolve(AuditService)
      .log({
        userId: 'userId' in subject ? subject.userId : null,
        action: 'auth.login_failed',
        resourceType: 'session',
        details: {
          method: factor,
          reason: 'account_locked',
          failures: ACCOUNT_SIGN_IN_FAILURE_LIMIT,
          lockSeconds: LOCK_SECONDS,
          ...('email' in subject ? { email: subject.email.trim().toLowerCase().slice(0, 320) } : {}),
        },
      })
      .catch(() => undefined);
  }
}
