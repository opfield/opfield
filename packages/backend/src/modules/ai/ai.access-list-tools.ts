import { container } from '@/container.js';
import { CreateAccessListSchema, UpdateAccessListSchema } from '@/modules/access-lists/access-list.schemas.js';
import type { AccessListService } from '@/modules/access-lists/access-list.service.js';
import { AccessListFolderService } from '@/modules/access-lists/access-list-folders.service.js';
import type { User } from '@/types.js';
import { agentPage, agentPageLimit, allowedResourceIdsForScopes } from './ai.service-helpers.js';

export const ACCESS_LIST_TOOL_NAMES = new Set([
  'list_access_lists',
  'create_access_list',
  'delete_access_list',
  'manage_access_list',
]);

export interface AccessListToolContext {
  accessListService: AccessListService;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

export async function executeAccessListTool(
  context: AccessListToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'list_access_lists':
      return context.accessListService.list(
        {
          search: a.search,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
          folderId: typeof a.folderId === 'string' && a.folderId ? a.folderId : undefined,
        },
        { allowedIds: allowedResourceIdsForScopes(user.scopes, 'acl:view') }
      );
    case 'create_access_list': {
      // The same fields as POST /api/access-lists; the schema drops the tool's own arguments.
      const input = CreateAccessListSchema.parse({ ...args, folderId: a.folderId ?? undefined });
      // Mirrors POST /access-lists: broad acl:create, or acl:create on the destination folder.
      await container.resolve(AccessListFolderService).assertCreateFolder(user.scopes, input.folderId);
      return context.accessListService.create(input, user.id);
    }
    case 'delete_access_list':
      await context.accessListService.delete(a.accessListId, user.id);
      return { success: true };
    case 'manage_access_list':
      if (a.operation === 'get') {
        context.ensureToolScopeForResource(user, 'acl:view', String(a.accessListId));
        return context.accessListService.get(a.accessListId);
      }
      if (a.operation === 'update') {
        context.ensureToolScopeForResource(user, 'acl:edit', String(a.accessListId));
        return context.accessListService.update(a.accessListId, UpdateAccessListSchema.parse(args), user.id);
      }
      throw new Error(`Unsupported access list operation: ${String(a.operation)}`);
    default:
      throw new Error(`Unsupported access list tool: ${toolName}`);
  }
}
