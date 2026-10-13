import { container } from '@/container.js';
import { hasScopeBase, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { parseAppListFilter } from '@/modules/apps/app-membership.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import {
  CreateLoggingEnvironmentSchema,
  CreateLoggingSchemaSchema,
  CreateLoggingTokenSchema,
  LoggingFacetsQuerySchema,
  LoggingSearchSchema,
  UpdateLoggingEnvironmentSchema,
  UpdateLoggingSchemaSchema,
} from '@/modules/logging/logging.schemas.js';
import {
  canAttachLoggingSchema,
  hasLoggingEnvironmentListAccess,
  hasLoggingHealthAccess,
  hasLoggingSchemaListAccess,
  visibleLoggingEnvironmentIds,
  visibleLoggingSchemaIds,
} from '@/modules/logging/logging-permissions.js';
import type { User } from '@/types.js';

export async function manageLoggingTool(user: User, args: Record<string, unknown>) {
  const { resource, operation } = normalizeLoggingOperationArgs(args);
  const payload = (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>;
  if (resource === 'health' && operation === 'get') {
    // Same rule as GET /logging/health: any logs view scope or housekeeping:view.
    if (!hasLoggingHealthAccess(user.scopes)) {
      throw new Error('PERMISSION_DENIED: Missing required scope: a logs view scope or housekeeping:view');
    }
    const { LoggingMaintenanceService } = await import('@/modules/logging/logging-maintenance.service.js');
    return container.resolve(LoggingMaintenanceService).getSnapshot();
  }
  await requireLoggingEnabled(operation);
  if (resource === 'environment') {
    const { LoggingEnvironmentService } = await import('@/modules/logging/logging-environment.service.js');
    const service = container.resolve(LoggingEnvironmentService);
    const id = String(args.environmentId ?? '');
    if (operation === 'list') {
      // Same as GET /logging/environments: an empty granted folder or a creator lists as empty.
      if (!hasLoggingEnvironmentListAccess(user.scopes)) {
        throw new Error('PERMISSION_DENIED: Missing required scope logs:environments:view');
      }
      return service.list({
        search: typeof args.search === 'string' ? args.search : undefined,
        allowedIds: visibleLoggingEnvironmentIds(user.scopes),
        ...parseAppListFilter(args),
      });
    }
    if (operation === 'get') {
      ensureLoggingScope(user, 'logs:environments:view', id);
      return service.get(id);
    }
    if (operation === 'create') {
      const input = CreateLoggingEnvironmentSchema.parse(payload);
      ensureLoggingCreationScope(user, 'logs:environments:create', input.folderId);
      ensureSchemaAttachable(user, input.schemaId);
      const { LoggingEnvironmentFolderService } = await import(
        '@/modules/logging/logging-environment-folders.service.js'
      );
      await container.resolve(LoggingEnvironmentFolderService).assertFolderExists(input.folderId);
      return service.create(input, user.id);
    }
    if (operation === 'update') {
      ensureLoggingScope(user, 'logs:environments:edit', id);
      const input = UpdateLoggingEnvironmentSchema.parse(payload);
      if (input.schemaId) ensureSchemaAttachable(user, input.schemaId, (await service.get(id)).schemaId);
      return service.update(id, input, user.id);
    }
    if (operation === 'delete') {
      ensureLoggingScope(user, 'logs:environments:delete', id);
      await service.delete(id, user.id);
      return { success: true };
    }
  }
  if (resource === 'schema') {
    const { LoggingSchemaService } = await import('@/modules/logging/logging-schema.service.js');
    const service = container.resolve(LoggingSchemaService);
    const id = String(args.schemaId ?? '');
    if (operation === 'list') {
      // Same as GET /logging/schemas: an empty granted folder or a creator lists as empty.
      if (!hasLoggingSchemaListAccess(user.scopes)) {
        throw new Error('PERMISSION_DENIED: Missing required scope logs:schemas:view');
      }
      const schemas = await service.list({ search: typeof args.search === 'string' ? args.search : undefined });
      const visible = visibleLoggingSchemaIds(user.scopes);
      if (!visible) return schemas;
      const allowedIds = new Set(visible);
      return schemas.filter((schema) => allowedIds.has(schema.id));
    }
    if (operation === 'get') {
      ensureLoggingScope(user, 'logs:schemas:view', id);
      return service.get(id);
    }
    if (operation === 'create') {
      const input = CreateLoggingSchemaSchema.parse(payload);
      ensureLoggingCreationScope(user, 'logs:schemas:create', input.folderId);
      const { LoggingSchemaFolderService } = await import('@/modules/logging/logging-schema-folders.service.js');
      await container.resolve(LoggingSchemaFolderService).assertFolderExists(input.folderId);
      return service.create(input, user.id);
    }
    if (operation === 'update') {
      ensureLoggingScope(user, 'logs:schemas:edit', id);
      return service.update(id, UpdateLoggingSchemaSchema.parse(payload), user.id);
    }
    if (operation === 'delete') {
      ensureLoggingScope(user, 'logs:schemas:delete', id);
      await service.delete(id, user.id);
      return { success: true };
    }
  }
  if (resource === 'token') {
    const { LoggingTokenService } = await import('@/modules/logging/logging-token.service.js');
    const service = container.resolve(LoggingTokenService);
    const environmentId = String(args.environmentId ?? '');
    ensureLoggingScope(
      user,
      operation === 'list' ? 'logs:tokens:view' : operation === 'create' ? 'logs:tokens:create' : 'logs:tokens:delete',
      environmentId
    );
    if (operation === 'list') return service.list(environmentId);
    if (operation === 'create') return service.create(environmentId, CreateLoggingTokenSchema.parse(payload), user.id);
    if (operation === 'delete') {
      await service.delete(environmentId, String(args.tokenId), user.id);
      return { success: true };
    }
  }
  if (resource === 'logs' && operation === 'search') {
    ensureLoggingScope(user, 'logs:read', String(args.environmentId));
    const { LoggingFeatureService } = await import('@/modules/logging/logging-feature.service.js');
    container.resolve(LoggingFeatureService).requireAvailableForStorage();
    const { LoggingSearchService } = await import('@/modules/logging/logging-search.service.js');
    return container
      .resolve(LoggingSearchService)
      .search(String(args.environmentId), LoggingSearchSchema.parse(payload) as any);
  }
  if (resource === 'facets' || operation === 'facets') {
    ensureLoggingScope(user, 'logs:read', String(args.environmentId));
    const { LoggingFeatureService } = await import('@/modules/logging/logging-feature.service.js');
    container.resolve(LoggingFeatureService).requireAvailableForStorage();
    const { LoggingSearchService } = await import('@/modules/logging/logging-search.service.js');
    return container
      .resolve(LoggingSearchService)
      .facets(String(args.environmentId), LoggingFacetsQuerySchema.parse(payload));
  }
  if (resource === 'metadata' || operation === 'metadata') {
    ensureLoggingScope(user, 'logs:read', String(args.environmentId));
    const { LoggingMetadataService } = await import('@/modules/logging/logging-metadata.service.js');
    return container.resolve(LoggingMetadataService).get(String(args.environmentId));
  }
  throw new Error(`Unsupported logging operation: ${resource}.${operation}`);
}

function normalizeLoggingOperationArgs(args: Record<string, unknown>) {
  let resource = String(args.resource ?? '').trim();
  let operation = String(args.operation ?? '').trim();

  if (operation.includes('.')) {
    const [operationResource, operationName] = operation.split('.', 2);
    resource ||= operationResource;
    operation = operationName;
  }

  return {
    resource: normalizeLoggingResource(resource),
    operation: normalizeLoggingOperation(operation),
  };
}

function normalizeLoggingResource(resource: string): string {
  const normalized = resource.trim().toLowerCase().replace(/-/g, '_');
  const aliases: Record<string, string> = {
    env: 'environment',
    envs: 'environment',
    environment: 'environment',
    environments: 'environment',
    logging_environment: 'environment',
    logging_environments: 'environment',
    schema: 'schema',
    schemas: 'schema',
    logging_schema: 'schema',
    logging_schemas: 'schema',
    token: 'token',
    tokens: 'token',
    ingest_token: 'token',
    ingest_tokens: 'token',
    log: 'logs',
    logs: 'logs',
    metadata: 'metadata',
    facet: 'facets',
    facets: 'facets',
    health: 'health',
  };
  return aliases[normalized] ?? normalized;
}

function normalizeLoggingOperation(operation: string): string {
  const normalized = operation.trim().toLowerCase().replace(/-/g, '_');
  const aliases: Record<string, string> = {
    read: 'get',
    show: 'get',
    create: 'create',
    add: 'create',
    edit: 'update',
    patch: 'update',
    remove: 'delete',
    destroy: 'delete',
    query: 'search',
    search: 'search',
    facet: 'facets',
    facets: 'facets',
    metadata: 'metadata',
  };
  return aliases[normalized] ?? normalized;
}

/**
 * Same gate as the logging routes' `requireLoggingEnabledMiddleware`: reading,
 * searching, and deleting existing environments and schemas keep working after the
 * license grace period; creating or changing them needs the current plan.
 */
async function requireLoggingEnabled(operation: string) {
  const policy = container.resolve(LicensePolicyService);
  if (operation === 'create' || operation === 'update') await policy.requireFeature('structured-logging');
  else await policy.requireFeatureForExistingRuntime('structured-logging');
  const { LoggingFeatureService } = await import('@/modules/logging/logging-feature.service.js');
  container.resolve(LoggingFeatureService).requireEnabled();
}

/** Same destination check as the environment and schema create routes. */
function ensureLoggingCreationScope(user: User, baseScope: string, folderId: string | null | undefined) {
  if (!hasScopeForCreation(user.scopes, baseScope, folderId)) {
    throw new Error(`PERMISSION_DENIED: Missing ${baseScope} permission for the selected destination`);
  }
}

/** Same as the environment routes: attaching a schema needs view access to it. */
function ensureSchemaAttachable(user: User, schemaId: string | null | undefined, currentSchemaId?: string | null) {
  if (!canAttachLoggingSchema(user.scopes, schemaId, currentSchemaId)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope logs:schemas:view:${schemaId}`);
  }
}

function ensureLoggingScope(user: User, baseScope: string, resourceId?: string) {
  if (resourceId ? hasScopeForResource(user.scopes, baseScope, resourceId) : hasScopeBase(user.scopes, baseScope)) {
    return;
  }
  throw new Error(`PERMISSION_DENIED: Missing required scope ${resourceId ? `${baseScope}:${resourceId}` : baseScope}`);
}
