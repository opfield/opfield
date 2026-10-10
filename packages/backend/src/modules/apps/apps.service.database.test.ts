import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { executeAppTool } from '@/modules/ai/ai.app-tools.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit', 'apps:delete', 'apps:env:manage', 'apps:operate'];

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): apps and environments with their hidden folders, the Production
 * marker, name rules, deletes that leave members running outside the app and remove grants, and visibility for
 * environment-limited callers (REST service and MCP tool share the same calls).
 */
describe.skipIf(!url)('apps service on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let service: AppsService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const audit = { log: vi.fn().mockResolvedValue(true) };
  let userId = '';
  const actor = (scopes: string[] = ALL) => ({ userId, scopes });

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'apps_service');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    service = new AppsService(db, audit as never, folders, new AppMembersReader(db, folders));
    container.registerInstance(AppsService, service);
    const group = (await q(`insert into permission_groups (name) values ('apps-svc') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('svc@example.test', 'Svc', $1) returning id`, [group])
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('creates an app with one Production environment and its placement folders', async () => {
    const app = await service.create(actor(), { name: 'Shop' });
    expect(app.slug).toBe('shop');
    expect(app.environments).toHaveLength(1);
    expect(app.environments[0]).toMatchObject({ name: 'production', isProduction: true });
    expect(Object.values(app.environments[0].placementFolderIds).every(Boolean)).toBe(true);
    expect(Object.values(app.rootFolderIds).every(Boolean)).toBe(true);
    await expect(service.create(actor(), { name: 'SHOP' })).rejects.toMatchObject({ code: 'APP_NAME_TAKEN' });
    const other = await service.create(actor(), { name: 'Shop.' });
    expect(other.slug).toBe('shop-2');
    await expect(service.create(actor(['apps:view']), { name: 'Nope' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('creates, renames and moves the Production marker between environments', async () => {
    const app = await service.create(actor(), { name: 'Blog' });
    const production = app.environments[0];
    const staging = await service.createEnvironment(actor(), app.id, { name: 'Staging' });
    expect(staging.slug).toBe('staging');
    await expect(service.createEnvironment(actor(), app.id, { name: 'staging' })).rejects.toMatchObject({
      code: 'APP_ENV_NAME_TAKEN',
    });
    const renamed = await service.updateEnvironment(actor(), app.id, staging.id, { name: 'QA' });
    expect(renamed).toMatchObject({ name: 'QA', slug: 'qa' });
    const folderName = (await q('select name from proxy_host_folders where app_environment_id = $1', [staging.id]))
      .rows[0].name;
    expect(folderName).toBe('QA');

    await service.updateEnvironment(actor(), app.id, staging.id, { isProduction: true });
    let detail = await service.get(ALL, app.id);
    expect(detail.environments.find((env) => env.id === staging.id)?.isProduction).toBe(true);
    expect(detail.environments.find((env) => env.id === production.id)?.isProduction).toBe(false);
    await service.updateEnvironment(actor(), app.id, production.id, { isProduction: true });
    detail = await service.get(ALL, app.slug);
    expect(detail.environments.filter((env) => env.isProduction).map((env) => env.id)).toEqual([production.id]);

    await expect(service.deleteEnvironment(actor(), app.id, production.id)).rejects.toMatchObject({
      code: 'APP_ENV_PRODUCTION',
    });
    await expect(
      service.updateEnvironment(actor([`apps:view:${app.id}`]), app.id, staging.id, { name: 'x' })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('deletes an environment: members stay outside the app and grants naming it go', async () => {
    const app = await service.create(actor(), { name: 'Docs' });
    const staging = await service.createEnvironment(actor(), app.id, { name: 'staging' });
    const member = (
      await q(
        `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id, folder_id)
         values ('docs-db', 'docs-db', 'postgres', 'db', 5432, 'x', $1, $2) returning id`,
        [userId, staging.placementFolderIds.databases]
      )
    ).rows[0].id;
    const grants = [`apps:view:env/${staging.id}`, `databases:view:folder/${staging.placementFolderIds.databases}`];
    await q('update users set additional_scopes = $1::jsonb where id = $2', [JSON.stringify(grants), userId]);
    expect((await service.listMembers(ALL, app.id, staging.id)).map((item) => item.id)).toEqual([]);
    expect((await service.listMembers([...ALL, 'databases:view'], app.id, staging.id)).map((item) => item.id)).toEqual([
      member,
    ]);

    await service.deleteEnvironment(actor(), app.id, staging.id);
    expect((await q('select folder_id from database_connections where id = $1', [member])).rows[0].folder_id).toBe(
      null
    );
    expect((await q('select additional_scopes from users where id = $1', [userId])).rows[0].additional_scopes).toEqual(
      []
    );
  });

  it('shows an environment-limited caller only that environment', async () => {
    const app = await service.create(actor(), { name: 'Api' });
    const staging = await service.createEnvironment(actor(), app.id, { name: 'staging' });
    const scopes = [`apps:env:manage:env/${staging.id}`];
    const listed = (await service.list(scopes)).find((item) => item.id === app.id);
    expect(listed?.environments.map((env) => env.id)).toEqual([staging.id]);
    const detail = await service.get(scopes, app.id);
    expect(detail.environments.map((env) => env.id)).toEqual([staging.id]);
    expect(detail.permissions).toMatchObject({ edit: false, envManage: { [staging.id]: true } });
    expect((await service.list([])).find((item) => item.id === app.id)).toBeUndefined();
    await expect(service.get(['apps:view:env/00000000-0000-4000-8000-000000000000'], app.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('deletes an app and its grants through the MCP tool, members left running', async () => {
    const user = { id: userId, scopes: ALL } as never;
    const created = (await executeAppTool(user, 'manage_app', { operation: 'create', name: 'Gone' })) as {
      id: string;
      environments: Array<{ placementFolderIds: { routes: string } }>;
    };
    const fetched = (await executeAppTool(user, 'get_app', { appId: created.id })) as { id: string };
    expect(fetched.id).toBe(created.id);
    await q('update users set additional_scopes = $1::jsonb where id = $2', [
      JSON.stringify([`apps:operate:${created.id}`]),
      userId,
    ]);
    await executeAppTool(user, 'manage_app', { operation: 'delete', appId: created.id });
    expect((await q('select id from apps where id = $1', [created.id])).rows).toEqual([]);
    expect(
      (await q('select count(*)::int as n from proxy_host_folders where app_id = $1', [created.id])).rows[0].n
    ).toBe(0);
    expect((await q('select additional_scopes from users where id = $1', [userId])).rows[0].additional_scopes).toEqual(
      []
    );
  });
});
