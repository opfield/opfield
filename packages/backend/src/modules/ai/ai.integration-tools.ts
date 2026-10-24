import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import {
  ScopeTargetResolveQuerySchema,
  ScopeTargetSearchQuerySchema,
  scopeTargetRateLimiter,
} from '@/modules/integrations/git-scope-targets.js';
import {
  assertConnectorOperationAccess,
  type ConnectorScopeTarget,
  gitConnectorVisibility,
  holdsConnectorOperationScope,
} from '@/modules/integrations/integration-permissions.js';
import {
  CloudflareConnectorCreateSchema,
  CloudflareConnectorPreviewTestSchema,
  CloudflareConnectorRotateTokenSchema,
  CloudflareConnectorUpdateSchema,
  ExternalSshConnectorUpdateSchema,
  ExternalSshHostKeySchema,
  GitConnectorCreateSchema,
  GitConnectorPreviewTestSchema,
  GitConnectorUpdateSchema,
  GitHubConnectorCreateSchema,
  GitHubConnectorPreviewTestSchema,
  GitHubOAuthStartSchema,
  GitLabAllowlistPreviewSearchSchema,
  GitLabAllowlistSearchQuerySchema,
  GitLabConnectorCreateSchema,
  GitLabConnectorPreviewTestSchema,
  GitLabConnectorRotateTokenSchema,
  GitLabConnectorUpdateSchema,
} from '@/modules/integrations/integrations.schemas.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { User } from '@/types.js';

const CONNECTOR_PROVIDERS = ['gitlab', 'github', 'git', 'cloudflare', 'ssh'] as const;
type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

interface ConnectorRouteAccess {
  operation: string;
  requiredScope: string | readonly string[];
  /** Lists accept a Git grant on any connector, group/owner or project/repository and filter the result. */
  scopeTarget?: ConnectorScopeTarget;
}

const GIT_CONNECTOR_PROVIDERS = new Set<ConnectorProvider>(['gitlab', 'github', 'git']);

/**
 * Mirrors the connector list middleware in integrations.routes.ts. Git and SSH
 * routes name the operation after the HTTP method (`connector.get`).
 */
const CONNECTOR_LIST_ACCESS: Record<ConnectorProvider, ConnectorRouteAccess> = {
  gitlab: {
    operation: 'connector.list',
    requiredScope: ['integrations:gitlab:view', 'integrations:gitlab:manage'],
    scopeTarget: 'within-connector',
  },
  cloudflare: {
    operation: 'connector.list',
    requiredScope: ['integrations:cloudflare:view', 'integrations:cloudflare:manage'],
  },
  github: {
    operation: 'connector.get',
    requiredScope: ['integrations:github:view', 'integrations:github:manage'],
    scopeTarget: 'within-connector',
  },
  git: {
    operation: 'connector.get',
    requiredScope: ['integrations:git:view', 'integrations:git:manage'],
    scopeTarget: 'within-connector',
  },
  ssh: { operation: 'connector.get', requiredScope: ['integrations:ssh:view', 'integrations:ssh:manage'] },
};

/**
 * Mirrors the connector sync middleware in integrations.routes.ts
 * (`POST /:provider/connectors/:id/sync`). Hosting connectors are left out:
 * their sync route is session-only. Per-user Git credential routes are
 * session-only too, and no sync below reads or writes them.
 */
const CONNECTOR_SYNC_ACCESS: Record<ConnectorProvider, ConnectorRouteAccess> = {
  gitlab: { operation: 'connector.sync', requiredScope: 'integrations:gitlab:manage' },
  cloudflare: {
    operation: 'connector.sync',
    requiredScope: ['integrations:cloudflare:sync', 'integrations:cloudflare:manage'],
  },
  github: { operation: 'connector.post', requiredScope: 'integrations:github:manage' },
  git: { operation: 'connector.post', requiredScope: 'integrations:git:manage' },
  // The SSH "sync" route authenticates to the host with the stored credential; it has no sync scope.
  ssh: { operation: 'connector.post', requiredScope: 'integrations:ssh:manage' },
};

export const INTEGRATION_TOOL_NAMES = new Set([
  'github_list_connectors',
  'git_list_connectors',
  'github_list_repositories',
  'github_list_repository_tree',
  'github_read_repository_file',
  'github_list_branches',
  'github_list_workflow_runs',
  'github_list_actions_variables',
  'github_list_actions_secrets',
  'github_upsert_repository_file',
  'github_create_branch',
  'github_delete_branch',
  'github_upsert_actions_variable',
  'github_upsert_actions_secret',
  'git_list_remote_refs',
  'git_list_repository_tree',
  'git_read_repository_file',
  'git_upsert_repository_file',
  'git_create_branch',
  'git_delete_branch',
  'create_github_token_connector',
  'create_git_connector',
  'create_gitlab_connector',
  'create_cloudflare_connector',
  'list_integration_connectors',
  'sync_integration_connector',
  'manage_integration_connector',
]);

export async function executeIntegrationTool(user: User, toolName: string, args: Record<string, unknown>) {
  const service = container.resolve(IntegrationsService);
  const a = args as Record<string, unknown>;
  if (toolName === 'list_integration_connectors') return listIntegrationConnectors(service, user, a);
  if (toolName === 'sync_integration_connector') return syncIntegrationConnector(service, user, a);
  if (toolName === 'manage_integration_connector') return manageIntegrationConnector(service, user, a);
  if (toolName === 'github_list_connectors')
    return visibleGitConnectors(user, 'github', await service.listGitConnectors('github', true));
  if (toolName === 'git_list_connectors')
    return visibleGitConnectors(user, 'git', await service.listGitConnectors('git', true));
  if (toolName === 'github_list_repositories') {
    return service.githubListRepositories(user, { connectorId: requiredString(a.connectorId) });
  }
  if (toolName === 'github_list_repository_tree') {
    return service.githubListRepositoryTree(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: optionalString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'github_read_repository_file') {
    return service.githubReadRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'github_list_branches') {
    return service.githubListBranches(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'github_list_workflow_runs') {
    return service.githubListWorkflowRuns(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      branch: optionalString(a.branch),
      status: optionalString(a.status),
    });
  }
  if (toolName === 'github_list_actions_variables') {
    return service.githubListActionsVariables(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'github_list_actions_secrets') {
    return service.githubListActionsSecrets(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'github_upsert_repository_file') {
    return service.githubUpsertRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      branch: requiredString(a.branch),
      message: requiredString(a.message),
      content: typeof a.content === 'string' ? a.content : requiredString(a.content),
    });
  }
  if (toolName === 'github_create_branch') {
    return service.githubCreateBranch(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      branch: requiredString(a.branch),
      fromRef: optionalString(a.fromRef),
    });
  }
  if (toolName === 'github_delete_branch') {
    return service.githubDeleteBranch(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      branch: requiredString(a.branch),
    });
  }
  if (toolName === 'git_create_branch') {
    return service.gitCreateBranch(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      branch: requiredString(a.branch),
      fromRef: optionalString(a.fromRef),
    });
  }
  if (toolName === 'git_delete_branch') {
    return service.gitDeleteBranch(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      branch: requiredString(a.branch),
    });
  }
  if (toolName === 'github_upsert_actions_variable') {
    return service.githubUpsertActionsVariable(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      name: requiredString(a.name),
      value: typeof a.value === 'string' ? a.value : requiredString(a.value),
    });
  }
  if (toolName === 'github_upsert_actions_secret') {
    return service.githubUpsertActionsSecret(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      name: requiredString(a.name),
      value: typeof a.value === 'string' ? a.value : requiredString(a.value),
    });
  }
  if (toolName === 'git_list_remote_refs') {
    return service.gitListRemoteRefs(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'git_list_repository_tree') {
    return service.gitListRepositoryTree(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: optionalString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'git_read_repository_file') {
    return service.gitReadRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'git_upsert_repository_file') {
    return service.gitUpsertRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      branch: requiredString(a.branch),
      message: requiredString(a.message),
      content: typeof a.content === 'string' ? a.content : requiredString(a.content),
    });
  }
  if (toolName === 'create_gitlab_connector') {
    // The assistant keeps its all_visible default when no allowlist is chosen; the route defaults to selected.
    return service.createGitLabConnector(
      GitLabConnectorCreateSchema.parse({
        name: a.name,
        baseUrl: a.baseUrl,
        enabled: a.enabled,
        token: a.token,
        allowlistMode: a.allowlistMode ?? (Array.isArray(a.allowlistEntries) ? 'selected' : 'all_visible'),
        settings: a.settings,
        allowlistEntries: a.allowlistEntries,
      }),
      user.id
    );
  }
  if (toolName === 'create_cloudflare_connector') {
    return service.createCloudflareConnector(
      CloudflareConnectorCreateSchema.parse({ name: a.name, enabled: a.enabled, token: a.token, settings: a.settings }),
      user.id
    );
  }
  if (toolName === 'create_github_token_connector') {
    return service.createGitConnector(
      'github',
      GitHubConnectorCreateSchema.parse({ name: a.name, baseUrl: a.baseUrl, enabled: a.enabled, token: a.token }),
      user.id
    );
  }
  if (toolName === 'create_git_connector') {
    const repositoryUrls = Array.isArray(a.repositoryUrls)
      ? a.repositoryUrls.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const input = GitConnectorCreateSchema.parse({
      name: a.name,
      baseUrl: a.baseUrl,
      enabled: a.enabled,
      username: optionalString(a.username),
      token: a.token,
      allowlistEntries: [
        ...(Array.isArray(a.allowlistEntries) ? a.allowlistEntries : []),
        ...repositoryUrls.map((url) => ({
          entryType: 'project',
          remoteId: url,
          fullPath: url,
          name: url,
          webUrl: url,
        })),
      ],
    });
    return service.createGitConnector('git', input, user.id);
  }
  throw new Error(`Unsupported integration tool: ${toolName}`);
}

/**
 * GitHub and generic Git connectors the caller may see (any Git grant on the connector); connectors seen only
 * through owner- or repo-qualified grants leave out their allowlist, like GET /integrations/<provider>/connectors.
 */
function visibleGitConnectors<T extends { id: string; allowlistEntries: unknown[] }>(
  user: User,
  provider: 'github' | 'git',
  rows: T[]
): T[] {
  const visibility = gitConnectorVisibility(user.scopes, provider);
  return rows.flatMap((row) => {
    const access = visibility(row.id);
    if (!access.visible) return [];
    return [access.full ? row : { ...row, allowlistEntries: [] }];
  });
}

function assertConnectorRouteAccess(
  user: User,
  provider: ConnectorProvider,
  connectorId: string | null,
  access: ConnectorRouteAccess
) {
  assertConnectorOperationAccess({
    actor: { userId: user.id, scopes: user.scopes, accountScopes: user.accountScopes },
    provider,
    connectorId,
    operation: access.operation,
    requiredScope: access.requiredScope,
    scopeTarget: access.scopeTarget,
  });
}

function connectorProvider(value: unknown): ConnectorProvider {
  if (CONNECTOR_PROVIDERS.includes(value as ConnectorProvider)) return value as ConnectorProvider;
  throw new AppError(400, 'INVALID_CONNECTOR_PROVIDER', `provider must be one of: ${CONNECTOR_PROVIDERS.join(', ')}`);
}

function canListConnectorProvider(user: User, provider: ConnectorProvider): boolean {
  const { requiredScope, scopeTarget } = CONNECTOR_LIST_ACCESS[provider];
  const scopes = typeof requiredScope === 'string' ? [requiredScope] : requiredScope;
  return scopes.some((scope) =>
    holdsConnectorOperationScope(
      { actor: { scopes: user.scopes, accountScopes: user.accountScopes }, connectorId: null, scopeTarget },
      scope
    )
  );
}

interface ListedConnectorRow {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  authMode?: string;
  syncStatus: string;
  syncLastError: string | null;
  syncFinishedAt: Date | null;
  testedAt: Date | null;
}

function compactConnector(provider: ConnectorProvider, row: ListedConnectorRow) {
  return {
    provider,
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    authMode: row.authMode,
    syncStatus: row.syncStatus,
    syncLastError: row.syncLastError,
    syncFinishedAt: row.syncFinishedAt,
    testedAt: row.testedAt,
  };
}

async function listProviderConnectors(
  service: IntegrationsService,
  user: User,
  provider: ConnectorProvider,
  enabled: boolean | undefined
) {
  const visible = GIT_CONNECTOR_PROVIDERS.has(provider)
    ? gitConnectorVisibility(user.scopes, provider as 'gitlab' | 'github' | 'git')
    : () => ({ visible: true, full: true });
  switch (provider) {
    case 'gitlab':
      return (await service.listGitLabConnectors({ enabled }))
        .filter((row) => visible(row.id).visible)
        .map((row) => compactConnector(provider, row));
    case 'cloudflare':
      return (await service.listCloudflareConnectors({ enabled })).map((row) => ({
        ...compactConnector(provider, row),
        zoneCount: row.zones.length,
      }));
    case 'github':
    case 'git':
      return visibleGitConnectors(user, provider, await service.listGitConnectors(provider, enabled)).map((row) => ({
        ...compactConnector(provider, row),
        repositoryCount: row.allowlistEntries.length,
      }));
    case 'ssh':
      return (await container.resolve(ExternalSshService).list(user))
        .filter((row) => enabled === undefined || row.enabled === enabled)
        .map((row) => ({
          provider,
          id: row.id,
          name: row.name,
          host: row.host,
          port: row.port,
          enabled: row.enabled,
          testStatus: row.testStatus,
          testLastError: row.testLastError,
          testedAt: row.testedAt,
        }));
  }
}

async function listIntegrationConnectors(service: IntegrationsService, user: User, args: Record<string, unknown>) {
  const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
  if (args.provider !== undefined) {
    const provider = connectorProvider(args.provider);
    assertConnectorRouteAccess(user, provider, null, CONNECTOR_LIST_ACCESS[provider]);
    return { connectors: await listProviderConnectors(service, user, provider, enabled) };
  }

  const connectors: Array<Record<string, unknown>> = [];
  const unavailableProviders: Array<{ provider: ConnectorProvider; error: string }> = [];
  for (const provider of CONNECTOR_PROVIDERS) {
    if (!canListConnectorProvider(user, provider)) continue;
    assertConnectorRouteAccess(user, provider, null, CONNECTOR_LIST_ACCESS[provider]);
    try {
      connectors.push(...(await listProviderConnectors(service, user, provider, enabled)));
    } catch (error) {
      unavailableProviders.push({ provider, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return unavailableProviders.length > 0 ? { connectors, unavailableProviders } : { connectors };
}

async function syncIntegrationConnector(service: IntegrationsService, user: User, args: Record<string, unknown>) {
  const provider = connectorProvider(args.provider);
  const connectorId = requiredString(args.connectorId);
  assertConnectorRouteAccess(user, provider, connectorId, CONNECTOR_SYNC_ACCESS[provider]);
  switch (provider) {
    case 'gitlab':
      return { provider, connectorId, result: await service.syncGitLabConnector(connectorId, user.id) };
    case 'cloudflare':
      return { provider, connectorId, result: await service.syncCloudflareConnector(connectorId, user.id) };
    case 'github':
    case 'git': {
      const synced = await service.syncGitConnector(provider, connectorId, user.id);
      return {
        provider,
        connectorId,
        result: { ...compactConnector(provider, synced), repositoryCount: synced.allowlistEntries.length },
      };
    }
    case 'ssh':
      return { provider, connectorId, result: await container.resolve(ExternalSshService).test(user, connectorId) };
  }
}

type ConnectorOperation =
  | 'get'
  | 'update'
  | 'delete'
  | 'test'
  | 'preview_test'
  | 'rotate_token'
  | 'capabilities'
  | 'list_zones'
  | 'allowlist_search'
  | 'allowlist_options'
  | 'allowlist_refresh'
  | 'allowlist_preview_search'
  | 'discover_host_key'
  | 'oauth_availability'
  | 'oauth_start'
  | 'oauth_status'
  | 'oauth_cancel'
  | 'scope_target_search'
  | 'scope_target_resolve';

/** GET /:provider/:connectorId/scope-targets and /scope-targets/resolve: the Git scope picker. */
const SCOPE_TARGET_ACCESS = (provider: 'gitlab' | 'github'): ConnectorRouteAccess => ({
  operation: 'connector.scope_targets',
  requiredScope: `integrations:${provider}:view`,
  scopeTarget: 'within-connector',
});

/**
 * Route access for manage_integration_connector, per provider and operation,
 * mirroring the connector middleware in integrations.routes.ts. Git, GitHub
 * and SSH routes name the operation after the HTTP method.
 */
const CONNECTOR_MANAGE_ACCESS: Record<ConnectorProvider, Partial<Record<ConnectorOperation, ConnectorRouteAccess>>> = {
  gitlab: {
    get: { operation: 'connector.get', requiredScope: ['integrations:gitlab:view', 'integrations:gitlab:manage'] },
    update: { operation: 'connector.update', requiredScope: 'integrations:gitlab:manage' },
    delete: { operation: 'connector.delete', requiredScope: 'integrations:gitlab:manage' },
    test: { operation: 'connector.test', requiredScope: 'integrations:gitlab:manage' },
    preview_test: { operation: 'connector.preview_test', requiredScope: 'integrations:gitlab:manage' },
    rotate_token: { operation: 'connector.token.rotate', requiredScope: 'integrations:gitlab:manage' },
    capabilities: {
      operation: 'connector.capabilities.get',
      requiredScope: ['integrations:gitlab:view', 'integrations:gitlab:manage'],
    },
    allowlist_search: { operation: 'connector.allowlist.search', requiredScope: 'integrations:gitlab:manage' },
    allowlist_options: { operation: 'connector.allowlist.options', requiredScope: 'integrations:gitlab:manage' },
    allowlist_refresh: {
      operation: 'connector.allowlist.options.refresh',
      requiredScope: 'integrations:gitlab:manage',
    },
    allowlist_preview_search: {
      operation: 'connector.allowlist.preview_search',
      requiredScope: 'integrations:gitlab:manage',
    },
    scope_target_search: SCOPE_TARGET_ACCESS('gitlab'),
    scope_target_resolve: SCOPE_TARGET_ACCESS('gitlab'),
  },
  cloudflare: {
    get: {
      operation: 'connector.get',
      requiredScope: ['integrations:cloudflare:view', 'integrations:cloudflare:manage'],
    },
    update: { operation: 'connector.update', requiredScope: 'integrations:cloudflare:manage' },
    delete: { operation: 'connector.delete', requiredScope: 'integrations:cloudflare:manage' },
    test: { operation: 'connector.test', requiredScope: 'integrations:cloudflare:manage' },
    preview_test: { operation: 'connector.preview_test', requiredScope: 'integrations:cloudflare:manage' },
    rotate_token: { operation: 'connector.token.rotate', requiredScope: 'integrations:cloudflare:manage' },
    list_zones: {
      operation: 'connector.zones.list',
      requiredScope: ['integrations:cloudflare:view', 'integrations:cloudflare:manage'],
    },
  },
  github: {
    update: { operation: 'connector.patch', requiredScope: 'integrations:github:manage' },
    delete: { operation: 'connector.delete', requiredScope: 'integrations:github:manage' },
    test: { operation: 'connector.post', requiredScope: 'integrations:github:manage' },
    preview_test: { operation: 'connector.post', requiredScope: 'integrations:github:manage' },
    // The GitHub OAuth (device flow) connector setup: /github/oauth and /github/oauth/sessions[/:id].
    oauth_availability: {
      operation: 'connector.get',
      requiredScope: ['integrations:github:view', 'integrations:github:manage'],
    },
    oauth_start: { operation: 'connector.post', requiredScope: 'integrations:github:manage' },
    oauth_status: { operation: 'connector.get', requiredScope: 'integrations:github:manage' },
    oauth_cancel: { operation: 'connector.delete', requiredScope: 'integrations:github:manage' },
    scope_target_search: SCOPE_TARGET_ACCESS('github'),
    scope_target_resolve: SCOPE_TARGET_ACCESS('github'),
  },
  git: {
    update: { operation: 'connector.patch', requiredScope: 'integrations:git:manage' },
    delete: { operation: 'connector.delete', requiredScope: 'integrations:git:manage' },
    test: { operation: 'connector.post', requiredScope: 'integrations:git:manage' },
    preview_test: { operation: 'connector.post', requiredScope: 'integrations:git:manage' },
  },
  ssh: {
    update: { operation: 'connector.patch', requiredScope: 'integrations:ssh:manage' },
    delete: { operation: 'connector.delete', requiredScope: 'integrations:ssh:manage' },
    test: { operation: 'connector.post', requiredScope: 'integrations:ssh:manage' },
    discover_host_key: { operation: 'connector.post', requiredScope: 'integrations:ssh:manage' },
  },
};

/** Operations that act before a connector exists or across connectors; they take no connectorId. */
const CONNECTORLESS_OPERATIONS = new Set<ConnectorOperation>([
  'preview_test',
  'allowlist_preview_search',
  'discover_host_key',
  // The OAuth routes carry no connector in the path; oauth_start may name one to re-authorize in its body.
  'oauth_availability',
  'oauth_start',
  'oauth_status',
  'oauth_cancel',
]);

async function manageIntegrationConnector(service: IntegrationsService, user: User, args: Record<string, unknown>) {
  const provider = connectorProvider(args.provider);
  const operation = requiredString(args.operation) as ConnectorOperation;
  const access = CONNECTOR_MANAGE_ACCESS[provider][operation];
  if (!access) {
    throw new AppError(
      400,
      'UNSUPPORTED_CONNECTOR_OPERATION',
      `Operation ${operation} is not available for ${provider} connectors`
    );
  }
  const connectorId = CONNECTORLESS_OPERATIONS.has(operation) ? null : requiredString(args.connectorId);
  assertConnectorRouteAccess(user, provider, connectorId, access);
  const id = connectorId ?? '';
  const ssh = () => container.resolve(ExternalSshService);
  // Searches and label lookups spend the connector's provider API budget: limited per account, like the picker.
  if (operation === 'scope_target_search' || operation === 'scope_target_resolve')
    scopeTargetRateLimiter.consume(user.id);

  switch (`${provider}.${operation}`) {
    case 'gitlab.get':
      return service.getGitLabConnector(id);
    case 'gitlab.update':
      return service.updateGitLabConnector(id, GitLabConnectorUpdateSchema.parse(pickConnectorFields(args)), user.id);
    case 'gitlab.delete':
      await service.deleteGitLabConnector(id, user.id);
      return { success: true };
    case 'gitlab.test':
      return service.testGitLabConnector(id, user.id);
    case 'gitlab.preview_test':
      return service.testGitLabConnectorPreview(
        GitLabConnectorPreviewTestSchema.parse({ baseUrl: args.baseUrl, token: args.token })
      );
    case 'gitlab.rotate_token':
      return service.rotateGitLabConnectorToken(
        id,
        GitLabConnectorRotateTokenSchema.parse({ token: args.token }).token,
        user.id
      );
    case 'gitlab.capabilities':
      return service.getGitLabConnectorCapabilities(id);
    case 'gitlab.allowlist_search':
      return service.searchGitLabAllowlist(id, GitLabAllowlistSearchQuerySchema.parse({ q: args.query }).q);
    case 'gitlab.allowlist_options':
      return service.listGitLabAllowlistOptions(id);
    case 'gitlab.allowlist_refresh':
      return service.refreshGitLabAllowlistOptions(id, user.id);
    case 'gitlab.allowlist_preview_search':
      return service.searchGitLabAllowlistPreview(
        GitLabAllowlistPreviewSearchSchema.parse({ baseUrl: args.baseUrl, token: args.token, q: args.query })
      );
    case 'cloudflare.get':
      return service.getCloudflareConnector(id);
    case 'cloudflare.update':
      return service.updateCloudflareConnector(
        id,
        CloudflareConnectorUpdateSchema.parse(pickConnectorFields(args)),
        user.id
      );
    case 'cloudflare.delete':
      await service.deleteCloudflareConnector(id, user.id);
      return { success: true };
    case 'cloudflare.test':
      return service.testCloudflareConnector(id, user.id);
    case 'cloudflare.preview_test':
      return service.testCloudflareConnectorPreview(CloudflareConnectorPreviewTestSchema.parse({ token: args.token }));
    case 'cloudflare.rotate_token':
      return service.rotateCloudflareConnectorToken(
        id,
        CloudflareConnectorRotateTokenSchema.parse({ token: args.token }).token,
        user.id
      );
    case 'cloudflare.list_zones':
      return service.listCloudflareZones(id);
    case 'github.update':
    case 'git.update':
      return service.updateGitConnector(
        provider as 'github' | 'git',
        id,
        GitConnectorUpdateSchema.parse(pickConnectorFields(args)),
        user.id
      );
    case 'github.delete':
    case 'git.delete':
      await service.deleteGitConnector(provider as 'github' | 'git', id, user.id);
      return { success: true };
    case 'github.test':
    case 'git.test':
      return service.testGitConnector(provider as 'github' | 'git', id, user.id);
    case 'github.preview_test':
      return service.previewGitHubConnectorTest(
        GitHubConnectorPreviewTestSchema.parse({ baseUrl: args.baseUrl, token: args.token })
      );
    case 'git.preview_test':
      return service.previewGitConnectorTest(
        GitConnectorPreviewTestSchema.parse({
          baseUrl: args.baseUrl,
          repositoryUrl: args.repositoryUrl,
          username: args.username,
          token: args.token,
        })
      );
    case 'github.oauth_availability':
      return service.getGitHubOAuthAvailability();
    case 'github.oauth_start':
      return service.startGitHubOAuth(
        GitHubOAuthStartSchema.parse({ connectorId: args.connectorId, name: args.name, enabled: args.enabled }),
        user.id
      );
    case 'github.oauth_status':
      return service.getGitHubOAuthStatus(requiredString(args.sessionId), user.id);
    case 'github.oauth_cancel':
      return service.cancelGitHubOAuth(requiredString(args.sessionId), user.id);
    case 'gitlab.scope_target_search':
      return service.listGitLabScopeTargets(user, id, scopeTargetSearchQuery(args));
    case 'github.scope_target_search':
      return service.listGitHubScopeTargets(user, id, scopeTargetSearchQuery(args));
    case 'gitlab.scope_target_resolve':
      return service.resolveGitLabScopeTargets(user, id, scopeTargetIds(args));
    case 'github.scope_target_resolve':
      return service.resolveGitHubScopeTargets(user, id, scopeTargetIds(args));
    case 'ssh.update':
      return ssh().updateName(user, id, ExternalSshConnectorUpdateSchema.parse({ name: args.name }).name);
    case 'ssh.delete':
      return ssh().delete(user, id);
    case 'ssh.test':
      return ssh().test(user, id);
    case 'ssh.discover_host_key':
      return ssh().discoverHostKey(
        user,
        ExternalSshHostKeySchema.parse({ host: args.host, port: args.port, jumpConnectorId: args.jumpConnectorId })
      );
    default:
      throw new AppError(
        400,
        'UNSUPPORTED_CONNECTOR_OPERATION',
        `Operation ${operation} is not available for ${provider} connectors`
      );
  }
}

function scopeTargetSearchQuery(args: Record<string, unknown>) {
  return ScopeTargetSearchQuerySchema.parse({ search: args.query, limit: args.limit });
}

/** Stored qualifiers to label, as the resolve route takes them: comma-separated (group/123,project/456). */
function scopeTargetIds(args: Record<string, unknown>) {
  const ids = Array.isArray(args.ids) ? args.ids.map(String).join(',') : args.ids;
  return ScopeTargetResolveQuerySchema.parse({ ids }).ids;
}

/** Connector update fields as the PATCH routes accept them; each provider schema keeps only its own fields. */
function pickConnectorFields(args: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of [
    'name',
    'baseUrl',
    'enabled',
    'token',
    'username',
    'authMode',
    'allowlistMode',
    'allowlistEntries',
    'settings',
  ]) {
    if (args[key] !== undefined) fields[key] = args[key];
  }
  return fields;
}

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new Error('Required value is missing');
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
