import { container } from '@/container.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  ManagedAvailabilityAddMemberSchema,
  ManagedAvailabilityDisableSchema,
  ManagedAvailabilityEnableSchema,
  ManagedAvailabilityEventsQuerySchema,
  ManagedAvailabilityMakePrimarySchema,
  ManagedAvailabilityPreflightSchema,
  ManagedAvailabilitySettingsSchema,
  ManagedDatabaseAvailabilityCreatePreflightSchema,
} from '@/modules/databases/databases.schemas.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import type { User } from '@/types.js';
import { ensureManagedDatabaseScopes } from './ai.database-tools.js';
import { requiredString } from './ai.resource-setup-args.js';

/**
 * manage_managed_database operations of availability (one database on several servers). They mirror the
 * /api/databases/managed/{id}/availability routes: the same scopes (databases:view to read, databases:edit to change)
 * and the same service, which checks the multi-node availability license once per operation.
 */
export const MANAGED_DATABASE_AVAILABILITY_OPERATIONS: ReadonlySet<string> = new Set([
  'availability',
  'availability_preflight',
  'availability_events',
  'make_available',
  'update_availability',
  'add_member',
  'remove_member',
  'make_primary',
  'rebuild_member',
  'disable_availability',
]);

/** Operations that create or change a set: the database feature needs the current plan for them. */
export const MANAGED_DATABASE_AVAILABILITY_CHANGE_OPERATIONS: ReadonlySet<string> = new Set([
  'availability_preflight',
  'make_available',
  'update_availability',
  'add_member',
]);

/** The `availability` argument of the tool (an object), or {} when it is missing. */
function availabilityArgs(args: Record<string, unknown>): Record<string, unknown> {
  const value = args.availability;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function manageManagedDatabaseAvailability(
  user: User,
  operation: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const service = container.resolve(ManagedDatabaseService);
  const input = availabilityArgs(args);
  // A preflight answers for the servers and witnesses; enable-only settings are not part of it.
  const { priorityMode: _priorityMode, ...preflightInput } = input;
  if (operation === 'availability_preflight' && args.databaseId === undefined) {
    // POST /databases/managed/availability/preflight: the create form, before the database exists.
    const parsed = ManagedDatabaseAvailabilityCreatePreflightSchema.parse({
      ...preflightInput,
      type: args.type,
      version: args.version,
      nodeIds: [...new Set([requiredString(args.nodeId), ...((input.nodeIds as string[] | undefined) ?? [])])],
      ...(args.tlsEnabled !== undefined ? { tlsEnabled: args.tlsEnabled } : {}),
      ...(args.storageSizeGb !== undefined ? { storageSizeGb: args.storageSizeGb } : {}),
      ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
    });
    for (const nodeId of parsed.nodeIds) {
      if (!hasScopeForCreation(user.scopes, 'databases:create', parsed.folderId ?? null, nodeId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing databases:create permission for a selected node');
      }
    }
    return service.availabilityPreflightForCreate(parsed);
  }
  const databaseId = requiredString(args.databaseId);
  if (operation === 'availability' || operation === 'availability_events') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    if (operation === 'availability') return service.availabilityView(databaseId);
    return service.availabilityEvents(
      databaseId,
      ManagedAvailabilityEventsQuerySchema.parse({ page: args.page, limit: args.limit })
    );
  }
  await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
  switch (operation) {
    case 'availability_preflight':
      return service.availabilityPreflight(databaseId, ManagedAvailabilityPreflightSchema.parse(preflightInput));
    case 'make_available':
      return service.enableAvailability(databaseId, ManagedAvailabilityEnableSchema.parse(input), user.id);
    case 'update_availability':
      return service.updateAvailability(databaseId, ManagedAvailabilitySettingsSchema.parse(input), user.id);
    case 'add_member':
      return service.addAvailabilityMember(
        databaseId,
        ManagedAvailabilityAddMemberSchema.parse({ nodeId: args.nodeId, priority: args.priority }),
        user.id
      );
    case 'remove_member':
      return service.removeAvailabilityMember(databaseId, requiredString(args.memberId), user.id);
    case 'rebuild_member':
      return service.rebuildAvailabilityMember(databaseId, requiredString(args.memberId), user.id);
    case 'make_primary':
      // Without acceptDataLoss a switch that can lose writes is refused with the estimate (AVAILABILITY_LOSSY_PROMOTION).
      return service.makeAvailabilityPrimary(
        databaseId,
        ManagedAvailabilityMakePrimarySchema.parse({ memberId: args.memberId, acceptDataLoss: args.acceptDataLoss }),
        user.id
      );
    case 'disable_availability':
      return service.disableAvailability(
        databaseId,
        user.id,
        ManagedAvailabilityDisableSchema.parse({
          keepMemberId: args.keepMemberId,
          ...(args.force !== undefined ? { force: args.force } : {}),
        })
      );
    default:
      throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported managed database operation: ${operation}`);
  }
}
