import { z } from '@hono/zod-openapi';
import {
  ApiErrorSchema,
  appRoute,
  createdJson,
  dataResponseSchema,
  jsonBody,
  jsonContent,
  okJson,
  optionalJsonBody,
  pathParamSchema,
  successJson,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import {
  ContainerArchiveExportQuerySchema,
  ContainerArchiveImportQuerySchema,
  ContainerArchivePlanSchema,
  ContainerCreateSchema,
  ContainerDuplicateSchema,
  ContainerKillSchema,
  ContainerLiveUpdateSchema,
  ContainerRecreateSchema,
  ContainerRenameSchema,
  ContainerStopSchema,
  ContainerUpdateSchema,
  DockerHealthCheckUpsertSchema,
  EnvUpdateSchema,
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadChunkQuerySchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  ImagePullSchema,
  LogQuerySchema,
  NetworkConnectSchema,
  NetworkCreateSchema,
  RegistryCreateSchema,
  RegistryUpdateSchema,
  SecretCreateSchema,
  SecretUpdateSchema,
  VolumeCreateSchema,
  VolumeLabelsUpdateSchema,
  VolumeRenameSchema,
  VolumeResizeSchema,
} from './docker.schemas.js';
import { DockerSourceResourceCreateSchema } from './docker-build.schemas.js';
import {
  DockerDeploymentCreateSchema,
  DockerDeploymentDeploySchema,
  DockerDeploymentSwitchSchema,
  DockerDeploymentUpdateSchema,
} from './docker-deployment.schemas.js';
import {
  CreateDockerFolderSchema,
  DockerFolderPlacementsSchema,
  DockerFolderResourceTypeSchema,
  MoveDockerContainersToFolderSchema,
  MoveDockerFolderSchema,
  MoveDockerResourcesToFolderSchema,
  ReorderDockerContainersSchema,
  ReorderDockerFoldersSchema,
  ReorderDockerResourcesSchema,
  UpdateDockerFolderSchema,
} from './docker-folder.schemas.js';
import { ImageCleanupUpsertSchema } from './docker-image-cleanup.schemas.js';
import { WebhookTriggerSchema, WebhookUpsertSchema } from './docker-webhook.schemas.js';
import { DockerInternalRegistryUpdateSchema } from './registry-storage/registry-storage.schemas.js';

export const nodeParams = pathParamSchema('nodeId');
export const containerParams = pathParamSchema('nodeId', 'containerId');
export const containerNameParams = pathParamSchema('nodeId', 'containerName');
export const deploymentParams = pathParamSchema('nodeId', 'deploymentId');
const dockerNodeSlugParams = pathParamSchema('nodeSlug');
const deploymentNameParams = pathParamSchema('nodeId', 'deploymentName');
const containerUploadParams = pathParamSchema('nodeId', 'containerId', 'uploadId');

const imageParams = pathParamSchema('nodeId', 'imageId');
const volumeParams = pathParamSchema('nodeId', 'name');
const volumeUploadParams = pathParamSchema('nodeId', 'name', 'uploadId');
const networkParams = pathParamSchema('nodeId', 'networkId');
const registryParams = pathParamSchema('id');
const taskParams = pathParamSchema('id');
const containerSecretParams = pathParamSchema('nodeId', 'containerId', 'secretId');
const deploymentSecretParams = pathParamSchema('nodeId', 'deploymentId', 'secretId');
const dockerListQuery = z.object({ search: z.string().trim().optional() });

export const getDockerBuildAdmissionRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/source-resources/admission',
  tags: ['Docker Builds'],
  summary: 'Check internal registry and isolated Build Worker admission',
  request: { params: nodeParams },
  responses: okJson(
    z.object({
      data: z.object({
        ready: z.boolean(),
        code: z.string().nullable(),
        message: z.string().nullable(),
      }),
    })
  ),
});

export const createDockerSourceResourceRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/source-resources',
  tags: ['Docker Builds'],
  summary: 'Create a Business+ Docker resource from Git and queue its first immutable build',
  request: { params: nodeParams, ...jsonBody(DockerSourceResourceCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const preflightDockerRuntimeRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/runtime/runsc/preflight',
  tags: ['Docker Nodes'],
  summary: 'Check runsc compatibility and health',
  request: { params: nodeParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const installDockerRuntimeRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/runtime/runsc/install',
  tags: ['Docker Nodes'],
  summary: 'Install and verify runsc on a Docker node',
  request: { params: nodeParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const getDockerNodeBySlugRoute = appRoute({
  method: 'get',
  path: '/nodes/by-slug/{nodeSlug}',
  tags: ['Docker Nodes'],
  summary: 'Resolve compact Docker node route context by slug',
  request: { params: dockerNodeSlugParams },
  responses: okJson(
    z.object({
      data: z.object({
        id: z.string().uuid(),
        slug: z.string(),
        type: z.literal('docker'),
        hostname: z.string(),
        displayName: z.string().nullable(),
        appearanceColor: z.string().nullable(),
      }),
    })
  ),
});

export const listContainersRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers',
  tags: ['Docker Containers'],
  summary: 'List containers',
  request: { params: nodeParams, query: dockerListQuery },
  responses: okJson(UnknownDataResponseSchema),
});
export const listContainerGpuUsageRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/gpu-usage',
  tags: ['Docker Containers'],
  summary: 'List visible container users for each managed GPU',
  request: { params: nodeParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const createContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers',
  tags: ['Docker Containers'],
  summary: 'Create a container',
  request: { params: nodeParams, ...jsonBody(ContainerCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const inspectContainerRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}',
  tags: ['Docker Containers'],
  summary: 'Inspect a container',
  request: { params: containerParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const inspectContainerByNameRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/by-name/{containerName}',
  tags: ['Docker Containers'],
  summary: 'Inspect a container by exact name',
  request: { params: containerNameParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const startContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/start',
  tags: ['Docker Containers'],
  summary: 'Start a container',
  request: { params: containerParams },
  responses: successJson,
});
const ContainerOperationPendingSchema = z.object({
  taskId: z.string().nullable(),
  containerId: z.string(),
  name: z.string(),
  transition: z.enum(['stopping', 'restarting', 'killing']),
});
/** A lifecycle request waits at most 45 s; an operation still running then is answered 202 with its task. */
const operationPendingJson = (description: string) => ({
  202: { description, content: jsonContent(dataResponseSchema(ContainerOperationPendingSchema)) },
});

export const stopContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/stop',
  tags: ['Docker Containers'],
  summary: 'Stop a container',
  description:
    'Answers 200 once the container has stopped, so a read or a removal right after sees it stopped; a stop already running is waited for. The request waits at most 45 s: a stop still running then (a long stop timeout) is answered 202 with its task and `transition: stopping`. Follow the task (GET /docker/tasks/{taskId}) or read the container until it is exited.',
  request: { params: containerParams, ...optionalJsonBody(ContainerStopSchema) },
  responses: { ...successJson, ...operationPendingJson('The stop still runs; follow its task') },
});
export const restartContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/restart',
  tags: ['Docker Containers'],
  summary: 'Restart a container',
  description:
    'Answers 200 once Docker has started the container again. The request waits at most 45 s: a restart still running then is answered 202 with its task and `transition: restarting`.',
  request: { params: containerParams, ...optionalJsonBody(ContainerStopSchema) },
  responses: { ...successJson, ...operationPendingJson('The restart still runs; follow its task') },
});
export const killContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/kill',
  tags: ['Docker Containers'],
  summary: 'Kill a container',
  description:
    'SIGKILL (the default) answers 200 once the container has exited, or 202 with its task and `transition: killing` when it has not within 45 s. Another signal answers 200 once it was delivered; the container may keep running. A container that is not running has no process to signal: the kill answers 200 at once, as a stop of it does.',
  request: { params: containerParams, ...optionalJsonBody(ContainerKillSchema) },
  responses: { ...successJson, ...operationPendingJson('The kill still runs; follow its task') },
});
export const removeContainerRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/containers/{containerId}',
  tags: ['Docker Containers'],
  summary: 'Remove a container',
  description:
    'Removes a stopped container. A container that is stopping is removed once the stop ends: the request waits up to 45 s for it, then answers 202 with a `remove` task (and `transition: stopping`) that removes the container once the stop ended; the task records the outcome. A running, paused or restarting container is refused (409 CONTAINER_RUNNING): stop it first. A container a Route reaches is refused (409 PROXY_UPSTREAM_IN_USE). Its managed database and storage links are removed with it.',
  request: { params: containerParams },
  responses: {
    ...successJson,
    ...operationPendingJson('The container is still stopping; its remove task removes it then'),
  },
});
export const renameContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/rename',
  tags: ['Docker Containers'],
  summary: 'Rename a container',
  request: { params: containerParams, ...jsonBody(ContainerRenameSchema) },
  responses: successJson,
});
export const duplicateContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/duplicate',
  tags: ['Docker Containers'],
  summary: 'Duplicate a container',
  request: { params: containerParams, ...jsonBody(ContainerDuplicateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const exportContainerArchiveRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/archive',
  tags: ['Docker Containers'],
  summary: 'Stream an Opfield container archive',
  request: { params: containerParams, query: ContainerArchiveExportQuerySchema },
  responses: {
    200: {
      description: 'GWCA v1 stream. Volume contents are never included.',
      content: { 'application/vnd.opfield.gwca': { schema: { type: 'string', format: 'binary' } } },
    },
    409: {
      description:
        'The container cannot be exported as a standalone archive. DOCKER_ARCHIVE_COMPOSE_CONTAINER: it belongs to a Compose project and is managed through that project. GPU_ARCHIVE_UNSUPPORTED: it has GPU mappings.',
      content: jsonContent(ApiErrorSchema, {
        code: 'DOCKER_ARCHIVE_COMPOSE_CONTAINER',
        message:
          'This container belongs to Compose project shop and cannot be exported as a container archive; manage it through the Compose project instead',
        details: {
          nodeId: '550e8400-e29b-41d4-a716-446655440000',
          containerId: 'shop-web-1',
          projectName: 'shop',
          projectId: null,
        },
      }),
    },
  },
});
export const importContainerArchiveRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/archive',
  tags: ['Docker Containers'],
  summary: 'Import a streamed Opfield container archive',
  request: {
    params: nodeParams,
    query: ContainerArchiveImportQuerySchema,
    body: {
      required: true,
      content: { 'application/vnd.opfield.gwca': { schema: { type: 'string', format: 'binary' } } },
    },
  },
  responses: createdJson(UnknownDataResponseSchema),
});
export const planContainerArchiveImportRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/archive/plan',
  tags: ['Docker Containers'],
  summary: 'Plan target resource mappings for an Opfield container archive',
  request: { params: nodeParams, ...jsonBody(ContainerArchivePlanSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const updateContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/update',
  tags: ['Docker Containers'],
  summary: 'Pull and redeploy a container image',
  request: { params: containerParams, ...jsonBody(ContainerUpdateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const liveUpdateContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/live-update',
  tags: ['Docker Containers'],
  summary: 'Update runtime settings without recreation',
  request: { params: containerParams, ...jsonBody(ContainerLiveUpdateSchema) },
  responses: successJson,
});
export const recreateContainerRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/recreate',
  tags: ['Docker Containers'],
  summary: 'Recreate a container with new settings',
  request: { params: containerParams, ...jsonBody(ContainerRecreateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const containerLogsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/logs',
  tags: ['Docker Containers'],
  summary: 'Get container logs',
  request: { params: containerParams, query: LogQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const containerStatsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/stats',
  tags: ['Docker Containers'],
  summary: 'Get container stats',
  request: { params: containerParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const containerStatsHistoryRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/stats/history',
  tags: ['Docker Containers'],
  summary: 'Get container stats history',
  request: { params: containerParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const containerTopRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/top',
  tags: ['Docker Containers'],
  summary: 'Get container process list',
  request: { params: containerParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const containerEnvRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/env',
  tags: ['Docker Containers'],
  summary: 'Get container environment',
  request: { params: containerParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const updateContainerEnvRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/containers/{containerId}/env',
  tags: ['Docker Containers'],
  summary: 'Update container environment',
  request: { params: containerParams, ...jsonBody(EnvUpdateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listContainerSecretsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/secrets',
  tags: ['Docker Secrets'],
  summary: 'List container secrets',
  request: { params: containerParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const createContainerSecretRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/secrets',
  tags: ['Docker Secrets'],
  summary: 'Create a container secret',
  request: { params: containerParams, ...jsonBody(SecretCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const updateContainerSecretRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/containers/{containerId}/secrets/{secretId}',
  tags: ['Docker Secrets'],
  summary: 'Update a container secret',
  request: { params: containerSecretParams, ...jsonBody(SecretUpdateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteContainerSecretRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/containers/{containerId}/secrets/{secretId}',
  tags: ['Docker Secrets'],
  summary: 'Delete a container secret',
  request: { params: containerSecretParams },
  responses: successJson,
});
export const listContainerFilesRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/files',
  tags: ['Docker Files'],
  summary: 'List container directory',
  request: { params: containerParams, query: FileBrowseSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const readContainerFileRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerId}/files/read',
  tags: ['Docker Files'],
  summary: 'Read a container file',
  request: { params: containerParams, query: FileBrowseSchema },
  responses: {
    200: {
      description: 'File bytes',
      content: {
        'application/octet-stream': {
          schema: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  },
});
/** The raw body of a file write: the file's complete new content. */
const fileContentBody = {
  body: {
    description:
      "The file's complete new content as raw bytes (any Content-Type; the body is not JSON). The file at `path` is replaced with it.",
    required: true,
    content: { 'application/octet-stream': { schema: { type: 'string' as const, format: 'binary' } } },
  },
};
export const writeContainerFileRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/containers/{containerId}/files/write',
  tags: ['Docker Files'],
  summary: 'Write a container file',
  request: { params: containerParams, query: FileBrowseSchema, ...fileContentBody },
  responses: successJson,
});
export const createContainerFileRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/files/create',
  tags: ['Docker Files'],
  summary: 'Create a container file',
  request: { params: containerParams, query: FileBrowseSchema },
  responses: successJson,
});
export const initContainerFileUploadRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/files/uploads',
  tags: ['Docker Files'],
  summary: 'Initialize a chunked container file upload',
  request: { params: containerParams, ...jsonBody(FileUploadInitSchema) },
  responses: okJson(
    z.object({
      data: z.object({
        uploadId: z.string(),
        chunkSize: z.number(),
      }),
    })
  ),
});
export const uploadContainerFileChunkRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/containers/{containerId}/files/uploads/{uploadId}/chunks',
  tags: ['Docker Files'],
  summary: 'Upload one chunk for a container file upload',
  request: { params: containerUploadParams, query: FileUploadChunkQuerySchema },
  responses: okJson(
    z.object({
      data: z.object({
        receivedBytes: z.number(),
        totalBytes: z.number(),
      }),
    })
  ),
});
export const completeContainerFileUploadRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/files/uploads/{uploadId}/complete',
  tags: ['Docker Files'],
  summary: 'Complete a chunked container file upload',
  request: { params: containerUploadParams, ...jsonBody(FileUploadCompleteSchema) },
  responses: successJson,
});
export const abortContainerFileUploadRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/containers/{containerId}/files/uploads/{uploadId}',
  tags: ['Docker Files'],
  summary: 'Abort a chunked container file upload',
  request: { params: containerUploadParams },
  responses: successJson,
});
export const createContainerDirectoryRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/files/directory',
  tags: ['Docker Files'],
  summary: 'Create a container directory',
  request: { params: containerParams, ...jsonBody(FileBrowseSchema) },
  responses: successJson,
});
export const deleteContainerFileRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/containers/{containerId}/files',
  tags: ['Docker Files'],
  summary: 'Delete a container file or directory',
  request: { params: containerParams, query: FileBrowseSchema },
  responses: successJson,
});
export const moveContainerFileRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerId}/files/move',
  tags: ['Docker Files'],
  summary: 'Move a container file or directory',
  request: { params: containerParams, ...jsonBody(FileMoveSchema) },
  responses: successJson,
});

export const listDeploymentsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/deployments',
  tags: ['Docker Deployments'],
  summary: 'List blue/green deployments',
  request: { params: nodeParams, query: dockerListQuery },
  responses: okJson(UnknownDataResponseSchema),
});
export const createDeploymentRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments',
  tags: ['Docker Deployments'],
  summary: 'Create a blue/green deployment',
  request: { params: nodeParams, ...jsonBody(DockerDeploymentCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const getDeploymentRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/deployments/{deploymentId}',
  tags: ['Docker Deployments'],
  summary: 'Get a deployment',
  request: { params: deploymentParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const getDeploymentByNameRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/deployments/by-name/{deploymentName}',
  tags: ['Docker Deployments'],
  summary: 'Get a deployment by exact name',
  request: { params: deploymentNameParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const updateDeploymentRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/deployments/{deploymentId}',
  tags: ['Docker Deployments'],
  summary: 'Update a deployment',
  request: { params: deploymentParams, ...jsonBody(DockerDeploymentUpdateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteDeploymentRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/deployments/{deploymentId}',
  tags: ['Docker Deployments'],
  summary: 'Delete a deployment',
  request: { params: deploymentParams },
  responses: successJson,
});
export const deploymentActionRoute = (action: 'start' | 'stop' | 'restart' | 'kill') =>
  appRoute({
    method: 'post',
    path: `/nodes/{nodeId}/deployments/{deploymentId}/${action}`,
    tags: ['Docker Deployments'],
    summary: `${action[0].toUpperCase()}${action.slice(1)} a deployment`,
    request: { params: deploymentParams },
    responses: okJson(UnknownDataResponseSchema),
  });
export const deployDeploymentRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/deploy',
  tags: ['Docker Deployments'],
  summary: 'Deploy a new inactive slot',
  description:
    'Rolls the deployment out to its standby slot, with the requested image or tag or the saved configuration. A requested env replaces the whole environment of the deployment and is saved as its configuration: send every variable the deployment should keep. On a deployment with legacy host bind mounts, a requested image or tag needs docker:containers:mounts (new code gets that host access); redeploying the saved configuration needs none.',
  request: { params: deploymentParams, ...optionalJsonBody(DockerDeploymentDeploySchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const switchDeploymentRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/switch',
  tags: ['Docker Deployments'],
  summary: 'Switch deployment slot',
  description:
    'Serves the standby slot as it was deployed. A standby deployed before the current managed database and storage links is recreated from its own release with the current link networks; the deployment keeps its saved configuration. That recreate keeps the standby image and mounts, so it needs no docker:containers:mounts.',
  request: { params: deploymentParams, ...jsonBody(DockerDeploymentSwitchSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const rollbackDeploymentRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/rollback',
  tags: ['Docker Deployments'],
  summary: 'Rollback a deployment',
  description:
    'Serves the previous release from the standby slot. The release keeps the current managed database and storage links: their networks come from the current configuration (a link added since stays, a link removed since is not reattached) and their secrets are merged at deploy time. Rolling back to another image on a deployment with host bind mounts needs docker:containers:mounts.',
  request: { params: deploymentParams, ...optionalJsonBody(z.object({ force: z.boolean().optional() })) },
  responses: okJson(UnknownDataResponseSchema),
});
export const stopDeploymentSlotRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/slots/{slot}/stop',
  tags: ['Docker Deployments'],
  summary: 'Stop a deployment slot',
  request: { params: pathParamSchema('nodeId', 'deploymentId', 'slot') },
  responses: successJson,
});
export const deploymentWebhookRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/webhook',
  tags: ['Docker Deployments'],
  summary: 'Get deployment webhook config',
  request: { params: deploymentParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const upsertDeploymentWebhookRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/webhook',
  tags: ['Docker Deployments'],
  summary: 'Configure deployment webhook',
  description:
    "Saving the webhook records the caller as the account its calls act for: on a workload with host bind mounts, a call that brings a new image needs that account's current docker:containers:mounts.",
  request: { params: deploymentParams, ...jsonBody(WebhookUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteDeploymentWebhookRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/webhook',
  tags: ['Docker Deployments'],
  summary: 'Delete deployment webhook',
  request: { params: deploymentParams },
  responses: successJson,
});
export const regenerateDeploymentWebhookRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/webhook/regenerate',
  tags: ['Docker Deployments'],
  summary: 'Regenerate deployment webhook token',
  description:
    "Rotating the token records the caller as the account the webhook calls act for: on a workload with host bind mounts, a call that brings a new image needs that account's current docker:containers:mounts.",
  request: { params: deploymentParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const getDeploymentImageCleanupRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/image-cleanup',
  tags: ['Docker Deployments'],
  summary: 'Get deployment image cleanup settings',
  request: { params: deploymentParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const upsertDeploymentImageCleanupRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/image-cleanup',
  tags: ['Docker Deployments'],
  summary: 'Configure deployment image cleanup',
  request: { params: deploymentParams, ...jsonBody(ImageCleanupUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const listDeploymentSecretsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/secrets',
  tags: ['Docker Secrets'],
  summary: 'List deployment secrets',
  request: { params: deploymentParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const createDeploymentSecretRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/secrets',
  tags: ['Docker Secrets'],
  summary: 'Create a deployment secret',
  request: { params: deploymentParams, ...jsonBody(SecretCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const updateDeploymentSecretRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/secrets/{secretId}',
  tags: ['Docker Secrets'],
  summary: 'Update a deployment secret',
  request: { params: deploymentSecretParams, ...jsonBody(SecretUpdateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteDeploymentSecretRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/secrets/{secretId}',
  tags: ['Docker Secrets'],
  summary: 'Delete a deployment secret',
  request: { params: deploymentSecretParams },
  responses: successJson,
});

export const containerHealthCheckRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerName}/health-check',
  tags: ['Docker Health Checks'],
  summary: 'Get a container health check',
  request: { params: containerNameParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const upsertContainerHealthCheckRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/containers/{containerName}/health-check',
  tags: ['Docker Health Checks'],
  summary: 'Configure a container health check',
  request: { params: containerNameParams, ...jsonBody(DockerHealthCheckUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const testContainerHealthCheckRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerName}/health-check/test',
  tags: ['Docker Health Checks'],
  summary: 'Test a container health check',
  request: { params: containerNameParams, ...optionalJsonBody(DockerHealthCheckUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deploymentHealthCheckRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/health-check',
  tags: ['Docker Health Checks'],
  summary: 'Get a deployment health check',
  request: { params: deploymentParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const upsertDeploymentHealthCheckRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/health-check',
  tags: ['Docker Health Checks'],
  summary: 'Configure a deployment health check',
  request: { params: deploymentParams, ...jsonBody(DockerHealthCheckUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const testDeploymentHealthCheckRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/deployments/{deploymentId}/health-check/test',
  tags: ['Docker Health Checks'],
  summary: 'Test a deployment health check',
  request: { params: deploymentParams, ...optionalJsonBody(DockerHealthCheckUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listImagesRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/images',
  tags: ['Docker Images'],
  summary: 'List images',
  request: { params: nodeParams, query: dockerListQuery },
  responses: okJson(UnknownDataResponseSchema),
});
export const pullImageRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/images/pull',
  tags: ['Docker Images'],
  summary: 'Pull an image asynchronously',
  request: { params: nodeParams, ...jsonBody(ImagePullSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const pullImageSyncRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/images/pull-sync',
  tags: ['Docker Images'],
  summary: 'Pull an image synchronously',
  request: { params: nodeParams, ...jsonBody(ImagePullSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const removeImageRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/images/{imageId}',
  tags: ['Docker Images'],
  summary: 'Remove an image',
  request: { params: imageParams, query: z.object({ force: z.coerce.boolean().optional() }) },
  responses: successJson,
});
export const pruneImagesRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/images/prune',
  tags: ['Docker Images'],
  summary: 'Prune unused images',
  description:
    "Removes dangling images, then applies the image cleanup rules: each workload's older images beyond its image cleanup setting (the image it runs and one rollback image by default) and unused images nothing runs or names once unused for 12 hours. Images a container uses, the builds the internal registry keeps and images Opfield's records name are never removed.",
  request: { params: nodeParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const listVolumesRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/volumes',
  tags: ['Docker Volumes'],
  summary: 'List volumes',
  request: { params: nodeParams, query: dockerListQuery },
  responses: okJson(UnknownDataResponseSchema),
});
export const inspectVolumeRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/volumes/{name}',
  tags: ['Docker Volumes'],
  summary: 'Inspect a volume',
  request: { params: volumeParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const listVolumeFilesRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/volumes/{name}/files',
  tags: ['Docker Volumes'],
  summary: 'List volume files',
  request: { params: volumeParams, query: FileBrowseSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const readVolumeFileRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/volumes/{name}/files/read',
  tags: ['Docker Volumes'],
  summary: 'Read a volume file',
  request: { params: volumeParams, query: FileBrowseSchema },
  responses: {
    200: {
      description: 'File bytes',
      content: {
        'application/octet-stream': {
          schema: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  },
});
export const writeVolumeFileRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/volumes/{name}/files/write',
  tags: ['Docker Volumes'],
  summary: 'Write a volume file',
  request: { params: volumeParams, query: FileBrowseSchema, ...fileContentBody },
  responses: successJson,
});
export const createVolumeFileRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/files/create',
  tags: ['Docker Volumes'],
  summary: 'Create a volume file',
  request: { params: volumeParams, query: FileBrowseSchema },
  responses: successJson,
});
export const initVolumeFileUploadRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/files/uploads',
  tags: ['Docker Volumes'],
  summary: 'Initialize a chunked volume file upload',
  request: { params: volumeParams, ...jsonBody(FileUploadInitSchema) },
  responses: okJson(
    z.object({
      data: z.object({
        uploadId: z.string(),
        chunkSize: z.number(),
      }),
    })
  ),
});
export const uploadVolumeFileChunkRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/volumes/{name}/files/uploads/{uploadId}/chunks',
  tags: ['Docker Volumes'],
  summary: 'Upload one chunk for a volume file upload',
  request: { params: volumeUploadParams, query: FileUploadChunkQuerySchema },
  responses: okJson(
    z.object({
      data: z.object({
        receivedBytes: z.number(),
        totalBytes: z.number(),
      }),
    })
  ),
});
export const completeVolumeFileUploadRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/files/uploads/{uploadId}/complete',
  tags: ['Docker Volumes'],
  summary: 'Complete a chunked volume file upload',
  request: { params: volumeUploadParams, ...jsonBody(FileUploadCompleteSchema) },
  responses: successJson,
});
export const abortVolumeFileUploadRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/volumes/{name}/files/uploads/{uploadId}',
  tags: ['Docker Volumes'],
  summary: 'Abort a chunked volume file upload',
  request: { params: volumeUploadParams },
  responses: successJson,
});
export const createVolumeDirectoryRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/files/directory',
  tags: ['Docker Volumes'],
  summary: 'Create a volume directory',
  request: { params: volumeParams, ...jsonBody(FileBrowseSchema) },
  responses: successJson,
});
export const deleteVolumeFileRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/volumes/{name}/files',
  tags: ['Docker Volumes'],
  summary: 'Delete a volume file or directory',
  request: { params: volumeParams, query: FileBrowseSchema },
  responses: successJson,
});
export const moveVolumeFileRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/files/move',
  tags: ['Docker Volumes'],
  summary: 'Move a volume file or directory',
  request: { params: volumeParams, ...jsonBody(FileMoveSchema) },
  responses: successJson,
});
export const exportVolumeRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/volumes/{name}/export',
  tags: ['Docker Volumes'],
  summary: 'Export a volume',
  request: { params: volumeParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const renameVolumeRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/rename',
  tags: ['Docker Volumes'],
  summary: 'Rename a volume',
  request: { params: volumeParams, ...jsonBody(VolumeRenameSchema) },
  responses: successJson,
});
export const updateVolumeLabelsRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/volumes/{name}/labels',
  tags: ['Docker Volumes'],
  summary: 'Update volume labels',
  request: { params: volumeParams, ...jsonBody(VolumeLabelsUpdateSchema) },
  responses: successJson,
});
export const createVolumeRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes',
  tags: ['Docker Volumes'],
  summary: 'Create a volume',
  description: 'Creates a regular Docker volume. Disk-image volume creation requires the Personal plan or higher.',
  request: { params: nodeParams, ...jsonBody(VolumeCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const getVolumeMetricsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/volumes/{name}/metrics',
  tags: ['Docker Volumes'],
  summary: 'Get cached volume metrics',
  description: 'Returns the latest volume metrics collected by the background Docker snapshot reconciler.',
  request: { params: volumeParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const resizeVolumeRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/resize',
  tags: ['Docker Volumes'],
  summary: 'Grow a managed disk-image volume',
  request: { params: volumeParams, ...jsonBody(VolumeResizeSchema) },
  responses: successJson,
});
export const listManagedVolumeOptionsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/managed-volumes',
  tags: ['Docker Volumes'],
  summary: 'List managed volume names available for container mounts',
  request: { params: nodeParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const adoptVolumeRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/volumes/{name}/adopt',
  tags: ['Docker Volumes'],
  summary: 'Adopt an eligible legacy local volume without copying data',
  request: { params: volumeParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const removeVolumeRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/volumes/{name}',
  tags: ['Docker Volumes'],
  summary: 'Remove a volume',
  request: { params: volumeParams, query: z.object({ force: z.coerce.boolean().optional() }) },
  responses: successJson,
});

export const listNetworksRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/networks',
  tags: ['Docker Networks'],
  summary: 'List networks',
  request: { params: nodeParams, query: dockerListQuery },
  responses: okJson(UnknownDataResponseSchema),
});
export const createNetworkRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/networks',
  tags: ['Docker Networks'],
  summary: 'Create a network',
  request: { params: nodeParams, ...jsonBody(NetworkCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const removeNetworkRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/networks/{networkId}',
  tags: ['Docker Networks'],
  summary: 'Remove a network',
  request: { params: networkParams },
  responses: successJson,
});
export const connectNetworkRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/networks/{networkId}/connect',
  tags: ['Docker Networks'],
  summary: 'Connect a container to a network',
  request: { params: networkParams, ...jsonBody(NetworkConnectSchema) },
  responses: successJson,
});
export const disconnectNetworkRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/networks/{networkId}/disconnect',
  tags: ['Docker Networks'],
  summary: 'Disconnect a container from a network',
  request: { params: networkParams, ...jsonBody(NetworkConnectSchema) },
  responses: successJson,
});

export const listRegistriesRoute = appRoute({
  method: 'get',
  path: '/registries',
  tags: ['Docker Registries'],
  summary: 'List registries',
  request: { query: z.object({ nodeId: z.string().optional() }) },
  responses: okJson(UnknownDataResponseSchema),
});
export const createRegistryRoute = appRoute({
  method: 'post',
  path: '/registries',
  tags: ['Docker Registries'],
  summary: 'Create a registry',
  request: jsonBody(RegistryCreateSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const updateRegistryRoute = appRoute({
  method: 'put',
  path: '/registries/{id}',
  tags: ['Docker Registries'],
  summary: 'Update a registry',
  request: { params: registryParams, ...jsonBody(RegistryUpdateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteRegistryRoute = appRoute({
  method: 'delete',
  path: '/registries/{id}',
  tags: ['Docker Registries'],
  summary: 'Delete a registry',
  request: { params: registryParams },
  responses: successJson,
});
export const testRegistryDirectRoute = appRoute({
  method: 'post',
  path: '/registries/test',
  tags: ['Docker Registries'],
  summary: 'Test registry credentials',
  request: jsonBody(RegistryCreateSchema.partial()),
  responses: okJson(UnknownDataResponseSchema),
});
export const testRegistryRoute = appRoute({
  method: 'post',
  path: '/registries/{id}/test',
  tags: ['Docker Registries'],
  summary: 'Test a saved registry',
  request: { params: registryParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const getInternalRegistryRoute = appRoute({
  method: 'get',
  path: '/registries/internal/state',
  tags: ['Docker Registries'],
  summary: 'Get the Opfield internal registry state',
  responses: okJson(UnknownDataResponseSchema),
});
export const updateInternalRegistryRoute = appRoute({
  method: 'put',
  path: '/registries/internal/settings',
  tags: ['Docker Registries'],
  summary: 'Update the Opfield internal registry storage (local disk or S3) and Business+ external access',
  description:
    'storage switches the registry between its local volume and an S3 bucket: the bucket is checked first (write, read and delete of a probe object), then the switch runs in the background, copies the stored images to the new storage, recreates the registry and checks the images in use; storage.lastSwitch in the state reports the outcome. Omitting externalAccessEnabled leaves external access as it is.',
  request: jsonBody(DockerInternalRegistryUpdateSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const runInternalRegistryGcRoute = appRoute({
  method: 'post',
  path: '/registries/internal/gc',
  tags: ['Docker Registries'],
  summary: 'Run retention and garbage collection for the Opfield internal registry',
  request: optionalJsonBody(z.object({ dryRun: z.boolean().default(false) })),
  responses: okJson(UnknownDataResponseSchema),
});
export const resumeInternalRegistryMaintenanceRoute = appRoute({
  method: 'post',
  path: '/registries/internal/maintenance/{runId}/resume',
  tags: ['Docker Registries'],
  summary: 'Resume an interrupted internal registry maintenance run',
  request: { params: z.object({ runId: z.string().uuid() }) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listTasksRoute = appRoute({
  method: 'get',
  path: '/tasks',
  tags: ['Docker Tasks'],
  summary: 'List background tasks',
  request: {
    query: z.object({
      nodeId: z.string().optional(),
      status: z.string().optional(),
      type: z.string().optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .openapi({ description: 'Newest tasks to return; all when omitted' }),
    }),
  },
  responses: okJson(UnknownDataResponseSchema),
});
export const getTaskRoute = appRoute({
  method: 'get',
  path: '/tasks/{id}',
  tags: ['Docker Tasks'],
  summary: 'Get a background task',
  request: { params: taskParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const forceCancelTaskRoute = appRoute({
  method: 'post',
  path: '/tasks/{id}/force-cancel',
  tags: ['Docker Tasks'],
  summary: 'Force-cancel an active background task',
  request: { params: taskParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const listDockerFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags: ['Docker Folders'],
  summary: 'List Docker folders',
  request: { query: z.object({ resourceType: DockerFolderResourceTypeSchema.optional() }) },
  responses: okJson(UnknownDataResponseSchema),
});
export const createDockerFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags: ['Docker Folders'],
  summary: 'Create a Docker folder',
  request: jsonBody(CreateDockerFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const reorderDockerFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags: ['Docker Folders'],
  summary: 'Reorder Docker folders',
  request: jsonBody(ReorderDockerFoldersSchema),
  responses: successJson,
});
export const reorderDockerContainersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-containers',
  tags: ['Docker Folders'],
  summary: 'Reorder containers inside Docker folders',
  request: jsonBody(ReorderDockerContainersSchema),
  responses: successJson,
});
export const reorderDockerResourcesRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-resources',
  tags: ['Docker Folders'],
  summary: 'Reorder resources inside Docker folders',
  request: jsonBody(ReorderDockerResourcesSchema),
  responses: successJson,
});
export const updateDockerFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags: ['Docker Folders'],
  summary: 'Update a Docker folder',
  request: { params: pathParamSchema('id'), ...jsonBody(UpdateDockerFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const moveDockerFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags: ['Docker Folders'],
  summary: 'Move a Docker folder under another folder or to the root',
  request: { params: pathParamSchema('id'), ...jsonBody(MoveDockerFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteDockerFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags: ['Docker Folders'],
  summary: 'Delete a Docker folder',
  request: { params: pathParamSchema('id') },
  responses: { 204: { description: 'No content' } },
});
export const moveDockerContainersRoute = appRoute({
  method: 'post',
  path: '/folders/move-containers',
  tags: ['Docker Folders'],
  summary: 'Move containers into a Docker folder',
  request: jsonBody(MoveDockerContainersToFolderSchema),
  responses: successJson,
});
export const moveDockerResourcesRoute = appRoute({
  method: 'post',
  path: '/folders/move-resources',
  tags: ['Docker Folders'],
  summary: 'Move Docker resources into a folder',
  request: jsonBody(MoveDockerResourcesToFolderSchema),
  responses: successJson,
});
export const getDockerFolderPlacementsRoute = appRoute({
  method: 'post',
  path: '/folders/placements',
  tags: ['Docker Folders'],
  summary: 'Get Docker resource folder placements',
  request: jsonBody(DockerFolderPlacementsSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const triggerDockerWebhookRoute = appRoute({
  method: 'post',
  path: '/{token}',
  tags: ['Docker Webhooks'],
  summary: 'Trigger a Docker webhook',
  description:
    "Updates the image of the webhook's container or deployment. On a workload with legacy host bind mounts the call acts for the account that last saved the webhook and needs its current docker:containers:mounts; a webhook with no recorded account (saved before Opfield recorded one) is refused there until it is saved again.",
  security: [],
  request: { params: pathParamSchema('token'), ...jsonBody(WebhookTriggerSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const getContainerWebhookRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerName}/webhook',
  tags: ['Docker Webhooks'],
  summary: 'Get container webhook config',
  request: { params: containerNameParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const upsertContainerWebhookRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/containers/{containerName}/webhook',
  tags: ['Docker Webhooks'],
  summary: 'Configure container webhook',
  description:
    "Saving the webhook records the caller as the account its calls act for: on a workload with host bind mounts, a call that brings a new image needs that account's current docker:containers:mounts.",
  request: { params: containerNameParams, ...jsonBody(WebhookUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteContainerWebhookRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/containers/{containerName}/webhook',
  tags: ['Docker Webhooks'],
  summary: 'Delete container webhook',
  request: { params: containerNameParams },
  responses: successJson,
});
export const regenerateContainerWebhookRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/containers/{containerName}/webhook/regenerate',
  tags: ['Docker Webhooks'],
  summary: 'Regenerate container webhook token',
  description:
    "Rotating the token records the caller as the account the webhook calls act for: on a workload with host bind mounts, a call that brings a new image needs that account's current docker:containers:mounts.",
  request: { params: containerNameParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const getContainerImageCleanupRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/containers/{containerName}/image-cleanup',
  tags: ['Docker Image Cleanup'],
  summary: 'Get container image cleanup settings',
  request: { params: containerNameParams },
  responses: okJson(UnknownDataResponseSchema),
});
export const upsertContainerImageCleanupRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/containers/{containerName}/image-cleanup',
  tags: ['Docker Image Cleanup'],
  summary: 'Configure container image cleanup',
  request: { params: containerNameParams, ...jsonBody(ImageCleanupUpsertSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
