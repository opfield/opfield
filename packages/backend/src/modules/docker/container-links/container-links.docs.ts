import { z } from '@hono/zod-openapi';
import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  UnknownDataResponseSchema,
  UnknownListResponseSchema,
} from '@/lib/openapi.js';
import { CreateContainerLinkSchema, ListContainerLinksQuerySchema } from './container-links.schemas.js';

const TAG = 'Docker Containers';

export const listContainerLinksRoute = appRoute({
  method: 'get',
  path: '/container-links',
  tags: [TAG],
  summary: 'List the container links of a workload',
  description:
    'direction outgoing (default): the links the workload (container, deployment or Compose service) reaches other workloads through. incoming: the links that reach it. Needs view access to the workload.',
  request: { query: ListContainerLinksQuerySchema },
  responses: okJson(UnknownListResponseSchema),
});

export const createContainerLinkRoute = appRoute({
  method: 'post',
  path: '/container-links',
  tags: [TAG],
  summary: 'Link a workload to one port of another workload',
  description:
    'The consumer reaches the target as alias:targetPort on its own internal link network; the target needs no published port and no route, and cannot reach the consumer. Without environment names a container or deployment joins the link without a restart (a Compose service gets a new revision); with them the consumer is recreated once. Both Docker nodes need a daemon with secure_link_egress_v1. Needs docker:containers:edit on the consumer (docker:compose:manage for a Compose service), docker:containers:environment when environment names are set, and docker:containers:link on the target (docker:compose:manage for a Compose service). A node of the link that is offline (a reboot, an update) does not fail the request: the link is saved with status waiting and a lastError that says so, and is set up when the node reconnects.',
  request: { ...jsonBody(CreateContainerLinkSchema) },
  responses: createdJson(UnknownDataResponseSchema),
});

export const getContainerLinkRoute = appRoute({
  method: 'get',
  path: '/container-links/{id}',
  tags: [TAG],
  summary: 'Get a container link',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getContainerLinkRuntimeRoute = appRoute({
  method: 'get',
  path: '/container-links/{id}/runtime',
  tags: [TAG],
  summary: 'Get a container link with its relay counters',
  description:
    'The link and its relay counters summed over its routes (one per consumer node). A link whose ends share a node runs without the relay and reports no relay traffic.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteContainerLinkRoute = appRoute({
  method: 'delete',
  path: '/container-links/{id}',
  tags: [TAG],
  summary: 'Remove a container link',
  description:
    'Detaches the consumer from the link network (a Compose service gets a new revision; variables the link set recreate the consumer) and removes the link everywhere. Needs the consumer-side permissions of creating it.',
  request: { params: IdParamSchema },
  responses: okJson(z.object({ success: z.boolean() })),
});
