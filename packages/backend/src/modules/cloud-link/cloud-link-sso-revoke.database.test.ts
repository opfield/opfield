import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { syncPermissionGroupsAtStartup } from '@/lib/startup-scope-sync.js';
import { AuthService, type NormalizedOidcClaims } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { CloudLinkService } from './cloud-link.service.js';
import { CloudSsoRevoker } from './cloud-link-sso-revoke.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const ISSUER = 'https://account.opfield.dev';
const OTHER_ISSUER = 'https://id.customer.example';
const SUB_ADA = '0b6f1a52-6a51-4c5e-9d8e-0f3f4a2b7c11';
const SUB_BOB = '1c7e2b63-7b62-4d6f-8e9f-1a4a5b3c8d22';
const SUB_OPS = '2d8f3c74-8c73-4e70-9fa0-2b5b6c4d9e33';
const SUB_NOBODY = '3e904d85-9d84-4f81-a0b1-3c6c7d5eaf44';

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the Opfield account removes people's access (sso-revoke). Accounts are
 * matched by issuer and subject, blocked as the Opfield account's with their sessions ended and tokens refused, the
 * next sign-in through that issuer lifts only that block, and an administrator's block wins over it.
 */
describe.skipIf(!url)('Opfield account access removal over the cloud link (PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let crypto: CryptoService;
  const audit = vi.fn(async (_entry: Record<string, unknown>) => undefined);
  const sessions = { destroyAllUserSessions: vi.fn(async (_userId: string) => undefined) };
  let auth: AuthService;
  let revoker: CloudSsoRevoker;
  const ids: Record<string, string> = {};

  const groupId = async (admin: boolean) => {
    const [group] = await db
      .select({ id: schema.permissionGroups.id })
      .from(schema.permissionGroups)
      .where(
        admin ? eq(schema.permissionGroups.name, 'system-admin') : ne(schema.permissionGroups.name, 'system-admin')
      )
      .limit(1);
    return group!.id;
  };
  const addUser = async (email: string, sub: string | null, issuer: string | null, admin = false) => {
    const [row] = await db
      .insert(schema.users)
      .values({
        email,
        name: email.split('@')[0]!,
        authMethod: sub ? 'oidc' : 'password',
        oidcSubject: sub,
        oidcIssuer: issuer,
        groupId: await groupId(admin),
      })
      .returning({ id: schema.users.id });
    return row!.id;
  };
  const row = async (id: string) => (await db.query.users.findFirst({ where: eq(schema.users.id, id) }))!;
  const revokeEntries = () =>
    audit.mock.calls.map(([entry]) => entry).filter((entry) => entry.action === 'cloud.sso_revoke');
  const signIn = (sub: string, issuer: string) =>
    (
      auth as unknown as { findOrCreateUser(data: NormalizedOidcClaims): Promise<{ id: string; isBlocked: boolean }> }
    ).findOrCreateUser({
      oidcSubject: sub,
      oidcIssuer: issuer,
      email: null,
      emailVerified: false,
      name: null,
      avatarUrl: null,
    });

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'sso_revoke');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    await syncPermissionGroupsAtStartup(db, 'standard');
    crypto = new CryptoService(randomBytes(32).toString('hex'));
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    audit.mockClear();
    sessions.destroyAllUserSessions.mockClear();
    await pool.query(`delete from api_tokens`);
    await pool.query(`delete from users where oidc_subject is null or oidc_subject not like 'system:%'`);
    const cloud = new CloudLinkService(
      db,
      crypto,
      { CLOUD_PORTAL_URL: ISSUER, APP_VERSION: 'v2.12.1' },
      { getInstallationId: async () => 'installation-1', getInstallationName: () => 'gw' },
      null
    );
    cloud.setAuditService({ log: audit } as never);
    auth = new AuthService(db, sessions as never, {} as never, new AuthSettingsService(db), { log: audit } as never);
    revoker = new CloudSsoRevoker({ db, auth, cloud });
    // The owner signs in with a password and stays an active administrator; Ada (an administrator too) and Bob
    // signed in with the Opfield account; Carol has the same subject as Bob under another issuer.
    ids.owner = await addUser('owner@example.com', null, null, true);
    ids.ada = await addUser('ada@example.com', SUB_ADA, ISSUER, true);
    ids.bob = await addUser('bob@example.com', SUB_BOB, `${ISSUER}`);
    ids.ops = await addUser('ops@example.com', SUB_OPS, OTHER_ISSUER);
  });

  it('blocks the accounts of the issuer and subjects, idempotently, and leaves other issuers alone', async () => {
    const answer = await revoker.revoke({
      issuer: `${ISSUER}/`,
      subjects: [SUB_ADA, SUB_BOB, SUB_OPS, SUB_NOBODY, SUB_BOB],
      reason: 'removed_from_team',
    });
    expect(answer).toEqual({
      revoked: [
        { sub: SUB_ADA, userId: ids.ada },
        { sub: SUB_BOB, userId: ids.bob },
      ],
      unknown: [SUB_OPS, SUB_NOBODY],
    });
    expect(await row(ids.ada)).toMatchObject({ isBlocked: true, blockedBy: 'opfield_account' });
    expect(await row(ids.bob)).toMatchObject({ isBlocked: true, blockedBy: 'opfield_account' });
    // Same subject under the customer's own issuer: another person, untouched.
    expect(await row(ids.ops)).toMatchObject({ isBlocked: false, blockedBy: null });
    expect(await row(ids.owner)).toMatchObject({ isBlocked: false });
    expect(sessions.destroyAllUserSessions.mock.calls.map(([id]) => id).sort()).toEqual([ids.ada, ids.bob].sort());

    const [entry] = revokeEntries();
    expect(entry).toMatchObject({
      action: 'cloud.sso_revoke',
      resourceType: 'cloud-link',
      details: { reason: 'removed_from_team', blocked: 2, alreadyBlocked: 0, unknown: 2 },
    });
    expect((entry!.details as { users: unknown[] }).users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ids.bob, email: 'bob@example.com', outcome: 'blocked' }),
      ])
    );

    // Again: the same answer, nothing changes, no session is ended twice.
    sessions.destroyAllUserSessions.mockClear();
    await expect(
      revoker.revoke({ issuer: ISSUER, subjects: [SUB_ADA, SUB_BOB, SUB_NOBODY], reason: 'access_removed' })
    ).resolves.toEqual({
      revoked: [
        { sub: SUB_ADA, userId: ids.ada },
        { sub: SUB_BOB, userId: ids.bob },
      ],
      unknown: [SUB_NOBODY],
    });
    expect(sessions.destroyAllUserSessions).not.toHaveBeenCalled();
    expect(revokeEntries()[1]).toMatchObject({ details: { blocked: 0, alreadyBlocked: 2, unknown: 1 } });
  });

  it('refuses the tokens of a blocked account without deleting them, and the next sign-in through the issuer lifts it', async () => {
    const tokens = new TokensService(db, { log: audit } as never);
    const created = await tokens.createToken(ids.bob, { name: 'ci', scopes: ['nodes:details'] } as never);
    const raw = created.token;
    expect(await tokens.validateToken(raw)).not.toBeNull();

    await revoker.revoke({ issuer: ISSUER, subjects: [SUB_BOB], reason: 'account_suspended' });
    expect(await tokens.validateToken(raw)).toBeNull();
    // What OAuth, MCP and live connections check.
    expect(await resolveLiveUser(db, ids.bob)).toMatchObject({ isBlocked: true, blockedBy: 'opfield_account' });
    expect(
      (await pool.query(`select count(*)::int as n from api_tokens where user_id = $1`, [ids.bob])).rows[0].n
    ).toBe(1);

    // A sign-in through another issuer with the same subject is refused as before and lifts nothing.
    await expect(signIn(SUB_BOB, OTHER_ISSUER)).rejects.toMatchObject({ code: 'OIDC_ISSUER_MISMATCH' });
    expect(await row(ids.bob)).toMatchObject({ isBlocked: true, blockedBy: 'opfield_account' });

    const user = await signIn(SUB_BOB, ISSUER);
    expect(user).toMatchObject({ id: ids.bob, isBlocked: false });
    expect(await row(ids.bob)).toMatchObject({ isBlocked: false, blockedBy: null });
    expect(audit.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ action: 'user.opfield_account_unblock', resourceId: ids.bob })
    );
    expect(await tokens.validateToken(raw)).not.toBeNull();
  });

  it("never lifts an administrator's block by a sign-in, and an administrator's unblock lifts either", async () => {
    // An administrator blocked Bob first: the account's request keeps it the administrator's.
    await auth.blockUser(ids.bob);
    await expect(revoker.revoke({ issuer: ISSUER, subjects: [SUB_BOB], reason: 'access_removed' })).resolves.toEqual({
      revoked: [{ sub: SUB_BOB, userId: ids.bob }],
      unknown: [],
    });
    expect(await row(ids.bob)).toMatchObject({ isBlocked: true, blockedBy: 'admin' });
    await expect(signIn(SUB_BOB, ISSUER)).resolves.toMatchObject({ isBlocked: true });
    expect(await row(ids.bob)).toMatchObject({ isBlocked: true, blockedBy: 'admin' });

    // Unblock, then the account blocks him; an administrator's block turns it into theirs.
    await auth.unblockUser(ids.bob);
    await revoker.revoke({ issuer: ISSUER, subjects: [SUB_BOB], reason: 'access_removed' });
    expect(await row(ids.bob)).toMatchObject({ blockedBy: 'opfield_account' });
    expect((await auth.blockUser(ids.bob)).blockedBy).toBe('admin');
    await signIn(SUB_BOB, ISSUER);
    expect(await row(ids.bob)).toMatchObject({ isBlocked: true, blockedBy: 'admin' });

    // An administrator's unblock lifts the account's block too.
    await auth.unblockUser(ids.bob);
    await revoker.revoke({ issuer: ISSUER, subjects: [SUB_BOB], reason: 'access_removed' });
    expect((await auth.unblockUser(ids.bob)).blockedBy).toBeNull();
    expect(await row(ids.bob)).toMatchObject({ isBlocked: false, blockedBy: null });
  });

  it('never blocks the last active system administrator', async () => {
    await auth.blockUser(ids.owner);
    const answer = await revoker.revoke({ issuer: ISSUER, subjects: [SUB_ADA], reason: 'installation_moved' });
    expect(answer).toEqual({
      revoked: [],
      unknown: [],
      kept: [{ sub: SUB_ADA, userId: ids.ada, code: 'LAST_SYSTEM_ADMIN' }],
    });
    expect(await row(ids.ada)).toMatchObject({ isBlocked: false });
    expect(revokeEntries()[0]).toMatchObject({ details: { kept: 1, reason: 'installation_moved' } });
  });
});
