import type { AIToolDefinition } from './ai.types.js';

export const OPERATION_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_logging',
    description:
      'Manage external logging environments, schemas, ingest tokens, metadata, facets, and search. Use canonical args like { resource: "schema", operation: "create", payload: { name, schemaMode, fieldSchema } } or { resource: "environment", operation: "list", search }. Environment list takes excludeAppMembers (leave out app members) or appId (only the environments of one app); each environment carries app (its app and environment, or null) and lastIngestAt. Resource slugs are assigned by the backend. Operation-specific logs:* scopes are enforced. { resource: "health", operation: "get" } returns the logging storage maintenance snapshot (any logs view scope or housekeeping:view).',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: ['environment', 'schema', 'token', 'logs', 'metadata', 'facets', 'health'] },
        operation: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'search', 'facets', 'metadata'],
        },
        environmentId: { type: 'string' },
        schemaId: { type: 'string' },
        tokenId: { type: 'string' },
        search: { type: 'string' },
        excludeAppMembers: { type: 'boolean', description: 'environment list: leave out environments of apps.' },
        appId: { type: 'string', description: 'environment list: only the environments of this app.' },
        payload: {
          type: 'object',
          description:
            'Create/update/search/facets body matching the logging API schema. Schema payload fields: name, description?, schemaMode ("loose"|"strip"|"reject"), fieldSchema[]. Environment payload fields: name, description?, enabled?, schemaId?, schemaMode, retentionDays, fieldSchema[], folderId? (get_app placementFolderIds.logging creates it inside an app environment). Resource slugs are assigned by the backend. Search payload fields: from?, to?, query?, limit?, cursor?, services?, sources?, expression?.',
        },
      },
      required: ['resource', 'operation'],
    },
    destructive: true,
    category: 'Logging',
    requiredScope: 'logs:environments:view',
    invalidateStores: [],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_status_page',
    description:
      'Manage the status page settings, service list and order, incidents, incident updates, proxy template options, and preview. settings.get_upstream returns the upstream the public page is served from now (inUse), whether Opfield Cloud manages it (cloudManaged; then settings.update keeps it) and consoleDirect. sources.list returns the resources the caller may expose (a service can only expose a source the caller can view). services.reorder takes payload { serviceIds } in the new display order. settings.update payload nodeId picks the nginx node that serves the public page; payload ingressGroupId serves it from every member of an ingress group instead (multi-node availability license feature; moving between a node and a group works while the page is enabled, ingressGroupId null with nodeId, a current member, moves it back). Operation-specific status-page:* scopes are enforced.',
    parameters: {
      type: 'object',
      properties: {
        resource: {
          type: 'string',
          enum: ['settings', 'proxy_templates', 'sources', 'services', 'incidents', 'incident_updates', 'preview'],
        },
        operation: {
          type: 'string',
          enum: [
            'get',
            'get_upstream',
            'list',
            'update',
            'create',
            'delete',
            'reorder',
            'resolve',
            'promote',
            'create_update',
            'preview',
          ],
        },
        serviceId: { type: 'string' },
        incidentId: { type: 'string' },
        status: { type: 'string', enum: ['active', 'resolved', 'all'] },
        limit: { type: 'number' },
        payload: { type: 'object', description: 'Create/update body matching the status page API schema' },
      },
      required: ['resource', 'operation'],
    },
    destructive: true,
    category: 'Status Page',
    requiredScope: 'status-page:view',
    invalidateStores: [],
  },
];
