import 'reflect-metadata';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import type { CacheService } from '@/services/cache.service.js';
import { LocalAuthService } from './local-auth.service.js';

vi.mock('@/modules/auth/live-session-user.js', () => ({
  resolveLiveUser: vi.fn(async (_db: unknown, userId: string) => ({ id: userId })),
}));

describe('LocalAuthService challenge consumption', () => {
  it('allows only one concurrent claimant for a one-time challenge', async () => {
    const key = 'local_auth:challenge:challenge-id';
    let raw: string | null = JSON.stringify({
      userId: 'user-1',
      purpose: 'email_otp',
      secretHash: 'hash',
      attempts: 0,
    });
    const evalChallenge = vi.fn(async (_script: string, _keys: number, requestedKey: string) => {
      expect(requestedKey).toBe(key);
      if (!raw) return [0, ''];
      const claimed = raw;
      raw = null;
      return [1, claimed];
    });
    const cache = { getClient: () => ({ eval: evalChallenge }) } as unknown as CacheService;
    const service = new LocalAuthService({} as never, cache, {} as never, {} as never, {} as never, {} as never);

    const results = await Promise.all([
      (service as any).consumeChallenge('challenge-id', 'email_otp', '123456'),
      (service as any).consumeChallenge('challenge-id', 'email_otp', '123456'),
    ]);

    expect(results.filter(Boolean)).toEqual(['user-1']);
    expect(evalChallenge).toHaveBeenCalledTimes(2);
    expect(evalChallenge).toHaveBeenCalledWith(
      expect.any(String),
      1,
      key,
      expect.any(String),
      JSON.stringify(['email_otp']),
      5
    );
  });

  it('does not consume a password link when the password violates policy', async () => {
    const evalChallenge = vi.fn();
    const cache = { getClient: () => ({ eval: evalChallenge }) } as unknown as CacheService;
    const service = new LocalAuthService(
      {} as never,
      cache,
      {} as never,
      {
        getConfig: vi.fn().mockResolvedValue({
          passwordPolicy: {
            minLength: 12,
            maxLength: 128,
            requireUppercase: true,
            requireLowercase: true,
            requireDigit: true,
            requireSymbol: true,
          },
        }),
      } as never,
      {} as never,
      {} as never
    );

    await expect(service.completePasswordLink('challenge-id.secret', 'weak')).rejects.toMatchObject({
      code: 'PASSWORD_POLICY',
    });
    expect(evalChallenge).not.toHaveBeenCalled();
  });
});

describe('LocalAuthService.requestPasswordLink', () => {
  const USER = { id: 'user-1', email: 'user@example.com', isBlocked: false, authMethod: 'password' };
  const SLOT_KEY = 'local_auth:password_reset:user-1';

  function setup(options: { reserved?: unknown; send?: ReturnType<typeof vi.fn> } = {}) {
    const evalReserve = vi.fn().mockResolvedValue(options.reserved ?? [1, 0]);
    const zrem = vi.fn().mockResolvedValue(1);
    const cache = {
      getClient: () => ({ eval: evalReserve, zrem }),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const sendSecurityEmail = options.send ?? vi.fn().mockResolvedValue('sent');
    const db = { query: { users: { findFirst: vi.fn().mockResolvedValue(USER) } } };
    const service = new LocalAuthService(
      db as never,
      cache,
      {} as never,
      { getConfig: vi.fn().mockResolvedValue({ methods: { password: true } }) } as never,
      { sendSecurityEmail } as never,
      {} as never,
      { requirePublicUrl: vi.fn().mockResolvedValue('https://opfield.example') } as never
    );
    const reservedMember = () => evalReserve.mock.calls[0]?.[5];
    return { service, evalReserve, zrem, sendSecurityEmail, reservedMember };
  }

  it('reports a used-up reset limit to an administrator as 429 with when it resets, sending nothing', async () => {
    const { service, sendSecurityEmail } = setup({ reserved: [0, 20 * 60_000] });

    await expect(service.requestPasswordLink(USER.email, 'password_reset', { wait: true })).rejects.toMatchObject({
      statusCode: 429,
      code: 'PASSWORD_RESET_RATE_LIMITED',
      details: { retryAfterSeconds: 1200 },
    });
    expect(sendSecurityEmail).not.toHaveBeenCalled();
  });

  it('answers the public reset with null when throttled, so the response does not reveal the account', async () => {
    const { service, sendSecurityEmail } = setup({ reserved: [0, 20 * 60_000] });

    await expect(service.requestPasswordLink(USER.email, 'password_reset')).resolves.toBeNull();
    expect(sendSecurityEmail).not.toHaveBeenCalled();
  });

  it('gives the slot back when the email is refused or fails to send', async () => {
    const send = vi.fn().mockRejectedValue(new AppError(429, 'MAIL_QUOTA', 'Monthly email limit reached'));
    const { service, zrem, reservedMember } = setup({ send });

    await expect(service.requestPasswordLink(USER.email, 'password_reset', { wait: true })).rejects.toMatchObject({
      code: 'MAIL_QUOTA',
    });
    expect(zrem).toHaveBeenCalledWith(SLOT_KEY, reservedMember());
  });

  it('hands the slot to the email job, so a final delivery failure releases it', async () => {
    const { service, zrem, sendSecurityEmail, reservedMember } = setup();

    await expect(service.requestPasswordLink(USER.email, 'password_reset', { wait: true })).resolves.toBe('sent');
    expect(zrem).not.toHaveBeenCalled();
    expect(sendSecurityEmail).toHaveBeenCalledWith(USER.email, expect.objectContaining({ kind: 'password_reset' }), {
      wait: true,
      rateSlot: { key: SLOT_KEY, member: reservedMember() },
    });
  });

  // O-12 (stand rc.2): four setup links in a row were all sent; setup links now have the reset links' limit.
  it('limits setup links per user like reset links, in their own window', async () => {
    const sent = setup();
    await expect(sent.service.requestPasswordLink(USER.email, 'password_setup', { wait: true })).resolves.toBe('sent');
    expect(sent.evalReserve).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'local_auth:password_setup:user-1',
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
      3,
      3600
    );
    expect(sent.sendSecurityEmail).toHaveBeenCalledWith(
      USER.email,
      expect.objectContaining({ kind: 'password_setup' }),
      {
        wait: true,
        rateSlot: { key: 'local_auth:password_setup:user-1', member: sent.reservedMember() },
      }
    );

    const throttled = setup({ reserved: [0, 5 * 60_000] });
    await expect(
      throttled.service.requestPasswordLink(USER.email, 'password_setup', { wait: true })
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'PASSWORD_SETUP_RATE_LIMITED',
      message: expect.stringContaining('password setup links'),
      details: { retryAfterSeconds: 300 },
    });
    // rc.3 GO-9: the onboarding mail takes one of the three slots, and the refusal says so.
    await expect(
      throttled.service.requestPasswordLink(USER.email, 'password_setup', { wait: true })
    ).rejects.toMatchObject({ message: expect.stringContaining('sent when the account was created') });
    expect(throttled.sendSecurityEmail).not.toHaveBeenCalled();
  });
});

/**
 * The Redis scripts of the per-account sign-in throttle and the per-user email windows, kept in memory. The throttle
 * scripts are told apart by their text; anything else is answered by `other`.
 */
function memoryRedis(other: (script: string, args: unknown[]) => unknown = () => [1, 0]) {
  const counters = new Map<string, number>();
  const locks = new Set<string>();
  const evalScript = vi.fn(async (script: string, keyCount: number, ...args: unknown[]) => {
    if (script.includes("redis.call('PTTL', lockKey)")) {
      const keys = args.slice(0, keyCount) as string[];
      const [clientLimit, accountLimit, , , withClient, withAccount] = args.slice(keyCount) as string[];
      const [clientAttempts, clientLock] = withClient === '1' ? keys.splice(0, 2) : [];
      const [accountAttempts, accountLock] = withAccount === '1' ? keys.splice(0, 2) : [];
      if ((clientLock && locks.has(clientLock)) || (accountLock && locks.has(accountLock))) return [1, 600_000];
      let client = 0;
      if (clientAttempts) {
        client = (counters.get(clientAttempts) ?? 0) + 1;
        counters.set(clientAttempts, client);
        if (client > Number(clientLimit)) {
          counters.delete(clientAttempts);
          locks.add(clientLock!);
          return [2, 900_000];
        }
      }
      if (accountAttempts) {
        const account = (counters.get(accountAttempts) ?? 0) + 1;
        counters.set(accountAttempts, account);
        if (account > Number(accountLimit)) {
          counters.delete(accountAttempts);
          if (clientAttempts) counters.set(clientAttempts, client - 1);
          locks.add(accountLock!);
          return [3, 900_000];
        }
      }
      return [0, 0];
    }
    if (script.includes("redis.call('DECR', key)")) {
      for (const key of args.slice(0, keyCount) as string[]) {
        const attempts = counters.get(key) ?? 0;
        if (attempts > 0) counters.set(key, attempts - 1);
      }
      return 0;
    }
    return other(script, args);
  });
  return { evalScript, counters, locks };
}

describe('LocalAuthService password sign-in (R1-04, R1-08)', () => {
  const PASSWORD_USER = {
    id: 'user-1',
    email: 'user@example.com',
    isBlocked: false,
    authMethod: 'password',
  };

  function setup(options: { user?: unknown; passwordHash?: string | null } = {}) {
    const redis = memoryRedis();
    const cache = { getClient: () => ({ eval: redis.evalScript }) } as unknown as CacheService;
    const db = {
      query: {
        users: { findFirst: vi.fn().mockResolvedValue(options.user === undefined ? PASSWORD_USER : options.user) },
        userPasswordCredentials: {
          findFirst: vi
            .fn()
            .mockResolvedValue(options.passwordHash === null ? null : { passwordHash: options.passwordHash ?? 'hash' }),
        },
      },
    };
    const service = new LocalAuthService(
      db as never,
      cache,
      {} as never,
      { getConfig: vi.fn().mockResolvedValue({ methods: { password: true, emailOtp: false } }) } as never,
      {} as never,
      {} as never
    );
    return { service, redis, db };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spends a bcrypt comparison when the account or its password does not exist', async () => {
    const compare = vi.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);

    await expect(setup({ user: null }).service.authenticatePassword('nobody@example.com', 'guess')).resolves.toBeNull();
    await expect(
      setup({ passwordHash: null }).service.authenticatePassword('user@example.com', 'guess')
    ).resolves.toBeNull();
    await expect(
      setup({ user: { ...PASSWORD_USER, authMethod: 'email_otp' } }).service.authenticatePassword(
        'user@example.com',
        'guess'
      )
    ).resolves.toBeNull();

    expect(compare).toHaveBeenCalledTimes(3);
    for (const call of compare.mock.calls) expect(call[1]).toMatch(/^\$2[aby]\$12\$/);
  });

  it('locks an account for the client after 10 wrong passwords from it, also for the right one', async () => {
    vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string) => password === 'right') as never);
    const { service, redis } = setup();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        service.authenticatePassword('user@example.com', 'wrong', { ip: '198.51.100.7' })
      ).resolves.toBeNull();
    }
    await expect(
      service.authenticatePassword('User@Example.com ', 'right', { ip: '198.51.100.7' })
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'SIGN_IN_LOCKED',
    });
    expect([...redis.locks]).toEqual(['auth:sign-in:locked:user:user-1:ip:198.51.100.7']);
  });

  it('lets the owner sign in from another address while a guesser is locked out', async () => {
    vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string) => password === 'right') as never);
    const { service } = setup();

    for (let attempt = 0; attempt < 11; attempt += 1) {
      await service.authenticatePassword('user@example.com', 'wrong', { ip: '198.51.100.7' }).catch(() => null);
    }

    await expect(
      service.authenticatePassword('user@example.com', 'right', { ip: '203.0.113.20' })
    ).resolves.toMatchObject({
      id: 'user-1',
    });
  });

  it('applies only the account-wide limit when the client address does not tell clients apart (M-03)', async () => {
    vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string) => password === 'right') as never);
    const { service, redis } = setup();

    // Behind an untrusted proxy every client has the proxy's address, so the route passes no address.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(service.authenticatePassword('user@example.com', 'wrong', {})).resolves.toBeNull();
    }
    await expect(service.authenticatePassword('user@example.com', 'right', {})).resolves.toMatchObject({
      id: 'user-1',
    });
    expect(redis.locks.size).toBe(0);
    expect([...redis.counters.keys()]).toEqual(['auth:sign-in:attempts:user:user-1']);
  });

  it('locks the account everywhere after 100 failures spread over many addresses', async () => {
    vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string) => password === 'right') as never);
    const { service, redis } = setup();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await expect(
        service.authenticatePassword('user@example.com', 'wrong', { ip: `198.51.100.${attempt % 50}` })
      ).resolves.toBeNull();
    }
    await expect(
      service.authenticatePassword('user@example.com', 'right', { ip: '203.0.113.20' })
    ).rejects.toMatchObject({
      statusCode: 429,
    });
    expect([...redis.locks]).toEqual(['auth:sign-in:locked:user:user-1']);
  });

  it('counts an IPv6 client by its /64 network', async () => {
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
    const { service, redis } = setup();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.authenticatePassword('user@example.com', 'wrong', { ip: `2001:db8:1:2::${attempt + 1}` });
    }
    await expect(
      service.authenticatePassword('user@example.com', 'wrong', { ip: '2001:db8:1:2:ffff::1' })
    ).rejects.toMatchObject({ statusCode: 429 });
    expect([...redis.locks]).toEqual(['auth:sign-in:locked:user:user-1:ip:20010db800010002::/64']);
    // Another /64 is another client.
    await expect(
      service.authenticatePassword('user@example.com', 'wrong', { ip: '2001:db8:1:3::1' })
    ).resolves.toBeNull();
  });

  it('lets a known device of the account through the account-wide lock, not through its own address lock', async () => {
    vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string) => password === 'right') as never);
    const { service, redis } = setup();
    redis.locks.add('auth:sign-in:locked:user:user-1');

    await expect(
      service.authenticatePassword('user@example.com', 'right', { ip: '203.0.113.20' })
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      service.authenticatePassword('user@example.com', 'right', { ip: '203.0.113.20', knownDeviceUserId: 'user-2' })
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      service.authenticatePassword('user@example.com', 'right', { ip: '203.0.113.20', knownDeviceUserId: 'user-1' })
    ).resolves.toMatchObject({ id: 'user-1' });

    redis.locks.add('auth:sign-in:locked:user:user-1:ip:203.0.113.20');
    await expect(
      service.authenticatePassword('user@example.com', 'right', { ip: '203.0.113.20', knownDeviceUserId: 'user-1' })
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it('does not count a correct password as a failure', async () => {
    vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string) => password === 'right') as never);
    const { service, redis } = setup();

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await service.authenticatePassword('user@example.com', 'wrong', { ip: '198.51.100.7' });
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.authenticatePassword('user@example.com', 'right', { ip: '198.51.100.7' })
      ).resolves.toMatchObject({
        id: 'user-1',
      });
    }
    expect(redis.counters.get('auth:sign-in:attempts:user:user-1:ip:198.51.100.7')).toBe(9);
    expect(redis.counters.get('auth:sign-in:attempts:user:user-1')).toBe(9);
  });

  it('counts guesses for an unknown email under that email', async () => {
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
    const { service, redis } = setup({ user: null });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.authenticatePassword('nobody@example.com', 'guess', { ip: '198.51.100.7' });
    }
    await expect(
      service.authenticatePassword('NOBODY@example.com', 'guess', { ip: '198.51.100.7' })
    ).rejects.toMatchObject({
      statusCode: 429,
    });
    expect([...redis.locks][0]).toMatch(/^auth:sign-in:locked:email:[a-f0-9]{64}:ip:198\.51\.100\.7$/);
  });
});

describe('LocalAuthService email codes (R1-04)', () => {
  const OTP_USER = { id: 'user-2', email: 'otp@example.com', isBlocked: false, authMethod: 'email_otp' };

  function setup(options: { reserved?: unknown[] } = {}) {
    const reserve = vi.fn().mockResolvedValue(options.reserved ?? [1, 0]);
    const redis = memoryRedis((script, args) => reserve(script, ...args));
    const store = new Map<string, unknown>();
    const cache = {
      getClient: () => ({ eval: redis.evalScript }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
    } as unknown as CacheService;
    const sendSecurityEmail = vi.fn().mockResolvedValue('sent');
    const service = new LocalAuthService(
      { query: { users: { findFirst: vi.fn().mockResolvedValue(OTP_USER) } } } as never,
      cache,
      {} as never,
      { getConfig: vi.fn().mockResolvedValue({ methods: { password: false, emailOtp: true } }) } as never,
      { sendSecurityEmail } as never,
      {} as never
    );
    return { service, reserve, redis, store, sendSecurityEmail };
  }

  it('sends at most five codes per account and hour', async () => {
    const allowed = setup();
    await expect(allowed.service.requestEmailOtp(OTP_USER.email)).resolves.toEqual(expect.any(String));
    expect(allowed.reserve).toHaveBeenCalledWith(
      expect.any(String),
      'local_auth:email_otp:user-2',
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
      5,
      3600
    );

    const throttled = setup({ reserved: [0, 60_000] });
    await expect(throttled.service.requestEmailOtp(OTP_USER.email)).resolves.toBeNull();
    expect(throttled.sendSecurityEmail).not.toHaveBeenCalled();
  });

  it('takes an account attempt before a code is checked and refuses codes while the account is locked', async () => {
    const { service, redis, store } = setup();
    store.set('local_auth:challenge:c1', { userId: OTP_USER.id, purpose: 'email_otp', secretHash: 'x', attempts: 0 });
    redis.locks.add('auth:sign-in:locked:user:user-2:ip:198.51.100.7');

    await expect(service.verifyEmailOtp('c1', '123456', { ip: '198.51.100.7' })).rejects.toMatchObject({
      statusCode: 429,
    });
    // The challenge itself was not touched: the code was never compared.
    expect(redis.evalScript.mock.calls.some(([script]) => String(script).includes('cjson'))).toBe(false);
  });
});
