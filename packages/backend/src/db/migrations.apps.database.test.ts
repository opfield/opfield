import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposableDatabase, migrateDatabase, rejection } from './migration-database.test-helpers.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the apps migration. One Production environment per app, environment
 * names unique per app case-insensitively, one hidden app-root and one environment folder per family, and an
 * environment folder always names its app. Upgraded rows keep working: existing folders get no app.
 */
describe.skipIf(!url)('apps migration on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  const user = randomUUID();
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  const insertApp = async (name: string) => {
    const id = randomUUID();
    await q('insert into apps (id, slug, name, created_by_id) values ($1, $2, $3, $4)', [
      id,
      id.slice(0, 20),
      name,
      user,
    ]);
    return id;
  };
  const insertEnv = async (appId: string, name: string, isProduction = false) => {
    const id = randomUUID();
    await q(
      'insert into app_environments (id, app_id, name, slug, is_production, created_by_id) values ($1, $2, $3, $4, $5, $6)',
      [id, appId, name, name.toLowerCase(), isProduction, user]
    );
    return id;
  };

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'apps');
    pool = database.pool;
    await migrateDatabase(pool, '0236_secure_link_loopback_slot');
    const group = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `apps-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@apps.test`,
      'Apps test',
    ]);
    await q("insert into proxy_host_folders (name, created_by_id) values ('Existing', $1)", [user]);
    await migrateDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('leaves existing folders and routes outside every app', async () => {
    const { rows } = await q("select app_id, app_environment_id from proxy_host_folders where name = 'Existing'");
    expect(rows).toEqual([{ app_id: null, app_environment_id: null }]);
  });

  it('keeps exactly one Production environment per app', async () => {
    const app = await insertApp('Shop');
    await insertEnv(app, 'production', true);
    await insertEnv(app, 'staging');
    expect(await rejection(insertEnv(app, 'live', true))).toMatchObject({
      code: '23505',
      constraint: 'app_environments_one_production',
    });
  });

  it('refuses environment and app names that differ only in case', async () => {
    const app = await insertApp('Blog');
    await insertEnv(app, 'Staging');
    expect(await rejection(insertEnv(app, 'STAGING'))).toMatchObject({
      code: '23505',
    });
    expect(await rejection(insertApp('BLOG'))).toMatchObject({ code: '23505', constraint: 'apps_name_lower_unique' });
  });

  it('allows one app root and one environment folder per family', async () => {
    const app = await insertApp('Docs');
    const env = await insertEnv(app, 'production', true);
    const root = randomUUID();
    await q(
      "insert into docker_container_folders (id, name, resource_type, created_by_id, app_id) values ($1, 'Docs', 'container', $2, $3)",
      [root, user, app]
    );
    // The compose tree has its own root.
    await q(
      "insert into docker_container_folders (name, resource_type, created_by_id, app_id) values ('Docs', 'compose', $1, $2)",
      [user, app]
    );
    expect(
      await rejection(
        q(
          "insert into docker_container_folders (name, resource_type, created_by_id, app_id) values ('Docs', 'container', $1, $2)",
          [user, app]
        )
      )
    ).toMatchObject({ code: '23505', constraint: 'docker_container_folders_app_root_unique' });
    await q(
      `insert into docker_container_folders (name, resource_type, parent_id, depth, created_by_id, app_id, app_environment_id)
       values ('production', 'container', $1, 1, $2, $3, $4)`,
      [root, user, app, env]
    );
    expect(
      await rejection(
        q(
          `insert into docker_container_folders (name, resource_type, parent_id, depth, created_by_id, app_id, app_environment_id)
           values ('production', 'container', $1, 1, $2, $3, $4)`,
          [root, user, app, env]
        )
      )
    ).toMatchObject({ code: '23505', constraint: 'docker_container_folders_app_env_unique' });
    await q("insert into proxy_host_folders (name, created_by_id, app_id) values ('Docs', $1, $2)", [user, app]);
    expect(
      await rejection(
        q("insert into proxy_host_folders (name, created_by_id, app_id) values ('Docs', $1, $2)", [user, app])
      )
    ).toMatchObject({ code: '23505', constraint: 'proxy_host_folders_app_root_unique' });
  });

  it('refuses an environment folder without its app and an app delete while folders remain', async () => {
    const app = await insertApp('Api');
    const env = await insertEnv(app, 'production', true);
    expect(
      await rejection(
        q('insert into page_project_folders (name, created_by_id, app_environment_id) values ($1, $2, $3)', [
          'production',
          user,
          env,
        ])
      )
    ).toMatchObject({ code: '23514', constraint: 'page_project_folders_app_env_check' });
    await q('insert into page_project_folders (name, created_by_id, app_id) values ($1, $2, $3)', ['Api', user, app]);
    expect(await rejection(q('delete from apps where id = $1', [app]))).toMatchObject({ code: '23503' });
  });

  it('defaults the route overlay to off and accepts untagged audit rows', async () => {
    const { rows } = await q(
      "select column_default from information_schema.columns where table_name = 'proxy_hosts' and column_name = 'app_maintenance_mode'"
    );
    expect(rows[0]?.column_default).toContain("'off'");
    await q("insert into audit_log (action, resource_type) values ('test', 'test')");
  });

  it('keeps one open incident of each kind per environment and frees it once released', async () => {
    const app = await insertApp('Incidents');
    const env = await insertEnv(app, 'production', true);
    const open = (kind: string, state = 'active') =>
      q(
        'insert into app_incidents (id, batch_id, app_id, environment_id, kind, state) values ($1, $2, $3, $4, $5, $6) returning id',
        [randomUUID(), randomUUID(), app, env, kind, state]
      );
    const first = await open('isolation');
    await open('shutdown');
    expect(await rejection(open('isolation', 'applying'))).toMatchObject({
      code: '23505',
      constraint: 'app_incidents_env_kind_open_unique',
    });
    await q("update app_incidents set state = 'released' where id = $1", [first.rows[0].id]);
    await open('isolation');
    await q(
      "insert into app_incident_items (incident_id, item_kind, item_key, ref) values ($1, 'route_overlay', 'route:a', '{}')",
      [first.rows[0].id]
    );
    expect(
      await rejection(
        q(
          "insert into app_incident_items (incident_id, item_kind, item_key, ref) values ($1, 'route_overlay', 'route:a', '{}')",
          [first.rows[0].id]
        )
      )
    ).toMatchObject({ code: '23505', constraint: 'app_incident_items_incident_key_unique' });
  });

  it('accepts a managed storage paused status and keeps app incident port holds while their item exists', async () => {
    const { rows } = await q('select unnest(enum_range(null::managed_storage_status))::text as value');
    expect(rows.map((row) => row.value)).toContain('paused');
    const node = randomUUID();
    await q(
      "insert into nodes (id, type, hostname, slug) values ($1, 'docker', gen_random_uuid()::text, gen_random_uuid()::text)",
      [node]
    );
    const app = await insertApp('Holds');
    const env = await insertEnv(app, 'production', true);
    const incident = (
      await q(
        "insert into app_incidents (batch_id, app_id, environment_id, kind, state) values ($1, $2, $3, 'isolation', 'active') returning id",
        [randomUUID(), app, env]
      )
    ).rows[0].id;
    const item = (
      await q(
        "insert into app_incident_items (incident_id, item_kind, item_key, ref) values ($1, 'database_publication', 'db:x', '{}') returning id",
        [incident]
      )
    ).rows[0].id;
    const hold = (owner: string, port: number) =>
      q(
        "insert into node_host_port_reservations (node_id, host_port, owner_kind, owner_id, conflict) values ($1, $2, 'app_incident', $3, true)",
        [node, port, owner]
      );
    await hold(item, 45432);
    await hold(randomUUID(), 45433);
    await q('select node_host_port_reservations_reconcile()');
    const { rows: kept } = await q(
      "select host_port, conflict from node_host_port_reservations where owner_kind = 'app_incident' order by host_port"
    );
    // The hold of the gone item is released; the live one now holds its port outright.
    expect(kept).toEqual([{ host_port: 45432, conflict: false }]);
  });
});
