import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  CreateStatusPageIncidentSchema,
  CreateStatusPageIncidentUpdateSchema,
  CreateStatusPageServiceSchema,
  IncidentListQuerySchema,
  ReorderStatusPageServicesSchema,
  StatusPageSettingsSchema,
  UpdateStatusPageIncidentSchema,
  UpdateStatusPageServiceSchema,
} from './status-page.schemas.js';

export const getStatusPageSettingsRoute = appRoute({
  method: 'get',
  path: '/settings',
  tags: ['Status Page'],
  summary: 'Get status page settings',
  responses: okJson(UnknownDataResponseSchema),
});
export const listStatusPageProxyTemplatesRoute = appRoute({
  method: 'get',
  path: '/proxy-templates',
  tags: ['Status Page'],
  summary: 'List status page proxy templates',
  responses: okJson(UnknownDataResponseSchema),
});
export const listStatusPageSourcesRoute = appRoute({
  method: 'get',
  path: '/sources',
  tags: ['Status Page'],
  summary: 'List resources the caller may expose on the status page',
  description:
    'Nodes, routes with health checks, databases, Docker containers and deployments with health checks, Compose projects and Pages projects that the caller can view. Creating or editing an exposed service requires view access to its source.',
  responses: okJson(UnknownDataResponseSchema),
});
export const updateStatusPageSettingsRoute = appRoute({
  method: 'put',
  path: '/settings',
  tags: ['Status Page'],
  summary: 'Update status page settings',
  request: jsonBody(StatusPageSettingsSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const listStatusPageServicesRoute = appRoute({
  method: 'get',
  path: '/services',
  tags: ['Status Page'],
  summary: 'List exposed status page services',
  responses: okJson(UnknownDataResponseSchema),
});
export const createStatusPageServiceRoute = appRoute({
  method: 'post',
  path: '/services',
  tags: ['Status Page'],
  summary: 'Expose a service on the status page',
  request: jsonBody(CreateStatusPageServiceSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const updateStatusPageServiceRoute = appRoute({
  method: 'put',
  path: '/services/{id}',
  tags: ['Status Page'],
  summary: 'Update an exposed status page service',
  request: { params: IdParamSchema, ...jsonBody(UpdateStatusPageServiceSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const reorderStatusPageServicesRoute = appRoute({
  method: 'put',
  path: '/services/reorder',
  tags: ['Status Page'],
  summary: 'Reorder exposed status page services',
  request: jsonBody(ReorderStatusPageServicesSchema),
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteStatusPageServiceRoute = appRoute({
  method: 'delete',
  path: '/services/{id}',
  tags: ['Status Page'],
  summary: 'Remove an exposed status page service',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});
export const listStatusPageIncidentsRoute = appRoute({
  method: 'get',
  path: '/incidents',
  tags: ['Status Page'],
  summary: 'List status page incidents',
  request: { query: IncidentListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const createStatusPageIncidentRoute = appRoute({
  method: 'post',
  path: '/incidents',
  tags: ['Status Page'],
  summary: 'Create a manual status page incident',
  request: jsonBody(CreateStatusPageIncidentSchema),
  responses: createdJson(UnknownDataResponseSchema),
});
export const updateStatusPageIncidentRoute = appRoute({
  method: 'put',
  path: '/incidents/{id}',
  tags: ['Status Page'],
  summary: 'Update a status page incident',
  request: { params: IdParamSchema, ...jsonBody(UpdateStatusPageIncidentSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
export const deleteStatusPageIncidentRoute = appRoute({
  method: 'delete',
  path: '/incidents/{id}',
  tags: ['Status Page'],
  summary: 'Delete a status page incident',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});
export const resolveStatusPageIncidentRoute = appRoute({
  method: 'post',
  path: '/incidents/{id}/resolve',
  tags: ['Status Page'],
  summary: 'Resolve a status page incident',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const promoteStatusPageIncidentRoute = appRoute({
  method: 'post',
  path: '/incidents/{id}/promote',
  tags: ['Status Page'],
  summary: 'Promote an automatic incident to manual',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
export const createStatusPageIncidentUpdateRoute = appRoute({
  method: 'post',
  path: '/incidents/{id}/updates',
  tags: ['Status Page'],
  summary: 'Create a status page incident update',
  request: { params: IdParamSchema, ...jsonBody(CreateStatusPageIncidentUpdateSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});
export const getStatusPagePreviewRoute = appRoute({
  method: 'get',
  path: '/preview',
  tags: ['Status Page'],
  summary: 'Get status page preview data',
  responses: okJson(UnknownDataResponseSchema),
});
export const publicStatusPageRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Status Page'],
  summary: 'Get public status page data',
  security: [],
  responses: okJson(UnknownDataResponseSchema),
});
