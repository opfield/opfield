import { createRoute, OpenAPIHono, type RouteConfig, z } from '@hono/zod-openapi';
import type { Env } from 'hono';
import type { BlankSchema, Schema } from 'hono/types';

type Method = RouteConfig['method'];
type RouteRequest = NonNullable<RouteConfig['request']>;
type RouteResponses = RouteConfig['responses'];

export const openApiValidationHook = (result: { success: boolean; error?: unknown }) => {
  if (!result.success && result.error) {
    throw result.error;
  }
};

/**
 * OpenAPIHono with Opfield's validation hook: a request that fails its route schema is answered with the standard
 * VALIDATION_ERROR shape, never the raw ZodError. Route runtimes hand it to the commercial edition, so the routers
 * it creates from them answer the same way.
 */
export class OpfieldOpenAPIHono<
  E extends Env = Env,
  S extends Schema = BlankSchema,
  BasePath extends string = '/',
> extends OpenAPIHono<E, S, BasePath> {
  constructor(init: ConstructorParameters<typeof OpenAPIHono<E, S, BasePath>>[0] = {}) {
    super({ defaultHook: openApiValidationHook, ...init });
  }
}

export const ApiErrorSchema = z.object({
  code: z.string().openapi({
    description: 'Error code',
    example: 'VALIDATION_ERROR',
  }),
  message: z.string().openapi({
    description: 'Human-readable error message',
    example: 'Request validation failed',
  }),
  details: z.any().optional().openapi({
    description: 'Additional error details',
  }),
});

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1).openapi({
    description: 'Page number (1-indexed)',
    example: 1,
  }),
  limit: z.coerce.number().min(1).max(100).default(20).openapi({
    description: 'Items per page',
    example: 20,
  }),
});

export const PaginationMetaSchema = z.object({
  page: z.number().openapi({ example: 1 }),
  limit: z.number().openapi({ example: 20 }),
  total: z.number().openapi({ example: 100 }),
  totalPages: z.number().openapi({ example: 5 }),
});

export const UUIDSchema = z.string().uuid().openapi({
  description: 'UUID v4 identifier',
  example: '550e8400-e29b-41d4-a716-446655440000',
});

export const TimestampSchema = z.string().datetime().openapi({
  description: 'ISO 8601 timestamp',
  example: '2024-01-01T12:00:00.000Z',
});

export const securitySchemes = {
  bearerAuth: {
    type: 'http' as const,
    scheme: 'bearer',
    description:
      'Opfield API token (`opf_...`) or OAuth access token (`opfo_...`) for programmatic access. Browser sessions use the HttpOnly session cookie.',
  },
  inferenceTokenAuth: {
    type: 'http' as const,
    scheme: 'bearer',
    description: 'Dedicated Opfield inference token (`opfi_...`). Valid only on inference adapter data planes.',
  },
};

export const jsonContent = (schema: z.ZodTypeAny, example?: unknown) => ({
  'application/json': example === undefined ? { schema } : { schema, example },
});

const GenericObjectSchema = z
  .object({
    id: z.string().optional().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    name: z.string().optional().openapi({ example: 'Example resource' }),
  })
  .catchall(z.any())
  .openapi({
    description: 'Resource object. Exact fields depend on the endpoint.',
    example: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Example resource',
      createdAt: '2024-01-01T12:00:00.000Z',
    },
  });

export const dataResponseSchema = (schema: z.ZodTypeAny) =>
  z
    .object({
      data: schema,
    })
    .openapi({
      example: {
        data: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'Example resource',
        },
      },
    });

export const listResponseSchema = (schema: z.ZodTypeAny) => dataResponseSchema(z.array(schema));

export const successResponseSchema = z.object({
  success: z.boolean().openapi({ example: true }),
});

export const messageResponseSchema = z.object({
  message: z.string().openapi({ example: 'Operation completed successfully' }),
});

export const UnknownDataResponseSchema = dataResponseSchema(GenericObjectSchema);
export const UnknownListResponseSchema = listResponseSchema(GenericObjectSchema);

export const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '550e8400-e29b-41d4-a716-446655440000',
    }),
});

export const NodeIdParamSchema = z.object({
  nodeId: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'nodeId', in: 'path' },
      example: '550e8400-e29b-41d4-a716-446655440000',
    }),
});

export const pathParamSchema = <T extends string>(...names: T[]) =>
  z.object(
    Object.fromEntries(
      names.map((name) => [
        name,
        z
          .string()
          .min(1)
          .openapi({
            param: { name, in: 'path' },
            example: name.toLowerCase().includes('id') ? '550e8400-e29b-41d4-a716-446655440000' : 'example',
          }),
      ])
    ) as Record<T, z.ZodString>
  );

export function jsonBody(schema: z.ZodTypeAny, description = 'JSON request body') {
  return {
    body: {
      description,
      required: true,
      content: jsonContent(schema),
    },
  };
}

export function optionalJsonBody(schema: z.ZodTypeAny, description = 'Optional JSON request body') {
  return {
    body: {
      description,
      required: false,
      content: jsonContent(schema),
    },
  };
}

export const okJson = (schema: z.ZodTypeAny = UnknownDataResponseSchema) => ({
  200: {
    description: 'Successful response',
    content: jsonContent(schema),
  },
});

export const createdJson = (schema: z.ZodTypeAny = UnknownDataResponseSchema) => ({
  201: {
    description: 'Created',
    content: jsonContent(schema),
  },
});

export const noContent = {
  204: {
    description: 'No content',
  },
};

export const successJson = okJson(successResponseSchema);

export const commonErrorResponses = {
  400: {
    description: 'Bad request',
    content: jsonContent(ApiErrorSchema, {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ path: ['name'], message: 'Required' }],
    }),
  },
  401: {
    description: 'Authentication required',
    content: jsonContent(ApiErrorSchema, {
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    }),
  },
  403: {
    description: 'Forbidden',
    content: jsonContent(ApiErrorSchema, {
      code: 'FORBIDDEN',
      message: 'Insufficient permissions',
    }),
  },
  404: {
    description: 'Not found',
    content: jsonContent(ApiErrorSchema, {
      code: 'NOT_FOUND',
      message: 'Resource not found',
    }),
  },
  409: {
    description: 'Conflict',
    content: jsonContent(ApiErrorSchema, {
      code: 'CONFLICT',
      message: 'Resource already exists',
    }),
  },
  422: {
    description: 'Unprocessable entity',
    content: jsonContent(ApiErrorSchema, {
      code: 'UNPROCESSABLE_ENTITY',
      message: 'Request could not be processed',
    }),
  },
  500: {
    description: 'Internal server error',
    content: jsonContent(ApiErrorSchema, {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    }),
  },
} satisfies RouteResponses;

const exampleResource = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Example resource',
  createdAt: '2024-01-01T12:00:00.000Z',
  updatedAt: '2024-01-01T12:30:00.000Z',
};

const tagExamples: Record<string, unknown> = {
  Authentication: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'admin@example.com',
    name: 'Admin User',
    groupName: 'Administrators',
    scopes: ['nodes:details', 'proxy:view'],
  },
  'Certificate Authorities': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    commonName: 'Example Root CA',
    type: 'root',
    status: 'active',
    notAfter: '2034-01-01T00:00:00.000Z',
  },
  Certificates: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    commonName: 'app.example.com',
    type: 'tls-server',
    status: 'active',
    notAfter: '2025-01-01T00:00:00.000Z',
  },
  Templates: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Web Server',
    type: 'tls-server',
    validityDays: 90,
  },
  Audit: {
    data: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        action: 'proxy.create',
        resourceType: 'proxy_host',
        createdAt: '2024-01-01T12:00:00.000Z',
      },
    ],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  },
  Alerts: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'certificate_expiry',
    severity: 'warning',
    message: 'Certificate expires soon',
    dismissed: false,
  },
  Tokens: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Automation token',
    tokenPrefix: 'opf_abc123',
    scopes: ['nodes:details'],
  },
  Admin: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'operator@example.com',
    name: 'Operator',
    groupName: 'Operators',
  },
  Nodes: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    hostname: 'edge-01',
    type: 'nginx',
    status: 'online',
    serviceCreationLocked: false,
  },
  Routes: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    domainNames: ['app.example.com'],
    forwardHost: '10.0.0.10',
    forwardPort: 3000,
    enabled: true,
  },
  'Route Folders': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Production',
    parentId: null,
    sortOrder: 10,
  },
  'Nginx Templates': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Default proxy',
    type: 'proxy',
    content: 'proxy_set_header Host $host;',
  },
  'Docker Containers': {
    id: 'nginx-prod',
    name: 'nginx-prod',
    image: 'nginx:1.27',
    state: 'running',
    ports: ['80/tcp'],
  },
  'Docker Deployments': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'api',
    image: 'registry.example.com/api:1.2.3',
    activeColor: 'blue',
    status: 'running',
  },
  'Docker Images': {
    id: 'sha256:abcd1234',
    repoTags: ['nginx:1.27'],
    size: 187000000,
    createdAt: '2024-01-01T12:00:00.000Z',
  },
  'Docker Volumes': {
    name: 'postgres-data',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/postgres-data/_data',
  },
  'Docker Networks': {
    id: '550e8400e29b',
    name: 'frontend',
    driver: 'bridge',
    scope: 'local',
  },
  'Docker Registries': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'GHCR',
    url: 'ghcr.io',
    username: 'deploy-bot',
  },
  'Docker Folders': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Apps',
    parentId: null,
  },
  'Docker Health Checks': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    containerId: 'api',
    status: 'healthy',
    intervalSeconds: 30,
  },
  'Docker Secrets': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    key: 'DATABASE_URL',
    source: 'manual',
    masked: true,
  },
  'Docker Files': {
    path: '/app/config.json',
    type: 'file',
    size: 1024,
    modifiedAt: '2024-01-01T12:00:00.000Z',
  },
  'Docker Tasks': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'image_pull',
    status: 'completed',
    progress: 100,
  },
  'Docker Webhooks': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Deploy API',
    enabled: true,
    tokenPreview: 'wh_abc...',
  },
  'SSL Certificates': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'app.example.com',
    type: 'acme',
    status: 'active',
    domains: ['app.example.com'],
  },
  Domains: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    domain: 'app.example.com',
    dnsStatus: 'valid',
    proxyHostCount: 1,
  },
  'Access Lists': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Office only',
    basicAuthEnabled: false,
    ipRules: [{ type: 'allow', value: '203.0.113.0/24' }],
    ipRuleWarnings: [],
  },
  Databases: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Production Postgres',
    type: 'postgres',
    healthStatus: 'online',
  },
  'Status Page': {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'API',
    status: 'operational',
    public: true,
  },
  Logging: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    environmentId: 'production',
    timestamp: '2024-01-01T12:00:00.000Z',
    message: 'Request completed',
    level: 'info',
  },
  AI: {
    enabled: true,
    providerUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
  },
  System: {
    currentVersion: '1.2.3',
    latestVersion: '1.2.4',
    updateAvailable: true,
  },
  License: {
    status: 'active',
    plan: 'pro',
    expiresAt: '2025-01-01T00:00:00.000Z',
  },
  Housekeeping: {
    enabled: true,
    cronExpression: '0 3 * * *',
    lastRunAt: '2024-01-01T03:00:00.000Z',
  },
  Monitoring: {
    proxyHosts: { total: 12, online: 11, offline: 1 },
    nodes: { total: 3, online: 3, offline: 0 },
  },
  Setup: {
    success: true,
    domain: 'opfield.example.com',
  },
  Notifications: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Slack alerts',
    enabled: true,
    status: 'success',
  },
};

function responseExampleFor(tag: string | undefined, method: Method, path: string, summary: string, status: string) {
  const data = (tag && tagExamples[tag]) || exampleResource;
  if (status === '201') return { data };
  if (status !== '200') return undefined;
  if (tag === 'Authentication' && path === '/csrf') return { csrfToken: 'csrf_abc123' };
  if (tag === 'Authentication' && path === '/logout') {
    return { message: 'Logged out successfully', logoutUrl: 'https://auth.example.com/logout' };
  }
  if (tag === 'Tokens' && method === 'get' && path === '/') return [data];
  if (tag === 'AI' && path === '/status') return { enabled: true };
  if (path.includes('/stream')) return undefined;
  if (
    method === 'get' &&
    (/^(list|search|scan|browse)\b/i.test(summary) ||
      path === '/' ||
      path.endsWith('/grouped') ||
      path.endsWith('/services'))
  ) {
    return Array.isArray(data) || (typeof data === 'object' && data !== null && 'data' in data)
      ? data
      : { data: [data] };
  }
  if (typeof data === 'object' && data !== null && 'data' in data) return data;
  return { data };
}

function addSuccessExamples(
  responses: RouteResponses,
  input: { method: Method; path: string; tags: string[]; summary: string }
) {
  const next = { ...responses } as RouteResponses;
  for (const status of ['200', '201'] as const) {
    const response = next[status] as any;
    const json = response?.content?.['application/json'];
    if (!json || 'example' in json) continue;
    const example = responseExampleFor(input.tags[0], input.method, input.path, input.summary, status);
    if (example === undefined) continue;
    next[status] = {
      ...response,
      content: {
        ...response.content,
        'application/json': { ...json, example },
      },
    };
  }
  return next;
}

export function appRoute(input: {
  method: Method;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  request?: RouteRequest;
  responses?: RouteResponses;
  security?: RouteConfig['security'];
}): RouteConfig {
  // A route-specific error response replaces the shared default for that status.
  const responses = addSuccessExamples({ ...commonErrorResponses, ...(input.responses ?? okJson()) }, input);
  return createRoute({
    method: input.method,
    path: input.path,
    tags: input.tags,
    summary: input.summary,
    description: input.description,
    request: input.request,
    security: input.security ?? [{ bearerAuth: [] }],
    responses,
  }) as RouteConfig;
}

export const tags = [
  { name: 'Authentication', description: 'User authentication via OIDC' },
  { name: 'Certificate Authorities', description: 'CA creation and management' },
  { name: 'Certificates', description: 'Certificate issuance, revocation, and export' },
  { name: 'Templates', description: 'Certificate template management' },
  { name: 'PKI', description: 'Public PKI endpoints (CRL, OCSP)' },
  { name: 'Audit', description: 'Audit log' },
  { name: 'Alerts', description: 'Expiry alerts and notifications' },
  { name: 'Tokens', description: 'API token management' },
  { name: 'Admin', description: 'User administration' },
  { name: 'Nodes', description: 'Opfield node enrollment, configuration, and monitoring' },
  { name: 'Routes', description: 'Ingress route management; stable API paths retain the proxy-hosts name' },
  { name: 'Route Folders', description: 'Ingress route folder organization' },
  { name: 'Nginx Templates', description: 'Reusable nginx config templates' },
  { name: 'Docker Containers', description: 'Docker container lifecycle and inspection' },
  { name: 'Docker Deployments', description: 'Blue/green Docker deployments' },
  { name: 'Docker Images', description: 'Docker image pull, remove, and prune operations' },
  { name: 'Docker Volumes', description: 'Docker volume management' },
  { name: 'Docker Networks', description: 'Docker network management' },
  { name: 'Docker Registries', description: 'Private Docker registry credentials' },
  { name: 'Docker Folders', description: 'Docker container folder organization' },
  { name: 'Docker Health Checks', description: 'Opfield-managed Docker health checks' },
  { name: 'Docker Migrations', description: 'Durable Docker node-to-node migrations' },
  { name: 'Docker Secrets', description: 'Container and deployment environment secrets' },
  { name: 'Docker Files', description: 'Container file browser operations' },
  { name: 'Docker Tasks', description: 'Docker background tasks' },
  { name: 'Docker Webhooks', description: 'External Docker update webhooks' },
  { name: 'SSL Certificates', description: 'SSL/TLS certificate management' },
  { name: 'Domains', description: 'Domain inventory and DNS checks' },
  { name: 'Access Lists', description: 'IP and basic-auth access controls' },
  { name: 'Databases', description: 'Database connections, monitoring, and explorers' },
  { name: 'Status Page', description: 'Status page settings, services, and incidents' },
  { name: 'Logging', description: 'Log ingestion, schemas, tokens, search, and metadata' },
  { name: 'AI', description: 'AI assistant configuration and metadata' },
  { name: 'Inference', description: 'Standalone multi-provider inference proxy management' },
  { name: 'System', description: 'Version, release, and update operations' },
  { name: 'License', description: 'Opfield license activation and status' },
  { name: 'Cloud', description: 'Connection of this installation to its cloud account' },
  { name: 'Housekeeping', description: 'Retention, cleanup, and housekeeping runs' },
  { name: 'Monitoring', description: 'Dashboard, health, log, and nginx monitoring' },
  { name: 'Setup', description: 'Initial setup and bootstrap operations' },
  { name: 'Notifications', description: 'Notification webhooks and alert rules' },
];
