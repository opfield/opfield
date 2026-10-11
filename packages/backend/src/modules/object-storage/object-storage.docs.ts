import { z } from '@hono/zod-openapi';
import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  CreateBucketSchema,
  CreateObjectStorageConnectionSchema,
  CreatePrefixSchema,
  DeleteObjectsSchema,
  DeleteStorageQuerySchema,
  ListObjectsQuerySchema,
  ObjectMetadataQuerySchema,
  ObjectStorageListQuerySchema,
  PresignObjectSchema,
  UpdateObjectStorageConnectionSchema,
} from './object-storage.schemas.js';

const TAG = 'Object Storage';
export const BucketQuerySchema = z.object({ bucket: z.string().min(1).max(255) });

// ── Connections ─────────────────────────────────────────────────────

export const listObjectStorageConnectionsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: 'List object storage connections',
  request: { query: ObjectStorageListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createObjectStorageConnectionRoute = appRoute({
  method: 'post',
  path: '/',
  tags: [TAG],
  summary: 'Create an object storage connection',
  request: jsonBody(CreateObjectStorageConnectionSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const getObjectStorageConnectionRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: [TAG],
  summary: 'Get an object storage connection',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getObjectStorageConnectionBySlugRoute = appRoute({
  method: 'get',
  path: '/by-slug/{slug}',
  tags: [TAG],
  summary: 'Get an object storage connection by slug',
  request: { params: z.object({ slug: z.string().min(1) }) },
  responses: okJson(UnknownDataResponseSchema),
});

export const getObjectStorageHealthHistoryRoute = appRoute({
  method: 'get',
  path: '/{id}/health-history',
  tags: [TAG],
  summary: 'Get object storage health history',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateObjectStorageConnectionRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: [TAG],
  summary: 'Update an object storage connection',
  request: { params: IdParamSchema, ...jsonBody(UpdateObjectStorageConnectionSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteObjectStorageConnectionRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: [TAG],
  summary: 'Delete an object storage connection',
  description:
    'Refused while backup policies or active backup runs use the storage. Finished backup history also blocks deletion (409 STORAGE_BACKUP_HISTORY_EXISTS with historyRecords and backupsWithFiles) unless backupHistory=forget confirms removing it; forgotten backups can no longer be restored or deleted through Opfield, and their files are not deleted.',
  request: { params: IdParamSchema, query: DeleteStorageQuerySchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const testObjectStorageConnectionRoute = appRoute({
  method: 'post',
  path: '/{id}/test',
  tags: [TAG],
  summary: 'Test a saved object storage connection',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const revealObjectStorageCredentialsRoute = appRoute({
  method: 'get',
  path: '/{id}/reveal-credentials',
  tags: [TAG],
  summary: 'Reveal stored object storage credentials',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const objectStorageMonitoringStreamRoute = appRoute({
  method: 'get',
  path: '/{id}/monitoring/stream',
  tags: [TAG],
  summary: 'Stream object storage monitoring snapshots',
  request: { params: IdParamSchema },
  responses: { 200: { description: 'Server-sent events stream' } },
});

// ── Folders ─────────────────────────────────────────────────────────

export const listObjectStorageFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags: [TAG],
  summary: 'List object storage folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createObjectStorageFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags: [TAG],
  summary: 'Create an object storage folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderObjectStorageFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags: [TAG],
  summary: 'Reorder object storage folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(z.object({ success: z.boolean() })),
});

export const moveObjectStorageToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-connections',
  tags: [TAG],
  summary: 'Move connections to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(z.object({ success: z.boolean() })),
});

export const reorderObjectStorageRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-connections',
  tags: [TAG],
  summary: 'Reorder connections',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(z.object({ success: z.boolean() })),
});

export const updateObjectStorageFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags: [TAG],
  summary: 'Update an object storage folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveObjectStorageFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags: [TAG],
  summary: 'Move an object storage folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteObjectStorageFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags: [TAG],
  summary: 'Delete an object storage folder',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

// ── Object browser ──────────────────────────────────────────────────

export const listBucketsRoute = appRoute({
  method: 'get',
  path: '/{id}/buckets',
  tags: [TAG],
  summary: 'List buckets',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createBucketRoute = appRoute({
  method: 'post',
  path: '/{id}/buckets',
  tags: [TAG],
  summary: 'Create a bucket',
  request: { params: IdParamSchema, ...jsonBody(CreateBucketSchema) },
  responses: createdJson(z.object({ success: z.boolean() })),
});

export const deleteBucketRoute = appRoute({
  method: 'delete',
  path: '/{id}/buckets',
  tags: [TAG],
  summary: 'Delete a bucket',
  request: { params: IdParamSchema, query: BucketQuerySchema },
  responses: okJson(z.object({ success: z.boolean() })),
});

export const listObjectsRoute = appRoute({
  method: 'get',
  path: '/{id}/objects',
  tags: [TAG],
  summary: 'List objects by prefix',
  request: { params: IdParamSchema, query: ListObjectsQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const objectMetadataRoute = appRoute({
  method: 'get',
  path: '/{id}/objects/metadata',
  tags: [TAG],
  summary: 'Get object metadata',
  request: { params: IdParamSchema, query: ObjectMetadataQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const downloadObjectRoute = appRoute({
  method: 'get',
  path: '/{id}/objects/download',
  tags: [TAG],
  summary: 'Download an object',
  request: { params: IdParamSchema, query: ObjectMetadataQuerySchema },
  responses: { 200: { description: 'Object bytes' } },
});

export const presignObjectRoute = appRoute({
  method: 'post',
  path: '/{id}/objects/presign',
  tags: [TAG],
  summary: 'Generate a presigned URL',
  description:
    'A URL for an S3 connection. For managed storage reachable only through Opfield (private relay) the request is refused with 409 STORAGE_PRESIGN_UNSUPPORTED; once its S3 endpoint is published, the URL points at the published endpoint (the node address and published port). SFTP and FTP(S) connections have no presigned URLs.',
  request: { params: IdParamSchema, ...jsonBody(PresignObjectSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const uploadObjectRoute = appRoute({
  method: 'post',
  path: '/{id}/objects/upload',
  tags: [TAG],
  summary: 'Upload an object',
  description:
    'The raw request body is the object; it is streamed into storage. One object may be as large as the file upload limit in Settings (`fileUploadMaxBytes` of GET /api/system/config; 100 MB unless changed, at most 500 MB), not the general API request body limit. A larger body is refused with 413 STORAGE_UPLOAD_TOO_LARGE, whose `details.maxBytes` is the limit. The MCP upload_storage_object tool takes the same limit.',
  request: {
    params: IdParamSchema,
    query: ObjectMetadataQuerySchema.extend({ contentType: z.string().max(255).optional() }),
  },
  responses: createdJson(z.object({ success: z.boolean() })),
});

export const createPrefixRoute = appRoute({
  method: 'post',
  path: '/{id}/objects/prefix',
  tags: [TAG],
  summary: 'Create a prefix (folder)',
  request: { params: IdParamSchema, ...jsonBody(CreatePrefixSchema) },
  responses: createdJson(z.object({ success: z.boolean() })),
});

export const deleteObjectsRoute = appRoute({
  method: 'delete',
  path: '/{id}/objects',
  tags: [TAG],
  summary: 'Delete objects',
  request: { params: IdParamSchema, ...jsonBody(DeleteObjectsSchema) },
  responses: okJson(z.object({ success: z.boolean() })),
});
