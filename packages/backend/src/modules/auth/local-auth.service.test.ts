import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import type { CacheService } from '@/services/cache.service.js';
import { LocalAuthService } from './local-auth.service.js';

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
    expect(throttled.sendSecurityEmail).not.toHaveBeenCalled();
  });
});
