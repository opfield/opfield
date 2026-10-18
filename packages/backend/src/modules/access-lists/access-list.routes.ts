import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import { authMiddleware, requireScopeBase, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { accessListFolderRouteDocs } from '@/modules/resource-folders/resource-folder.docs.js';
import { registerResourceFolderRoutes } from '@/modules/resource-folders/resource-folder.routes.js';
import type { AppEnv } from '@/types.js';
import {
  createAccessListRoute,
  deleteAccessListRoute,
  getAccessListRoute,
  listAccessListsRoute,
  moveAccessListIpRuleRoute,
  updateAccessListRoute,
} from './access-list.docs.js';
import {
  AccessListQuerySchema,
  assertAccessListFields,
  CreateAccessListSchema,
  MoveAccessListIpRuleSchema,
  UpdateAccessListSchema,
} from './access-list.schemas.js';
import { AccessListService } from './access-list.service.js';
import { AccessListFolderService } from './access-list-folders.service.js';

export const accessListRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

accessListRoutes.use('*', authMiddleware);

// Folders of access lists, registered before the `/{id}` routes. acl:view, acl:edit and acl:delete take a list
// (`<scope>:<id>`) or a folder (`<scope>:folder/<id>`); acl:create takes a destination folder. Placing a list needs
// acl:edit on it and on the destination.
registerResourceFolderRoutes(accessListRoutes, {
  docs: accessListFolderRouteDocs,
  service: () => container.resolve(AccessListFolderService),
  manageScope: 'acl:folders:manage',
  viewScope: 'acl:view',
  listScopes: ['acl:create'],
  folderGrantScopes: ['acl:view', 'acl:create', 'acl:edit', 'acl:delete'],
  placementScope: 'acl:edit',
});

// List access lists
accessListRoutes.openapi({ ...listAccessListsRoute, middleware: requireScopeBase('acl:view') }, async (c) => {
  const accessListService = container.resolve(AccessListService);
  const rawQuery = c.req.query();
  const query = AccessListQuerySchema.parse(rawQuery);
  const scopes = c.get('effectiveScopes') || [];
  const result = await accessListService.list(
    query,
    hasScope(scopes, 'acl:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'acl:view') }
  );
  return c.json(result);
});

// Get access list detail
accessListRoutes.openapi(
  { ...getAccessListRoute, middleware: requireScopeForResource('acl:view', 'id') },
  async (c) => {
    const accessListService = container.resolve(AccessListService);
    const id = c.req.param('id')!;
    const accessList = await accessListService.get(id);
    return c.json({ data: accessList });
  }
);

// Create access list
accessListRoutes.openapi({ ...createAccessListRoute, middleware: requireScopeBase('acl:create') }, async (c) => {
  const accessListService = container.resolve(AccessListService);
  const user = c.get('user')!;
  const body = await c.req.json();
  assertAccessListFields(body, { create: true });
  const input = CreateAccessListSchema.parse(body);
  // Broad acl:create creates anywhere; `acl:create:folder/<id>` in that folder only.
  await container.resolve(AccessListFolderService).assertCreateFolder(c.get('effectiveScopes') ?? [], input.folderId);
  const accessList = await accessListService.create(input, user.id);
  return c.json({ data: accessList }, 201);
});

// Update access list
accessListRoutes.openapi(
  { ...updateAccessListRoute, middleware: requireScopeForResource('acl:edit', 'id') },
  async (c) => {
    const accessListService = container.resolve(AccessListService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const body = await c.req.json();
    assertAccessListFields(body);
    const input = UpdateAccessListSchema.parse(body);
    const accessList = await accessListService.update(id, input, user.id);
    return c.json({ data: accessList });
  }
);

// Move one IP rule (first match wins, so order changes who gets in)
accessListRoutes.openapi(
  { ...moveAccessListIpRuleRoute, middleware: requireScopeForResource('acl:edit', 'id') },
  async (c) => {
    const accessListService = container.resolve(AccessListService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const input = MoveAccessListIpRuleSchema.parse(await c.req.json());
    const accessList = await accessListService.moveIpRule(id, input, user.id);
    return c.json({ data: accessList });
  }
);

// Delete access list
accessListRoutes.openapi(
  { ...deleteAccessListRoute, middleware: requireScopeForResource('acl:delete', 'id') },
  async (c) => {
    const accessListService = container.resolve(AccessListService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    await accessListService.delete(id, user.id);
    return c.body(null, 204);
  }
);
