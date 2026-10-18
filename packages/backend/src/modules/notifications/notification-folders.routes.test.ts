import 'reflect-metadata';
// The schema barrel first: loading a service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import {
  NotificationAlertRuleFolderService,
  NotificationWebhookFolderService,
} from './notification-folders.service.js';
import { NotificationWebhookService } from './notification-webhook.service.js';

const scopes = vi.hoisted(() => ({ current: [] as string[] }));
const mutations = vi.hoisted(() => ({
  create: vi.fn(async (_service: unknown, input: Record<string, unknown>) => ({ id: 'created', ...input })),
}));

vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: scopes.current });
    c.set('effectiveScopes', scopes.current);
    await next();
  },
}));

// The rule side effects (watched-resource checks, evaluator) are covered elsewhere; these tests cover placement.
vi.mock('./notification-alert-rule.mutations.js', () => ({
  createAlertRuleWithEffects: mutations.create,
  updateAlertRuleWithEffects: vi.fn(async (_service: unknown, id: string) => ({ id })),
  deleteAlertRuleWithEffects: vi.fn(async () => undefined),
}));

const { alertRuleRoutes } = await import('./notification-alert-rule.routes.js');
const { webhookRoutes } = await import('./notification-webhook.routes.js');

const RULE = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const WEBHOOK = '44444444-4444-4444-8444-444444444444';
const OTHER_WEBHOOK = '55555555-5555-4555-8555-555555555555';
const PARENTS: Record<string, string | null> = { [FOLDER]: TEAM, [TEAM]: null };

function folderService(assertCreateFolder: (...args: any[]) => Promise<void>) {
  return {
    getFolderTree: vi.fn().mockResolvedValue([]),
    createFolder: vi.fn().mockResolvedValue({ id: FOLDER }),
    updateFolder: vi.fn().mockResolvedValue({ id: FOLDER }),
    moveFolder: vi.fn().mockResolvedValue({ id: FOLDER }),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    reorderFolders: vi.fn().mockResolvedValue(undefined),
    moveResourcesToFolder: vi.fn().mockResolvedValue(undefined),
    reorderResources: vi.fn().mockResolvedValue(undefined),
    getFolderParentIds: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, PARENTS[id] ?? null]))),
    getResourceFolderIds: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, FOLDER]))),
    // The real create rule, with the folder lookup stubbed.
    assertFolderExists: vi.fn().mockResolvedValue(undefined),
    assertCreateFolder,
  };
}

function setup(granted: string[]) {
  scopes.current = granted;
  const ruleFolders = folderService(NotificationAlertRuleFolderService.prototype.assertCreateFolder);
  const webhookFolders = folderService(NotificationWebhookFolderService.prototype.assertCreateFolder);
  const rules = {
    list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
    getById: vi.fn(async (id: string) => ({ id })),
  };
  const webhooks = {
    list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
    getById: vi.fn(async (id: string) => ({ id })),
    create: vi.fn(async (input: Record<string, unknown>) => ({ id: 'created', ...input })),
  };
  container.registerInstance(
    NotificationAlertRuleFolderService,
    ruleFolders as unknown as NotificationAlertRuleFolderService
  );
  container.registerInstance(
    NotificationWebhookFolderService,
    webhookFolders as unknown as NotificationWebhookFolderService
  );
  container.registerInstance(NotificationAlertRuleService, rules as unknown as NotificationAlertRuleService);
  container.registerInstance(NotificationWebhookService, webhooks as unknown as NotificationWebhookService);
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/notifications/alert-rules', alertRuleRoutes);
  app.route('/api/notifications/webhooks', webhookRoutes);
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api/notifications${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ruleFolders, webhookFolders, rules, webhooks, call };
}

const NEW_RULE = {
  name: 'Node offline',
  type: 'event',
  category: 'node',
  eventPattern: 'offline',
  webhookIds: [],
};

afterEach(() => {
  container.reset();
  mutations.create.mockClear();
});

describe('alert rule folders', () => {
  it('lists folders for rule viewers but changes them only with the folder scope', async () => {
    const { ruleFolders, call } = setup(['notifications:alerts:view']);

    expect((await call('/alert-rules/folders')).status).toBe(200);
    expect(ruleFolders.getFolderTree).toHaveBeenCalledWith({ includeAllFolders: true });
    expect((await call('/alert-rules/folders', 'POST', { name: 'Team' })).status).toBe(403);
    expect(ruleFolders.createFolder).not.toHaveBeenCalled();
  });

  it('creates folders with notifications:alerts:folders:manage', async () => {
    const { ruleFolders, call } = setup(['notifications:alerts:folders:manage']);

    expect((await call('/alert-rules/folders', 'POST', { name: 'Team' })).status).toBe(201);
    expect(ruleFolders.createFolder).toHaveBeenCalledWith({ name: 'Team' }, 'user-1');
  });

  it('moves a rule only with notifications:alerts:manage on it and on the destination', async () => {
    const move = { ids: [RULE], folderId: FOLDER };
    let routes = setup(['notifications:alerts:folders:manage', `notifications:alerts:manage:${RULE}`]);
    expect((await routes.call('/alert-rules/folders/move-rules', 'POST', move)).status).toBe(403);
    expect(routes.ruleFolders.moveResourcesToFolder).not.toHaveBeenCalled();
    container.reset();

    routes = setup([
      'notifications:alerts:folders:manage',
      `notifications:alerts:manage:${RULE}`,
      `notifications:alerts:manage:folder/${FOLDER}`,
    ]);
    expect((await routes.call('/alert-rules/folders/move-rules', 'POST', move)).status).toBe(200);
    expect(routes.ruleFolders.moveResourcesToFolder).toHaveBeenCalledWith(move, 'user-1');
  });

  it('lists only the granted rules to a folder-limited caller and reads a rule only with view on it', async () => {
    const { rules, call } = setup([`notifications:alerts:view:folder/${FOLDER}`, `notifications:alerts:view:${RULE}`]);

    expect((await call('/alert-rules')).status).toBe(200);
    expect(rules.list).toHaveBeenCalledWith(expect.any(Object), { allowedIds: [RULE] });
    expect((await call(`/alert-rules/${RULE}`)).status).toBe(200);
    expect((await call(`/alert-rules/${WEBHOOK}`)).status).toBe(403);
  });

  it('creates a rule in a folder with manage there, and refuses the root', async () => {
    const { call } = setup([`notifications:alerts:manage:folder/${FOLDER}`]);

    expect((await call('/alert-rules', 'POST', { ...NEW_RULE, folderId: FOLDER })).status).toBe(201);
    expect(mutations.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ folderId: FOLDER }),
      expect.any(Array),
      'user-1'
    );
    expect((await call('/alert-rules', 'POST', NEW_RULE)).status).toBe(403);
    expect(mutations.create).toHaveBeenCalledTimes(1);
  });
});

describe('notification webhook folders', () => {
  it('lists the granted webhooks and reveals URL and headers only where the caller may manage', async () => {
    const { webhooks, call } = setup([
      `notifications:webhooks:view:${OTHER_WEBHOOK}`,
      `notifications:webhooks:manage:${WEBHOOK}`,
    ]);

    expect((await call('/webhooks')).status).toBe(200);
    const options = webhooks.list.mock.calls[0]![1];
    expect([...options.allowedIds].sort()).toEqual([WEBHOOK, OTHER_WEBHOOK].sort());
    expect(options.revealUrl(WEBHOOK)).toBe(true);
    expect(options.revealUrl(OTHER_WEBHOOK)).toBe(false);
  });

  it('moves webhooks with the folder scope and manage on each webhook and the destination', async () => {
    const move = { ids: [WEBHOOK], folderId: FOLDER };
    const { webhookFolders, call } = setup([
      'notifications:webhooks:folders:manage',
      `notifications:webhooks:manage:${WEBHOOK}`,
      `notifications:webhooks:manage:folder/${FOLDER}`,
    ]);

    expect((await call('/webhooks/folders/move-webhooks', 'POST', move)).status).toBe(200);
    expect(webhookFolders.moveResourcesToFolder).toHaveBeenCalledWith(move, 'user-1');
  });

  it('creates a webhook in a folder with manage there, and refuses the root', async () => {
    const { webhooks, call } = setup([`notifications:webhooks:manage:folder/${FOLDER}`]);
    const body = { name: 'Ops', url: 'https://hooks.example.com/ops' };

    expect((await call('/webhooks', 'POST', { ...body, folderId: FOLDER })).status).toBe(201);
    expect(webhooks.create).toHaveBeenCalledWith(expect.objectContaining({ folderId: FOLDER }), 'user-1');
    expect((await call('/webhooks', 'POST', body)).status).toBe(403);
    expect(webhooks.create).toHaveBeenCalledTimes(1);
  });
});

describe('alert rule folder service', () => {
  it('keeps built-in rules in the built-in group', async () => {
    const rows = [{ id: RULE, isBuiltin: true }];
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
    const service = new NotificationAlertRuleFolderService(db as never, { log: vi.fn() } as never);

    await expect(service.moveResourcesToFolder({ ids: [RULE], folderId: FOLDER }, 'user-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'BUILTIN_ALERT_RULE_FOLDER_LOCKED',
    });
    await expect(service.reorderResources({ items: [{ id: RULE, sortOrder: 0 }] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
