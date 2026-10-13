import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { buildAccessSummary } from '@/lib/access-summary-resolver.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { removeDanglingResourceScopes } from '@/lib/resource-scope-cleanup.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { DockerFolderService } from '@/modules/docker/docker-folder.service.js';
import { FolderService } from '@/modules/proxy/folder.service.js';
import { APP_FAMILIES } from './app-families.js';
import { AppFolderService } from './app-folders.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): hidden app folders never show in folder surfaces, are valid create
 * destinations (environment folders only), refuse normal moves in and out, keep folder grants working, and deleting
 * an environment ungroups its members and drops the grants naming its folders.
 */
describe.skipIf(!url)('hidden app folders on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  let userId = '';
  let nodeId = '';
  let appFolders: AppFolderService;

  const createApp = async (name: string) => {
    const appId = randomUUID();
    const envId = randomUUID();
    await db.transaction(async (tx) => {
      await appFolders.lockFamilies(tx);
      await tx.insert(schema.apps).values({ id: appId, slug: appId.slice(0, 12), name, createdById: userId });
      await tx.insert(schema.appEnvironments).values({
        id: envId,
        appId,
        name: 'production',
        slug: 'production',
        isProduction: true,
        createdById: userId,
      });
      await appFolders.createAppFolders(tx, appId, name, userId);
      await appFolders.createEnvFolders(tx, appId, envId, 'production', userId);
    });
    const folders = (await appFolders.envFolders([envId])).get(envId)!;
    const roots = await appFolders.appRootFolders(appId);
    return { appId, envId, folders, roots };
  };
  const insertDatabase = async (folderId: string | null) =>
    (
      await q(
        `insert into database_connections (name, slug, type, host, port, encrypted_config, created_by_id, folder_id)
         values ($1, $1, 'postgres', 'db.local', 5432, 'x', $2, $3) returning id`,
        [`db-${randomUUID().slice(0, 8)}`, userId, folderId]
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_folders');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    appFolders = new AppFolderService(db);
    const group = (await q(`insert into permission_groups (name) values ('apps-test') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('apps@example.test', 'Apps', $1) returning id`, [
        group,
      ])
    ).rows[0].id;
    nodeId = (await q(`insert into nodes (hostname, slug) values ('apps-node', 'apps-node') returning id`)).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('creates one root and one environment folder per family', async () => {
    const { folders, roots } = await createApp('Shop');
    for (const family of APP_FAMILIES) {
      expect(roots[family], family).toBeTruthy();
      expect(folders[family], family).toBeTruthy();
    }
    expect(folders.containers).not.toBe(folders.compose);
  });

  it('hides app folders from folder trees and lets a user folder share the app name', async () => {
    const { folders } = await createApp('Blog');
    const service = new DatabaseFolderService(db, audit as never);
    const user = await service.createFolder({ name: 'Blog' }, userId);
    const tree = await service.getFolderTree();
    expect(tree.map((folder) => folder.id)).toEqual([user.id]);
    expect(JSON.stringify(tree)).not.toContain(folders.databases!);
    const proxyTree = await new FolderService(db, audit as never).getFolderTree();
    expect(JSON.stringify(proxyTree)).not.toContain(folders.routes!);
    const dockerTree = await new DockerFolderService(db, audit as never).getFolderTree({ resourceType: 'container' });
    expect(JSON.stringify(dockerTree)).not.toContain(folders.containers!);
  });

  it('accepts an environment folder as a create destination, never an app root', async () => {
    const { folders, roots } = await createApp('Docs');
    const service = new DatabaseFolderService(db, audit as never);
    await expect(service.assertFolderExists(folders.databases)).resolves.toBeUndefined();
    await expect(service.assertFolderExists(roots.databases)).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    const proxy = new FolderService(db, audit as never);
    await expect(proxy.assertFolderExists(folders.routes)).resolves.toBeUndefined();
    await expect(proxy.assertFolderExists(roots.routes)).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
  });

  it('refuses normal moves into (404) and out of (409) app folders', async () => {
    const { folders } = await createApp('Api');
    const service = new DatabaseFolderService(db, audit as never);
    const outside = await insertDatabase(null);
    await expect(
      service.moveResourcesToFolder({ ids: [outside], folderId: folders.databases! }, userId)
    ).rejects.toMatchObject({ statusCode: 404 });
    const member = await insertDatabase(folders.databases);
    await expect(service.moveResourcesToFolder({ ids: [member], folderId: null }, userId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'RESOURCE_IN_APP',
    });
    await expect(service.updateFolder(folders.databases!, { name: 'x' }, userId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.deleteFolder(folders.databases!, userId)).rejects.toMatchObject({ statusCode: 404 });

    const docker = new DockerFolderService(db, audit as never);
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, folder_id)
       values ($1, 'container', 'api-web', $2)`,
      [nodeId, folders.containers]
    );
    await expect(
      docker.moveResourcesToFolder(
        { resourceType: 'container', folderId: null, items: [{ nodeId, resourceKey: 'api-web' }] },
        userId
      )
    ).rejects.toMatchObject({ code: 'RESOURCE_IN_APP' });
    await expect(
      docker.moveResourcesToFolder(
        { resourceType: 'container', folderId: folders.containers!, items: [{ nodeId, resourceKey: 'other' }] },
        userId
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('expands a grant on an environment folder to its members', async () => {
    const { folders } = await createApp('Grants');
    const member = await insertDatabase(folders.databases);
    const expanded = await expandFolderScopes(db, [`databases:view:folder/${folders.databases}`]);
    expect(expanded).toContain(`databases:view:${member}`);
  });

  it('names app folder grants and app scopes by app and environment in the access summary', async () => {
    const { appId, envId, folders } = await createApp('Labels');
    const summary = await buildAccessSummary(db, [
      `databases:view:folder/${folders.databases}`,
      `apps:view:env/${envId}`,
      `apps:operate:${appId}`,
    ]);
    const databases = summary.areas.find((area) => area.area === 'databases');
    expect(databases?.folders[0]?.name).toBe('App Labels · production');
    const appsArea = summary.areas.find((area) => area.area === 'apps');
    expect(appsArea?.resources.map((resource) => resource.name).sort()).toEqual([
      'App Labels',
      'App Labels · production',
    ]);
  });

  it('ungroups members and drops grants when an environment is deleted', async () => {
    const { envId, folders } = await createApp('Gone');
    const member = await insertDatabase(folders.databases);
    const grant = `databases:view:folder/${folders.databases}`;
    await q('update users set additional_scopes = $1::jsonb where id = $2', [JSON.stringify([grant]), userId]);
    await db.transaction(async (tx) => {
      await appFolders.lockFamilies(tx);
      await appFolders.deleteEnvFolders(tx, envId);
      await removeDanglingResourceScopes(tx);
    });
    expect((await q('select folder_id from database_connections where id = $1', [member])).rows[0].folder_id).toBe(
      null
    );
    expect((await q('select additional_scopes from users where id = $1', [userId])).rows[0].additional_scopes).toEqual(
      []
    );
  });
});
