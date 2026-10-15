import { container } from '@/container.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { UpdateAuthProvisioningSettingsSchema } from '@/modules/admin/admin.schemas.js';
import { updateOpfieldSettings } from '@/modules/admin/opfield-settings.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import {
  CreateManagedDatabaseBindingSchema,
  CreateManagedDatabaseSchema,
  DeleteManagedDatabaseBindingSchema,
  ManagedDatabaseListQuerySchema,
  UpdateManagedDatabaseSchema,
} from '@/modules/databases/databases.schemas.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import {
  DockerMigrationCreateInputSchema,
  DockerMigrationListQuerySchema,
  DockerMigrationPreflightInputSchema,
  DockerMigrationResolveInputSchema,
} from '@/modules/docker/docker-migration.schemas.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { AdditionalRouteService } from '@/modules/proxy/additional-route.service.js';
import {
  CreateAdditionalRouteSchema,
  UpdateAdditionalRouteSchema,
} from '@/modules/proxy/additional-route.validation.js';
import { redactAdditionalRouteForScopes } from '@/modules/proxy/page-target-visibility.js';
import { CreateAdditionalSecureLinkSchema, parseRetargetAdditionalSecureLink } from '@/modules/proxy/proxy.schemas.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { User } from '@/types.js';
import {
  MANAGED_DATABASE_AVAILABILITY_CHANGE_OPERATIONS,
  MANAGED_DATABASE_AVAILABILITY_OPERATIONS,
  manageManagedDatabaseAvailability,
} from './ai.database-availability-tools.js';
import {
  ensureManagedDatabaseScopes,
  MANAGED_DATABASE_ACCESS_OPERATIONS,
  manageManagedDatabaseAccess,
} from './ai.database-tools.js';
import { managePages, uploadPagesArtifact } from './ai.pages-tools.js';
import {
  ensureAnyScopeBase,
  ensureResourceScope,
  ensureScope,
  optionalNumber,
  optionalString,
  requiredString,
  requiredValue,
} from './ai.resource-setup-args.js';

export const RESOURCE_SETUP_TOOL_NAMES = new Set([
  'upload_pages_artifact',
  'manage_pages',
  'manage_additional_route',
  'manage_additional_secure_link',
  'manage_managed_database',
  'manage_docker_migration',
  'manage_logging_backend',
]);

export async function executeResourceSetupTool(user: User, toolName: string, args: Record<string, unknown>) {
  if (toolName === 'upload_pages_artifact') return uploadPagesArtifact(user, args);
  if (toolName === 'manage_pages') return managePages(user, args);
  if (toolName === 'manage_additional_route') return manageAdditionalRoute(user, args);
  if (toolName === 'manage_additional_secure_link') return manageAdditionalSecureLink(user, args);
  if (toolName === 'manage_managed_database') return manageManagedDatabase(user, args);
  if (toolName === 'manage_docker_migration') return manageDockerMigration(user, args);
  if (toolName === 'manage_logging_backend') return manageLoggingBackend(user, args);
  throw new Error(`Unsupported resource setup tool: ${toolName}`);
}

/** Managed database operations that change configuration or create resources. */
// Disabling an extension keeps working after the license grace period, like a delete.
const MANAGED_DATABASE_CHANGE_OPERATIONS = new Set([
  'create',
  'update',
  'create_binding',
  'enable_extension',
  'update_extension',
]);

async function manageAdditionalRoute(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const routeId = requiredString(args.routeId);
  const service = container.resolve(AdditionalRouteService);
  // Same view the Additional Route endpoints return: advanced config and Pages fields follow the caller scopes.
  const visible = (row: unknown) => redactAdditionalRouteForScopes(row as Record<string, unknown>, user.scopes);
  if (operation === 'list') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return { data: (await service.list(routeId)).map(visible) };
  }
  const additionalRouteId = operation === 'create' ? undefined : requiredString(args.additionalRouteId);
  if (operation === 'get') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return visible(await service.present(await service.get(routeId, requiredValue(additionalRouteId))));
  }
  ensureResourceScope(user, 'proxy:edit', routeId);
  if (operation === 'create') {
    const input = CreateAdditionalRouteSchema.parse(args);
    if (input.advancedConfig !== undefined) ensureResourceScope(user, 'proxy:advanced', routeId);
    await requirePagesForAdditionalTarget(input);
    return visible(await service.present(await service.create(routeId, input, user.id, user.scopes)));
  }
  if (operation === 'update') {
    const input = UpdateAdditionalRouteSchema.parse(args);
    await requirePagesForAdditionalTarget(input);
    if (input.advancedConfig !== undefined) ensureResourceScope(user, 'proxy:advanced', routeId);
    return visible(
      await service.present(
        await service.update(routeId, requiredValue(additionalRouteId), input, user.id, user.scopes)
      )
    );
  }
  if (operation === 'retry') {
    const existing = await service.get(routeId, requiredValue(additionalRouteId));
    if (existing.targetKind === 'pages')
      await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime('pages');
    return visible(await service.present(await service.retry(routeId, existing.id, user.id, user.scopes)));
  }
  if (operation === 'delete') {
    await service.remove(routeId, requiredValue(additionalRouteId), user.id);
    return { success: true };
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Additional Route operation: ${operation}`);
}

async function manageAdditionalSecureLink(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const routeId = requiredString(args.routeId);
  const service = container.resolve(ProxyService);
  if (operation === 'list') {
    ensureResourceScope(user, 'proxy:view', routeId);
    return { data: await service.listAdditionalSecureLinks(routeId) };
  }
  ensureResourceScope(user, 'proxy:edit', routeId);
  if (operation === 'create') {
    return service.createAdditionalSecureLink(
      routeId,
      CreateAdditionalSecureLinkSchema.parse({
        name: args.name,
        upstreamKind: args.upstreamKind,
        managedStorageId: args.managedStorageId,
        forwardScheme: args.forwardScheme,
        dockerNodeId: args.dockerNodeId,
        dockerContainerName: args.dockerContainerName,
        dockerComposeProjectId: args.dockerComposeProjectId,
        dockerComposeServiceName: args.dockerComposeServiceName,
        dockerDeploymentId: args.dockerDeploymentId,
        dockerContainerPort: args.dockerContainerPort,
      }),
      user.id,
      user.scopes
    );
  }
  const bindingId = requiredString(args.bindingId);
  if (operation === 'retry') return service.retryAdditionalSecureLink(routeId, bindingId, user.id, user.scopes);
  if (operation === 'retarget') {
    // POST /proxy-hosts/{id}/additional-secure-links/{bindingId}/retarget
    return service.retargetAdditionalSecureLink(
      routeId,
      bindingId,
      parseRetargetAdditionalSecureLink({
        upstreamKind: args.upstreamKind,
        managedStorageId: args.managedStorageId,
        forwardScheme: args.forwardScheme,
        dockerNodeId: args.dockerNodeId,
        dockerContainerName: args.dockerContainerName,
        dockerComposeProjectId: args.dockerComposeProjectId,
        dockerComposeServiceName: args.dockerComposeServiceName,
        dockerDeploymentId: args.dockerDeploymentId,
        dockerContainerPort: args.dockerContainerPort,
      }),
      user.id,
      user.scopes
    );
  }
  if (operation === 'delete') {
    await service.deleteAdditionalSecureLink(routeId, bindingId, user.id);
    return { success: true };
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Additional Secure Link operation: ${operation}`);
}

async function requirePagesForAdditionalTarget(input: {
  targetKind?: string;
  pageProjectId?: string | null;
  pageTagId?: string | null;
}): Promise<void> {
  if (input.targetKind === 'pages' || input.pageProjectId != null || input.pageTagId != null) {
    await container.resolve(LicensePolicyService).requireFeature('pages');
    await container.resolve(PageProfileService).requireEnabled();
  }
}

/** The extension name of manage_managed_database extension operations (the `{name}` rule of the REST routes). */
function postgresExtensionArgument(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'extension must be an extension name from the extensions list');
  }
  return name;
}

async function manageManagedDatabase(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  // LICENSE ENFORCEMENT: same classes as the /api/databases routes. Existing managed
  // databases stay viewable, operable, and deletable after the license grace period.
  const policy = container.resolve(LicensePolicyService);
  if (
    MANAGED_DATABASE_CHANGE_OPERATIONS.has(operation) ||
    MANAGED_DATABASE_AVAILABILITY_CHANGE_OPERATIONS.has(operation)
  ) {
    await policy.requireFeature('external-database-connections');
  } else await policy.requireFeatureForExistingRuntime('external-database-connections');
  if (MANAGED_DATABASE_ACCESS_OPERATIONS.has(operation)) return manageManagedDatabaseAccess(user, operation, args);
  // Availability: the service checks multi-node availability once per operation, as for the REST routes.
  if (MANAGED_DATABASE_AVAILABILITY_OPERATIONS.has(operation)) {
    return manageManagedDatabaseAvailability(user, operation, args);
  }
  const service = container.resolve(ManagedDatabaseService);
  const bindings = container.resolve(ManagedDatabaseBindingService);

  if (operation === 'catalog') {
    // Same as GET /databases/managed/catalog: creators read it before create.
    ensureAnyScopeBase(user, ['databases:view', 'databases:create']);
    return service.listCatalog();
  }
  if (operation === 'list') {
    // Same visibility as GET /databases/managed: scoped grants name the canonical connection;
    // an empty granted folder or a creator with nothing visible yet lists as empty.
    ensureAnyScopeBase(user, ['databases:view', 'databases:create']);
    const rows = await service.list(
      ManagedDatabaseListQuerySchema.parse({
        nodeId: args.nodeId,
        type: args.type,
        excludeAppMembers: args.excludeAppMembers,
        appId: args.appId,
      })
    );
    if (hasScope(user.scopes, 'databases:view')) return rows;
    const allowedIds = new Set(getResourceScopedIds(user.scopes, 'databases:view'));
    return rows.filter((row) => allowedIds.has(row.databaseConnectionId ?? ''));
  }
  if (operation === 'create') {
    const input = CreateManagedDatabaseSchema.parse(args);
    // A database created on several servers needs the grant on each of them (as POST /databases/managed).
    for (const nodeId of new Set([input.nodeId, ...(input.availability?.nodeIds ?? [])])) {
      if (!hasScopeForCreation(user.scopes, 'databases:create', input.folderId, nodeId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing databases:create permission for the selected destination');
      }
    }
    await container.resolve(DatabaseFolderService).assertFolderExists(input.folderId);
    return service.create(input, user.id);
  }

  const databaseId = requiredString(args.databaseId);
  if (operation === 'get') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    return service.get(databaseId);
  }
  if (operation === 'update') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.update(databaseId, UpdateManagedDatabaseSchema.parse(args), user.id);
  }
  if (operation === 'retry') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.retryProvisioning(databaseId, user.id);
  }
  if (operation === 'restart') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.restart(databaseId, user.id);
  }
  if (operation === 'pause') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.pause(databaseId, user.id);
  }
  if (operation === 'unpause') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.unpause(databaseId, user.id);
  }
  if (operation === 'move_to_valkey') {
    // Same as POST /databases/managed/{id}/move-to-valkey.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.moveToValkey(databaseId, user.id, {
      acceptPendingStreamLoss: args.acceptPendingStreamLoss === true,
    });
  }
  if (operation === 'move_to_valkey_check') {
    // Same as GET /databases/managed/{id}/move-to-valkey.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.moveToValkeyPreflight(databaseId);
  }
  if (operation === 'rotate_certificate') {
    // Same as POST /databases/managed/{id}/rotate-certificate: reloaded in place unless allowRestart.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    return service.rotateCertificate(databaseId, user.id, { allowRestart: args.allowRestart === true });
  }
  if (operation === 'extensions') {
    // Same as GET /databases/managed/{id}/extensions.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    return service.listPostgresExtensions(databaseId);
  }
  if (operation === 'enable_extension' || operation === 'disable_extension' || operation === 'update_extension') {
    // Same as POST, DELETE and POST .../update on /databases/managed/{id}/extensions/{name}.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:edit');
    const extension = postgresExtensionArgument(args.extension);
    if (operation === 'enable_extension') return service.enablePostgresExtension(databaseId, extension, user.id);
    if (operation === 'disable_extension') return service.disablePostgresExtension(databaseId, extension, user.id);
    return service.updatePostgresExtension(databaseId, extension, user.id);
  }
  if (operation === 'certificate_status') {
    // Same as GET /databases/managed/{id}/certificate.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    return service.getCertificateStatus(databaseId);
  }
  if (operation === 'delete') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:delete');
    return service.delete(databaseId, user.id);
  }
  if (operation === 'list_bindings') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:view');
    return bindings.list(databaseId);
  }
  if (operation === 'create_binding') {
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:bind');
    const input = CreateManagedDatabaseBindingSchema.parse(args);
    await bindings.assertTargetAccess(user.scopes, input);
    return bindings.create(databaseId, input, user.id);
  }
  if (operation === 'delete_binding') {
    // Same as DELETE /databases/managed/{id}/bindings/{bindingId}: unbinding needs bind, not edit or delete.
    await ensureManagedDatabaseScopes(user, databaseId, 'databases:bind');
    const bindingId = requiredString(args.bindingId);
    const options = DeleteManagedDatabaseBindingSchema.parse(args);
    await bindings.assertTargetAccess(user.scopes, {
      ...(await bindings.getTarget(databaseId, bindingId)),
      targetEnvironment: options.targetEnvironment,
    });
    return bindings.delete(databaseId, bindingId, user.id, options);
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported managed database operation: ${operation}`);
}

/**
 * Mirrors the Docker migration routes: preflight and start are authorized by the
 * service against source, target and dependencies (docker:containers:migrate);
 * list and get need docker:tasks, cancel, retry_cleanup and resolve need
 * docker:tasks:manage, and the service narrows every one to the migration nodes.
 */
async function manageDockerMigration(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const service = container.resolve(DockerMigrationService);
  if (operation === 'preflight') {
    ensureAnyScopeBase(user, ['docker:containers:migrate']);
    return service.preflightMigration(DockerMigrationPreflightInputSchema.parse(args), user.scopes);
  }
  if (operation === 'start') {
    ensureAnyScopeBase(user, ['docker:containers:migrate']);
    return service.create(DockerMigrationCreateInputSchema.parse(args), user.id, user.scopes);
  }
  if (operation === 'list') {
    ensureAnyScopeBase(user, ['docker:tasks']);
    return service.list(
      user.scopes,
      DockerMigrationListQuerySchema.parse({ status: args.status, nodeId: args.nodeId, limit: args.limit })
    );
  }
  const migrationId = requiredString(args.migrationId);
  if (operation === 'get') {
    ensureAnyScopeBase(user, ['docker:tasks']);
    return service.get(migrationId, user.scopes);
  }
  if (operation === 'cancel') {
    ensureAnyScopeBase(user, ['docker:tasks:manage']);
    return service.cancel(migrationId, user.id, user.scopes);
  }
  if (operation === 'retry_cleanup') {
    ensureAnyScopeBase(user, ['docker:tasks:manage']);
    return service.retryCleanup(migrationId, user.id, user.scopes);
  }
  if (operation === 'resolve') {
    ensureAnyScopeBase(user, ['docker:tasks:manage']);
    return service.resolve(
      migrationId,
      DockerMigrationResolveInputSchema.parse({ authoritativeSide: args.authoritativeSide }),
      user.id,
      user.scopes
    );
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Docker migration operation: ${operation}`);
}

async function manageLoggingBackend(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  if (operation === 'get') {
    ensureScope(user, 'settings:opfield:view');
    return container.resolve(LoggingSettingsService).getPublicConfig();
  }
  ensureScope(user, 'settings:opfield:edit');
  const logging =
    operation === 'enable_local'
      ? { mode: 'local' }
      : operation === 'disable'
        ? { mode: 'disabled' }
        : operation === 'configure_external'
          ? {
              mode: 'external',
              url: requiredString(args.url),
              username: requiredString(args.username),
              password: requiredString(args.password),
              database: optionalString(args.database),
              table: optionalString(args.table),
              requestTimeoutMs: optionalNumber(args.requestTimeoutMs),
            }
          : null;
  if (!logging) {
    throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported logging backend operation: ${operation}`);
  }
  // Same path as PUT /admin/auth-settings { logging }: schema, audit record, and settings change event.
  const input = UpdateAuthProvisioningSettingsSchema.parse({ logging });
  return (await updateOpfieldSettings({ user, scopes: user.scopes }, input)).logging;
}
