/**
 * MCP coverage of every REST operation the host application serves (mcp-rest-coverage.test.ts checks it against the
 * app's route table). Product rule: an MCP or API agent can do everything a person can do with resources, so each
 * operation names the MCP tools (and their operation) that do the same, or a product exclusion with its reason
 * (categories in mcp-rest-coverage.types.ts). A new route fails the check until it is listed here; a new capability
 * gets an MCP tool operation, never an exclusion of convenience.
 */

import { excluded, type McpRestCoverageMap, mcp } from './mcp-rest-coverage.types.js';

const CHAT_INTERNALS = excluded('chat-internals', 'Embedded AI chat internals.');
const INFERENCE_DATA_PLANE = excluded('machine', 'Inference data plane called by clients with their inference key.');
const MCP_TRANSPORT = excluded('machine', 'The MCP transport itself.');
const OAUTH_DISCOVERY = excluded('oauth-protocol', 'OAuth and OpenID discovery metadata.');
const SETUP_WIZARD = excluded('own-auth', 'First-run setup wizard, runs before any account or MCP token exists.');
const OWN_ACCOUNT = excluded('own-auth', 'Own sign-in, session, MFA, passkeys or profile of the caller.');
const OWN_GIT_CREDENTIAL = excluded(
  'own-auth',
  "The caller's own personal credential for a connector (browser session only): a token must not read, plant or remove the account's personal Git credential."
);
const OWNER_SETUP_CHECKLIST = excluded(
  'own-auth',
  "The installation owner's own post-setup checklist in the console (browser session only), the tail of first-run setup."
);
const API_TOKENS = excluded('token-minting', 'Issues or manages Opfield API tokens of the caller.');
const OAUTH_GRANTS = excluded('token-minting', 'Manages OAuth grants of the caller.');
const OAUTH_CONSENT = excluded('token-minting', 'OAuth consent screen for granting the caller credentials.');

export const HOST_MCP_REST_COVERAGE: McpRestCoverageMap = {
  // /.well-known
  'GET /.well-known/oauth-authorization-server': OAUTH_DISCOVERY,
  'GET /.well-known/oauth-authorization-server/api/mcp': OAUTH_DISCOVERY,
  'GET /.well-known/oauth-protected-resource': OAUTH_DISCOVERY,
  'GET /.well-known/oauth-protected-resource/api': OAUTH_DISCOVERY,
  'GET /.well-known/oauth-protected-resource/api/mcp': OAUTH_DISCOVERY,
  'GET /.well-known/openid-configuration': OAUTH_DISCOVERY,
  'GET /.well-known/openid-configuration/api/mcp': OAUTH_DISCOVERY,
  // /api/access-lists
  'GET /api/access-lists': mcp('list_access_lists'),
  'POST /api/access-lists': mcp('create_access_list'),
  'GET /api/access-lists/folders': mcp('list_resource_folders'),
  'POST /api/access-lists/folders': mcp('manage_resource_folder:create'),
  'POST /api/access-lists/folders/move-access-lists': mcp('manage_resource_folder:move_resources'),
  'PUT /api/access-lists/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/access-lists/folders/reorder-access-lists': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/access-lists/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/access-lists/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/access-lists/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/access-lists/{id}': mcp('manage_access_list:get'),
  'PUT /api/access-lists/{id}': mcp('manage_access_list:update'),
  'DELETE /api/access-lists/{id}': mcp('delete_access_list'),
  // /api/admin
  'GET /api/admin/auth-settings': mcp('get_opfield_settings'),
  'PUT /api/admin/auth-settings': mcp('update_opfield_settings'),
  'GET /api/admin/groups': mcp('list_groups'),
  'POST /api/admin/groups': mcp('create_group'),
  'GET /api/admin/groups/folders': mcp('list_resource_folders'),
  'POST /api/admin/groups/folders': mcp('manage_resource_folder:create'),
  'POST /api/admin/groups/folders/move-groups': mcp('manage_resource_folder:move_resources'),
  'PUT /api/admin/groups/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/admin/groups/folders/reorder-groups': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/admin/groups/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/admin/groups/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/admin/groups/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/admin/groups/{id}': mcp('list_groups'),
  'PUT /api/admin/groups/{id}': mcp('update_group'),
  'DELETE /api/admin/groups/{id}': mcp('delete_group'),
  'GET /api/admin/user-folders': mcp('list_resource_folders'),
  'POST /api/admin/user-folders': mcp('manage_resource_folder:create'),
  'POST /api/admin/user-folders/move-users': mcp('manage_resource_folder:move_resources'),
  'PUT /api/admin/user-folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/admin/user-folders/reorder-users': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/admin/user-folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/admin/user-folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/admin/user-folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/admin/users': mcp('list_users'),
  'POST /api/admin/users': mcp('create_user'),
  'GET /api/admin/users/deleted': mcp('manage_user:list_deleted'),
  'DELETE /api/admin/users/{id}': mcp('delete_user'),
  'PUT /api/admin/users/{id}/additional-permissions': mcp('set_user_additional_permissions'),
  'PATCH /api/admin/users/{id}/auth-method': mcp('manage_user:set_auth_method'),
  'DELETE /api/admin/users/{id}/avatar': mcp('manage_user:reset_avatar'),
  'PATCH /api/admin/users/{id}/block': mcp('set_user_blocked'),
  'PATCH /api/admin/users/{id}/group': mcp('update_user_role'),
  'POST /api/admin/users/{id}/impersonate': excluded('impersonation', 'Acting as another user.'),
  'POST /api/admin/users/{id}/invitation': mcp('manage_user:send_invitation'),
  'POST /api/admin/users/{id}/mfa/reset': mcp('manage_user:reset_mfa'),
  'PATCH /api/admin/users/{id}/name': mcp('manage_user:rename'),
  'POST /api/admin/users/{id}/password-setup': mcp('manage_user:send_password_link'),
  'POST /api/admin/users/{id}/restore': mcp('manage_user:restore'),
  'GET /api/admin/users/{id}/sessions': mcp('manage_user:list_sessions'),
  'DELETE /api/admin/users/{id}/sessions': mcp('manage_user:revoke_all_sessions'),
  'DELETE /api/admin/users/{id}/sessions/{sessionId}': mcp('manage_user:revoke_session'),
  // /api/ai
  'GET /api/ai/config': mcp('get_ai_settings'),
  'PUT /api/ai/config': mcp('update_ai_settings'),
  'POST /api/ai/context-estimate': CHAT_INTERNALS,
  'GET /api/ai/conversation-folders': CHAT_INTERNALS,
  'POST /api/ai/conversation-folders': CHAT_INTERNALS,
  'PUT /api/ai/conversation-folders/move-conversations': CHAT_INTERNALS,
  'PUT /api/ai/conversation-folders/reorder': CHAT_INTERNALS,
  'PATCH /api/ai/conversation-folders/{id}': CHAT_INTERNALS,
  'DELETE /api/ai/conversation-folders/{id}': CHAT_INTERNALS,
  'GET /api/ai/conversations': CHAT_INTERNALS,
  'GET /api/ai/conversations/{id}': CHAT_INTERNALS,
  'PATCH /api/ai/conversations/{id}': CHAT_INTERNALS,
  'DELETE /api/ai/conversations/{id}': CHAT_INTERNALS,
  'PATCH /api/ai/conversations/{id}/provider': CHAT_INTERNALS,
  'POST /api/ai/conversations/{id}/rollback': CHAT_INTERNALS,
  'GET /api/ai/sandbox/artifacts': CHAT_INTERNALS,
  'POST /api/ai/sandbox/artifacts': CHAT_INTERNALS,
  'DELETE /api/ai/sandbox/artifacts/{id}': CHAT_INTERNALS,
  'GET /api/ai/sandbox/artifacts/{id}/download': CHAT_INTERNALS,
  'GET /api/ai/sandbox/jobs': CHAT_INTERNALS,
  'POST /api/ai/sandbox/jobs/{id}/kill': CHAT_INTERNALS,
  'GET /api/ai/sandbox/jobs/{id}/output': CHAT_INTERNALS,
  'GET /api/ai/sandbox/status': mcp('get_opfield_runtime:sandbox_status'),
  'GET /api/ai/scenarios': CHAT_INTERNALS,
  'GET /api/ai/skills': CHAT_INTERNALS,
  'POST /api/ai/skills': CHAT_INTERNALS,
  'PATCH /api/ai/skills/{id}': CHAT_INTERNALS,
  'DELETE /api/ai/skills/{id}': CHAT_INTERNALS,
  'GET /api/ai/status': mcp('get_opfield_runtime:ai_status'),
  'GET /api/ai/tools': mcp('list_ai_tools'),
  'GET /api/ai/ws': CHAT_INTERNALS,
  // /api/alerts
  'GET /api/alerts': mcp('manage_system_alerts:list'),
  'POST /api/alerts/{id}/dismiss': mcp('manage_system_alerts:dismiss'),
  // /api/apps
  'GET /api/apps': mcp('list_apps'),
  'POST /api/apps': mcp('manage_app:create'),
  'GET /api/apps/folders': mcp('list_resource_folders'),
  'POST /api/apps/folders': mcp('manage_resource_folder:create'),
  'POST /api/apps/folders/move-apps': mcp('manage_resource_folder:move_resources'),
  'PUT /api/apps/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/apps/folders/reorder-apps': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/apps/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/apps/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/apps/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'POST /api/apps/members/place': mcp('manage_app_members:place'),
  'GET /api/apps/{id}': mcp('get_app'),
  'PATCH /api/apps/{id}': mcp('manage_app:update'),
  'DELETE /api/apps/{id}': mcp('manage_app:delete'),
  'GET /api/apps/{id}/activity': mcp('get_app_activity'),
  'POST /api/apps/{id}/environments': mcp('manage_app_environment:create'),
  'PATCH /api/apps/{id}/environments/{envId}': mcp(
    'manage_app_environment:rename',
    'manage_app_environment:mark_production',
    'manage_app_environment:set_maintenance',
    'manage_app_environment:set_domain_patterns'
  ),
  'DELETE /api/apps/{id}/environments/{envId}': mcp('manage_app_environment:delete'),
  'GET /api/apps/{id}/environments/{envId}/nodes': mcp('manage_app_environment:list_nodes'),
  'POST /api/apps/{id}/environments/{envId}/nodes': mcp('manage_app_environment:allow_node'),
  'DELETE /api/apps/{id}/environments/{envId}/nodes': mcp('manage_app_environment:remove_node'),
  'DELETE /api/apps/{id}/environments/{envId}/nodes/{nodeId}': mcp('manage_app_environment:remove_node'),
  'PATCH /api/apps/{id}/environments/{envId}/secrets': mcp(
    'manage_app_variables:set_secrets',
    'manage_app_variables:delete_secrets'
  ),
  'GET /api/apps/{id}/environments/{envId}/variables': mcp('manage_app_variables:get'),
  'PUT /api/apps/{id}/environments/{envId}/variables': mcp('manage_app_variables:set_variables'),
  'GET /api/apps/{id}/environments/{envId}/workload-tasks/{taskId}': mcp('manage_app_variables:workload_task'),
  'GET /api/apps/{id}/incidents': mcp('manage_app_incident:status'),
  'GET /api/apps/{id}/incidents/preview': mcp('manage_app_incident:preview'),
  'POST /api/apps/{id}/isolation': mcp('manage_app_incident:isolate'),
  'DELETE /api/apps/{id}/isolation': mcp('manage_app_incident:release'),
  'PUT /api/apps/{id}/logo': mcp('manage_app:upload_logo'),
  'DELETE /api/apps/{id}/logo': mcp('manage_app:remove_logo'),
  'POST /api/apps/{id}/maintenance-access-code': mcp('manage_app_environment:create_access_code'),
  'GET /api/apps/{id}/members': mcp('manage_app_members:list'),
  'GET /api/apps/{id}/overview': mcp('get_app_overview'),
  'GET /api/apps/{id}/promotions': mcp('promote_app_environment:list'),
  'POST /api/apps/{id}/promotions': mcp('promote_app_environment:execute'),
  'POST /api/apps/{id}/promotions/preview': mcp('promote_app_environment:preview'),
  'GET /api/apps/{id}/promotions/{promotionId}': mcp('promote_app_environment:status'),
  'POST /api/apps/{id}/shutdown': mcp('manage_app_incident:shutdown'),
  'POST /api/apps/{id}/start': mcp('manage_app_incident:start'),
  // /api/audit
  'GET /api/audit': mcp('get_audit_log'),
  'GET /api/audit/users': mcp('get_audit_log'),
  // /api/auth
  'GET /api/auth/me/access': mcp('get_my_access'),
  // /api/configuration-export-link
  'GET /api/configuration-export-link/{token}': mcp('manage_configuration_export:export'),
  // /api/databases
  'GET /api/databases/{databaseId}/logs/stream': mcp('manage_managed_database:logs'),
  // /api/docker-archive-link
  'GET /api/docker-archive-link/{token}': mcp('download_docker_archive:link'),
  'POST /api/docker-archive-link/{token}': mcp('upload_docker_container_archive:link'),
  'PUT /api/docker-archive-link/{token}': mcp('upload_docker_container_archive:link'),
  // /api/docker
  'POST /api/docker/availability': mcp('manage_docker_availability:enable'),
  'GET /api/docker/availability/by-resource': mcp('manage_docker_availability:get_by_resource'),
  'POST /api/docker/availability/preflight': mcp('manage_docker_availability:preflight'),
  'GET /api/docker/availability/{id}': mcp('manage_docker_availability:get'),
  'PATCH /api/docker/availability/{id}': mcp('manage_docker_availability:update'),
  'POST /api/docker/availability/{id}/disable': mcp('manage_docker_availability:disable'),
  'GET /api/docker/availability/{id}/operations': mcp('manage_docker_availability:list_operations'),
  'GET /api/docker/availability/{id}/operations/page': mcp('manage_docker_availability:list_operations'),
  'POST /api/docker/availability/{id}/operations/{operationId}/retry': mcp(
    'manage_docker_availability:retry_operation'
  ),
  'GET /api/docker/builds': mcp('list_docker_builds'),
  'GET /api/docker/builds/{buildId}': mcp('manage_docker_build:get'),
  'POST /api/docker/builds/{buildId}/cancel': mcp('manage_docker_build:cancel'),
  'GET /api/docker/builds/{buildId}/logs': mcp('manage_docker_build:logs'),
  'POST /api/docker/builds/{buildId}/retry': mcp('manage_docker_build:retry'),
  'GET /api/docker/compose-projects': mcp('manage_docker_compose:list'),
  'GET /api/docker/container-links': mcp('manage_container_link:list'),
  'POST /api/docker/container-links': mcp('manage_container_link:create'),
  'GET /api/docker/container-links/{id}': mcp('manage_container_link:get_runtime'),
  'DELETE /api/docker/container-links/{id}': mcp('manage_container_link:delete'),
  'GET /api/docker/container-links/{id}/runtime': mcp('manage_container_link:get_runtime'),
  'GET /api/docker/containers': mcp('list_docker_containers'),
  'GET /api/docker/folders': mcp('list_resource_folders'),
  'POST /api/docker/folders': mcp('manage_resource_folder:create'),
  'POST /api/docker/folders/move-containers': mcp('manage_resource_folder:move_resources'),
  'POST /api/docker/folders/move-resources': mcp('manage_resource_folder:move_resources'),
  'POST /api/docker/folders/placements': mcp('list_docker_containers', 'list_docker_deployments'),
  'PUT /api/docker/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/docker/folders/reorder-containers': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/docker/folders/reorder-resources': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/docker/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/docker/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/docker/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/docker/images': mcp('list_docker_images'),
  'GET /api/docker/migrations': mcp('manage_docker_migration:list'),
  'POST /api/docker/migrations': mcp('manage_docker_migration:start'),
  'POST /api/docker/migrations/preflight': mcp('manage_docker_migration:preflight'),
  'GET /api/docker/migrations/{id}': mcp('manage_docker_migration:get'),
  'POST /api/docker/migrations/{id}/cancel': mcp('manage_docker_migration:cancel'),
  'POST /api/docker/migrations/{id}/resolve': mcp('manage_docker_migration:resolve'),
  'POST /api/docker/migrations/{id}/retry-cleanup': mcp('manage_docker_migration:retry_cleanup'),
  'GET /api/docker/networks': mcp('list_docker_networks'),
  'GET /api/docker/nodes/by-slug/{nodeSlug}': mcp('find_resource', 'list_nodes'),
  'POST /api/docker/nodes/{nodeId}/compose-projects': mcp('manage_docker_compose:create'),
  'POST /api/docker/nodes/{nodeId}/compose-projects/from-source': mcp('manage_docker_source:create'),
  'POST /api/docker/nodes/{nodeId}/compose-projects/validate': mcp('manage_docker_compose:validate'),
  'GET /api/docker/nodes/{nodeId}/compose-projects/{projectId}': mcp('manage_docker_compose:get'),
  'DELETE /api/docker/nodes/{nodeId}/compose-projects/{projectId}': mcp('manage_docker_compose:delete'),
  'POST /api/docker/nodes/{nodeId}/compose-projects/{projectId}/actions/{action}': mcp(
    'manage_docker_compose:operation_start'
  ),
  'POST /api/docker/nodes/{nodeId}/compose-projects/{projectId}/adopt': mcp('manage_docker_compose:adopt'),
  'GET /api/docker/nodes/{nodeId}/compose-projects/{projectId}/operations': mcp('manage_docker_compose:operation_list'),
  'GET /api/docker/nodes/{nodeId}/compose-projects/{projectId}/revisions': mcp('manage_docker_compose:revision_list'),
  'POST /api/docker/nodes/{nodeId}/compose-projects/{projectId}/revisions': mcp(
    'manage_docker_compose:revision_create'
  ),
  'GET /api/docker/nodes/{nodeId}/compose-projects/{projectId}/revisions/{revisionId}': mcp(
    'manage_docker_compose:revision_get'
  ),
  'DELETE /api/docker/nodes/{nodeId}/compose-projects/{projectId}/revisions/{revisionId}': mcp(
    'manage_docker_compose:revision_delete'
  ),
  'GET /api/docker/nodes/{nodeId}/compose-projects/{projectId}/secrets': mcp('manage_docker_compose:secret_list'),
  'POST /api/docker/nodes/{nodeId}/compose-projects/{projectId}/secrets': mcp('manage_docker_compose:secret_create'),
  'PUT /api/docker/nodes/{nodeId}/compose-projects/{projectId}/secrets/{secretId}': mcp(
    'manage_docker_compose:secret_update'
  ),
  'DELETE /api/docker/nodes/{nodeId}/compose-projects/{projectId}/secrets/{secretId}': mcp(
    'manage_docker_compose:secret_delete'
  ),
  'GET /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source': mcp('manage_docker_source:get'),
  'PUT /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source': mcp('manage_docker_source:upsert'),
  'DELETE /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source': mcp('manage_docker_source:remove'),
  'GET /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source/build-secrets': mcp(
    'manage_docker_source:secret_list'
  ),
  'PUT /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source/build-secrets/{secretName}': mcp(
    'manage_docker_source:secret_upsert'
  ),
  'DELETE /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source/build-secrets/{secretName}': mcp(
    'manage_docker_source:secret_delete'
  ),
  'POST /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source/builds': mcp('manage_docker_source:build'),
  'POST /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source/resolve': mcp('manage_docker_source:resolve'),
  'POST /api/docker/nodes/{nodeId}/compose-projects/{projectId}/source/sync': mcp('manage_docker_source:sync'),
  'GET /api/docker/nodes/{nodeId}/compose/{project}/logs/stream': mcp('manage_docker_compose:logs'),
  'GET /api/docker/nodes/{nodeId}/containers': mcp('list_docker_containers'),
  'POST /api/docker/nodes/{nodeId}/containers': mcp('create_docker_container'),
  'POST /api/docker/nodes/{nodeId}/containers/archive': mcp(
    'upload_docker_container_archive:link',
    'upload_docker_container_archive:finalize'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/archive/plan': mcp('manage_docker_container:archive_plan_import'),
  'GET /api/docker/nodes/{nodeId}/containers/by-name/{containerName}': mcp('get_docker_container'),
  'GET /api/docker/nodes/{nodeId}/containers/gpu-usage': mcp('manage_docker_container:gpu_usage'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}': mcp('get_docker_container'),
  'DELETE /api/docker/nodes/{nodeId}/containers/{containerId}': mcp('remove_docker_container'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/archive': mcp(
    'download_docker_archive:link',
    'download_docker_archive:begin'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/duplicate': mcp('duplicate_docker_container'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/env': mcp('manage_docker_container_config:get_env'),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerId}/env': mcp('manage_docker_container_config:update_env'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/exec': mcp('execute_docker_container_console_command'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/files': mcp('manage_docker_container_config:list_files'),
  'DELETE /api/docker/nodes/{nodeId}/containers/{containerId}/files': mcp('manage_docker_container_config:delete_file'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/files/create': mcp(
    'manage_docker_container_config:create_file'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/files/directory': mcp(
    'manage_docker_container_config:create_directory'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/files/move': mcp(
    'manage_docker_container_config:move_file'
  ),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/files/read': mcp('manage_docker_container_config:read_file'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/files/uploads': mcp(
    'manage_docker_container_config:upload_init'
  ),
  'DELETE /api/docker/nodes/{nodeId}/containers/{containerId}/files/uploads/{uploadId}': mcp(
    'manage_docker_container_config:upload_abort'
  ),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerId}/files/uploads/{uploadId}/chunks': mcp(
    'manage_docker_container_config:upload_chunk'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/files/uploads/{uploadId}/complete': mcp(
    'manage_docker_container_config:upload_complete'
  ),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerId}/files/write': mcp(
    'manage_docker_container_config:write_file'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/kill': mcp('kill_docker_container'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/live-update': mcp('manage_docker_container:live_update'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/logs': mcp('get_docker_container_logs'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/logs/stream': mcp('get_docker_container_logs'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/recreate': mcp('manage_docker_container:recreate'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/rename': mcp('rename_docker_container'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/restart': mcp('restart_docker_container'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/secrets': mcp('manage_docker_container_config:list_secrets'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/secrets': mcp(
    'manage_docker_container_config:create_secret'
  ),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerId}/secrets/{secretId}': mcp(
    'manage_docker_container_config:update_secret'
  ),
  'DELETE /api/docker/nodes/{nodeId}/containers/{containerId}/secrets/{secretId}': mcp(
    'manage_docker_container_config:delete_secret'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/start': mcp('start_docker_container'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/stats': mcp('get_docker_container_stats'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/stats/history': mcp('manage_docker_container:stats_history'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/stop': mcp('stop_docker_container'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerId}/top': mcp('manage_docker_container:processes'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerId}/update': mcp(
    'manage_docker_container:update',
    'update_docker_container_image'
  ),
  'GET /api/docker/nodes/{nodeId}/containers/{containerName}/health-check': mcp(
    'manage_docker_container_config:get_health_check'
  ),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerName}/health-check': mcp(
    'manage_docker_container_config:upsert_health_check'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerName}/health-check/test': mcp(
    'manage_docker_container_config:test_health_check'
  ),
  'GET /api/docker/nodes/{nodeId}/containers/{containerName}/image-cleanup': mcp(
    'manage_docker_container:image_cleanup_get'
  ),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerName}/image-cleanup': mcp(
    'manage_docker_container:image_cleanup_upsert'
  ),
  'GET /api/docker/nodes/{nodeId}/containers/{containerName}/source': mcp('manage_docker_source:get'),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerName}/source': mcp('manage_docker_source:upsert'),
  'DELETE /api/docker/nodes/{nodeId}/containers/{containerName}/source': mcp('manage_docker_source:remove'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerName}/source/build-secrets': mcp(
    'manage_docker_source:secret_list'
  ),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerName}/source/build-secrets/{secretName}': mcp(
    'manage_docker_source:secret_upsert'
  ),
  'DELETE /api/docker/nodes/{nodeId}/containers/{containerName}/source/build-secrets/{secretName}': mcp(
    'manage_docker_source:secret_delete'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerName}/source/builds': mcp('manage_docker_source:build'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerName}/source/pending': mcp('manage_docker_source:pending'),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerName}/source/pending/volumes': mcp(
    'manage_docker_source:pending_volumes'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerName}/source/resolve': mcp('manage_docker_source:resolve'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerName}/source/rollback': mcp('manage_docker_source:rollback'),
  'POST /api/docker/nodes/{nodeId}/containers/{containerName}/source/sync': mcp('manage_docker_source:sync'),
  'GET /api/docker/nodes/{nodeId}/containers/{containerName}/webhook': mcp(
    'manage_docker_container_config:get_webhook'
  ),
  'PUT /api/docker/nodes/{nodeId}/containers/{containerName}/webhook': mcp(
    'manage_docker_container_config:upsert_webhook'
  ),
  'DELETE /api/docker/nodes/{nodeId}/containers/{containerName}/webhook': mcp(
    'manage_docker_container_config:delete_webhook'
  ),
  'POST /api/docker/nodes/{nodeId}/containers/{containerName}/webhook/regenerate': mcp(
    'manage_docker_container_config:regenerate_webhook_token'
  ),
  'GET /api/docker/nodes/{nodeId}/deployments': mcp('list_docker_deployments'),
  'POST /api/docker/nodes/{nodeId}/deployments': mcp('manage_docker_deployment:create'),
  'GET /api/docker/nodes/{nodeId}/deployments/by-name/{deploymentName}': mcp(
    'list_docker_deployments',
    'get_docker_deployment'
  ),
  'GET /api/docker/nodes/{nodeId}/deployments/{deploymentId}': mcp('get_docker_deployment'),
  'PUT /api/docker/nodes/{nodeId}/deployments/{deploymentId}': mcp('manage_docker_deployment:update'),
  'DELETE /api/docker/nodes/{nodeId}/deployments/{deploymentId}': mcp('manage_docker_deployment:delete'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/deploy': mcp('deploy_docker_deployment'),
  'GET /api/docker/nodes/{nodeId}/deployments/{deploymentId}/health-check': mcp(
    'manage_docker_container_config:get_health_check'
  ),
  'PUT /api/docker/nodes/{nodeId}/deployments/{deploymentId}/health-check': mcp(
    'manage_docker_container_config:upsert_health_check'
  ),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/health-check/test': mcp(
    'manage_docker_container_config:test_health_check'
  ),
  'GET /api/docker/nodes/{nodeId}/deployments/{deploymentId}/image-cleanup': mcp(
    'manage_docker_container:image_cleanup_get'
  ),
  'PUT /api/docker/nodes/{nodeId}/deployments/{deploymentId}/image-cleanup': mcp(
    'manage_docker_container:image_cleanup_upsert'
  ),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/kill': mcp('kill_docker_deployment'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/restart': mcp('restart_docker_deployment'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/rollback': mcp('rollback_docker_deployment'),
  'GET /api/docker/nodes/{nodeId}/deployments/{deploymentId}/secrets': mcp(
    'manage_docker_container_config:list_secrets'
  ),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/secrets': mcp(
    'manage_docker_container_config:create_secret'
  ),
  'PUT /api/docker/nodes/{nodeId}/deployments/{deploymentId}/secrets/{secretId}': mcp(
    'manage_docker_container_config:update_secret'
  ),
  'DELETE /api/docker/nodes/{nodeId}/deployments/{deploymentId}/secrets/{secretId}': mcp(
    'manage_docker_container_config:delete_secret'
  ),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/slots/{slot}/stop': mcp('stop_docker_deployment_slot'),
  'GET /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source': mcp('manage_docker_source:get'),
  'PUT /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source': mcp('manage_docker_source:upsert'),
  'DELETE /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source': mcp('manage_docker_source:remove'),
  'GET /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source/build-secrets': mcp(
    'manage_docker_source:secret_list'
  ),
  'PUT /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source/build-secrets/{secretName}': mcp(
    'manage_docker_source:secret_upsert'
  ),
  'DELETE /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source/build-secrets/{secretName}': mcp(
    'manage_docker_source:secret_delete'
  ),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source/builds': mcp('manage_docker_source:build'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source/resolve': mcp('manage_docker_source:resolve'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/source/sync': mcp('manage_docker_source:sync'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/start': mcp('start_docker_deployment'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/stop': mcp('stop_docker_deployment'),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/switch': mcp('switch_docker_deployment_slot'),
  'GET /api/docker/nodes/{nodeId}/deployments/{deploymentId}/webhook': mcp(
    'manage_docker_container_config:get_webhook'
  ),
  'PUT /api/docker/nodes/{nodeId}/deployments/{deploymentId}/webhook': mcp(
    'manage_docker_container_config:upsert_webhook'
  ),
  'DELETE /api/docker/nodes/{nodeId}/deployments/{deploymentId}/webhook': mcp(
    'manage_docker_container_config:delete_webhook'
  ),
  'POST /api/docker/nodes/{nodeId}/deployments/{deploymentId}/webhook/regenerate': mcp(
    'manage_docker_container_config:regenerate_webhook_token'
  ),
  'GET /api/docker/nodes/{nodeId}/images': mcp('list_docker_images'),
  'POST /api/docker/nodes/{nodeId}/images/prune': mcp('prune_docker_images'),
  'POST /api/docker/nodes/{nodeId}/images/pull': mcp('pull_docker_image'),
  'POST /api/docker/nodes/{nodeId}/images/pull-sync': mcp('pull_docker_image'),
  'DELETE /api/docker/nodes/{nodeId}/images/{imageId}': mcp('remove_docker_image'),
  'GET /api/docker/nodes/{nodeId}/managed-volumes': mcp('manage_docker_volume:managed_options'),
  'GET /api/docker/nodes/{nodeId}/networks': mcp('list_docker_networks'),
  'POST /api/docker/nodes/{nodeId}/networks': mcp('manage_docker_network:create'),
  'DELETE /api/docker/nodes/{nodeId}/networks/{networkId}': mcp('manage_docker_network:delete'),
  'POST /api/docker/nodes/{nodeId}/networks/{networkId}/connect': mcp('manage_docker_network:connect'),
  'POST /api/docker/nodes/{nodeId}/networks/{networkId}/disconnect': mcp('manage_docker_network:disconnect'),
  'POST /api/docker/nodes/{nodeId}/runtime/runsc/install': mcp('manage_docker_runtime:install'),
  'POST /api/docker/nodes/{nodeId}/runtime/runsc/preflight': mcp('manage_docker_runtime:preflight'),
  'POST /api/docker/nodes/{nodeId}/source-resources': mcp('manage_docker_source:create'),
  'GET /api/docker/nodes/{nodeId}/source-resources/admission': mcp('manage_docker_source:admission'),
  'GET /api/docker/nodes/{nodeId}/volumes': mcp('list_docker_volumes'),
  'POST /api/docker/nodes/{nodeId}/volumes': mcp('manage_docker_volume:create'),
  'GET /api/docker/nodes/{nodeId}/volumes/{name}': mcp('manage_docker_volume:inspect'),
  'DELETE /api/docker/nodes/{nodeId}/volumes/{name}': mcp('manage_docker_volume:delete'),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/adopt': mcp('manage_docker_volume:adopt'),
  'GET /api/docker/nodes/{nodeId}/volumes/{name}/export': mcp(
    'download_docker_archive:link',
    'download_docker_archive:begin'
  ),
  'GET /api/docker/nodes/{nodeId}/volumes/{name}/files': mcp('manage_docker_volume:list_files'),
  'DELETE /api/docker/nodes/{nodeId}/volumes/{name}/files': mcp('manage_docker_volume:delete_file'),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/files/create': mcp('manage_docker_volume:create_file'),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/files/directory': mcp('manage_docker_volume:create_directory'),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/files/move': mcp('manage_docker_volume:move_file'),
  'GET /api/docker/nodes/{nodeId}/volumes/{name}/files/read': mcp('manage_docker_volume:read_file'),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/files/uploads': mcp('manage_docker_volume:upload_init'),
  'DELETE /api/docker/nodes/{nodeId}/volumes/{name}/files/uploads/{uploadId}': mcp('manage_docker_volume:upload_abort'),
  'PUT /api/docker/nodes/{nodeId}/volumes/{name}/files/uploads/{uploadId}/chunks': mcp(
    'manage_docker_volume:upload_chunk'
  ),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/files/uploads/{uploadId}/complete': mcp(
    'manage_docker_volume:upload_complete'
  ),
  'PUT /api/docker/nodes/{nodeId}/volumes/{name}/files/write': mcp('manage_docker_volume:write_file'),
  'PUT /api/docker/nodes/{nodeId}/volumes/{name}/labels': mcp('manage_docker_volume:update_labels'),
  'GET /api/docker/nodes/{nodeId}/volumes/{name}/metrics': mcp('manage_docker_volume:metrics'),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/rename': mcp('manage_docker_volume:rename'),
  'POST /api/docker/nodes/{nodeId}/volumes/{name}/resize': mcp('manage_docker_volume:resize'),
  'GET /api/docker/registries': mcp('manage_docker_registry:list'),
  'POST /api/docker/registries': mcp('manage_docker_registry:create'),
  'POST /api/docker/registries/internal/gc': mcp('manage_docker_registry:internal_gc'),
  'POST /api/docker/registries/internal/maintenance/{runId}/resume': mcp(
    'manage_docker_registry:internal_resume_maintenance'
  ),
  'GET /api/docker/registries/internal/repositories': mcp('manage_docker_registry:internal_repositories'),
  'PUT /api/docker/registries/internal/settings': mcp('manage_docker_registry:internal_update_settings'),
  'GET /api/docker/registries/internal/state': mcp('manage_docker_registry:internal_get'),
  'POST /api/docker/registries/test': mcp('manage_docker_registry:test_direct'),
  'PUT /api/docker/registries/{id}': mcp('manage_docker_registry:update'),
  'DELETE /api/docker/registries/{id}': mcp('manage_docker_registry:delete'),
  'POST /api/docker/registries/{id}/test': mcp('manage_docker_registry:test'),
  'GET /api/docker/registry/token': excluded(
    'machine',
    'Registry token service called by the Docker engine with its own credential.'
  ),
  'POST /api/docker/snapshots/refresh': mcp('refresh_docker_snapshot'),
  'GET /api/docker/sources/connectors': mcp('manage_docker_source:connectors'),
  'GET /api/docker/sources/connectors/{connectorId}/repositories': mcp('manage_docker_source:repositories'),
  'GET /api/docker/tasks': mcp('manage_docker_task:list'),
  'GET /api/docker/tasks/{id}': mcp('manage_docker_task:get'),
  'POST /api/docker/tasks/{id}/force-cancel': mcp('force_cancel_docker_task'),
  'GET /api/docker/volumes': mcp('list_docker_volumes'),
  // /api/domains
  'GET /api/domains': mcp('list_domains'),
  'POST /api/domains': mcp('create_domain'),
  'GET /api/domains/folders': mcp('list_resource_folders'),
  'POST /api/domains/folders': mcp('manage_resource_folder:create'),
  'POST /api/domains/folders/move-domains': mcp('manage_resource_folder:move_resources'),
  'PUT /api/domains/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/domains/folders/reorder-domains': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/domains/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/domains/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/domains/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/domains/nginx-nodes': mcp('manage_domain:list_nginx_nodes'),
  'POST /api/domains/preview': mcp('manage_domain:preview'),
  'GET /api/domains/search': mcp('list_domains'),
  'GET /api/domains/{id}': mcp('manage_domain:get'),
  'PUT /api/domains/{id}': mcp('manage_domain:update'),
  'DELETE /api/domains/{id}': mcp('delete_domain'),
  'POST /api/domains/{id}/check-dns': mcp('manage_domain:check_dns'),
  'POST /api/domains/{id}/cloudflare-migration/resolve': mcp('manage_domain:resolve_cloudflare_migration'),
  'POST /api/domains/{id}/ingress-migration': mcp('manage_domain:migrate_ingress'),
  'POST /api/domains/{id}/ingress-migration/preview': mcp('manage_domain:preview_ingress_migration'),
  'POST /api/domains/{id}/ingress-placement': mcp('manage_ingress_group:convert_domain', 'manage_domain:update'),
  'POST /api/domains/{id}/issue-cert': mcp('manage_domain:issue_certificate'),
  // /api/events
  'GET /api/events': excluded('machine', 'Console realtime event socket.'),
  // /api/finalize-setup
  'GET /api/finalize-setup': OWNER_SETUP_CHECKLIST,
  'GET /api/finalize-setup/mfa-reminder': OWNER_SETUP_CHECKLIST,
  'POST /api/finalize-setup/mfa-reminder/hide': OWNER_SETUP_CHECKLIST,
  'PUT /api/finalize-setup/steps/{step}': OWNER_SETUP_CHECKLIST,
  // /api/hosting
  'GET /api/hosting/node-bindings': mcp('manage_hosting:node_bindings'),
  'GET /api/hosting/nodes/{id}': mcp('manage_hosting:node_get'),
  'GET /api/hosting/nodes/{id}/firewall': mcp('manage_hosting:node_firewall_get'),
  'PUT /api/hosting/nodes/{id}/firewall': mcp('manage_hosting:node_firewall_update'),
  'POST /api/hosting/operations': mcp('manage_hosting:provision'),
  'GET /api/hosting/operations/{id}': mcp('manage_hosting:operation_get'),
  'POST /api/hosting/operations/{id}/reconcile': mcp('manage_hosting:operation_reconcile'),
  'POST /api/hosting/operations/{id}/retry-install': mcp('manage_hosting:operation_retry_install'),
  'POST /api/hosting/resources/{id}/actions': mcp('manage_hosting:resource_action'),
  'GET /api/hosting/resources/{id}/snapshot-folders': mcp('manage_hosting:snapshot_folders'),
  'POST /api/hosting/resources/{id}/snapshot-folders/actions': mcp('manage_hosting:snapshot_folder_action'),
  'GET /api/hosting/resources/{id}/snapshots': mcp('manage_hosting:snapshots_list'),
  'POST /api/hosting/resources/{id}/snapshots/actions': mcp('manage_hosting:snapshot_action'),
  // /api/housekeeping
  'GET /api/housekeeping/config': mcp('manage_housekeeping:get_config'),
  'PUT /api/housekeeping/config': mcp('manage_housekeeping:update_config'),
  'GET /api/housekeeping/history': mcp('manage_housekeeping:get_history'),
  'POST /api/housekeeping/run': mcp('manage_housekeeping:run'),
  'GET /api/housekeeping/stats': mcp('manage_housekeeping:get_stats'),
  // /api/inference
  'GET /api/inference/catalog': mcp('manage_inference_usage:catalog'),
  'POST /api/inference/core/check-updates': mcp('manage_inference_provider:core_check_updates'),
  'POST /api/inference/core/install': mcp('manage_inference_provider:core_install'),
  'POST /api/inference/core/repair': mcp('manage_inference_provider:core_repair'),
  'GET /api/inference/core/status': mcp('manage_inference_provider:core_status'),
  'POST /api/inference/core/update': mcp('manage_inference_provider:core_update'),
  'GET /api/inference/limits': mcp('manage_inference_limits:list_policies'),
  'PUT /api/inference/limits/default': mcp('manage_inference_limits:set_default'),
  'GET /api/inference/limits/users': mcp('manage_inference_limits:list_users'),
  'PUT /api/inference/limits/users/{id}': mcp('manage_inference_limits:set_user'),
  'DELETE /api/inference/limits/users/{id}': mcp('manage_inference_limits:remove_user'),
  'POST /api/inference/limits/users/{id}/reset': mcp('manage_inference_limits:reset_user'),
  'GET /api/inference/models': mcp('manage_inference_model:list'),
  'POST /api/inference/models/configuration': mcp('manage_inference_model:save'),
  'PUT /api/inference/models/reorder': mcp('manage_inference_model:reorder'),
  'DELETE /api/inference/models/{id}': mcp('manage_inference_model:delete'),
  'PUT /api/inference/models/{id}/configuration': mcp('manage_inference_model:save'),
  'GET /api/inference/models/{id}/suggestions': mcp('manage_inference_model:suggestions'),
  'GET /api/inference/providers/catalog': mcp('manage_inference_provider:list_templates'),
  'GET /api/inference/providers/connections': mcp('manage_inference_provider:list_connections'),
  'POST /api/inference/providers/connections': mcp('manage_inference_provider:connect_api_key'),
  'PATCH /api/inference/providers/connections/{id}': mcp('manage_inference_provider:update'),
  'DELETE /api/inference/providers/connections/{id}': mcp('manage_inference_provider:disconnect'),
  'POST /api/inference/providers/connections/{id}/sync': mcp('manage_inference_provider:sync'),
  'POST /api/inference/providers/oauth/start': mcp('manage_inference_provider:start_authorization'),
  'GET /api/inference/providers/oauth/{id}': mcp('manage_inference_provider:authorization_status'),
  'POST /api/inference/providers/oauth/{id}/cancel': mcp('manage_inference_provider:cancel_authorization'),
  'POST /api/inference/providers/oauth/{id}/complete': mcp('manage_inference_provider:complete_authorization'),
  'PATCH /api/inference/providers/{providerId}/routing': mcp('manage_inference_provider:set_routing'),
  'GET /api/inference/tokens': mcp('manage_inference_token:list'),
  'POST /api/inference/tokens': mcp('manage_inference_token:create'),
  'PATCH /api/inference/tokens/{id}': mcp('manage_inference_token:update'),
  'DELETE /api/inference/tokens/{id}': mcp('manage_inference_token:revoke'),
  'GET /api/inference/usage/activity': mcp('manage_inference_usage:activity'),
  'GET /api/inference/usage/activity/filters': mcp('manage_inference_usage:activity_filters'),
  'GET /api/inference/usage/self': mcp('manage_inference_usage:self'),
  'GET /api/inference/usage/self/overview': mcp('manage_inference_usage:self_overview'),
  'GET /api/inference/usage/system': mcp('manage_inference_usage:system'),
  'GET /api/inference/usage/users': mcp('manage_inference_usage:users'),
  'POST /api/inference/v1/alpha/search': INFERENCE_DATA_PLANE,
  'POST /api/inference/v1/chat/completions': INFERENCE_DATA_PLANE,
  'POST /api/inference/v1/images/edits': INFERENCE_DATA_PLANE,
  'POST /api/inference/v1/images/generations': INFERENCE_DATA_PLANE,
  'POST /api/inference/v1/live': INFERENCE_DATA_PLANE,
  'POST /api/inference/v1/messages': INFERENCE_DATA_PLANE,
  'POST /api/inference/v1/messages/count_tokens': INFERENCE_DATA_PLANE,
  'GET /api/inference/v1/models': excluded(
    'machine',
    'Inference data plane model list called by clients with their inference key.'
  ),
  'POST /api/inference/v1/realtime/calls': INFERENCE_DATA_PLANE,
  'GET /api/inference/v1/responses': excluded(
    'machine',
    'Inference data plane Responses socket called by clients with their inference key.'
  ),
  'POST /api/inference/v1/responses': INFERENCE_DATA_PLANE,
  'POST /api/inference/v1/responses/compact': INFERENCE_DATA_PLANE,
  'GET /api/inference/v1/usage': mcp('manage_inference_usage:self', 'manage_inference_usage:self_overview'),
  // /api/ingress-groups
  'GET /api/ingress-groups': mcp('manage_ingress_group:list'),
  'POST /api/ingress-groups': mcp('manage_ingress_group:create'),
  'GET /api/ingress-groups/{id}': mcp('manage_ingress_group:get'),
  'PUT /api/ingress-groups/{id}': mcp('manage_ingress_group:update'),
  'DELETE /api/ingress-groups/{id}': mcp('manage_ingress_group:delete'),
  'POST /api/ingress-groups/{id}/domains': mcp('manage_ingress_group:convert_domain'),
  'POST /api/ingress-groups/{id}/members': mcp('manage_ingress_group:add_member'),
  'PUT /api/ingress-groups/{id}/members/order': mcp('manage_ingress_group:reorder'),
  'DELETE /api/ingress-groups/{id}/members/{nodeId}': mcp('manage_ingress_group:remove_member'),
  'POST /api/ingress-groups/{id}/routes': mcp('manage_ingress_group:convert_route'),
  // /api/integrations
  'GET /api/integrations/cloudflare/connectors': mcp('list_integration_connectors'),
  'POST /api/integrations/cloudflare/connectors': mcp('create_cloudflare_connector'),
  'POST /api/integrations/cloudflare/connectors/preview-test': mcp('manage_integration_connector:preview_test'),
  'GET /api/integrations/cloudflare/connectors/{id}': mcp('manage_integration_connector:get'),
  'PATCH /api/integrations/cloudflare/connectors/{id}': mcp('manage_integration_connector:update'),
  'DELETE /api/integrations/cloudflare/connectors/{id}': mcp('manage_integration_connector:delete'),
  'POST /api/integrations/cloudflare/connectors/{id}/sync': mcp('sync_integration_connector'),
  'POST /api/integrations/cloudflare/connectors/{id}/test': mcp('manage_integration_connector:test'),
  'POST /api/integrations/cloudflare/connectors/{id}/token': mcp('manage_integration_connector:rotate_token'),
  'GET /api/integrations/cloudflare/connectors/{id}/zones': mcp('manage_integration_connector:list_zones'),
  'GET /api/integrations/git/connectors': mcp('list_integration_connectors', 'git_list_connectors'),
  'POST /api/integrations/git/connectors': mcp('create_git_connector'),
  'POST /api/integrations/git/connectors/preview-test': mcp('manage_integration_connector:preview_test'),
  'PATCH /api/integrations/git/connectors/{id}': mcp('manage_integration_connector:update'),
  'DELETE /api/integrations/git/connectors/{id}': mcp('manage_integration_connector:delete'),
  'POST /api/integrations/git/connectors/{id}/sync': mcp('sync_integration_connector'),
  'POST /api/integrations/git/connectors/{id}/test': mcp('manage_integration_connector:test'),
  'GET /api/integrations/git/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'POST /api/integrations/git/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'DELETE /api/integrations/git/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'GET /api/integrations/github/connectors': mcp('list_integration_connectors', 'github_list_connectors'),
  'POST /api/integrations/github/connectors': mcp('create_github_token_connector'),
  'POST /api/integrations/github/connectors/preview-test': mcp('manage_integration_connector:preview_test'),
  'PATCH /api/integrations/github/connectors/{id}': mcp('manage_integration_connector:update'),
  'DELETE /api/integrations/github/connectors/{id}': mcp('manage_integration_connector:delete'),
  'POST /api/integrations/github/connectors/{id}/sync': mcp('sync_integration_connector'),
  'POST /api/integrations/github/connectors/{id}/test': mcp('manage_integration_connector:test'),
  'GET /api/integrations/github/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'POST /api/integrations/github/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'DELETE /api/integrations/github/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'GET /api/integrations/github/oauth': mcp('manage_integration_connector:oauth_availability'),
  'POST /api/integrations/github/oauth/sessions': mcp('manage_integration_connector:oauth_start'),
  'GET /api/integrations/github/oauth/sessions/{id}': mcp('manage_integration_connector:oauth_status'),
  'DELETE /api/integrations/github/oauth/sessions/{id}': mcp('manage_integration_connector:oauth_cancel'),
  'POST /api/integrations/gitlab/allowlist/preview-search': mcp(
    'manage_integration_connector:allowlist_preview_search'
  ),
  'GET /api/integrations/gitlab/connectors': mcp('list_integration_connectors', 'gitlab_list_connectors'),
  'POST /api/integrations/gitlab/connectors': mcp('create_gitlab_connector'),
  'POST /api/integrations/gitlab/connectors/preview-test': mcp('manage_integration_connector:preview_test'),
  'GET /api/integrations/gitlab/connectors/{id}': mcp('manage_integration_connector:get'),
  'PATCH /api/integrations/gitlab/connectors/{id}': mcp('manage_integration_connector:update'),
  'DELETE /api/integrations/gitlab/connectors/{id}': mcp('manage_integration_connector:delete'),
  'GET /api/integrations/gitlab/connectors/{id}/allowlist/options': mcp(
    'manage_integration_connector:allowlist_options'
  ),
  'POST /api/integrations/gitlab/connectors/{id}/allowlist/options/refresh': mcp(
    'manage_integration_connector:allowlist_refresh'
  ),
  'GET /api/integrations/gitlab/connectors/{id}/allowlist/search': mcp('manage_integration_connector:allowlist_search'),
  'GET /api/integrations/gitlab/connectors/{id}/capabilities': mcp('manage_integration_connector:capabilities'),
  'POST /api/integrations/gitlab/connectors/{id}/sync': mcp('sync_integration_connector', 'gitlab_sync_connector'),
  'POST /api/integrations/gitlab/connectors/{id}/test': mcp('manage_integration_connector:test'),
  'POST /api/integrations/gitlab/connectors/{id}/token': mcp('manage_integration_connector:rotate_token'),
  'GET /api/integrations/gitlab/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'PUT /api/integrations/gitlab/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'DELETE /api/integrations/gitlab/connectors/{id}/user-credential': OWN_GIT_CREDENTIAL,
  'GET /api/integrations/hosting': mcp('manage_hosting:connector_list'),
  'POST /api/integrations/hosting': mcp('manage_hosting:connector_create'),
  'POST /api/integrations/hosting/discover': mcp('manage_hosting:connector_discover'),
  'POST /api/integrations/hosting/test': mcp('manage_hosting:connector_preview'),
  'GET /api/integrations/hosting/{id}': mcp('manage_hosting:connector_get'),
  'PUT /api/integrations/hosting/{id}': mcp('manage_hosting:connector_update'),
  'DELETE /api/integrations/hosting/{id}': mcp('manage_hosting:connector_delete'),
  'GET /api/integrations/hosting/{id}/account-summary': mcp('manage_hosting:account_summary'),
  'POST /api/integrations/hosting/{id}/adopt': mcp('manage_hosting:adopt'),
  'GET /api/integrations/hosting/{id}/adoption-candidates': mcp('manage_hosting:adoption_candidates'),
  'GET /api/integrations/hosting/{id}/catalog': mcp('manage_hosting:catalog'),
  'GET /api/integrations/hosting/{id}/configuration': mcp('manage_hosting:connector_configuration'),
  'GET /api/integrations/hosting/{id}/operations': mcp('manage_hosting:operations_list'),
  'GET /api/integrations/hosting/{id}/resources': mcp('manage_hosting:resources'),
  'POST /api/integrations/hosting/{id}/sync': mcp('manage_hosting:connector_sync'),
  'POST /api/integrations/hosting/{id}/test': mcp('manage_hosting:connector_test'),
  'GET /api/integrations/ssh/connectors': mcp('ssh_list_connectors', 'list_integration_connectors'),
  'POST /api/integrations/ssh/connectors': mcp('create_ssh_connector'),
  'POST /api/integrations/ssh/connectors/host-key': mcp('manage_integration_connector:discover_host_key'),
  'PATCH /api/integrations/ssh/connectors/{id}': mcp('manage_integration_connector:update'),
  'DELETE /api/integrations/ssh/connectors/{id}': mcp('manage_integration_connector:delete'),
  'POST /api/integrations/ssh/connectors/{id}/sync': mcp('sync_integration_connector'),
  'POST /api/integrations/ssh/connectors/{id}/test': mcp('manage_integration_connector:test'),
  'GET /api/integrations/{provider}/{connectorId}/scope-targets': mcp(
    'manage_integration_connector:scope_target_search'
  ),
  'GET /api/integrations/{provider}/{connectorId}/scope-targets/lookup': mcp('find_git_scope_target'),
  'GET /api/integrations/{provider}/{connectorId}/scope-targets/resolve': mcp(
    'manage_integration_connector:scope_target_resolve'
  ),
  // /api/mcp
  'GET /api/mcp': MCP_TRANSPORT,
  'POST /api/mcp': MCP_TRANSPORT,
  'DELETE /api/mcp': MCP_TRANSPORT,
  'GET /api/mcp/.well-known/oauth-authorization-server': OAUTH_DISCOVERY,
  'GET /api/mcp/.well-known/oauth-authorization-server/api/mcp': OAUTH_DISCOVERY,
  'GET /api/mcp/.well-known/oauth-protected-resource': OAUTH_DISCOVERY,
  'GET /api/mcp/.well-known/oauth-protected-resource/api': OAUTH_DISCOVERY,
  'GET /api/mcp/.well-known/oauth-protected-resource/api/mcp': OAUTH_DISCOVERY,
  'GET /api/mcp/.well-known/openid-configuration': OAUTH_DISCOVERY,
  'GET /api/mcp/.well-known/openid-configuration/api/mcp': OAUTH_DISCOVERY,
  // /api/monitoring
  'GET /api/monitoring/dashboard': mcp('get_dashboard_stats'),
  'POST /api/monitoring/dashboard/bootstrap': mcp('get_dashboard_stats'),
  'GET /api/monitoring/health-status': mcp('list_routes'),
  'GET /api/monitoring/logs/{hostId}/stream': mcp('manage_route:access_logs'),
  'GET /api/monitoring/logs/{hostId}/ws': mcp('manage_route:access_logs'),
  // /api/nginx-templates
  'GET /api/nginx-templates': mcp('manage_proxy_template:list'),
  'POST /api/nginx-templates': mcp('manage_proxy_template:create'),
  'GET /api/nginx-templates/folders': mcp('list_resource_folders'),
  'POST /api/nginx-templates/folders': mcp('manage_resource_folder:create'),
  'POST /api/nginx-templates/folders/move-templates': mcp('manage_resource_folder:move_resources'),
  'PUT /api/nginx-templates/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/nginx-templates/folders/reorder-templates': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/nginx-templates/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/nginx-templates/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/nginx-templates/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'POST /api/nginx-templates/preview': mcp('manage_proxy_template:preview'),
  'POST /api/nginx-templates/test': mcp('manage_proxy_template:test'),
  'GET /api/nginx-templates/{id}': mcp('manage_proxy_template:get'),
  'PUT /api/nginx-templates/{id}': mcp('manage_proxy_template:update'),
  'DELETE /api/nginx-templates/{id}': mcp('manage_proxy_template:delete'),
  'POST /api/nginx-templates/{id}/clone': mcp('manage_proxy_template:clone'),
  // /api/nodes
  'GET /api/nodes': mcp('list_nodes'),
  'POST /api/nodes': mcp('create_node'),
  'GET /api/nodes/by-slug/{slug}': mcp('get_node'),
  'GET /api/nodes/folders': mcp('list_resource_folders'),
  'POST /api/nodes/folders': mcp('manage_resource_folder:create'),
  'POST /api/nodes/folders/move-nodes': mcp('manage_resource_folder:move_resources'),
  'PUT /api/nodes/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/nodes/folders/reorder-nodes': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/nodes/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/nodes/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/nodes/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/nodes/{id}': mcp('get_node'),
  'PATCH /api/nodes/{id}': mcp('manage_node:update', 'rename_node'),
  'DELETE /api/nodes/{id}': mcp('delete_node'),
  'GET /api/nodes/{id}/config': mcp('manage_node_config:read'),
  'PUT /api/nodes/{id}/config': mcp('manage_node_config:update'),
  'POST /api/nodes/{id}/config/test': mcp('manage_node_config:test'),
  'POST /api/nodes/{id}/enrollment-token': mcp('manage_node:regenerate_enrollment_token'),
  'GET /api/nodes/{id}/files': mcp('manage_node_file:list'),
  'DELETE /api/nodes/{id}/files': mcp('manage_node_file:delete'),
  'POST /api/nodes/{id}/files/create': mcp('manage_node_file:create'),
  'POST /api/nodes/{id}/files/directory': mcp('manage_node_file:mkdir'),
  'POST /api/nodes/{id}/files/move': mcp('manage_node_file:move'),
  'GET /api/nodes/{id}/files/read': mcp('manage_node_file:read'),
  'POST /api/nodes/{id}/files/uploads': mcp('manage_node_file:upload_init'),
  'DELETE /api/nodes/{id}/files/uploads/{uploadId}': mcp('manage_node_file:upload_abort'),
  'PUT /api/nodes/{id}/files/uploads/{uploadId}/chunks': mcp('manage_node_file:upload_chunk'),
  'POST /api/nodes/{id}/files/uploads/{uploadId}/complete': mcp('manage_node_file:upload_complete'),
  'PUT /api/nodes/{id}/files/write': mcp('manage_node_file:write'),
  'GET /api/nodes/{id}/health-history': mcp('manage_node:health_history'),
  'GET /api/nodes/{id}/logs': mcp('manage_node:daemon_logs'),
  'GET /api/nodes/{id}/monitoring/stream': mcp('get_node', 'manage_node:monitoring_history'),
  'GET /api/nodes/{id}/nginx-logs': mcp('manage_node:nginx_logs'),
  'PATCH /api/nodes/{id}/service-creation-lock': mcp('set_node_service_creation_lock'),
  'GET /api/nodes/{nodeId}/exec': mcp('execute_node_console_command'),
  'GET /api/nodes/{nodeId}/nginx-logs/ws': mcp('manage_node:nginx_logs'),
  // /api/notifications
  'GET /api/notifications/alert-rules': mcp('list_alert_rules'),
  'POST /api/notifications/alert-rules': mcp('create_alert_rule'),
  'GET /api/notifications/alert-rules/categories': mcp('manage_notifications:alert_categories'),
  'GET /api/notifications/alert-rules/categories/{category}/resources': mcp('manage_notifications:alert_resources'),
  'GET /api/notifications/alert-rules/folders': mcp('list_resource_folders'),
  'POST /api/notifications/alert-rules/folders': mcp('manage_resource_folder:create'),
  'POST /api/notifications/alert-rules/folders/move-rules': mcp('manage_resource_folder:move_resources'),
  'PUT /api/notifications/alert-rules/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/notifications/alert-rules/folders/reorder-rules': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/notifications/alert-rules/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/notifications/alert-rules/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/notifications/alert-rules/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/notifications/alert-rules/{id}': mcp('get_alert_rule'),
  'PUT /api/notifications/alert-rules/{id}': mcp('update_alert_rule'),
  'DELETE /api/notifications/alert-rules/{id}': mcp('delete_alert_rule'),
  'GET /api/notifications/alerts': mcp('list_alerts'),
  'GET /api/notifications/deliveries': mcp('list_webhook_deliveries'),
  'GET /api/notifications/deliveries/stats': mcp('get_delivery_stats'),
  'GET /api/notifications/deliveries/{id}': mcp('manage_notifications:delivery_get'),
  'GET /api/notifications/webhooks': mcp('list_webhooks'),
  'POST /api/notifications/webhooks': mcp('create_webhook'),
  'GET /api/notifications/webhooks/folders': mcp('list_resource_folders'),
  'POST /api/notifications/webhooks/folders': mcp('manage_resource_folder:create'),
  'POST /api/notifications/webhooks/folders/move-webhooks': mcp('manage_resource_folder:move_resources'),
  'PUT /api/notifications/webhooks/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/notifications/webhooks/folders/reorder-webhooks': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/notifications/webhooks/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/notifications/webhooks/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/notifications/webhooks/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'GET /api/notifications/webhooks/presets': mcp('manage_notifications:webhook_presets'),
  'POST /api/notifications/webhooks/preview': mcp('manage_notifications:webhook_preview'),
  'GET /api/notifications/webhooks/{id}': mcp('manage_notifications:webhook_get'),
  'PUT /api/notifications/webhooks/{id}': mcp('update_webhook'),
  'DELETE /api/notifications/webhooks/{id}': mcp('delete_webhook'),
  'POST /api/notifications/webhooks/{id}/test': mcp('test_webhook'),
  // /api/oauth
  'GET /api/oauth/authorizations': OAUTH_GRANTS,
  'PATCH /api/oauth/authorizations/{authorizationId}': OAUTH_GRANTS,
  'DELETE /api/oauth/authorizations/{authorizationId}': OAUTH_GRANTS,
  'GET /api/oauth/authorize': excluded('oauth-protocol', 'OAuth authorization endpoint.'),
  'GET /api/oauth/authorize/api/mcp': excluded('oauth-protocol', 'OAuth authorization endpoint.'),
  'GET /api/oauth/consent/{requestId}': OAUTH_CONSENT,
  'POST /api/oauth/consent/{requestId}/approve': OAUTH_CONSENT,
  'POST /api/oauth/consent/{requestId}/deny': OAUTH_CONSENT,
  'POST /api/oauth/register': excluded('oauth-protocol', 'OAuth dynamic client registration.'),
  'POST /api/oauth/revoke': excluded('oauth-protocol', 'OAuth token revocation.'),
  'POST /api/oauth/token': excluded('oauth-protocol', 'OAuth token endpoint.'),
  // /api/openapi.json
  'GET /api/openapi.json': excluded('machine', 'API description document.'),
  // /api/pages-upload
  'POST /api/pages-upload/{token}': mcp('upload_pages_artifact:link'),
  'PUT /api/pages-upload/{token}': mcp('upload_pages_artifact:link'),
  // /api/proxy-host-folders
  'GET /api/proxy-host-folders': mcp('list_resource_folders'),
  'POST /api/proxy-host-folders': mcp('create_route_folder', 'manage_resource_folder:create'),
  'GET /api/proxy-host-folders/grouped': mcp('list_resource_folders', 'list_routes'),
  'POST /api/proxy-host-folders/move-hosts': mcp('move_routes_to_folder', 'manage_resource_folder:move_resources'),
  'PUT /api/proxy-host-folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/proxy-host-folders/reorder-hosts': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/proxy-host-folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/proxy-host-folders/{id}': mcp('delete_route_folder', 'manage_resource_folder:delete'),
  'PUT /api/proxy-host-folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  // /api/proxy-hosts
  'GET /api/proxy-hosts': mcp('list_routes'),
  'POST /api/proxy-hosts': mcp('create_route'),
  'GET /api/proxy-hosts/by-slug/{slug}': mcp('manage_route:get_by_slug'),
  'GET /api/proxy-hosts/ingress-nodes': mcp('list_route_ingress_nodes'),
  'POST /api/proxy-hosts/missing-domains': mcp('manage_route:missing_domains'),
  'POST /api/proxy-hosts/validate-config': mcp('manage_route:validate_config'),
  'GET /api/proxy-hosts/{id}': mcp('get_route', 'manage_route:get_config'),
  'PUT /api/proxy-hosts/{id}': mcp('update_route'),
  'DELETE /api/proxy-hosts/{id}': mcp('delete_route'),
  'GET /api/proxy-hosts/{id}/additional-routes': mcp('manage_additional_route:list'),
  'POST /api/proxy-hosts/{id}/additional-routes': mcp('manage_additional_route:create'),
  'GET /api/proxy-hosts/{id}/additional-routes/{routeId}': mcp('manage_additional_route:get'),
  'PUT /api/proxy-hosts/{id}/additional-routes/{routeId}': mcp('manage_additional_route:update'),
  'DELETE /api/proxy-hosts/{id}/additional-routes/{routeId}': mcp('manage_additional_route:delete'),
  'POST /api/proxy-hosts/{id}/additional-routes/{routeId}/retry': mcp('manage_additional_route:retry'),
  'GET /api/proxy-hosts/{id}/additional-secure-links': mcp('manage_additional_secure_link:list'),
  'POST /api/proxy-hosts/{id}/additional-secure-links': mcp('manage_additional_secure_link:create'),
  'DELETE /api/proxy-hosts/{id}/additional-secure-links/{bindingId}': mcp('manage_additional_secure_link:delete'),
  'POST /api/proxy-hosts/{id}/additional-secure-links/{bindingId}/retarget': mcp(
    'manage_additional_secure_link:retarget'
  ),
  'POST /api/proxy-hosts/{id}/additional-secure-links/{bindingId}/retry': mcp('manage_additional_secure_link:retry'),
  'GET /api/proxy-hosts/{id}/health-history': mcp('manage_route:health_history'),
  'POST /api/proxy-hosts/{id}/ingress-placement': mcp('manage_ingress_group:convert_route', 'update_route'),
  'POST /api/proxy-hosts/{id}/maintenance': mcp('set_route_maintenance'),
  'POST /api/proxy-hosts/{id}/maintenance-access-code': mcp('manage_route:maintenance_access_code'),
  'GET /api/proxy-hosts/{id}/rendered-config': mcp('get_route_rendered_config'),
  'GET /api/proxy-hosts/{id}/secure-link': mcp('manage_route:secure_link_status'),
  'POST /api/proxy-hosts/{id}/tls/resync': mcp('resync_tls_distribution'),
  'POST /api/proxy-hosts/{id}/toggle': mcp('update_route'),
  // /api/resources
  'GET /api/resources/search': mcp('find_resource'),
  // /api/settings
  'GET /api/settings/environment': mcp('get_opfield_settings'),
  'PATCH /api/settings/environment': mcp('update_opfield_settings'),
  // /api/setup
  'POST /api/setup/restore/owner-link': SETUP_WIZARD,
  'GET /api/setup/status': SETUP_WIZARD,
  'POST /api/setup/unlock': SETUP_WIZARD,
  'POST /api/setup/wizard/apply': SETUP_WIZARD,
  'POST /api/setup/wizard/complete': SETUP_WIZARD,
  'GET /api/setup/wizard/config': SETUP_WIZARD,
  'GET /api/setup/wizard/csrf': SETUP_WIZARD,
  'POST /api/setup/wizard/license/activate': SETUP_WIZARD,
  'POST /api/setup/wizard/license/community': SETUP_WIZARD,
  'GET /api/setup/wizard/restore': SETUP_WIZARD,
  'DELETE /api/setup/wizard/restore': SETUP_WIZARD,
  'PUT /api/setup/wizard/restore/archive': SETUP_WIZARD,
  'POST /api/setup/wizard/restore/start': SETUP_WIZARD,
  'POST /api/setup/wizard/restore/verify': SETUP_WIZARD,
  'POST /api/setup/wizard/session': SETUP_WIZARD,
  // /api/ssl-certificates
  'GET /api/ssl-certificates': mcp('list_ssl_certificates'),
  'POST /api/ssl-certificates/acme': mcp('request_acme_cert'),
  'GET /api/ssl-certificates/folders': mcp('list_resource_folders'),
  'POST /api/ssl-certificates/folders': mcp('manage_resource_folder:create'),
  'POST /api/ssl-certificates/folders/move-certificates': mcp('manage_resource_folder:move_resources'),
  'PUT /api/ssl-certificates/folders/reorder': mcp('manage_resource_folder:reorder_folders'),
  'PUT /api/ssl-certificates/folders/reorder-certificates': mcp('manage_resource_folder:reorder_resources'),
  'PUT /api/ssl-certificates/folders/{id}': mcp('manage_resource_folder:update'),
  'DELETE /api/ssl-certificates/folders/{id}': mcp('manage_resource_folder:delete'),
  'PUT /api/ssl-certificates/folders/{id}/move': mcp('manage_resource_folder:move_folder'),
  'POST /api/ssl-certificates/internal': mcp('link_internal_cert'),
  'POST /api/ssl-certificates/upload': mcp('manage_ssl_certificate:upload'),
  'GET /api/ssl-certificates/{id}': mcp('manage_ssl_certificate:get'),
  'DELETE /api/ssl-certificates/{id}': mcp('manage_ssl_certificate:delete'),
  'POST /api/ssl-certificates/{id}/acme-cancel': mcp('manage_ssl_certificate:cancel_acme'),
  'PATCH /api/ssl-certificates/{id}/auto-renew': mcp('manage_ssl_certificate:set_auto_renew'),
  'POST /api/ssl-certificates/{id}/distribution/resync': mcp('resync_tls_distribution'),
  'POST /api/ssl-certificates/{id}/dns-verify': mcp('manage_ssl_certificate:verify_dns'),
  'POST /api/ssl-certificates/{id}/renew': mcp('manage_ssl_certificate:renew'),
  // /api/status-page
  'PUT /api/status-page/settings': mcp('manage_status_page:update'),
  // /api/storage-object-link
  'GET /api/storage-object-link/{token}': mcp('download_storage_object'),
  // /api/system
  'POST /api/system/check-update': mcp('manage_system_updates:check_opfield'),
  'POST /api/system/cloud/connect': mcp('manage_cloud:connect'),
  'POST /api/system/cloud/disconnect': mcp('manage_cloud:disconnect'),
  'POST /api/system/cloud/remote-management': mcp('manage_cloud:set_remote_management'),
  'GET /api/system/cloud/status': mcp('get_cloud_status'),
  'GET /api/system/config': mcp('get_opfield_runtime:config'),
  'GET /api/system/configuration-export': mcp('manage_configuration_export:estimate'),
  'POST /api/system/configuration-export': mcp('manage_configuration_export:export'),
  'GET /api/system/configuration-export/move': mcp('manage_configuration_export:move_status'),
  'PUT /api/system/configuration-export/move': mcp(
    'manage_configuration_export:announce_move',
    'manage_configuration_export:withdraw_move'
  ),
  'GET /api/system/configuration-export/{id}': mcp('manage_configuration_export:progress'),
  'GET /api/system/daemon-updates': mcp('manage_system_updates:list_daemon_updates'),
  'POST /api/system/daemon-updates/check': mcp('manage_system_updates:check_daemon_updates'),
  'POST /api/system/daemon-updates/{nodeId}': mcp('manage_system_updates:update_daemon'),
  'POST /api/system/license/activate': mcp('manage_license:activate'),
  'POST /api/system/license/check': mcp('manage_license:check'),
  'DELETE /api/system/license/key': mcp('manage_license:clear'),
  'POST /api/system/license/module/activate': mcp('manage_license:activate_module'),
  'GET /api/system/license/status': mcp('get_license_status'),
  'GET /api/system/relay': mcp('manage_relay_pool:get'),
  'POST /api/system/relay-update': mcp('manage_system_updates:perform_relay_update'),
  'POST /api/system/relay-update/abandon': mcp('manage_system_updates:abandon_relay_update'),
  'PATCH /api/system/relay/instances/{instanceId}': mcp('manage_relay_pool:set_witness_hosting'),
  'POST /api/system/relay/instances/{instanceId}/drain': mcp('manage_relay_pool:drain_instance'),
  'POST /api/system/relay/instances/{instanceId}/force-disconnect': mcp('manage_relay_pool:force_disconnect_instance'),
  'POST /api/system/relay/instances/{instanceId}/reenroll': mcp('manage_relay_pool:reenroll_instance'),
  'POST /api/system/relay/instances/{instanceId}/renew-certificate': mcp('manage_relay_pool:renew_certificate'),
  'POST /api/system/relay/instances/{instanceId}/resume': mcp('manage_relay_pool:resume_instance'),
  'POST /api/system/relay/instances/{instanceId}/service-port': mcp('manage_relay_pool:set_service_port'),
  'POST /api/system/relay/rebalance': mcp('manage_relay_pool:rebalance'),
  'POST /api/system/relay/recovery': mcp('manage_relay_pool:retry_recovery'),
  'GET /api/system/release-notes': mcp('manage_system_updates:list_opfield_release_notes'),
  'GET /api/system/release-notes/{version}': mcp('manage_system_updates:get_opfield_release_notes'),
  'GET /api/system/status-page-upstream': mcp('manage_status_page:get_upstream'),
  'POST /api/system/update': mcp('manage_system_updates:perform_opfield_update'),
  'POST /api/system/update/acknowledge': mcp('manage_system_updates:acknowledge_opfield_update_failure'),
  'POST /api/system/update/proceed': mcp('manage_system_updates:proceed_opfield_update'),
  'GET /api/system/version': mcp('get_opfield_runtime:version', 'manage_system_updates:get_opfield_status'),
  // /api/tokens
  'GET /api/tokens': API_TOKENS,
  'POST /api/tokens': API_TOKENS,
  'GET /api/tokens/client-address': excluded(
    'token-minting',
    'Helper of the API token dialog (caller IP for token address limits).'
  ),
  'GET /api/tokens/registry-access': excluded(
    'token-minting',
    'Helper of the API token dialog (whether tokens can get registry access).'
  ),
  'PATCH /api/tokens/{id}': API_TOKENS,
  'DELETE /api/tokens/{id}': API_TOKENS,
  // /api/ui
  'GET /api/ui/bootstrap': mcp(
    'get_my_access',
    'list_nodes',
    'get_opfield_settings',
    'manage_status_page:get',
    'list_integration_connectors',
    'manage_system_updates:get_opfield_status',
    'get_ai_settings',
    'get_license_status',
    'manage_pages:profile_get',
    'list_apps'
  ),
  // /api/webhooks
  'POST /api/webhooks/docker-source/{sourceBindingId}': excluded(
    'machine',
    'Git provider push webhook receiver authenticated by its own secret.'
  ),
  'POST /api/webhooks/docker/{token}': excluded(
    'machine',
    'Docker image webhook receiver called by CI with its own token.'
  ),
  // /auth
  'GET /auth/avatars/{filename}': excluded(
    'machine',
    'Static avatar and app logo image files the console renders; their URLs are in the user and app records.'
  ),
  'GET /auth/callback': OWN_ACCOUNT,
  'GET /auth/csrf': OWN_ACCOUNT,
  'POST /auth/demo/request': OWN_ACCOUNT,
  'POST /auth/demo/verify': OWN_ACCOUNT,
  'POST /auth/email-otp/request': OWN_ACCOUNT,
  'POST /auth/email-otp/verify': OWN_ACCOUNT,
  'POST /auth/email/continue': OWN_ACCOUNT,
  'POST /auth/impersonation/stop': excluded('impersonation', 'Ends acting as another user.'),
  'GET /auth/login': OWN_ACCOUNT,
  'POST /auth/logout': OWN_ACCOUNT,
  'GET /auth/me': OWN_ACCOUNT,
  'PUT /auth/me/avatar': OWN_ACCOUNT,
  'DELETE /auth/me/avatar': OWN_ACCOUNT,
  'GET /auth/me/mfa': OWN_ACCOUNT,
  'POST /auth/me/mfa/recovery-codes': OWN_ACCOUNT,
  'POST /auth/me/mfa/recovery-codes/passkey/options': OWN_ACCOUNT,
  'POST /auth/me/mfa/recovery-codes/passkey/verify': OWN_ACCOUNT,
  'POST /auth/me/mfa/step-up': OWN_ACCOUNT,
  'POST /auth/me/mfa/step-up/passkey/options': OWN_ACCOUNT,
  'POST /auth/me/mfa/step-up/passkey/verify': OWN_ACCOUNT,
  'POST /auth/me/mfa/totp/confirm': OWN_ACCOUNT,
  'POST /auth/me/mfa/totp/reset': OWN_ACCOUNT,
  'POST /auth/me/mfa/totp/setup': OWN_ACCOUNT,
  'GET /auth/me/passkeys': OWN_ACCOUNT,
  'POST /auth/me/passkeys': OWN_ACCOUNT,
  'POST /auth/me/passkeys/options': OWN_ACCOUNT,
  'DELETE /auth/me/passkeys/{id}': OWN_ACCOUNT,
  'GET /auth/me/preferences': OWN_ACCOUNT,
  'PATCH /auth/me/preferences': OWN_ACCOUNT,
  'GET /auth/me/sessions': OWN_ACCOUNT,
  'POST /auth/me/sessions/revoke-others': OWN_ACCOUNT,
  'DELETE /auth/me/sessions/{id}': OWN_ACCOUNT,
  'GET /auth/methods': OWN_ACCOUNT,
  'POST /auth/mfa/enrollment/passkey/confirm': OWN_ACCOUNT,
  'POST /auth/mfa/enrollment/passkey/options': OWN_ACCOUNT,
  'POST /auth/mfa/enrollment/totp/confirm': OWN_ACCOUNT,
  'POST /auth/mfa/enrollment/totp/setup': OWN_ACCOUNT,
  'POST /auth/mfa/passkey/options': OWN_ACCOUNT,
  'POST /auth/mfa/passkey/verify': OWN_ACCOUNT,
  'POST /auth/mfa/verify': OWN_ACCOUNT,
  'POST /auth/passkeys/options': OWN_ACCOUNT,
  'POST /auth/passkeys/verify': OWN_ACCOUNT,
  'POST /auth/password/login': OWN_ACCOUNT,
  'POST /auth/password/reset/complete': OWN_ACCOUNT,
  'POST /auth/password/reset/profile': OWN_ACCOUNT,
  'POST /auth/password/reset/request': OWN_ACCOUNT,
  // /docs
  'GET /docs': excluded('machine', 'API documentation page.'),
  // /health
  'GET /health': excluded('machine', 'Health probe.'),
  // /openapi.json
  'GET /openapi.json': excluded('machine', 'API description document.'),
};
