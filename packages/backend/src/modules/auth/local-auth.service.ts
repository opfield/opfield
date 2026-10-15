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
import type { AuthSettingsService } from './auth.settings.service.js';
import type { AuthMailService } from './auth-mail.service.js';

const EMAIL_CHALLENGE_TTL_SECONDS = 10 * 60;
const PASSWORD_LINK_TTL_SECONDS = 30 * 60;
const PASSWORD_RESET_WINDOW_SECONDS = 60 * 60;
const MAX_PASSWORD_RESETS_PER_WINDOW = 3;
const MAX_CHALLENGE_ATTEMPTS = 5;

const RESERVE_PASSWORD_RESET_SCRIPT = `
local key = KEYS[1]
local windowStart = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local member = ARGV[3]
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
if redis.call('ZCARD', key) >= limit then return 0 end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, ttl)
return 1
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
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cacheService: CacheService,
    private readonly sessionService: SessionService,
    private readonly authSettingsService: AuthSettingsService,
    private readonly authMailService: AuthMailService,
    private readonly auditService: AuditService,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {}

  async authenticatePassword(email: string, password: string): Promise<User | null> {
    const methods = (await this.authSettingsService.getConfig()).methods;
    if (!methods.password) return null;
    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, normalizeEmail(email)), eq(users.authMethod, 'password')),
    });
    if (!user || user.isBlocked) return null;
    const credential = await this.db.query.userPasswordCredentials.findFirst({
      where: eq(userPasswordCredentials.userId, user.id),
    });
    if (!credential || !(await bcrypt.compare(password, credential.passwordHash))) return null;
    return resolveLiveUser(this.db, user.id);
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

    // Password is the intentionally generic fallback when both methods are available.
    // It keeps unknown and non-local accounts indistinguishable from password accounts.
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
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challengeId = await this.createChallenge(user.id, 'email_otp', code, EMAIL_CHALLENGE_TTL_SECONDS);
    await this.authMailService.sendSecurityEmail(user.email, { kind: 'email_otp', code });
    return challengeId;
  }

  async verifyEmailOtp(challengeId: string, code: string): Promise<User | null> {
    const userId = await this.consumeChallenge(challengeId, 'email_otp', code);
    return userId ? resolveLiveUser(this.db, userId) : null;
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
   * Emails a password link. `wait` (an administrator's action) follows the delivery and throws when it failed;
   * the public reset never waits. Null when no email went out (no such password user, or the reset was throttled).
   */
  async requestPasswordLink(
    email: string,
    purpose: 'password_setup' | 'password_reset',
    options: { wait?: boolean } = {}
  ): Promise<'sent' | 'queued' | null> {
    const methods = (await this.authSettingsService.getConfig()).methods;
    if (!methods.password) return null;
    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, normalizeEmail(email)), eq(users.authMethod, 'password')),
    });
    if (!user || user.isBlocked) return null;
    if (purpose === 'password_reset' && !(await this.reservePasswordReset(user.id))) return null;
    const secret = nanoid(32);
    const challengeId = await this.createChallenge(user.id, purpose, secret, PASSWORD_LINK_TTL_SECONDS);
    const token = `${challengeId}.${secret}`;
    const baseUrl = this.generalSettingsService
      ? await this.generalSettingsService.requirePublicUrl()
      : getEnv().APP_URL;
    return this.authMailService.sendSecurityEmail(
      user.email,
      {
        kind: purpose,
        actionUrl: new URL(`/reset-password?token=${encodeURIComponent(token)}`, baseUrl).toString(),
      },
      options
    );
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

  private async reservePasswordReset(userId: string): Promise<boolean> {
    const now = Date.now();
    const reserved = await this.cacheService
      .getClient()
      .eval(
        RESERVE_PASSWORD_RESET_SCRIPT,
        1,
        `local_auth:password_reset:${userId}`,
        now - PASSWORD_RESET_WINDOW_SECONDS * 1000,
        now,
        nanoid(12),
        MAX_PASSWORD_RESETS_PER_WINDOW,
        PASSWORD_RESET_WINDOW_SECONDS
      );
    return Number(reserved) === 1;
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
