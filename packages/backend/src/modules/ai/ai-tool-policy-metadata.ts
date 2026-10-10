import type {
  AIToolApprovalClass,
  AIToolDefinition,
  AIToolEffect,
  AIToolOperationArgumentPolicy,
  AIToolOperationPolicy,
} from './ai.types.js';

type OperationGroups = Partial<Record<AIToolApprovalClass | 'external', readonly string[]>>;

function operationPolicies(groups: OperationGroups): Record<string, AIToolOperationPolicy> {
  const result: Record<string, AIToolOperationPolicy> = {};
  for (const [group, operations] of Object.entries(groups)) {
    const effect: AIToolEffect =
      group === 'read' ? 'read' : group === 'delete' ? 'delete' : group === 'external' ? 'external' : 'write';
    const approvalClass: AIToolApprovalClass = group === 'external' ? 'destructive' : (group as AIToolApprovalClass);
    for (const operation of operations ?? []) result[operation] = { effect, approvalClass };
  }
  return result;
}

function withArgumentPolicy(
  policies: Record<string, AIToolOperationPolicy>,
  operation: string,
  argumentPolicy: AIToolOperationArgumentPolicy
): Record<string, AIToolOperationPolicy> {
  return { ...policies, [operation]: { ...policies[operation], argumentPolicy } };
}

// Credential reveals and key or secret exports are `execute`, like manage_ca export_key, so every
// approval mode except bypass-everything asks before secret material reaches the model.
const OPERATION_POLICIES: Record<string, Record<string, AIToolOperationPolicy>> = {
  manage_ca: operationPolicies({ update: ['update'], destructive: ['revoke'], execute: ['export_key'] }),
  manage_certificate: withArgumentPolicy(
    operationPolicies({ read: ['chain'], create: ['issue_from_csr'], execute: ['export'] }),
    'export',
    // Public formats are plain reads; the private-key formats export key material.
    {
      path: ['format'],
      approvalClasses: {
        pem: 'read',
        der: 'read',
        chain: 'read',
        fullchain: 'read',
        'private-key': 'execute',
        'pem-bundle': 'execute',
        pkcs12: 'execute',
        jks: 'execute',
      },
    }
  ),
  manage_template: operationPolicies({ read: ['get'], update: ['update'] }),
  manage_resource_folder: operationPolicies({
    create: ['create'],
    update: ['update', 'move_folder', 'reorder_folders', 'move_resources', 'reorder_resources'],
    delete: ['delete'],
  }),
  manage_proxy_template: operationPolicies({
    read: ['list', 'get', 'preview'],
    create: ['create', 'clone'],
    update: ['update'],
    delete: ['delete'],
    external: ['test'],
  }),
  manage_route: operationPolicies({
    read: ['get_config', 'get_by_slug', 'health_history', 'secure_link_status', 'access_logs', 'validate_config'],
    create: ['maintenance_access_code'],
  }),
  manage_ssl_certificate: operationPolicies({
    read: ['get'],
    update: ['upload', 'set_auto_renew', 'cancel_acme'],
    external: ['renew', 'verify_dns'],
    delete: ['delete'],
  }),
  manage_domain: operationPolicies({
    read: ['get', 'preview_ingress_migration', 'list_nginx_nodes', 'preview'],
    update: ['update'],
    external: ['check_dns', 'issue_certificate', 'resolve_cloudflare_migration'],
    execute: ['migrate_ingress'],
  }),
  manage_app: operationPolicies({ create: ['create'], update: ['update'], delete: ['delete'] }),
  manage_app_members: operationPolicies({ read: ['list'], update: ['place'] }),
  manage_app_environment: operationPolicies({
    read: ['list_nodes'],
    create: ['create', 'create_access_code'],
    update: ['rename', 'mark_production', 'set_maintenance', 'allow_node', 'remove_node'],
    delete: ['delete'],
  }),
  manage_ingress_group: operationPolicies({
    read: ['list', 'get'],
    create: ['create'],
    update: ['update', 'add_member', 'reorder', 'convert_route', 'convert_domain'],
    delete: ['delete', 'remove_member'],
  }),
  manage_access_list: operationPolicies({ read: ['get'], update: ['update'] }),
  manage_node_config: operationPolicies({ read: ['read'], update: ['update'], external: ['test'] }),
  manage_node_file: operationPolicies({
    read: ['list', 'read'],
    create: ['create', 'mkdir', 'upload_init'],
    update: ['write', 'move', 'upload_chunk', 'upload_complete'],
    delete: ['delete', 'upload_abort'],
  }),
  manage_ai_conversation: operationPolicies({ read: ['list', 'get'], delete: ['delete', 'delete_by_title'] }),
  manage_oauth_authorization: operationPolicies({ read: ['list'], update: ['update_scopes'], delete: ['revoke'] }),
  manage_api_token: operationPolicies({ read: ['list'], create: ['create'], update: ['update'], delete: ['revoke'] }),
  manage_license: operationPolicies({ external: ['activate', 'activate_module', 'check'], delete: ['clear'] }),
  manage_gateway_diagnostics: operationPolicies({ read: ['snapshot', 'history', 'requests', 'jobs', 'logs'] }),
  manage_housekeeping: operationPolicies({
    read: ['get_config', 'get_stats', 'get_history'],
    update: ['update_config'],
    execute: ['run'],
  }),
  manage_system_updates: operationPolicies({
    read: ['get_gateway_status', 'list_daemon_updates'],
    update: ['acknowledge_gateway_update_failure'],
    external: ['check_gateway', 'get_gateway_release_notes', 'list_gateway_release_notes', 'check_daemon_updates'],
    execute: [
      'perform_gateway_update',
      'proceed_gateway_update',
      'perform_relay_update',
      'abandon_relay_update',
      'update_daemon',
    ],
  }),
  manage_system_alerts: operationPolicies({ read: ['list'], update: ['dismiss'] }),
  manage_user: operationPolicies({
    read: ['list_sessions', 'list_deleted'],
    update: ['set_auth_method', 'rename', 'reset_avatar', 'restore'],
    external: ['send_password_link', 'send_invitation'],
    delete: ['revoke_session', 'revoke_all_sessions'],
    destructive: ['reset_mfa'],
  }),
  manage_node: operationPolicies({
    read: ['health_history', 'monitoring_history', 'daemon_logs', 'nginx_logs'],
    update: ['update', 'regenerate_enrollment_token'],
  }),
  manage_relay_pool: operationPolicies({
    read: ['get', 'local_policy_trust_status'],
    update: ['reenroll_instance'],
    execute: ['retry_recovery', 'rebalance', 'drain_instance', 'resume_instance', 'renew_certificate'],
    destructive: ['force_disconnect_instance'],
  }),
  manage_docker_registry: operationPolicies({
    read: ['list', 'get', 'internal_get', 'internal_repositories'],
    create: ['create'],
    update: ['update', 'internal_update_settings'],
    delete: ['delete'],
    external: ['test', 'test_direct'],
    execute: ['internal_gc', 'internal_resume_maintenance'],
  }),
  manage_docker_volume: operationPolicies({
    read: ['inspect', 'metrics', 'managed_options', 'list_files', 'read_file'],
    create: ['create', 'create_file', 'create_directory', 'upload_init'],
    update: [
      'resize',
      'adopt',
      'rename',
      'update_labels',
      'write_file',
      'move_file',
      'upload_chunk',
      'upload_complete',
    ],
    delete: ['delete', 'delete_file', 'upload_abort'],
  }),
  // Creating a link changes its consumer (a network joins it, variables recreate it); deleting takes the path away.
  manage_container_link: operationPolicies({
    read: ['list', 'get_runtime'],
    create: ['create'],
    delete: ['delete'],
  }),
  manage_docker_network: operationPolicies({
    create: ['create'],
    delete: ['delete', 'disconnect'],
    external: ['connect'],
  }),
  manage_docker_compose: withArgumentPolicy(
    operationPolicies({
      read: ['list', 'get', 'validate', 'revision_list', 'revision_get', 'operation_list', 'secret_list', 'logs'],
      create: ['create', 'adopt', 'revision_create', 'secret_create'],
      update: ['operation_start', 'secret_update'],
      delete: ['delete', 'revision_delete', 'secret_delete'],
    }),
    'operation_start',
    // Applying a revision runs new code; down removes the services and delete_volumes their data.
    {
      path: ['action'],
      approvalClasses: {
        start: 'update',
        stop: 'update',
        restart: 'update',
        cancel: 'update',
        apply: 'execute',
        pull_apply: 'execute',
        down: 'delete',
        delete_volumes: 'delete',
      },
    }
  ),
  manage_docker_source: operationPolicies({
    read: ['get', 'pending', 'admission', 'connectors', 'repositories', 'secret_list'],
    create: ['create'],
    update: ['upsert', 'secret_upsert'],
    delete: ['remove', 'secret_delete'],
    external: ['resolve'],
    execute: ['build', 'sync'],
  }),
  manage_docker_build: operationPolicies({
    read: ['get', 'logs'],
    execute: ['cancel', 'retry'],
  }),
  manage_docker_task: operationPolicies({ read: ['list', 'get'] }),
  manage_docker_deployment: operationPolicies({ create: ['create'], update: ['update'], delete: ['delete'] }),
  manage_docker_container_config: withArgumentPolicy(
    {
      ...operationPolicies({
        read: ['get_env', 'list_files', 'read_file', 'list_secrets', 'get_health_check'],
        create: ['create_secret', 'create_file', 'create_directory', 'upload_init'],
        update: [
          'update_env',
          'write_file',
          'move_file',
          'upload_chunk',
          'upload_complete',
          'update_secret',
          'upsert_health_check',
        ],
        // Each returns the webhook trigger token, a credential.
        execute: ['upsert_webhook', 'regenerate_webhook_token'],
        delete: ['delete_secret', 'delete_webhook', 'delete_file', 'upload_abort'],
        external: ['test_health_check'],
      }),
      get_webhook: { effect: 'read', approvalClass: 'execute' },
    },
    'list_secrets',
    // reveal: true returns the secret values.
    { path: ['reveal'], approvalClasses: { false: 'read', true: 'execute' } }
  ),
  manage_docker_container: operationPolicies({
    read: ['processes', 'stats_history', 'gpu_usage', 'image_cleanup_get', 'archive_plan_import'],
    update: ['live_update', 'image_cleanup_upsert'],
    execute: ['recreate', 'update'],
  }),
  manage_docker_availability: operationPolicies({
    read: ['preflight', 'get', 'get_by_resource', 'list_operations'],
    create: ['enable'],
    update: ['update'],
    execute: ['retry_operation'],
    delete: ['disable'],
  }),
  manage_docker_runtime: operationPolicies({ read: ['preflight'], execute: ['install'] }),
  upload_docker_container_archive: operationPolicies({
    create: ['link', 'begin'],
    update: ['chunk'],
    read: ['status'],
    execute: ['finalize'],
    delete: ['abort'],
  }),
  download_docker_archive: operationPolicies({
    read: ['status', 'chunk'],
    execute: ['link', 'begin'],
    delete: ['close'],
  }),
  manage_database_connection: operationPolicies({
    read: ['health_history', 'monitoring'],
    create: ['create'],
    update: ['update'],
    delete: ['delete'],
    external: ['test'],
    execute: ['reveal_credentials'],
  }),
  manage_postgres_data: operationPolicies({
    read: [
      'list_schemas',
      'list_tables',
      'table_metadata',
      'browse_rows',
      'list_extensions',
      'sql_list_namespaces',
      'sql_list_objects',
      'sql_table_metadata',
      'sql_browse_rows',
    ],
    create: ['insert_row', 'add_column', 'sql_insert_row'],
    update: ['update_row', 'update_column_type', 'enable_extension', 'sql_update_row'],
    delete: ['delete_row', 'delete_column', 'disable_extension', 'sql_delete_row'],
    execute: ['sql_execute'],
  }),
  manage_redis_data: operationPolicies({
    read: ['scan_keys', 'get_key'],
    update: ['set_key', 'expire_key'],
    delete: ['delete_key'],
    execute: ['execute_command'],
  }),
  manage_managed_database: operationPolicies({
    read: ['catalog', 'list', 'get', 'list_bindings', 'logs', 'get_binding_runtime', 'certificate_status'],
    create: ['create', 'create_binding'],
    update: ['update', 'retry', 'rotate_certificate'],
    // Rotation returns the new direct-access password.
    execute: ['restart', 'pause', 'unpause', 'reveal_credentials', 'reveal_binding_credentials', 'rotate_credentials'],
    delete: ['delete', 'delete_binding'],
  }),
  manage_pages: operationPolicies({
    read: [
      'profile_get',
      'profile_options',
      'project_list',
      'project_get',
      'project_get_by_slug',
      'project_placement_options',
      'deployment_list',
      'deployment_get',
      'deployment_links',
      'tag_list',
      'token_list',
      'config_list',
      'source_get',
      'source_repositories',
      'source_secret_list',
    ],
    create: ['project_create', 'token_create', 'source_secret_upsert'],
    update: [
      'profile_configure',
      'profile_disable',
      'project_update',
      'deployment_pin',
      'tag_move',
      'config_save_default',
      'config_save_tag',
      'config_reset_tag',
      'source_upsert',
    ],
    external: ['source_discover'],
    execute: ['project_migrate', 'project_rotate_preview_hash', 'source_build', 'source_sync'],
    delete: [
      'project_delete',
      'deployment_delete',
      'tag_delete',
      'token_revoke',
      'source_remove',
      'source_secret_delete',
    ],
  }),
  upload_pages_artifact: operationPolicies({
    create: ['link', 'begin'],
    update: ['chunk'],
    execute: ['finalize'],
    delete: ['cancel'],
  }),
  upload_storage_object: operationPolicies({
    create: ['begin'],
    update: ['chunk'],
    read: ['status'],
    execute: ['finalize'],
    delete: ['abort'],
  }),
  manage_additional_route: operationPolicies({
    read: ['list', 'get'],
    create: ['create'],
    update: ['update', 'retry'],
    delete: ['delete'],
  }),
  manage_additional_secure_link: operationPolicies({
    read: ['list'],
    create: ['create'],
    update: ['retry', 'retarget'],
    delete: ['delete'],
  }),
  manage_docker_migration: operationPolicies({
    read: ['preflight', 'get', 'list'],
    execute: ['start', 'cancel', 'retry_cleanup', 'resolve'],
  }),
  manage_logging_backend: operationPolicies({
    read: ['get'],
    external: ['enable_local', 'configure_external', 'disable'],
  }),
  manage_inference_provider: operationPolicies({
    read: ['list_templates', 'list_connections', 'authorization_status', 'core_status'],
    update: ['sync', 'update', 'set_routing'],
    delete: ['cancel_authorization', 'disconnect'],
    external: ['connect_api_key', 'start_authorization', 'complete_authorization', 'core_check_updates'],
    execute: ['core_install', 'core_update', 'core_repair'],
  }),
  manage_inference_model: operationPolicies({
    read: ['list', 'suggestions'],
    update: ['save', 'reorder'],
    delete: ['delete'],
  }),
  manage_inference_limits: operationPolicies({
    read: ['list_policies', 'list_users'],
    update: ['set_default', 'set_user', 'reset_user'],
    delete: ['remove_user'],
  }),
  manage_inference_token: operationPolicies({ read: ['list'], create: ['create'], delete: ['revoke'] }),
  manage_inference_usage: operationPolicies({
    read: ['self', 'self_overview', 'system', 'users', 'activity_filters', 'activity'],
  }),
  manage_notifications: operationPolicies({
    read: ['alert_categories', 'webhook_get', 'webhook_presets', 'webhook_preview', 'delivery_get'],
  }),
  manage_integration_connector: operationPolicies({
    read: ['get', 'capabilities', 'list_zones', 'allowlist_search', 'allowlist_options'],
    update: ['update', 'rotate_token', 'allowlist_refresh'],
    delete: ['delete'],
    external: ['test', 'preview_test', 'allowlist_preview_search', 'discover_host_key'],
  }),
  manage_hosting: operationPolicies({
    read: [
      'connector_list',
      'connector_get',
      'connector_configuration',
      'catalog',
      'resources',
      'adoption_candidates',
      'operations_list',
      'account_summary',
      'node_bindings',
      'node_get',
      'node_firewall_get',
      'operation_get',
      'snapshots_list',
      'snapshot_folders',
    ],
    create: ['connector_create', 'provision'],
    update: [
      'connector_update',
      'connector_sync',
      'adopt',
      'node_firewall_update',
      'operation_reconcile',
      'snapshot_folder_action',
    ],
    delete: ['connector_delete'],
    external: ['connector_preview', 'connector_discover', 'connector_test'],
    execute: ['operation_retry_install'],
    destructive: ['resource_action', 'snapshot_action'],
  }),
};

const COMPOSITE_OPERATION_POLICIES: Record<
  string,
  { arguments: string[]; operations: Record<string, AIToolOperationPolicy> }
> = {
  manage_database_backups: {
    arguments: ['action'],
    operations: operationPolicies({
      read: ['list_policies', 'list_runs'],
      create: ['create_policy'],
      update: ['update_policy'],
      delete: ['delete_policy', 'delete_run'],
      destructive: ['run', 'cancel', 'restore'],
    }),
  },
  manage_storage_connection: {
    arguments: ['action'],
    operations: operationPolicies({
      read: ['health_history', 'monitoring', 'copy_data_status', 'copy_data_list'],
      create: ['create'],
      update: ['update'],
      delete: ['delete'],
      external: ['test'],
      execute: ['reveal_credentials'],
      // A copy overwrites destination keys and sync also deletes destination objects.
      destructive: ['copy_data_start', 'copy_data_cancel'],
    }),
  },
  manage_storage_objects: {
    arguments: ['action'],
    // A presigned PUT URL lets its holder write the object; config.operation defaults to get.
    operations: withArgumentPolicy(
      operationPolicies({
        read: ['list_buckets', 'list_objects', 'head', 'presign', 'read_object'],
        create: ['create_bucket', 'create_prefix'],
        delete: ['delete_bucket', 'delete_objects'],
      }),
      'presign',
      { path: ['config', 'operation'], approvalClasses: { get: 'read', put: 'update' } }
    ),
  },
  manage_managed_storage: {
    arguments: ['action'],
    operations: operationPolicies({
      read: [
        'catalog',
        'list',
        'get',
        'list_bindings',
        'get_binding_runtime',
        'list_access_keys',
        'ca_certificate',
        'certificate_status',
      ],
      create: ['create', 'create_binding', 'create_access_key', 'import_access_keys'],
      update: ['update', 'retry', 'move_binding', 'rehome_backup_history', 'renew_certificate'],
      // A write freeze and its reversal change what every client of the cluster can do.
      execute: ['restart', 'reveal_credentials', 'freeze_writes', 'unfreeze_writes'],
      delete: ['delete', 'delete_binding', 'remove_access_key'],
    }),
  },
  manage_logging: {
    arguments: ['resource', 'operation'],
    operations: operationPolicies({
      read: [
        'environment.list',
        'environment.get',
        'schema.list',
        'schema.get',
        'token.list',
        'logs.search',
        'facets.facets',
        'metadata.metadata',
        'health.get',
      ],
      create: ['environment.create', 'schema.create', 'token.create'],
      update: ['environment.update', 'schema.update'],
      delete: ['environment.delete', 'schema.delete', 'token.delete'],
    }),
  },
  manage_status_page: {
    arguments: ['resource', 'operation'],
    operations: operationPolicies({
      read: [
        'settings.get',
        'proxy_templates.list',
        'sources.list',
        'services.list',
        'incidents.list',
        'preview.preview',
      ],
      create: ['services.create', 'incidents.create', 'incident_updates.create_update'],
      update: [
        'settings.update',
        'services.update',
        'services.reorder',
        'incidents.update',
        'incidents.resolve',
        'incidents.promote',
      ],
      delete: ['services.delete', 'incidents.delete'],
    }),
  },
};

const TOOL_POLICIES: Record<string, Pick<AIToolDefinition, 'effect' | 'approvalClass'>> = {
  test_webhook: { effect: 'external', approvalClass: 'destructive' },
  test_siem_destination: { effect: 'external', approvalClass: 'destructive' },
  request_acme_cert: { effect: 'external', approvalClass: 'destructive' },
  create_domain: { effect: 'external', approvalClass: 'destructive' },
  delete_domain: { effect: 'external', approvalClass: 'delete' },
  pull_docker_image: { effect: 'external', approvalClass: 'destructive' },
  // Runs another image with the container's env and secrets, like manage_docker_container recreate/update.
  update_docker_container_image: { effect: 'write', approvalClass: 'execute' },
  download_artifact: { effect: 'external', approvalClass: 'destructive' },
  send_artifact: { effect: 'external', approvalClass: 'destructive' },
};

const PLANNING_SAFE_TOOL_NAMES = new Set([
  'list_apps',
  'get_app',
  'get_app_overview',
  'get_app_activity',
  'ask_question',
  'audit_system_pki_leaves',
  'browse_redis_keys',
  'discover_tools',
  'read_skill',
  'activate_skill',
  'enter_plan_mode',
  'fetch',
  'find_in_chat',
  'find_resource',
  'finalize_plan_execution',
  'find_git_scope_target',
  'get_ai_settings',
  'get_alert_rule',
  'get_audit_log',
  'get_ca',
  'get_certificate',
  'get_current_context',
  'get_dashboard_stats',
  'get_database_connection',
  'get_delivery_stats',
  'get_docker_container',
  'get_docker_container_logs',
  'get_docker_container_stats',
  'get_docker_deployment',
  'get_gateway_settings',
  'get_license_status',
  'get_my_access',
  'get_node',
  'get_route',
  'get_route_rendered_config',
  'get_redis_key',
  'get_sandbox_runtime_status',
  'get_siem_delivery',
  'get_siem_destination',
  'git_list_connectors',
  'git_list_remote_refs',
  'git_list_repository_tree',
  'git_read_repository_file',
  'gitlab_get_job_log',
  'gitlab_get_pipeline',
  'gitlab_get_pipeline_jobs',
  'gitlab_get_project',
  'gitlab_lint_ci_config',
  'gitlab_list_connectors',
  'gitlab_list_pipelines',
  'gitlab_list_project_variables',
  'gitlab_list_project_webhooks',
  'gitlab_list_projects',
  'gitlab_list_registry_repositories',
  'gitlab_list_repository_tree',
  'gitlab_read_file',
  'gitlab_search_projects',
  'github_list_actions_secrets',
  'github_list_actions_variables',
  'github_list_branches',
  'github_list_connectors',
  'github_list_repositories',
  'github_list_repository_tree',
  'github_list_workflow_runs',
  'github_read_repository_file',
  'internal_documentation',
  'list_access_lists',
  'list_ai_tools',
  'list_alert_rules',
  'list_artifact_files',
  'list_cas',
  'list_certificates',
  'list_chat_projects',
  'list_databases',
  'list_storage_connections',
  'get_storage_connection',
  'list_docker_containers',
  'list_docker_deployments',
  'list_docker_images',
  'list_docker_networks',
  'list_docker_volumes',
  'list_domains',
  'list_groups',
  'list_integration_connectors',
  'list_nodes',
  'list_routes',
  'list_route_ingress_nodes',
  'list_resource_folders',
  'list_sandbox_jobs',
  'list_siem_deliveries',
  'list_siem_destinations',
  'list_ssl_certificates',
  'list_templates',
  'list_users',
  'list_webhook_deliveries',
  'list_webhooks',
  'pause_plan_execution',
  'open_connector_setup',
  'query_postgres_read',
  'read_artifact',
  'read_chat_slice',
  'read_process_output',
  'read_tool_output',
  'resume_plan_execution',
  'search_chats',
  'search_compacted_history',
  'search_tool_output',
  'send_comment',
  'ssh_list_connectors',
  'submit_plan',
  'submit_plan_review',
  'start_plan_execution',
  'submit_plan_verification',
  'update_plan_step',
  'wait',
  'web_search',
]);

export function withAIToolPolicyMetadata(tools: readonly AIToolDefinition[]): AIToolDefinition[] {
  return tools.map((tool) => {
    const operations = OPERATION_POLICIES[tool.name];
    const composite = COMPOSITE_OPERATION_POLICIES[tool.name];
    const standalone = TOOL_POLICIES[tool.name];
    const targetIdentity = inferToolTargetIdentity(tool);
    return {
      ...tool,
      ...standalone,
      planningAccess:
        PLANNING_SAFE_TOOL_NAMES.has(tool.name) ||
        Object.values(operations ?? {}).some((policy) => policy.effect === 'read') ||
        Object.values(composite?.operations ?? {}).some((policy) => policy.effect === 'read')
          ? 'allowed'
          : 'blocked',
      ...(targetIdentity ? { targetIdentity } : {}),
      ...(operations ? { operationDiscriminator: { arguments: ['operation'], operations } } : {}),
      ...(composite ? { operationDiscriminator: composite } : {}),
    };
  });
}

export function getAIToolResourceId(
  tool: Pick<AIToolDefinition, 'targetIdentity'> | undefined,
  args: Record<string, unknown>
): string {
  const argumentsList = tool?.targetIdentity?.arguments ?? [
    'caId',
    'parentCaId',
    'certificateId',
    'routeId',
    'proxyHostId',
    'domainId',
    'accessListId',
    'templateId',
    'userId',
    'containerId',
    'deploymentId',
    'databaseId',
    'storageId',
    'managedStorageId',
    'ruleId',
    'webhookId',
    'registryId',
    'nodeId',
  ];
  for (const argument of argumentsList) {
    const value = args[argument];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function inferToolTargetIdentity(tool: AIToolDefinition): AIToolDefinition['targetIdentity'] {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const available = new Set(Object.keys(properties));
  const preferred = tool.requiredScope.startsWith('docker:containers:')
    ? ['containerId', 'deploymentId', 'containerName', 'nodeId']
    : tool.requiredScope.startsWith('docker:registries:')
      ? ['registryId', 'nodeId']
      : tool.requiredScope.startsWith('docker:deployments:')
        ? ['deploymentId', 'containerId', 'containerName', 'nodeId']
        : tool.requiredScope.startsWith('databases:')
          ? ['databaseId', 'nodeId']
          : tool.requiredScope.startsWith('pages:')
            ? ['projectId', 'deploymentId', 'tagId', 'nodeId']
            : [
                'caId',
                'parentCaId',
                'certificateId',
                'routeId',
                'proxyHostId',
                'domainId',
                'accessListId',
                'templateId',
                'userId',
                'containerId',
                'deploymentId',
                'databaseId',
                'storageId',
                'managedStorageId',
                'ruleId',
                'webhookId',
                'nodeId',
                'registryId',
              ];
  const argumentsList = preferred.filter((argument) => available.has(argument));
  return argumentsList.length > 0 ? { arguments: argumentsList } : undefined;
}

export function getDeclaredOperationPolicyToolNames(): string[] {
  return [...Object.keys(OPERATION_POLICIES), ...Object.keys(COMPOSITE_OPERATION_POLICIES)].sort();
}
