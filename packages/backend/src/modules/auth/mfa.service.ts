import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, userPasskeys, userRecoveryCodes, users, userTotpFactors } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CryptoService } from '@/services/crypto.service.js';

const TOTP_SETUP_TTL_SECONDS = 10 * 60;
const MAX_MFA_LOGIN_ATTEMPTS = 5;

const CONSUME_MFA_LOGIN_CHALLENGE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
redis.call('DEL', KEYS[1])
return raw
`;

const RECORD_MFA_LOGIN_FAILURE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
local challenge = cjson.decode(raw)
local attempts = (tonumber(challenge.attempts) or 0) + 1
if attempts >= tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
else
  challenge.attempts = attempts
  redis.call('SET', KEYS[1], cjson.encode(challenge), 'PX', ttl)
end
return attempts
`;

interface PendingTotpSetup {
  encryptedSecret: { encryptedKey: string; encryptedDek: string };
}

interface PendingMfaLogin {
  userId: string;
  authMethod: 'password' | 'email_otp';
  attempts: number;
}

interface PendingMfaEnrollment {
  userId: string;
  authMethod: 'password' | 'email_otp';
}

interface PendingStepUp {
  userId: string;
}

const STEP_UP_TTL_SECONDS = 5 * 60;
const MAX_STEP_UP_FAILURES = 5;
const STEP_UP_FAILURE_WINDOW_SECONDS = 15 * 60;

function stepUpKey(sessionId: string): string {
  return `mfa:step-up:${createHash('sha256').update(sessionId).digest('base64url')}`;
}

function stepUpFailuresKey(userId: string): string {
  return `mfa:step-up:failures:${userId}`;
}

function createTotp(secret?: string, label?: string) {
  return new OTPAuth.TOTP({
    issuer: 'Opfield',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    ...(secret ? { secret } : { secret: new OTPAuth.Secret({ size: 20 }) }),
  });
}

@injectable()
export class MfaService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cacheService: CacheService,
    private readonly cryptoService: CryptoService
  ) {}

  async isOpfieldMfaRequired(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({
        authMethod: users.authMethod,
        require2fa: sql<boolean>`${permissionGroups.require2fa} OR EXISTS (SELECT 1 FROM permission_groups g WHERE g.id = ANY(${users.additionalGroupIds}) AND g.require_2fa)`,
      })
      .from(users)
      .innerJoin(permissionGroups, eq(permissionGroups.id, users.groupId))
      .where(eq(users.id, userId))
      .limit(1);
    return Boolean(row?.require2fa && row.authMethod !== 'oidc');
  }

  async getStatus(
    userId: string
  ): Promise<{ totpConfigured: boolean; passkeyCount: number; recoveryCodeCount: number }> {
    const factor = await this.db.query.userTotpFactors.findFirst({ where: eq(userTotpFactors.userId, userId) });
    const [codes, passkeys] = await Promise.all([
      this.db
        .select({ id: userRecoveryCodes.id })
        .from(userRecoveryCodes)
        .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt))),
      this.db.select({ id: userPasskeys.id }).from(userPasskeys).where(eq(userPasskeys.userId, userId)),
    ]);
    return { totpConfigured: Boolean(factor), passkeyCount: passkeys.length, recoveryCodeCount: codes.length };
  }

  async requiresLocalMfa(userId: string): Promise<boolean> {
    const { totpConfigured, passkeyCount } = await this.getStatus(userId);
    return totpConfigured || passkeyCount > 0;
  }

  async beginTotpSetup(userId: string, email: string): Promise<{ secret: string; uri: string }> {
    const existing = await this.db.query.userTotpFactors.findFirst({ where: eq(userTotpFactors.userId, userId) });
    if (existing)
      throw new AppError(
        409,
        'TOTP_ALREADY_CONFIGURED',
        'TOTP is already configured; contact an administrator to reset MFA'
      );
    const totp = createTotp(undefined, email);
    const secret = totp.secret.base32;
    await this.cacheService.set<PendingTotpSetup>(
      `mfa:totp:setup:${userId}`,
      { encryptedSecret: this.cryptoService.encryptString(secret) },
      TOTP_SETUP_TTL_SECONDS
    );
    return { secret, uri: totp.toString() };
  }

  async confirmTotpSetup(userId: string, code: string): Promise<string[]> {
    const key = `mfa:totp:setup:${userId}`;
    const pending = await this.cacheService.get<PendingTotpSetup>(key);
    if (!pending) throw new AppError(400, 'TOTP_SETUP_EXPIRED', 'TOTP setup has expired');
    const secret = this.cryptoService.decryptString(pending.encryptedSecret);
    if (!this.isValidTotp(secret, code)) throw new AppError(400, 'INVALID_TOTP_CODE', 'Invalid authentication code');
    const claimed = await this.cacheService.take<PendingTotpSetup>(key);
    if (!claimed || JSON.stringify(claimed.encryptedSecret) !== JSON.stringify(pending.encryptedSecret)) {
      throw new AppError(400, 'TOTP_SETUP_EXPIRED', 'TOTP setup has expired');
    }
    await this.db
      .insert(userTotpFactors)
      .values({
        userId,
        encryptedSecret: JSON.stringify(pending.encryptedSecret),
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userTotpFactors.userId,
        set: {
          encryptedSecret: JSON.stringify(pending.encryptedSecret),
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    return this.regenerateRecoveryCodes(userId);
  }

  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const factor = await this.db.query.userTotpFactors.findFirst({ where: eq(userTotpFactors.userId, userId) });
    if (!factor) return false;
    try {
      const encryptedSecret = JSON.parse(factor.encryptedSecret) as PendingTotpSetup['encryptedSecret'];
      if (!encryptedSecret.encryptedKey || !encryptedSecret.encryptedDek) return false;
      return this.isValidTotp(this.cryptoService.decryptString(encryptedSecret), code);
    } catch {
      return false;
    }
  }

  async beginLoginChallenge(userId: string, authMethod: 'password' | 'email_otp'): Promise<string> {
    const challengeId = randomBytes(18).toString('base64url');
    await this.cacheService.set<PendingMfaLogin>(
      `mfa:login:${challengeId}`,
      { userId, authMethod, attempts: 0 },
      TOTP_SETUP_TTL_SECONDS
    );
    return challengeId;
  }

  async beginEnrollmentChallenge(userId: string, authMethod: 'password' | 'email_otp'): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.cacheService.set<PendingMfaEnrollment>(
      `mfa:enrollment:${token}`,
      { userId, authMethod },
      TOTP_SETUP_TTL_SECONDS
    );
    return token;
  }

  async getEnrollmentChallenge(token: string): Promise<PendingMfaEnrollment | null> {
    return this.cacheService.get<PendingMfaEnrollment>(`mfa:enrollment:${token}`);
  }

  async completeEnrollmentChallenge(token: string): Promise<PendingMfaEnrollment | null> {
    const key = `mfa:enrollment:${token}`;
    const pending = await this.cacheService.get<PendingMfaEnrollment>(key);
    if (pending) await this.cacheService.delete(key);
    return pending;
  }

  async verifyLoginChallenge(
    challengeId: string,
    input: { totpCode?: string; recoveryCode?: string }
  ): Promise<{ userId: string; authMethod: 'password' | 'email_otp' } | null> {
    const key = `mfa:login:${challengeId}`;
    const pending = await this.cacheService.get<PendingMfaLogin>(key);
    if (!pending || pending.attempts >= MAX_MFA_LOGIN_ATTEMPTS) return null;
    const valid = input.totpCode
      ? await this.verifyTotp(pending.userId, input.totpCode)
      : input.recoveryCode
        ? await this.useRecoveryCode(pending.userId, input.recoveryCode)
        : false;
    if (!valid) {
      await this.cacheService.getClient().eval(RECORD_MFA_LOGIN_FAILURE_SCRIPT, 1, key, MAX_MFA_LOGIN_ATTEMPTS);
      return null;
    }
    return this.consumeLoginChallenge(key);
  }

  async getLoginChallenge(challengeId: string): Promise<PendingMfaLogin | null> {
    return this.cacheService.get<PendingMfaLogin>(`mfa:login:${challengeId}`);
  }

  async completeVerifiedLoginChallenge(
    challengeId: string
  ): Promise<{ userId: string; authMethod: 'password' | 'email_otp' } | null> {
    return this.consumeLoginChallenge(`mfa:login:${challengeId}`);
  }

  private async consumeLoginChallenge(
    key: string
  ): Promise<{ userId: string; authMethod: 'password' | 'email_otp' } | null> {
    const raw = await this.cacheService.getClient().eval(CONSUME_MFA_LOGIN_CHALLENGE_SCRIPT, 1, key);
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const pending = JSON.parse(raw) as PendingMfaLogin;
    return { userId: pending.userId, authMethod: pending.authMethod };
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').toUpperCase());
    await this.db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await this.db
      .insert(userRecoveryCodes)
      .values(await Promise.all(codes.map(async (code) => ({ userId, codeHash: await bcrypt.hash(code, 12) }))));
    return codes;
  }

  private async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const candidates = await this.db
      .select({ id: userRecoveryCodes.id, codeHash: userRecoveryCodes.codeHash })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    for (const candidate of candidates) {
      if (!(await bcrypt.compare(code.trim().toUpperCase(), candidate.codeHash))) continue;
      const updated = await this.db
        .update(userRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(userRecoveryCodes.id, candidate.id), isNull(userRecoveryCodes.usedAt)))
        .returning({ id: userRecoveryCodes.id });
      return updated.length === 1;
    }
    return false;
  }

  async resetMfa(userId: string): Promise<void> {
    await this.db.delete(userTotpFactors).where(eq(userTotpFactors.userId, userId));
    await this.db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await this.db.delete(userPasskeys).where(eq(userPasskeys.userId, userId));
    await this.cacheService.delete(`mfa:totp:setup:${userId}`);
  }

  /**
   * Record that this browser session just proved possession of an existing
   * second factor. Second-factor changes accept the proof for a short window
   * so a reset-and-reconfigure or passkey ceremony needs only one prompt.
   */
  async grantStepUp(userId: string, sessionId: string): Promise<void> {
    await this.cacheService.delete(stepUpFailuresKey(userId));
    await this.cacheService.set<PendingStepUp>(stepUpKey(sessionId), { userId }, STEP_UP_TTL_SECONDS);
  }

  /** Verify a TOTP or recovery code as a step-up proof for the current session. */
  async verifyStepUpCode(
    userId: string,
    sessionId: string,
    input: { totpCode?: string; recoveryCode?: string }
  ): Promise<boolean> {
    const failuresKey = stepUpFailuresKey(userId);
    const failures = Number((await this.cacheService.get<number>(failuresKey)) ?? 0);
    if (failures >= MAX_STEP_UP_FAILURES) {
      throw new AppError(429, 'MFA_STEP_UP_LOCKED', 'Too many failed verification attempts. Try again later.');
    }
    const valid = input.totpCode
      ? await this.verifyTotp(userId, input.totpCode)
      : input.recoveryCode
        ? await this.useRecoveryCode(userId, input.recoveryCode)
        : false;
    if (!valid) {
      const attempts = await this.cacheService.incr(failuresKey);
      if (attempts === 1) await this.cacheService.expire(failuresKey, STEP_UP_FAILURE_WINDOW_SECONDS);
      return false;
    }
    await this.grantStepUp(userId, sessionId);
    return true;
  }

  /**
   * Adding, replacing or removing a second factor requires a fresh proof of an
   * existing one. An account without any factor may enroll its first one.
   */
  async assertSecondFactorChangeAllowed(userId: string, sessionId: string): Promise<void> {
    if (!(await this.requiresLocalMfa(userId))) return;
    const grant = await this.cacheService.get<PendingStepUp>(stepUpKey(sessionId));
    if (grant?.userId === userId) return;
    throw new AppError(
      403,
      'MFA_STEP_UP_REQUIRED',
      'Confirm with your authenticator app, a recovery code or a passkey before changing second factors'
    );
  }

  async resetTotp(userId: string): Promise<void> {
    await this.db.delete(userTotpFactors).where(eq(userTotpFactors.userId, userId));
    await this.db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await this.cacheService.delete(`mfa:totp:setup:${userId}`);
  }

  private isValidTotp(secret: string, code: string): boolean {
    const delta = createTotp(secret).validate({ token: code, window: 1 });
    return delta !== null;
  }
}
