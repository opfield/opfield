import { z } from 'zod';
import { DelegatedScopeArraySchema, MAX_OAUTH_SCOPE_PARAMETER_LENGTH } from '@/lib/scopes-schemas.js';
import { TokenAllowedIpsSchema, TokenExpiresAtSchema } from '@/lib/token-limits.js';

const UrlSchema = z.string().max(2048).url();
const HttpUrlSchema = UrlSchema.refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'URL must use http or https');
const OptionalHttpUrlSchema = HttpUrlSchema.or(z.literal(''));

export const OAuthClientRegistrationSchema = z.object({
  redirect_uris: z.array(UrlSchema).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .max(2)
    .optional(),
  response_types: z.array(z.literal('code')).max(1).optional(),
  client_name: z.string().min(1).max(255).optional(),
  client_uri: HttpUrlSchema.optional(),
  logo_uri: OptionalHttpUrlSchema.optional(),
  scope: z.string().max(MAX_OAUTH_SCOPE_PARAMETER_LENGTH).optional(),
  contacts: z.array(z.string().max(320)).max(5).optional(),
  tos_uri: OptionalHttpUrlSchema.optional(),
  policy_uri: HttpUrlSchema.optional(),
  software_id: z.string().max(128).optional(),
  software_version: z.string().max(64).optional(),
});

export const OAuthAuthorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  scope: z.string().max(MAX_OAUTH_SCOPE_PARAMETER_LENGTH).optional(),
  state: z.string().optional(),
  resource: z.string().url().optional(),
});

export const OAuthTokenRequestSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  client_id: z.string().min(1),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  code_verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/)
    .optional(),
  refresh_token: z.string().optional(),
  resource: z.string().url().optional(),
});

export const OAuthRevocationRequestSchema = z.object({
  token: z.string().min(1),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  client_id: z.string().min(1).optional(),
});

/** Scopes selected on the consent screen; folder, node, and Docker child restrictions are allowed. */
export const OAuthConsentDecisionSchema = z.object({
  scopes: DelegatedScopeArraySchema.optional(),
});

/** Narrowing an existing OAuth authorization from Settings: its scopes, expiry and allowed addresses. */
export const OAuthAuthorizationScopesSchema = z
  .object({
    scopes: DelegatedScopeArraySchema.min(1).optional(),
    expiresAt: TokenExpiresAtSchema.optional(),
    allowedIps: TokenAllowedIpsSchema.optional(),
  })
  .refine(
    (input) => input.scopes !== undefined || input.expiresAt !== undefined || input.allowedIps !== undefined,
    'At least one field is required'
  );

export type OAuthClientRegistrationInput = z.infer<typeof OAuthClientRegistrationSchema>;
export type OAuthAuthorizeQuery = z.infer<typeof OAuthAuthorizeQuerySchema>;
export type OAuthTokenRequest = z.infer<typeof OAuthTokenRequestSchema>;
