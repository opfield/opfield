import {
  databaseConnectionFolders,
  dockerContainerFolders,
  objectStorageFolders,
  pageProjectFolders,
  proxyHostFolders,
} from '@/db/schema/index.js';

/**
 * Resource families an app holds. Each has one hidden app-root folder per app and one environment folder per
 * environment in its own folder table. Containers and deployments share the Docker container tree.
 */
export const APP_FAMILIES = ['containers', 'compose', 'routes', 'databases', 'storage', 'pages'] as const;
export type AppFamily = (typeof APP_FAMILIES)[number];

/** Member types the API speaks (`place`, member lists, activity). */
export const APP_MEMBER_TYPES = [
  'container',
  'deployment',
  'compose',
  'database',
  'storage',
  'route',
  'pages',
] as const;
export type AppMemberType = (typeof APP_MEMBER_TYPES)[number];

export function familyOfMemberType(type: AppMemberType): AppFamily {
  switch (type) {
    case 'container':
    case 'deployment':
      return 'containers';
    case 'compose':
      return 'compose';
    case 'database':
      return 'databases';
    case 'storage':
      return 'storage';
    case 'route':
      return 'routes';
    case 'pages':
      return 'pages';
  }
}

export interface AppFamilyTable {
  /** Folder table (all share id, name, parentId, depth, sortOrder, appId, appEnvironmentId, createdById). */
  table: any;
  /** Docker folder rows carry a resource type; the other tables hold one family each. */
  dockerResourceType?: 'container' | 'compose';
  /** The advisory lock the family's folder service takes for tree changes. */
  lockKey: string;
}

export const APP_FAMILY_TABLES: Readonly<Record<AppFamily, AppFamilyTable>> = {
  containers: { table: dockerContainerFolders, dockerResourceType: 'container', lockKey: 'docker-folders:container' },
  compose: { table: dockerContainerFolders, dockerResourceType: 'compose', lockKey: 'docker-folders:compose' },
  routes: { table: proxyHostFolders, lockKey: 'resource-folders:proxy_host_folder' },
  databases: { table: databaseConnectionFolders, lockKey: 'resource-folders:database_connection_folder' },
  storage: { table: objectStorageFolders, lockKey: 'resource-folders:object_storage_folder' },
  pages: { table: pageProjectFolders, lockKey: 'resource-folders:page_project_folder' },
};
