import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  dataResponseSchema,
  IdParamSchema,
  jsonBody,
  okJson,
  pathParamSchema,
  successJson,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
} from '@/modules/docker/docker.schemas.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import {
  CreateNodeSchema,
  NodeListQuerySchema,
  UpdateNodeSchema,
  UpdateNodeServiceCreationLockSchema,
} from './nodes.schemas.js';

const ConfigBodySchema = z.object({
  content: z.string().min(1).openapi({ example: 'worker_processes auto;' }),
});

const NodeConfigResponseSchema = dataResponseSchema(
  z.object({
    content: z.string(),
  })
);

const ConfigTestResponseSchema = dataResponseSchema(
  z.object({
    valid: z.boolean(),
    error: z.string().optional(),
  })
);

const CreateNodeResponseSchema = dataResponseSchema(
  z.object({
    node: z
      .object({
        id: z.string().uuid(),
        type: z.enum(['nginx', 'bastion', 'monitoring', 'docker', 'builder', 'databases', 'storage', 'relay']),
        hostname: z.string(),
        status: z.enum(['pending', 'online', 'offline', 'error']),
      })
      .catchall(z.any()),
    enrollmentToken: z.string().openapi({
      description: 'One-time enrollment token. Returned only once.',
      example: 'opf_node_v2_0123456789abcdef_0123456789abcdef0123456789abcdef0123456789abcdef',
    }),
    enrollmentTokenExpiresAt: z.string().datetime().optional().openapi({
      description: 'Time after which the unused enrollment token is rejected.',
    }),
    opfieldCertSha256: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .openapi({
        description: 'SHA-256 fingerprint of the active Opfield gRPC TLS leaf certificate.',
        example: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    opfieldEnrollmentTargets: z
      .object({
        public: z.object({ label: z.string(), address: z.string().nullable() }),
        local: z.object({ label: z.string(), address: z.string() }).optional(),
      })
      .openapi({
        description:
          'Backend-derived gRPC enrollment targets. A null public Opfield target is not configured yet; installCommands then use the host of this request.',
      }),
    installerRelease: z.string().nullable().openapi({
      description:
        'Opfield release whose installers the setup commands download and verify. Null for an unreleased build, whose commands run the installers from main.',
      example: 'v2.11.0',
    }),
    installCommands: z
      .array(
        z.object({
          target: z.enum(['public', 'local']),
          label: z.string(),
          address: z.string(),
          curl: z.string(),
          wget: z.string(),
        })
      )
      .openapi({
        description:
          'Setup command for each enrollment target, using curl or wget. A release build downloads the installer of its own release, checks it against opfield-node-installers.sha256 and pins the daemon release that matches this Opfield installation.',
      }),
  })
);

const LogQuerySchema = z.object({
  level: z.string().optional().openapi({ example: 'info,warn,error' }),
  search: z.string().optional(),
});

const MonitoringStreamQuerySchema = z.object({
  focused: z.enum(['true']).optional(),
});

const UploadIdParamSchema = z.object({
  uploadId: z.string().min(1),
});

export const listNodesRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Nodes'],
  summary: 'List nodes',
  request: { query: NodeListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listNodeFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags: ['Nodes'],
  summary: 'List node folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createNodeFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags: ['Nodes'],
  summary: 'Create a node folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderNodeFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags: ['Nodes'],
  summary: 'Reorder node folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: successJson,
});

export const moveNodesToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-nodes',
  tags: ['Nodes'],
  summary: 'Move nodes to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: successJson,
});

export const reorderNodesRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-nodes',
  tags: ['Nodes'],
  summary: 'Reorder nodes within a folder',
  request: jsonBody(ReorderResourcesSchema),
  responses: successJson,
});

export const updateNodeFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags: ['Nodes'],
  summary: 'Rename a node folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveNodeFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags: ['Nodes'],
  summary: 'Move a node folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteNodeFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags: ['Nodes'],
  summary: 'Delete a node folder',
  request: { params: IdParamSchema },
  responses: successJson,
});

export const getNodeRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Nodes'],
  summary: 'Get node details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getNodeBySlugRoute = appRoute({
  method: 'get',
  path: '/by-slug/{slug}',
  tags: ['Nodes'],
  summary: 'Resolve node details by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});

export const getNodeHealthHistoryRoute = appRoute({
  method: 'get',
  path: '/{id}/health-history',
  tags: ['Nodes'],
  summary: 'Get node health history',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listNodeFilesRoute = appRoute({
  method: 'get',
  path: '/{id}/files',
  tags: ['Nodes'],
  summary: 'List node files',
  request: { params: IdParamSchema, query: FileBrowseSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const readNodeFileRoute = appRoute({
  method: 'get',
  path: '/{id}/files/read',
  tags: ['Nodes'],
  summary: 'Read node file',
  request: { params: IdParamSchema, query: FileBrowseSchema },
  responses: okJson(z.any()),
});

export const writeNodeFileRoute = appRoute({
  method: 'put',
  path: '/{id}/files/write',
  tags: ['Nodes'],
  summary: 'Write node file',
  request: { params: IdParamSchema, query: FileBrowseSchema },
  responses: successJson,
});

export const createNodeFileRoute = appRoute({
  method: 'post',
  path: '/{id}/files/create',
  tags: ['Nodes'],
  summary: 'Create or overwrite node file',
  request: { params: IdParamSchema, query: FileBrowseSchema },
  responses: successJson,
});

export const initNodeFileUploadRoute = appRoute({
  method: 'post',
  path: '/{id}/files/uploads',
  tags: ['Nodes'],
  summary: 'Initialize node file upload',
  request: { params: IdParamSchema, ...jsonBody(FileUploadInitSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const uploadNodeFileChunkRoute = appRoute({
  method: 'put',
  path: '/{id}/files/uploads/{uploadId}/chunks',
  tags: ['Nodes'],
  summary: 'Upload node file chunk',
  request: { params: IdParamSchema.merge(UploadIdParamSchema), query: FileUploadChunkQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const completeNodeFileUploadRoute = appRoute({
  method: 'post',
  path: '/{id}/files/uploads/{uploadId}/complete',
  tags: ['Nodes'],
  summary: 'Complete node file upload',
  request: { params: IdParamSchema.merge(UploadIdParamSchema), ...jsonBody(FileUploadCompleteSchema) },
  responses: successJson,
});

export const abortNodeFileUploadRoute = appRoute({
  method: 'delete',
  path: '/{id}/files/uploads/{uploadId}',
  tags: ['Nodes'],
  summary: 'Abort node file upload',
  request: { params: IdParamSchema.merge(UploadIdParamSchema) },
  responses: successJson,
});

export const createNodeDirectoryRoute = appRoute({
  method: 'post',
  path: '/{id}/files/directory',
  tags: ['Nodes'],
  summary: 'Create node directory',
  request: { params: IdParamSchema, ...jsonBody(FileBrowseSchema) },
  responses: successJson,
});

export const deleteNodeFileRoute = appRoute({
  method: 'delete',
  path: '/{id}/files',
  tags: ['Nodes'],
  summary: 'Delete node file or directory',
  request: { params: IdParamSchema, query: FileBrowseSchema },
  responses: successJson,
});

export const moveNodeFileRoute = appRoute({
  method: 'post',
  path: '/{id}/files/move',
  tags: ['Nodes'],
  summary: 'Move node file or directory',
  request: { params: IdParamSchema, ...jsonBody(FileMoveSchema) },
  responses: successJson,
});

export const createNodeRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Nodes'],
  summary: 'Create node enrollment',
  request: jsonBody(CreateNodeSchema),
  responses: createdJson(CreateNodeResponseSchema),
});

export const regenerateNodeEnrollmentTokenRoute = appRoute({
  method: 'post',
  path: '/{id}/enrollment-token',
  tags: ['Nodes'],
  summary: 'Regenerate the enrollment token of a node that has not enrolled yet',
  request: { params: IdParamSchema },
  responses: okJson(CreateNodeResponseSchema),
});

export const updateNodeRoute = appRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Nodes'],
  summary: 'Update node display metadata',
  request: { params: IdParamSchema, ...jsonBody(UpdateNodeSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const updateNodeServiceCreationLockRoute = appRoute({
  method: 'patch',
  path: '/{id}/service-creation-lock',
  tags: ['Nodes'],
  summary: 'Lock or unlock new service creation on a node',
  description:
    'nginx, Docker and Build Worker nodes. A locked Build Worker takes no new builds; builds it runs finish. While every online Build Worker is locked, new builds are refused (503) and queued builds wait.',
  request: { params: IdParamSchema, ...jsonBody(UpdateNodeServiceCreationLockSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteNodeRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Nodes'],
  summary: 'Delete a node',
  request: {
    params: IdParamSchema,
    query: z.object({ cascadeProxyHosts: z.enum(['true']).optional() }),
  },
  responses: successJson,
});

export const getNodeConfigRoute = appRoute({
  method: 'get',
  path: '/{id}/config',
  tags: ['Nodes'],
  summary: 'Read nginx global config from a node',
  request: { params: IdParamSchema },
  responses: okJson(NodeConfigResponseSchema),
});

export const updateNodeConfigRoute = appRoute({
  method: 'put',
  path: '/{id}/config',
  tags: ['Nodes'],
  summary: 'Update nginx global config on a node',
  request: { params: IdParamSchema, ...jsonBody(ConfigBodySchema) },
  responses: okJson(ConfigTestResponseSchema),
});

export const testNodeConfigRoute = appRoute({
  method: 'post',
  path: '/{id}/config/test',
  tags: ['Nodes'],
  summary: 'Test nginx config on a node',
  request: { params: IdParamSchema },
  responses: okJson(ConfigTestResponseSchema),
});

export const nodeMonitoringStreamRoute = appRoute({
  method: 'get',
  path: '/{id}/monitoring/stream',
  tags: ['Nodes'],
  summary: 'Stream node monitoring snapshots over SSE',
  request: { params: IdParamSchema, query: MonitoringStreamQuerySchema },
  responses: { 200: { description: 'Server-sent event stream' } },
});

export const nodeDaemonLogsRoute = appRoute({
  method: 'get',
  path: '/{id}/logs',
  tags: ['Nodes'],
  summary: 'Stream daemon logs for a node',
  request: { params: IdParamSchema, query: LogQuerySchema },
  responses: { 200: { description: 'Server-sent event stream' } },
});

export const nodeNginxLogsRoute = appRoute({
  method: 'get',
  path: '/{id}/nginx-logs',
  tags: ['Nodes'],
  summary: 'Stream nginx access and error logs for a node',
  request: {
    params: IdParamSchema,
    query: LogQuerySchema.extend({
      hostId: z.string().optional(),
    }),
  },
  responses: { 200: { description: 'Server-sent event stream' } },
});
