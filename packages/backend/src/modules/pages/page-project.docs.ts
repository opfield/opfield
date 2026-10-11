import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  CreatePageProjectSchema,
  MigratePageProjectSchema,
  PageProjectListQuerySchema,
  PageProjectPlacementOptionsQuerySchema,
  UpdatePageProjectSchema,
} from './page-project.schemas.js';

const tags = ['Pages'];

export const listPageProjectFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags,
  summary: 'List Page Project folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createPageProjectFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags,
  summary: 'Create a Page Project folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderPageProjectFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags,
  summary: 'Reorder Page Project folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const movePageProjectsToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-projects',
  tags,
  summary: 'Move Page Projects to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderPageProjectsRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-projects',
  tags,
  summary: 'Reorder Page Projects within a folder',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updatePageProjectFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags,
  summary: 'Rename a Page Project folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const movePageProjectFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags,
  summary: 'Move a Page Project folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deletePageProjectFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags,
  summary: 'Delete a Page Project folder and ungroup its Projects',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listPageProjectsRoute = appRoute({
  method: 'get',
  path: '/',
  tags,
  summary: 'List Page Projects',
  request: { query: PageProjectListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createPageProjectRoute = appRoute({
  method: 'post',
  path: '/',
  tags,
  summary: 'Create a Page Project',
  request: jsonBody(CreatePageProjectSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const listPageProjectPlacementOptionsRoute = appRoute({
  method: 'get',
  path: '/placement-options',
  tags,
  summary: 'List eligible Page Project placement nodes',
  request: { query: PageProjectPlacementOptionsQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getPageProjectRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags,
  summary: 'Get a Page Project',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getPageProjectBySlugRoute = appRoute({
  method: 'get',
  path: '/by-slug/{slug}',
  tags,
  summary: 'Resolve a Page Project by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});

export const updatePageProjectRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags,
  summary: 'Update a Page Project',
  request: { params: IdParamSchema, ...jsonBody(UpdatePageProjectSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const migratePageProjectRoute = appRoute({
  method: 'post',
  path: '/{id}/migrate',
  tags,
  summary: 'Migrate a Page Project to another Nginx node',
  request: { params: IdParamSchema, ...jsonBody(MigratePageProjectSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const rotatePageProjectPreviewHashRoute = appRoute({
  method: 'post',
  path: '/{id}/preview-hash/rotate',
  tags,
  summary: 'Rotate every preview link of a Page Project',
  description:
    'Gives the Project a new random preview hash and new Deployment preview slugs, revokes every old preview hostname at once, and republishes the new links. Requires pages:edit.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const syncPageProjectSourceRoute = appRoute({
  method: 'post',
  path: '/projects/{id}/source/sync',
  tags,
  summary: 'Sync the Git source of a Page Project now',
  description:
    'Checks the source branch for a new commit now instead of waiting for the next poll or webhook: one poll iteration for this source, also when automatic builds are off. The head is resolved with the connector credentials and recorded as the desired commit; a `poll` build is queued only when the source builds automatically and the head changed or has no build yet. Returns `{ source, changed, build }` (`build` is null when nothing was queued). Within about 10 seconds of the previous poll or sync the current state is returned without asking the Git provider. A Git provider failure answers 502 SOURCE_SYNC_FAILED and is kept as the last poll error. Requires pages:deploy on the Project, like a manual build; no integrations:<provider>:use is needed.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const deletePageProjectRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags,
  summary: 'Delete an empty Page Project',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
