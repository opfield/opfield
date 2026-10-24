import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { databaseToolRuntime } from '@/modules/databases/database-tool-runtime.js';
import type { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import type { User } from '@/types.js';

export const DATABASE_TOOL_NAMES = new Set([
  'list_databases',
  'get_database_connection',
  'query_postgres_read',
  'execute_postgres_sql',
  'browse_redis_keys',
  'get_redis_key',
  'set_redis_key',
  'execute_redis_command',
  'manage_database_connection',
  'manage_postgres_data',
  'manage_redis_data',
]);

export interface DatabaseToolContext {
  databaseService: DatabaseConnectionService;
}

export async function executeDatabaseTool(
  context: DatabaseToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!container.isRegistered(TOKENS.CommercialEdition)) return commercialModuleUnavailable();
  return container
    .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
    .executeDatabaseTool(
      context,
      user,
      toolName,
      await withDatabaseIdForSlug(context, toolName, args),
      databaseToolRuntime
    );
}

/**
 * get_database_connection by slug, like GET /databases/by-slug/{slug}: the slug names the connection, and the
 * tool then reads it by id with the usual databases:view check on that id.
 */
async function withDatabaseIdForSlug(context: DatabaseToolContext, toolName: string, args: Record<string, unknown>) {
  if (toolName !== 'get_database_connection' || args.databaseId || typeof args.slug !== 'string' || !args.slug) {
    return args;
  }
  const { slug, ...rest } = args;
  return { ...rest, databaseId: (await context.databaseService.getBySlug(slug as string)).id };
}

/** manage_managed_database operations for credentials, logs and binding runtime. */
export const MANAGED_DATABASE_ACCESS_OPERATIONS: ReadonlySet<string> = new Set([
  'reveal_credentials',
  'rotate_credentials',
  'logs',
  'get_binding_runtime',
  'reveal_binding_credentials',
]);

/**
 * Mirrors `requireManagedDatabaseScopes` in the database routes. Scoped
 * database grants are issued for the canonical database connection, so a
 * managed instance id is resolved to it before a resource-scoped check.
 */
export async function ensureManagedDatabaseScopes(
  user: User,
  managedDatabaseId: string,
  ...scopeBases: string[]
): Promise<void> {
  const missingBases = scopeBases.filter((scopeBase) => !hasScope(user.scopes, scopeBase));
  if (missingBases.length === 0) return;
  const canonicalDatabaseId = await container
    .resolve(ManagedDatabaseService)
    .getCanonicalScopeResourceId(managedDatabaseId);
  const missingResources = missingBases.filter(
    (scopeBase) => !hasScope(user.scopes, `${scopeBase}:${canonicalDatabaseId}`)
  );
  if (missingResources.length > 0) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${missingResources.join(', ')}`);
  }
}

/**
 * Same checks and service calls as the managed database credential, log and
 * binding runtime routes. Revealing or rotating a credential is refused while
 * impersonating by the AI impersonation policy before this runs.
 */
export async function manageManagedDatabaseAccess(
  user: User,
  operation: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const databaseId = requiredString(args.databaseId, 'databaseId');
  const service = container.resolve(ManagedDatabaseService);

  if (operation === 'reveal_credentials') {
    // POST /databases/managed/{id}/reveal-credentials
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:credentials:reveal');
    return service.revealCredentials(databaseId);
  }
  if (operation === 'rotate_credentials') {
    // POST /databases/managed/{id}/rotate-direct-credentials
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit', 'databases:credentials:reveal');
    return service.rotateDirectAccessCredentials(databaseId, user.id);
  }
  if (operation === 'logs') {
    // GET /databases/{id}/logs is keyed by the canonical database connection.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    const databaseConnectionId = await service.getCanonicalScopeResourceId(databaseId);
    return service.getLogs(databaseConnectionId, {
      tailLines: logTailLines(args.tailLines),
      follow: false,
      timestamps: args.timestamps !== false,
    });
  }

  const bindingId = requiredString(args.bindingId, 'bindingId');
  const bindings = container.resolve(ManagedDatabaseBindingService);
  if (operation === 'get_binding_runtime') {
    // GET /databases/managed/{id}/bindings/{bindingId}/runtime
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    await bindings.assertTargetViewAccess(user.scopes, await bindings.getTarget(databaseId, bindingId));
    return bindings.getRuntime(databaseId, bindingId);
  }
  if (operation === 'reveal_binding_credentials') {
    // POST /databases/managed/{id}/bindings/{bindingId}/reveal-credentials
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:credentials:reveal');
    // Revealing changes nothing on the workload: no rollout scope, like the route.
    await bindings.assertTargetAccess(user.scopes, await bindings.getTarget(databaseId, bindingId), {
      rollout: false,
    });
    return bindings.revealCredentials(databaseId, bindingId);
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported managed database operation: ${operation}`);
}

/** Same bounds as the `tail` query of GET /databases/{id}/logs. */
function logTailLines(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) && value !== 0 ? value : 500;
  return Math.min(Math.max(Math.trunc(requested), 1), 5_000);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', `${name} is required`);
}
