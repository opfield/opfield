import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { PageDeploymentService } from '@/modules/pages/deployments/page-deployment.service.js';
import { AppFolderService } from './app-folders.service.js';
import { AppIncidentsRepo } from './app-incidents.repo.js';
import { AppMemberFreeze } from './app-member-freeze.js';
import { AppMembersReader } from './app-members.service.js';
import { AppPromotionService } from './app-promotion.service.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const ALL = ['apps:view', 'apps:create', 'apps:edit', 'apps:env:manage', 'apps:promote', 'pages:view'];

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): promotion between environments over real rows, with Pages (what runs
 * is the artifact of the `latest` tag). Pairs by name without the environment suffix, marks the same artifact as
 * same, refuses a stale preview, runs the selected items and records per-item status and the activity entry.
 */
describe.skipIf(!url)('app promotion on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let promotions: AppPromotionService;
  const audit = { log: vi.fn().mockResolvedValue(true) };
  const promoteDeployment = vi.fn(async () => ({ deploymentId: randomUUID(), sequence: 49, previousSequence: 48 }));
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  const actor = (scopes = ALL) => ({ userId, scopes });

  const project = async (name: string, folderId: string, artifact: string | null, sequence: number) => {
    const id = (
      await q(`insert into page_projects (name, slug, folder_id, created_by_id) values ($1, $2, $3, $4) returning id`, [
        name,
        `${name}-${randomUUID().slice(0, 6)}`,
        folderId,
        userId,
      ])
    ).rows[0].id as string;
    if (artifact) {
      const deployment = (
        await q(
          `insert into page_deployments (project_id, sequence, public_slug, status, artifact_sha256)
           values ($1, $2, $3, 'ready', $4) returning id`,
          [id, sequence, randomUUID().slice(0, 12), artifact]
        )
      ).rows[0].id;
      await q(`insert into page_tags (project_id, name, deployment_id, system) values ($1, 'latest', $2, true)`, [
        id,
        deployment,
      ]);
    }
    return id;
  };

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_promotion');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const reader = new AppMembersReader(db, folders);
    apps = new AppsService(db, audit as never, folders, reader);
    promotions = new AppPromotionService(
      db,
      apps,
      reader,
      new AppMemberFreeze(db, new AppIncidentsRepo(db)),
      audit as never
    );
    container.registerInstance(PageDeploymentService, { promoteDeployment } as never);
    const group = (await q(`insert into permission_groups (name) values ('apps-promo') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('pr@example.test', 'P', $1) returning id`, [group])
    ).rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('previews, refuses a stale preview and promotes the selected Pages project', async () => {
    const app = await apps.create(actor(), { name: 'Shop' });
    const live = app.environments[0]!;
    const staging = await apps.createEnvironment(actor(), app.id, { name: 'staging' });
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    await project('shop-help-staging', staging.placementFolderIds.pages!, b, 52);
    await project('shop-docs', staging.placementFolderIds.pages!, a, 3);
    await project('shop-blog-staging', staging.placementFolderIds.pages!, a, 7);
    const help = await project('shop-help', live.placementFolderIds.pages!, a, 48);
    await project('shop-docs', live.placementFolderIds.pages!, a, 9);

    const preview = await promotions.preview(actor(), app.id, staging.id, live.id);
    const helpItem = preview.items.find((item) => item.targetId === help)!;
    expect(helpItem).toMatchObject({ type: 'pages', same: false, promotable: true, fromDigest: a, toDigest: b });
    expect(helpItem.pages).toEqual({ fromSequence: 48, toSequence: 52, artifactSha256: b });
    expect(preview.unchanged).toEqual(['shop-docs']);
    expect(preview.unpaired).toEqual([
      expect.objectContaining({ name: 'shop-blog-staging', message: 'not in production' }),
    ]);

    await expect(
      promotions.preview(
        { userId, scopes: ['apps:view', `apps:promote:env/${staging.id}`] },
        app.id,
        staging.id,
        live.id
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      promotions.execute(actor(), app.id, {
        sourceEnvironmentId: staging.id,
        targetEnvironmentId: live.id,
        items: [helpItem.pairKey],
        previewDigest: 'stale',
      })
    ).rejects.toMatchObject({ code: 'PROMOTION_PREVIEW_STALE' });

    const started = await promotions.execute(actor(), app.id, {
      sourceEnvironmentId: staging.id,
      targetEnvironmentId: live.id,
      items: [helpItem.pairKey],
      previewDigest: preview.previewDigest,
    });
    expect(started.items).toEqual([expect.objectContaining({ pairKey: helpItem.pairKey, status: 'pending' })]);
    await vi.waitFor(async () => {
      const current = await promotions.get(ALL, app.id, started.id);
      expect(current.status).toBe('succeeded');
    });
    const done = await promotions.get(ALL, app.id, started.id);
    expect(done.items[0]).toMatchObject({ status: 'succeeded' });
    expect(done.items[0]!.detail).toContain('deployment #49, was #48');
    expect(promoteDeployment).toHaveBeenCalledWith(expect.any(String), help, userId);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'app.environment.promote', resourceId: live.id })
    );
    expect(await promotions.list(ALL, app.id, live.id)).toHaveLength(1);
  });
});
