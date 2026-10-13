import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import { normalizeEnvironmentSettings as v2113ReadEnvironmentSettings } from '@/modules/settings/fixtures/v2.11.3-environment-settings.js';
import { CryptoService } from '@/services/crypto.service.js';
import { parseLegacySettingsEnv } from './legacy-settings-env.js';
import { importLegacySettings } from './legacy-settings-import.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/** The last migration of v2.11.3: the database the 2.11.3 updater runs the 2.11.4 image against. */
const V2113_LAST_MIGRATION = '0227_relay_stream_resume';

/** A .env of an install that has been on 2.11 since before 2.11.3: nothing legacy is left in it. */
const V2113_ENV = `GATEWAY_VERSION=v2.11.3
DATABASE_URL=postgresql://gateway:secret@postgres:5432/gateway
PKI_MASTER_KEY=${'a'.repeat(64)}
`;

/**
 * The 2.11.3 updater runs the target image's dist/cli/migrate-legacy-settings.js against the live database before it
 * snapshots it, so a rollback restores what that step wrote and v2.11.3 starts on it (rc.10 upgrade run, F-1: rc.10
 * wrote its full defaults, including sessionMaxRequests, and v2.11.3 refused to start on the restored database).
 */
describe.skipIf(!url)('legacy settings import before the pre-update snapshot, on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const crypto = new CryptoService(randomBytes(32).toString('hex'));
  const environmentRow = async () =>
    (await pool.query(`select value from settings where key = 'environment:settings'`)).rows[0]?.value as
      | Record<string, unknown>
      | undefined;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'legacy_settings');
    pool = database.pool;
    db = drizzle(pool, { schema });
    await migrateDatabase(pool, V2113_LAST_MIGRATION);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('writes no environment row for an install with nothing legacy, and v2.11.3 reads every row it wrote', async () => {
    const before = (await pool.query('select key from settings')).rows.map((row) => row.key as string);
    const result = await importLegacySettings(db, crypto, parseLegacySettingsEnv(V2113_ENV));
    expect(result.environmentImported).toBe(false);
    expect(await environmentRow()).toBeUndefined();
    // v2.11.3 starts on what the step left: its own reader of the environment settings takes the (absent) row.
    expect(() => v2113ReadEnvironmentSettings(undefined)).not.toThrow();
    // The only other row it writes comes from code v2.11.3 ships unchanged: logging stays as v2.11.3 left it.
    const written = (await pool.query('select key from settings')).rows
      .map((row) => row.key as string)
      .filter((key) => !before.includes(key));
    expect(written).toEqual(['logging:clickhouse']);
    expect(
      (await pool.query(`select value from settings where key = 'logging:clickhouse'`)).rows[0].value
    ).toMatchObject({
      mode: 'disabled',
    });
  });

  it('writes only the values a legacy .env gave, which v2.11.3 reads; v2.11.4 fills in its defaults', async () => {
    await pool.query(`delete from settings where key = 'environment:settings'`);
    const legacy = `${V2113_ENV}RATE_LIMIT_MAX_REQUESTS=900\nSESSION_EXPIRY=86400\n`;
    const result = await importLegacySettings(db, crypto, parseLegacySettingsEnv(legacy));
    expect(result.environmentImported).toBe(true);
    const row = await environmentRow();
    expect(row).toEqual({ rateLimits: { maxRequests: 900 }, sessions: { expirySeconds: 86_400 } });

    // The pre-update snapshot holds this row; after a rollback v2.11.3 starts on it.
    const v2113 = v2113ReadEnvironmentSettings(row);
    expect(v2113.rateLimits.maxRequests).toBe(900);
    expect(v2113.sessions.expirySeconds).toBe(86_400);

    // The update goes on: v2.11.4's migrations, then its start reads the same row with its new keys from code.
    await migrateDatabase(pool);
    const v2114 = await new EnvironmentSettingsService(db).initialize();
    expect(v2114.rateLimits.maxRequests).toBe(900);
    expect(v2114.rateLimits.sessionMaxRequests).toBe(DEFAULT_ENVIRONMENT_SETTINGS.rateLimits.sessionMaxRequests);
    expect(v2114.sessions.expirySeconds).toBe(86_400);
  });

  it('reproduces F-1: v2.11.3 refuses the full v2.11.4 defaults rc.10 wrote', () => {
    expect(() => v2113ReadEnvironmentSettings(DEFAULT_ENVIRONMENT_SETTINGS)).toThrow(/sessionMaxRequests/);
  });

  it('starts on rows written around a rollback-then-update cycle', async () => {
    const service = new EnvironmentSettingsService(db);
    // A full row v2.11.4 saved, a row v2.11.3 saved after a rollback (no sessionMaxRequests), and one a later release
    // saved before a rollback to v2.11.4 (a key v2.11.4 does not know).
    const { sessionMaxRequests: _new, ...v2113RateLimits } = DEFAULT_ENVIRONMENT_SETTINGS.rateLimits;
    for (const value of [
      { ...DEFAULT_ENVIRONMENT_SETTINGS, rateLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.rateLimits, maxRequests: 700 } },
      { ...DEFAULT_ENVIRONMENT_SETTINGS, rateLimits: { ...v2113RateLimits, maxRequests: 700 } },
      {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        rateLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.rateLimits, maxRequests: 700, laterMaxRequests: 5 },
        laterGroup: { anything: true },
      },
    ]) {
      await pool.query(`update settings set value = $1 where key = 'environment:settings'`, [JSON.stringify(value)]);
      const settings = await service.initialize();
      expect(settings.rateLimits.maxRequests).toBe(700);
      expect(settings.rateLimits.sessionMaxRequests).toBe(DEFAULT_ENVIRONMENT_SETTINGS.rateLimits.sessionMaxRequests);
      expect(settings.rateLimits).not.toHaveProperty('laterMaxRequests');
      expect(settings).not.toHaveProperty('laterGroup');
    }
    // A later update finds the row and imports nothing over it.
    await expect(service.importLegacy({ rateLimits: { maxRequests: 1 } })).resolves.toBe(false);
  });
});
