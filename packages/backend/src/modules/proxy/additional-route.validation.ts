import { z } from 'zod';
import { ConfigValidatorService } from '@/services/config-validator.service.js';

const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const RESERVED_CANONICAL_PREFIXES = ['/_opfield', '/_gateway', '/.well-known/acme-challenge'];

/**
 * Normalize a literal path-prefix route.  Percent-encoded input is rejected
 * instead of decoded: accepting both forms would let two rows represent the
 * same Nginx location and would make reserved-path checks ambiguous.
 */
export function normalizeAdditionalRoutePath(value: string): string {
  const input = value.trim();
  const normalized = input.length > 1 && input.endsWith('/') ? input.slice(0, -1) : input;
  if (!normalized || normalized === '/') throw new Error('Additional Route path cannot be root');
  if (
    normalized.includes('%') ||
    [...normalized].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    throw new Error('Additional Route path must not contain encoded or control characters');
  }
  if (!normalized.startsWith('/') || normalized.includes('?') || normalized.includes('#')) {
    throw new Error('Additional Route path must be an absolute literal path');
  }
  if (normalized.includes('//')) throw new Error('Additional Route path must not contain an empty segment');
  const segments = normalized.split('/').slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Additional Route path must not contain traversal segments');
  }
  if (segments.some((segment) => !PATH_SEGMENT.test(segment))) {
    throw new Error('Additional Route path contains unsupported syntax');
  }
  const lower = normalized.toLowerCase();
  if (RESERVED_CANONICAL_PREFIXES.some((reserved) => lower === reserved || lower.startsWith(`${reserved}/`))) {
    throw new Error('Additional Route path is reserved by Opfield');
  }
  return normalized;
}

export const AdditionalRoutePathSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      return normalizeAdditionalRoutePath(value);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  });

const TimeoutSchema = z.number().int().min(1).max(3600);

const TargetKindSchema = z.enum(['manual', 'docker_container', 'docker_deployment', 'pages']);
const locationValidator = new ConfigValidatorService();

/**
 * Additional Route advanced config is inserted line by line into the route's location. Unless the caller holds
 * proxy:unrestricted on the Route it gets the deny-list of the Route's own advanced config, as written inside a
 * non-root location; either way it must consist of complete directives, so it cannot run into the directives
 * Gateway renders after it.
 */
export function additionalRouteAdvancedConfigErrors(value: string, unrestricted: boolean): string[] {
  return locationValidator.validateLocationSnippet(value, unrestricted).errors;
}

const AdditionalRouteAdvancedConfigSchema = z
  .string()
  .max(10_000)
  .refine((value) => !/[{}]/.test(value), 'Location advanced config must contain directives only, without blocks');

/** Flat form mirrors the existing Proxy Host upstream API and is convenient
 * for programmatic clients.  A nested `target` alias is accepted by the
 * service normalizer for clients that model the union explicitly. */
export const CreateAdditionalRouteSchema = z
  .object({
    path: AdditionalRoutePathSchema,
    enabled: z.boolean().optional().default(true),
    targetKind: TargetKindSchema.optional(),
    targetType: TargetKindSchema.optional(),
    target: z.record(z.unknown()).optional(),
    forwardHost: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
    forwardPort: z.number().int().min(1).max(65535).optional(),
    forwardScheme: z.enum(['http', 'https']).optional().default('http'),
    dockerNodeId: z.string().uuid().optional(),
    dockerContainerName: z.string().min(1).max(255).nullable().optional(),
    dockerComposeProjectId: z.string().uuid().nullable().optional(),
    dockerComposeServiceName: z.string().min(1).max(255).nullable().optional(),
    dockerDeploymentId: z.string().uuid().optional(),
    dockerContainerPort: z.number().int().min(1).max(65535).optional(),
    dockerHostPort: z.number().int().min(1).max(65535).optional(),
    dockerProtocol: z.literal('tcp').optional().default('tcp'),
    pageProjectId: z.string().uuid().optional(),
    pageTagId: z.string().uuid().optional(),
    advancedConfig: AdditionalRouteAdvancedConfigSchema.optional().nullable(),
    stripPrefix: z.boolean().optional().default(false),
    websocketSupport: z.boolean().optional().default(false),
    requestBuffering: z.boolean().optional().default(true),
    responseBuffering: z.boolean().optional().default(true),
    connectTimeoutSeconds: TimeoutSchema.optional().default(60),
    readTimeoutSeconds: TimeoutSchema.optional().default(60),
    sendTimeoutSeconds: TimeoutSchema.optional().default(60),
  })
  .superRefine((data, ctx) => {
    const kind =
      data.targetKind ??
      data.targetType ??
      (data.target?.kind as string | undefined) ??
      (data.target?.targetKind as string | undefined);
    if (!kind || !TargetKindSchema.safeParse(kind).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetKind'], message: 'A route target is required' });
      return;
    }
    const target = data.target ?? {};
    const read = (key: string): unknown => (data as Record<string, unknown>)[key] ?? target[key];
    if (kind === 'manual') {
      if (!read('forwardHost'))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['forwardHost'], message: 'Forward host is required' });
      if (!read('forwardPort'))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['forwardPort'], message: 'Forward port is required' });
    }
    if (kind === 'docker_container') {
      for (const [key, message] of [
        ['dockerNodeId', 'Docker node is required'],
        ['dockerContainerPort', 'Container port is required'],
      ] as const) {
        if (!read(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      }
      const hasContainer = Boolean(read('dockerContainerName'));
      const hasCompose = Boolean(read('dockerComposeProjectId') && read('dockerComposeServiceName'));
      if (hasContainer === hasCompose) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dockerContainerName'],
          message: 'Select either a container or a Compose service',
        });
      }
    }
    if (kind === 'docker_deployment') {
      if (!read('dockerDeploymentId'))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dockerDeploymentId'], message: 'Deployment is required' });
      if (!read('dockerContainerPort'))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dockerContainerPort'],
          message: 'Container port is required',
        });
    }
    if (kind === 'pages') {
      if (!read('pageProjectId'))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pageProjectId'], message: 'Page Project is required' });
      if (!read('pageTagId'))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pageTagId'], message: 'Page Tag is required' });
      if (data.websocketSupport)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['websocketSupport'],
          message: 'Pages routes do not support WebSocket upgrades',
        });
    }
  });

export const UpdateAdditionalRouteSchema = z.object({
  path: AdditionalRoutePathSchema.optional(),
  enabled: z.boolean().optional(),
  targetKind: TargetKindSchema.optional(),
  targetType: TargetKindSchema.optional(),
  target: z.record(z.unknown()).optional(),
  forwardHost: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional()
    .nullable(),
  forwardPort: z.number().int().min(1).max(65535).optional().nullable(),
  forwardScheme: z.enum(['http', 'https']).optional(),
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
  advancedConfig: AdditionalRouteAdvancedConfigSchema.optional().nullable(),
  stripPrefix: z.boolean().optional(),
  websocketSupport: z.boolean().optional(),
  requestBuffering: z.boolean().optional(),
  responseBuffering: z.boolean().optional(),
  connectTimeoutSeconds: TimeoutSchema.optional(),
  readTimeoutSeconds: TimeoutSchema.optional(),
  sendTimeoutSeconds: TimeoutSchema.optional(),
});

export type CreateAdditionalRouteInput = z.infer<typeof CreateAdditionalRouteSchema>;
export type UpdateAdditionalRouteInput = z.infer<typeof UpdateAdditionalRouteSchema>;
