import {
  appRoute,
  createdJson,
  dataResponseSchema,
  IdParamSchema,
  jsonBody,
  okJson,
  pathParamSchema,
  UnknownDataResponseSchema,
  withDocumentedConditionals,
} from '@/lib/openapi.js';
import {
  CreateProxyHostSchema,
  MissingRouteDomainsSchema,
  ProxyHostListQuerySchema,
  RouteIngressNodeListQuerySchema,
  RouteIngressPlacementSchema,
  ToggleProxyHostSchema,
  ToggleProxyMaintenanceSchema,
  UpdateProxyHostSchema,
  ValidateAdvancedConfigSchema,
} from './proxy.schemas.js';

const RenderedConfigResponseSchema = dataResponseSchema(
  ValidateAdvancedConfigSchema.pick({ snippet: true })
    .extend({
      rendered: ValidateAdvancedConfigSchema.shape.snippet,
    })
    .omit({ snippet: true })
);

const upstreamKind = (kind: string) => ({ required: ['upstreamKind'], properties: { upstreamKind: { const: kind } } });
/** The create body with the requirements its refinement enforces per type and upstream kind (see the description). */
const CreateProxyHostDocumentedSchema = withDocumentedConditionals(CreateProxyHostSchema, [
  {
    when: { properties: { type: { const: 'proxy' }, upstreamKind: { const: 'manual' } } },
    requires: { required: ['forwardHost', 'forwardPort'] },
  },
  { when: upstreamKind('docker_container'), requires: { required: ['dockerNodeId', 'dockerContainerPort'] } },
  { when: upstreamKind('docker_deployment'), requires: { required: ['dockerDeploymentId', 'dockerContainerPort'] } },
  { when: upstreamKind('pages'), requires: { required: ['pageProjectId', 'pageTagId'] } },
  {
    when: { required: ['type'], properties: { type: { const: 'redirect' } } },
    requires: { required: ['redirectUrl'] },
  },
  {
    when: { required: ['relaySpreadMode'], properties: { relaySpreadMode: { const: 'fixed' } } },
    requires: { required: ['relaySpreadCount'] },
  },
]);

export const listProxyHostsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Routes'],
  summary: 'List ingress routes',
  request: { query: ProxyHostListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listRouteIngressNodesRoute = appRoute({
  method: 'get',
  path: '/ingress-nodes',
  tags: ['Routes'],
  summary: 'List the nginx ingress nodes the caller may create routes on',
  description:
    'Needs any proxy:create grant (broad, folder or node) and no node permission. Returns id, displayName, hostname and status of each nginx node a new route may use: every node for a broad or folder grant, only granted nodes for node grants; nodes locked for new services are omitted. `groups` lists the ingress groups a new route may use (the caller holds ingress:groups:view on the group and every member is such a node): id, name, slug, DNS failover mode and the members in site order with their state (joining, active, draining); create the route with ingressGroupId to serve it from every member. Pass folderId to limit both lists to a route in that folder. A route created without nodeId uses the node or group of its registered domains, or the only listed node.',
  request: { query: RouteIngressNodeListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getProxyHostRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Routes'],
  summary: 'Get ingress route details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getProxyHostBySlugRoute = appRoute({
  method: 'get',
  path: '/by-slug/{slug}',
  tags: ['Routes'],
  summary: 'Resolve ingress route by slug',
  request: { params: pathParamSchema('slug') },
  responses: okJson(UnknownDataResponseSchema),
});

export const getProxyHostHealthHistoryRoute = appRoute({
  method: 'get',
  path: '/{id}/health-history',
  tags: ['Routes'],
  summary: 'Get ingress route health history',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createProxyHostRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Routes'],
  summary: 'Create an ingress route',
  description:
    "createMissingDomains true creates a Cloudflare domain for each hostname no registered domain covers (an exact domain or a covering wildcard), before the route: in the zone of an enabled connector, served by the route's node or ingress group, in the domains folder of the route's app environment (or the domain root). Each name needs domains:create there (on every member for a group) and must match the environment domain allowlist; a name without permission, without a zone or refused by Cloudflare is skipped, not fatal. When the route fails, the domains this request created are removed. The response adds createdDomains [{id, domain, zoneName}] and skippedDomains [{hostname, code, reason}]. POST /proxy-hosts/missing-domains shows the plan first. Required by type (400 VALIDATION_ERROR otherwise): type proxy (the default) with upstreamKind manual (the default) needs forwardHost and forwardPort; upstreamKind docker_container needs dockerNodeId, dockerContainerPort and either dockerContainerName or dockerComposeProjectId with dockerComposeServiceName; docker_deployment needs dockerDeploymentId and dockerContainerPort; pages needs pageProjectId and pageTagId (no rawConfigEnabled, no websocketSupport); any other upstreamKind than manual needs type proxy; type redirect needs redirectUrl; type 404 takes no health check; relaySpreadMode fixed needs relaySpreadCount (and only it takes one).",
  request: jsonBody(CreateProxyHostDocumentedSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const missingRouteDomainsRoute = appRoute({
  method: 'post',
  path: '/missing-domains',
  tags: ['Routes'],
  summary: 'Preview the domains a new route would create',
  description:
    'For a route about to be created (domainNames, folderId, nodeId or ingressGroupId; without both, the node a create would pick): each hostname no registered domain covers, with status create (zoneName: the Cloudflare zone the domain would be created in) or unavailable (code and reason: no domains:create there, no Cloudflare zone, not allowed by the app environment domain allowlist, not a registrable name). Covered hostnames are left out. Needs any proxy:create grant.',
  request: jsonBody(MissingRouteDomainsSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateProxyHostRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Routes'],
  summary: 'Update an ingress route',
  request: { params: IdParamSchema, ...jsonBody(UpdateProxyHostSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteProxyHostRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Routes'],
  summary: 'Delete an ingress route',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const toggleProxyHostRoute = appRoute({
  method: 'post',
  path: '/{id}/toggle',
  tags: ['Routes'],
  summary: 'Enable or disable an ingress route',
  request: { params: IdParamSchema, ...jsonBody(ToggleProxyHostSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const toggleProxyMaintenanceRoute = appRoute({
  method: 'post',
  path: '/{id}/maintenance',
  tags: ['Routes'],
  summary: 'Enter or exit maintenance mode for an ingress route',
  request: { params: IdParamSchema, ...jsonBody(ToggleProxyMaintenanceSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const resyncProxyHostTlsRoute = appRoute({
  method: 'post',
  path: '/{id}/tls/resync',
  tags: ['Routes'],
  summary: 'Retry TLS deployment for an ingress route',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const renderedProxyConfigRoute = appRoute({
  method: 'get',
  path: '/{id}/rendered-config',
  tags: ['Routes'],
  summary: 'Get rendered nginx config for an ingress route',
  request: { params: IdParamSchema },
  responses: okJson(RenderedConfigResponseSchema),
});

export const validateProxyConfigRoute = appRoute({
  method: 'post',
  path: '/validate-config',
  tags: ['Routes'],
  summary: 'Validate advanced nginx config',
  request: jsonBody(ValidateAdvancedConfigSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const changeRouteIngressPlacementRoute = appRoute({
  method: 'post',
  path: '/{id}/ingress-placement',
  tags: ['Routes'],
  summary: 'Move a route onto an ingress group or back to one node',
  description:
    'A planned operation without downtime. Onto a group (ingressGroupId): the node that serves the route now must be a member and keeps serving while every other member gets the route (config, certificates, Secure Link sources, Pages artifacts). Back to one node (ingressGroupId null, nodeId a current member): the route leaves the other members after the node took it; point DNS of the route’s names at that node first. A route whose names are registered Opfield domains moves with its domain (use the domain’s ingress placement). Onto a group requires proxy:edit on the route, proxy:create for every member and the multi-node availability entitlement.',
  request: { params: IdParamSchema, ...jsonBody(RouteIngressPlacementSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
