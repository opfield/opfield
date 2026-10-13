import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { __testOnly, InferenceTokenService } from './inference-token.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = '22222222-2222-4222-8222-222222222222';

const USER: User = {
  id: USER_ID,
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'inference-users',
  scopes: ['feat:ai:use'],
  isBlocked: false,
};

function liveUserDb(token: Record<string, unknown> | null, user: Partial<User> = {}) {
  const execute = vi.fn().mockResolvedValue(undefined);
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ execute }),
      }),
    }),
    query: {
      inferenceTokens: { findFirst: vi.fn().mockResolvedValue(token) },
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          isBlocked: USER.isBlocked,
          additionalScopes: [],
          ...user,
        }),
      },
      permissionGroups: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: USER.groupId, parentId: null, name: USER.groupName, scopes: user.scopes ?? USER.scopes },
          ]),
      },
    },
  };
}

describe('InferenceTokenService', () => {
  it('returns a copy-once token while storing and auditing only non-secret material', async () => {
    const values = vi.fn().mockImplementation((inserted) => ({
      returning: vi.fn().mockResolvedValue([
        {
          id: TOKEN_ID,
          userId: USER_ID,
          name: inserted.name,
          tokenHash: inserted.tokenHash,
          tokenPrefix: inserted.tokenPrefix,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-07-24T00:00:00.000Z'),
        },
      ]),
    }));
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const service = new InferenceTokenService(db as never, audit as never);

    const result = await service.createToken(USER_ID, { name: 'Codex laptop' });
    const stored = values.mock.calls[0][0];
    const auditEntry = audit.log.mock.calls[0][0];

    expect(result.token).toMatch(/^opfi_[0-9a-f]{64}$/);
    expect(stored.tokenHash).toBe(__testOnly.hashInferenceToken(result.token));
    expect(stored.tokenHash).not.toContain(result.token);
    expect(stored.tokenPrefix).toBe(result.token.slice(0, 12));
    expect(JSON.stringify(auditEntry)).not.toContain(result.token);
    expect(auditEntry).toMatchObject({ action: 'inference_token.create', resourceId: TOKEN_ID });
  });

  it('validates against the live owner and required inference scope', async () => {
    const token = { id: TOKEN_ID, userId: USER_ID, tokenPrefix: 'gwi_12345678' };
    const allowed = await new InferenceTokenService(
      liveUserDb(token) as never,
      { log: vi.fn() } as never
    ).validateToken('gwi_test');
    const blocked = await new InferenceTokenService(
      liveUserDb(token, { isBlocked: true }) as never,
      { log: vi.fn() } as never
    ).validateToken('gwi_test');
    const demoted = await new InferenceTokenService(
      liveUserDb(token, { scopes: ['nodes:details'] }) as never,
      { log: vi.fn() } as never
    ).validateToken('gwi_test');

    expect(allowed).toMatchObject({
      user: { id: USER_ID },
      tokenId: TOKEN_ID,
      tokenPrefix: 'gwi_12345678',
    });
    expect(blocked).toBeNull();
    expect(demoted).toBeNull();
  });

  it('refuses an expired token and one used from an address outside its list', async () => {
    const validate = (token: Record<string, unknown>, clientIp?: string) =>
      new InferenceTokenService(
        liveUserDb({ id: TOKEN_ID, userId: USER_ID, tokenPrefix: 'gwi_12345678', ...token }) as never,
        { log: vi.fn() } as never
      ).validateToken('gwi_test', { clientIp });

    await expect(validate({ expiresAt: new Date(Date.now() - 1000) })).resolves.toBeNull();
    await expect(validate({ expiresAt: new Date(Date.now() + 60_000) })).resolves.not.toBeNull();
    await expect(validate({ allowedIps: ['10.20.0.0/16'] }, '10.20.4.17')).resolves.not.toBeNull();
    await expect(validate({ allowedIps: ['10.20.0.0/16'] }, '198.51.100.7')).resolves.toBeNull();
    await expect(validate({ allowedIps: ['10.20.0.0/16'] })).resolves.toBeNull();
  });

  it('rejects revoked, unknown, and wrong-prefix credentials', async () => {
    const service = new InferenceTokenService(liveUserDb(null) as never, { log: vi.fn() } as never);
    await expect(service.validateToken('gwi_revoked')).resolves.toBeNull();
    await expect(service.validateToken('gw_wrong_kind')).resolves.toBeNull();
  });

  it('soft-revokes owned tokens without putting secret material in audit data', async () => {
    const token = {
      id: TOKEN_ID,
      userId: USER_ID,
      name: 'CLI',
      tokenPrefix: 'gwi_12345678',
      revokedAt: null,
    };
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const db = {
      query: { inferenceTokens: { findFirst: vi.fn().mockResolvedValue(token) } },
      update: vi.fn().mockReturnValue({ set }),
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };

    await new InferenceTokenService(db as never, audit as never).revokeToken(USER_ID, TOKEN_ID);

    expect(set.mock.calls[0][0].revokedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'inference_token.revoke', resourceId: TOKEN_ID })
    );
  });
});
