import { z } from '@hono/zod-openapi';
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
  CreateLoggingEnvironmentSchema,
  CreateLoggingSchemaSchema,
  CreateLoggingTokenSchema,
  LoggingBatchSchema,
  LoggingFacetsQuerySchema,
  UpdateLoggingEnvironmentSchema,
  UpdateLoggingSchemaSchema,
} from './logging.schemas.js';

const schemaParams = pathParamSchema('schemaId');
const tokenParams = pathParamSchema('id', 'tokenId');
const LoggingSearchDocsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
  services: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  expression: z.unknown().optional(),
});

export const loggingIngestRoute = appRoute({
  method: 'post',
  path: '/ingest',
  tags: ['Logging'],
  summary: 'Ingest one log event',
  security: [],
  request: jsonBody(z.unknown()),
  responses: okJson(UnknownDataResponseSchema),
});
export const loggingBatchIngestRoute = appRoute({
  method: 'post',
  path: '/ingest/batch',
  tags: ['Logging'],
  summary: 'Ingest a batch of log events',
  security: [],
  request: jsonBody(LoggingBatchSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const loggingHealthRoute = appRoute({
  method: 'get',
  path: '/health',
  tags: ['Logging'],
  summary: 'Get ClickHouse logging storage health',
  responses: okJson(UnknownDataResponseSchema),
});
export const listLoggingEnvironmentsRoute = appRoute({
  method: 'get',
  path: '/environments',
  tags: ['Logging'],
  summary: 'List logging environments',
  request: {
    query: z.object({
      search: z.string().optional(),
      /** Leave out environments that belong to an app (the normal list). */
      excludeAppMembers: z.enum(['true', 'false', '1', '0']).optional(),
      /** Only the environments of this app (any environment of it). */
      appId: z.string().uuid().optional(),
    }),
  },
  responses: okJson(UnknownDataResponseSchema),
});
export const createLoggingEnvironmentRoute = appRoute({
  method: 'post',
  path: '/environments',
  tags: ['Logging'],
  summary: 'Create a logging environment',
  request: jsonBody(CreateLoggingEnvironmentSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const getLoggingEnvironmentRoute = appRoute({
  method: 'get',
  path: '/environments/{id}',
  tags: ['Logging'],
  summary: 'Get a logging environment',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const getLoggingEnvironmentBySlugRoute = appRoute({
  method: 'get',
  path: '/environments/by-slug/{slug}',
  tags: ['Logging'],
  summary: 'Resolve a logging environment by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});
export const updateLoggingEnvironmentRoute = appRoute({
  method: 'put',
  path: '/environments/{id}',
  tags: ['Logging'],
  summary: 'Update a logging environment',
  request: { params: IdParamSchema, ...jsonBody(UpdateLoggingEnvironmentSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteLoggingEnvironmentRoute = appRoute({
  method: 'delete',
  path: '/environments/{id}',
  tags: ['Logging'],
  summary: 'Delete a logging environment',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});
export const listLoggingEnvironmentFoldersRoute = appRoute({
  method: 'get',
  path: '/environment-folders',
  tags: ['Logging Folders'],
  summary: 'List logging environment folders',
  responses: okJson(UnknownDataResponseSchema),
});
export const createLoggingEnvironmentFolderRoute = appRoute({
  method: 'post',
  path: '/environment-folders',
  tags: ['Logging Folders'],
  summary: 'Create a logging environment folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const reorderLoggingEnvironmentFoldersRoute = appRoute({
  method: 'put',
  path: '/environment-folders/reorder',
  tags: ['Logging Folders'],
  summary: 'Reorder logging environment folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const moveLoggingEnvironmentsToFolderRoute = appRoute({
  method: 'post',
  path: '/environment-folders/move-environments',
  tags: ['Logging Folders'],
  summary: 'Move logging environments to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const reorderLoggingEnvironmentsRoute = appRoute({
  method: 'put',
  path: '/environment-folders/reorder-environments',
  tags: ['Logging Folders'],
  summary: 'Reorder logging environments',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const updateLoggingEnvironmentFolderRoute = appRoute({
  method: 'put',
  path: '/environment-folders/{id}',
  tags: ['Logging Folders'],
  summary: 'Update a logging environment folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const moveLoggingEnvironmentFolderRoute = appRoute({
  method: 'put',
  path: '/environment-folders/{id}/move',
  tags: ['Logging Folders'],
  summary: 'Move a logging environment folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteLoggingEnvironmentFolderRoute = appRoute({
  method: 'delete',
  path: '/environment-folders/{id}',
  tags: ['Logging Folders'],
  summary: 'Delete a logging environment folder',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const listLoggingSchemasRoute = appRoute({
  method: 'get',
  path: '/schemas',
  tags: ['Logging'],
  summary: 'List logging schemas',
  request: { query: z.object({ search: z.string().optional() }) },
  responses: okJson(UnknownDataResponseSchema),
});
export const listLoggingSchemaFoldersRoute = appRoute({
  method: 'get',
  path: '/schema-folders',
  tags: ['Logging Folders'],
  summary: 'List logging schema folders',
  responses: okJson(UnknownDataResponseSchema),
});
export const createLoggingSchemaFolderRoute = appRoute({
  method: 'post',
  path: '/schema-folders',
  tags: ['Logging Folders'],
  summary: 'Create a logging schema folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const reorderLoggingSchemaFoldersRoute = appRoute({
  method: 'put',
  path: '/schema-folders/reorder',
  tags: ['Logging Folders'],
  summary: 'Reorder logging schema folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const moveLoggingSchemasToFolderRoute = appRoute({
  method: 'post',
  path: '/schema-folders/move-schemas',
  tags: ['Logging Folders'],
  summary: 'Move logging schemas to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const reorderLoggingSchemasRoute = appRoute({
  method: 'put',
  path: '/schema-folders/reorder-schemas',
  tags: ['Logging Folders'],
  summary: 'Reorder logging schemas',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const updateLoggingSchemaFolderRoute = appRoute({
  method: 'put',
  path: '/schema-folders/{id}',
  tags: ['Logging Folders'],
  summary: 'Update a logging schema folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const moveLoggingSchemaFolderRoute = appRoute({
  method: 'put',
  path: '/schema-folders/{id}/move',
  tags: ['Logging Folders'],
  summary: 'Move a logging schema folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteLoggingSchemaFolderRoute = appRoute({
  method: 'delete',
  path: '/schema-folders/{id}',
  tags: ['Logging Folders'],
  summary: 'Delete a logging schema folder',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const createLoggingSchemaRoute = appRoute({
  method: 'post',
  path: '/schemas',
  tags: ['Logging'],
  summary: 'Create a logging schema',
  request: jsonBody(CreateLoggingSchemaSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const getLoggingSchemaRoute = appRoute({
  method: 'get',
  path: '/schemas/{schemaId}',
  tags: ['Logging'],
  summary: 'Get a logging schema',
  request: { params: schemaParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const getLoggingSchemaBySlugRoute = appRoute({
  method: 'get',
  path: '/schemas/by-slug/{slug}',
  tags: ['Logging'],
  summary: 'Resolve a logging schema by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});
export const updateLoggingSchemaRoute = appRoute({
  method: 'put',
  path: '/schemas/{schemaId}',
  tags: ['Logging'],
  summary: 'Update a logging schema',
  request: { params: schemaParams, ...jsonBody(UpdateLoggingSchemaSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteLoggingSchemaRoute = appRoute({
  method: 'delete',
  path: '/schemas/{schemaId}',
  tags: ['Logging'],
  summary: 'Delete a logging schema',
  request: { params: schemaParams },
  responses: { 204: { description: 'No content' } },
});
export const listLoggingTokensRoute = appRoute({
  method: 'get',
  path: '/environments/{id}/tokens',
  tags: ['Logging'],
  summary: 'List logging tokens',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const createLoggingTokenRoute = appRoute({
  method: 'post',
  path: '/environments/{id}/tokens',
  tags: ['Logging'],
  summary: 'Create a logging token',
  request: { params: IdParamSchema, ...jsonBody(CreateLoggingTokenSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const deleteLoggingTokenRoute = appRoute({
  method: 'delete',
  path: '/environments/{id}/tokens/{tokenId}',
  tags: ['Logging'],
  summary: 'Delete a logging token',
  request: { params: tokenParams },
  responses: { 204: { description: 'No content' } },
});
export const searchLogsRoute = appRoute({
  method: 'post',
  path: '/environments/{id}/search',
  tags: ['Logging'],
  summary: 'Search logs',
  request: { params: IdParamSchema, ...jsonBody(LoggingSearchDocsSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const loggingFacetsRoute = appRoute({
  method: 'get',
  path: '/environments/{id}/facets',
  tags: ['Logging'],
  summary: 'Get log facets',
  request: { params: IdParamSchema, query: LoggingFacetsQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const loggingMetadataRoute = appRoute({
  method: 'get',
  path: '/environments/{id}/metadata',
  tags: ['Logging'],
  summary: 'Get log metadata',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
