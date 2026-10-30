import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateAccessListSchema,
  MoveAccessListIpRuleSchema,
  UpdateAccessListSchema,
} from '@/modules/access-lists/access-list.schemas.js';
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

/** The create_access_list arguments of 2.12: any of them makes the call a legacy create (access-list-legacy.ts). */
const LEGACY_CREATE_ARGUMENTS = ['allowIps', 'denyIps', 'ipRules', 'basicAuthEnabled', 'basicAuthUsers'] as const;

function stringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AppError(400, 'VALIDATION_ERROR', 'allowIps and denyIps are arrays of IP addresses or CIDR ranges');
  }
  return value;
}

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
      // The same fields as POST /api/access-lists, and the arguments of agents written before sign-in based lists:
      // allowIps and denyIps go after ipRules (allows, then denies), and basicAuthUsers turn basic authentication on.
      const legacy = LEGACY_CREATE_ARGUMENTS.some((name) => a[name] !== undefined);
      const { allowIps, denyIps, ...rest } = args;
      const input = CreateAccessListSchema.parse({
        ...rest,
        ...(legacy
          ? {
              ipRules: [
                ...(Array.isArray(a.ipRules) ? a.ipRules : []),
                ...stringList(allowIps).map((value) => ({ value, type: 'allow' })),
                ...stringList(denyIps).map((value) => ({ value, type: 'deny' })),
              ],
              basicAuthEnabled: a.basicAuthEnabled ?? !!a.basicAuthUsers?.length,
              basicAuthUsers: a.basicAuthUsers ?? [],
            }
          : {}),
        folderId: a.folderId ?? undefined,
      });
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
      if (a.operation === 'move_rule') {
        context.ensureToolScopeForResource(user, 'acl:edit', String(a.accessListId));
        return context.accessListService.moveIpRule(a.accessListId, MoveAccessListIpRuleSchema.parse(args), user.id);
      }
      throw new Error(`Unsupported access list operation: ${String(a.operation)}`);
    default:
      throw new Error(`Unsupported access list tool: ${toolName}`);
  }
}
