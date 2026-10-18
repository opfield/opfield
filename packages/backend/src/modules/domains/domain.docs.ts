import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  optionalJsonBody,
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
  CreateDomainSchema,
  DeleteDomainSchema,
  DomainIngressMigrationSchema,
  DomainIngressPlacementSchema,
  DomainListQuerySchema,
  PreviewDomainSchema,
  ResolveCloudflareMigrationSchema,
  UpdateDomainSchema,
} from './domain.schemas.js';

export const listDomainFoldersRoute = appRoute({
  method: 'get',
  path: '/folders',
  tags: ['Domains'],
  summary: 'List domain folders',
  responses: okJson(UnknownDataResponseSchema),
});

export const createDomainFolderRoute = appRoute({
  method: 'post',
  path: '/folders',
  tags: ['Domains'],
  summary: 'Create a domain folder',
  request: jsonBody(CreateResourceFolderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const reorderDomainFoldersRoute = appRoute({
  method: 'put',
  path: '/folders/reorder',
  tags: ['Domains'],
  summary: 'Reorder domain folders',
  request: jsonBody(ReorderResourceFoldersSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const moveDomainsToFolderRoute = appRoute({
  method: 'post',
  path: '/folders/move-domains',
  tags: ['Domains'],
  summary: 'Move domains to a folder',
  request: jsonBody(MoveResourcesToFolderSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const reorderDomainsRoute = appRoute({
  method: 'put',
  path: '/folders/reorder-domains',
  tags: ['Domains'],
  summary: 'Reorder domains within a folder',
  request: jsonBody(ReorderResourcesSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateDomainFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}',
  tags: ['Domains'],
  summary: 'Rename a domain folder',
  request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveDomainFolderRoute = appRoute({
  method: 'put',
  path: '/folders/{id}/move',
  tags: ['Domains'],
  summary: 'Move a domain folder',
  request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteDomainFolderRoute = appRoute({
  method: 'delete',
  path: '/folders/{id}',
  tags: ['Domains'],
  summary: 'Delete a domain folder',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const listDomainsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Domains'],
  summary: 'List domains',
  description:
    'Each domain carries app (its app and environment, or null). excludeAppMembers leaves out domains that belong to an app (the normal list); appId lists the domains of one app.',
  request: { query: DomainListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const searchDomainsRoute = appRoute({
  method: 'get',
  path: '/search',
  tags: ['Domains'],
  summary: 'Search domains for autocomplete',
  responses: okJson(UnknownDataResponseSchema),
});

export const listDomainNginxNodesRoute = appRoute({
  method: 'get',
  path: '/nginx-nodes',
  tags: ['Domains'],
  summary: 'List eligible Nginx ingress nodes for domains',
  description:
    'Needs any domains:create grant (broad, folder or node). eligibleNodes are nginx nodes with a public ingress address the caller may create domains on, unconfiguredNodes those without one. ingressGroups lists the ingress groups a new domain may use: the caller holds ingress:groups:view on the group, every member is an eligible node open to the caller, and at least one member is active; members are listed in site order with their state. Create the domain with ingressGroupId to serve it (and its routes) from every member; Cloudflare DNS then lists every active member address (round robin, no health checks in DNS failover mode none).',
  responses: okJson(UnknownDataResponseSchema),
});

export const getDomainRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Domains'],
  summary: 'Get domain details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createDomainRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Domains'],
  summary: 'Create a domain',
  description:
    'dnsProvider external registers the domain only once its DNS already points at the selected ingress (A/AAAA records resolving to its addresses); Opfield checks it and never changes DNS. Until then the create answers 409 DOMAIN_DNS_NOT_READY with details.targetIps and details.dnsRecords: create the records at the DNS provider and create the domain again (POST /preview runs the same check). folderId = placementFolderIds.domains of an app environment creates the domain inside it: the name must match the environment domain allowlist (422 APP_DOMAIN_NOT_ALLOWED) and the ingress node (every member of an ingress group) must be allowed there (APP_NODE_NOT_ALLOWED).',
  request: jsonBody(CreateDomainSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const previewDomainRoute = appRoute({
  method: 'post',
  path: '/preview',
  tags: ['Domains'],
  summary: 'Preview DNS readiness for a domain',
  request: jsonBody(PreviewDomainSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const updateDomainRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Domains'],
  summary: 'Update a domain',
  request: { params: IdParamSchema, ...jsonBody(UpdateDomainSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteDomainRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Domains'],
  summary: 'Delete a domain',
  request: { params: IdParamSchema, ...optionalJsonBody(DeleteDomainSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const checkDomainDnsRoute = appRoute({
  method: 'post',
  path: '/{id}/check-dns',
  tags: ['Domains'],
  summary: 'Run a DNS check for a domain',
  description:
    'Re-probes the domain DNS. By default the check also repairs drift: it reconciles an ingress group domain and rewrites a drifted Cloudflare record towards the approved target. With `repair=false` it only reads the resolver and the provider records and stores the observed status.',
  request: {
    params: IdParamSchema,
    query: z.object({
      repair: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: '`false` makes the check read-only: no provider writes and no reconciliation.' }),
    }),
  },
  responses: okJson(UnknownDataResponseSchema),
});

export const resolveCloudflareMigrationRoute = appRoute({
  method: 'post',
  path: '/{id}/cloudflare-migration/resolve',
  tags: ['Domains'],
  summary: 'Resolve a Cloudflare migration conflict',
  request: { params: IdParamSchema, ...jsonBody(ResolveCloudflareMigrationSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const previewDomainIngressMigrationRoute = appRoute({
  method: 'post',
  path: '/{id}/ingress-migration/preview',
  tags: ['Domains'],
  summary: 'Preview a domain ingress migration',
  description:
    'Lists the domains and routes that move and every issue the move would run into, before anything moves. status is blocked while issues holds a blocker (severity blocker; each has code, message, fix, resourceType and resourceId): the app environment of a route does not allow the target node, the target node is offline or locked for new services, a route has additional Secure Links, TLS or Pages cannot be delivered to the target, a Pages route is not ready, an enabled route on the target already serves a moved name, external DNS does not point at the target yet, or the caller lacks a permission. Warnings (severity warning) describe what stays behind, such as a Pages project whose previews stay on the source node. ready: POST /{id}/ingress-migration starts the move and refuses with 409 DOMAIN_INGRESS_MIGRATION_BLOCKED (details.blockers) while a blocker is left. waiting_dns and cleanup_pending: a started move waits for DNS or for the source cleanup.',
  request: { params: IdParamSchema, ...jsonBody(DomainIngressMigrationSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const migrateDomainIngressRoute = appRoute({
  method: 'post',
  path: '/{id}/ingress-migration',
  tags: ['Domains'],
  summary: 'Move a domain and its routes to another nginx ingress node',
  request: { params: IdParamSchema, ...jsonBody(DomainIngressMigrationSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const issueDomainCertificateRoute = appRoute({
  method: 'post',
  path: '/{id}/issue-cert',
  tags: ['Domains'],
  summary: 'Issue an ACME certificate for a domain',
  // The optional body is parsed by the handler so body-less calls keep working.
  description:
    'Requires domains:view on the domain and ssl:cert:issue on the destination. Optional JSON body `{ "folderId": "<ssl certificate folder id>" }` creates the certificate in that SSL certificate folder.',
  request: { params: IdParamSchema },
  responses: createdJson(UnknownDataResponseSchema),
});

export const changeDomainIngressPlacementRoute = appRoute({
  method: 'post',
  path: '/{id}/ingress-placement',
  tags: ['Domains'],
  summary: 'Move a domain onto an ingress group or back to one node',
  description:
    'Moves the domain, every route on it and every related registered domain. Onto a group (ingressGroupId): the domain’s current node must be a member and keeps serving; config and certificates reach the other members first, then Cloudflare-managed DNS records become the union of the active members’ addresses (round robin, no health checks: DNS failover mode none). External DNS stays the operator’s: list the members’ addresses there. Back to one node (ingressGroupId null, nginxNodeId a current member): DNS first, then the routes leave the other members. A domain that backs the Pages wildcard profile stays on one node. Onto a group requires domains:create for every member and the multi-node availability entitlement.',
  request: { params: IdParamSchema, ...jsonBody(DomainIngressPlacementSchema) },
  responses: okJson(UnknownDataResponseSchema),
});
