import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { AppFolderService } from './app-folders.service.js';
import { AppHealthService } from './app-health.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit'];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): environment health counts only the members the caller may view; the
 * app list reports the Production environment.
 */
describe.skipIf(!url)('app health on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_health');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    apps = new AppsService(db, { log: vi.fn() } as never, folders, reader);
    apps.setHealthProvider(new AppHealthService(db, reader));
    const group = (await q(`insert into permission_groups (name) values ('apps-health') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('h@example.test', 'H', $1) returning id`, [group])
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('counts only visible members and reports the Production environment in the list', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Shop' });
    const env = app.environments[0];
    const staging = await apps.createEnvironment({ userId, scopes: ALL }, app.id, { name: 'staging' });
    const node = (await q(`insert into nodes (hostname, slug, type) values ('n', 'n', 'nginx') returning id`)).rows[0]
      .id;
    await q(
      `insert into proxy_hosts (slug, node_id, created_by_id, folder_id, health_status) values ('ok-route', $1, $2, $3, 'online')`,
      [node, userId, env.placementFolderIds.routes]
    );
    await q(
      `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id, folder_id, health_status)
       values ('down-db', 'down-db', 'postgres', 'db', 5432, 'x', $1, $2, 'offline')`,
      [userId, env.placementFolderIds.databases]
    );
    await q(
      `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id, folder_id, health_status)
       values ('stage-db', 'stage-db', 'postgres', 'db', 5432, 'x', $1, $2, 'degraded')`,
      [userId, staging.placementFolderIds.databases]
    );
    const routesOnly = [...ALL, 'proxy:view'];
    expect((await apps.get(routesOnly, app.id)).environments.find((item) => item.id === env.id)?.health).toBe(
      'healthy'
    );
    const everything = [...ALL, 'proxy:view', 'databases:view'];
    const detail = await apps.get(everything, app.id);
    expect(detail.environments.find((item) => item.id === env.id)?.health).toBe('failing');
    expect(detail.environments.find((item) => item.id === staging.id)?.health).toBe('degraded');
    const listed = (await apps.list(everything)).find((item) => item.id === app.id)!;
    expect(listed).toMatchObject({ health: 'failing', running: 1, failing: 1, degraded: 0, incident: 'none' });
  });
});
