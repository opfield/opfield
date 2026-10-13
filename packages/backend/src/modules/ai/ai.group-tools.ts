import type { AuditService } from '@/modules/audit/audit.service.js';
import { CreateGroupSchema, UpdateGroupSchema } from '@/modules/groups/group.schemas.js';
import type { GroupService } from '@/modules/groups/group.service.js';
import {
  createGroupForActor,
  deleteGroupForActor,
  listVisibleGroups,
  updateGroupForActor,
} from '@/modules/groups/group-actions.js';
import type { User } from '@/types.js';

export const GROUP_TOOL_NAMES = new Set(['list_groups', 'create_group', 'update_group', 'delete_group']);

export interface GroupToolContext {
  groupService: GroupService;
  auditService?: AuditService;
}

/** Mirrors /api/admin/groups through the shared group actions (scopes, grants, audit). */
export async function executeGroupTool(
  context: GroupToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;
  const actor = { id: user.id, scopes: user.scopes, accountScopes: user.accountScopes };
  const services = { groupService: context.groupService, auditService: context.auditService };

  switch (toolName) {
    case 'list_groups':
      return listVisibleGroups(user.scopes, services);
    case 'create_group': {
      const input = CreateGroupSchema.parse(
        definedFields({
          name: a.name,
          description: a.description,
          scopes: a.scopes,
          parentId: a.parentId,
          folderId: a.folderId,
          require2fa: a.require2fa,
        })
      );
      return createGroupForActor(actor, input, services);
    }
    case 'update_group': {
      const input = UpdateGroupSchema.parse(
        definedFields({
          name: a.name,
          description: a.description,
          scopes: a.scopes,
          parentId: a.parentId,
          require2fa: a.require2fa,
        })
      );
      return updateGroupForActor(actor, String(a.groupId ?? ''), input, services);
    }
    case 'delete_group':
      await deleteGroupForActor(actor, String(a.groupId ?? ''), services);
      return { success: true };
    default:
      throw new Error(`Unsupported group tool: ${toolName}`);
  }
}

/** Drop omitted arguments so the parsed body matches what the HTTP route receives. */
function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
