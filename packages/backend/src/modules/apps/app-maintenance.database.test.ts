import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { NOT_IN_EFFECTIVE_MAINTENANCE } from '@/modules/proxy/effective-maintenance.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMaintenanceService } from './app-maintenance.service.js';
import { AppMembersReader, AppMembersService } from './app-members.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit', 'apps:env:manage', 'apps:operate', 'proxy:edit'];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): environment maintenance and the app override set the overlay of
 * every proxy route of the scope and never touch a route's own switch; switching off restores exactly the own
 * state; a route that leaves the environment loses the overlay; health checks skip routes in effective maintenance.
 */
describe.skipIf(!url)('app maintenance overlay on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let members: AppMembersService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  let nodeId = '';
  const actor = () => ({ userId, scopes: ALL });
  const route = async (folderId: string, extra: { type?: string; own?: boolean } = {}) =>
    (
      await q(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id, type, maintenance_enabled)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [`r-${randomUUID().slice(0, 6)}`, nodeId, userId, folderId, extra.type ?? 'proxy', extra.own ?? false]
      )
    ).rows[0].id as string;
  const state = async (id: string) =>
    (await q('select maintenance_enabled, app_maintenance_mode from proxy_hosts where id = $1', [id])).rows[0];

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_maintenance');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const audit = { log: vi.fn().mockResolvedValue(true) };
    apps = new AppsService(db, audit as never, folders, new AppMembersReader(db, folders));
    members = new AppMembersService(db, audit as never, folders, apps);
    const maintenance = new AppMaintenanceService(db);
    apps.setMaintenanceHooks(maintenance);
    members.setRouteMoveHook((ids) => maintenance.applyModes(ids));
    const group = (await q(`insert into permission_groups (name) values ('apps-mnt') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('mt@example.test', 'M', $1) returning id`, [group])
    ).rows[0].id;
    nodeId = (await q(`insert into nodes (hostname, slug, type) values ('ng', 'ng', 'nginx') returning id`)).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('turns the environment overlay on and off without touching own switches', async () => {
    const app = await apps.create(actor(), { name: 'Shop' });
    const env = app.environments[0];
    const a = await route(env.placementFolderIds.routes!, { own: true });
    const b = await route(env.placementFolderIds.routes!);
    const redirect = await route(env.placementFolderIds.routes!, { type: 'redirect' });

    let detail = await apps.environmentDetail(ALL, app.id, env.id);
    expect(detail.maintenance).toMatchObject({
      state: 'partial',
      routeCount: 2,
      ownMaintenanceCount: 1,
      notAffectedCount: 1,
    });

    detail = await apps.updateEnvironment(actor(), app.id, env.id, { maintenanceEnabled: true });
    expect(detail.maintenance).toMatchObject({ state: 'on' });
    expect(await state(a)).toEqual({ maintenance_enabled: true, app_maintenance_mode: 'maintenance' });
    expect(await state(b)).toEqual({ maintenance_enabled: false, app_maintenance_mode: 'maintenance' });
    expect(await state(redirect)).toEqual({ maintenance_enabled: false, app_maintenance_mode: 'off' });
    const probed = await db
      .select({ id: schema.proxyHosts.id })
      .from(schema.proxyHosts)
      .where(NOT_IN_EFFECTIVE_MAINTENANCE);
    expect(probed.map((row) => row.id)).not.toContain(b);

    await apps.updateEnvironment(actor(), app.id, env.id, { maintenanceEnabled: false });
    expect(await state(a)).toEqual({ maintenance_enabled: true, app_maintenance_mode: 'off' });
    expect(await state(b)).toEqual({ maintenance_enabled: false, app_maintenance_mode: 'off' });
  });

  it('puts every environment in maintenance with the app override', async () => {
    const app = await apps.create(actor(), { name: 'Blog' });
    const staging = await apps.createEnvironment(actor(), app.id, { name: 'staging' });
    const live = await route(app.environments[0].placementFolderIds.routes!);
    const stage = await route(staging.placementFolderIds.routes!);
    const updated = await apps.update(actor(), app.id, { maintenanceOverride: true });
    expect(updated.environments.every((env) => (env.maintenance as { state: string }).state === 'overridden')).toBe(
      true
    );
    expect((await state(live)).app_maintenance_mode).toBe('maintenance');
    expect((await state(stage)).app_maintenance_mode).toBe('maintenance');
    await apps.update(actor(), app.id, { maintenanceOverride: false });
    expect((await state(live)).app_maintenance_mode).toBe('off');
  });

  it('clears the overlay of a route that leaves the environment or whose app is deleted', async () => {
    const app = await apps.create(actor(), { name: 'Docs' });
    const env = app.environments[0];
    const moving = await route(env.placementFolderIds.routes!);
    const staying = await route(env.placementFolderIds.routes!);
    await apps.updateEnvironment(actor(), app.id, env.id, { maintenanceEnabled: true });
    expect((await state(moving)).app_maintenance_mode).toBe('maintenance');
    expect((await state(staying)).app_maintenance_mode).toBe('maintenance');
    await members.place(actor(), { target: null, members: [{ type: 'route', id: moving }] });
    expect(await state(moving)).toEqual({ maintenance_enabled: false, app_maintenance_mode: 'off' });
    await apps.delete({ userId, scopes: [...ALL, 'apps:delete'] }, app.id);
    expect(await state(staying)).toEqual({ maintenance_enabled: false, app_maintenance_mode: 'off' });
  });
});
