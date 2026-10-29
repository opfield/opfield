import 'reflect-metadata';
// The schema barrel first: loading a service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { AccessListService } from './access-list.service.js';
import { AccessListFolderService } from './access-list-folders.service.js';

const scopes = vi.hoisted(() => ({ current: [] as string[] }));

vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: scopes.current });
    c.set('effectiveScopes', scopes.current);
    await next();
  },
}));

const { accessListRoutes } = await import('./access-list.routes.js');

const FOLDER = '22222222-2222-4222-8222-222222222222';
const LIST = '11111111-1111-4111-8111-111111111111';

/** The body the Access Lists page sends (access-list-form.ts): folderId is always present, null without a folder. */
const UI_PAYLOAD = { name: 'Office', ipRules: [{ type: 'allow', value: '10.0.0.0/8' }], basicAuthEnabled: false };

function setup(granted: string[]) {
  scopes.current = granted;
  const lists = {
    create: vi.fn(async (input: Record<string, unknown>) => ({ id: LIST, ...input })),
    update: vi.fn(async (id: string, input: Record<string, unknown>) => ({ id, ...input })),
    moveIpRule: vi.fn(async (id: string) => ({ id })),
  };
  const folders = {
    // The real destination rule, with the folder lookup stubbed.
    assertFolderExists: vi.fn().mockResolvedValue(undefined),
    assertCreateFolder: AccessListFolderService.prototype.assertCreateFolder,
  };
  container.registerInstance(AccessListService, lists as unknown as AccessListService);
  container.registerInstance(AccessListFolderService, folders as unknown as AccessListFolderService);
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/access-lists', accessListRoutes);
  const call = (path: string, method: string, body: unknown) =>
    app.request(`/api/access-lists${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { lists, folders, call };
}

afterEach(() => {
  container.reset();
});

describe('POST /api/access-lists', () => {
  it('creates with folderId null (the page payload), without folderId, and in a folder', async () => {
    const { lists, call } = setup(['acl:create']);

    expect((await call('', 'POST', { ...UI_PAYLOAD, folderId: null })).status).toBe(201);
    expect((await call('', 'POST', UI_PAYLOAD)).status).toBe(201);
    expect((await call('', 'POST', { ...UI_PAYLOAD, folderId: FOLDER })).status).toBe(201);
    expect(lists.create.mock.calls.map(([input]) => input.folderId)).toEqual([null, undefined, FOLDER]);
  });

  it('lets a folder-limited creator create in its folder only', async () => {
    const { lists, call } = setup([`acl:create:folder/${FOLDER}`]);

    expect((await call('', 'POST', { ...UI_PAYLOAD, folderId: FOLDER })).status).toBe(201);
    expect((await call('', 'POST', { ...UI_PAYLOAD, folderId: null })).status).toBe(403);
    expect((await call('', 'POST', UI_PAYLOAD)).status).toBe(403);
    expect(lists.create).toHaveBeenCalledTimes(1);
    expect(lists.create.mock.calls[0]![0]).toMatchObject({ name: 'Office', folderId: FOLDER });
  });

  it('takes the sign-in fields or the legacy fields, never both in one body', async () => {
    const { lists, call } = setup(['acl:create']);
    const signIn = { name: 'Team', signInMethods: ['opfield'], includeRules: [{ selector: 'everyone' }] };

    expect((await call('', 'POST', signIn)).status).toBe(201);
    const mixed = await call('', 'POST', { ...signIn, ipRules: [] });
    expect(mixed.status).toBe(400);
    expect(lists.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy IP rule move route of published clients', async () => {
    const { lists, call } = setup(['acl:edit']);

    expect((await call(`/${LIST}/ip-rules/move`, 'POST', { fromIndex: 1, toIndex: 0 })).status).toBe(200);
    expect(lists.moveIpRule).toHaveBeenCalledWith(LIST, { fromIndex: 1, toIndex: 0 }, 'user-1');
  });

  it('still refuses folderId on an update: a list changes folder through the folder move route', async () => {
    const { lists, call } = setup(['acl:edit']);

    const response = await call(`/${LIST}`, 'PUT', { name: 'Office', folderId: FOLDER });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(lists.update).not.toHaveBeenCalled();
  });
});
