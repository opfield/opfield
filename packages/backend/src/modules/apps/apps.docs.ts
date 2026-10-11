import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  jsonBody,
  noContent,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
  UnknownListResponseSchema,
} from '@/lib/openapi.js';
import {
  AppMembersQuerySchema,
  CreateAppEnvironmentSchema,
  CreateAppSchema,
  PatchAppSecretsSchema,
  PlaceAppMembersSchema,
  SetAppVariablesSchema,
  UpdateAppEnvironmentSchema,
  UpdateAppSchema,
} from './apps.schemas.js';

const TAGS = ['Apps'];

export const APPS_DESCRIPTION =
  'An app groups resources of several types (containers, deployments, Compose projects, routes, databases, storage, Pages) into environments. A new app has one environment, production, marked as Production; exactly one environment holds the marker. Members sit in hidden folders of their own type, so create a resource inside an environment by passing folderId = placementFolderIds[type] of that environment to the normal create endpoint. Visibility: apps:view broadly, on the app (apps:view:<appId>) or on one environment (apps:view:env/<envId>); members appear by their own view permissions.';

const AppParams = pathParamSchema('id');
const EnvParams = pathParamSchema('id', 'envId');

export const listAppsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: TAGS,
  summary: 'List apps',
  description: `${APPS_DESCRIPTION} Each app lists the environments the caller may view with their health, plus the Production environment's health, incident state, CPU and memory of its containers and running/failing/degraded counts.`,
  responses: okJson(UnknownListResponseSchema),
});

export const createAppRoute = appRoute({
  method: 'post',
  path: '/',
  tags: TAGS,
  summary: 'Create an app',
  description:
    'Needs apps:create. Creates the app with one environment, production, marked as Production. The creator keeps view of the app and the app permissions they already hold.',
  request: jsonBody(CreateAppSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const getAppRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: TAGS,
  summary: 'Get an app',
  description:
    'By id or slug. Environments the caller may view, each with placementFolderIds (the folderId to pass when creating a resource of that type inside the environment), allowedNodeIds (nodes the environment may place workloads on), health, visible member counts and maintenance state; permissions says what the caller may change.',
  request: { params: AppParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAppRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: TAGS,
  summary: 'Update an app',
  description:
    'Rename (apps:edit on the app) or turn the app maintenance override on or off (apps:operate on the app): every proxy route of every environment then shows the maintenance page; each route keeps its own maintenance setting for when the override is off.',
  request: { params: AppParams, ...jsonBody(UpdateAppSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAppRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: TAGS,
  summary: 'Delete an app',
  description:
    'Needs apps:delete on the app. Members keep running and leave the app (they show at the top level of their lists); environment variables, secrets and allowed nodes are deleted, and grants naming the app, its environments or its folders are removed. Refused while a shutdown or the kill switch is open in any environment (409 APP_INCIDENT_ACTIVE): start the app or turn the kill switch off first.',
  request: { params: AppParams },
  responses: noContent,
});

export const createAppEnvironmentRoute = appRoute({
  method: 'post',
  path: '/{id}/environments',
  tags: TAGS,
  summary: 'Create an environment',
  description: 'Needs apps:edit on the app. Names are unique in the app regardless of case.',
  request: { params: AppParams, ...jsonBody(CreateAppEnvironmentSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateAppEnvironmentRoute = appRoute({
  method: 'patch',
  path: '/{id}/environments/{envId}',
  tags: TAGS,
  summary: 'Update an environment',
  description:
    'Rename or mark as Production (isProduction: true moves the marker; apps:edit on the app), or turn environment maintenance on or off (apps:env:manage on the environment): every proxy route of the environment shows the maintenance page while each keeps its own setting.',
  request: { params: EnvParams, ...jsonBody(UpdateAppEnvironmentSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAppEnvironmentRoute = appRoute({
  method: 'delete',
  path: '/{id}/environments/{envId}',
  tags: TAGS,
  summary: 'Delete an environment',
  description:
    'Needs apps:edit on the app. The Production environment cannot be deleted. Members keep running and leave the app; variables, secrets and allowed nodes of the environment are deleted. Refused while the environment is shut down or isolated (409 APP_INCIDENT_ACTIVE): start it or turn the kill switch off first.',
  request: { params: EnvParams },
  responses: noContent,
});

export const placeAppMembersRoute = appRoute({
  method: 'post',
  path: '/members/place',
  tags: TAGS,
  summary: 'Move resources into, between or out of app environments',
  description:
    'target {appId, environmentId} imports or moves each member into that environment; target null takes them out of their app (top level of their lists). Members: {type, id} (deployment, compose, database, storage, route, pages by id) or {type: container, id: name, nodeId}. Needs apps:env:manage on the target environment and on the environment a member leaves, plus the edit permission of each member. Refused per member: system routes and the Gateway public URL route (ROUTE_NOT_PLACEABLE), a node the target environment does not allow (APP_NODE_NOT_ALLOWED), no permission (FORBIDDEN), unknown member (NOT_FOUND), a member of an environment isolated by the kill switch (APP_ISOLATED; an isolated target refuses the whole request with 409 APP_ISOLATED). Shut-down environments take moves both ways; Start still starts a member moved out that ran at shutdown. Partial success: placed and refused are listed.',
  request: jsonBody(PlaceAppMembersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const listAppMembersRoute = appRoute({
  method: 'get',
  path: '/{id}/members',
  tags: TAGS,
  summary: 'List app members',
  description:
    'Members of the environments the caller may view, filtered to the members the caller may view: {type, id, name, environmentId, nodeIds} (Docker members also carry nodeId).',
  request: { params: AppParams, query: AppMembersQuerySchema },
  responses: okJson(UnknownListResponseSchema),
});

export const AppActivityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  environmentId: z.string().uuid().optional(),
});

export const AppNodeBodySchema = z.object({ nodeId: z.string().uuid() }).strict();
const EnvNodeParams = pathParamSchema('id', 'envId', 'nodeId');

const NODES_DESCRIPTION =
  'The nodes an environment may place workloads on. Creating, importing or moving a resource into the environment on another node is refused (APP_NODE_NOT_ALLOWED, or APP_ENV_NO_ALLOWED_NODE when no node of the needed type is allowed): containers, deployments and Compose need a Docker node, routes and Pages an Nginx node, managed databases and storage a database or storage node. Each node lists usedBy: how many members of each type run on it. Removing a node leaves what runs there running.';

export const listAppEnvironmentNodesRoute = appRoute({
  method: 'get',
  path: '/{id}/environments/{envId}/nodes',
  tags: TAGS,
  summary: 'List allowed nodes',
  description: `${NODES_DESCRIPTION} Needs view of the environment.`,
  request: { params: EnvParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const allowAppEnvironmentNodeRoute = appRoute({
  method: 'post',
  path: '/{id}/environments/{envId}/nodes',
  tags: TAGS,
  summary: 'Allow a node',
  description: `${NODES_DESCRIPTION} Needs apps:env:manage on the environment.`,
  request: { params: EnvParams, ...jsonBody(AppNodeBodySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const removeAppEnvironmentNodeRoute = appRoute({
  method: 'delete',
  path: '/{id}/environments/{envId}/nodes/{nodeId}',
  tags: TAGS,
  summary: 'Remove an allowed node',
  description: `${NODES_DESCRIPTION} Needs apps:env:manage on the environment.`,
  request: { params: EnvNodeParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const removeAppEnvironmentNodeByBodyRoute = appRoute({
  method: 'delete',
  path: '/{id}/environments/{envId}/nodes',
  tags: TAGS,
  summary: 'Remove an allowed node (node in the body)',
  description: `${NODES_DESCRIPTION} Needs apps:env:manage on the environment.`,
  request: { params: EnvParams, ...jsonBody(AppNodeBodySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

const VARIABLES_DESCRIPTION =
  'Environment variables and secrets every container, deployment and Compose project of the environment receives on its next create, recreate, deploy or apply (nothing restarts on save). Precedence, lowest first: image ENV, environment variables, environment secrets, the workload own environment, the workload own secrets. Keys match ^[A-Za-z_][A-Za-z0-9_]*$, at most 200 per environment, values up to 32 KiB; a key is either a variable or a secret. Secrets are write-only: only keys and update times are returned. pendingWorkloads lists the workloads that still run older values ({kind: container|deployment|compose, id, nodeId, name}; containers by name) so a client can recreate or redeploy them one at a time; a container recreate is queued on its node, follow its taskId with GET .../workload-tasks/{taskId}. Needs apps:env:manage on the environment.';

export const getAppVariablesRoute = appRoute({
  method: 'get',
  path: '/{id}/environments/{envId}/variables',
  tags: TAGS,
  summary: 'Get environment variables and secret keys',
  description: VARIABLES_DESCRIPTION,
  request: { params: EnvParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const setAppVariablesRoute = appRoute({
  method: 'put',
  path: '/{id}/environments/{envId}/variables',
  tags: TAGS,
  summary: 'Replace environment variables',
  description: `${VARIABLES_DESCRIPTION} The body is the full set of variables (secrets are not touched).`,
  request: { params: EnvParams, ...jsonBody(SetAppVariablesSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const patchAppSecretsRoute = appRoute({
  method: 'patch',
  path: '/{id}/environments/{envId}/secrets',
  tags: TAGS,
  summary: 'Set or delete environment secrets',
  description: `${VARIABLES_DESCRIPTION} set adds or replaces secrets, delete removes them by key.`,
  request: { params: EnvParams, ...jsonBody(PatchAppSecretsSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const getAppWorkloadTaskRoute = appRoute({
  method: 'get',
  path: '/{id}/environments/{envId}/workload-tasks/{taskId}',
  tags: TAGS,
  summary: 'Follow the recreate of an environment workload',
  description:
    'A Docker task of a container of the environment, such as the recreate a client starts to apply pendingWorkloads (the container recreate answers its taskId): {id, type, status: pending|running|succeeded|failed, progress, error, completedAt}. The recreate has finished only when status is succeeded; failed carries the error. Needs apps:env:manage on the environment, not docker:tasks. 404 for a task of anything else.',
  request: { params: pathParamSchema('id', 'envId', 'taskId') },
  responses: okJson(UnknownDataResponseSchema),
});

export const AppAccessCodeBodySchema = z.object({ environmentId: z.string().uuid().optional() }).strict();

export const createAppAccessCodeRoute = appRoute({
  method: 'post',
  path: '/{id}/maintenance-access-code',
  tags: TAGS,
  summary: 'Create a Maintenance Access Code for an app or environment',
  description:
    'One code for every route of the environment (environmentId; apps:env:manage on it) or of the whole app (no environmentId; apps:env:manage on the app) that is in maintenance on a node that supports team access. The code is for one user, valid 5 minutes, and opens each route once in a browser (Team access on the maintenance page). routeCount says how many routes it opens. Refused when no route of the scope is in maintenance.',
  request: { params: AppParams, ...jsonBody(AppAccessCodeBodySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const AppOverviewQuerySchema = z.object({ range: z.enum(['1h', '24h']).default('1h') });

export const getAppOverviewRoute = appRoute({
  method: 'get',
  path: '/{id}/overview',
  tags: TAGS,
  summary: 'App monitoring overview',
  description:
    'Per environment the caller may view: health, member count, issues (failing or degraded members per type), alerts ({tone: destructive for a failing member or warning for a nearly full disk or 5xx errors, title, detail}), and 24-point series over the range (1h or 24h) for containers (CPU, memory, unhealthy names), databases (disk, connections, transactions), storage (disk, objects, buckets, RX/TX), routes (requests, 5xx, p95 latency, traffic) and Pages (active deployment), plus the nodes the members run on. A database or storage on several servers carries `availability` {state, mode, stateReason, members[{memberId, nodeId, nodeName, role, primary, eligible, health: healthy|degraded|down|stopped}]} (null on one server); a set that lost a copy or cannot fail over counts degraded, not failing, while its primary answers. Only members the caller may view count; unknown values are null and unknown series empty. Cached for 15 seconds.',
  request: { params: AppParams, query: AppOverviewQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getAppActivityRoute = appRoute({
  method: 'get',
  path: '/{id}/activity',
  tags: TAGS,
  summary: 'App activity',
  description:
    'Audit entries about the app, its environments and its members since they joined, newest first, in the audit log row shape: {data, total, page, limit}. environmentId narrows to one environment (app-wide entries included). Entries about members you cannot view are left out.',
  request: { params: AppParams, query: AppActivityQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});
