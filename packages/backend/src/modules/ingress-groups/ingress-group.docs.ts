import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  noContent,
  okJson,
  optionalJsonBody,
  pathParamSchema,
  UnknownDataResponseSchema,
  UnknownListResponseSchema,
} from '@/lib/openapi.js';
import {
  AddIngressGroupMemberSchema,
  CreateIngressGroupSchema,
  IngressGroupDomainConversionSchema,
  IngressGroupListQuerySchema,
  IngressGroupRouteConversionSchema,
  RemoveIngressGroupMemberSchema,
  ReorderIngressGroupSchema,
  UpdateIngressGroupSchema,
} from './ingress-group.schemas.js';

const TAGS = ['Ingress groups'];

const GROUP_DESCRIPTION =
  'An ingress group is a set of nginx ingress nodes (normally one per site) that serve the same routes and domains: every member gets the same config, certificates, access lists, Pages artifacts and its own Secure Link sources. Groups live in node folders; viewing needs ingress:groups:view, changing needs ingress:groups:manage (broadly or on the group folder), adding a member also needs nodes:manage on that node. Creating, changing and converting require the multi-node availability entitlement (Business and Enterprise); existing groups keep serving without it. DNS failover mode `none`: the Cloudflare records of the group’s domains list every active member (round robin, no health checks).';

export const listIngressGroupsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: TAGS,
  summary: 'List ingress groups',
  description: `${GROUP_DESCRIPTION} Each group lists its members with state (joining, active, draining), node status, published addresses, the health their daemon reports for /.well-known/gateway-ingress-health, and per-member delivery counts.`,
  request: { query: IngressGroupListQuerySchema },
  responses: okJson(UnknownListResponseSchema),
});

export const getIngressGroupRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: TAGS,
  summary: 'Get an ingress group',
  description:
    'The group with its members, its routes (per member: delivery status, applied config hash, applied certificate version and whether it is current) and its domains (DNS provider, status and published addresses).',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createIngressGroupRoute = appRoute({
  method: 'post',
  path: '/',
  tags: TAGS,
  summary: 'Create an ingress group',
  description:
    'Members are nginx nodes whose daemon advertises ingress_group_v1, listed in site-preference order. A new group serves nothing yet: place routes and domains on it (create them with ingressGroupId, or convert existing ones).',
  request: jsonBody(CreateIngressGroupSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateIngressGroupRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: TAGS,
  summary: 'Update an ingress group',
  request: { params: IdParamSchema, ...jsonBody(UpdateIngressGroupSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteIngressGroupRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: TAGS,
  summary: 'Delete an ingress group',
  description: 'Refused (409 INGRESS_GROUP_IN_USE) while routes or domains are placed on the group.',
  request: { params: IdParamSchema },
  responses: noContent,
});

export const addIngressGroupMemberRoute = appRoute({
  method: 'post',
  path: '/{id}/members',
  tags: TAGS,
  summary: 'Add a member',
  description:
    'Without downtime: the node joins as `joining` and receives every route of the group (Secure Link sources, Pages artifacts, config, certificates) before its address is published in DNS; then it becomes `active`. An offline node or a route that did not reach it keeps it joining; Opfield retries and promotes it automatically.',
  request: { params: IdParamSchema, ...jsonBody(AddIngressGroupMemberSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const removeIngressGroupMemberRoute = appRoute({
  method: 'delete',
  path: '/{id}/members/{nodeId}',
  tags: TAGS,
  summary: 'Remove a member',
  description:
    'Without downtime: DNS first. The member becomes `draining` (still serving, no longer published), and its config, certificates and Secure Link sources are removed once DNS no longer points at it (the TTL of DNS-only records elapsed and no public name of the group resolves to it; at most 24 hours). `force: true` removes it at once. The last active member of a group that still serves routes or domains cannot be removed.',
  request: { params: pathParamSchema('id', 'nodeId'), ...optionalJsonBody(RemoveIngressGroupMemberSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderIngressGroupRoute = appRoute({
  method: 'put',
  path: '/{id}/members/order',
  tags: TAGS,
  summary: 'Reorder members',
  description: 'Site preference order of every member; the first active member is the group primary.',
  request: { params: IdParamSchema, ...jsonBody(ReorderIngressGroupSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const convertRouteToIngressGroupRoute = appRoute({
  method: 'post',
  path: '/{id}/routes',
  tags: TAGS,
  summary: 'Move a route onto the group',
  description:
    'A planned operation without downtime: the node that serves the route now must be a member and keeps serving while the other members get the route (config, certificates, Secure Link sources) first. A route whose names are registered Opfield domains moves with its domain (convert the domain instead). Requires proxy:edit on the route and proxy:create for every member.',
  request: { params: IdParamSchema, ...jsonBody(IngressGroupRouteConversionSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const convertDomainToIngressGroupRoute = appRoute({
  method: 'post',
  path: '/{id}/domains',
  tags: TAGS,
  summary: 'Move a domain and its routes onto the group',
  description:
    'Moves the domain, every route on it and every related registered domain: config and certificates on the new members first, then DNS (Cloudflare-managed records become the union of the active members’ addresses; external DNS must list them, Opfield validates it). The domain’s current node must be a member. Requires domains:edit on the domain and domains:create for every member.',
  request: { params: IdParamSchema, ...jsonBody(IngressGroupDomainConversionSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
