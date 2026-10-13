import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { executeAppTool } from '@/modules/ai/ai.app-tools.js';
import { assertDockerCreationAccess } from '@/modules/docker/docker-creation-access.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppNodesService } from './app-nodes.service.js';
import { assertAppPlacement, assertGroupRoutesAllowNode, filterNodesForAppFolder } from './app-placement-guard.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = [
  'apps:view',
  'apps:create',
  'apps:edit',
  'apps:env:manage',
  'docker:containers:create',
  'docker:compose:create',
];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): the environment node allowlist and the guard every create path
 * shares. Docker creates (REST, MCP, core deployments, Compose, migration) all pass assertDockerCreationAccess; routes
 * pass assertAppPlacement in the proxy service; the allowlist itself is managed through the same service from REST
 * and the MCP tool.
 */
describe.skipIf(!url)('app node allowlist on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  const node = async (type: string) =>
    (
      await q(`insert into nodes (hostname, slug, type) values ($1, $1, $2) returning id`, [
        `${type}-${randomUUID().slice(0, 6)}`,
        type,
      ])
    ).rows[0].id as string;
  const user = () => ({ id: userId, scopes: ALL }) as never;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_nodes');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    const audit = { log: vi.fn().mockResolvedValue(true) };
    apps = new AppsService(db, audit as never, folders, reader);
    container.registerInstance(AppsService, apps);
    container.registerInstance(AppNodesService, new AppNodesService(db, audit as never, apps, reader));
    const group = (await q(`insert into permission_groups (name) values ('apps-nodes') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('nodes@example.test', 'N', $1) returning id`, [group])
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('refuses Docker creates in an environment until a Docker node is allowed, then only there', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Shop' });
    const env = app.environments[0];
    const [dockerA, dockerB, nginx] = [await node('docker'), await node('docker'), await node('nginx')];
    const create = (nodeId: string, folderId = env.placementFolderIds.containers) =>
      assertDockerCreationAccess(db, ALL, 'docker:containers:create', nodeId, folderId);

    await expect(create(dockerA)).rejects.toMatchObject({ statusCode: 409, code: 'APP_ENV_NO_ALLOWED_NODE' });
    // An Nginx node does not count for Docker workloads.
    await executeAppTool(user(), 'manage_app_environment', {
      operation: 'allow_node',
      appId: app.id,
      environmentId: env.id,
      nodeId: nginx,
    });
    await expect(create(dockerA)).rejects.toMatchObject({ code: 'APP_ENV_NO_ALLOWED_NODE' });

    const listed = (await executeAppTool(user(), 'manage_app_environment', {
      operation: 'allow_node',
      appId: app.id,
      environmentId: env.id,
      nodeId: dockerA,
    })) as { nodes: Array<{ nodeId: string }> };
    expect(listed.nodes.map((item) => item.nodeId).sort()).toEqual([dockerA, nginx].sort());
    await expect(create(dockerA)).resolves.toBeUndefined();
    await expect(create(dockerB)).rejects.toMatchObject({ code: 'APP_NODE_NOT_ALLOWED' });
    await expect(
      assertDockerCreationAccess(db, ALL, 'docker:compose:create', dockerB, env.placementFolderIds.compose, 'compose')
    ).rejects.toMatchObject({ code: 'APP_NODE_NOT_ALLOWED' });
    // Outside apps nothing changes.
    await expect(
      assertDockerCreationAccess(db, ALL, 'docker:containers:create', dockerB, null)
    ).resolves.toBeUndefined();
    // An app root is never a destination.
    await expect(create(dockerA, app.rootFolderIds.containers!)).rejects.toMatchObject({ code: 'FOLDER_FORBIDDEN' });
  });

  it('limits routes and route node pickers to allowed Nginx nodes, including ingress group members', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Blog' });
    const env = app.environments[0];
    const [nginxA, nginxB] = [await node('nginx'), await node('nginx')];
    await container.resolve(AppNodesService).allow({ userId, scopes: ALL }, app.id, env.id, nginxA);
    await expect(assertAppPlacement(db, 'routes', env.placementFolderIds.routes, [nginxA])).resolves.toBeUndefined();
    await expect(
      assertAppPlacement(db, 'routes', env.placementFolderIds.routes, [nginxA, nginxB])
    ).rejects.toMatchObject({ code: 'APP_NODE_NOT_ALLOWED' });
    const candidates = [{ id: nginxA }, { id: nginxB }];
    expect(
      (await filterNodesForAppFolder(db, 'routes', env.placementFolderIds.routes, candidates, (item) => item.id)).map(
        (item) => item.id
      )
    ).toEqual([nginxA]);
    expect(await filterNodesForAppFolder(db, 'routes', null, candidates, (item) => item.id)).toHaveLength(2);

    const host = (
      await q(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id) values ($1, $2, $3, $4) returning id`,
        [`r-${randomUUID().slice(0, 6)}`, nginxA, userId, env.placementFolderIds.routes]
      )
    ).rows[0].id;
    await expect(assertGroupRoutesAllowNode(db, [host], nginxB)).rejects.toMatchObject({
      code: 'APP_NODE_NOT_ALLOWED',
    });
    await expect(assertGroupRoutesAllowNode(db, [host], nginxA)).resolves.toBeUndefined();
  });

  it('reports node usage and keeps resources when a node is removed', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Api' });
    const env = app.environments[0];
    const nginx = await node('nginx');
    const service = container.resolve(AppNodesService);
    await service.allow({ userId, scopes: ALL }, app.id, env.id, nginx);
    await q(`insert into proxy_hosts (slug, node_id, created_by_id, folder_id) values ($1, $2, $3, $4)`, [
      `u-${randomUUID().slice(0, 6)}`,
      nginx,
      userId,
      env.placementFolderIds.routes,
    ]);
    const usage = await service.list({ userId, scopes: ALL }, app.id, env.id);
    expect(usage.nodes[0]).toMatchObject({ nodeId: nginx, usedBy: { routes: 1 } });
    await expect(
      service.allow({ userId, scopes: [`apps:view:${app.id}`] }, app.id, env.id, nginx)
    ).rejects.toMatchObject({ statusCode: 403 });
    const after = await service.remove({ userId, scopes: ALL }, app.id, env.id, nginx);
    expect(after.nodes).toEqual([]);
    expect(
      (await q('select count(*)::int as n from proxy_hosts where folder_id = $1', [env.placementFolderIds.routes]))
        .rows[0].n
    ).toBe(1);
    const builder = await node('builder');
    await expect(service.allow({ userId, scopes: ALL }, app.id, env.id, builder)).rejects.toMatchObject({
      code: 'APP_NODE_TYPE_UNSUPPORTED',
    });
  });
});
