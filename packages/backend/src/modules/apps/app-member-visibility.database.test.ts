import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AppActivityService } from './app-activity.service.js';
import { AppAuditTagger } from './app-audit-tagger.js';
import { AppFolderService } from './app-folders.service.js';
import { AppHealthService } from './app-health.service.js';
import { AppIncidentsRepo } from './app-incidents.repo.js';
import { AppIncidentService } from './app-isolation.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppMembershipService } from './app-membership.js';
import { AppOverviewService } from './app-overview.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit'];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): an app is visible without apps:view through the members a caller can
 * view (environment folder grant, app root folder grant, direct resource grant), limited to the environments holding
 * them and to those members; overview, activity and incidents are computed from them alone. apps:view callers see
 * the app as before.
 */
describe.skipIf(!url)('apps visible through members on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let audit: AuditService;
  let overview: AppOverviewService;
  let activity: AppActivityService;
  let incidents: AppIncidentService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const one = async (text: string, values: unknown[] = []) => (await q(text, values)).rows[0];
  let userId = '';
  let dockerNode = '';
  let nginxNode = '';

  /** Shop: production (container web + hidden container db-admin + database), staging (route). */
  let app: Awaited<ReturnType<AppsService['create']>>;
  let production: (typeof app)['environments'][number];
  let staging: Awaited<ReturnType<AppsService['createEnvironment']>>;
  let databaseId = '';
  let routeId = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_member_visibility');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    audit = new AuditService(db);
    audit.setAppTagger(new AppAuditTagger(db, folders, new AppMembershipService(db, folders)));
    apps = new AppsService(db, audit, folders, reader);
    const health = new AppHealthService(db, reader);
    apps.setHealthProvider(health);
    overview = new AppOverviewService(db, apps, reader, health);
    activity = new AppActivityService(apps, reader, audit);
    incidents = new AppIncidentService(
      db,
      apps,
      new AppIncidentsRepo(db),
      null as never,
      null as never,
      null as never,
      audit
    );
    apps.setIncidentGuard(incidents);
    const group = (await one(`insert into permission_groups (name) values ('apps-mv') returning id`)).id;
    userId = (
      await one(`insert into users (email, name, group_id) values ('mv@example.test', 'M', $1) returning id`, [group])
    ).id;
    dockerNode = (await one(`insert into nodes (hostname, slug, type) values ('d1', 'd1', 'docker') returning id`)).id;
    nginxNode = (await one(`insert into nodes (hostname, slug, type) values ('n1', 'n1', 'nginx') returning id`)).id;

    app = await apps.create({ userId, scopes: ALL }, { name: 'Shop' });
    production = app.environments[0]!;
    staging = await apps.createEnvironment({ userId, scopes: ALL }, app.id, { name: 'staging' });
    for (const name of ['web', 'db-admin']) {
      await q(
        `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id) values ($1, 'container', $2, $3)`,
        [dockerNode, name, production.placementFolderIds.containers]
      );
      await q(`insert into docker_access_resources (node_id, resource_key) values ($1, $2)`, [dockerNode, name]);
    }
    databaseId = (
      await one(
        `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id, folder_id)
         values ('shop-db', 'shop-db', 'postgres', 'db', 5432, 'x', $1, $2) returning id`,
        [userId, production.placementFolderIds.databases]
      )
    ).id;
    routeId = (
      await one(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id) values ('shop-staging', $1, $2, $3) returning id`,
        [nginxNode, userId, staging.placementFolderIds.routes]
      )
    ).id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  /** Effective scopes as the auth layer builds them (folder grants expanded). */
  const effective = (scopes: string[]) => expandFolderScopes(db, scopes);
  /** Only the `web` container of production, through a grant on one access resource. */
  const webOnly = async () => {
    const web = (
      await one(`select id from docker_access_resources where node_id = $1 and resource_key = 'web'`, [dockerNode])
    ).id;
    return [`docker:containers:view:${dockerNode}/${web}`];
  };

  it('shows the app through a grant on the environment folder, limited to that environment and its members', async () => {
    const scopes = await effective([`docker:containers:view:folder/${production.placementFolderIds.containers}`]);
    const listed = (await apps.list(scopes)).find((item) => item.id === app.id);
    expect(listed).toMatchObject({ access: 'members' });
    expect(listed?.environments.map((env) => env.id)).toEqual([production.id]);

    const detail = await apps.get(scopes, app.slug);
    expect(detail.access).toBe('members');
    expect(detail.environments.map((env) => env.id)).toEqual([production.id]);
    expect(detail.environments[0]).toMatchObject({ access: 'members', allowedNodeIds: [], maintenance: null });
    // The database of production is not visible: it is neither counted nor listed.
    expect(detail.environments[0]?.memberCounts).toMatchObject({ container: 2, database: 0, route: 0 });
    expect(Object.values(detail.rootFolderIds).every((id) => id === null)).toBe(true);
    expect(detail.permissions).toMatchObject({ edit: false, delete: false, operate: false });
    // A view through members learns nothing about the members it does not see.
    expect(detail.environments[0]?.hiddenMemberTypes).toEqual([]);

    const members = await apps.listMembers(scopes, app.id);
    expect(members.map((member) => member.name).sort()).toEqual(['db-admin', 'web']);
    await expect(apps.listMembers(scopes, app.id, staging.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('shows the app through a grant on the app root folder (parent of every environment folder)', async () => {
    const scopes = await effective([`docker:containers:view:folder/${app.rootFolderIds.containers}`]);
    const detail = await apps.get(scopes, app.id);
    expect(detail.access).toBe('members');
    expect(detail.environments.map((env) => env.id)).toEqual([production.id]);
  });

  it('shows the app through a direct grant on one member', async () => {
    const scopes = await effective([`proxy:view:${routeId}`]);
    const detail = await apps.get(scopes, app.id);
    expect(detail.environments.map((env) => env.id)).toEqual([staging.id]);
    expect(detail.environments[0]?.memberCounts).toMatchObject({ route: 1, container: 0 });
    expect((await apps.listMembers(scopes, app.id)).map((member) => member.id)).toEqual([routeId]);
  });

  it('hides the app from callers that can view neither the app nor any member', async () => {
    const scopes = await effective(['docker:containers:view:00000000-0000-4000-8000-000000000000/x']);
    expect((await apps.list(scopes)).find((item) => item.id === app.id)).toBeUndefined();
    await expect(apps.get(scopes, app.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await apps.hasAppsByMembers(scopes)).toBe(false);
    expect(await apps.hasAppsByMembers(await webOnly())).toBe(true);
  });

  it('keeps apps:view callers unchanged and adds member environments to an environment-limited view', async () => {
    const full = await apps.get(ALL, app.id);
    expect(full.access).toBe('full');
    expect(full.environments.map((env) => [env.id, env.access])).toEqual([
      [production.id, 'full'],
      [staging.id, 'full'],
    ]);
    expect(Object.values(full.rootFolderIds).every(Boolean)).toBe(true);
    // apps:view without member scopes: the types the user cannot see are named, nothing more.
    const prod = full.environments.find((env) => env.id === production.id);
    expect(prod?.hiddenMemberTypes).toEqual(['container', 'database']);
    expect(full.environments.find((env) => env.id === staging.id)?.hiddenMemberTypes).toEqual(['route']);
    const seeing = await apps.get([...ALL, 'docker:containers:view', 'databases:view', 'proxy:view'], app.id);
    expect(seeing.environments.every((env) => env.hiddenMemberTypes.length === 0)).toBe(true);

    const mixed = await apps.get([`apps:view:env/${staging.id}`, ...(await webOnly())], app.id);
    expect(mixed.access).toBe('full');
    expect(mixed.environments.map((env) => [env.id, env.access])).toEqual([
      [production.id, 'members'],
      [staging.id, 'full'],
    ]);
  });

  it('computes the overview only from the members the caller can view', async () => {
    const scopes = await webOnly();
    const result = (await overview.overview(scopes, app.id, '1h')) as any;
    expect(result.environments.map((env: any) => env.environmentId)).toEqual([production.id]);
    expect(result.environments[0]).toMatchObject({ members: 1, databases: [] });
    expect(result.environments[0].containers.total).toBe(1);

    const all = (await overview.overview([...ALL, 'docker:containers:view', 'databases:view'], app.id, '1h')) as any;
    const prod = all.environments.find((env: any) => env.environmentId === production.id);
    expect(prod.members).toBe(3);
  });

  it('shows a members-only caller only activity about its members', async () => {
    await audit.log({
      userId,
      action: 'docker.container.restart',
      resourceType: 'docker-container',
      resourceId: randomUUID(),
      details: { nodeId: dockerNode, name: 'web' },
    });
    await audit.log({
      userId,
      action: 'docker.container.stop',
      resourceType: 'docker-container',
      resourceId: randomUUID(),
      details: { nodeId: dockerNode, name: 'db-admin' },
    });
    await audit.log({ userId, action: 'database.update', resourceType: 'database', resourceId: databaseId });
    await audit.log({
      userId,
      action: 'app.environment.maintenance_on',
      resourceType: 'app_environment',
      resourceId: production.id,
      details: { appId: app.id },
    });

    const actions = (await activity.list(await webOnly(), app.id, { page: 1, limit: 50 })).data.map(
      (row) => row.action
    );
    expect(actions).toEqual(['docker.container.restart']);

    const full = (await activity.list([...ALL, 'docker:containers:view'], app.id, { page: 1, limit: 50 })).data.map(
      (row) => row.action
    );
    expect(full).toEqual(
      expect.arrayContaining(['docker.container.restart', 'docker.container.stop', 'app.environment.maintenance_on'])
    );
    expect(full).toContain('app.create');
  });

  it('lists incident items only about the members a members-only caller can view', async () => {
    const incident = (
      await one(
        `insert into app_incidents (batch_id, app_id, environment_id, kind, state, last_error)
         values ($1, $2, $3, 'shutdown', 'active', 'db-admin failed') returning id`,
        [randomUUID(), app.id, production.id]
      )
    ).id;
    const item = (kind: string, key: string, ref: Record<string, unknown>) =>
      q(
        `insert into app_incident_items (incident_id, item_kind, item_key, ref, status) values ($1, $2, $3, $4, 'applied')`,
        [incident, kind, key, JSON.stringify(ref)]
      );
    await item('container_stop', `container:${dockerNode}:web`, { nodeId: dockerNode, name: 'web', label: 'web' });
    await item('container_stop', `container:${dockerNode}:db-admin`, {
      nodeId: dockerNode,
      name: 'db-admin',
      label: 'db-admin',
    });
    await item('container_link', 'link:1', { linkId: randomUUID(), label: 'Container link' });

    const [view] = await incidents.list(await webOnly(), app.id);
    expect(view?.items.map((entry) => entry.label)).toEqual(['web']);
    expect(view?.counts.total).toBe(1);
    expect(view?.lastError).toBeNull();
    const detail = await apps.get(await webOnly(), app.id);
    expect((detail.environments[0]?.incidents as any[])[0].items.map((entry: any) => entry.label)).toEqual(['web']);

    const [fullView] = await incidents.list(ALL, app.id);
    expect(fullView?.counts.total).toBe(3);
    expect(fullView?.lastError).toBe('db-admin failed');
  });
});
