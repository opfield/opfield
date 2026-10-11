import { container } from '@/container.js';
import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { getResourceScopedIds, hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  DockerBuildCreateSchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerSourceBindingUpsertSchema,
  PagesBuildDiscoverySchema,
} from '@/modules/docker/docker-build.schemas.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import {
  CreatePageDeploymentSchema,
  FinalizePageUploadSchema,
  PageDeploymentListQuerySchema,
} from '@/modules/pages/deployments/page-deployment.schemas.js';
import {
  PageDeploymentService,
  type PageDeployPrincipal,
} from '@/modules/pages/deployments/page-deployment.service.js';
import { resolvePageDeploymentExpiry } from '@/modules/pages/deployments/page-deployment-expiry.js';
import {
  CreatePageProjectSchema,
  MigratePageProjectSchema,
  PageProjectListQuerySchema,
  UpdatePageProjectSchema,
} from '@/modules/pages/page-project.schemas.js';
import { PageProjectService } from '@/modules/pages/page-project.service.js';
import {
  canAccessPageProject,
  canAttachPageAccessList,
  visiblePageProjectIds,
} from '@/modules/pages/page-project-access.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import { UpdatePageProfileSchema } from '@/modules/pages/profile/page-profile.schemas.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import { PageRetentionService } from '@/modules/pages/retention/page-retention.service.js';
import {
  ResetPageRuntimeConfigSchema,
  SavePageRuntimeConfigSchema,
} from '@/modules/pages/runtime-config/page-runtime-config.schemas.js';
import { PageRuntimeConfigService } from '@/modules/pages/runtime-config/page-runtime-config.service.js';
import { PagePublicationService } from '@/modules/pages/tags/page-publication.service.js';
import { MovePageTagSchema, PageTagParamSchema } from '@/modules/pages/tags/page-tag.schemas.js';
import { PageTagService } from '@/modules/pages/tags/page-tag.service.js';
import { CreatePageDeployTokenSchema } from '@/modules/pages/tokens/page-deploy-token.schemas.js';
import { PageDeployTokenService } from '@/modules/pages/tokens/page-deploy-token.service.js';
import { createPageUploadLink, publishStoredDeployment } from '@/modules/pages/uploads/page-upload-link.js';
import type { User } from '@/types.js';
import {
  ensureAnyScopeBase,
  ensureResourceScope,
  ensureScope,
  optionalString,
  requiredBoolean,
  requiredEnum,
  requiredNumber,
  requiredString,
  requiredValue,
} from './ai.resource-setup-args.js';

/**
 * A base64 chunk plus its JSON-RPC envelope must stay under the default 2 MiB
 * API request body limit. Larger artifacts go through a one-time upload link.
 */
const MCP_PAGE_UPLOAD_CHUNK_MAX_BYTES = 1024 * 1024;
const USE_UPLOAD_LINK = 'to send a file from disk, use operation "link" and stream it with curl';

export async function uploadPagesArtifact(user: User, args: Record<string, unknown>) {
  const operation = requiredEnum(args.operation, ['link', 'begin', 'chunk', 'finalize', 'cancel'] as const);
  await container.resolve(LicensePolicyService).requireFeature('pages');
  await container.resolve(PageProfileService).requireEnabled();

  const deployments = container.resolve(PageDeploymentService);
  const principal: PageDeployPrincipal = { kind: 'user', userId: user.id, scopes: user.scopes };
  if (operation === 'link') {
    ensureResourceScope(user, 'pages:deploy', requiredString(args.projectId));
    return createPageUploadLink(user, args);
  }
  if (operation === 'begin') {
    const input = CreatePageDeploymentSchema.parse(args);
    ensureResourceScope(user, 'pages:deploy', input.projectId);
    return deployments.create(input, principal);
  }

  const uploadId = requiredString(args.uploadId);
  if (operation === 'cancel') return deployments.cancelUpload(uploadId, principal);
  if (operation === 'chunk') {
    const offset = requiredNumber(args.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', 'Upload offset must be a non-negative integer');
    }
    return deployments.appendChunk(
      uploadId,
      offset,
      decodeMcpPageUploadChunk(requiredString(args.contentBase64)),
      principal
    );
  }

  const expiresAt = resolvePageDeploymentExpiry(FinalizePageUploadSchema.parse(args));
  const stored = await deployments.finalize(uploadId, principal, expiresAt === undefined ? undefined : { expiresAt });
  return publishStoredDeployment(stored.deployment.id);
}

function decodeMcpPageUploadChunk(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AppError(
      400,
      'PAGES_UPLOAD_CHUNK_INVALID',
      `Upload chunk must use canonical base64 encoding; ${USE_UPLOAD_LINK}`
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0) {
    throw new AppError(400, 'PAGES_UPLOAD_CHUNK_EMPTY', 'Upload chunk cannot be empty');
  }
  if (bytes.byteLength > MCP_PAGE_UPLOAD_CHUNK_MAX_BYTES) {
    throw new AppError(
      413,
      'PAGES_UPLOAD_CHUNK_TOO_LARGE',
      `MCP upload chunks cannot exceed 1 MiB decoded; send smaller ordered chunks, or ${USE_UPLOAD_LINK}`
    );
  }
  if (bytes.toString('base64') !== value) {
    throw new AppError(
      400,
      'PAGES_UPLOAD_CHUNK_INVALID',
      `Upload chunk must use canonical base64 encoding; ${USE_UPLOAD_LINK}`
    );
  }
  return bytes;
}

/** Pages operations that read or delete existing resources; they keep working after the grace period. */
const PAGES_EXISTING_OPERATIONS = new Set([
  'profile_get',
  'profile_options',
  'project_list',
  'project_get',
  'project_get_by_slug',
  'project_placement_options',
  'project_delete',
  'source_get',
  'source_repositories',
  'source_remove',
  'source_secret_list',
  'source_secret_delete',
  'deployment_list',
  'deployment_get',
  'deployment_links',
  'deployment_delete',
  'tag_list',
  'tag_delete',
  'token_list',
  'token_revoke',
  'config_list',
  'config_reset_tag',
]);

const PAGES_READ_OPERATIONS = new Set([
  'project_list',
  'project_get',
  'project_get_by_slug',
  'project_placement_options',
  'source_repositories',
  'deployment_list',
  'deployment_get',
  'deployment_links',
  'tag_list',
  'token_list',
  'config_list',
  'source_get',
  'source_secret_list',
]);

export async function managePages(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation);
  const policy = container.resolve(LicensePolicyService);
  if (PAGES_EXISTING_OPERATIONS.has(operation)) await policy.requireFeatureForExistingRuntime('pages');
  else await policy.requireFeature('pages');

  const profile = container.resolve(PageProfileService);
  if (operation === 'profile_get') {
    ensureScope(user, 'pages:settings:view');
    return profile.get();
  }
  if (operation === 'profile_options') {
    ensureScope(user, 'pages:settings:view');
    return profile.getOptions();
  }
  if (operation === 'profile_configure') {
    ensureScope(user, 'pages:settings:edit');
    const input = UpdatePageProfileSchema.parse(args);
    return input.enabled ? profile.configure(input, user.id) : profile.disable(user.id);
  }
  if (operation === 'profile_disable') {
    ensureScope(user, 'pages:settings:edit');
    return profile.disable(user.id);
  }

  if (!PAGES_READ_OPERATIONS.has(operation)) await profile.requireEnabled();

  const projects = container.resolve(PageProjectService);
  if (operation === 'project_list') {
    ensureAnyScopeBase(user, ['pages:view', 'pages:create']);
    return projects.list(PageProjectListQuerySchema.parse(args), { allowedIds: visiblePageProjectIds(user.scopes) });
  }
  if (operation === 'project_create') {
    const input = CreatePageProjectSchema.parse(args);
    if (!hasScopeForCreation(user.scopes, 'pages:create', input.folderId, input.nodeId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing pages:create permission for the selected destination');
    }
    await container.resolve(PageProjectFolderService).assertFolderExists(input.folderId);
    return projects.create(input, user.id);
  }
  if (operation === 'project_placement_options') {
    // GET /projects/placement-options: nodes a Project can be created on or moved to.
    ensureAnyScopeBase(user, ['pages:create', 'pages:edit']);
    const canUseAnyPlacement =
      hasScope(user.scopes, 'pages:create') ||
      hasScope(user.scopes, 'pages:edit') ||
      getFolderScopedIds(user.scopes, ['pages:create']).length > 0;
    // folderId: the destination folder (an app environment lists only the nodes it allows).
    const folderId = optionalString(args.folderId);
    return canUseAnyPlacement
      ? projects.placementOptions(folderId ? { folderId } : undefined)
      : projects.placementOptions({
          allowedNodeIds: getResourceScopedIds(user.scopes, 'pages:create'),
          ...(folderId ? { folderId } : {}),
        });
  }
  if (operation === 'project_get_by_slug') {
    const project = await projects.getBySlug(requiredString(args.slug));
    if (!canAccessPageProject(user.scopes, 'pages:view', project.id)) {
      throw new AppError(403, 'PAGE_PROJECT_FORBIDDEN', 'Missing pages:view for this Project');
    }
    return project;
  }

  const projectId = requiredString(args.projectId);
  if (operation === 'project_get') {
    ensureResourceScope(user, 'pages:view', projectId);
    return projects.get(projectId);
  }
  if (operation === 'project_update') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const input = UpdatePageProjectSchema.parse(args);
    // Like PUT /pages/:id: attaching an access list needs acl:view on that list.
    if (input.accessListId && !canAttachPageAccessList(user.scopes, input.accessListId)) {
      const current = await projects.get(projectId);
      if (current.accessListId !== input.accessListId) {
        throw new AppError(403, 'FORBIDDEN', `Missing required scope: acl:view:${input.accessListId}`);
      }
    }
    return projects.update(projectId, input, user.id);
  }
  if (operation === 'project_rotate_preview_hash') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return projects.rotatePreviewHash(projectId, user.id);
  }
  if (operation === 'project_migrate') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const input = MigratePageProjectSchema.parse(args);
    // Like POST /projects/:id/migrate: moving a Project onto a node needs pages:create for that node.
    const project = await projects.get(projectId);
    if (!hasScopeForCreation(user.scopes, 'pages:create', project.folderId, input.targetNodeId)) {
      throw new AppError(403, 'PAGE_PROJECT_FORBIDDEN', 'Missing pages:create permission for the target node');
    }
    return projects.migrate(projectId, input, user.id);
  }
  if (operation === 'project_delete') {
    ensureResourceScope(user, 'pages:delete', projectId);
    await projects.delete(projectId, user.id);
    return { success: true };
  }

  const sourceResult = await manageProjectSource(user, operation, projectId, args);
  if (sourceResult !== NOT_HANDLED) return sourceResult;

  const deployments = () => container.resolve(PageDeploymentService);
  if (operation === 'deployment_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return deployments().list(projectId, PageDeploymentListQuerySchema.parse(args));
  }
  const deploymentId = optionalString(args.deploymentId);
  if (operation === 'deployment_get') {
    ensureResourceScope(user, 'pages:view', projectId);
    return deployments().getForProject(projectId, requiredValue(deploymentId));
  }
  if (operation === 'deployment_links') {
    ensureResourceScope(user, 'pages:view', projectId);
    const deployment = await deployments().getForProject(projectId, requiredValue(deploymentId));
    return deployments().publicationLinks(deployment.id);
  }
  if (operation === 'deployment_pin') {
    ensureResourceScope(user, 'pages:deployments:manage', projectId);
    return container
      .resolve(PageRetentionService)
      .setPinned(projectId, requiredValue(deploymentId), requiredBoolean(args.pinned), user.id);
  }
  if (operation === 'deployment_delete') {
    ensureResourceScope(user, 'pages:deployments:manage', projectId);
    await container.resolve(PageRetentionService).deleteDeployment(projectId, requiredValue(deploymentId), user.id);
    return { success: true };
  }

  if (operation === 'tag_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return container.resolve(PageTagService).list(projectId);
  }
  const tag = optionalString(args.tag);
  if (operation === 'tag_move') {
    ensureResourceScope(user, 'pages:tags:manage', projectId);
    const parsed = PageTagParamSchema.parse({ projectId, tag: requiredValue(tag) });
    const move = MovePageTagSchema.parse(args);
    return container.resolve(PagePublicationService).moveUserTag(projectId, parsed.tag, move.deploymentId, user.id);
  }
  if (operation === 'tag_delete') {
    ensureResourceScope(user, 'pages:tags:manage', projectId);
    const parsed = PageTagParamSchema.parse({ projectId, tag: requiredValue(tag) });
    await container.resolve(PageTagService).delete(projectId, parsed.tag, user.id);
    return { success: true };
  }

  const tokens = container.resolve(PageDeployTokenService);
  if (operation === 'token_list') {
    ensureResourceScope(user, 'pages:tokens:manage', projectId);
    return tokens.list(projectId);
  }
  if (operation === 'token_create') {
    ensureResourceScope(user, 'pages:tokens:manage', projectId);
    return tokens.create(projectId, CreatePageDeployTokenSchema.parse(args), user.id);
  }
  if (operation === 'token_revoke') {
    ensureResourceScope(user, 'pages:tokens:manage', projectId);
    await tokens.revoke(projectId, requiredString(args.tokenId), user.id);
    return { success: true };
  }

  const configs = container.resolve(PageRuntimeConfigService);
  if (operation === 'config_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return configs.list(projectId);
  }
  if (operation === 'config_save_default') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return configs.saveDefault(projectId, SavePageRuntimeConfigSchema.parse(args), user.id);
  }
  const tagId = requiredString(args.tagId);
  if (operation === 'config_save_tag') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return configs.saveTag(projectId, tagId, SavePageRuntimeConfigSchema.parse(args), user.id);
  }
  if (operation === 'config_reset_tag') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const input = ResetPageRuntimeConfigSchema.parse(args);
    return configs.resetTag(projectId, tagId, input.expectedGeneration, user.id);
  }
  throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported Pages operation: ${operation}`);
}

const NOT_HANDLED = Symbol('not-handled');

async function manageProjectSource(
  user: User,
  operation: string,
  projectId: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const sourceTarget = { kind: 'pages_project' as const, pageProjectId: projectId };
  const sources = () => container.resolve(DockerSourceService);
  if (operation === 'source_get') {
    ensureResourceScope(user, 'pages:view', projectId);
    return sources().get(sourceTarget);
  }
  if (operation === 'source_repositories') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return container
      .resolve(IntegrationsService)
      .findDockerBuildSourceRepositories(user, requiredString(args.sourceConnectorId), optionalString(args.search));
  }
  if (operation === 'source_discover') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return sources().discoverPagesBuild(
      PagesBuildDiscoverySchema.parse({
        connectorId: args.sourceConnectorId,
        projectId: args.repositoryProjectId,
        branch: args.branch,
        applicationRoot: args.applicationRoot ?? '.',
      }),
      user
    );
  }
  if (operation === 'source_upsert') {
    ensureResourceScope(user, 'pages:edit', projectId);
    ensureResourceScope(user, 'pages:deploy', projectId);
    return sources().upsert(
      DockerSourceBindingUpsertSchema.parse({
        target: sourceTarget,
        connectorId: args.sourceConnectorId,
        projectId: args.repositoryProjectId,
        branch: args.branch,
        applicationRoot: args.applicationRoot ?? '.',
        packageManager: args.packageManager,
        packageManagerVersion: args.packageManagerVersion,
        nodeVersion: args.nodeVersion,
        buildScript: args.buildScript,
        artifactDirectory: args.artifactDirectory,
        publishTag: args.publishTag,
        autoBuild: args.autoBuild ?? true,
        autoDeploy: args.autoDeploy ?? true,
        buildArgs: args.buildArgs ?? {},
        buildSecretNames: args.buildSecretNames ?? [],
        policy: args.policy ?? {},
      }),
      user
    );
  }
  if (operation === 'source_remove') {
    ensureResourceScope(user, 'pages:edit', projectId);
    return { success: true, removed: await sources().remove(sourceTarget, user.id) };
  }
  if (operation === 'source_build') {
    ensureResourceScope(user, 'pages:deploy', projectId);
    return sources().createBuild(
      sourceTarget,
      DockerBuildCreateSchema.parse({ commitSha: args.commitSha, force: args.force ?? false }),
      user
    );
  }
  if (operation === 'source_sync') {
    ensureResourceScope(user, 'pages:deploy', projectId);
    return sources().sync(sourceTarget, user);
  }
  if (operation === 'source_secret_list') {
    ensureResourceScope(user, 'pages:view', projectId);
    return sources().listBuildSecrets(sourceTarget);
  }
  if (operation === 'source_secret_upsert') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const name = DockerBuildSecretNameSchema.parse(args.secretName);
    const { value } = DockerBuildSecretValueSchema.parse({ value: args.secretValue });
    return sources().upsertBuildSecret(sourceTarget, name, value, user.id);
  }
  if (operation === 'source_secret_delete') {
    ensureResourceScope(user, 'pages:edit', projectId);
    const name = DockerBuildSecretNameSchema.parse(args.secretName);
    return { success: true, removed: await sources().deleteBuildSecret(sourceTarget, name, user.id) };
  }
  return NOT_HANDLED;
}
