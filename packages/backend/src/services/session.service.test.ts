import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { container } from '@/container.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import type { SessionData, User } from '@/types.js';
import { SessionService } from './session.service.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

class MemoryCache {
  readonly values = new Map<string, unknown>();
  readonly ttls = new Map<string, number>();
  readonly sets = new Map<string, Set<string>>();
  /** Runs right after a read, like a concurrent request between this read and the write that follows it. */
  afterGet: ((key: string) => Promise<void>) | null = null;

  async get<T>(key: string): Promise<T | null> {
    const value = (this.values.get(key) as T | undefined) ?? null;
    await this.afterGet?.(key);
    return value;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.values.set(key, structuredClone(value));
    if (ttlSeconds) this.ttls.set(key, ttlSeconds);
  }

  async setIfExists(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    if (!this.values.has(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async sadd(key: string, member: string): Promise<void> {
    const values = this.sets.get(key) ?? new Set<string>();
    values.add(member);
    this.sets.set(key, values);
  }

  async expire(): Promise<void> {}

  async srem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.sets.delete(key);
  }
}

function useSessionSettings(sessions: { expirySeconds?: number; absoluteLifetimeSeconds?: number | null }) {
  const snapshot = {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    sessions: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions, ...sessions },
  };
  container.registerInstance(EnvironmentSettingsService, {
    getSnapshot: () => structuredClone(snapshot),
  } as unknown as EnvironmentSettingsService);
}

afterEach(() => {
  container.reset();
});

describe('SessionService', () => {
  it('sets and clears the MFA grace deadline on every active user session', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    const expiresAt = Date.now() + 60_000;
    const firstSessionId = 'browser-session-1';
    const secondSessionId = 'browser-session-2';
    const userId = 'user-1';
    const firstSession = {
      userId,
      user: { id: userId },
      createdAt: Date.now() - 60_000,
      expiresAt,
    } as SessionData;
    const secondSession = {
      userId,
      user: { id: userId },
      createdAt: Date.now() - 30_000,
      expiresAt,
    } as SessionData;
    cache.values.set(`session:${firstSessionId}`, firstSession);
    cache.values.set(`session:${secondSessionId}`, secondSession);
    cache.sets.set(`user_sessions:${userId}`, new Set([firstSessionId, secondSessionId]));

    await service.setUserSessionsMfaGraceExpiresAt(userId, 1_700_000_000_000);

    await expect(service.getSession(firstSessionId)).resolves.toMatchObject({
      mfaGraceExpiresAt: 1_700_000_000_000,
    });
    await expect(service.getSession(secondSessionId)).resolves.toMatchObject({
      mfaGraceExpiresAt: 1_700_000_000_000,
    });

    await service.clearUserSessionsMfaGraceExpiresAt(userId);

    expect((await service.getSession(firstSessionId))?.mfaGraceExpiresAt).toBeUndefined();
    expect((await service.getSession(secondSessionId))?.mfaGraceExpiresAt).toBeUndefined();
  });

  it('upgrades a legacy session without a cached user so it stays visible and revocable', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    const user: User = {
      id: 'user-1',
      oidcSubject: 'oidc-user-1',
      authMethod: 'oidc',
      email: 'user@example.com',
      name: 'OIDC User',
      avatarUrl: null,
      groupId: 'group-1',
      groupName: 'viewer',
      scopes: [],
      isBlocked: false,
    };
    const sessionId = 'legacy-oidc-session';
    const legacySession = {
      userId: user.id,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
    } as unknown as SessionData;
    cache.values.set(`session:${sessionId}`, legacySession);
    cache.sets.set(`user_sessions:${user.id}`, new Set([sessionId]));

    const sessions = await service.listPublicUserSessions(user.id, sessionId);

    expect(sessions).toEqual([
      expect.objectContaining({
        authMethod: 'oidc',
        isCurrent: true,
        id: expect.any(String),
      }),
    ]);
    expect((await cache.get<SessionData>(`session:${sessionId}`))?.publicId).toEqual(sessions[0].id);
  });

  it('keeps impersonation sessions outside target session listing and bulk revocation', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    const actor = {
      id: 'actor-1',
      oidcSubject: 'actor',
      authMethod: 'oidc',
      email: 'actor@example.com',
      name: 'Actor',
      avatarUrl: null,
      groupId: 'system-admin',
      groupName: 'system-admin',
      scopes: ['admin:users:impersonate'],
      isBlocked: false,
    } satisfies User;
    const subject = {
      ...actor,
      id: 'subject-1',
      oidcSubject: 'subject',
      email: 'subject@example.com',
      name: 'Subject',
      groupId: 'viewer',
      groupName: 'viewer',
      scopes: ['nodes:details'],
    } satisfies User;
    const originalSessionId = 'actor-session';
    cache.values.set(`session:${originalSessionId}`, {
      userId: actor.id,
      user: actor,
      publicId: 'actor-public-session',
      purpose: 'user',
      authMethod: 'oidc',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    } satisfies SessionData);
    cache.sets.set(`user_sessions:${actor.id}`, new Set([originalSessionId]));

    const created = await service.createImpersonationSession(actor, subject, originalSessionId);

    expect(cache.sets.get(`user_sessions:${subject.id}`)).toBeUndefined();
    await expect(service.listPublicUserSessions(subject.id, created.sessionId)).resolves.toEqual([]);

    await service.destroyAllUserSessions(subject.id);

    await expect(service.getSession(created.sessionId)).resolves.toMatchObject({
      purpose: 'impersonation',
      userId: subject.id,
      impersonation: { actorUserId: actor.id, originalSessionId },
    });
    await expect(service.getSession(originalSessionId)).resolves.toBeTruthy();
  });
});

describe('SessionService writes after a revocation (R1-01)', () => {
  const user = { id: 'user-1' } as User;

  function storedSession(overrides: Partial<SessionData> = {}): SessionData {
    return {
      userId: user.id,
      user,
      publicId: 'public-1',
      purpose: 'user',
      createdAt: Date.now() - 60_000,
      lastSeenAt: Date.now() - 120_000,
      expiresAt: Date.now() + 60_000,
      ...overrides,
    };
  }

  it('does not bring back a session that was revoked between its read and the update', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    cache.values.set('session:s1', storedSession());
    cache.sets.set('user_sessions:user-1', new Set(['s1']));
    let revoked = false;
    cache.afterGet = async (key) => {
      if (key !== 'session:s1' || revoked) return;
      revoked = true;
      await service.destroyAllUserSessions(user.id);
    };

    await service.updateSession('s1', { ipAddress: '203.0.113.7' });

    expect(revoked).toBe(true);
    expect(cache.values.has('session:s1')).toBe(false);
  });

  it('does not renew a session that was revoked while the renewal was decided', async () => {
    useSessionSettings({ expirySeconds: 3_600 });
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    const stale = storedSession({ expiresAt: Date.now() + 60_000 });

    await expect(service.refreshSession('s1', stale)).resolves.toBe(false);
    await service.touchSession('s1', stale);

    expect(cache.values.has('session:s1')).toBe(false);
  });

  it('renews a live session with a fresh expiry from the stored copy, not the request snapshot', async () => {
    useSessionSettings({ expirySeconds: 3_600 });
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    cache.values.set('session:s1', storedSession({ csrfToken: 'fresh-csrf' }));

    await expect(service.refreshSession('s1', storedSession())).resolves.toBe(true);

    const renewed = cache.values.get('session:s1') as SessionData;
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(renewed.csrfToken).toBe('fresh-csrf');
    expect(cache.ttls.get('session:s1')).toBeGreaterThan(3_500);
  });

  it('loads a session stored with IdP tokens and drops them when it is written back', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    cache.values.set('session:s1', { ...storedSession(), accessToken: 'idp-access', refreshToken: 'idp-refresh' });

    await expect(service.getSession('s1')).resolves.toMatchObject({ userId: user.id });
    await service.updateSession('s1', { lastSeenAt: Date.now() });

    expect(cache.values.get('session:s1')).not.toHaveProperty('accessToken');
    expect(cache.values.get('session:s1')).not.toHaveProperty('refreshToken');
  });

  it('stores no IdP tokens in a new session', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);

    const { sessionId } = await service.createSession(user, { authMethod: 'oidc' });

    const stored = cache.values.get(`session:${sessionId}`) as Record<string, unknown>;
    expect(stored).toMatchObject({ userId: user.id, authMethod: 'oidc' });
    expect(stored).not.toHaveProperty('accessToken');
    expect(stored).not.toHaveProperty('refreshToken');
  });
});

describe('SessionService absolute lifetime (R1-12)', () => {
  const user = { id: 'user-1' } as User;

  it('ends a session at its absolute lifetime from sign-in, however recently it was renewed', async () => {
    useSessionSettings({ expirySeconds: 86_400, absoluteLifetimeSeconds: 3_600 });
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    cache.values.set('session:s1', {
      userId: user.id,
      user,
      publicId: 'public-1',
      createdAt: Date.now() - 3_601_000,
      expiresAt: Date.now() + 86_000_000,
    } satisfies SessionData);
    cache.sets.set('user_sessions:user-1', new Set(['s1']));

    await expect(service.getSession('s1')).resolves.toBeNull();
    expect(cache.values.has('session:s1')).toBe(false);
  });

  it('caps a new session and its renewals at the absolute lifetime', async () => {
    useSessionSettings({ expirySeconds: 86_400, absoluteLifetimeSeconds: 7_200 });
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);

    const created = await service.createSession(user);
    expect(created.expiresAt).toBeLessThanOrEqual(Date.now() + 7_200_000);

    const signedInLongAgo: SessionData = {
      userId: user.id,
      user,
      publicId: 'public-1',
      purpose: 'user',
      createdAt: Date.now() - 7_000_000,
      expiresAt: Date.now() + 200_000,
    };
    cache.values.set('session:s2', signedInLongAgo);
    await expect(service.refreshSession('s2', signedInLongAgo)).resolves.toBe(false);
    expect((cache.values.get('session:s2') as SessionData).expiresAt).toBe(signedInLongAgo.expiresAt);
  });

  it('keeps sliding sessions without an absolute lifetime (the default)', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    cache.values.set('session:s1', {
      userId: user.id,
      user,
      publicId: 'public-1',
      createdAt: Date.now() - 400 * 86_400_000,
      expiresAt: Date.now() + 60_000,
    } satisfies SessionData);

    await expect(service.getSession('s1')).resolves.toMatchObject({ userId: user.id });
  });
});
