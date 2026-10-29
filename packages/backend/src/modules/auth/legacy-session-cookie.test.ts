import { describe, expect, it } from 'vitest';
import type { SessionData } from '@/types.js';
import { initializeHostCookieSince, sessionAllowedForCookie } from './legacy-session-cookie.js';

/** A settings table of at most one row per key, with insert-if-absent like the real one. */
function settingsDb(stored?: { since: string }) {
  let value: unknown = stored;
  const db = {
    insert: () => ({
      values: (row: { value: unknown }) => ({
        onConflictDoNothing: async () => {
          value ??= row.value;
        },
      }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (value === undefined ? [] : [{ value }]) }) }),
    }),
  };
  return { db: db as never, stored: () => value };
}

const sessionAt = (createdAt: number) => ({ userId: 'u1', createdAt, expiresAt: createdAt + 60_000 }) as SessionData;

describe('legacy-named session cookies (L-08)', () => {
  it('accepts a legacy-named cookie only for a session created before the first start of this release', async () => {
    const firstStart = Date.parse('2026-10-20T00:00:00Z');
    const { db, stored } = settingsDb({ since: new Date(firstStart).toISOString() });

    await initializeHostCookieSince(db);

    // The first start stays recorded: a restart does not move it.
    expect(stored()).toEqual({ since: '2026-10-20T00:00:00.000Z' });
    expect(sessionAllowedForCookie({ legacy: true }, sessionAt(firstStart - 1))).toBe(true);
    expect(sessionAllowedForCookie({ legacy: true }, sessionAt(firstStart + 1))).toBe(false);
    expect(sessionAllowedForCookie({ legacy: false }, sessionAt(firstStart + 1))).toBe(true);
  });

  it('records the first start when it is missing, so sessions signed in from now on need the __Host- cookie', async () => {
    const { db, stored } = settingsDb();
    const before = Date.now();

    await initializeHostCookieSince(db);

    const since = Date.parse((stored() as { since: string }).since);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(sessionAllowedForCookie({ legacy: true }, sessionAt(before - 1_000))).toBe(true);
    expect(sessionAllowedForCookie({ legacy: true }, sessionAt(Date.now() + 1_000))).toBe(false);
  });

  it('refuses legacy-named cookies when the date cannot be read', async () => {
    const failing = {
      insert: () => {
        throw new Error('database unavailable');
      },
    };

    await initializeHostCookieSince(failing as never);

    expect(sessionAllowedForCookie({ legacy: true }, sessionAt(0))).toBe(false);
  });
});
