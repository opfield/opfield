import { describe, expect, it } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { resolveSlugVisibleTo } from './ai.slug-lookup.js';

describe('resolveSlugVisibleTo', () => {
  it('returns the resource when the caller may view it', async () => {
    const found = await resolveSlugVisibleTo(
      'Route',
      async () => ({ id: 'a' }),
      (id) => id === 'a'
    );
    expect(found).toEqual({ id: 'a' });
  });

  it('answers a forbidden resource exactly like a missing slug', async () => {
    const forbidden = await resolveSlugVisibleTo(
      'Route',
      async () => ({ id: 'a' }),
      () => false
    ).catch((error) => error);
    const missing = await resolveSlugVisibleTo(
      'Route',
      async () => {
        throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Route not found');
      },
      () => true
    ).catch((error) => error);
    expect(forbidden).toBeInstanceOf(AppError);
    expect(missing).toBeInstanceOf(AppError);
    expect([forbidden.statusCode, forbidden.code, forbidden.message]).toEqual([
      missing.statusCode,
      missing.code,
      missing.message,
    ]);
    expect(forbidden.statusCode).toBe(404);
  });

  it('passes other lookup errors through', async () => {
    const failure = new AppError(503, 'UNAVAILABLE', 'down');
    await expect(
      resolveSlugVisibleTo(
        'Route',
        async () => {
          throw failure;
        },
        () => true
      )
    ).rejects.toBe(failure);
  });
});
