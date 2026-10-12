import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { permissionGroups, settings, users } from '@/db/schema/index.js';
import { FINALIZE_SETUP_STATE_KEY } from '@/modules/onboarding/finalize-setup.service.js';
import { issueOwnerPasswordLink } from './owner-password-link.js';
import { MANAGED_SIGN_IN_DETACH_SQL } from './transfer-docker.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!url)('a copy restored from a managed installation, on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let db: DrizzleClient;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'restore_sign_in');
    db = drizzle(database.pool, { schema }) as unknown as DrizzleClient;
    await migrateDatabase(database.pool);
    const [group] = await db
      .insert(permissionGroups)
      .values({ name: `restore-sign-in-${randomBytes(4).toString('hex')}` })
      .returning({ id: permissionGroups.id });
    await db.insert(users).values([
      { id: OWNER, oidcSubject: 'portal|owner', email: 'owner@example.com', name: 'Owner', groupId: group!.id },
      { id: MEMBER, oidcSubject: 'portal|member', email: 'member@example.com', name: 'Member', groupId: group!.id },
    ]);
    await db.insert(settings).values([
      { key: FINALIZE_SETUP_STATE_KEY, value: { ownerUserId: OWNER } },
      { key: 'auth:methods', value: { oidc: true, password: false, emailOtp: true, passkeyLogin: false } },
      { key: 'license:key_encrypted', value: 'enc:key' },
      { key: 'license:installation_id', value: 'cloud-installation' },
      { key: 'license:cached_state_v5', value: { plan: 'business' } },
      { key: 'license:onboarding_completed', value: true },
    ]);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('turns OIDC off and password on, drops the cloud license, moves only the owner to a password, and issues a link', async () => {
    await database.pool.query(MANAGED_SIGN_IN_DETACH_SQL);
    const [methods] = await db.select().from(settings).where(eq(settings.key, 'auth:methods'));
    expect(methods!.value).toEqual({ oidc: false, password: true, emailOtp: true, passkeyLogin: false });
    const kept = await db.select({ key: settings.key }).from(settings);
    const keys = kept.map((row) => row.key);
    expect(keys).not.toContain('license:key_encrypted');
    expect(keys).not.toContain('license:installation_id');
    expect(keys).not.toContain('license:cached_state_v5');
    expect(keys).toContain('license:onboarding_completed');
    const rows = await db.select({ id: users.id, authMethod: users.authMethod }).from(users);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.authMethod]))).toMatchObject({
      [OWNER]: 'password',
      [MEMBER]: 'oidc',
    });

    const set = vi.fn(async () => undefined);
    const link = await issueOwnerPasswordLink(db, { set }, 'https://gw.example.com');
    expect(link.email).toBe('owner@example.com');
    expect(link.url).toMatch(/^https:\/\/gw\.example\.com\/reset-password\?token=/);
    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(/^local_auth:challenge:/),
      expect.objectContaining({ userId: OWNER, purpose: 'password_setup' }),
      24 * 60 * 60
    );
  });

  it('writes the methods when the export had none stored', async () => {
    await db.delete(settings).where(eq(settings.key, 'auth:methods'));
    await database.pool.query(MANAGED_SIGN_IN_DETACH_SQL);
    const [methods] = await db.select().from(settings).where(eq(settings.key, 'auth:methods'));
    expect(methods!.value).toEqual({ oidc: false, password: true, emailOtp: false, passkeyLogin: false });
  });
});
