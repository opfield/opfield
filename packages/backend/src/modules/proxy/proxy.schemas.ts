import { z } from 'zod';
import { createChildLogger } from '@/lib/logger.js';
import { queryFlag } from '@/modules/apps/app-membership.js';
import { reservedTemplateVariableNames, withoutReservedTemplateVariables } from './proxy-template-variables.js';

const logger = createChildLogger('ProxySchemas');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const domainNameRegex = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

const DomainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(domainNameRegex, 'Invalid domain name format');

const CustomHeaderSchema = z.object({
  name: z.string().min(1).max(255),
  value: z.string().min(1).max(4096),
});

const CacheOptionsSchema = z.object({
  maxAge: z.number().int().min(0).optional(),
  staleWhileRevalidate: z.number().int().min(0).optional(),
});

const RateLimitOptionsSchema = z.object({
  requestsPerSecond: z.number().int().min(1),
  burst: z.number().int().min(1).optional(),
  connectionsPerIp: z.number().int().min(1).optional(),
});

const RewriteRuleSchema = z.object({
  source: z.string().min(1).max(1024),
  destination: z.string().min(1).max(1024),
  type: z.enum(['permanent', 'temporary']),
});

/**
 * Gateway-managed render keys are ignored at render time, and custom templates that declare such
 * variables send them back from the host form. Drop them here instead of rejecting the save.
 */
const TemplateVariablesSchema = z.record(z.union([z.string(), z.number(), z.boolean()])).transform((variables) => {
  const reserved = reservedTemplateVariableNames(variables);
  if (reserved.length === 0) return variables;
  logger.info('Dropped Gateway-managed template variables from proxy host input', { reserved });
  return withoutReservedTemplateVariables(variables);
});

const HealthCheckBodyMatchModeSchema = z.enum(['includes', 'exact', 'starts_with', 'ends_with']);
const RelaySpreadModeSchema = z.enum(['inherit', 'fixed', 'all']);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const CreateProxyHostSchema = z
  .object({
    type: z.enum(['proxy', 'redirect', '404', 'raw']).default('proxy'),
    // Optional: omitted, the route uses the ingress node or group its registered Gateway domains are assigned
    // to, or the only nginx node the caller may create routes on (see route-ingress-nodes.ts).
    nodeId: z.string().uuid('A node must be selected').optional(),
    // Serve the route from every member of this ingress group instead of one node.
    ingressGroupId: z.string().uuid().optional(),
    domainNames: z.array(DomainNameSchema).min(1, 'At least one domain name is required'),

    // Upstream — proxy type
    upstreamKind: z.enum(['manual', 'docker_container', 'docker_deployment', 'pages']).default('manual'),
    forwardHost: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid hostname')
      .optional(),
    forwardPort: z.number().int().min(1).max(65535).optional(),
    forwardScheme: z.enum(['http', 'https']).default('http'),
    upstreamIpv6Enabled: z.boolean().default(false),
    dockerNodeId: z.string().uuid().optional(),
    // Older browser bundles serialized mutually exclusive Docker target fields
    // as null. Accept those payloads so cached clients remain compatible while
    // still requiring exactly one complete container or Compose reference.
    dockerContainerName: z.string().min(1).max(255).optional().nullable(),
    dockerComposeProjectId: z.string().uuid().optional().nullable(),
    dockerComposeServiceName: z.string().min(1).max(255).optional().nullable(),
    dockerDeploymentId: z.string().uuid().optional(),
    dockerContainerPort: z.number().int().min(1).max(65535).optional(),
    dockerHostPort: z.number().int().min(1).max(65535).optional(),
    dockerProtocol: z.literal('tcp').optional(),
    pageProjectId: z.string().uuid().optional(),
    pageTagId: z.string().uuid().optional(),
    relaySpreadMode: RelaySpreadModeSchema.optional(),
    relaySpreadCount: z.number().int().min(1).max(64).optional().nullable(),

    // SSL
    sslEnabled: z.boolean().default(false),
    sslForced: z.boolean().default(false),
    http2Support: z.boolean().default(true),
    websocketSupport: z.boolean().default(false),
    sslCertificateId: z.string().uuid().optional(),
    internalCertificateId: z.string().uuid().optional(),

    // Redirect type
    redirectUrl: z.string().url().max(2048).optional(),
    redirectStatusCode: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional(),

    // Custom headers
    customHeaders: z.array(CustomHeaderSchema).default([]),

    // Cache
    cacheEnabled: z.boolean().default(false),
    cacheOptions: CacheOptionsSchema.optional(),

    // Rate limit
    rateLimitEnabled: z.boolean().default(false),
    rateLimitMode: z.enum(['inherit', 'custom', 'disabled']).default('inherit'),
    rateLimitOptions: RateLimitOptionsSchema.optional(),

    // Rewrites
    customRewrites: z.array(RewriteRuleSchema).default([]),

    // Advanced nginx config
    advancedConfig: z.string().max(10000).optional(),

    // Raw config override — bypasses template rendering
    rawConfig: z.string().max(100000).optional(),
    rawConfigEnabled: z.boolean().optional(),

    // Access list
    accessListId: z.string().uuid().optional(),

    // Folder
    folderId: z.string().uuid().optional(),

    // Nginx config template
    nginxTemplateId: z.string().uuid().optional(),
    templateVariables: TemplateVariablesSchema.optional(),

    // Health check
    healthCheckEnabled: z.boolean().default(false),
    healthCheckUrl: z.string().max(500).regex(/^\//, 'Must start with /').optional(),
    healthCheckInterval: z.number().int().min(5).max(3600).optional(),
    healthCheckExpectedStatus: z.number().int().min(100).max(599).optional(),
    healthCheckExpectedBody: z.string().max(500).optional(),
    healthCheckBodyMatchMode: HealthCheckBodyMatchModeSchema.optional(),
    healthCheckSlowThreshold: z.number().int().min(0).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'proxy' && data.upstreamKind === 'manual') {
      if (!data.forwardHost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'forwardHost is required for proxy type',
          path: ['forwardHost'],
        });
      }
      if (data.forwardPort === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'forwardPort is required for proxy type',
          path: ['forwardPort'],
        });
      }
    }

    if (data.relaySpreadMode === 'fixed' && data.relaySpreadCount == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Relay spread count is required in fixed mode',
        path: ['relaySpreadCount'],
      });
    }
    if (data.relaySpreadMode !== 'fixed' && data.relaySpreadCount != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Relay spread count is only available in fixed mode',
        path: ['relaySpreadCount'],
      });
    }

    if (data.type === 'proxy' && data.upstreamKind === 'docker_container') {
      for (const [field, value, message] of [
        ['dockerNodeId', data.dockerNodeId, 'Docker node is required'],
        ['dockerContainerPort', data.dockerContainerPort, 'Container port is required'],
      ] as const) {
        if (value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [field] });
        }
      }
      const hasContainer = Boolean(data.dockerContainerName);
      const hasCompose = Boolean(data.dockerComposeProjectId && data.dockerComposeServiceName);
      if (hasContainer === hasCompose) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Select either a container or a Compose service',
          path: ['dockerContainerName'],
        });
      }
    }

    if (data.type === 'proxy' && data.upstreamKind === 'docker_deployment') {
      for (const [field, value, message] of [
        ['dockerDeploymentId', data.dockerDeploymentId, 'Deployment is required'],
        ['dockerContainerPort', data.dockerContainerPort, 'Container port is required'],
      ] as const) {
        if (value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [field] });
        }
      }
    }

    if (data.type === 'proxy' && data.upstreamKind === 'pages') {
      for (const [field, value, message] of [
        ['pageProjectId', data.pageProjectId, 'Page Project is required'],
        ['pageTagId', data.pageTagId, 'Page Tag is required'],
      ] as const) {
        if (value === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [field] });
      }
      if (data.rawConfigEnabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Pages Routes do not support Raw Config mode',
          path: ['upstreamKind'],
        });
      }
      if (data.websocketSupport) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'WebSocket upgrades are not available for static Pages Routes',
          path: ['upstreamKind'],
        });
      }
    }

    if (data.type !== 'proxy' && data.upstreamKind !== 'manual') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Managed upstreams are only available for proxy routes',
        path: ['upstreamKind'],
      });
    }

    if (data.type === 'redirect') {
      if (!data.redirectUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'redirectUrl is required for redirect type',
          path: ['redirectUrl'],
        });
      }
    }

    if (data.type === '404' && data.healthCheckEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Health checks are not available for 404 hosts (no upstream)',
        path: ['healthCheckEnabled'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Update — partial version (all fields optional)
// ---------------------------------------------------------------------------

export const UpdateProxyHostSchema = z.object({
  type: z.enum(['proxy', 'redirect', '404', 'raw']).optional(),
  nodeId: z.string().uuid().optional(),
  // A group id moves the route onto that ingress group; null serves it from `nodeId` (a current member) again.
  ingressGroupId: z.string().uuid().nullable().optional(),
  domainNames: z.array(DomainNameSchema).min(1, 'At least one domain name is required').optional(),

  upstreamKind: z.enum(['manual', 'docker_container', 'docker_deployment', 'pages']).optional(),

  forwardHost: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid hostname')
    .optional()
    .nullable(),
  forwardPort: z.number().int().min(1).max(65535).optional().nullable(),
  forwardScheme: z.enum(['http', 'https']).optional(),
  upstreamIpv6Enabled: z.boolean().optional(),
  dockerNodeId: z.string().uuid().optional().nullable(),
  dockerContainerName: z.string().min(1).max(255).optional().nullable(),
  dockerComposeProjectId: z.string().uuid().optional().nullable(),
  dockerComposeServiceName: z.string().min(1).max(255).optional().nullable(),
  dockerDeploymentId: z.string().uuid().optional().nullable(),
  dockerContainerPort: z.number().int().min(1).max(65535).optional().nullable(),
  dockerHostPort: z.number().int().min(1).max(65535).optional().nullable(),
  dockerProtocol: z.literal('tcp').optional().nullable(),
  pageProjectId: z.string().uuid().optional().nullable(),
  pageTagId: z.string().uuid().optional().nullable(),
  relaySpreadMode: RelaySpreadModeSchema.optional(),
  relaySpreadCount: z.number().int().min(1).max(64).optional().nullable(),

  sslEnabled: z.boolean().optional(),
  sslForced: z.boolean().optional(),
  http2Support: z.boolean().optional(),
  websocketSupport: z.boolean().optional(),
  sslCertificateId: z.string().uuid().optional().nullable(),
  internalCertificateId: z.string().uuid().optional().nullable(),

  redirectUrl: z.string().url().max(2048).optional().nullable(),
  redirectStatusCode: z
    .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
    .optional()
    .nullable(),

  customHeaders: z.array(CustomHeaderSchema).optional(),
  cacheEnabled: z.boolean().optional(),
  cacheOptions: CacheOptionsSchema.optional().nullable(),
  rateLimitEnabled: z.boolean().optional(),
  rateLimitMode: z.enum(['inherit', 'custom', 'disabled']).optional(),
  rateLimitOptions: RateLimitOptionsSchema.optional().nullable(),
  customRewrites: z.array(RewriteRuleSchema).optional(),

  advancedConfig: z.string().max(10000).optional().nullable(),

  rawConfig: z.string().max(100000).optional().nullable(),
  rawConfigEnabled: z.boolean().optional(),

  accessListId: z.string().uuid().optional().nullable(),

  folderId: z.string().uuid().optional().nullable(),

  nginxTemplateId: z.string().uuid().optional().nullable(),
  templateVariables: TemplateVariablesSchema.optional().nullable(),

  healthCheckEnabled: z.boolean().optional(),
  healthCheckUrl: z.string().max(500).regex(/^\//, 'Must start with /').optional().nullable(),
  healthCheckInterval: z.number().int().min(5).max(3600).optional().nullable(),
  healthCheckExpectedStatus: z.number().int().min(100).max(599).optional().nullable(),
  healthCheckExpectedBody: z.string().max(500).optional().nullable(),
  healthCheckBodyMatchMode: HealthCheckBodyMatchModeSchema.optional().nullable(),
  healthCheckSlowThreshold: z.number().int().min(0).max(100).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Additional Secure Link — Route-scoped link to a Docker workload or managed storage
// ---------------------------------------------------------------------------

export const CreateAdditionalSecureLinkSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    upstreamKind: z.enum(['docker_container', 'docker_deployment', 'managed_storage']),
    managedStorageId: z.string().uuid().nullable().optional(),
    forwardScheme: z.enum(['http', 'https']).default('http'),
    dockerNodeId: z.string().uuid().nullable().optional(),
    dockerContainerName: z.string().min(1).max(255).nullable().optional(),
    dockerComposeProjectId: z.string().uuid().nullable().optional(),
    dockerComposeServiceName: z.string().min(1).max(255).nullable().optional(),
    dockerDeploymentId: z.string().uuid().nullable().optional(),
    dockerContainerPort: z.number().int().min(1).max(65535).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.upstreamKind === 'managed_storage') {
      if (!data.managedStorageId)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['managedStorageId'], message: 'Select managed storage' });
      return;
    }
    if (!data.dockerContainerPort)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dockerContainerPort'],
        message: 'Select the application port',
      });
    if (data.upstreamKind === 'docker_deployment' && !data.dockerDeploymentId)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dockerDeploymentId'], message: 'Select a deployment' });
    if (data.upstreamKind !== 'docker_container') return;
    const hasContainer = Boolean(data.dockerContainerName);
    const hasCompose = Boolean(data.dockerComposeProjectId && data.dockerComposeServiceName);
    if (!data.dockerNodeId || hasContainer === hasCompose) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dockerContainerName'],
        message: 'Select either a container or a Compose service',
      });
    }
  });

/**
 * Retarget body: the target fields of {@link CreateAdditionalSecureLinkSchema},
 * validated by the same rules. The link keeps its name, so none is accepted.
 */
export function parseRetargetAdditionalSecureLink(input: unknown) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const { name: _name, ...target } = CreateAdditionalSecureLinkSchema.parse({ ...body, name: 'retarget' });
  return target;
}

// ---------------------------------------------------------------------------
// List query — pagination + filters
// ---------------------------------------------------------------------------

export const ProxyHostListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['proxy', 'redirect', '404', 'raw']).optional(),
  enabled: z.coerce.boolean().optional(),
  healthStatus: z.enum(['online', 'offline', 'degraded', 'unknown', 'disabled']).optional(),
  search: z.string().max(255).optional(),
  /** Routes served by this nginx node, including the routes of its ingress groups. */
  nodeId: z.string().uuid().optional(),
  ingressGroupId: z.string().uuid().optional(),
  /** Leave out routes that belong to an app (the normal Routes list). */
  excludeAppMembers: z.preprocess(queryFlag, z.boolean().optional()),
  /** Only the routes of this app (any environment). */
  appId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Toggle enabled/disabled
// ---------------------------------------------------------------------------

export const ToggleProxyHostSchema = z.object({
  enabled: z.boolean(),
});

export const ToggleProxyMaintenanceSchema = z.object({
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Validate advanced config
// ---------------------------------------------------------------------------

/** Serve a route from every member of an ingress group, or with null from one member node again. */
export const RouteIngressPlacementSchema = z
  .object({
    ingressGroupId: z.string().uuid().nullable(),
    nodeId: z.string().uuid().optional(),
  })
  .refine((value) => value.ingressGroupId !== null || !!value.nodeId, {
    message: 'Pass nodeId (a current group member) to serve the route from one node',
    path: ['nodeId'],
  });

export const RouteIngressNodeListQuerySchema = z.object({
  /** Limit the list to the nodes a new route in this folder may use. */
  folderId: z.string().uuid().optional(),
});

export const ValidateAdvancedConfigSchema = z.object({
  snippet: z.string().min(1).max(100000),
  mode: z.enum(['advanced', 'raw']).optional().default('advanced'),
  proxyHostId: z.string().optional(),
  /** Destination of a route that is about to be created (ignored when proxyHostId is set). */
  folderId: z.string().uuid().nullable().optional(),
  nodeId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** A create request: `nodeId` may be omitted and is resolved before the create checks run. */
export type CreateProxyHostRequest = z.infer<typeof CreateProxyHostSchema>;
/** A create with its ingress node resolved (the service and Pages contract). */
export type CreateProxyHostInput = CreateProxyHostRequest & { nodeId: string };
export type UpdateProxyHostInput = z.infer<typeof UpdateProxyHostSchema>;
export type ProxyHostListQuery = z.infer<typeof ProxyHostListQuerySchema>;
export type ToggleProxyHostInput = z.infer<typeof ToggleProxyHostSchema>;
export type ToggleProxyMaintenanceInput = z.infer<typeof ToggleProxyMaintenanceSchema>;
export type ValidateAdvancedConfigInput = z.infer<typeof ValidateAdvancedConfigSchema>;
export type RouteIngressPlacementInput = z.infer<typeof RouteIngressPlacementSchema>;
