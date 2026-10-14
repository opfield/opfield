import { z } from '@hono/zod-openapi';
import { invalidDomainPatterns, MAX_DOMAIN_PATTERNS, normalizeDomainPatterns } from './app-domain-patterns.js';
import { APP_MEMBER_TYPES } from './app-families.js';

const name = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32), 'Name contains control characters');

/** App description: one line under the name, up to 200 characters; empty clears it. */
export const APP_DESCRIPTION_MAX = 200;
const description = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(z.string().max(APP_DESCRIPTION_MAX))
  .nullable();

/**
 * Allowed domain names: `api.example.com` (that name) or `*.example.com` (any name under example.com, not
 * example.com itself). Trimmed, lowercased, without a trailing dot; duplicates dropped. An empty list allows every name.
 */
export const DomainPatternsSchema = z
  .array(z.string().max(255))
  .max(MAX_DOMAIN_PATTERNS)
  .superRefine((values, ctx) => {
    const invalid = invalidDomainPatterns(values);
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Not a domain name or *.domain pattern: ${invalid.join(', ')}`,
      });
    }
  })
  .transform(normalizeDomainPatterns);

export const CreateAppSchema = z
  .object({
    name: name(255),
    description: description.optional(),
    /** Apps list folder to create the app in; omitted or null at the top level. */
    folderId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const UpdateAppSchema = z
  .object({
    name: name(255).optional(),
    description: description.optional(),
    maintenanceOverride: z.boolean().optional(),
    /** Domains every environment may use (joined with each environment's own list). */
    domainPatterns: DomainPatternsSchema.optional(),
  })
  .strict();

export const CreateAppEnvironmentSchema = z.object({ name: name(64) }).strict();

export const UpdateAppEnvironmentSchema = z
  .object({
    name: name(64).optional(),
    /** Only `true`: the Production marker moves to this environment. */
    isProduction: z.literal(true).optional(),
    maintenanceEnabled: z.boolean().optional(),
    /** Domains this environment may use on top of the app-wide list. */
    domainPatterns: DomainPatternsSchema.optional(),
  })
  .strict();

export const AppMemberRefSchema = z
  .object({
    type: z.enum(APP_MEMBER_TYPES),
    id: z.string().min(1).max(512).optional(),
    nodeId: z.string().uuid().optional(),
    /** Containers: the container name (same as id). */
    resourceKey: z.string().min(1).max(512).optional(),
  })
  .strict();

export const PlaceAppMembersSchema = z
  .object({
    target: z.object({ appId: z.string().uuid(), environmentId: z.string().uuid() }).strict().nullable(),
    members: z.array(AppMemberRefSchema).min(1).max(200),
  })
  .strict();

export const AppMembersQuerySchema = z.object({ environmentId: z.string().uuid().optional() });

export type CreateAppInput = z.infer<typeof CreateAppSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppSchema>;
export type CreateAppEnvironmentInput = z.infer<typeof CreateAppEnvironmentSchema>;
export type UpdateAppEnvironmentInput = z.infer<typeof UpdateAppEnvironmentSchema>;
export type PlaceAppMembersInput = z.infer<typeof PlaceAppMembersSchema>;
export type AppMemberRefInput = z.infer<typeof AppMemberRefSchema>;

export const SetAppVariablesSchema = z
  .object({
    variables: z.array(z.object({ key: z.string().min(1).max(255), value: z.string() }).strict()).max(200),
  })
  .strict();

export const PatchAppSecretsSchema = z
  .object({
    set: z.record(z.string().min(1).max(255), z.string()).optional(),
    delete: z.array(z.string().min(1).max(255)).max(200).optional(),
  })
  .strict();
