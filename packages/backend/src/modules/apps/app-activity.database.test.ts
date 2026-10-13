import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AppActivityService } from './app-activity.service.js';
import { AppAuditTagger } from './app-audit-tagger.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppMembershipService } from './app-membership.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit'];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): audit rows are tagged with the app, environment and member when they
 * are written (app rows, member families incl. containers by node and name), untagged otherwise; the activity
 * feed shows a caller only rows of environments and members it may view.
 */
describe.skipIf(!url)('app activity on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let audit: AuditService;
  let activity: AppActivityService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  const tagsOf = async (action: string) =>
    (
      await q(
        'select app_id, app_environment_id, app_member_type, app_member_id from audit_log where action = $1 order by created_at desc limit 1',
        [action]
      )
    ).rows[0];

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_activity');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    audit = new AuditService(db);
    audit.setAppTagger(new AppAuditTagger(db, folders, new AppMembershipService(db, folders)));
    apps = new AppsService(db, audit, folders, reader);
    activity = new AppActivityService(apps, reader, audit);
    const group = (await q(`insert into permission_groups (name) values ('apps-act') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('a@example.test', 'A', $1) returning id`, [group])
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('tags rows of the app and of its members when they are written', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Shop' });
    const env = app.environments[0];
    expect(await tagsOf('app.create')).toMatchObject({ app_id: app.id, app_environment_id: null });

    const node = (await q(`insert into nodes (hostname, slug, type) values ('d', 'd', 'docker') returning id`)).rows[0]
      .id;
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id) values ($1, 'container', 'web', $2)`,
      [node, env.placementFolderIds.containers]
    );
    await audit.log({
      userId,
      action: 'docker.container.restart',
      resourceType: 'docker-container',
      resourceId: randomUUID(),
      details: { nodeId: node, name: 'web' },
    });
    expect(await tagsOf('docker.container.restart')).toEqual({
      app_id: app.id,
      app_environment_id: env.id,
      app_member_type: 'container',
      app_member_id: `${node}:web`,
    });

    const dbId = (
      await q(
        `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id, folder_id)
         values ('shop-db', 'shop-db', 'postgres', 'db', 5432, 'x', $1, $2) returning id`,
        [userId, env.placementFolderIds.databases]
      )
    ).rows[0].id;
    await audit.log({ userId, action: 'database.update', resourceType: 'database', resourceId: dbId });
    expect(await tagsOf('database.update')).toMatchObject({
      app_id: app.id,
      app_member_type: 'database',
      app_member_id: dbId,
    });

    await audit.log({ userId, action: 'proxy_host.update', resourceType: 'proxy_host', resourceId: randomUUID() });
    expect(await tagsOf('proxy_host.update')).toEqual({
      app_id: null,
      app_environment_id: null,
      app_member_type: null,
      app_member_id: null,
    });
  });

  it('shows a partial viewer only rows of members it may view', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Blog' });
    const env = app.environments[0];
    const node = (await q(`insert into nodes (hostname, slug, type) values ('n2', 'n2', 'nginx') returning id`)).rows[0]
      .id;
    const seen = (
      await q(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id) values ('seen', $1, $2, $3) returning id`,
        [node, userId, env.placementFolderIds.routes]
      )
    ).rows[0].id;
    const hidden = (
      await q(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id) values ('hidden', $1, $2, $3) returning id`,
        [node, userId, env.placementFolderIds.routes]
      )
    ).rows[0].id;
    await audit.log({ userId, action: 'proxy_host.update', resourceType: 'proxy_host', resourceId: seen });
    await audit.log({ userId, action: 'proxy_host.delete_test', resourceType: 'proxy_host', resourceId: hidden });

    const full = await activity.list([...ALL, 'proxy:view'], app.id, { page: 1, limit: 50 });
    expect(full.data.map((row) => row.action)).toEqual(
      expect.arrayContaining(['proxy_host.update', 'proxy_host.delete_test', 'app.create'])
    );
    const partial = await activity.list([`apps:view:${app.id}`, `proxy:view:${seen}`], app.id, { page: 1, limit: 50 });
    const actions = partial.data.map((row) => row.action);
    expect(actions).toContain('proxy_host.update');
    expect(actions).not.toContain('proxy_host.delete_test');
    expect(actions).toContain('app.create');
    expect(partial).toMatchObject({ page: 1, limit: 50 });
  });
});
