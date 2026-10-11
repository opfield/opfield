import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { ProxyMaintenanceAccessService } from '@/modules/proxy/proxy-maintenance-access.service.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMaintenanceService } from './app-maintenance.service.js';
import { AppMaintenanceAccessService } from './app-maintenance-access.js';
import { AppMembersReader } from './app-members.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit', 'apps:env:manage', 'apps:operate'];

/** In-memory stand-in for the Redis cache the codes live in (TTL is not simulated). */
function memoryCache() {
  const values = new Map<string, string>();
  return {
    values,
    set: async (key: string, value: unknown) => void values.set(key, JSON.stringify(value)),
    get: async (key: string) => (values.has(key) ? JSON.parse(values.get(key)!) : null),
    setIfAbsent: async (key: string, value: unknown) => {
      if (values.has(key)) return false;
      values.set(key, JSON.stringify(value));
      return true;
    },
    getClient: () => ({
      getdel: async (key: string) => {
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
      },
    }),
  };
}

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): an environment Maintenance Access Code opens each route of the
 * environment that is in maintenance once, for its user, while the user still manages the environment; never a route
 * of another environment, a second time, a route in lockdown, after expiry or after the permission is gone.
 */
describe.skipIf(!url)('app maintenance access codes on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let codes: AppMaintenanceAccessService;
  let cache: ReturnType<typeof memoryCache>;
  let access: ProxyMaintenanceAccessService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  let nodeId = '';
  const actor = () => ({ userId, scopes: ALL });
  const route = async (folderId: string, domain: string) =>
    (
      await q(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id, domain_names) values ($1, $2, $3, $4, $5::jsonb) returning id`,
        [`r-${randomUUID().slice(0, 6)}`, nodeId, userId, folderId, JSON.stringify([domain])]
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_access_codes');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    apps = new AppsService(db, { log: vi.fn() } as never, folders, new AppMembersReader(db, folders));
    apps.setMaintenanceHooks(new AppMaintenanceService(db));
    cache = memoryCache();
    access = new ProxyMaintenanceAccessService(
      db,
      cache as never,
      { log: vi.fn() } as never,
      {
        deriveScopedSecret: () => 'secret',
      } as never
    );
    container.registerInstance(ProxyMaintenanceAccessService, access);
    codes = new AppMaintenanceAccessService(apps);
    const group = (await q(`insert into permission_groups (name) values ('apps-codes') returning id`)).rows[0].id;
    userId = (
      await q(
        `insert into users (email, name, group_id, additional_scopes) values ('c@example.test', 'C', $1, $2::jsonb) returning id`,
        [group, JSON.stringify(ALL)]
      )
    ).rows[0].id;
    nodeId = (
      await q(
        `insert into nodes (hostname, slug, type, status, capabilities) values ('ngx', 'ngx', 'nginx', 'online', $1::jsonb) returning id`,
        [JSON.stringify({ capabilities: ['proxy_maintenance_access_v1'] })]
      )
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('opens every route of the environment once and nothing else', async () => {
    const app = await apps.create(actor(), { name: 'Shop' });
    const env = app.environments[0];
    const staging = await apps.createEnvironment(actor(), app.id, { name: 'staging' });
    const a = await route(env.placementFolderIds.routes!, 'a.shop.test');
    const b = await route(env.placementFolderIds.routes!, 'b.shop.test');
    const other = await route(staging.placementFolderIds.routes!, 's.shop.test');
    await expect(codes.issue(actor(), app.id, env.id)).rejects.toMatchObject({
      code: 'MAINTENANCE_ACCESS_UNAVAILABLE',
    });
    await apps.updateEnvironment(actor(), app.id, env.id, { maintenanceEnabled: true });
    await apps.updateEnvironment(actor(), app.id, staging.id, { maintenanceEnabled: true });

    const issued = await codes.issue(actor(), app.id, env.id);
    expect(issued.routeCount).toBe(2);
    expect(await access.redeem(a, nodeId, 'a.shop.test', issued.code)).toMatch(/,\d+$/);
    expect(await access.redeem(a, nodeId, 'a.shop.test', issued.code)).toBe(null);
    expect(await access.redeem(other, nodeId, 's.shop.test', issued.code)).toBe(null);
    expect(await access.redeem(b, nodeId, 'wrong.test', issued.code)).toBe(null);
    expect(await access.redeem(b, nodeId, 'b.shop.test', issued.code)).toMatch(/,\d+$/);

    // A route in lockdown has no team access.
    const third = await route(env.placementFolderIds.routes!, 'c.shop.test');
    await q(`update proxy_hosts set app_maintenance_mode = 'lockdown' where id = $1`, [third]);
    expect(await access.redeem(third, nodeId, 'c.shop.test', issued.code)).toBe(null);

    // An expired code (gone from the cache) and a revoked permission open nothing.
    const second = await codes.issue(actor(), app.id, null);
    expect(second.routeCount).toBe(3);
    await q(`update users set additional_scopes = '[]'::jsonb where id = $1`, [userId]);
    expect(await access.redeem(other, nodeId, 's.shop.test', second.code)).toBe(null);
    await q(`update users set additional_scopes = $1::jsonb where id = $2`, [JSON.stringify(ALL), userId]);
    cache.values.clear();
    expect(await access.redeem(other, nodeId, 's.shop.test', second.code)).toBe(null);
  });

  it('needs apps:env:manage on the environment, or on the app for every environment', async () => {
    const app = await apps.create(actor(), { name: 'Blog' });
    const env = app.environments[0];
    await expect(codes.issue({ userId, scopes: [`apps:view:${app.id}`] }, app.id, env.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      codes.issue({ userId, scopes: [`apps:env:manage:env/${env.id}`] }, app.id, null)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
