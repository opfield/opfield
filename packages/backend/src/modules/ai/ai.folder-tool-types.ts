import type { AccessFolderResourceType } from '@/lib/access-summary.js';

/** Folder families list_resource_folders and manage_resource_folder accept, in tool-enum order. */
export const FOLDER_TOOL_RESOURCE_TYPES = [
  'nodes',
  'databases',
  'storage',
  'domains',
  'ssl_certificates',
  'pki_cas',
  'pki_certificates',
  'pki_templates',
  'nginx_templates',
  'logging_environments',
  'logging_schemas',
  'admin_users',
  'permission_groups',
  'routes',
  'docker',
  'pages',
  'apps',
] as const satisfies readonly AccessFolderResourceType[];

export type FolderToolResourceType = (typeof FOLDER_TOOL_RESOURCE_TYPES)[number];
export type GenericFolderResourceType = Exclude<FolderToolResourceType, 'routes' | 'docker'>;
