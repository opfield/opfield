import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import { AppFolderService } from './app-folders.service.js';
import { AppHealthService } from './app-health.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppOverviewService } from './app-overview.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit'];

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the overview shape per environment, database series from the
 * monitoring host contract, and visibility: a caller without view of a member never sees it, cached separately.
 */
describe.skipIf(!url)('app overview on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let overview: AppOverviewService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_overview');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    apps = new AppsService(db, { log: vi.fn() } as never, folders, reader);
    const health = new AppHealthService(db, reader);
    apps.setHealthProvider(health);
    overview = new AppOverviewService(db, apps, reader, health);
    const group = (await q(`insert into permission_groups (name) values ('apps-ov') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('o@example.test', 'O', $1) returning id`, [group])
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('reports each environment with its database series and hides members the caller cannot view', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Shop' });
    const env = app.environments[0];
    const dbId = (
      await q(
        `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id, folder_id, health_status, manual_size_limit_mb)
         values ('shop-db', 'shop-db', 'postgres', 'db', 5432, 'x', $1, $2, 'online', 100) returning id`,
        [userId, env.placementFolderIds.databases]
      )
    ).rows[0].id;
    const now = Date.now();
    container.registerInstance(DatabaseMonitoringService, {
      getOverviewSeries: async (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            [
              {
                timestamp: new Date(now - 30 * 60 * 1000).toISOString(),
                metrics: { database_size_bytes: 80 * 1024 * 1024, total_connections: 4, max_connections: 100 },
              },
              {
                timestamp: new Date(now - 60 * 1000).toISOString(),
                metrics: {
                  database_size_bytes: 90 * 1024 * 1024,
                  total_connections: 6,
                  max_connections: 100,
                  transaction_rate: 12,
                },
              },
            ],
          ])
        ),
      getHistory: async () => [],
    } as never);

    const full = (await overview.overview([...ALL, 'databases:view'], app.id, '1h')) as any;
    const production = full.environments.find((item: any) => item.environmentId === env.id);
    expect(production).toMatchObject({ health: 'healthy', members: 1, issues: [], nodeIds: [] });
    expect(production.databases).toHaveLength(1);
    expect(production.databases[0]).toMatchObject({
      id: dbId,
      name: 'shop-db',
      connections: 6,
      maxConnections: 100,
      transactionsPerSecond: 12,
      diskPercent: 90,
    });
    expect(production.databases[0].diskHistory).toHaveLength(24);
    expect(production.databases[0].transactionsHistory).toHaveLength(24);
    expect(production.databases[0].throughputUnit).toBe('tx');
    expect(production.alerts).toEqual([
      { tone: 'warning', title: 'shop-db disk is 90% full', detail: 'Free space or grow the volume' },
    ]);
    expect(production.containers).toMatchObject({ total: 0, unhealthy: [], restarts: null, healthyHistory: [] });
    expect(production.routes).toMatchObject({ total: 0, requestsPerSecond: null, latencySource: null });

    const partial = (await overview.overview(ALL, app.id, '1h')) as any;
    expect(partial.environments[0].databases).toEqual([]);
    expect(partial.environments[0].members).toBe(0);
  });
});
