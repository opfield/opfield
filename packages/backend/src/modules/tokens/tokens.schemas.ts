import { z } from 'zod';
import { API_TOKEN_SCOPES, isApiTokenScope } from '@/lib/scopes.js';
import { DelegatedScopeArraySchema, everyReplacementScope } from '@/lib/scopes-schemas.js';
import { TokenAllowedIpsSchema, TokenExpiresAtSchema } from '@/lib/token-limits.js';
import { hasRegistryAccess, TokenRegistryAccessSchema } from './token-registry-access.js';

export const AVAILABLE_SCOPES = API_TOKEN_SCOPES;

/** Folder, node, and Docker child restrictions are accepted like on the consent screen. */
const TokenScopeArraySchema = DelegatedScopeArraySchema.refine(
  (scopes) => scopes.every((scope) => everyReplacementScope(scope, isApiTokenScope)),
  'One or more scopes cannot be granted to API tokens'
);

/** A token carries at least one scope or internal registry access (a registry-only CI token has no scopes). */
export const CreateTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    scopes: TokenScopeArraySchema.default([]),
    registryAccess: TokenRegistryAccessSchema.optional(),
    expiresAt: TokenExpiresAtSchema.optional(),
    allowedIps: TokenAllowedIpsSchema.optional(),
    exactScopes: z
      .boolean()
      .optional()
      .describe(
        'Store exactly the requested scopes. Without it a new token also gets the grants older scripts expect from the scopes they name (for example repository reads with integrations:github:view), where the owner holds them.'
      ),
  })
  .refine(
    (input) => input.scopes.length > 0 || hasRegistryAccess(input.registryAccess),
    'At least one scope or registry access is required'
  );

/** registryAccess replaces the token's registry access; `{}` removes it. */
export const UpdateTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    scopes: TokenScopeArraySchema.optional(),
    registryAccess: TokenRegistryAccessSchema.optional(),
    expiresAt: TokenExpiresAtSchema.optional(),
    allowedIps: TokenAllowedIpsSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.scopes !== undefined ||
      input.registryAccess !== undefined ||
      input.expiresAt !== undefined ||
      input.allowedIps !== undefined,
    'At least one field is required'
  );

export const TokenResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  registryAccess: TokenRegistryAccessSchema,
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  allowedIps: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CreateTokenResponseSchema = TokenResponseSchema.extend({
  token: z.string(),
});

export type CreateTokenInput = z.infer<typeof CreateTokenSchema>;
export type UpdateTokenInput = z.infer<typeof UpdateTokenSchema>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;
