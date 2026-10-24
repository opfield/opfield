import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  successJson,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  CreateFolderSchema,
  GroupedHostsQuerySchema,
  MoveFolderSchema,
  MoveHostsToFolderSchema,
  ReorderFoldersSchema,
  ReorderHostsSchema,
  UpdateFolderSchema,
} from './folder.schemas.js';

export const listProxyFoldersRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Route Folders'],
  summary: 'List route folders',
  responses: okJson(UnknownDataResponseSchema),
});
export const groupedProxyHostsRoute = appRoute({
  method: 'get',
  path: '/grouped',
  tags: ['Route Folders'],
  summary: 'List grouped ingress routes and folders',
  description:
    'User folders with their routes, plus routes outside any folder. Routes that belong to an app are left out; with appId, only the routes of that app come back, flat in ungroupedHosts with their app field, and folders is empty.',
  request: { query: GroupedHostsQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const createProxyFolderRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Route Folders'],
  summary: 'Create a route folder',
  request: jsonBody(CreateFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const moveProxyHostsRoute = appRoute({
  method: 'post',
  path: '/move-hosts',
  tags: ['Route Folders'],
  summary: 'Move routes into a folder',
  request: jsonBody(MoveHostsToFolderSchema),
  responses: successJson,
});
export const reorderProxyFoldersRoute = appRoute({
  method: 'put',
  path: '/reorder',
  tags: ['Route Folders'],
  summary: 'Reorder route folders',
  request: jsonBody(ReorderFoldersSchema),
  responses: successJson,
});
export const reorderProxyHostsRoute = appRoute({
  method: 'put',
  path: '/reorder-hosts',
  tags: ['Route Folders'],
  summary: 'Reorder routes',
  request: jsonBody(ReorderHostsSchema),
  responses: successJson,
});
export const updateProxyFolderRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Route Folders'],
  summary: 'Update a route folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const moveProxyFolderRoute = appRoute({
  method: 'put',
  path: '/{id}/move',
  tags: ['Route Folders'],
  summary: 'Move a route folder',
  request: { params: IdParamSchema, ...jsonBody(MoveFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteProxyFolderRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Route Folders'],
  summary: 'Delete a route folder',
  request: { params: IdParamSchema },
  responses: successJson,
});
