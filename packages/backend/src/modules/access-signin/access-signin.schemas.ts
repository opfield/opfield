import { z } from 'zod';

/** Session lengths the sign-in settings and access lists accept: 5 minutes to 30 days. */
export const MIN_ACCESS_SESSION_TTL_SECONDS = 300;
export const MAX_ACCESS_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_ACCESS_SESSION_TTL_SECONDS = 86_400;

const SessionTtlSchema = z.number().int().min(MIN_ACCESS_SESSION_TTL_SECONDS).max(MAX_ACCESS_SESSION_TTL_SECONDS);

export const AccessSignInSettingsUpdateSchema = z.object({
  defaultSessionTtlSeconds: SessionTtlSchema.optional(),
});
export type AccessSignInSettingsUpdate = z.infer<typeof AccessSignInSettingsUpdateSchema>;

const ProviderNameSchema = z.string().trim().min(1).max(64);
const IssuerSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'Issuer must use https');
const GroupsClaimSchema = z.string().trim().max(128).nullable().optional();

export const CreateAccessIdentityProviderSchema = z
  .object({
    // The console may pick the id up front, to show the redirect URI before the provider is saved.
    id: z.string().uuid().optional(),
    kind: z.enum(['google', 'oidc']),
    name: ProviderNameSchema,
    // Required for oidc; Google always uses https://accounts.google.com.
    issuer: IssuerSchema.optional(),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().min(1).max(2048),
    scopes: z.string().trim().min(1).max(512).optional(),
    groupsClaim: GroupsClaimSchema,
    /** A missing email_verified claim counts as verified (default); email_verified false never does. */
    trustEmail: z.boolean().optional(),
  })
  .refine((value) => value.kind === 'google' || !!value.issuer, {
    message: 'An OIDC provider needs an issuer URL',
    path: ['issuer'],
  });
export type CreateAccessIdentityProviderInput = z.infer<typeof CreateAccessIdentityProviderSchema>;

export const UpdateAccessIdentityProviderSchema = z.object({
  name: ProviderNameSchema.optional(),
  issuer: IssuerSchema.optional(),
  clientId: z.string().trim().min(1).max(512).optional(),
  // Omitted or empty: the stored secret stays.
  clientSecret: z
    .string()
    .max(2048)
    .optional()
    .transform((value) => value || undefined),
  scopes: z.string().trim().min(1).max(512).optional(),
  groupsClaim: GroupsClaimSchema,
  trustEmail: z.boolean().optional(),
});
export type UpdateAccessIdentityProviderInput = z.infer<typeof UpdateAccessIdentityProviderSchema>;

const ExpiresAtSchema = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .optional()
  .refine((value) => !value || Date.parse(value) > Date.now(), 'Expiry must be in the future');

export const CreateAccessServiceTokenSchema = z.object({
  name: z.string().trim().min(1).max(255),
  // Null or omitted: never expires.
  expiresAt: ExpiresAtSchema,
});
export type CreateAccessServiceTokenInput = z.infer<typeof CreateAccessServiceTokenSchema>;

export const UpdateAccessServiceTokenSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  expiresAt: ExpiresAtSchema,
});
export type UpdateAccessServiceTokenInput = z.infer<typeof UpdateAccessServiceTokenSchema>;

export const AccessSessionListQuerySchema = z.object({
  search: z.string().trim().max(255).optional(),
  accessListId: z.string().uuid().optional(),
  includeEnded: z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type AccessSessionListQuery = z.infer<typeof AccessSessionListQuerySchema>;
