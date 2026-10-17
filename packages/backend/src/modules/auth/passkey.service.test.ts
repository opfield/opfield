import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyAuthenticationResponse: vi.fn(),
  resolveLiveUser: vi.fn(),
}));

vi.mock('@simplewebauthn/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simplewebauthn/server')>()),
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
}));
vi.mock('@/modules/auth/live-session-user.js', () => ({ resolveLiveUser: mocks.resolveLiveUser }));

const { PasskeyService } = await import('./passkey.service.js');

describe('PasskeyService authentication challenge claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows only one concurrent claimant after successful verification', async () => {
    const pending = { challenge: 'challenge-1' };
    let available = true;
    const cache = {
      get: vi.fn().mockResolvedValue(pending),
      take: vi.fn(async () => {
        if (!available) return null;
        available = false;
        return pending;
      }),
    };
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      query: {
        userPasskeys: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'passkey-1',
            userId: 'user-1',
            credentialId: 'credential-1',
            publicKey: Buffer.from('public-key').toString('base64url'),
            counter: 1,
            transports: [],
          }),
        },
      },
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
    };
    const user = { id: 'user-1', authMethod: 'password', isBlocked: false };
    mocks.resolveLiveUser.mockResolvedValue(user);
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    const service = new PasskeyService(
      db as never,
      cache as never,
      { getConfig: vi.fn().mockResolvedValue({ methods: { passkeyLogin: true } }) } as never,
      { getCachedPublicUrl: () => 'https://opfield.example.com' } as never
    );
    const response = { id: 'credential-1' } as never;

    const results = await Promise.all([
      service.verifyAuthentication('challenge-1', response),
      service.verifyAuthentication('challenge-1', response),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(cache.take).toHaveBeenCalledTimes(2);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });
});
