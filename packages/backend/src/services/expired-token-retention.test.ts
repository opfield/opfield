import { describe, expect, it, vi } from 'vitest';
import { apiTokens, inferenceTokens } from '@/db/schema/index.js';
import { expiredTokenCutoff, purgeExpiredTokens } from './expired-token-retention.js';

const OWNER = '11111111-1111-4111-8111-111111111111';

describe('expired token retention', () => {
  it('keeps expired tokens for the retention period; 0 removes them at once', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(expiredTokenCutoff(7, now).toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(expiredTokenCutoff(0, now).toISOString()).toBe(now.toISOString());
  });

  it('removes expired API and inference tokens, audits each as a system action and refreshes the owner lists', async () => {
    const expiresAt = new Date('2026-10-01T00:00:00Z');
    const removed = new Map<unknown, unknown[]>([
      [apiTokens, [{ id: 'api-1', userId: OWNER, name: 'CI', tokenPrefix: 'opf_abc', expiresAt }]],
      [inferenceTokens, [{ id: 'inf-1', userId: OWNER, name: 'Laptop', tokenPrefix: 'opfi_abc', expiresAt }]],
    ]);
    const db = {
      delete: vi.fn((table: unknown) => ({
        where: () => ({ returning: async () => removed.get(table) ?? [] }),
      })),
    };
    const log = vi.fn().mockResolvedValue(true);
    const publish = vi.fn();

    const result = await purgeExpiredTokens(db as any, 7, { auditService: { log }, eventBus: { publish } });

    expect(result).toEqual({ api: 1, inference: 1, total: 2 });
    expect(log.mock.calls.map(([entry]) => [entry.action, entry.userId, entry.resourceId])).toEqual([
      ['api_token.remove_expired', null, 'api-1'],
      ['inference_token.remove_expired', null, 'inf-1'],
    ]);
    expect(log.mock.calls[0]![0].details).toMatchObject({ name: 'CI', ownerUserId: OWNER, retentionDays: 7 });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
