import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { CreateAccessListSchema } from '@/modules/access-lists/access-list.schemas.js';
import { AccessListService } from '@/modules/access-lists/access-list.service.js';
import { AccessListFolderService } from '@/modules/access-lists/access-list-folders.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { CreateAlertRuleSchema } from './notification-alert-rule.schemas.js';
import { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import {
  NotificationAlertRuleFolderService,
  NotificationWebhookFolderService,
} from './notification-folders.service.js';
import { CreateWebhookSchema } from './notification-webhook.schemas.js';
import { NotificationWebhookService } from './notification-webhook.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const audit = { log: async () => true } as unknown as AuditService;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): alert rules, webhooks and access lists live in folders. Rules and webhooks that
 * existed before stay ungrouped in their order, built-in rules never move, folder grants cover what is inside, and
 * deleting a folder ungroups its items and removes the grants naming it (and those naming a deleted item).
 */
describe.skipIf(!url)('Alert rule, webhook and access list folders on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  let groupId = '';

  const ruleInput = (name: string, folderId?: string) =>
    CreateAlertRuleSchema.parse({
      name,
      type: 'event',
      category: 'node',
      eventPattern: 'offline',
      webhookIds: [],
      ...(folderId ? { folderId } : {}),
    });

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'notification_folders');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    groupId = (await q(`insert into permission_groups (name) values ($1) returning id`, [`notif-${suffix}`])).rows[0]
      .id;
    userId = (
      await q(`insert into users (email, name, group_id) values ($1, 'Operator', $2) returning id`, [
        `notif-${suffix}@example.test`,
        groupId,
      ])
    ).rows[0].id;
  });

  it('keeps the shipped built-in rules ungrouped, in their order', async () => {
    const rows = (
      await q('select folder_id, sort_order from notification_alert_rules where is_builtin order by created_at, id')
    ).rows as Array<{ folder_id: string | null; sort_order: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.folder_id === null)).toBe(true);
    const orders = rows.map((row) => row.sort_order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('creates a rule in a folder at its end, lists by folder, and never moves a built-in rule', async () => {
    const folders = new NotificationAlertRuleFolderService(db, audit);
    const rules = new NotificationAlertRuleService(db, audit);
    const folder = await folders.createFolder({ name: 'Edge' }, userId);

    const first = await rules.create(ruleInput('Edge down', folder.id), userId);
    const second = await rules.create(ruleInput('Edge flapping', folder.id), userId);
    expect(first.folderId).toBe(folder.id);
    expect(second.sortOrder).toBe(first.sortOrder + 1);
    const listed = await rules.list({ page: 1, limit: 100, folderId: folder.id });
    expect(listed.data.map((rule) => rule.id).sort()).toEqual([first.id, second.id].sort());
    expect((await rules.list({ page: 1, limit: 100 }, { allowedIds: [first.id] })).data.map((r) => r.id)).toEqual([
      first.id,
    ]);

    const builtin = (await q('select id from notification_alert_rules where is_builtin limit 1')).rows[0].id;
    await expect(folders.moveResourcesToFolder({ ids: [builtin], folderId: folder.id }, userId)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BUILTIN_ALERT_RULE_FOLDER_LOCKED',
    });
  });

  it('expands rule folder grants to the rules inside and its subfolders', async () => {
    const folders = new NotificationAlertRuleFolderService(db, audit);
    const rules = new NotificationAlertRuleService(db, audit);
    const team = await folders.createFolder({ name: 'Team' }, userId);
    const sub = await folders.createFolder({ name: 'Nested', parentId: team.id }, userId);
    const inside = await rules.create(ruleInput('Inside', sub.id), userId);
    const outside = await rules.create(ruleInput('Outside'), userId);

    const expanded = await expandFolderScopes(db, [`notifications:alerts:view:folder/${team.id}`]);
    expect(expanded).toContain(`notifications:alerts:view:${inside.id}`);
    expect(expanded).toContain(`notifications:alerts:view:folder/${sub.id}`);
    expect(expanded).not.toContain(`notifications:alerts:view:${outside.id}`);
  });

  it('ungroups the webhooks and removes the grants of a deleted webhook folder and a deleted webhook', async () => {
    const folders = new NotificationWebhookFolderService(db, audit);
    const webhooks = new NotificationWebhookService(db, audit, {} as never);
    const folder = await folders.createFolder({ name: 'Partners' }, userId);
    const webhook = await webhooks.create(
      CreateWebhookSchema.parse({ name: 'Partner', url: 'https://hooks.example.test/p', folderId: folder.id }),
      userId
    );
    const other = await webhooks.create(
      CreateWebhookSchema.parse({ name: 'Other', url: 'https://hooks.example.test/o' }),
      userId
    );
    const grants = [`notifications:webhooks:view:folder/${folder.id}`, `notifications:webhooks:manage:${other.id}`];
    await q('update permission_groups set scopes = $2 where id = $1', [groupId, JSON.stringify(grants)]);

    await folders.deleteFolder(folder.id, userId);
    expect((await q('select folder_id from notification_webhooks where id = $1', [webhook.id])).rows[0].folder_id).toBe(
      null
    );
    expect((await q('select scopes from permission_groups where id = $1', [groupId])).rows[0].scopes).toEqual([
      `notifications:webhooks:manage:${other.id}`,
    ]);

    await webhooks.delete(other.id, userId);
    expect((await q('select scopes from permission_groups where id = $1', [groupId])).rows[0].scopes).toEqual([]);
  });

  it('creates access lists in folders, expands folder grants to them and ungroups them with the folder', async () => {
    const folders = new AccessListFolderService(db, audit);
    const lists = new AccessListService(db, {} as never, {} as never, audit, {} as never, {} as never);
    const team = await folders.createFolder({ name: 'Customers' }, userId);
    const inside = await lists.create(CreateAccessListSchema.parse({ name: 'Customer A', folderId: team.id }), userId);
    const outside = await lists.create(CreateAccessListSchema.parse({ name: 'Office' }), userId);
    expect(inside.folderId).toBe(team.id);

    const expanded = await expandFolderScopes(db, [`acl:edit:folder/${team.id}`, `acl:create:folder/${team.id}`]);
    expect(expanded).toContain(`acl:edit:${inside.id}`);
    expect(expanded).not.toContain(`acl:edit:${outside.id}`);
    expect(expanded).not.toContain(`acl:create:${inside.id}`);
    expect((await lists.list({ page: 1, limit: 100, folderId: team.id })).data.map((list) => list.id)).toEqual([
      inside.id,
    ]);

    await folders.deleteFolder(team.id, userId);
    expect((await q('select folder_id from access_lists where id = $1', [inside.id])).rows[0].folder_id).toBe(null);
  });
  it('lists rules, webhooks and access lists in folder-tree order, then sortOrder, ungrouped last', async () => {
    // Folders: First (sortOrder 0) with a subfolder Nested, then Second (sortOrder 1).
    const ruleFolders = new NotificationAlertRuleFolderService(db, audit);
    const rules = new NotificationAlertRuleService(db, audit);
    const second = await ruleFolders.createFolder({ name: 'Second' }, userId);
    const first = await ruleFolders.createFolder({ name: 'First' }, userId);
    await ruleFolders.reorderFolders({
      items: [
        { id: first.id, sortOrder: 0 },
        { id: second.id, sortOrder: 1 },
      ],
    });
    const nested = await ruleFolders.createFolder({ name: 'Nested', parentId: first.id }, userId);
    const ungrouped = await rules.create(ruleInput('Ungrouped'), userId);
    const inSecond = await rules.create(ruleInput('In second'), userId);
    await ruleFolders.moveResourcesToFolder({ ids: [inSecond.id], folderId: second.id }, userId);
    const inNested = await rules.create(ruleInput('In nested', nested.id), userId);
    const firstB = await rules.create(ruleInput('First B', first.id), userId);
    const firstA = await rules.create(ruleInput('First A', first.id), userId);
    await ruleFolders.reorderResources({
      items: [
        { id: firstA.id, sortOrder: 0 },
        { id: firstB.id, sortOrder: 1 },
      ],
    });
    const ids = [ungrouped, inSecond, inNested, firstB, firstA].map((rule) => rule.id);
    const listed = (await rules.list({ page: 1, limit: 100 }, { allowedIds: ids })).data.map((rule) => rule.id);
    expect(listed).toEqual([firstA.id, firstB.id, inNested.id, inSecond.id, ungrouped.id]);
    // Built-in rules come first, as their group does in the list.
    const all = (await rules.list({ page: 1, limit: 100 })).data;
    expect(all[0]!.isBuiltin).toBe(true);
    expect(all.findIndex((rule) => !rule.isBuiltin)).toBe(all.filter((rule) => rule.isBuiltin).length);

    const webhookFolders = new NotificationWebhookFolderService(db, audit);
    const webhooks = new NotificationWebhookService(db, audit, {} as never);
    const hookFolder = await webhookFolders.createFolder({ name: 'Hooks' }, userId);
    const looseHook = await webhooks.create(
      CreateWebhookSchema.parse({ name: 'Loose', url: 'https://hooks.example.test/l' }),
      userId
    );
    const folderHook = await webhooks.create(
      CreateWebhookSchema.parse({ name: 'Foldered', url: 'https://hooks.example.test/f', folderId: hookFolder.id }),
      userId
    );
    const hookIds = (await webhooks.list({ page: 1, limit: 100 }, { allowedIds: [looseHook.id, folderHook.id] })).data;
    expect(hookIds.map((hook) => hook.id)).toEqual([folderHook.id, looseHook.id]);

    const listFolders = new AccessListFolderService(db, audit);
    const lists = new AccessListService(db, {} as never, {} as never, audit, {} as never, {} as never);
    const listFolder = await listFolders.createFolder({ name: 'Partners' }, userId);
    const looseList = await lists.create(CreateAccessListSchema.parse({ name: 'Loose' }), userId);
    const folderList = await lists.create(
      CreateAccessListSchema.parse({ name: 'Partner', folderId: listFolder.id }),
      userId
    );
    const listIds = (await lists.list({ page: 1, limit: 100 }, { allowedIds: [looseList.id, folderList.id] })).data.map(
      (list) => list.id
    );
    expect(listIds).toEqual([folderList.id, looseList.id]);
  });
});
