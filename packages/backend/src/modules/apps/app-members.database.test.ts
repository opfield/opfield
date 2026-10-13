import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { executeAppTool } from '@/modules/ai/ai.app-tools.js';
import { executeProxyTool } from '@/modules/ai/ai.proxy-tools.js';
import { GroupedHostsQuerySchema } from '@/modules/proxy/folder.schemas.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { ProxyHostListQuerySchema } from '@/modules/proxy/proxy.schemas.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMembersReader, AppMembersService } from './app-members.service.js';
import { AppMembershipService, appMemberFolderCondition, withAppMembers } from './app-membership.js';
import { AppNodesService } from './app-nodes.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = [
  'apps:view',
  'apps:create',
  'apps:edit',
  'apps:env:manage',
  'proxy:edit',
  'proxy:view',
  'databases:edit',
  'databases:view',
  'storage:edit',
  'pages:edit',
  'docker:containers:edit',
  'docker:compose:manage',
];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): importing, moving and taking out members of every family, the refusals
 * (system route, non-allowed node, compose service, missing permission), folder grants on an environment covering an
 * imported member, and the `app` field and list filters the normal lists use.
 */
describe.skipIf(!url)('app membership on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let members: AppMembersService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  const actor = (scopes: string[] = ALL) => ({ userId, scopes });
  const one = async (sql: string, values: unknown[]) => (await q(sql, values)).rows[0];
  const node = async (type: string) =>
    (
      await one(`insert into nodes (hostname, slug, type) values ($1, $1, $2) returning id`, [
        `${type}-${randomUUID().slice(0, 6)}`,
        type,
      ])
    ).id as string;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_members');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    const audit = { log: vi.fn().mockResolvedValue(true) };
    apps = new AppsService(db, audit as never, folders, reader);
    members = new AppMembersService(db, audit as never, folders, apps);
    container.registerInstance(AppsService, apps);
    container.registerInstance(AppMembersService, members);
    container.registerInstance(AppNodesService, new AppNodesService(db, audit as never, apps, reader));
    container.registerInstance(AppMembershipService, new AppMembershipService(db, folders));
    const group = (await one(`insert into permission_groups (name) values ('apps-members') returning id`, [])).id;
    userId = (
      await one(`insert into users (email, name, group_id) values ('m@example.test', 'M', $1) returning id`, [group])
    ).id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('imports members of every family, moves them between environments and takes them out', async () => {
    const app = await apps.create(actor(), { name: 'Shop' });
    const production = app.environments[0];
    const staging = await apps.createEnvironment(actor(), app.id, { name: 'staging' });
    const [nginx, docker] = [await node('nginx'), await node('docker')];
    for (const env of [production.id, staging.id]) {
      for (const nodeId of [nginx, docker]) {
        await container.resolve(AppNodesService).allow(actor(), app.id, env, nodeId);
      }
    }
    const route = (
      await one(`insert into proxy_hosts (slug, node_id, created_by_id) values ($1, $2, $3) returning id`, [
        `r-${randomUUID().slice(0, 6)}`,
        nginx,
        userId,
      ])
    ).id;
    const database = (
      await one(
        `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id)
         values ('shop-db', 'shop-db', 'postgres', 'db', 5432, 'x', $1) returning id`,
        [userId]
      )
    ).id;
    await q(`insert into docker_access_resources (node_id, resource_key) values ($1, 'web')`, [docker]);
    const compose = (
      await one(`insert into docker_compose_projects (node_id, name) values ($1, 'shop-stack') returning id`, [docker])
    ).id;

    const placed = await members.place(actor(), {
      target: { appId: app.id, environmentId: production.id },
      members: [
        { type: 'route', id: route },
        { type: 'database', id: database },
        { type: 'container', id: 'web', nodeId: docker },
        { type: 'compose', id: compose },
      ],
    });
    expect(placed.refused).toEqual([]);
    expect(placed.placed).toHaveLength(4);
    const listed = await apps.listMembers([...ALL, 'docker:containers:view', 'docker:compose:view'], app.id);
    expect(listed.map((member) => member.type).sort()).toEqual(['compose', 'container', 'database', 'route']);

    // A grant on the environment folder now covers the imported database.
    const expanded = await expandFolderScopes(db, [`databases:view:folder/${production.placementFolderIds.databases}`]);
    expect(expanded).toContain(`databases:view:${database}`);

    const moved = await executeAppTool({ id: userId, scopes: ALL } as never, 'manage_app_members', {
      operation: 'place',
      target: { appId: app.id, environmentId: staging.id },
      members: [{ type: 'route', id: route }],
    });
    expect((moved as { placed: unknown[] }).placed).toHaveLength(1);
    expect((await one('select folder_id from proxy_hosts where id = $1', [route])).folder_id).toBe(
      staging.placementFolderIds.routes
    );

    await members.place(actor(), {
      target: null,
      members: [
        { type: 'route', id: route },
        { type: 'compose', id: compose },
      ],
    });
    expect((await one('select folder_id from proxy_hosts where id = $1', [route])).folder_id).toBe(null);
    expect(
      (
        await one(
          `select folder_id from docker_container_folder_assignments where resource_type = 'compose' and resource_key = $1`,
          [compose]
        )
      ).folder_id
    ).toBe(null);
  });

  it('refuses system routes, nodes the environment does not allow, Compose service containers and missing permission', async () => {
    const app = await apps.create(actor(), { name: 'Blog' });
    const env = app.environments[0];
    const [allowed, other, docker] = [await node('nginx'), await node('nginx'), await node('docker')];
    await container.resolve(AppNodesService).allow(actor(), app.id, env.id, allowed);
    const system = (
      await one(
        `insert into proxy_hosts (slug, node_id, created_by_id, is_system, system_kind) values ($1, $2, $3, true, 'status_page') returning id`,
        [`s-${randomUUID().slice(0, 6)}`, allowed, userId]
      )
    ).id;
    const elsewhere = (
      await one(`insert into proxy_hosts (slug, node_id, created_by_id) values ($1, $2, $3) returning id`, [
        `e-${randomUUID().slice(0, 6)}`,
        other,
        userId,
      ])
    ).id;
    const composeFolder = (
      await one(
        `insert into docker_container_folders (name, resource_type, is_system, node_id, compose_project, created_by_id)
         values ('stack', 'container', true, $1, 'stack', $2) returning id`,
        [docker, userId]
      )
    ).id;
    await q(`insert into docker_access_resources (node_id, resource_key) values ($1, 'stack-web-1')`, [docker]);
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id) values ($1, 'container', 'stack-web-1', $2)`,
      [docker, composeFolder]
    );
    const result = await members.place(actor(), {
      target: { appId: app.id, environmentId: env.id },
      members: [
        { type: 'route', id: system },
        { type: 'route', id: elsewhere },
        { type: 'container', id: 'stack-web-1', nodeId: docker },
        { type: 'database', id: randomUUID() },
      ],
    });
    expect(result.placed).toEqual([]);
    expect(result.refused.map((item) => item.code)).toEqual([
      'ROUTE_NOT_PLACEABLE',
      'APP_NODE_NOT_ALLOWED',
      'COMPOSE_SERVICE',
      'NOT_FOUND',
    ]);
    const noEdit = await members.place(actor(['apps:env:manage', 'apps:view']), {
      target: { appId: app.id, environmentId: env.id },
      members: [{ type: 'route', id: elsewhere }],
    });
    expect(noEdit.refused[0]?.code).toBe('FORBIDDEN');
    await expect(
      members.place(actor(['apps:view', 'proxy:edit']), {
        target: { appId: app.id, environmentId: env.id },
        members: [{ type: 'route', id: elsewhere }],
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('marks app members in lists and filters them out or in', async () => {
    const app = await apps.create(actor(), { name: 'Docs' });
    const env = app.environments[0];
    const nginx = await node('nginx');
    const member = (
      await one(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id) values ($1, $2, $3, $4) returning id`,
        [`m-${randomUUID().slice(0, 6)}`, nginx, userId, env.placementFolderIds.routes]
      )
    ).id;
    const outside = (
      await one(`insert into proxy_hosts (slug, node_id, created_by_id) values ($1, $2, $3) returning id`, [
        `o-${randomUUID().slice(0, 6)}`,
        nginx,
        userId,
      ])
    ).id;
    const rows = [
      { id: member, folderId: env.placementFolderIds.routes },
      { id: outside, folderId: null },
    ];
    const annotated = await withAppMembers('routes', rows);
    expect(annotated[0].app).toMatchObject({ id: app.id, environmentId: env.id, environmentName: 'production' });
    expect(annotated[1].app).toBe(null);
    expect((await withAppMembers('routes', rows, { excludeAppMembers: true })).map((row) => row.id)).toEqual([outside]);
    expect((await withAppMembers('routes', rows, { appId: app.id })).map((row) => row.id)).toEqual([member]);

    const condition = appMemberFolderCondition(schema.proxyHosts.folderId, schema.proxyHostFolders, {
      excludeAppMembers: true,
    });
    const visible = await db.select({ id: schema.proxyHosts.id }).from(schema.proxyHosts).where(condition);
    expect(visible.map((row) => row.id)).toContain(outside);
    expect(visible.map((row) => row.id)).not.toContain(member);
  });

  it('filters the route list, the grouped route list and MCP list_routes by app', async () => {
    const app = await apps.create(actor(), { name: 'Routes' });
    const env = app.environments[0];
    const nginx = await node('nginx');
    const route = async (folderId: string | null) =>
      (
        await one(
          `insert into proxy_hosts (slug, node_id, created_by_id, folder_id) values ($1, $2, $3, $4) returning id`,
          [`f-${randomUUID().slice(0, 6)}`, nginx, userId, folderId]
        )
      ).id as string;
    const member = await route(env.placementFolderIds.routes);
    const outside = await route(null);
    const userFolder = (
      await one(`insert into proxy_host_folders (name, created_by_id) values ('Mine', $1) returning id`, [userId])
    ).id as string;
    const inFolder = await route(userFolder);

    // The list endpoint reads through the relational query builder, which aliases the outer table.
    const proxy = new ProxyService(db, {} as never, {} as never, {} as never, {} as never, {} as never);
    const list = async (filter: Record<string, unknown>) => {
      const result = await proxy.listProxyHosts(ProxyHostListQuerySchema.parse({ limit: 100, ...filter }));
      return result.data.map((host: any) => host.id);
    };
    const withoutMembers = await list({ excludeAppMembers: 'true' });
    expect(withoutMembers).toEqual(expect.arrayContaining([outside, inFolder]));
    expect(withoutMembers).not.toContain(member);
    expect(await list({ appId: app.id })).toEqual([member]);
    const page = await proxy.listProxyHosts(ProxyHostListQuerySchema.parse({ appId: app.id }));
    expect(page.pagination.total).toBe(1);
    expect((page.data[0] as any).app).toMatchObject({ id: app.id, environmentId: env.id });

    const folders = new FolderService(db, { log: vi.fn() } as never);
    const grouped = await folders.getGroupedHosts(GroupedHostsQuerySchema.parse({}));
    const groupedIds = [
      ...grouped.ungroupedHosts.map((host: any) => host.id),
      ...grouped.folders.flatMap((folder: any) => folder.hosts.map((host: any) => host.id)),
    ];
    expect(groupedIds).toEqual(expect.arrayContaining([outside, inFolder]));
    expect(groupedIds).not.toContain(member);
    const ofApp = await folders.getGroupedHosts(GroupedHostsQuerySchema.parse({ appId: app.id }));
    expect(ofApp.folders).toEqual([]);
    expect(ofApp.totalHosts).toBe(1);
    expect(ofApp.ungroupedHosts.map((host: any) => host.id)).toEqual([member]);
    expect((ofApp.ungroupedHosts[0] as any).app).toMatchObject({ id: app.id, environmentId: env.id });

    const user = { id: userId, scopes: ['proxy:view'] } as never;
    const context = { proxyService: proxy, folderService: folders };
    const tool = async (args: Record<string, unknown>) => {
      const result = (await executeProxyTool(context, user, 'list_routes', args)) as any;
      return result.data.map((host: any) => host.id);
    };
    expect(await tool({ appId: app.id })).toEqual([member]);
    const toolWithout = await tool({ excludeAppMembers: true, limit: 100 });
    expect(toolWithout).toContain(outside);
    expect(toolWithout).not.toContain(member);
  });
});
