import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  jsonBody,
  okJson,
  successJson,
  UnknownDataResponseSchema,
  UnknownListResponseSchema,
} from '@/lib/openapi.js';
import {
  ComposeAdoptInputSchema,
  ComposeCreateInputSchema,
  ComposeOperationActionSchema,
  ComposeOperationInputSchema,
  ComposeOperationListQuerySchema,
  ComposeRevisionCreateInputSchema,
  ComposeSecretCreateSchema,
  ComposeSecretUpdateSchema,
  ComposeYamlInputSchema,
} from './compose.schemas.js';

const nodeParams = z.object({ nodeId: z.string().uuid() });
const projectParams = nodeParams.extend({ projectId: z.string().uuid() });
const revisionParams = projectParams.extend({ revisionId: z.string().uuid() });
const secretParams = projectParams.extend({ secretId: z.string().uuid() });
const actionParams = projectParams.extend({ action: ComposeOperationActionSchema });

export const listComposeProjectsRoute = appRoute({
  method: 'get',
  path: '/compose-projects',
  tags: ['Docker Compose'],
  summary: 'List external and managed Compose projects',
  request: { query: z.object({ nodeId: z.string().uuid().optional() }) },
  responses: okJson(UnknownListResponseSchema),
});

export const getComposeProjectRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/compose-projects/{projectId}',
  tags: ['Docker Compose'],
  summary: 'Get a Compose project',
  request: { params: projectParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const validateComposeProjectRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/compose-projects/validate',
  tags: ['Docker Compose'],
  summary: 'Validate a single-file image-only Compose project',
  request: { params: nodeParams, ...jsonBody(ComposeYamlInputSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const createComposeProjectRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/compose-projects',
  tags: ['Docker Compose'],
  summary: 'Create a managed Compose project and its first immutable revision',
  request: { params: nodeParams, ...jsonBody(ComposeCreateInputSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const adoptComposeProjectRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/adopt',
  tags: ['Docker Compose'],
  summary: 'Prepare an external Compose project for adoption',
  request: { params: projectParams, ...jsonBody(ComposeAdoptInputSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const deleteComposeProjectRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/compose-projects/{projectId}',
  tags: ['Docker Compose'],
  summary: 'Delete a stopped managed Compose project record',
  request: { params: projectParams },
  responses: successJson,
});

export const listComposeRevisionsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/revisions',
  tags: ['Docker Compose'],
  summary: 'List immutable Compose revisions',
  request: { params: projectParams },
  responses: okJson(UnknownListResponseSchema),
});

export const createComposeRevisionRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/revisions',
  tags: ['Docker Compose'],
  summary: 'Create an immutable Compose revision',
  request: { params: projectParams, ...jsonBody(ComposeRevisionCreateInputSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const getComposeRevisionRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/revisions/{revisionId}',
  tags: ['Docker Compose'],
  summary: 'Get an immutable Compose revision',
  request: { params: revisionParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteComposeRevisionRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/revisions/{revisionId}',
  tags: ['Docker Compose'],
  summary: 'Delete an inactive immutable Compose revision',
  request: { params: revisionParams },
  responses: successJson,
});

export const listComposeOperationsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/operations',
  tags: ['Docker Compose'],
  summary: 'List Compose lifecycle operations',
  request: { params: projectParams, query: ComposeOperationListQuerySchema },
  responses: okJson(UnknownListResponseSchema),
});

export const composeProjectActionRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/actions/{action}',
  tags: ['Docker Compose'],
  summary: 'Start a managed Compose lifecycle operation',
  description:
    'An apply (pull_apply) runs the revision with the managed database links that exist when it starts: links deleted since the revision was built are left out, links the project runs are kept and links saved pending are added when the revision defines their service. When that changes the revision, a copy is applied and the operation names it; a revision lacking the service of a link the project runs is refused. Start and restart act on existing containers: a project that was never applied answers 409 COMPOSE_PROJECT_NOT_APPLIED (apply it first).',
  request: { params: actionParams, ...jsonBody(ComposeOperationInputSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const listComposeSecretsRoute = appRoute({
  method: 'get',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/secrets',
  tags: ['Docker Compose'],
  summary: 'List masked Compose secret bindings',
  request: { params: projectParams },
  responses: okJson(UnknownListResponseSchema),
});

export const createComposeSecretRoute = appRoute({
  method: 'post',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/secrets',
  tags: ['Docker Compose'],
  summary: 'Create or replace a Compose secret binding',
  request: { params: projectParams, ...jsonBody(ComposeSecretCreateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateComposeSecretRoute = appRoute({
  method: 'put',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/secrets/{secretId}',
  tags: ['Docker Compose'],
  summary: 'Update a Compose secret binding',
  request: { params: secretParams, ...jsonBody(ComposeSecretUpdateSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteComposeSecretRoute = appRoute({
  method: 'delete',
  path: '/nodes/{nodeId}/compose-projects/{projectId}/secrets/{secretId}',
  tags: ['Docker Compose'],
  summary: 'Delete a Compose secret binding',
  request: { params: secretParams },
  responses: successJson,
});
