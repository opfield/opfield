import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { inject, injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { userPasswordCredentials, users } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';
import { AccountSignInThrottle, type SignInClient } from './account-sign-in-throttle.js';
import type { AuthSettingsService } from './auth.settings.service.js';
import type { AuthEmailRateSlot } from './auth-email-queue.service.js';
import type { AuthMailService } from './auth-mail.service.js';

const EMAIL_CHALLENGE_TTL_SECONDS = 10 * 60;
const PASSWORD_LINK_TTL_SECONDS = 30 * 60;
const PASSWORD_RESET_WINDOW_SECONDS = 60 * 60;
const EMAIL_OTP_WINDOW_SECONDS = 60 * 60;
const MAX_PASSWORD_RESETS_PER_WINDOW = 3;
const MAX_EMAIL_OTP_CODES_PER_WINDOW = 5;
const MAX_CHALLENGE_ATTEMPTS = 5;
// A bcrypt hash of a discarded random secret, cost 12 like stored passwords: compared when there is no account or no
// password, so a refused sign-in takes as long whether the account exists or not. Matching it signs nobody in.
const DUMMY_PASSWORD_HASH = '$2b$12$7VBzWZfYBjdpvOuw63qBdu/DPJ9T7PAx6ZXsKNldOATTz2RrwHRwy';

const RESERVE_PASSWORD_RESET_SCRIPT = `
local key = KEYS[1]
local windowStart = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local member = ARGV[3]
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
if redis.call('ZCARD', key) >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfterMs = tonumber(oldest[2]) + ttl * 1000 - now
  if retryAfterMs < 1000 then retryAfterMs = 1000 end
  return {0, retryAfterMs}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, ttl)
return {1, 0}
`;

const CONSUME_AUTH_CHALLENGE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, ''} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return {0, ''}
end
local challenge = cjson.decode(raw)
local allowedPurposes = cjson.decode(ARGV[2])
local purposeAllowed = false
for _, purpose in ipairs(allowedPurposes) do
  if challenge.purpose == purpose then purposeAllowed = true break end
end
if not purposeAllowed then return {0, ''} end
local attempts = tonumber(challenge.attempts) or 0
if attempts >= tonumber(ARGV[3]) then
  redis.call('DEL', KEYS[1])
  return {0, ''}
end
if challenge.secretHash == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {1, raw}
end
attempts = attempts + 1
if attempts >= tonumber(ARGV[3]) then
  redis.call('DEL', KEYS[1])
else
  challenge.attempts = attempts
  redis.call('SET', KEYS[1], cjson.encode(challenge), 'PX', ttl)
end
return {0, ''}
`;

type ChallengePurpose = 'email_otp' | 'password_setup' | 'password_reset';

export interface PasswordLinkProfile {
  name: string;
  email: string;
  avatarUrl: string | null;
  groupName: string;
}

export type EmailSignInContinuation = { method: 'password' } | { method: 'email_otp'; challengeId: string };

interface AuthChallenge {
  userId: string;
  purpose: ChallengePurpose;
  secretHash: string;
  attempts: number;
}

type PasswordLinkPurpose = 'password_setup' | 'password_reset';

function passwordLinkRateLimited(purpose: PasswordLinkPurpose, retryAfterMs: number): AppError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const resetsAt = new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
  const kind = purpose === 'password_setup' ? 'setup' : 'reset';
  return new AppError(
    429,
    purpose === 'password_setup' ? 'PASSWORD_SETUP_RATE_LIMITED' : 'PASSWORD_RESET_RATE_LIMITED',
    `Too many password ${kind} links were requested for this user (${MAX_PASSWORD_RESETS_PER_WINDOW} per hour). ` +
      (purpose === 'password_setup'
        ? 'The setup link sent when the account was created or switched to password counts as one of them. '
        : '') +
      `The limit resets in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} (${resetsAt}).`,
    { retryAfterSeconds, resetsAt }
  );
}

async function storeAuthChallenge(
  cache: Pick<CacheService, 'set'>,
  userId: string,
  purpose: ChallengePurpose,
  secret: string,
  ttlSeconds: number
): Promise<string> {
  const id = nanoid(24);
  await cache.set<AuthChallenge>(
    `local_auth:challenge:${id}`,
    { userId, purpose, secretHash: hashSecret(secret), attempts: 0 },
    ttlSeconds
  );
  return id;
}

/**
 * A one-time password setup link for a user, without email (the link a restored copy's owner opens, see
 * cli/owner-password-link). The same token the emailed link carries; `/reset-password` completes it.
 */
export async function issuePasswordSetupLink(
  cache: Pick<CacheService, 'set'>,
  userId: string,
  baseUrl: string,
  ttlSeconds: number
): Promise<string> {
  const secret = nanoid(32);
  const challengeId = await storeAuthChallenge(cache, userId, 'password_setup', secret, ttlSeconds);
  return new URL(`/reset-password?token=${encodeURIComponent(`${challengeId}.${secret}`)}`, baseUrl).toString();
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@injectable()
export class LocalAuthService {
  private readonly signInThrottle: AccountSignInThrottle;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cacheService: CacheService,
    private readonly sessionService: SessionService,
    private readonly authSettingsService: AuthSettingsService,
    private readonly authMailService: AuthMailService,
    private readonly auditService: AuditService,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {
    this.signInThrottle = new AccountSignInThrottle(cacheService);
  }

  async authenticatePassword(email: string, password: string, client: SignInClient = {}): Promise<User | null> {
    const methods = (await this.authSettingsService.getConfig()).methods;
    if (!methods.password) return this.refusePassword(password);
    const user = await this.db.query.users.findFirst({ where: eq(users.email, normalizeEmail(email)) });
    // Counted per account (an unknown email by itself) and client address, see AccountSignInThrottle.
    const subject = user ? { userId: user.id } : { email };
    await this.signInThrottle.beginAttempt(subject, 'password', client);
    if (!user || user.isBlocked || user.authMethod !== 'password') return this.refusePassword(password);
    const credential = await this.db.query.userPasswordCredentials.findFirst({
      where: eq(userPasswordCredentials.userId, user.id),
    });
    if (!credential) return this.refusePassword(password);
    if (!(await bcrypt.compare(password, credential.passwordHash))) return null;
    await this.signInThrottle.attemptSucceeded(subject, client);
    return resolveLiveUser(this.db, user.id);
  }

  /** A refused password sign-in that took a bcrypt comparison, like a wrong password of an existing account does. */
  private async refusePassword(password: string): Promise<null> {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }

  async beginEmailSignIn(email: string): Promise<EmailSignInContinuation> {
    const methods = (await this.authSettingsService.getConfig()).methods;
    if (!methods.password && !methods.emailOtp) {
      throw new AppError(409, 'EMAIL_SIGN_IN_DISABLED', 'Email sign-in is disabled');
    }

    const otpUser = methods.emailOtp
      ? await this.db.query.users.findFirst({
          where: and(eq(users.email, normalizeEmail(email)), eq(users.authMethod, 'email_otp')),
        })
      : null;
    if (otpUser && !otpUser.isBlocked) {
      const challengeId = await this.requestEmailOtp(email);
      return { method: 'email_otp', challengeId: challengeId ?? crypto.randomUUID() };
    }

    // Password is the generic fallback when both methods are available: unknown, OIDC and password accounts all get
    // it. An email-code account gets a challenge instead, so this answer does tell those accounts apart from the rest
    // (accepted: a uniform answer would change the sign-in flow); the per-account code limit bounds the emails it sends.
    if (methods.password) return { method: 'password' };

    return { method: 'email_otp', challengeId: crypto.randomUUID() };
  }

  async requestEmailOtp(email: string): Promise<string | null> {
    const methods = (await this.authSettingsService.getConfig()).methods;
    if (!methods.emailOtp) return null;
    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, normalizeEmail(email)), eq(users.authMethod, 'email_otp')),
    });
    if (!user || user.isBlocked) return null;
    // At most five codes per account and hour: requesting one is unauthenticated and emails the account.
    const reserved = await this.reserveWindowSlot(
      `local_auth:email_otp:${user.id}`,
      MAX_EMAIL_OTP_CODES_PER_WINDOW,
      EMAIL_OTP_WINDOW_SECONDS
    );
    if (!reserved.slot) return null;
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challengeId = await this.createChallenge(user.id, 'email_otp', code, EMAIL_CHALLENGE_TTL_SECONDS);
    await this.authMailService.sendSecurityEmail(user.email, { kind: 'email_otp', code });
    return challengeId;
  }

  async verifyEmailOtp(challengeId: string, code: string, client: SignInClient = {}): Promise<User | null> {
    const challenge = await this.cacheService.get<AuthChallenge>(`local_auth:challenge:${challengeId}`);
    if (challenge?.purpose !== 'email_otp') return null;
    const subject = { userId: challenge.userId };
    await this.signInThrottle.beginAttempt(subject, 'email_otp', client);
    const userId = await this.consumeChallenge(challengeId, 'email_otp', code);
    if (!userId) return null;
    await this.signInThrottle.attemptSucceeded(subject, client);
    return resolveLiveUser(this.db, userId);
  }

  async sendEmailOtpOnboarding(email: string): Promise<void> {
    const baseUrl = this.generalSettingsService
      ? await this.generalSettingsService.requirePublicUrl()
      : getEnv().APP_URL;
    await this.authMailService.sendSecurityEmail(normalizeEmail(email), {
      kind: 'email_otp_enabled',
      actionUrl: new URL('/login', baseUrl).toString(),
    });
  }

  /**
   * Emails a password link. `wait` (an administrator's action) follows the delivery and reports every reason no email
   * went out as an error: password sign-in off, no such password user, a blocked user, the link throttled (429, with
   * when it resets) or a failed delivery. The public reset never waits and gets null instead, so its answer does not
   * reveal whether the account exists. Null means no email went out.
   *
   * Every link holds one slot of the user's hourly limit for its kind (setup or reset); it is given back when the
   * email does not go out (refused by the cloud, SMTP failure, or any error before the job exists).
   */
  async requestPasswordLink(
    email: string,
    purpose: PasswordLinkPurpose,
    options: { wait?: boolean } = {}
  ): Promise<'sent' | 'queued' | null> {
    const methods = (await this.authSettingsService.getConfig()).methods;
    if (!methods.password) {
      if (options.wait) throw new AppError(409, 'PASSWORD_SIGN_IN_DISABLED', 'Password sign-in is disabled');
      return null;
    }
    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, normalizeEmail(email)), eq(users.authMethod, 'password')),
    });
    if (!user || user.isBlocked) {
      if (options.wait) {
        throw user
          ? new AppError(409, 'USER_BLOCKED', 'The user is blocked, so no password link was sent')
          : new AppError(404, 'NOT_FOUND', 'No password user with this email was found');
      }
      return null;
    }
    // Setup and reset links each hold one slot of the user's hourly limit for their kind.
    const reservation = await this.reservePasswordLink(user.id, purpose);
    if (!reservation.slot) {
      if (options.wait) throw passwordLinkRateLimited(purpose, reservation.retryAfterMs);
      return null;
    }
    const slot = reservation.slot;
    try {
      const secret = nanoid(32);
      const challengeId = await this.createChallenge(user.id, purpose, secret, PASSWORD_LINK_TTL_SECONDS);
      const token = `${challengeId}.${secret}`;
      const baseUrl = this.generalSettingsService
        ? await this.generalSettingsService.requirePublicUrl()
        : getEnv().APP_URL;
      return await this.authMailService.sendSecurityEmail(
        user.email,
        {
          kind: purpose,
          actionUrl: new URL(`/reset-password?token=${encodeURIComponent(token)}`, baseUrl).toString(),
        },
        { ...options, rateSlot: slot ?? undefined }
      );
    } catch (error) {
      await this.releasePasswordLink(slot);
      throw error;
    }
  }

  async getPasswordLinkProfile(token: string): Promise<PasswordLinkProfile | null> {
    const userId = await this.getPasswordLinkUserId(token);
    if (!userId) return null;
    const user = await resolveLiveUser(this.db, userId);
    if (!user || user.isBlocked) return null;
    return {
      name: user.name?.trim() || user.email,
      email: user.email,
      avatarUrl: user.avatarUrl,
      groupName: user.groupName,
    };
  }

  async completePasswordLink(token: string, password: string): Promise<void> {
    const separator = token.indexOf('.');
    if (separator <= 0) throw new AppError(400, 'INVALID_RESET_TOKEN', 'Invalid or expired password link');
    const challengeId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    await this.validatePassword(password);
    const challenge = await this.consumeChallenge(challengeId, ['password_setup', 'password_reset'], secret);
    if (!challenge) throw new AppError(400, 'INVALID_RESET_TOKEN', 'Invalid or expired password link');
    const passwordHash = await bcrypt.hash(password, 12);
    await this.db
      .insert(userPasswordCredentials)
      .values({ userId: challenge, passwordHash, changedAt: new Date() })
      .onConflictDoUpdate({ target: userPasswordCredentials.userId, set: { passwordHash, changedAt: new Date() } });
    await this.sessionService.destroyAllUserSessions(challenge);
    await this.auditService.log({
      userId: challenge,
      action: 'auth.password_changed',
      resourceType: 'user',
      resourceId: challenge,
      details: {},
    });
  }

  async setInitialPasswordForSetup(userId: string, password: string): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user || user.authMethod !== 'password') {
      throw new AppError(409, 'PASSWORD_AUTH_REQUIRED', 'Setup account must use password authentication');
    }
    const existing = await this.db.query.userPasswordCredentials.findFirst({
      where: eq(userPasswordCredentials.userId, userId),
    });
    if (existing) throw new AppError(409, 'PASSWORD_ALREADY_SET', 'The setup password has already been created');

    await this.validatePassword(password);
    const passwordHash = await bcrypt.hash(password, 12);
    await this.db.insert(userPasswordCredentials).values({ userId, passwordHash, changedAt: new Date() });
  }

  async validateInitialPasswordForSetup(password: string): Promise<void> {
    await this.validatePassword(password);
  }

  private async validatePassword(password: string): Promise<void> {
    const policy = (await this.authSettingsService.getConfig()).passwordPolicy;
    const byteLength = Buffer.byteLength(password, 'utf8');
    const allowed =
      byteLength >= policy.minLength &&
      byteLength <= policy.maxLength &&
      (!policy.requireUppercase || /[A-Z]/.test(password)) &&
      (!policy.requireLowercase || /[a-z]/.test(password)) &&
      (!policy.requireDigit || /\d/.test(password)) &&
      (!policy.requireSymbol || /[^A-Za-z0-9]/.test(password));
    if (!allowed) throw new AppError(400, 'PASSWORD_POLICY', 'Password does not meet the configured policy');
  }

  private async getPasswordLinkUserId(token: string): Promise<string | null> {
    const separator = token.indexOf('.');
    if (separator <= 0) return null;
    const challengeId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const challenge = await this.cacheService.get<AuthChallenge>(`local_auth:challenge:${challengeId}`);
    if (!challenge || !['password_setup', 'password_reset'].includes(challenge.purpose)) return null;
    const candidate = Buffer.from(hashSecret(secret));
    const expected = Buffer.from(challenge.secretHash);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? challenge.userId : null;
  }

  private async createChallenge(
    userId: string,
    purpose: ChallengePurpose,
    secret: string,
    ttlSeconds: number
  ): Promise<string> {
    return storeAuthChallenge(this.cacheService, userId, purpose, secret, ttlSeconds);
  }

  private async reservePasswordLink(
    userId: string,
    purpose: PasswordLinkPurpose
  ): Promise<{ slot: AuthEmailRateSlot; retryAfterMs: 0 } | { slot: null; retryAfterMs: number }> {
    return this.reserveWindowSlot(
      `local_auth:${purpose}:${userId}`,
      MAX_PASSWORD_RESETS_PER_WINDOW,
      PASSWORD_RESET_WINDOW_SECONDS
    );
  }

  /** One slot of a per-user hourly email limit (sliding window), or when the oldest slot frees up. */
  private async reserveWindowSlot(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ slot: AuthEmailRateSlot; retryAfterMs: 0 } | { slot: null; retryAfterMs: number }> {
    const now = Date.now();
    const member = nanoid(12);
    const reserved = await this.cacheService
      .getClient()
      .eval(RESERVE_PASSWORD_RESET_SCRIPT, 1, key, now - windowSeconds * 1000, now, member, limit, windowSeconds);
    const [allowed, retryAfterMs] = Array.isArray(reserved) ? reserved : [0, 0];
    if (Number(allowed) === 1) return { slot: { key, member }, retryAfterMs: 0 };
    return { slot: null, retryAfterMs: Number(retryAfterMs) || windowSeconds * 1000 };
  }

  /** Gives a reserved slot back (the email did not go out). Never throws: the caller is already failing. */
  private async releasePasswordLink(slot: AuthEmailRateSlot): Promise<void> {
    await this.cacheService
      .getClient()
      .zrem(slot.key, slot.member)
      .catch(() => undefined);
  }

  private async consumeChallenge(
    challengeId: string,
    expectedPurpose: ChallengePurpose | ChallengePurpose[] | undefined,
    secret: string
  ): Promise<string | null> {
    const key = `local_auth:challenge:${challengeId}`;
    const allowedPurposes =
      expectedPurpose === undefined
        ? (['email_otp', 'password_setup', 'password_reset'] satisfies ChallengePurpose[])
        : Array.isArray(expectedPurpose)
          ? expectedPurpose
          : [expectedPurpose];
    const consumed = await this.cacheService
      .getClient()
      .eval(
        CONSUME_AUTH_CHALLENGE_SCRIPT,
        1,
        key,
        hashSecret(secret),
        JSON.stringify(allowedPurposes),
        MAX_CHALLENGE_ATTEMPTS
      );
    if (!Array.isArray(consumed) || Number(consumed[0]) !== 1 || typeof consumed[1] !== 'string') return null;
    const challenge = JSON.parse(consumed[1]) as AuthChallenge;
    return challenge.userId;
  }
}
