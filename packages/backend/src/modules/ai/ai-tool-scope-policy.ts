import { hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { MCP_TOKEN_SCOPES } from '@/lib/scopes.js';
import { APP_MEMBER_VIEW_SCOPES } from '@/modules/apps/app-access.js';
import { FOLDER_TOOL_REQUIREMENT_SCOPES } from './ai.folder-tool-scopes.js';
import { NODE_LIST_TOOL_SCOPES } from './ai.node-list-scopes.js';
import type { AIToolDefinition } from './ai.types.js';
import { getAIToolResourceId } from './ai-tool-policy-metadata.js';

export const AI_BROAD_ONLY_TOOL_SCOPES = new Set<string>();
export const AI_DIRECT_RAW_READ_TOOLS = new Set(['get_route_rendered_config']);

/**
 * Docker child resources are granted as `<base>:<nodeId>/<resourceId>`, and folder grants expand to that form.
 * Tool arguments name a node plus a container name, deployment id, image id, volume name or network id, which the
 * gate cannot map to that identity without a daemon or database lookup. The gate therefore only requires the base
 * scope; every Docker executor resolves the resource and re-checks `<nodeId>/<resourceId>` like the Docker route
 * middleware (node-level operations such as image prune check the node grant).
 */
const EXECUTOR_AUTHORIZED_DOCKER_SCOPE_PREFIXES = [
  'docker:containers:',
  'docker:compose:',
  'docker:images:',
  'docker:volumes:',
  'docker:networks:',
] as const;

export function isExecutorAuthorizedDockerScope(requiredScope: string): boolean {
  return EXECUTOR_AUTHORIZED_DOCKER_SCOPE_PREFIXES.some((prefix) => requiredScope.startsWith(prefix));
}

/** App tools: any app permission reaches them; the handlers check the app or environment each call touches. */
const APP_TOOL_SCOPES = [
  'apps:view',
  'apps:create',
  'apps:edit',
  'apps:delete',
  'apps:env:manage',
  'apps:promote',
  'apps:operate',
] as const;

/**
 * App reads also reach callers that see an app only through its members (no apps:view): the member view scopes, as
 * for /api/apps. The handlers show such a caller only the environments and members it can view.
 */
const APP_READ_TOOL_SCOPES = [...APP_TOOL_SCOPES, ...APP_MEMBER_VIEW_SCOPES] as const;

export const AI_TOOL_ANY_SCOPE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  list_apps: APP_READ_TOOL_SCOPES,
  get_app: APP_READ_TOOL_SCOPES,
  manage_app: APP_TOOL_SCOPES,
  manage_app_environment: APP_TOOL_SCOPES,
  manage_app_variables: APP_TOOL_SCOPES,
  // list: members the caller can view; place checks apps:env:manage.
  manage_app_members: APP_READ_TOOL_SCOPES,
  get_app_overview: APP_READ_TOOL_SCOPES,
  get_app_activity: APP_READ_TOOL_SCOPES,
  // list and status: incidents of the visible environments; actions check apps:operate.
  manage_app_incident: APP_READ_TOOL_SCOPES,
  promote_app_environment: APP_TOOL_SCOPES,
  manage_database_backups: [
    'databases:backups:view',
    'databases:backups:manage',
    'databases:backups:run',
    'databases:backups:restore',
  ],
  manage_storage_connection: [
    'storage:view',
    'storage:create',
    'storage:edit',
    'storage:delete',
    'storage:credentials:reveal',
    // copy_data_* actions; StorageCopyService checks each connection.
    'storage:objects:read',
    'storage:objects:write',
  ],
  manage_storage_objects: ['storage:objects:read', 'storage:objects:write', 'storage:objects:admin'],
  manage_managed_storage: [
    'storage:view',
    'storage:create',
    'storage:edit',
    'storage:delete',
    'storage:iam',
    'storage:bind',
    'storage:credentials:reveal',
  ],
  read_opfield_documentation: MCP_TOKEN_SCOPES,
  // Every caller may read its own access summary: MCP grants hold only delegable scopes, the assistant the workspace.
  get_my_access: ['ai:workspace:use', ...MCP_TOKEN_SCOPES],
  manage_docker_compose: [
    'docker:compose:view',
    'docker:compose:create',
    'docker:compose:manage',
    'docker:compose:delete',
  ],
  manage_docker_source: [
    'docker:containers:view',
    'docker:containers:create',
    'docker:containers:edit',
    'docker:containers:manage',
    'docker:compose:view',
    'docker:compose:create',
    'docker:compose:manage',
    'pages:view',
    'pages:create',
    'pages:edit',
    'pages:deploy',
  ],
  manage_docker_build: [
    'docker:containers:view',
    'docker:containers:manage',
    'docker:compose:view',
    'docker:compose:manage',
    'pages:view',
    'pages:deploy',
  ],
  list_docker_builds: ['docker:containers:view', 'docker:compose:view', 'pages:view'],
  find_resource: [
    'ai:workspace:use',
    'apps:view',
    'nodes:details',
    'proxy:view',
    'proxy:templates:view',
    'ssl:cert:view',
    'domains:view',
    'acl:view',
    'pki:ca:view',
    'pki:cert:view',
    'pki:templates:view',
    'docker:containers:view',
    'docker:images:view',
    'docker:volumes:view',
    'docker:networks:view',
    'docker:registries:view',
    'databases:view',
    'pages:view',
    'logs:environments:view',
    'logs:schemas:view',
    'status-page:view',
    'notifications:alerts:view',
    'notifications:webhooks:view',
  ],
  // Same inventory as GET /api/nodes: node view, node folders, Docker grants and destination creators.
  list_nodes: NODE_LIST_TOOL_SCOPES,
  // GET /monitoring/dashboard answers every caller with the categories it may see; the assistant also
  // answers workspace users that see none of them.
  get_dashboard_stats: [
    'ai:workspace:use',
    'proxy:view',
    'ssl:cert:view',
    'pki:cert:view',
    'pki:ca:view',
    'nodes:details',
  ],
  list_cas: ['pki:ca:view', 'pki:cert:issue'],
  delete_ca: ['pki:ca:revoke:root', 'pki:ca:revoke:intermediate'],
  manage_ca: ['pki:ca:edit', 'pki:ca:export', 'pki:ca:revoke:root', 'pki:ca:revoke:intermediate'],
  manage_certificate: ['pki:cert:view', 'pki:cert:issue', 'pki:cert:export'],
  manage_template: ['pki:templates:view', 'pki:templates:edit'],
  manage_proxy_template: ['proxy:templates:view', 'proxy:templates:manage'],
  manage_ssl_certificate: ['ssl:cert:view', 'ssl:cert:issue', 'ssl:cert:renew', 'ssl:cert:delete'],
  manage_domain: ['domains:view', 'domains:edit', 'domains:create'],
  manage_ingress_group: ['ingress:groups:view', 'ingress:groups:manage', 'proxy:edit', 'domains:edit'],
  manage_access_list: ['acl:view', 'acl:edit'],
  manage_docker_registry: [
    'docker:registries:view',
    'docker:registries:create',
    'docker:registries:edit',
    'docker:registries:delete',
  ],
  manage_docker_volume: [
    'docker:volumes:create',
    'docker:volumes:edit',
    'docker:volumes:delete',
    'docker:volumes:view',
    'docker:volumes:files:read',
    'docker:volumes:files:write',
    'docker:containers:mounts',
  ],
  // The handlers enforce the exact per-provider route scope.
  list_integration_connectors: [
    'integrations:gitlab:view',
    'integrations:gitlab:manage',
    'integrations:github:view',
    'integrations:git:view',
    'integrations:cloudflare:view',
    'integrations:ssh:view',
  ],
  // The lookup enforces view on the named connector (any qualifier) for its provider.
  find_git_scope_target: ['integrations:gitlab:view', 'integrations:github:view'],
  sync_integration_connector: [
    'integrations:gitlab:manage',
    'integrations:cloudflare:sync',
    'integrations:cloudflare:manage',
    'integrations:github:manage',
    'integrations:git:manage',
    'integrations:ssh:manage',
  ],
  manage_docker_network: ['docker:networks:create', 'docker:networks:edit', 'docker:networks:delete'],
  // Consumer side (edit, compose manage), target side (link) or either end's view for list and runtime.
  manage_container_link: [
    'docker:containers:view',
    'docker:compose:view',
    'docker:containers:edit',
    'docker:compose:manage',
    'docker:containers:link',
  ],
  // An env-only update needs only docker:containers:environment on the deployment.
  manage_docker_deployment: [
    'docker:containers:create',
    'docker:containers:edit',
    'docker:containers:environment',
    'docker:containers:delete',
  ],
  manage_docker_container_config: [
    'docker:containers:view',
    'docker:containers:environment',
    'docker:containers:files:read',
    'docker:containers:files:write',
    'docker:containers:secrets',
    'docker:containers:webhooks',
    'docker:containers:edit',
  ],
  // Same list access as GET /nodes/:nodeId/containers and /deployments: a creator with nothing visible lists empty.
  list_docker_containers: ['docker:containers:view', 'docker:containers:create'],
  list_docker_deployments: ['docker:containers:view', 'docker:containers:create'],
  // Docker creation routes use requireScopeBase; the services check the node or folder destination.
  create_docker_container: ['docker:containers:create'],
  duplicate_docker_container: ['docker:containers:create'],
  // A pull for a workload (workload.folderId) is authorized by creating that container or deployment.
  pull_docker_image: ['docker:images:pull', 'docker:containers:create'],
  upload_docker_container_archive: ['docker:containers:create'],
  manage_docker_container: [
    'docker:containers:view',
    'docker:containers:edit',
    'docker:containers:manage',
    'docker:containers:create',
  ],
  download_docker_archive: ['docker:containers:export', 'docker:volumes:export'],
  // The Availability service authorizes the workload; mutations also need docker:availability:manage.
  manage_docker_availability: ['docker:availability:manage', 'docker:containers:view', 'docker:compose:view'],
  // Migration routes: preflight/start are authorized by the service, reads need docker:tasks, changes :manage.
  manage_docker_migration: ['docker:containers:migrate', 'docker:tasks', 'docker:tasks:manage'],
  // Secure runtime install is node control; the handler checks the node.
  manage_docker_runtime: ['nodes:manage', 'admin:update'],
  // Retrying TLS delivery is a route edit or a certificate issue; the handler checks the target.
  resync_tls_distribution: ['proxy:edit', 'ssl:cert:issue', 'admin:update'],
  // Same list access as GET /databases and GET /storage: a creator with nothing visible yet lists empty.
  list_databases: ['databases:view', 'databases:create'],
  list_storage_connections: ['storage:view', 'storage:create'],
  manage_database_connection: [
    'databases:view',
    'databases:create',
    'databases:edit',
    'databases:delete',
    'databases:credentials:reveal',
  ],
  manage_managed_database: [
    'databases:view',
    'databases:create',
    'databases:edit',
    'databases:bind',
    'databases:delete',
    'databases:credentials:reveal',
  ],
  manage_pages: [
    'pages:view',
    'pages:create',
    'pages:edit',
    'pages:delete',
    // source_build and source_sync (Sync now) need only pages:deploy on the Project, like their REST routes.
    'pages:deploy',
    'pages:deployments:manage',
    'pages:tags:manage',
    'pages:tokens:manage',
    'pages:settings:view',
    'pages:settings:edit',
    'pages:folders:manage',
  ],
  // nodeId is a list filter, not the target: the handler returns only routes inside the proxy:view grants.
  list_routes: ['proxy:view'],
  manage_additional_route: ['proxy:view', 'proxy:edit'],
  manage_additional_secure_link: ['proxy:view', 'proxy:edit'],
  // The handler checks the destination with hasScopeForCreation, like POST /proxy-hosts.
  create_route: ['proxy:create'],
  manage_route: ['proxy:view', 'proxy:create', 'proxy:advanced', 'proxy:raw:write', 'proxy:maintenance:bypass'],
  manage_postgres_data: ['databases:query:read', 'databases:query:write'],
  manage_redis_data: ['databases:query:read', 'databases:query:write', 'databases:query:admin'],
  manage_logging: [
    'logs:environments:view',
    'logs:environments:create',
    'logs:environments:edit',
    'logs:environments:delete',
    'logs:tokens:view',
    'logs:tokens:create',
    'logs:tokens:delete',
    'logs:schemas:view',
    'logs:schemas:create',
    'logs:schemas:edit',
    'logs:schemas:delete',
    'logs:read',
    'housekeeping:view',
  ],
  manage_status_page: [
    'status-page:view',
    'status-page:manage',
    'status-page:incidents:create',
    'status-page:incidents:update',
    'status-page:incidents:resolve',
    'status-page:incidents:delete',
  ],
  manage_inference_provider: ['inference:providers:view', 'inference:providers:manage'],
  manage_inference_token: ['feat:ai:use'],
  manage_inference_usage: ['feat:ai:use', 'inference:usage:view'],
  // Managing alert rules or webhooks implies viewing them.
  list_alert_rules: ['notifications:alerts:view', 'notifications:alerts:manage'],
  list_alerts: ['notifications:alerts:view', 'notifications:alerts:manage'],
  get_alert_rule: ['notifications:alerts:view', 'notifications:alerts:manage'],
  list_webhooks: ['notifications:webhooks:view', 'notifications:webhooks:manage'],
  list_webhook_deliveries: ['notifications:webhooks:view', 'notifications:webhooks:manage'],
  get_delivery_stats: ['notifications:webhooks:view', 'notifications:webhooks:manage'],
  manage_notifications: [
    'notifications:alerts:view',
    'notifications:alerts:manage',
    'notifications:webhooks:view',
    'notifications:webhooks:manage',
  ],
  // The handler enforces the exact per-provider route scope.
  manage_integration_connector: [
    'integrations:gitlab:view',
    'integrations:gitlab:manage',
    'integrations:github:view',
    'integrations:github:manage',
    'integrations:git:view',
    'integrations:git:manage',
    'integrations:cloudflare:view',
    'integrations:cloudflare:manage',
    'integrations:ssh:view',
    'integrations:ssh:manage',
  ],
  // The hosting services enforce each operation's exact scopes, like the hosting routes.
  manage_hosting: [
    'integrations:hosting:view',
    'integrations:hosting:manage',
    'hosting:resources:view',
    'hosting:resources:create',
    'hosting:resources:power',
    'hosting:resources:resize',
    'hosting:resources:delete',
    'hosting:resources:recover',
    'hosting:snapshots:view',
    'hosting:snapshots:create',
    'hosting:snapshots:delete',
    'hosting:snapshots:restore',
    'hosting:snapshots:folders:manage',
    'hosting:billing:view',
    'nodes:details',
  ],
  // Folder grants of proxy:folders:manage pass the gate; the handlers check the exact folders touched.
  create_route_folder: ['proxy:folders:manage'],
  move_routes_to_folder: ['proxy:folders:manage'],
  delete_route_folder: ['proxy:folders:manage'],
  list_resource_folders: [...FOLDER_TOOL_REQUIREMENT_SCOPES],
  manage_resource_folder: [...FOLDER_TOOL_REQUIREMENT_SCOPES],
  manage_node_config: ['nodes:config:view', 'nodes:manage'],
  // The handlers enforce the exact per-node or admin:system scope of each route.
  manage_node: ['nodes:details', 'nodes:rename', 'nodes:create', 'nodes:logs', 'nodes:manage'],
  manage_user: ['admin:users', 'admin:system'],
  manage_relay_pool: ['settings:opfield:view', 'admin:system'],
  manage_node_file: ['nodes:files:read', 'nodes:files:write'],
};

type ScopedTool = Pick<AIToolDefinition, 'name' | 'requiredScope' | 'requiredScopes' | 'targetIdentity'>;

function hasDirectScopeBase(scopes: string[], baseScope: string): boolean {
  return scopes.includes(baseScope) || scopes.some((scope) => scope.startsWith(`${baseScope}:`));
}

function hasRequiredScopeBases(scopes: string[], tool: ScopedTool): boolean {
  return !tool.requiredScopes || tool.requiredScopes.every((scope) => hasScopeBase(scopes, scope));
}

/**
 * Whether a tool may be offered to scopes without knowing its arguments (AI tool lists, MCP tools/list).
 * Resource-scoped grants count; the call itself is checked with {@link hasAIToolCallScope}.
 */
export function hasAIToolVisibilityScope(scopes: string[], tool: ScopedTool): boolean {
  if (!tool.requiredScope) return false;
  if (!hasRequiredScopeBases(scopes, tool)) return false;
  const anyRequirements = AI_TOOL_ANY_SCOPE_REQUIREMENTS[tool.name];
  if (anyRequirements) return anyRequirements.some((scope) => hasScopeBase(scopes, scope));
  if (AI_DIRECT_RAW_READ_TOOLS.has(tool.name)) return hasDirectScopeBase(scopes, tool.requiredScope);
  return AI_BROAD_ONLY_TOOL_SCOPES.has(tool.name)
    ? hasScope(scopes, tool.requiredScope)
    : hasScopeBase(scopes, tool.requiredScope);
}

/**
 * Whether scopes may call a tool with these arguments. Resource-scoped tools are checked against the target resource
 * named by the arguments; tools whose handlers authorize each resource (any-scope tools and the Docker child resource
 * families) only need the base scope here.
 */
export function hasAIToolCallScope(scopes: string[], tool: ScopedTool, args: Record<string, unknown>): boolean {
  if (!tool.requiredScope) return false;
  if (!hasRequiredScopeBases(scopes, tool)) return false;
  const anyRequirements = AI_TOOL_ANY_SCOPE_REQUIREMENTS[tool.name];
  if (anyRequirements) return anyRequirements.some((scope) => hasScopeBase(scopes, scope));
  if (AI_BROAD_ONLY_TOOL_SCOPES.has(tool.name)) return hasScope(scopes, tool.requiredScope);
  const resourceId = getAIToolResourceId(tool, args);
  if (AI_DIRECT_RAW_READ_TOOLS.has(tool.name)) {
    if (scopes.includes(tool.requiredScope)) return true;
    return resourceId
      ? scopes.includes(`${tool.requiredScope}:${resourceId}`)
      : scopes.some((scope) => scope.startsWith(`${tool.requiredScope}:`));
  }
  if (isExecutorAuthorizedDockerScope(tool.requiredScope)) return hasScopeBase(scopes, tool.requiredScope);
  return resourceId
    ? hasScopeForResource(scopes, tool.requiredScope, resourceId)
    : hasScopeBase(scopes, tool.requiredScope);
}
