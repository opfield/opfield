import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { CacheService } from '@/services/cache.service.js';
import type { SetupTokenPolicyService } from './setup-token-policy.js';

const ACCESS_CODE_KEY = 'setup:access_code';
const SESSION_PREFIX = 'setup:session:';
const APPLY_PREFIX = 'setup:apply:';
const ACTIVE_SESSION_KEY = 'setup:active_session';
const ACCESS_TTL_SECONDS = 24 * 60 * 60;
const APPLY_TTL_SECONDS = 15 * 60;

interface StoredAccessCode {
  id: string;
  hash: string;
  expiresAt: string;
}

export interface GeneratedSetupCode {
  id: string;
  code: string;
  expiresAt: string;
}

interface ActiveSetupSession {
  sessionId: string;
  codeId: string;
}

interface StoredSetupSession {
  codeId: string;
  csrfToken: string;
}

export class SetupAlreadyInProgressError extends Error {
  constructor() {
    super('Opfield setup is already in progress');
    this.name = 'SetupAlreadyInProgressError';
  }
}

export class SetupApplyInProgressError extends Error {
  constructor() {
    super('Opfield setup is already being applied');
    this.name = 'SetupApplyInProgressError';
  }
}

export class SetupAccessService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cache: CacheService,
    private readonly policy: SetupTokenPolicyService
  ) {}

  async generateCode(): Promise<GeneratedSetupCode> {
    if (await this.policy.isSetupComplete()) throw new Error('Opfield setup is already complete');

    const id = randomBytes(8).toString('hex');
    const code = `gws_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString();
    const stored: StoredAccessCode = { id, hash: hashCode(code), expiresAt };

    await this.db
      .insert(settings)
      .values({ key: ACCESS_CODE_KEY, value: stored, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: stored, updatedAt: new Date() },
      });
    await this.cache.deletePattern(`${SESSION_PREFIX}*`);
    await this.cache.delete(ACTIVE_SESSION_KEY);
    return { id, code, expiresAt };
  }

  async getCodeMetadata(): Promise<{ id: string; expiresAt: string; available: boolean } | null> {
    const stored = await this.readCode();
    if (!stored) return null;
    return { id: stored.id, expiresAt: stored.expiresAt, available: Date.parse(stored.expiresAt) > Date.now() };
  }

  async createSession(
    code: string
  ): Promise<{ sessionId: string; codeId: string; csrfToken: string; expiresAt: string }> {
    if (await this.cache.exists(ACTIVE_SESSION_KEY)) throw new SetupAlreadyInProgressError();

    const stored = await this.readCode();
    if (!stored || Date.parse(stored.expiresAt) <= Date.now() || !safeEqual(hashCode(code), stored.hash)) {
      throw new Error('Invalid or expired setup code');
    }

    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const remainingSeconds = Math.max(1, Math.floor((Date.parse(stored.expiresAt) - Date.now()) / 1000));
    const acquired = await this.cache.setIfAbsent(
      ACTIVE_SESSION_KEY,
      { sessionId, codeId: stored.id } satisfies ActiveSetupSession,
      remainingSeconds
    );
    if (!acquired) throw new SetupAlreadyInProgressError();
    try {
      await this.cache.set(
        `${SESSION_PREFIX}${sessionId}`,
        { codeId: stored.id, csrfToken } satisfies StoredSetupSession,
        remainingSeconds
      );
    } catch (error) {
      await this.cache.delete(ACTIVE_SESSION_KEY);
      throw error;
    }
    return { sessionId, codeId: stored.id, csrfToken, expiresAt: stored.expiresAt };
  }

  async validateSession(sessionId: string | undefined): Promise<boolean> {
    if (!sessionId || (await this.policy.isSetupComplete())) return false;
    const session = await this.cache.get<StoredSetupSession>(`${SESSION_PREFIX}${sessionId}`);
    if (!session) return false;
    const stored = await this.readCode();
    if (!stored || stored.id !== session.codeId || Date.parse(stored.expiresAt) <= Date.now()) return false;

    const remainingSeconds = Math.max(1, Math.floor((Date.parse(stored.expiresAt) - Date.now()) / 1000));
    let active = await this.cache.get<ActiveSetupSession>(ACTIVE_SESSION_KEY);
    if (!active) {
      const acquired = await this.cache.setIfAbsent(
        ACTIVE_SESSION_KEY,
        { sessionId, codeId: session.codeId } satisfies ActiveSetupSession,
        remainingSeconds
      );
      if (!acquired) active = await this.cache.get<ActiveSetupSession>(ACTIVE_SESSION_KEY);
      else active = { sessionId, codeId: session.codeId };
    }
    return active?.sessionId === sessionId && active.codeId === session.codeId;
  }

  async getCsrfToken(sessionId: string | undefined): Promise<string | null> {
    if (!(await this.validateSession(sessionId))) return null;
    const session = await this.cache.get<StoredSetupSession>(`${SESSION_PREFIX}${sessionId}`);
    return session?.csrfToken ?? null;
  }

  async getSessionExpiresAt(sessionId: string | undefined): Promise<string | null> {
    if (!(await this.validateSession(sessionId))) return null;
    return (await this.readCode())?.expiresAt ?? null;
  }

  async validateCsrfToken(sessionId: string | undefined, csrfToken: string | undefined): Promise<boolean> {
    if (!csrfToken) return false;
    const expected = await this.getCsrfToken(sessionId);
    return expected ? safeEqual(csrfToken, expected) : false;
  }

  async withApplyLock<T>(sessionId: string | undefined, task: () => Promise<T>): Promise<T> {
    if (!(await this.validateSession(sessionId))) throw new Error('A valid setup session is required');
    const key = `${APPLY_PREFIX}${sessionId}`;
    const lease = randomBytes(16).toString('hex');
    if (!(await this.cache.setIfAbsent(key, lease, APPLY_TTL_SECONDS))) {
      throw new SetupApplyInProgressError();
    }
    try {
      return await task();
    } finally {
      await this.cache
        .getClient()
        .eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          1,
          key,
          lease
        )
        .catch(() => {});
    }
  }

  async getProgress(sessionId: string | undefined): Promise<{ inProgress: boolean; currentSession: boolean }> {
    const currentSession = await this.validateSession(sessionId);
    return { inProgress: currentSession || (await this.cache.exists(ACTIVE_SESSION_KEY)), currentSession };
  }

  async invalidate(): Promise<void> {
    await this.cache.deletePattern(`${SESSION_PREFIX}*`);
    await this.cache.deletePattern(`${APPLY_PREFIX}*`);
    await this.cache.delete(ACTIVE_SESSION_KEY);
    await this.db.delete(settings).where(eq(settings.key, ACCESS_CODE_KEY));
  }

  private async readCode(): Promise<StoredAccessCode | null> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, ACCESS_CODE_KEY))
      .limit(1);
    const value = typeof row?.value === 'object' && row.value !== null ? (row.value as Record<string, unknown>) : null;
    if (
      !value ||
      typeof value.id !== 'string' ||
      typeof value.hash !== 'string' ||
      typeof value.expiresAt !== 'string'
    ) {
      return null;
    }
    return { id: value.id, hash: value.hash, expiresAt: value.expiresAt };
  }
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
