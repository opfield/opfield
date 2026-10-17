import { describe, expect, it } from 'vitest';
import { parseLegacySettingsEnv } from '@/cli/legacy-settings-env.js';
import { LEGACY_ENV_PREFIX } from '@/lib/legacy-compat.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
  legacyEnvironmentOverrides,
  normalizeEnvironmentSettings,
} from './environment-settings.service.js';
import { normalizeEnvironmentSettings as v2113ReadEnvironmentSettings } from './fixtures/v2.11.3-environment-settings.js';

/** A settings table of one optional row; records what was written. */
function fakeDb(existing?: unknown) {
  const writes: unknown[] = [];
  const db = {
    select: () => {
      const query: any = Promise.resolve(
        existing === undefined ? [] : [{ key: 'environment:settings', value: existing }]
      );
      for (const method of ['from', 'where', 'limit']) query[method] = () => query;
      return query;
    },
    insert: () => ({
      values: (row: { value: unknown }) => {
        writes.push(row.value);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  };
  return { db: db as never, writes };
}

describe('legacy environment settings import (runs before the pre-update snapshot)', () => {
  it('writes no row when the .env has nothing legacy', async () => {
    const { db, writes } = fakeDb();
    const parsed = parseLegacySettingsEnv(`${LEGACY_ENV_PREFIX}VERSION=v2.11.3\n`);
    expect(legacyEnvironmentOverrides(parsed.environment)).toBeNull();
    await expect(new EnvironmentSettingsService(db).importLegacy(parsed.environment)).resolves.toBe(false);
    expect(writes).toEqual([]);
  });

  it('writes only the keys the .env gave, a row the previous stable (v2.11.3) starts on', async () => {
    const { db, writes } = fakeDb();
    const parsed = parseLegacySettingsEnv('RATE_LIMIT_AUTH_MAX_REQUESTS=90\nEXPIRY_WARNING_DAYS=40\n');
    const service = new EnvironmentSettingsService(db);
    await expect(service.importLegacy(parsed.environment)).resolves.toBe(true);
    expect(writes).toEqual([{ rateLimits: { authMaxRequests: 90 }, pkiDefaults: { expiryWarningDays: 40 } }]);
    const v2113 = v2113ReadEnvironmentSettings(writes[0]);
    expect(v2113.rateLimits.authMaxRequests).toBe(90);
    expect(v2113.pkiDefaults.expiryWarningDays).toBe(40);
    // This release reads it with its own defaults for the rest.
    expect(service.getSnapshot().rateLimits.sessionMaxRequests).toBe(6_000);
  });

  it('still refuses a legacy value this release does not accept', async () => {
    const { db, writes } = fakeDb();
    await expect(
      new EnvironmentSettingsService(db).importLegacy({ sessions: { expirySeconds: 10 } })
    ).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it('reproduces the rc.10 failure: v2.11.3 refuses a row with the keys 2.11.4 added', () => {
    expect(() => v2113ReadEnvironmentSettings(DEFAULT_ENVIRONMENT_SETTINGS)).toThrow(/sessionMaxRequests/);
  });
});

describe('stored environment settings of other releases', () => {
  it('fills in what a partial or older row lacks', () => {
    const settings = normalizeEnvironmentSettings({ rateLimits: { maxRequests: 900 } });
    expect(settings.rateLimits.maxRequests).toBe(900);
    expect(settings.rateLimits.sessionMaxRequests).toBe(DEFAULT_ENVIRONMENT_SETTINGS.rateLimits.sessionMaxRequests);
    expect(settings.loggingIngest).toEqual(DEFAULT_ENVIRONMENT_SETTINGS.loggingIngest);
  });

  it('drops keys and groups a later release added, and takes the default for values it does not accept', () => {
    const settings = normalizeEnvironmentSettings({
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      rateLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.rateLimits, laterMaxRequests: 3, windowMs: 'soon' },
      requestLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.requestLimits, requestBodyMaxBytes: 1024 * 1024 * 1024 },
      pkiDefaults: { crlValidityHours: 12, expiryWarningDays: 5, expiryCriticalDays: 9 },
      laterGroup: { enabled: true },
    });
    expect(settings.rateLimits).not.toHaveProperty('laterMaxRequests');
    expect(settings).not.toHaveProperty('laterGroup');
    expect(settings.rateLimits.windowMs).toBe(DEFAULT_ENVIRONMENT_SETTINGS.rateLimits.windowMs);
    // Above this release's maximum: lowered to it, as before.
    expect(settings.requestLimits.requestBodyMaxBytes).toBe(32 * 1024 * 1024);
    expect(settings.pkiDefaults).toEqual(DEFAULT_ENVIRONMENT_SETTINGS.pkiDefaults);
  });
});
