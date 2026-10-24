import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, requireScopeBase } from '@/modules/auth/auth.middleware.js';
import {
  assertFolderManage,
  assertFolderManageForFolder,
  assertFolderManageForFolders,
  assertFolderManageForResources,
} from '@/modules/resource-folders/resource-folder-access.js';
import type { AppEnv } from '@/types.js';
import {
  createProxyFolderRoute,
  deleteProxyFolderRoute,
  groupedProxyHostsRoute,
  listProxyFoldersRoute,
  moveProxyFolderRoute,
  moveProxyHostsRoute,
  reorderProxyFoldersRoute,
  reorderProxyHostsRoute,
  updateProxyFolderRoute,
} from './folder.docs.js';
import {
  CreateFolderSchema,
  GroupedHostsQuerySchema,
  MoveFolderSchema,
  MoveHostsToFolderSchema,
  ReorderFoldersSchema,
  ReorderHostsSchema,
  UpdateFolderSchema,
} from './folder.schemas.js';
import { FolderService } from './folder.service.js';
import { redactFolderTreeProxyHostsForScopes, redactGroupedPageTargets } from './page-target-visibility.js';
import {
  redactFolderTreeRawProxyConfigForBrowserResponse,
  redactGroupedRawProxyConfigForBrowserResponse,
} from './raw-visibility.js';

export const folderRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

folderRoutes.use('*', authMiddleware);

export { stripGroupedRawProxyConfigForProgrammaticResponse as stripGroupedRawConfigForProgrammaticResponse } from './raw-visibility.js';

function requireFolderListAccess(scopes: string[]) {
  if (
    !hasScopeBase(scopes, 'proxy:view') &&
    !hasScopeBase(scopes, 'proxy:create') &&
    !hasScopeBase(scopes, 'proxy:folders:manage')
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required route view, create, or folder scope', {
      requiredScopes: ['proxy:view', 'proxy:create', 'proxy:folders:manage'],
      scopeMatch: 'any',
    });
  }
}

// --- Static GET routes first ---

// Get folder tree
folderRoutes.openapi(listProxyFoldersRoute, async (c) => {
  const folderService = container.resolve(FolderService);
  const scopes = c.get('effectiveScopes') || [];
  requireFolderListAccess(scopes);
  const canManageFolders = hasScope(scopes, 'proxy:folders:manage');
  const hasGlobalView = hasScope(scopes, 'proxy:view');
  const hasGlobalCreate = hasScope(scopes, 'proxy:create');
  const tree = await folderService.getFolderTree(
    canManageFolders || hasGlobalView || hasGlobalCreate
      ? { includeAllFolders: true }
      : {
          allowedHostIds: getResourceScopedIds(scopes, 'proxy:view'),
          allowedFolderIds: getFolderScopedIds(scopes, [
            'proxy:view',
            'proxy:edit',
            'proxy:create',
            'proxy:folders:manage',
          ]),
        }
  );
  return c.json({
    data: redactFolderTreeProxyHostsForScopes(
      redactFolderTreeRawProxyConfigForBrowserResponse(tree, (host) => {
        const hostId = typeof host.id === 'string' ? host.id : undefined;
        return scopes.includes('proxy:raw:read') || (hostId ? scopes.includes(`proxy:raw:read:${hostId}`) : false);
      }),
      scopes
    ),
  });
});

// Get grouped hosts
folderRoutes.openapi(groupedProxyHostsRoute, async (c) => {
  const folderService = container.resolve(FolderService);
  const rawQuery = c.req.query();
  const query = GroupedHostsQuerySchema.parse(rawQuery);
  const scopes = c.get('effectiveScopes') || [];
  requireFolderListAccess(scopes);
  const canManageFolders = hasScope(scopes, 'proxy:folders:manage');
  // Folder-scoped grants keep their folders visible while they are still empty,
  // so a folder-only user sees where they can create or move routes.
  const result = await folderService.getGroupedHosts(
    query,
    hasScope(scopes, 'proxy:view')
      ? { includeAllFolders: canManageFolders }
      : {
          allowedHostIds: getResourceScopedIds(scopes, 'proxy:view'),
          allowedFolderIds: getFolderScopedIds(scopes, [
            'proxy:view',
            'proxy:edit',
            'proxy:create',
            'proxy:folders:manage',
          ]),
          includeAllFolders: canManageFolders,
        }
  );
  return c.json({
    data: redactGroupedPageTargets(
      redactGroupedRawProxyConfigForBrowserResponse(result, (host) => {
        const hostId = typeof host.id === 'string' ? host.id : undefined;
        return scopes.includes('proxy:raw:read') || (hostId ? scopes.includes(`proxy:raw:read:${hostId}`) : false);
      }),
      scopes
    ),
  });
});

// --- Static POST routes ---

// Create folder
folderRoutes.openapi({ ...createProxyFolderRoute, middleware: requireScopeBase('proxy:folders:manage') }, async (c) => {
  const folderService = container.resolve(FolderService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = CreateFolderSchema.parse(body);
  assertFolderManage(c.get('effectiveScopes') || [], 'proxy:folders:manage', input.parentId ?? null);
  const folder = await folderService.createFolder(input, user.id);
  return c.json({ data: folder }, 201);
});

// Move hosts to folder
folderRoutes.openapi({ ...moveProxyHostsRoute, middleware: requireScopeBase('proxy:folders:manage') }, async (c) => {
  const folderService = container.resolve(FolderService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = MoveHostsToFolderSchema.parse(body);
  const scopes = c.get('effectiveScopes') || [];
  await assertFolderManageForResources(folderService, scopes, 'proxy:folders:manage', input.hostIds, input.folderId);
  for (const hostId of input.hostIds) {
    if (!hasScope(scopes, `proxy:edit:${hostId}`)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:edit:${hostId}`);
    }
  }
  if (!hasScopeForCreation(scopes, 'proxy:edit', input.folderId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing route edit access for the move destination');
  }
  await folderService.moveHostsToFolder(input, user.id);
  return c.json({ success: true });
});

// --- Static PUT routes (before /:id) ---

// Reorder folders
folderRoutes.openapi(
  { ...reorderProxyFoldersRoute, middleware: requireScopeBase('proxy:folders:manage') },
  async (c) => {
    const folderService = container.resolve(FolderService);
    const body = await c.req.json();
    const input = ReorderFoldersSchema.parse(body);
    await assertFolderManageForFolders(
      folderService,
      c.get('effectiveScopes') || [],
      'proxy:folders:manage',
      input.items.map((item) => item.id)
    );
    await folderService.reorderFolders(input);
    return c.json({ success: true });
  }
);

// Reorder hosts within a folder
folderRoutes.openapi({ ...reorderProxyHostsRoute, middleware: requireScopeBase('proxy:folders:manage') }, async (c) => {
  const folderService = container.resolve(FolderService);
  const body = await c.req.json();
  const input = ReorderHostsSchema.parse(body);
  const scopes = c.get('effectiveScopes') || [];
  await assertFolderManageForResources(
    folderService,
    scopes,
    'proxy:folders:manage',
    input.items.map((item) => item.id),
    undefined
  );
  for (const item of input.items) {
    if (!hasScope(scopes, `proxy:edit:${item.id}`)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: proxy:edit:${item.id}`);
    }
  }
  await folderService.reorderHosts(input);
  return c.json({ success: true });
});

// --- Parameterised routes last ---

// Update folder / rename
folderRoutes.openapi({ ...updateProxyFolderRoute, middleware: requireScopeBase('proxy:folders:manage') }, async (c) => {
  const folderService = container.resolve(FolderService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const body = await c.req.json();
  const input = UpdateFolderSchema.parse(body);
  await assertFolderManageForFolder(folderService, c.get('effectiveScopes') || [], 'proxy:folders:manage', id);
  const folder = await folderService.updateFolder(id, input, user.id);
  return c.json({ data: folder });
});

// Move folder to new parent
folderRoutes.openapi({ ...moveProxyFolderRoute, middleware: requireScopeBase('proxy:folders:manage') }, async (c) => {
  const folderService = container.resolve(FolderService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const body = await c.req.json();
  const input = MoveFolderSchema.parse(body);
  const scopes = c.get('effectiveScopes') ?? [];
  const folder = await folderService.moveFolder(
    id,
    input,
    user.id,
    { scopes, editScope: 'proxy:edit' },
    { scopes, manageScope: 'proxy:folders:manage' }
  );
  return c.json({ data: folder });
});

// Delete folder
folderRoutes.openapi({ ...deleteProxyFolderRoute, middleware: requireScopeBase('proxy:folders:manage') }, async (c) => {
  const folderService = container.resolve(FolderService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  await assertFolderManageForFolder(folderService, c.get('effectiveScopes') || [], 'proxy:folders:manage', id);
  await folderService.deleteFolder(id, user.id);
  return c.body(null, 204);
});
