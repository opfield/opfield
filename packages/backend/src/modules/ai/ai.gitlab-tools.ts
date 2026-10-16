import { container } from '@/container.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { User } from '@/types.js';
import type { AISandboxService } from './ai.sandbox.service.js';

export const GITLAB_TOOL_NAMES = new Set([
  'gitlab_list_connectors',
  'gitlab_list_projects',
  'gitlab_get_project',
  'gitlab_search_projects',
  'gitlab_sync_connector',
  'gitlab_add_connector_projects',
  'gitlab_list_repository_tree',
  'gitlab_read_file',
  'gitlab_commit_files',
  'gitlab_create_branch',
  'gitlab_delete_branch',
  'gitlab_lint_ci_config',
  'gitlab_update_ci_config',
  'gitlab_list_pipelines',
  'gitlab_get_pipeline',
  'gitlab_get_pipeline_jobs',
  'gitlab_get_job_log',
  'gitlab_list_project_variables',
  'gitlab_set_project_variable',
  'gitlab_delete_project_variable',
  'gitlab_list_project_webhooks',
  'gitlab_create_or_update_project_webhook',
  'gitlab_delete_project_webhook',
  'gitlab_list_registry_repositories',
  'gitlab_update_project_settings',
  'gitlab_create_deploy_token',
  'gitlab_clone_repository_to_sandbox',
]);

export interface GitLabToolContext {
  integrationsService?: IntegrationsService;
  sandboxService?: AISandboxService;
  conversationId?: string;
}

export async function executeGitLabTool(
  context: GitLabToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const service = context.integrationsService ?? container.resolve(IntegrationsService);
  const a = args as Record<string, unknown>;
  const connectorId = stringArg(a.connectorId);
  const project = stringArg(a.project);

  switch (toolName) {
    case 'gitlab_list_connectors':
      return service.listGitLabConnectorsForTool(user);
    case 'gitlab_list_projects':
    case 'gitlab_search_projects':
      return service.listGitLabProjectsForTool(user, {
        connectorId,
        search: optionalString(a.search),
        limit: optionalNumber(a.limit),
      });
    case 'gitlab_get_project':
      return service.getGitLabProjectForTool(user, { connectorId, project });
    case 'gitlab_sync_connector':
      return service.gitLabSyncConnectorForTool(user, { connectorId });
    case 'gitlab_add_connector_projects':
      return service.gitLabAddConnectorProjects(user, {
        connectorId,
        projects: Array.isArray(a.projects) ? a.projects.map(String) : [],
        syncAfter: optionalBoolean(a.syncAfter),
      });
    case 'gitlab_list_repository_tree':
      return service.gitLabListRepositoryTree(user, {
        connectorId,
        project,
        path: optionalString(a.path),
        ref: optionalString(a.ref),
        limit: optionalNumber(a.limit),
      });
    case 'gitlab_read_file':
      return service.gitLabReadFile(user, {
        connectorId,
        project,
        path: stringArg(a.path),
        ref: optionalString(a.ref),
        offset: optionalNumber(a.offset),
        length: optionalNumber(a.length),
      });
    case 'gitlab_create_branch':
      return service.gitLabCreateBranch(user, {
        connectorId,
        project,
        branch: stringArg(a.branch),
        ref: optionalString(a.ref),
      });
    case 'gitlab_delete_branch':
      return service.gitLabDeleteBranch(user, { connectorId, project, branch: stringArg(a.branch) });
    case 'gitlab_commit_files':
      return service.gitLabCommitFiles(user, {
        connectorId,
        project,
        branch: stringArg(a.branch),
        startBranch: optionalString(a.startBranch),
        commitMessage: stringArg(a.commitMessage),
        changes: Array.isArray(a.changes)
          ? a.changes.map((change) => {
              const item = isRecord(change) ? change : {};
              return {
                action:
                  item.action === 'create' || item.action === 'delete' || item.action === 'move'
                    ? item.action
                    : 'update',
                path: stringArg(item.path),
                previousPath: optionalString(item.previousPath),
                content: optionalString(item.content),
                encoding: item.encoding === 'base64' ? 'base64' : 'text',
              };
            })
          : [],
      });
    case 'gitlab_lint_ci_config':
      return service.gitLabLintCiConfig(user, { connectorId, project, content: stringArg(a.content) });
    case 'gitlab_update_ci_config':
      return service.gitLabUpdateCiConfig(user, {
        connectorId,
        project,
        branch: stringArg(a.branch),
        startBranch: optionalString(a.startBranch),
        content: stringArg(a.content),
        commitMessage: stringArg(a.commitMessage),
      });
    case 'gitlab_list_pipelines':
      return service.gitLabListPipelines(user, {
        connectorId,
        project,
        ref: optionalString(a.ref),
        limit: optionalNumber(a.limit),
      });
    case 'gitlab_get_pipeline':
      return service.gitLabGetPipeline(user, { connectorId, project, pipelineId: numberArg(a.pipelineId) });
    case 'gitlab_get_pipeline_jobs':
      return service.gitLabGetPipelineJobs(user, {
        connectorId,
        project,
        pipelineId: numberArg(a.pipelineId),
        limit: optionalNumber(a.limit),
      });
    case 'gitlab_get_job_log':
      return service.gitLabGetJobLog(user, {
        connectorId,
        project,
        jobId: numberArg(a.jobId),
        limitBytes: optionalNumber(a.limitBytes),
      });
    case 'gitlab_list_project_variables':
      return service.gitLabListProjectVariables(user, { connectorId, project });
    case 'gitlab_set_project_variable':
      return service.gitLabSetProjectVariable(user, {
        connectorId,
        project,
        key: stringArg(a.key),
        value: stringArg(a.value),
        variableType: a.variableType === 'file' ? 'file' : 'env_var',
        protected: optionalBoolean(a.protected),
        masked: optionalBoolean(a.masked),
        raw: optionalBoolean(a.raw),
        environmentScope: optionalString(a.environmentScope),
        description: optionalString(a.description),
      });
    case 'gitlab_delete_project_variable':
      return service.gitLabDeleteProjectVariable(user, {
        connectorId,
        project,
        key: stringArg(a.key),
        environmentScope: optionalString(a.environmentScope),
      });
    case 'gitlab_list_project_webhooks':
      return service.gitLabListProjectWebhooks(user, { connectorId, project });
    case 'gitlab_create_or_update_project_webhook':
      return service.gitLabCreateOrUpdateProjectWebhook(user, {
        connectorId,
        project,
        id: optionalNumber(a.id),
        url: stringArg(a.url),
        token: optionalString(a.token),
        pushEvents: optionalBoolean(a.pushEvents),
        mergeRequestsEvents: optionalBoolean(a.mergeRequestsEvents),
        tagPushEvents: optionalBoolean(a.tagPushEvents),
        jobEvents: optionalBoolean(a.jobEvents),
        pipelineEvents: optionalBoolean(a.pipelineEvents),
        enableSslVerification: optionalBoolean(a.enableSslVerification),
      });
    case 'gitlab_delete_project_webhook':
      return service.gitLabDeleteProjectWebhook(user, { connectorId, project, hookId: numberArg(a.hookId) });
    case 'gitlab_list_registry_repositories':
      return service.gitLabListRegistryRepositories(user, { connectorId, project });
    case 'gitlab_update_project_settings':
      return service.gitLabUpdateProjectSettings(user, {
        connectorId,
        project,
        containerRegistryAccessLevel: gitLabRegistryAccessLevelArg(a.containerRegistryAccessLevel),
      });
    case 'gitlab_create_deploy_token':
      return service.gitLabCreateDeployToken(user, {
        connectorId,
        project,
        name: stringArg(a.name),
        scopes: Array.isArray(a.scopes) ? a.scopes.map(String) : [],
        expiresAt: optionalString(a.expiresAt),
        registryUrl: optionalString(a.registryUrl),
      });
    case 'gitlab_clone_repository_to_sandbox': {
      if (!context.sandboxService) throw new Error('Sandbox runner is not configured');
      return service.gitLabCloneRepositoryToSandbox(
        user,
        {
          connectorId,
          project,
          ref: optionalString(a.ref),
          targetPath: optionalString(a.targetPath),
          ttlSeconds: optionalNumber(a.ttlSeconds),
        },
        context.sandboxService,
        context.conversationId
      );
    }
    default:
      throw new Error(`Unsupported GitLab tool: ${toolName}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(value: unknown): string {
  return String(value ?? '').trim();
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function numberArg(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function gitLabRegistryAccessLevelArg(value: unknown): 'enabled' | 'private' | 'disabled' {
  if (value === 'enabled' || value === 'private' || value === 'disabled') return value;
  throw new Error('containerRegistryAccessLevel must be one of: enabled, private, disabled');
}
