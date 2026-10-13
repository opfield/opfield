import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { getContainerEnv } from '@/modules/docker/docker-env-operations.js';
import { DockerEnvironmentService } from '@/modules/docker/docker-environment.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import {
  copyContainerLayer,
  forgetContainerLayer,
  inheritedContainerLayer,
  planContainerLayer,
  recordContainerLayer,
  renameContainerLayer,
} from './app-container-layer.js';
import { AppEnvLayerService } from './app-env-layer.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMembersReader } from './app-members.service.js';
import { AppVariablesService } from './app-variables.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit', 'apps:env:manage'];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a container in an app environment gets the layer from its folder,
 * keeps its record across rename and duplicate, and the environment view never shows or seeds layer keys as the
 * container's own env.
 */
describe.skipIf(!url)('container environment layer on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let variables: AppVariablesService;
  let crypto: CryptoService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  let nodeId = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_container_layer');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    const audit = { log: vi.fn().mockResolvedValue(true) };
    crypto = new CryptoService('22'.repeat(32));
    apps = new AppsService(db, audit as never, folders, reader);
    const layer = new AppEnvLayerService(db, crypto, reader);
    variables = new AppVariablesService(db, audit as never, crypto, apps, layer);
    container.registerInstance(AppEnvLayerService, layer);
    const group = (await q(`insert into permission_groups (name) values ('apps-layer') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('l@example.test', 'L', $1) returning id`, [group])
    ).rows[0].id;
    nodeId = (await q(`insert into nodes (hostname, slug, type) values ('dl', 'dl', 'docker') returning id`)).rows[0]
      .id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('plans the layer of a container from its folder and keeps the record across rename, copy and removal', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Shop' });
    const env = app.environments[0];
    await variables.setVariables({ userId, scopes: ALL }, app.id, env.id, [{ key: 'LOG_LEVEL', value: 'debug' }]);
    await variables.patchSecrets({ userId, scopes: ALL }, app.id, env.id, { set: { API_KEY: 'k' } });

    // A create into the environment folder (the container does not sit there yet).
    const created = await planContainerLayer(db, nodeId, 'web', env.placementFolderIds.containers);
    expect(created?.layer.vars).toEqual({ LOG_LEVEL: 'debug' });
    expect(created?.layer.secrets).toEqual({ API_KEY: 'k' });
    expect(await planContainerLayer(db, nodeId, 'other', null)).toBe(null);

    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id) values ($1, 'container', 'web', $2)`,
      [nodeId, env.placementFolderIds.containers]
    );
    await recordContainerLayer(created, nodeId, 'web');
    const recreate = await planContainerLayer(db, nodeId, 'web');
    expect(recreate?.previous?.appliedKeys).toEqual(['API_KEY', 'LOG_LEVEL']);
    expect((await inheritedContainerLayer(db, nodeId, 'web'))?.pending).toBe(false);

    await renameContainerLayer(nodeId, 'web', 'web2');
    expect((await planContainerLayer(db, nodeId, 'web2', env.placementFolderIds.containers))?.previous).not.toBe(null);
    await copyContainerLayer(nodeId, 'web2', 'web3');
    expect((await planContainerLayer(db, nodeId, 'web3', null))?.previous?.appliedKeys).toEqual([
      'API_KEY',
      'LOG_LEVEL',
    ]);
    await forgetContainerLayer(nodeId, 'web3');
    expect(await planContainerLayer(db, nodeId, 'web3', null)).toBe(null);
  });

  it('never shows or seeds layer keys as the container own env', async () => {
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Blog' });
    const env = app.environments[0];
    await variables.setVariables({ userId, scopes: ALL }, app.id, env.id, [{ key: 'LOG_LEVEL', value: 'debug' }]);
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id) values ($1, 'container', 'blog', $2)`,
      [nodeId, env.placementFolderIds.containers]
    );
    await recordContainerLayer(await planContainerLayer(db, nodeId, 'blog'), nodeId, 'blog');
    const environmentService = new DockerEnvironmentService(db, crypto);
    const inspect = { Name: '/blog', Config: { Env: ['PATH=/usr/bin', 'LOG_LEVEL=debug', 'OWN=1'] } };
    const env1 = await getContainerEnv(
      {
        db,
        nodeDispatch: { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }) } as never,
        environmentService,
        parseResult: () => inspect,
      },
      nodeId,
      'blog'
    );
    expect(env1).toEqual(['PATH=/usr/bin', 'OWN=1']);
    expect(await environmentService.getDecryptedMap(nodeId, 'blog')).toEqual({ PATH: '/usr/bin', OWN: '1' });
  });
});
