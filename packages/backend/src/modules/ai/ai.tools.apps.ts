import type { AIToolDefinition } from './ai.types.js';

const APP_CREATE_HINT =
  'To create a resource inside an app environment, pass folderId = placementFolderIds[type] from get_app to the normal create tool (and a node from allowedNodeIds where the tool takes one).';

export const APP_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'list_apps',
    description:
      'List apps the caller may view. An app groups containers, deployments, Compose projects, routes, databases, storage and Pages into environments (production, staging, ...). Each app lists its visible environments with health, plus the Production environment health, incident state, CPU and memory and running/failing/degraded counts.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: [],
  },
  {
    name: 'get_app',
    description: `Get one app by id or slug: visible environments with placementFolderIds (folder per resource type), allowedNodeIds, health, member counts, maintenance state, rootFolderIds and the caller's permissions. ${APP_CREATE_HINT}`,
    parameters: {
      type: 'object',
      properties: { appId: { type: 'string', description: 'App id or slug.' } },
      required: ['appId'],
    },
    destructive: false,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: [],
  },
  {
    name: 'manage_app',
    description:
      'Create, update or delete an app. create (name; needs apps:create) makes the app with one environment, production, marked as Production. update (appId, name and/or maintenanceOverride): renaming needs apps:edit on the app; maintenanceOverride true shows the maintenance page on every proxy route of every environment (apps:operate on the app), false restores each route to its own setting. delete (appId; apps:delete on the app): members keep running and leave the app, environment variables, secrets and allowed nodes are deleted.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'delete'] },
        appId: { type: 'string', description: 'update, delete: app id or slug.' },
        name: { type: 'string', description: 'create, update: app name (unique regardless of case).' },
        maintenanceOverride: { type: 'boolean', description: 'update: app-wide maintenance override.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: ['apps'],
  },
  {
    name: 'manage_app_environment',
    description:
      'Environments of an app. create (appId, name; apps:edit on the app); rename (appId, environmentId, name; apps:edit); mark_production (appId, environmentId; moves the Production marker; apps:edit); delete (appId, environmentId; apps:edit; never the Production environment; members keep running and leave the app); set_maintenance (appId, environmentId, enabled; apps:env:manage on the environment: every proxy route of the environment shows the maintenance page, each keeps its own setting for later); allow_node / remove_node (appId, environmentId, nodeId; apps:env:manage): the nodes the environment may place workloads on; creates and imports on other nodes are refused (APP_NODE_NOT_ALLOWED, or APP_ENV_NO_ALLOWED_NODE when none of the needed type is allowed); removing a node leaves its resources running; list_nodes (appId, environmentId): allowed nodes with what uses them; create_access_code (appId, optional environmentId; apps:env:manage on the environment, or on the app for every environment): a one-time Maintenance Access Code for every route of the scope in maintenance (one user, 5 minutes, once per route).',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'create',
            'rename',
            'mark_production',
            'delete',
            'set_maintenance',
            'allow_node',
            'remove_node',
            'list_nodes',
            'create_access_code',
          ],
        },
        appId: { type: 'string', description: 'App id or slug.' },
        environmentId: { type: 'string', description: 'Environment id (every operation except create).' },
        name: { type: 'string', description: 'create, rename: environment name.' },
        enabled: { type: 'boolean', description: 'set_maintenance: on or off.' },
        nodeId: { type: 'string', description: 'allow_node, remove_node: node id.' },
      },
      required: ['operation', 'appId'],
    },
    destructive: true,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: ['apps', 'proxy'],
  },
  {
    name: 'manage_app_members',
    description:
      'Members of an app. list (appId, optional environmentId): the members you may view with type, id, name, environmentId and nodeIds. place (target {appId, environmentId} or null, members [{type, id} or {type: container, id: name, nodeId}]): import or move each member into the environment, or take it out of its app with target null (it returns to the top level of its list). Types: container, deployment, compose, database, storage, route, pages. Needs apps:env:manage on the target environment and on the environment a member leaves, plus edit permission on each member. Refused per member: system routes (ROUTE_NOT_PLACEABLE), a node the environment does not allow (APP_NODE_NOT_ALLOWED, APP_ENV_NO_ALLOWED_NODE), a deployment slot or Compose service container (move the deployment or project), no permission. Returns placed and refused lists.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'place'] },
        appId: { type: 'string', description: 'list: app id or slug.' },
        environmentId: { type: 'string', description: 'list: only this environment.' },
        target: {
          type: ['object', 'null'],
          description: 'place: {appId, environmentId}, or null to take members out of their app.',
          properties: { appId: { type: 'string' }, environmentId: { type: 'string' } },
        },
        members: {
          type: 'array',
          description: 'place: members to move.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['container', 'deployment', 'compose', 'database', 'storage', 'route', 'pages'],
              },
              id: { type: 'string', description: 'Resource id; containers: the container name.' },
              nodeId: { type: 'string', description: 'Containers: the Docker node.' },
            },
            required: ['type', 'id'],
          },
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: ['apps', 'proxy', 'containers', 'databases', 'pages', 'folders'],
  },
  {
    name: 'manage_app_variables',
    description:
      'Environment variables and secrets of an app environment (apps:env:manage on it). Every container, deployment and Compose project of the environment receives them on its next create, recreate, deploy or apply; nothing restarts on save. Precedence, lowest first: image ENV, environment variables, environment secrets, the workload own environment, the workload own secrets. get returns variables with values, secret keys only (never values) and pendingWorkloads (workloads still running older values; recreate or redeploy them one at a time to apply). set_variables (variables [{key, value}]) replaces the full set of plain variables. set_secrets (secrets {KEY: value}) adds or replaces secrets. delete_secrets (keys [KEY]). Keys: ^[A-Za-z_][A-Za-z0-9_]*$, at most 200 per environment, values up to 32 KiB; a key is a variable or a secret, not both.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'set_variables', 'set_secrets', 'delete_secrets'] },
        appId: { type: 'string', description: 'App id or slug.' },
        environmentId: { type: 'string', description: 'Environment id.' },
        variables: {
          type: 'array',
          description: 'set_variables: the full set of plain variables.',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
        secrets: {
          type: 'object',
          description: 'set_secrets: KEY to value.',
          additionalProperties: { type: 'string' },
        },
        keys: { type: 'array', items: { type: 'string' }, description: 'delete_secrets: secret keys.' },
      },
      required: ['operation', 'appId', 'environmentId'],
    },
    destructive: true,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: ['apps'],
  },
  {
    name: 'get_app_overview',
    description:
      'Monitoring overview of an app: per environment you may view, health, issues (failing or degraded members per type), alerts (tone destructive for a failing member, warning for a nearly full disk or 5xx errors), and 24-point series over range 1h or 24h for containers (CPU, memory, unhealthy names), databases (disk, connections), storage (disk, buckets, RX/TX), routes (requests, 5xx, latency, traffic) and Pages, plus the nodes the members run on. Only members you may view count; unknown values are null.',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id or slug.' },
        range: { type: 'string', enum: ['1h', '24h'], description: 'Series range (default 1h).' },
      },
      required: ['appId'],
    },
    destructive: false,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: [],
  },
  {
    name: 'get_app_activity',
    description:
      'Activity of an app: audit entries about the app, its environments and its members since they joined, newest first ({data, total, page, limit}, audit log row shape). Optional environmentId narrows to one environment; entries about members you cannot view are left out.',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id or slug.' },
        environmentId: { type: 'string', description: 'Only this environment (app-wide entries included).' },
        page: { type: 'number', description: 'Page (default 1).' },
        limit: { type: 'number', description: 'Entries per page (default 25, at most 100).' },
      },
      required: ['appId'],
    },
    destructive: false,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: [],
  },
];
