import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { rewritePersistedDockerResourceScopes } from '@/modules/docker/docker-access-resource-scope-rewrite.js';
import { repairDanglingResourceScopes, transactionWithScopeCleanup } from './resource-scope-cleanup.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): deleting a resource removes every stored grant naming it (user, group,
 * API token and OAuth token scopes) in the deleting transaction, and the startup repair removes grants older releases
 * left behind without touching valid, unqualified or unrecognised scopes.
 */
describe.skipIf(!url)('resource scope cleanup on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let groupId = '';
  let userId = '';
  let memberGroupId = '';
  let tokenId = '';
  let accessTokenId = '';
  let nodeId = '';
  let hostId = '';
  let accessListId = '';
  let folderId = '';
  let containerId = '';

  const userScopes = async () =>
    (await q('select additional_scopes from users where id = $1', [userId])).rows[0].additional_scopes as string[];
  const groupScopes = async () =>
    (await q('select scopes from permission_groups where id = $1', [groupId])).rows[0].scopes as string[];
  const tokenScopes = async () =>
    (await q('select scopes from api_tokens where id = $1', [tokenId])).rows[0].scopes as string[];
  const oauthScopes = async () =>
    (await q('select scopes from oauth_access_tokens where id = $1', [accessTokenId])).rows[0].scopes as string[];

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'resource_scope_cleanup');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    memberGroupId = (await q(`insert into permission_groups (name) values ($1) returning id`, [`members-${suffix}`]))
      .rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ($1, 'Creator', $2) returning id`, [
        `creator-${suffix}@example.test`,
        memberGroupId,
      ])
    ).rows[0].id;
    nodeId = (await q(`insert into nodes (hostname, slug) values ($1, $1) returning id`, [`node-${suffix}`])).rows[0]
      .id;
    hostId = (
      await q(`insert into proxy_hosts (slug, node_id, created_by_id) values ($1, $2, $3) returning id`, [
        `route-${suffix}`,
        nodeId,
        userId,
      ])
    ).rows[0].id;
    accessListId = (
      await q(`insert into access_lists (name, created_by_id) values ($1, $2) returning id`, [`acl-${suffix}`, userId])
    ).rows[0].id;
    // Removed with the node by the foreign key cascade, so its grant must go in the same transaction.
    containerId = (
      await q(`insert into docker_access_resources (node_id, resource_key) values ($1, 'app') returning id`, [nodeId])
    ).rows[0].id;
    folderId = (
      await q(`insert into proxy_host_folders (name, created_by_id) values ($1, $2) returning id`, [
        `folder-${suffix}`,
        userId,
      ])
    ).rows[0].id;
    groupId = (
      await q(`insert into permission_groups (name, scopes) values ($1, $2) returning id`, [
        `scoped-${suffix}`,
        JSON.stringify([`nodes:details:${nodeId}`, `proxy:view:${hostId}`, `acl:edit:${accessListId}`, 'domains:view']),
      ])
    ).rows[0].id;
    await q(`update users set additional_scopes = $2 where id = $1`, [
      userId,
      JSON.stringify([
        `nodes:manage:${nodeId}`,
        `nodes:console:${nodeId}`,
        `pages:view:node/${nodeId}`,
        `docker:containers:view:${nodeId}/${containerId}`,
        `proxy:edit:${hostId}`,
        `acl:view:${accessListId}`,
        `proxy:view:folder/${folderId}`,
        'nodes:manage',
        'proxy:view:not-an-id',
      ]),
    ]);
    tokenId = (
      await q(
        `insert into api_tokens (user_id, name, token_hash, token_prefix, scopes)
         values ($1, 'automation', $2, 'gw_test', $3) returning id`,
        [
          userId,
          `hash-${suffix}`,
          JSON.stringify([`nodes:logs:${nodeId}`, `proxy:delete:${hostId}`, `acl:delete:${accessListId}`]),
        ]
      )
    ).rows[0].id;
    const clientId = `client-${suffix}`;
    await q(`insert into oauth_clients (client_id, client_name, redirect_uris) values ($1, 'MCP', '[]'::jsonb)`, [
      clientId,
    ]);
    accessTokenId = (
      await q(
        `insert into oauth_access_tokens (token_hash, token_prefix, client_id, user_id, scopes)
         values ($1, 'gwo_test', $2, $3, $4) returning id`,
        [`access-${suffix}`, clientId, userId, JSON.stringify([`nodes:manage:${nodeId}`, 'mcp:use'])]
      )
    ).rows[0].id;
  });

  it('removes a deleted node from users, groups and tokens in the deleting transaction', async () => {
    await transactionWithScopeCleanup(db, (tx) => tx.delete(schema.nodes).where(eq(schema.nodes.id, nodeId)));

    expect(await userScopes()).toEqual([
      `proxy:edit:${hostId}`,
      `acl:view:${accessListId}`,
      `proxy:view:folder/${folderId}`,
      'nodes:manage',
      'proxy:view:not-an-id',
    ]);
    expect(await groupScopes()).toEqual([`proxy:view:${hostId}`, `acl:edit:${accessListId}`, 'domains:view']);
    expect(await tokenScopes()).toEqual([`proxy:delete:${hostId}`, `acl:delete:${accessListId}`]);
    expect(await oauthScopes()).toEqual(['mcp:use']);
  });

  it('removes a deleted route and a deleted access list and keeps everything else', async () => {
    await transactionWithScopeCleanup(db, (tx) => tx.delete(schema.proxyHosts).where(eq(schema.proxyHosts.id, hostId)));
    await transactionWithScopeCleanup(db, (tx) =>
      tx.delete(schema.accessLists).where(eq(schema.accessLists.id, accessListId))
    );

    expect(await userScopes()).not.toContain(`proxy:edit:${hostId}`);
    expect(await userScopes()).not.toContain(`acl:view:${accessListId}`);
    expect(await userScopes()).toContain(`nodes:manage:${nodeId}`);
    expect(await groupScopes()).toEqual([`nodes:details:${nodeId}`, 'domains:view']);
    expect(await tokenScopes()).toEqual([`nodes:logs:${nodeId}`]);
  });

  it('keeps every grant when the transaction rolls back', async () => {
    await expect(
      transactionWithScopeCleanup(db, async (tx) => {
        await tx.delete(schema.nodes).where(eq(schema.nodes.id, nodeId));
        throw new Error('delete refused');
      })
    ).rejects.toThrow('delete refused');

    expect(await userScopes()).toContain(`nodes:manage:${nodeId}`);
    expect(await tokenScopes()).toContain(`nodes:logs:${nodeId}`);
  });

  it('moves a Docker grant to its new identity through the same rewrite', async () => {
    const movedId = randomUUID();
    await db.transaction((tx) =>
      rewritePersistedDockerResourceScopes(tx, `${nodeId}/${containerId}`, `${nodeId}/${movedId}`)
    );

    expect(await userScopes()).toContain(`docker:containers:view:${nodeId}/${movedId}`);
    expect(await userScopes()).not.toContain(`docker:containers:view:${nodeId}/${containerId}`);
    expect(await userScopes()).toContain(`nodes:manage:${nodeId}`);
  });

  it('repairs grants left by older releases and is idempotent', async () => {
    // What an older release left behind: the rows are gone, the grants stayed.
    const goneNode = randomUUID();
    const goneFolder = randomUUID();
    await q(`update users set additional_scopes = additional_scopes || $2::jsonb where id = $1`, [
      userId,
      JSON.stringify([
        `nodes:manage:${goneNode}`,
        `nodes:console:${goneNode}`,
        `proxy:view:folder/${goneFolder}`,
        `docker:containers:view:${goneNode}`,
      ]),
    ]);
    await q(`update permission_groups set scopes = scopes || $2::jsonb where id = $1`, [
      groupId,
      JSON.stringify([`nodes:details:${goneNode}`]),
    ]);
    const before = await userScopes();

    expect(await repairDanglingResourceScopes(db)).toBeGreaterThanOrEqual(5);

    expect(await userScopes()).toEqual(
      before.filter((scope) => !scope.includes(goneNode) && !scope.includes(goneFolder))
    );
    expect(await userScopes()).toEqual(
      expect.arrayContaining([
        `nodes:manage:${nodeId}`,
        `proxy:view:folder/${folderId}`,
        'nodes:manage',
        'proxy:view:not-an-id',
      ])
    );
    expect(await groupScopes()).not.toContain(`nodes:details:${goneNode}`);
    expect(await groupScopes()).toContain(`nodes:details:${nodeId}`);
    expect(await repairDanglingResourceScopes(db)).toBe(0);
  });
});
