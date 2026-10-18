import type { AIToolDefinition } from './ai.types.js';

/**
 * Agents with folder-, node- or resource-limited access must not read an empty list or a refused root
 * create as "no access". These notes are appended to the list and create tools of folder-scopable
 * resources, so the same text reaches the assistant and MCP clients.
 */
export const FOLDER_ACCESS_LIST_NOTE =
  'Returns only what you can access: with folder-, node- or resource-limited access it lists that subset, and an empty result is not a denial. get_my_access shows your grants.';

export const FOLDER_ACCESS_CREATE_NOTE =
  'With folder- or node-limited access, pass folderId (and nodeId where the tool takes one) for a destination you hold the create scope on; a create without a destination targets the root and is refused. get_my_access lists your create destinations and list_resource_folders the folders with your actions in each.';

const FOLDER_ID_PARAMETER_NOTE = 'Required when your create access is limited to folders (see get_my_access).';

/** List tools (and multi-action tools with list actions) of folder-scopable resources. */
export const FOLDER_ACCESS_LIST_TOOLS: ReadonlySet<string> = new Set([
  'find_resource',
  'list_docker_containers',
  'list_docker_deployments',
  'list_docker_images',
  'list_docker_volumes',
  'list_docker_networks',
  'list_routes',
  'list_domains',
  'list_ssl_certificates',
  'list_cas',
  'list_certificates',
  'list_databases',
  'list_storage_connections',
  'list_nodes',
  'manage_ingress_group',
  'manage_docker_compose',
  'manage_container_link',
  'manage_managed_database',
  'manage_managed_storage',
  'manage_pages',
  'manage_logging',
  'list_alert_rules',
  'list_alerts',
  'list_webhooks',
  'list_webhook_deliveries',
  'list_access_lists',
]);

/** Tools that create a resource in a folder or on a node. */
export const FOLDER_ACCESS_CREATE_TOOLS: ReadonlySet<string> = new Set([
  'create_docker_container',
  'duplicate_docker_container',
  'manage_docker_deployment',
  'manage_docker_compose',
  'pull_docker_image',
  'manage_docker_volume',
  'manage_docker_network',
  'create_route',
  'create_domain',
  'manage_ingress_group',
  'request_acme_cert',
  'manage_ssl_certificate',
  'manage_database_connection',
  'manage_managed_database',
  'manage_storage_connection',
  'manage_managed_storage',
  'manage_pages',
  'manage_logging',
  'create_node',
  'manage_proxy_template',
  'create_alert_rule',
  'create_webhook',
  'create_access_list',
]);

function withFolderIdParameterNote(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = parameters.properties as Record<string, Record<string, unknown>> | undefined;
  const folderId = properties?.folderId;
  if (!properties || !folderId || typeof folderId !== 'object') return parameters;
  const description = typeof folderId.description === 'string' ? folderId.description.trim() : '';
  const separator = description && !/[.!?]$/.test(description) ? '. ' : description ? ' ' : '';
  return {
    ...parameters,
    properties: {
      ...properties,
      folderId: { ...folderId, description: `${description}${separator}${FOLDER_ID_PARAMETER_NOTE}` },
    },
  };
}

/** Append the folder-access notes to the listed tools' descriptions (and their folderId parameter). */
export function withFolderAccessNotes(definitions: AIToolDefinition[]): AIToolDefinition[] {
  return definitions.map((tool) => {
    const lists = FOLDER_ACCESS_LIST_TOOLS.has(tool.name);
    const creates = FOLDER_ACCESS_CREATE_TOOLS.has(tool.name);
    if (!lists && !creates) return tool;
    const notes = [lists ? FOLDER_ACCESS_LIST_NOTE : null, creates ? FOLDER_ACCESS_CREATE_NOTE : null].filter(
      (note): note is string => !!note
    );
    const description = tool.description.trim();
    return {
      ...tool,
      description: `${description}${/[.!?]$/.test(description) ? '' : '.'} ${notes.join(' ')}`,
      ...(creates ? { parameters: withFolderIdParameterNote(tool.parameters as Record<string, unknown>) } : {}),
    };
  });
}
