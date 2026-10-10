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
  PlaceAppMembersSchema,
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
    'Needs apps:delete on the app. Members keep running and leave the app (they show at the top level of their lists); environment variables, secrets and allowed nodes are deleted, and grants naming the app, its environments or its folders are removed.',
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
    'Needs apps:edit on the app. The Production environment cannot be deleted. Members keep running and leave the app; variables, secrets and allowed nodes of the environment are deleted.',
  request: { params: EnvParams },
  responses: noContent,
});

export const placeAppMembersRoute = appRoute({
  method: 'post',
  path: '/members/place',
  tags: TAGS,
  summary: 'Move resources into, between or out of app environments',
  description:
    'target {appId, environmentId} imports or moves each member into that environment; target null takes them out of their app (top level of their lists). Members: {type, id} (deployment, compose, database, storage, route, pages by id) or {type: container, id: name, nodeId}. Needs apps:env:manage on the target environment and on the environment a member leaves, plus the edit permission of each member. Refused per member: system routes and the Gateway public URL route (ROUTE_NOT_PLACEABLE), a node the target environment does not allow (APP_NODE_NOT_ALLOWED), no permission (FORBIDDEN), unknown member (NOT_FOUND). Partial success: placed and refused are listed.',
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
