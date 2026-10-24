import { z } from '@hono/zod-openapi';
import type {
  ContainerLinkEnvironment,
  ContainerLinkStatus,
  ContainerLinkWorkloadType,
} from '@/db/schema/container-links.js';

/** A DNS label (RFC 1123), lower case: the name the consumer reaches the target by on the link network. */
export const CONTAINER_LINK_ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Aliases of managed database and storage links, which share the consumer's name space. */
export const RESERVED_CONTAINER_LINK_ALIAS_PATTERN = /^(?:db|storage)-[0-9a-f]{16}$/;

const environmentNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);

export const ContainerLinkWorkloadTypeSchema = z.enum(['container', 'deployment', 'compose_service']);

export const ContainerLinkEnvironmentSchema = z
  .object({
    host: environmentNameSchema.optional(),
    port: environmentNameSchema.optional(),
    url: environmentNameSchema.optional(),
  })
  .strict();

export const CreateContainerLinkSchema = z.object({
  sourceNodeId: z.string().uuid(),
  sourceType: ContainerLinkWorkloadTypeSchema,
  /** Container name, deployment id, or `<compose project id>:<url-encoded service name>`. */
  sourceResourceId: z.string().trim().min(1).max(255),
  targetNodeId: z.string().uuid(),
  targetType: ContainerLinkWorkloadTypeSchema,
  targetResourceId: z.string().trim().min(1).max(255),
  targetPort: z.number().int().min(1).max(65535),
  /** Defaults to the target's name as a DNS label. */
  alias: z.string().trim().toLowerCase().max(63).regex(CONTAINER_LINK_ALIAS_PATTERN).optional(),
  /** Variables the consumer gets (host, port, url); setting any recreates the consumer once. */
  environment: ContainerLinkEnvironmentSchema.optional(),
});

export type CreateContainerLinkInput = z.infer<typeof CreateContainerLinkSchema>;

export const ListContainerLinksQuerySchema = z.object({
  nodeId: z.string().uuid().describe('Docker node of the workload'),
  type: ContainerLinkWorkloadTypeSchema.describe('Kind of the workload whose links are listed'),
  resourceId: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe(
      'The workload: a container name, a deployment id, or `<composeProjectId>:<serviceName>` for a Compose service'
    ),
  /** `outgoing`: links the workload starts (its consumer side). `incoming`: links that reach it. */
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
});

export type ListContainerLinksQuery = z.infer<typeof ListContainerLinksQuerySchema>;

export interface ContainerLinkView {
  id: string;
  source: { nodeId: string; type: ContainerLinkWorkloadType; resourceId: string };
  target: { nodeId: string; type: ContainerLinkWorkloadType; resourceId: string };
  targetPort: number;
  alias: string;
  environment: ContainerLinkEnvironment;
  networkName: string;
  status: ContainerLinkStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContainerLinkRuntimeView {
  link: ContainerLinkView;
  /** The link's relay counters, summed over its routes; null while it has none. */
  runtime: import('@/services/relay-policy.service.js').RelayRouteRuntime | null;
}
