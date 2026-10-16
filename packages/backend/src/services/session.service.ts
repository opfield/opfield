import { timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { injectable } from 'tsyringe';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { AuthMethod, PublicSession, SessionData, User } from '@/types.js';
import type { CacheService } from './cache.service.js';

const SESSION_PREFIX = 'session:';
const USER_SESSIONS_PREFIX = 'user_sessions:';

@injectable()
export class SessionService {
  constructor(private readonly cache: CacheService) {}

  async createSession(
    user: User,
    accessToken?: string,
    refreshToken?: string,
    metadata: {
      authMethod?: AuthMethod;
      ipAddress?: string;
      userAgent?: string;
      mfaSatisfiedAt?: number;
      purpose?: 'user' | 'setup' | 'impersonation';
      setupSessionId?: string;
      impersonation?: SessionData['impersonation'];
      expiresAt?: number;
    } = {}
  ): Promise<{ sessionId: string; expiresAt: number }> {
    const expirySeconds = getEnvironmentSettingsSnapshot().sessions.expirySeconds;
    const sessionId = nanoid(32);
    const expiresAt = Math.min(metadata.expiresAt ?? Number.POSITIVE_INFINITY, Date.now() + expirySeconds * 1000);

    const sessionData: SessionData = {
      userId: user.id,
      user,
      publicId: nanoid(18),
      authMethod: metadata.authMethod ?? user.authMethod ?? 'oidc',
      accessToken,
      refreshToken,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      mfaSatisfiedAt: metadata.mfaSatisfiedAt,
      purpose: metadata.purpose ?? 'user',
      setupSessionId: metadata.setupSessionId,
      impersonation: metadata.impersonation,
      expiresAt,
    };

    await this.cache.set(`${SESSION_PREFIX}${sessionId}`, sessionData, expirySeconds);

    if (sessionData.purpose !== 'impersonation') {
      await this.cache.sadd(`${USER_SESSIONS_PREFIX}${user.id}`, sessionId);
      await this.cache.expire(`${USER_SESSIONS_PREFIX}${user.id}`, expirySeconds + 86400);
    }

    return { sessionId, expiresAt };
  }

  async createImpersonationSession(
    actor: User,
    subject: User,
    originalSessionId: string,
    metadata: { ipAddress?: string; userAgent?: string } = {}
  ): Promise<{ sessionId: string; expiresAt: number }> {
    const originalSession = await this.getSession(originalSessionId);
    const originalUserId = originalSession?.userId ?? originalSession?.user?.id;
    if (
      !originalSession ||
      (originalSession.purpose !== undefined && originalSession.purpose !== 'user') ||
      originalUserId !== actor.id
    ) {
      throw new Error('Original administrator session is invalid');
    }

    return this.createSession(subject, undefined, undefined, {
      authMethod: originalSession.authMethod ?? actor.authMethod,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      purpose: 'impersonation',
      impersonation: {
        actorUserId: actor.id,
        originalSessionId,
      },
      expiresAt: originalSession.expiresAt,
    });
  }

  async getOriginalSessionForImpersonation(
    session: SessionData
  ): Promise<{ sessionId: string; session: SessionData } | null> {
    if (session.purpose !== 'impersonation' || !session.impersonation) return null;

    const { actorUserId, originalSessionId } = session.impersonation;
    const originalSession = await this.getSession(originalSessionId);
    const originalUserId = originalSession?.userId ?? originalSession?.user?.id;
    if (
      !originalSession ||
      (originalSession.purpose !== undefined && originalSession.purpose !== 'user') ||
      originalUserId !== actorUserId
    ) {
      return null;
    }

    return { sessionId: originalSessionId, session: originalSession };
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${sessionId}`);

    if (!session) return null;

    if (session.expiresAt < Date.now()) {
      await this.destroySession(sessionId);
      return null;
    }

    // Sessions created before browser-session management was introduced do not
    // have a public identifier. Keep an authenticated browser visible rather
    // than silently filtering it from /me/sessions until it expires.
    if (!session.publicId) {
      session.publicId = nanoid(18);
      session.authMethod ??= session.user?.authMethod ?? 'oidc';
      const remainingTtl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
      await this.cache.set(`${SESSION_PREFIX}${sessionId}`, session, remainingTtl);
    }

    return session;
  }

  async updateSession(sessionId: string, updates: Partial<SessionData>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const updatedSession: SessionData = {
      ...session,
      ...updates,
    };

    const remainingTtl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));

    await this.cache.set(`${SESSION_PREFIX}${sessionId}`, updatedSession, remainingTtl);
  }

  async setUserSessionsMfaGraceExpiresAt(userId: string, mfaGraceExpiresAt: number): Promise<void> {
    await this.updateUserSessions(userId, { mfaGraceExpiresAt });
  }

  async clearUserSessionsMfaGraceExpiresAt(userId: string): Promise<void> {
    await this.updateUserSessions(userId, { mfaGraceExpiresAt: undefined });
  }

  private async updateUserSessions(userId: string, updates: Partial<SessionData>): Promise<void> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    await Promise.all(sessionIds.map((sessionId) => this.updateSession(sessionId, updates)));
  }

  async ensureCsrfToken(sessionId: string, session?: SessionData | null): Promise<string | null> {
    const resolved = session ?? (await this.getSession(sessionId));
    if (!resolved) return null;
    if (resolved.csrfToken) return resolved.csrfToken;

    const csrfToken = nanoid(32);
    await this.updateSession(sessionId, { csrfToken });
    return csrfToken;
  }

  async validateCsrfToken(
    sessionId: string,
    token: string | undefined,
    session?: SessionData | null
  ): Promise<boolean> {
    if (!token) return false;
    const csrfToken = await this.ensureCsrfToken(sessionId, session);
    if (!csrfToken) return false;

    const expected = Buffer.from(csrfToken);
    const received = Buffer.from(token);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  async refreshSession(sessionId: string, session?: SessionData | null): Promise<boolean> {
    const resolved = session ?? (await this.getSession(sessionId));
    if (!resolved || (resolved.purpose !== undefined && resolved.purpose !== 'user')) return false;

    const expirySeconds = getEnvironmentSettingsSnapshot().sessions.expirySeconds;
    const halfTtl = (expirySeconds * 1000) / 2;
    const remaining = resolved.expiresAt - Date.now();

    if (remaining > halfTtl) return false;

    const newExpiresAt = Date.now() + expirySeconds * 1000;
    resolved.expiresAt = newExpiresAt;

    await this.cache.set(`${SESSION_PREFIX}${sessionId}`, resolved, expirySeconds);

    return true;
  }

  async touchSession(sessionId: string, session?: SessionData | null): Promise<void> {
    const resolved = session ?? (await this.getSession(sessionId));
    if (!resolved || Date.now() - (resolved.lastSeenAt ?? resolved.createdAt) < 60_000) return;
    await this.updateSession(sessionId, { lastSeenAt: Date.now() });
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${sessionId}`);

    if (session) {
      await this.cache.srem(`${USER_SESSIONS_PREFIX}${session.userId}`, sessionId);
    }

    await this.cache.delete(`${SESSION_PREFIX}${sessionId}`);
  }

  async destroyAllUserSessions(userId: string): Promise<void> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);

    for (const sessionId of sessionIds) {
      await this.cache.delete(`${SESSION_PREFIX}${sessionId}`);
    }

    await this.cache.delete(`${USER_SESSIONS_PREFIX}${userId}`);
  }

  async getUserSessions(userId: string): Promise<SessionData[]> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    const sessions: SessionData[] = [];
    const expired: string[] = [];

    for (const sessionId of sessionIds) {
      const session = await this.getSession(sessionId);
      if (session) {
        sessions.push(session);
      } else {
        expired.push(sessionId);
      }
    }
    // Ids of sessions that expired stay in the set (it lives as long as the newest session): drop them here.
    if (expired.length > 0) await this.cache.srem(`${USER_SESSIONS_PREFIX}${userId}`, ...expired).catch(() => 0);

    return sessions;
  }

  async listPublicUserSessions(userId: string, currentSessionId: string): Promise<PublicSession[]> {
    const sessions = await this.getUserSessions(userId);
    const currentSession = await this.getSession(currentSessionId);
    const currentPublicId = currentSession?.publicId;
    return sessions
      .filter((session) => Boolean(session.publicId) && (session.purpose === undefined || session.purpose === 'user'))
      .map((session) => ({
        id: session.publicId!,
        authMethod: session.authMethod ?? session.user?.authMethod ?? 'oidc',
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt ?? session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress ?? null,
        userAgent: session.userAgent ?? null,
        mfaSatisfiedAt: session.mfaSatisfiedAt ?? null,
        isCurrent: session.publicId === currentPublicId,
      }));
  }

  async revokeUserSessionByPublicId(
    userId: string,
    publicId: string,
    options: { excludeSessionId?: string } = {}
  ): Promise<boolean> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    for (const sessionId of sessionIds) {
      if (sessionId === options.excludeSessionId) continue;
      const session = await this.getSession(sessionId);
      if (session?.publicId !== publicId) continue;
      await this.destroySession(sessionId);
      return true;
    }
    return false;
  }

  async revokeOtherUserSessions(userId: string, currentSessionId: string): Promise<number> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    let revoked = 0;
    for (const sessionId of sessionIds) {
      if (sessionId === currentSessionId) continue;
      await this.destroySession(sessionId);
      revoked += 1;
    }
    return revoked;
  }

  async validateSession(sessionId: string): Promise<User | null> {
    const session = await this.getSession(sessionId);
    return session?.user || null;
  }

  async destroySetupSessions(userId: string, setupSessionId?: string): Promise<void> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    for (const sessionId of sessionIds) {
      const session = await this.getSession(sessionId);
      if (session?.purpose !== 'setup') continue;
      if (setupSessionId && session.setupSessionId !== setupSessionId) continue;
      await this.destroySession(sessionId);
    }
  }
}
