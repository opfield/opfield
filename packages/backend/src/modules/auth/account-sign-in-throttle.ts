import { createHash } from 'node:crypto';
import { container } from '@/container.js';
import { clientLimitKey } from '@/lib/ip-cidr.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { KnownDevice } from './known-device-cookie.js';

const logger = createChildLogger('AccountSignInThrottle');

/** Failed sign-in checks one account may have from one client address within the window before that pair is locked. */
export const CLIENT_SIGN_IN_FAILURE_LIMIT = 10;
/** Failed checks of one account from all addresses together before the whole account is locked. */
export const ACCOUNT_SIGN_IN_FAILURE_LIMIT = 100;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;

// Takes one attempt before the credential is checked, so parallel guesses cannot all pass the limits at once.
// KEYS: the client's attempts and lock when ARGV[5] is '1' (an address that tells clients apart), then the account's
// attempts and lock when ARGV[6] is '1' (not a known device of the account). Returns {state, ms}: 0 = go ahead,
// 1 = already locked (ms left), 2 = the client lock starts now, 3 = the account lock starts now.
const BEGIN_ATTEMPT_SCRIPT = `
local nextKey = 1
local clientAttempts, clientLock, accountAttempts, accountLock
if ARGV[5] == '1' then
  clientAttempts, clientLock = KEYS[nextKey], KEYS[nextKey + 1]
  nextKey = nextKey + 2
end
if ARGV[6] == '1' then accountAttempts, accountLock = KEYS[nextKey], KEYS[nextKey + 1] end
for _, lockKey in ipairs({clientLock or false, accountLock or false}) do
  if lockKey then
    local lockTtl = redis.call('PTTL', lockKey)
    if lockTtl > 0 then return {1, lockTtl} end
    if lockTtl == -1 then return {1, tonumber(ARGV[4]) * 1000} end
  end
end
if clientAttempts then
  local attempts = redis.call('INCR', clientAttempts)
  if attempts == 1 then redis.call('EXPIRE', clientAttempts, ARGV[3]) end
  if attempts > tonumber(ARGV[1]) then
    redis.call('DEL', clientAttempts)
    redis.call('SET', clientLock, '1', 'EX', ARGV[4])
    return {2, tonumber(ARGV[4]) * 1000}
  end
end
if accountAttempts then
  local attempts = redis.call('INCR', accountAttempts)
  if attempts == 1 then redis.call('EXPIRE', accountAttempts, ARGV[3]) end
  if attempts > tonumber(ARGV[2]) then
    redis.call('DEL', accountAttempts)
    if clientAttempts then redis.call('DECR', clientAttempts) end
    redis.call('SET', accountLock, '1', 'EX', ARGV[4])
    return {3, tonumber(ARGV[4]) * 1000}
  end
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

export function subjectKey(subject: SignInSubject): string {
  if ('userId' in subject) return `user:${subject.userId}`;
  return `email:${createHash('sha256').update(subject.email.trim().toLowerCase()).digest('hex')}`;
}

/**
 * The client a sign-in check comes from. `ip`: its address, only when it tells clients apart
 * (getDistinctClientIpForContext). `knownDevice`: the account and device a valid known-device cookie of this browser
 * names (readKnownDevice).
 */
export interface SignInClient {
  ip?: string;
  knownDevice?: KnownDevice;
}

/**
 * What the per-client limits count for a client: its address (an IPv6 one by its /64), or, without an address that
 * tells clients apart, the known-device token of the account so a known device is never unlimited.
 */
export function clientCounterKey(subject: SignInSubject, client: SignInClient): string | undefined {
  if (client.ip) return `ip:${clientLimitKey(client.ip)}`;
  if (isKnownDeviceOf(subject, client)) return `device:${client.knownDevice!.deviceKey}`;
  return undefined;
}

export function isKnownDeviceOf(subject: SignInSubject, client: SignInClient): boolean {
  return 'userId' in subject && client.knownDevice?.userId === subject.userId;
}

interface AttemptKeys {
  client?: { attempts: string; lock: string };
  account?: { attempts: string; lock: string };
}

function attemptKeys(subject: SignInSubject, client: SignInClient): AttemptKeys {
  const account = subjectKey(subject);
  const clientKey = clientCounterKey(subject, client);
  return {
    ...(clientKey
      ? {
          client: {
            attempts: `auth:sign-in:attempts:${account}:${clientKey}`,
            lock: `auth:sign-in:locked:${account}:${clientKey}`,
          },
        }
      : {}),
    ...(isKnownDeviceOf(subject, client)
      ? {}
      : { account: { attempts: `auth:sign-in:attempts:${account}`, lock: `auth:sign-in:locked:${account}` } }),
  };
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
 * 10 failures of one account from one client address (an IPv6 client by its /64) within 15 minutes lock that account
 * for that address for 15 minutes (429), so a guesser cannot lock its owner out from elsewhere. 100 failures from all
 * addresses together lock the account everywhere for 15 minutes, which still bounds guessing spread over many
 * addresses. Without a client address that tells clients apart (behind an untrusted proxy every client has the
 * proxy's), only the account-wide limit applies, so one client cannot lock everybody else out at 10.
 *
 * A browser that signed in to the account before carries a known-device cookie for it and is not held by the
 * account-wide lock; its own per-address lock still applies, or without a usable address a lock per device token.
 * Residual: while an attacker keeps the account-wide lock up, a targeted account cannot sign in from a new device or a
 * browser without that cookie.
 */
export class AccountSignInThrottle {
  constructor(private readonly cache: Pick<CacheService, 'getClient'>) {}

  /** Takes an attempt before the credential is checked; throws 429 while the account is locked for this client. */
  async beginAttempt(subject: SignInSubject, factor: SignInFactor, client: SignInClient = {}): Promise<void> {
    const keys = attemptKeys(subject, client);
    const keyList = [keys.client, keys.account].flatMap((pair) => (pair ? [pair.attempts, pair.lock] : []));
    if (keyList.length === 0) return;
    const result = await this.cache
      .getClient()
      .eval(
        BEGIN_ATTEMPT_SCRIPT,
        keyList.length,
        ...keyList,
        CLIENT_SIGN_IN_FAILURE_LIMIT,
        ACCOUNT_SIGN_IN_FAILURE_LIMIT,
        FAILURE_WINDOW_SECONDS,
        LOCK_SECONDS,
        keys.client ? '1' : '0',
        keys.account ? '1' : '0'
      );
    const [state, retryAfterMs] = Array.isArray(result) ? result.map(Number) : [0, 0];
    if (!state) return;
    if (state === 2 || state === 3) await this.auditLock(subject, factor, state === 3 ? 'account' : 'client');
    throw signInLocked(retryAfterMs || LOCK_SECONDS * 1000);
  }

  /** The credential was correct: its attempt does not count as a failure. */
  async attemptSucceeded(subject: SignInSubject, client: SignInClient = {}): Promise<void> {
    const keys = attemptKeys(subject, client);
    const attemptCounters = [keys.client?.attempts, keys.account?.attempts].filter((key): key is string => !!key);
    if (attemptCounters.length === 0) return;
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
