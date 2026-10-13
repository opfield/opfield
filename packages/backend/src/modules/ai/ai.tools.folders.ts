import { FOLDER_TOOL_RESOURCE_TYPES } from './ai.folder-tool-types.js';
import type { AIToolDefinition } from './ai.types.js';

export const FOLDER_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'list_resource_folders',
    description:
      'List the folders of an Opfield resource type that you can use. Each folder carries access.actions (the actions you hold there, broad grants included) and access.canCreate. With folder-limited access you see every folder you hold any grant on, even an empty one: pick a folderId here before creating or moving resources, and see get_my_access for all your grants.',
    parameters: {
      type: 'object',
      properties: {
        resourceType: {
          type: 'string',
          enum: [...FOLDER_TOOL_RESOURCE_TYPES],
          description: 'Foldered resource type to inspect.',
        },
        dockerResourceType: {
          type: 'string',
          enum: ['container', 'image', 'network', 'volume', 'compose'],
          description:
            'Docker resource subtype when resourceType is docker (compose = Compose projects). Default: container.',
        },
      },
      required: ['resourceType'],
    },
    destructive: false,
    category: 'Folders',
    requiredScope: 'nodes:folders:manage',
    invalidateStores: [],
  },
  {
    name: 'manage_resource_folder',
    description:
      'Create, update, move, delete, reorder, or assign foldered Opfield resources. Use the resource-specific ids and resourceType (pages = Page Projects, apps = folders of the Apps list holding apps, storage = storage connections, pki_cas = internal CAs: only root CAs move and their intermediates follow, pki_certificates = internal PKI certificates, pki_templates and nginx_templates = custom templates; built-ins never move).',
    parameters: {
      type: 'object',
      properties: {
        resourceType: {
          type: 'string',
          enum: [...FOLDER_TOOL_RESOURCE_TYPES],
        },
        operation: {
          type: 'string',
          enum: ['create', 'update', 'move_folder', 'delete', 'reorder_folders', 'move_resources', 'reorder_resources'],
          description: 'Folder operation to perform.',
        },
        folderId: { type: 'string', description: 'Folder UUID for update/move/delete or target folder for resources.' },
        name: { type: 'string', description: 'Folder name for create/update.' },
        parentId: {
          type: 'string',
          description: 'Parent folder UUID for create/move_folder. Use null for top-level on move_folder.',
        },
        resourceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Resource UUIDs to move for non-Docker resources, including route UUIDs for routes.',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Folder/resource UUID for reorder operations.' },
              sortOrder: { type: 'number', description: 'Zero-based sort order.' },
              nodeId: { type: 'string', description: 'Docker node UUID for Docker resources.' },
              resourceKey: { type: 'string', description: 'Docker resource key/name for Docker resources.' },
            },
          },
          description: 'Reorder entries or Docker resource refs. Docker move_resources uses [{ nodeId, resourceKey }].',
        },
        dockerResourceType: {
          type: 'string',
          enum: ['container', 'image', 'network', 'volume', 'compose'],
          description:
            'Docker resource subtype when resourceType is docker (compose = Compose projects). Default: container.',
        },
      },
      required: ['resourceType', 'operation'],
    },
    destructive: true,
    category: 'Folders',
    requiredScope: 'nodes:folders:manage',
    invalidateStores: ['folders'],
  },
];
