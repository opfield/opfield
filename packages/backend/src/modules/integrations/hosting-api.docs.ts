import { type OpenAPIHono, z } from '@hono/zod-openapi';
import { appRoute, jsonBody, pathParamSchema, withDocumentedConditionals } from '@/lib/openapi.js';
import {
  CreateHostingConnectorSchema,
  DiscoverHostingConnectorSchema,
  HostingActionSchema,
  HostingAdoptSchema,
  HostingProvisionSchema,
  UpdateHostingConnectorSchema,
} from '@/modules/hosting/hosting.schemas.js';
import { HostingFirewallUpdateSchema } from '@/modules/hosting/hosting-firewall.types.js';
import { PROVIDER_ORIGINS } from '@/modules/hosting/hosting-http.js';
import { HostingSnapshotInputSchema } from '@/modules/hosting/hosting-snapshots.service.js';
import type { AppEnv } from '@/types.js';

/**
 * The OpenAPI operations of the hosting API (/api/integrations/hosting, /api/hosting). Plain routes in
 * modules/hosting/hosting.routes.ts serve them; this file only documents them. Hosting answers are not wrapped in
 * `data`.
 */

const TAG = 'Hosting';
const IdParams = pathParamSchema('id');
const HostingObjectSchema = z.object({}).catchall(z.any()).openapi({ description: 'Hosting object' });
const ok = (description: string) => ({
  200: { description, content: { 'application/json': { schema: HostingObjectSchema } } },
});
const accepted = (description: string) => ({
  202: { description, content: { 'application/json': { schema: HostingObjectSchema } } },
});
const created = (description: string) => ({
  201: { description, content: { 'application/json': { schema: HostingObjectSchema } } },
});

const RetryInstallSchema = z
  .object({ idempotencyKey: z.string().uuid(), sshConnectorId: z.string().uuid().optional() })
  .strict();
const SnapshotFolderActionSchema = z
  .object({
    operation: z.enum(['create', 'rename', 'delete', 'reorder-folders', 'move-resources', 'reorder-resources']),
    folderId: z.string().uuid().optional(),
    input: z.unknown(),
  })
  .strict();

const PERMISSIONS =
  'Needs the hosting permissions of the connector or resource (integrations and hosting:resources:* scopes).';

/** The create body with what each provider requires: its official API origin, or a Proxmox token ID. */
const CreateHostingConnectorDocumentedSchema = withDocumentedConditionals(CreateHostingConnectorSchema, [
  ...Object.entries(PROVIDER_ORIGINS).map(([provider, origin]) => ({
    when: { properties: { provider: { const: provider } } },
    requires: { properties: { baseUrl: { const: origin } } },
  })),
  {
    when: { properties: { provider: { const: 'proxmox' } } },
    requires: { required: ['settings'], properties: { settings: { required: ['tokenId'] } } },
  },
]);

const integrationRoutes = [
  appRoute({
    method: 'get',
    path: '/',
    tags: [TAG],
    summary: 'List hosting connectors',
    responses: ok('Hosting connectors the caller may see'),
  }),
  appRoute({
    method: 'post',
    path: '/test',
    tags: [TAG],
    summary: 'Test a hosting connector before saving it',
    request: jsonBody(CreateHostingConnectorDocumentedSchema),
    responses: ok('The provider check'),
  }),
  appRoute({
    method: 'post',
    path: '/discover',
    tags: [TAG],
    summary: "Discover a provider's locations, sizes and images",
    request: jsonBody(DiscoverHostingConnectorSchema),
    responses: ok('What the provider offers'),
  }),
  appRoute({
    method: 'post',
    path: '/',
    tags: [TAG],
    summary: 'Create a hosting connector',
    request: jsonBody(CreateHostingConnectorDocumentedSchema),
    responses: created('The connector (without its token)'),
  }),
  appRoute({
    method: 'get',
    path: '/{id}',
    tags: [TAG],
    summary: 'Get a hosting connector',
    request: { params: IdParams },
    responses: ok('The connector (without its token)'),
  }),
  appRoute({
    method: 'get',
    path: '/{id}/configuration',
    tags: [TAG],
    summary: "Get a hosting connector's configuration",
    request: { params: IdParams },
    responses: ok('The editable configuration'),
  }),
  appRoute({
    method: 'put',
    path: '/{id}',
    tags: [TAG],
    summary: 'Update a hosting connector',
    description: `Refused (409 HOSTING_OPERATION_ACTIVE) while an operation of the connector is open. ${PERMISSIONS}`,
    request: { params: IdParams, ...jsonBody(UpdateHostingConnectorSchema) },
    responses: ok('The connector'),
  }),
  appRoute({
    method: 'delete',
    path: '/{id}',
    tags: [TAG],
    summary: 'Delete a hosting connector',
    request: { params: IdParams },
    responses: ok('The removal result'),
  }),
  appRoute({
    method: 'post',
    path: '/{id}/test',
    tags: [TAG],
    summary: 'Test a saved hosting connector',
    request: { params: IdParams },
    responses: ok('The provider check'),
  }),
  appRoute({
    method: 'post',
    path: '/{id}/sync',
    tags: [TAG],
    summary: "Sync a connector's inventory from the provider",
    request: { params: IdParams },
    responses: ok('The synced inventory'),
  }),
  appRoute({
    method: 'get',
    path: '/{id}/catalog',
    tags: [TAG],
    summary: 'Get the order catalog of a connector',
    description: 'Locations, sizes, images and prices an order may use.',
    request: { params: IdParams },
    responses: ok('The catalog'),
  }),
  appRoute({
    method: 'get',
    path: '/{id}/resources',
    tags: [TAG],
    summary: "List a connector's hosting resources",
    request: { params: IdParams },
    responses: ok('The resources'),
  }),
  appRoute({
    method: 'get',
    path: '/{id}/adoption-candidates',
    tags: [TAG],
    summary: 'List provider resources that can be adopted',
    request: { params: IdParams },
    responses: ok('Adoptable resources'),
  }),
  appRoute({
    method: 'post',
    path: '/{id}/adopt',
    tags: [TAG],
    summary: 'Adopt a provider resource as the host of a node',
    request: { params: IdParams, ...jsonBody(HostingAdoptSchema) },
    responses: ok('The adopted resource'),
  }),
  appRoute({
    method: 'get',
    path: '/{id}/operations',
    tags: [TAG],
    summary: "List a connector's hosting operations",
    request: { params: IdParams },
    responses: ok('The operations'),
  }),
  appRoute({
    method: 'get',
    path: '/{id}/account-summary',
    tags: [TAG],
    summary: "Get the provider account's summary",
    request: { params: IdParams },
    responses: ok('Balance, spending and limits'),
  }),
];

const hostingRoutes = [
  appRoute({
    method: 'get',
    path: '/nodes/{id}/firewall',
    tags: [TAG],
    summary: "Get a hosted node's provider firewall",
    request: { params: IdParams },
    responses: ok('The firewall configuration'),
  }),
  appRoute({
    method: 'put',
    path: '/nodes/{id}/firewall',
    tags: [TAG],
    summary: "Change a hosted node's provider firewall",
    description: 'Applied in the background: 202 once accepted.',
    request: { params: IdParams, ...jsonBody(HostingFirewallUpdateSchema) },
    responses: accepted('The change was accepted'),
  }),
  appRoute({
    method: 'get',
    path: '/node-bindings',
    tags: [TAG],
    summary: 'List which nodes run on hosting resources',
    responses: ok('Node to hosting resource bindings'),
  }),
  appRoute({
    method: 'get',
    path: '/nodes/{id}',
    tags: [TAG],
    summary: 'Get the hosting view of a node',
    request: { params: IdParams },
    responses: ok("The node's hosting resource and operations"),
  }),
  appRoute({
    method: 'post',
    path: '/operations',
    tags: [TAG],
    summary: 'Order a hosted node',
    description: `Creates the node and orders its server from the connector's provider; the operation runs in the background (202). idempotencyKey makes a replayed order return the same operation. ${PERMISSIONS}`,
    request: jsonBody(HostingProvisionSchema),
    responses: accepted('The hosting operation'),
  }),
  appRoute({
    method: 'get',
    path: '/operations/{id}',
    tags: [TAG],
    summary: 'Get a hosting operation',
    request: { params: IdParams },
    responses: ok('The operation'),
  }),
  appRoute({
    method: 'post',
    path: '/operations/{id}/reconcile',
    tags: [TAG],
    summary: 'Reconcile a hosting operation now',
    request: { params: IdParams },
    responses: ok('The operation'),
  }),
  appRoute({
    method: 'post',
    path: '/operations/{id}/retry-install',
    tags: [TAG],
    summary: 'Retry the node installation of a hosting operation',
    request: { params: IdParams, ...jsonBody(RetryInstallSchema) },
    responses: accepted('The operation'),
  }),
  appRoute({
    method: 'post',
    path: '/resources/{id}/actions',
    tags: [TAG],
    summary: 'Run an action on a hosting resource',
    description: `start, shutdown, reboot, resize (size or cpu, memoryMb, diskGb required), delete or recover; confirmed must be true and expectedIncarnation the resource's current one. Runs in the background (202). ${PERMISSIONS}`,
    request: { params: IdParams, ...jsonBody(HostingActionSchema) },
    responses: accepted('The hosting operation'),
  }),
  appRoute({
    method: 'get',
    path: '/resources/{id}/snapshots',
    tags: [TAG],
    summary: "List a hosting resource's snapshots",
    request: { params: IdParams },
    responses: ok('The snapshots'),
  }),
  appRoute({
    method: 'get',
    path: '/resources/{id}/snapshot-folders',
    tags: [TAG],
    summary: "List a hosting resource's snapshot folders",
    request: { params: IdParams },
    responses: ok('The snapshot folders'),
  }),
  appRoute({
    method: 'post',
    path: '/resources/{id}/snapshot-folders/actions',
    tags: [TAG],
    summary: 'Change the snapshot folders of a hosting resource',
    request: { params: IdParams, ...jsonBody(SnapshotFolderActionSchema) },
    responses: ok('The snapshot folders'),
  }),
  appRoute({
    method: 'post',
    path: '/resources/{id}/snapshots/actions',
    tags: [TAG],
    summary: 'Create, restore or delete a hosting resource snapshot',
    description: 'Runs in the background (202).',
    request: { params: IdParams, ...jsonBody(HostingSnapshotInputSchema) },
    responses: accepted('The hosting operation'),
  }),
];

const documented = new WeakSet<OpenAPIHono<AppEnv>>();

/** Adds the hosting operations to the OpenAPI document (once per router); call before the routers are mounted. */
export function documentHostingRoutes(integrations: OpenAPIHono<AppEnv>, hosting: OpenAPIHono<AppEnv>) {
  if (documented.has(hosting)) return;
  documented.add(hosting);
  for (const route of integrationRoutes) integrations.openAPIRegistry.registerPath(route);
  for (const route of hostingRoutes) hosting.openAPIRegistry.registerPath(route);
}
