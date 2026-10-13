import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { UIBootstrapService } from '@/modules/ui-bootstrap/ui-bootstrap.service.js';
import type { User } from '@/types.js';
import { AppFolderService } from './app-folders.service.js';
import { AppMembersReader } from './app-members.service.js';
import { resolveAppOnlyScopeBases } from './app-place-scopes.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit'];

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): the UI bootstrap reports the scope bases a user holds only through
 * apps' hidden folders, read from the assigned grants (not their folder expansion), so the global sections hide them.
 */
describe.skipIf(!url)('scopes held only through app places on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let folders: AppFolderService;
  const one = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0];
  let userId = '';
  let envFolders: Record<string, string> = {};
  let rootFolders: Record<string, string | null> = {};
  let userStorageFolder = '';
  let storageId = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_place_scopes');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    folders = new AppFolderService(db);
    const apps = new AppsService(db, new AuditService(db), folders, new AppMembersReader(db, folders));
    const group = (await one(`insert into permission_groups (name) values ('app-places') returning id`)).id;
    userId = (
      await one(`insert into users (email, name, group_id) values ('ap@example.test', 'A', $1) returning id`, [group])
    ).id;
    const app = await apps.create({ userId, scopes: ALL }, { name: 'Shop' });
    envFolders = app.environments[0]!.placementFolderIds as Record<string, string>;
    rootFolders = await folders.appRootFolders(app.id);
    userStorageFolder = (
      await one(`insert into object_storage_folders (name, created_by_id) values ('Team', $1) returning id`, [userId])
    ).id;
    // A storage connection in the environment: the folder grant expands to a resource grant on it.
    storageId = (
      await one(
        `insert into object_storage_connections (name, slug, provider, endpoint, default_bucket, encrypted_config, created_by_id, folder_id)
         values ('shop-s3', 'shop-s3', 'aws', 'https://s3.example.test', 'shop', 'x', $1, $2) returning id`,
        [userId, envFolders.storage]
      )
    ).id;
    container.registerInstance(TOKENS.DrizzleClient, db);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  /** The scopes of an "In an app environment" line for the whole app (root folders) or the environment. */
  const appLine = (place: Record<string, string | null>) => [
    'apps:view',
    `docker:containers:view:folder/${place.containers}`,
    `docker:compose:view:folder/${place.compose}`,
    `proxy:view:folder/${place.routes}`,
    `databases:view:folder/${place.databases}`,
    `storage:view:folder/${place.storage}`,
    `pages:view:folder/${place.pages}`,
  ];
  const MEMBER_BASES = [
    'databases:view',
    'docker:compose:view',
    'docker:containers:view',
    'pages:view',
    'proxy:view',
    'storage:view',
  ];

  it('finds environment and app-root folders as app places', async () => {
    expect(await resolveAppOnlyScopeBases(db, appLine(envFolders))).toEqual(MEMBER_BASES);
    expect(await resolveAppOnlyScopeBases(db, appLine(rootFolders))).toEqual(MEMBER_BASES);
  });

  it('keeps a base also granted on a user folder, a resource or broadly', async () => {
    const withExtra = (extra: string) => resolveAppOnlyScopeBases(db, [...appLine(envFolders), extra]);
    expect(await withExtra(`storage:view:folder/${userStorageFolder}`)).not.toContain('storage:view');
    expect(await withExtra(`storage:view:${storageId}`)).not.toContain('storage:view');
    expect(await withExtra('storage:view')).not.toContain('storage:view');
    expect(await withExtra('storage:view')).toContain('proxy:view');
  });

  it('is what the UI bootstrap reports, classified from the assigned grants rather than their expansion', async () => {
    const shell = Object.create(UIBootstrapService.prototype) as UIBootstrapService;
    const bootstrapBases = (assigned: string[], effective: string[]) =>
      (shell as any).appOnlyScopeBases(
        { id: userId, groupScopes: assigned, additionalScopes: [] } as unknown as User,
        effective
      );

    const appOnly = appLine(envFolders);
    const effective = await expandFolderScopes(db, appOnly);
    // The expansion adds a resource grant on the environment's storage connection; it does not make Storage global.
    expect(effective).toContain(`storage:view:${storageId}`);
    expect(await bootstrapBases(appOnly, effective)).toEqual(MEMBER_BASES);

    const mixed = [...appOnly, `storage:view:folder/${userStorageFolder}`];
    expect(await bootstrapBases(mixed, await expandFolderScopes(db, mixed))).toEqual(
      MEMBER_BASES.filter((base) => base !== 'storage:view')
    );

    // A refused impersonation has no effective scopes: nothing to classify.
    expect(await bootstrapBases(appOnly, [])).toEqual([]);
  });
});
