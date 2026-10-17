import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens, permissionGroups, users } from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { User } from '@/types.js';
import { hashSecret, OAuthTokenLifecycle } from './oauth-token-lifecycle.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const USER_ID = '33333333-3333-4333-8333-333333333333';
const API = 'https://opfield.example.com/api';
const MCP = 'https://opfield.example.com/api/mcp';
const CLIENT = 'goc_claude_code';
const OLD_MCP = '44444444-4444-4444-8444-444444444441';
const NEW_MCP = '44444444-4444-4444-8444-444444444442';
const REFRESH_FIRST = '55555555-5555-4555-8555-555555555551';
const REFRESH_LIVE = '55555555-5555-4555-8555-555555555552';
const REFRESH_ACCESS = '66666666-6666-4666-8666-666666666661';

const token = () => randomBytes(8).toString('hex');

describe.skipIf(!url)('OAuth authorizations are one per consent, on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let db: DrizzleClient;
  let lifecycle: OAuthTokenLifecycle;
  const user = { id: USER_ID, scopes: ['mcp:use', 'nodes:details', 'docker:containers:secrets'] } as User;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'oauth_authorizations');
    db = drizzle(database.pool, { schema }) as unknown as DrizzleClient;
    await migrateDatabase(database.pool);
    const [group] = await db
      .insert(permissionGroups)
      .values({ name: `oauth-grants-${token()}`, scopes: user.scopes })
      .returning({ id: permissionGroups.id });
    await db.insert(users).values({ id: USER_ID, email: 'owner@example.com', name: 'Owner', groupId: group!.id });
    await db.insert(oauthClients).values({ clientId: CLIENT, clientName: 'Claude Code', redirectUris: [] });
    const now = Date.now();
    await db.insert(oauthAccessTokens).values([
      // Two consents of the same MCP client: the older one broader than the newer one.
      {
        id: OLD_MCP,
        tokenHash: token(),
        tokenPrefix: 'gwo_old',
        clientId: CLIENT,
        userId: USER_ID,
        scopes: ['nodes:details', 'docker:containers:secrets'],
        resource: MCP,
        createdAt: new Date('2026-10-02T10:00:00Z'),
      },
      {
        id: NEW_MCP,
        tokenHash: token(),
        tokenPrefix: 'gwo_new',
        clientId: CLIENT,
        userId: USER_ID,
        scopes: ['nodes:details'],
        resource: MCP,
        createdAt: new Date('2026-10-12T07:00:00Z'),
      },
    ]);
    // A third consent on the API resource, already rotated once.
    await db.insert(oauthRefreshTokens).values([
      {
        id: REFRESH_LIVE,
        tokenHash: token(),
        tokenPrefix: 'gwr_live',
        clientId: CLIENT,
        userId: USER_ID,
        scopes: ['nodes:details'],
        resource: API,
        expiresAt: new Date(now + 86_400_000),
      },
    ]);
    await db.insert(oauthRefreshTokens).values({
      id: REFRESH_FIRST,
      tokenHash: token(),
      tokenPrefix: 'gwr_first',
      clientId: CLIENT,
      userId: USER_ID,
      scopes: ['nodes:details'],
      resource: API,
      expiresAt: new Date(now + 86_400_000),
      revokedAt: new Date(now - 60_000),
      replacedByTokenId: REFRESH_LIVE,
      createdAt: new Date('2026-10-05T10:00:00Z'),
    });
    await db.insert(oauthAccessTokens).values({
      id: REFRESH_ACCESS,
      tokenHash: token(),
      tokenPrefix: 'gwo_api',
      clientId: CLIENT,
      userId: USER_ID,
      refreshTokenId: REFRESH_LIVE,
      scopes: ['nodes:details'],
      resource: API,
      expiresAt: new Date(now + 600_000),
    });

    lifecycle = new OAuthTokenLifecycle({
      db,
      auditService: { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      getApiResourceUrl: () => API,
      getMcpResourceUrl: () => MCP,
      getClient: async () => ({ clientId: CLIENT, clientName: 'Claude Code', clientUri: null, logoUri: null }),
      isSupportedResource: () => true,
      assertResourceAllowed: () => undefined,
      grantScopes: (_user, _resource, scopes) => [...new Set(scopes)].sort(),
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('lists each consent separately, a rotated chain under its first token', async () => {
    const authorizations = await lifecycle.listUserAuthorizations(USER_ID);
    expect(Object.fromEntries(authorizations.map((item) => [item.id, item.scopes]))).toEqual({
      [OLD_MCP]: ['docker:containers:secrets', 'nodes:details'],
      [NEW_MCP]: ['nodes:details'],
      [REFRESH_FIRST]: ['nodes:details'],
    });
  });

  it('saving one consent never widens another consent of the same client', async () => {
    await lifecycle.updateUserAuthorizationScopes(user, NEW_MCP, ['nodes:details']);
    const rows = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, CLIENT));
    const scopesOf = (id: string) => rows.find((row) => row.id === id)?.scopes;
    expect(scopesOf(NEW_MCP)).toEqual(['nodes:details']);
    expect(scopesOf(OLD_MCP)).toEqual(['nodes:details', 'docker:containers:secrets']);
  });

  it('limits one consent in time and place; its tokens are refused outside them', async () => {
    const raw = `opfo_${token()}`;
    const limitedId = '44444444-4444-4444-8444-444444444443';
    await db.insert(oauthAccessTokens).values({
      id: limitedId,
      tokenHash: hashSecret(raw),
      tokenPrefix: 'opfo_lim',
      clientId: CLIENT,
      userId: USER_ID,
      scopes: ['nodes:details'],
      resource: MCP,
    });
    const until = new Date(Date.now() + 3_600_000);
    const updated = await lifecycle.updateUserAuthorization(user, limitedId, {
      grantExpiresAt: until,
      allowedIps: ['203.0.113.10', '10.0.0.0/8'],
    });
    expect(updated).toMatchObject({
      allowedIps: ['203.0.113.10', '10.0.0.0/8'],
      grantExpiresAt: until.toISOString(),
      expiresAt: until.toISOString(),
    });
    // Other consents of the same client keep no limits.
    const others = (await lifecycle.listUserAuthorizations(USER_ID)).filter((item) => item.id !== limitedId);
    expect(others.every((item) => item.allowedIps.length === 0 && item.grantExpiresAt === null)).toBe(true);

    await expect(lifecycle.validateAccessToken(raw, { resource: MCP, clientIp: '10.1.2.3' })).resolves.not.toBeNull();
    await expect(lifecycle.validateAccessToken(raw, { resource: MCP, clientIp: '198.51.100.7' })).resolves.toBeNull();
    await expect(lifecycle.validateAccessToken(raw, { resource: MCP })).resolves.toBeNull();

    // Past its own expiry the consent is gone from the list and its token refused.
    await db
      .update(oauthAccessTokens)
      .set({ grantExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthAccessTokens.id, limitedId));
    await expect(lifecycle.validateAccessToken(raw, { resource: MCP, clientIp: '10.1.2.3' })).resolves.toBeNull();
    expect((await lifecycle.listUserAuthorizations(USER_ID)).some((item) => item.id === limitedId)).toBe(false);
    await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.id, limitedId));
  });

  it('revoking a rotated chain revokes only that chain', async () => {
    await lifecycle.revokeUserAuthorization(USER_ID, REFRESH_FIRST);
    const [live] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, REFRESH_LIVE));
    const access = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, CLIENT));
    expect(live?.revokedAt).not.toBeNull();
    expect(access.find((row) => row.id === REFRESH_ACCESS)?.revokedAt).not.toBeNull();
    expect(access.find((row) => row.id === OLD_MCP)?.revokedAt).toBeNull();
    expect(access.find((row) => row.id === NEW_MCP)?.revokedAt).toBeNull();
    expect((await lifecycle.listUserAuthorizations(USER_ID)).map((item) => item.id).sort()).toEqual(
      [NEW_MCP, OLD_MCP].sort()
    );
  });
});
