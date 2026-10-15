/**
 * Product areas of the access summary (see access-summary.ts): which base scopes belong to which area,
 * the area's view and create scopes, and the folder family list_resource_folders uses for it.
 */

/** Folder families list_resource_folders accepts. */
export type AccessFolderResourceType =
  | 'nodes'
  | 'databases'
  | 'storage'
  | 'domains'
  | 'ssl_certificates'
  | 'pki_cas'
  | 'pki_certificates'
  | 'pki_templates'
  | 'nginx_templates'
  | 'logging_environments'
  | 'logging_schemas'
  | 'admin_users'
  | 'permission_groups'
  | 'routes'
  | 'docker'
  | 'pages'
  | 'apps';

export type AccessDockerFolderType = 'container' | 'compose' | 'image' | 'volume' | 'network';

export interface AccessAreaDefinition {
  id: string;
  title: string;
  /** The action name of a base scope in this area, or null when the base belongs elsewhere. */
  action: (base: string) => string | null;
  /** Holding this scope unqualified means the caller sees every resource of the area. */
  viewScope?: string;
  /** The scope that authorizes creating a resource of this area (it names a destination). */
  createScope?: string;
  /** Docker qualifiers: a bare qualifier is a node, `<nodeId>/<resourceId>` a resource on that node. */
  dockerQualifiers?: boolean;
  /** Legacy bare `<scope>:<nodeId>` creation qualifiers name a node. */
  bareNodeCreate?: boolean;
  folderResourceType?: AccessFolderResourceType;
  dockerFolderType?: AccessDockerFolderType;
  /** How to create inside a granted destination (tool and arguments). */
  createHint?: string;
}

function prefixed(prefix: string, exclude: readonly string[] = []) {
  return (base: string): string | null =>
    base.startsWith(prefix) && !exclude.some((excluded) => base.startsWith(excluded))
      ? base.slice(prefix.length)
      : null;
}

function exact(actions: Readonly<Record<string, string>>) {
  return (base: string): string | null => actions[base] ?? null;
}

function anyPrefix(prefixes: readonly string[]) {
  return (base: string): string | null => (prefixes.some((prefix) => base.startsWith(prefix)) ? base : null);
}

/** Areas in match order: the first area whose `action` accepts a base owns it. */
export const ACCESS_AREAS: readonly AccessAreaDefinition[] = [
  {
    id: 'docker_containers',
    title: 'Docker containers and deployments',
    action: (base) =>
      base.startsWith('docker:containers:')
        ? base.slice('docker:containers:'.length)
        : base === 'docker:availability:manage'
          ? 'availability:manage'
          : null,
    viewScope: 'docker:containers:view',
    createScope: 'docker:containers:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'container',
    createHint:
      'pass nodeId and folderId to create_docker_container (or the deployment create action of manage_docker_deployment)',
  },
  {
    id: 'docker_compose',
    title: 'Docker Compose projects',
    action: prefixed('docker:compose:'),
    viewScope: 'docker:compose:view',
    createScope: 'docker:compose:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'compose',
    createHint: 'pass nodeId and folderId to manage_docker_compose',
  },
  {
    id: 'docker_images',
    title: 'Docker images',
    action: prefixed('docker:images:'),
    viewScope: 'docker:images:view',
    createScope: 'docker:images:pull',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'image',
    createHint: 'pass nodeId and folderId to pull_docker_image',
  },
  {
    id: 'docker_volumes',
    title: 'Docker volumes',
    action: prefixed('docker:volumes:'),
    viewScope: 'docker:volumes:view',
    createScope: 'docker:volumes:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'volume',
    createHint: 'pass nodeId and folderId to manage_docker_volume',
  },
  {
    id: 'docker_networks',
    title: 'Docker networks',
    action: prefixed('docker:networks:'),
    viewScope: 'docker:networks:view',
    createScope: 'docker:networks:create',
    dockerQualifiers: true,
    folderResourceType: 'docker',
    dockerFolderType: 'network',
    createHint: 'pass nodeId and folderId to manage_docker_network',
  },
  {
    id: 'docker_registries',
    title: 'Docker registries',
    action: prefixed('docker:registries:'),
    viewScope: 'docker:registries:view',
  },
  {
    id: 'docker_tasks',
    title: 'Docker tasks and folder layout',
    action: exact({
      'docker:tasks': 'tasks:view',
      'docker:tasks:manage': 'tasks:manage',
      'docker:folders:manage': 'folders:manage',
    }),
  },
  {
    id: 'route_templates',
    title: 'Route templates',
    action: prefixed('proxy:templates:'),
    viewScope: 'proxy:templates:view',
    createScope: 'proxy:templates:manage',
    folderResourceType: 'nginx_templates',
    createHint: 'pass folderId to the create operation of manage_proxy_template',
  },
  {
    id: 'routes',
    title: 'Ingress routes',
    action: prefixed('proxy:'),
    viewScope: 'proxy:view',
    createScope: 'proxy:create',
    bareNodeCreate: true,
    folderResourceType: 'routes',
    createHint: 'pass folderId (and nodeId) to create_route',
  },
  { id: 'access_lists', title: 'Access lists', action: prefixed('acl:'), viewScope: 'acl:view' },
  {
    id: 'domains',
    title: 'Domains',
    action: prefixed('domains:'),
    viewScope: 'domains:view',
    createScope: 'domains:create',
    bareNodeCreate: true,
    folderResourceType: 'domains',
    createHint: 'pass folderId to create_domain',
  },
  {
    id: 'ssl_certificates',
    title: 'SSL certificates',
    action: prefixed('ssl:cert:'),
    viewScope: 'ssl:cert:view',
    createScope: 'ssl:cert:issue',
    folderResourceType: 'ssl_certificates',
    createHint: 'pass folderId to request_acme_cert or manage_ssl_certificate',
  },
  {
    id: 'pki_cas',
    title: 'Internal PKI certificate authorities',
    action: prefixed('pki:ca:'),
    viewScope: 'pki:ca:view',
    folderResourceType: 'pki_cas',
  },
  {
    id: 'pki_certificates',
    title: 'Internal PKI certificates',
    action: prefixed('pki:cert:'),
    viewScope: 'pki:cert:view',
    folderResourceType: 'pki_certificates',
  },
  {
    id: 'pki_templates',
    title: 'Internal PKI certificate templates',
    action: prefixed('pki:templates:'),
    viewScope: 'pki:templates:view',
    folderResourceType: 'pki_templates',
  },
  {
    id: 'databases',
    title: 'Databases',
    action: prefixed('databases:'),
    viewScope: 'databases:view',
    createScope: 'databases:create',
    folderResourceType: 'databases',
    createHint:
      'pass folderId (and nodeId for a managed database) to manage_database_connection or manage_managed_database',
  },
  {
    id: 'storage',
    title: 'Storage',
    action: prefixed('storage:'),
    viewScope: 'storage:view',
    createScope: 'storage:create',
    folderResourceType: 'storage',
    createHint: 'pass folderId (and nodeId for managed storage) to manage_storage_connection or manage_managed_storage',
  },
  {
    id: 'pages',
    title: 'Pages',
    action: prefixed('pages:'),
    viewScope: 'pages:view',
    createScope: 'pages:create',
    folderResourceType: 'pages',
    createHint: 'pass folderId (and nodeId) to the create action of manage_pages',
  },
  {
    id: 'logging_schemas',
    title: 'Logging schemas',
    action: prefixed('logs:schemas:'),
    viewScope: 'logs:schemas:view',
    createScope: 'logs:schemas:create',
    folderResourceType: 'logging_schemas',
    createHint: 'pass folderId to the schema create action of manage_logging',
  },
  {
    id: 'logging_environments',
    title: 'Logging environments',
    action: (base) =>
      base.startsWith('logs:environments:')
        ? base.slice('logs:environments:'.length)
        : base.startsWith('logs:')
          ? base.slice('logs:'.length)
          : null,
    viewScope: 'logs:environments:view',
    createScope: 'logs:environments:create',
    folderResourceType: 'logging_environments',
    createHint: 'pass folderId to the environment create action of manage_logging',
  },
  {
    id: 'nodes',
    title: 'Nodes',
    action: prefixed('nodes:'),
    viewScope: 'nodes:details',
    createScope: 'nodes:create',
    folderResourceType: 'nodes',
    createHint: 'pass folderId to create_node',
  },
  {
    // Ingress groups live in node folders; their grants are broad or node-folder ones.
    id: 'ingress_groups',
    title: 'Ingress groups',
    action: prefixed('ingress:'),
    viewScope: 'ingress:groups:view',
    createScope: 'ingress:groups:manage',
    folderResourceType: 'nodes',
    createHint: 'pass folderId to the create operation of manage_ingress_group',
  },
  {
    // Apps: grants are broad, `<appId>`, `env/<envId>` or an Apps list folder; members follow their own resource grants.
    id: 'apps',
    title: 'Apps',
    action: prefixed('apps:'),
    viewScope: 'apps:view',
    createScope: 'apps:create',
    folderResourceType: 'apps',
    createHint:
      'call manage_app with operation create (pass folderId to create it in an Apps list folder); create resources inside an environment with folderId from get_app placementFolderIds',
  },
  {
    id: 'hosting',
    title: 'Hosting (VMs, snapshots, accounts)',
    action: (base) =>
      base.startsWith('integrations:hosting:')
        ? `accounts:${base.slice('integrations:hosting:'.length)}`
        : base.startsWith('hosting:')
          ? base.slice('hosting:'.length)
          : null,
    viewScope: 'hosting:resources:view',
    createScope: 'hosting:resources:create',
    createHint:
      'pass the hosting account as input.connectorId (and a node folder as input.folderId) to manage_hosting provision',
  },
  { id: 'integrations', title: 'Integrations (Git, SSH, Cloudflare)', action: prefixed('integrations:') },
  { id: 'notifications', title: 'Notifications', action: prefixed('notifications:') },
  { id: 'status_page', title: 'Status page', action: prefixed('status-page:'), viewScope: 'status-page:view' },
  {
    id: 'users',
    title: 'Users',
    action: exact({
      'admin:users': 'manage',
      'admin:users:folders:manage': 'folders:manage',
      'admin:users:impersonate': 'impersonate',
    }),
    viewScope: 'admin:users',
    folderResourceType: 'admin_users',
  },
  {
    id: 'groups',
    title: 'Permission groups',
    action: exact({ 'admin:groups': 'manage', 'admin:groups:folders:manage': 'folders:manage' }),
    viewScope: 'admin:groups',
    folderResourceType: 'permission_groups',
  },
  {
    id: 'administration',
    title: 'Administration and settings',
    action: anyPrefix(['admin:', 'audit:', 'settings:', 'license:', 'housekeeping:']),
  },
  { id: 'ai', title: 'AI and inference', action: anyPrefix(['ai:', 'feat:', 'inference:', 'mcp:']) },
];

export const OTHER_AREA: AccessAreaDefinition = { id: 'other', title: 'Other', action: (base) => base };

export function accessAreaForBase(base: string): { area: AccessAreaDefinition; action: string } {
  for (const area of ACCESS_AREAS) {
    const action = area.action(base);
    if (action) return { area, action };
  }
  return { area: OTHER_AREA, action: base };
}
