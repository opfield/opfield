import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  AccessSessionListQuerySchema,
  AccessSignInSettingsUpdateSchema,
  CreateAccessIdentityProviderSchema,
  CreateAccessServiceTokenSchema,
  UpdateAccessIdentityProviderSchema,
  UpdateAccessServiceTokenSchema,
} from './access-signin.schemas.js';

const TAG = ['Access Sign-in'];

export const getAccessSettingsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: TAG,
  summary: 'Get the access sign-in settings',
  description:
    'The default session length of access lists. Visitors sign in on the protected route itself (/_opfield/access/sign-in of the route).',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAccessSettingsRoute = appRoute({
  method: 'put',
  path: '/',
  tags: TAG,
  summary: 'Update the access sign-in settings',
  description: 'defaultSessionTtlSeconds: how long a sign-in lasts when the access list sets no length of its own.',
  request: jsonBody(AccessSignInSettingsUpdateSchema),
  responses: okJson(UnknownDataResponseSchema),
});

export const listAccessIdentityProvidersRoute = appRoute({
  method: 'get',
  path: '/',
  tags: TAG,
  summary: 'List identity providers',
  description: 'Google and OIDC providers access lists offer as sign-in method idp:<id>. Secrets are never returned.',
  responses: okJson(UnknownDataResponseSchema),
});

export const getAccessIdentityProviderRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: TAG,
  summary: 'Get an identity provider',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createAccessIdentityProviderRoute = appRoute({
  method: 'post',
  path: '/',
  tags: TAG,
  summary: 'Add an identity provider',
  description:
    'The response carries redirectUri, the pattern of the URIs to register at the provider: https://<route host>/_opfield/access/provider-callback for every route whose access list offers it.',
  request: jsonBody(CreateAccessIdentityProviderSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateAccessIdentityProviderRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: TAG,
  summary: 'Update an identity provider',
  description: 'clientSecret omitted keeps the stored secret.',
  request: { params: IdParamSchema, ...jsonBody(UpdateAccessIdentityProviderSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAccessIdentityProviderRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: TAG,
  summary: 'Delete an identity provider',
  description: 'Refused (409) while an access list offers it.',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const listAccessServiceTokensRoute = appRoute({
  method: 'get',
  path: '/',
  tags: TAG,
  summary: 'List service tokens',
  responses: okJson(UnknownDataResponseSchema),
});

export const getAccessServiceTokenRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: TAG,
  summary: 'Get a service token',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createAccessServiceTokenRoute = appRoute({
  method: 'post',
  path: '/',
  tags: TAG,
  summary: 'Create a service token',
  description:
    'Returns clientId and clientSecret once. Scripts send them as Opfield-Access-Client-Id and Opfield-Access-Client-Secret; a list lets the token in through an Include rule service_token with its id.',
  request: jsonBody(CreateAccessServiceTokenSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateAccessServiceTokenRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: TAG,
  summary: 'Rename a service token or change its expiry',
  request: { params: IdParamSchema, ...jsonBody(UpdateAccessServiceTokenSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAccessServiceTokenRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: TAG,
  summary: 'Delete a service token',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});

export const listAccessSessionsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: TAG,
  summary: 'List visitor sessions',
  description: 'Visitors signed in on protected routes; ended sessions only with includeEnded.',
  request: { query: AccessSessionListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const revokeAccessSessionRoute = appRoute({
  method: 'post',
  path: '/{id}/revoke',
  tags: TAG,
  summary: 'Revoke a visitor session',
  description: 'Every host token of the session stops working on every ingress node.',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});
