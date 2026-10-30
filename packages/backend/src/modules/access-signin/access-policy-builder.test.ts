import { describe, expect, it } from 'vitest';
import { buildAccessPolicyCommand } from './access-policy-builder.js';

describe('access policy payload', () => {
  it('carries every list, basic users only where basic is a method, and only unexpired revocations and tokens', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    const later = new Date('2026-03-02T00:00:00Z');
    const earlier = new Date('2026-02-28T00:00:00Z');
    const users = [{ username: 'lena', passwordHash: '$2b$10$hash' }];
    const command = buildAccessPolicyCommand({
      revision: 1_772_323_200_000,
      keys: [{ keyId: 'k1', publicKey: Buffer.alloc(32, 7) }],
      lists: [
        {
          id: 'list-basic',
          signInMethods: ['basic', 'opfield'],
          skipIpRanges: ['10.0.0.0/8'],
          includeRules: [{ selector: 'everyone', values: [] }],
          requireRules: [{ selector: 'ip', values: ['10.0.0.0/8'] }],
          excludeRules: [],
          users,
        },
        {
          id: 'list-password',
          signInMethods: ['password'],
          skipIpRanges: [],
          includeRules: [{ selector: 'email_domain', values: ['acme.dev'] }],
          requireRules: [],
          excludeRules: [{ selector: 'email', values: ['x@acme.dev'] }],
          users,
        },
      ],
      revokedSessions: [
        { id: 'live', expiresAt: later },
        { id: 'ended', expiresAt: earlier },
      ],
      serviceTokens: [
        { id: 't-forever', clientId: 'c1', secretSha256: 'a'.repeat(64), expiresAt: null },
        { id: 't-later', clientId: 'c2', secretSha256: 'b'.repeat(64), expiresAt: later },
        { id: 't-expired', clientId: 'c3', secretSha256: 'c'.repeat(64), expiresAt: earlier },
      ],
      now,
    });

    expect(command.revision).toBe('1772323200000');
    // Visitors sign in on the route itself: no sign-in origin.
    expect(command.signInOrigin).toBe('');
    expect(command.keys).toEqual([{ keyId: 'k1', publicKey: Buffer.alloc(32, 7) }]);
    expect(command.lists[0]).toEqual({
      id: 'list-basic',
      signInMethods: ['basic', 'opfield'],
      skipIpRanges: ['10.0.0.0/8'],
      includeRules: [{ selector: 'everyone', values: [] }],
      requireRules: [{ selector: 'ip', values: ['10.0.0.0/8'] }],
      excludeRules: [],
      basicAuthUsers: [{ username: 'lena', bcryptHash: '$2b$10$hash' }],
    });
    expect(command.lists[1].basicAuthUsers).toEqual([]);
    expect(command.revokedSessions).toEqual([{ sessionId: 'live', expiresAtUnix: String(later.getTime() / 1000) }]);
    expect(command.serviceTokens.map((token) => [token.id, token.expiresAtUnix])).toEqual([
      ['t-forever', '0'],
      ['t-later', String(later.getTime() / 1000)],
    ]);
  });
});
