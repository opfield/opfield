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
    'Sign-in domain (null: the Opfield public URL serves the sign-in page), default session length, placement of the sign-in route and signInOrigin, the origin visitors are sent to.',
  responses: okJson(UnknownDataResponseSchema),
});

export const updateAccessSettingsRoute = appRoute({
  method: 'put',
  path: '/',
  tags: TAG,
  summary: 'Update the access sign-in settings',
  description:
    'A domain with nodeId or ingressGroupId gets a system route proxied to Opfield (TLS with sslCertificateId); a domain without placement must reach Opfield another way. domain null removes the route.',
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
  description: 'The response carries redirectUri, the URI to register at the provider.',
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
  description: 'Visitors signed in on the sign-in domain; ended sessions only with includeEnded.',
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
