import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { executeAppTool } from '@/modules/ai/ai.app-tools.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { AppEnvLayerService, layerOwnerKey } from './app-env-layer.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppMembershipService } from './app-membership.js';
import { AppVariablesService } from './app-variables.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit', 'apps:env:manage'];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): environment variables and secrets are encrypted at rest, secrets are
 * never returned (REST service and MCP tool), keys are validated, and workloads that have not received the current
 * values are listed until they record what they applied.
 */
describe.skipIf(!url)('app environment variables on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let variables: AppVariablesService;
  let layer: AppEnvLayerService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  const actor = (scopes: string[] = ALL) => ({ userId, scopes });

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_variables');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    const audit = { log: vi.fn().mockResolvedValue(true) };
    const crypto = new CryptoService('11'.repeat(32));
    apps = new AppsService(db, audit as never, folders, reader);
    layer = new AppEnvLayerService(db, crypto, reader);
    variables = new AppVariablesService(db, audit as never, crypto, apps, layer);
    container.registerInstance(AppsService, apps);
    container.registerInstance(AppVariablesService, variables);
    const group = (await q(`insert into permission_groups (name) values ('apps-vars') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('v@example.test', 'V', $1) returning id`, [group])
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('stores variables and secrets encrypted and never returns secret values', async () => {
    const app = await apps.create(actor(), { name: 'Shop' });
    const env = app.environments[0];
    await variables.setVariables(actor(), app.id, env.id, [{ key: 'LOG_LEVEL', value: 'debug' }]);
    const view = await variables.patchSecrets(actor(), app.id, env.id, { set: { STRIPE_SECRET_KEY: 'sk_live_123' } });
    expect(view.variables).toEqual([{ key: 'LOG_LEVEL', value: 'debug' }]);
    expect(view.secrets.map((secret) => secret.key)).toEqual(['STRIPE_SECRET_KEY']);
    expect(JSON.stringify(view)).not.toContain('sk_live_123');
    const stored = (await q('select encrypted_value from app_environment_variables')).rows.map(
      (row) => row.encrypted_value
    );
    expect(stored.join('')).not.toContain('sk_live_123');
    expect(stored.join('')).not.toContain('debug');

    const viaTool = await executeAppTool({ id: userId, scopes: ALL } as never, 'manage_app_variables', {
      operation: 'get',
      appId: app.id,
      environmentId: env.id,
    });
    expect(JSON.stringify(viaTool)).not.toContain('sk_live_123');

    const resolved = await layer.resolveLayer(env.id);
    expect(resolved.vars).toEqual({ LOG_LEVEL: 'debug' });
    expect(resolved.secrets).toEqual({ STRIPE_SECRET_KEY: 'sk_live_123' });
    expect(resolved.keys).toEqual(['LOG_LEVEL', 'STRIPE_SECRET_KEY']);
  });

  it('validates keys, sizes and the variable/secret split, and needs apps:env:manage', async () => {
    const app = await apps.create(actor(), { name: 'Blog' });
    const env = app.environments[0];
    await expect(variables.setVariables(actor(), app.id, env.id, [{ key: '1BAD', value: 'x' }])).rejects.toMatchObject({
      code: 'APP_VARIABLE_KEY_INVALID',
    });
    await expect(
      variables.setVariables(actor(), app.id, env.id, [{ key: 'BIG', value: 'x'.repeat(33 * 1024) }])
    ).rejects.toMatchObject({ code: 'APP_VARIABLE_VALUE_TOO_LARGE' });
    await variables.patchSecrets(actor(), app.id, env.id, { set: { TOKEN: 'a' } });
    await expect(variables.setVariables(actor(), app.id, env.id, [{ key: 'TOKEN', value: 'b' }])).rejects.toMatchObject(
      {
        code: 'APP_VARIABLE_IS_SECRET',
      }
    );
    await variables.setVariables(actor(), app.id, env.id, [{ key: 'MODE', value: 'x' }]);
    await expect(variables.patchSecrets(actor(), app.id, env.id, { set: { MODE: 'y' } })).rejects.toMatchObject({
      code: 'APP_SECRET_IS_VARIABLE',
    });
    await expect(variables.get(actor([`apps:view:${app.id}`]), app.id, env.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    const after = await variables.patchSecrets(actor(), app.id, env.id, { delete: ['TOKEN'] });
    expect(after.secrets).toEqual([]);
    const cleared = await variables.setVariables(actor(), app.id, env.id, []);
    expect(cleared.variables).toEqual([]);
  });

  it('lists workloads that still run older values until they record the current layer', async () => {
    const app = await apps.create(actor(), { name: 'Api' });
    const env = app.environments[0];
    const docker = (await q(`insert into nodes (hostname, slug, type) values ('d1', 'd1', 'docker') returning id`))
      .rows[0].id;
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id) values ($1, 'container', 'api-web', $2)`,
      [docker, env.placementFolderIds.containers]
    );
    // An empty layer: nothing pending.
    expect((await variables.get(actor(), app.id, env.id)).pendingWorkloads).toEqual([]);
    const view = await variables.setVariables(actor(), app.id, env.id, [{ key: 'LOG_LEVEL', value: 'debug' }]);
    expect(view.pendingWorkloads).toEqual([{ kind: 'container', id: 'api-web', nodeId: docker, name: 'api-web' }]);
    await layer.recordApplied(
      'container',
      layerOwnerKey('container', 'api-web', docker),
      await layer.resolveLayer(env.id)
    );
    expect((await variables.get(actor(), app.id, env.id)).pendingWorkloads).toEqual([]);
    await variables.setVariables(actor(), app.id, env.id, [{ key: 'LOG_LEVEL', value: 'info' }]);
    expect((await variables.get(actor(), app.id, env.id)).pendingWorkloads).toHaveLength(1);
  });

  it('reads the recreate task of a container of the environment, and nothing else', async () => {
    container.registerInstance(AppMembershipService, new AppMembershipService(db, new AppFolderService(db)));
    const tasks = new DockerTaskService(db);
    container.registerInstance(DockerTaskService, tasks);
    const app = await apps.create(actor(), { name: 'Tasks' });
    const env = app.environments[0];
    const staging = await apps.createEnvironment(actor(), app.id, { name: 'staging' });
    const docker = (await q(`insert into nodes (hostname, slug, type) values ('d2', 'd2', 'docker') returning id`))
      .rows[0].id;
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id) values ($1, 'container', 'tasks-web', $2)`,
      [docker, env.placementFolderIds.containers]
    );
    const recreate = await tasks.create({ nodeId: docker, containerName: 'tasks-web', type: 'recreate' });
    await tasks.update(recreate.id, { status: 'running', progress: 'Pulling image' });
    const outside = await tasks.create({ nodeId: docker, containerName: 'elsewhere', type: 'recreate' });

    // Accepted by the node is not finished: the task says where it is.
    expect(await variables.workloadTask(actor(), app.id, env.id, recreate.id)).toMatchObject({
      id: recreate.id,
      type: 'recreate',
      status: 'running',
      progress: 'Pulling image',
      error: null,
    });
    await tasks.update(recreate.id, { status: 'failed', error: 'pull access denied', completedAt: new Date() });
    const viaTool = await executeAppTool({ id: userId, scopes: ALL } as never, 'manage_app_variables', {
      operation: 'workload_task',
      appId: app.id,
      environmentId: env.id,
      taskId: recreate.id,
    });
    expect(viaTool).toMatchObject({ status: 'failed', error: 'pull access denied' });

    for (const [environmentId, taskId] of [
      [env.id, outside.id],
      [staging.id, recreate.id],
      [env.id, '00000000-0000-4000-8000-000000000000'],
    ]) {
      await expect(variables.workloadTask(actor(), app.id, environmentId, taskId)).rejects.toMatchObject({
        statusCode: 404,
        code: 'APP_WORKLOAD_TASK_NOT_FOUND',
      });
    }
    await expect(variables.workloadTask(actor(['apps:view']), app.id, env.id, recreate.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
