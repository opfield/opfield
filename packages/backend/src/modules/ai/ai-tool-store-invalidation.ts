import type { EventBusService } from '@/services/event-bus.service.js';

export const TOOL_STORE_INVALIDATION_CHANNEL_PREFIX = 'tool.store.invalidated.';

const SAFE_CONTEXT_KEYS = [
  'operation',
  'resource',
  'nodeId',
  'containerId',
  'containerName',
  'deploymentId',
  'routeId',
  'proxyHostId',
  'projectId',
  'databaseId',
  'certificateId',
  'caId',
  'userId',
  'groupId',
  'registryId',
  'networkId',
  'environmentId',
  'schemaId',
  'tokenId',
  'clientId',
  'name',
] as const;

const DOCKER_CONFIG_MUTATION_STORES: Record<string, string[]> = {
  update_env: ['containers', 'tasks'],
  write_file: ['containers'],
  create_secret: ['containers'],
  update_secret: ['containers'],
  delete_secret: ['containers'],
  upsert_webhook: ['containers'],
  delete_webhook: ['containers'],
  regenerate_webhook_token: ['containers'],
  upsert_health_check: ['containers'],
};

export interface ToolStoreInvalidationEvent {
  userId: string;
  source: 'ai' | 'mcp';
  toolName: string;
  stores: string[];
  resourceId?: string;
  context: Record<string, string>;
}

export function resolveToolStoreInvalidations(
  toolName: string,
  args: Record<string, unknown>,
  configuredStores: string[]
): string[] {
  const stores = new Set(configuredStores);
  const operation = typeof args.operation === 'string' ? args.operation : '';

  if (toolName === 'manage_docker_container_config') {
    for (const store of DOCKER_CONFIG_MUTATION_STORES[operation] ?? []) stores.add(store);
  } else if (toolName === 'manage_docker_registry' && ['create', 'update', 'delete'].includes(operation)) {
    stores.add('dockerRegistries');
  } else if (toolName === 'manage_docker_volume') {
    stores.add('volumes');
  } else if (toolName === 'manage_container_link') {
    if (operation === 'create' || operation === 'delete') stores.add('containers');
  } else if (toolName === 'manage_docker_network') {
    stores.add('networks');
    if (operation === 'connect' || operation === 'disconnect') stores.add('containers');
  } else if (toolName === 'manage_pages') {
    if (operation === 'token_create' || operation === 'token_revoke') stores.add('pageTokens');
    if (
      operation === 'profile_configure' ||
      operation === 'profile_disable' ||
      operation.startsWith('project_') ||
      operation === 'deployment_pin' ||
      operation === 'deployment_delete' ||
      operation === 'tag_move' ||
      operation === 'tag_delete' ||
      operation.startsWith('config_save_') ||
      operation === 'config_reset_tag'
    ) {
      stores.add('pages');
    }
    if (
      operation === 'profile_configure' ||
      operation === 'profile_disable' ||
      ['project_create', 'project_update', 'project_migrate', 'project_delete', 'tag_move', 'tag_delete'].includes(
        operation
      )
    ) {
      stores.add('proxy-hosts');
    }
  } else if (toolName === 'upload_pages_artifact') {
    if (operation === 'begin' || operation === 'finalize' || operation === 'cancel') stores.add('pages');
    if (operation === 'finalize') stores.add('proxy-hosts');
  } else if (toolName === 'manage_logging') {
    let resource = typeof args.resource === 'string' ? args.resource : '';
    let loggingOperation = operation;
    if (loggingOperation.includes('.')) {
      const [operationResource, operationName] = loggingOperation.split('.', 2);
      resource ||= operationResource ?? '';
      loggingOperation = operationName ?? '';
    }
    const normalizedResource = resource.toLowerCase().replace(/-/g, '_').replace(/s$/, '');
    if (['create', 'add', 'update', 'edit', 'patch', 'delete', 'remove', 'destroy'].includes(loggingOperation)) {
      stores.add(normalizedResource === 'token' || normalizedResource === 'ingest_token' ? 'loggingTokens' : 'logging');
    }
  } else if (toolName === 'manage_inference_token' && ['create', 'update', 'revoke'].includes(operation)) {
    stores.add('inferenceTokens');
  } else if (toolName === 'manage_oauth_authorization' && ['update', 'update_scopes', 'revoke'].includes(operation)) {
    stores.add('oauthAuthorizations');
  } else if (toolName === 'manage_api_token' && ['create', 'update', 'revoke'].includes(operation)) {
    stores.add('apiTokens');
  }

  return [...stores];
}

export function publishToolStoreInvalidation(
  eventBus: EventBusService | undefined,
  event: ToolStoreInvalidationEvent
): void {
  if (!eventBus || event.stores.length === 0) return;
  eventBus.publish(`${TOOL_STORE_INVALIDATION_CHANNEL_PREFIX}${event.userId}`, event);
}

export function toolInvalidationContext(args: Record<string, unknown>): Record<string, string> {
  const context: Record<string, string> = {};
  for (const key of SAFE_CONTEXT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) context[key] = value;
  }
  return context;
}
